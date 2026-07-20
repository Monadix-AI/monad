// WeCom (企业微信) channel adapter — encrypted callback in, app-message API out. WeCom wraps every
// callback in AES-256-CBC ciphertext with a SHA1 message signature; we decrypt + verify, then reply
// via the app message API (access-token auth). The compliant alternative to personal WeChat (which has
// no official API). Pure platform I/O; never touches sessions.
//
// secrets: extra.corpId, extra.corpSecret (token), extra.token (signature), extra.aesKey (EncodingAESKey).
// options: { agentId, port?=8805, path?='/wecom' }

import type { ChannelInbound } from '@monad/protocol';
import type { ChannelAdapter, ChannelCapabilities, ChannelContext, SentMessage } from '@monad/sdk-atom';

import { createDecipheriv } from 'node:crypto';
import { defineChannel } from '@monad/sdk-atom';
import { z } from 'zod';

import { timingSafeEqual } from './_http-inbound.ts';

const WECOM_CAPABILITIES: ChannelCapabilities = {
  edit: false,
  typing: false,
  threads: false,
  maxMessageChars: 2048,
  markdown: false,
  reactions: false,
  nativeCommands: false,
  outboundMirror: true
};

function xmlField(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m?.[1];
}

/** Parse a DECRYPTED WeCom message XML → ChannelInbound, or null if it isn't a text message. The
 *  sender (FromUserName) is both the user and the 1:1 chat. Exported for tests. */
export function parseWecomMessageXml(xml: string): ChannelInbound | null {
  if (xmlField(xml, 'MsgType') !== 'text') return null;
  const from = xmlField(xml, 'FromUserName') ?? '';
  const text = xmlField(xml, 'Content') ?? '';
  const isCommand = text.startsWith('/');
  const [head, ...args] = isCommand ? text.trim().split(/\s+/) : [];
  return {
    chatId: from,
    userId: from,
    text,
    kind: isCommand ? 'command' : 'text',
    command: head ? head.slice(1).toLowerCase() : undefined,
    commandArgs: args,
    nativeMessageId: xmlField(xml, 'MsgId') ?? `wc-${Date.now()}`,
    chatType: 'dm',
    isSelf: false,
    media: [],
    at: new Date().toISOString()
  };
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** WeCom callback signature: sha1 of the sorted [token, timestamp, nonce, encrypt] joined. */
export async function wecomSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string
): Promise<string> {
  return sha1Hex([token, timestamp, nonce, encrypt].sort().join(''));
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decrypt a WeCom Encrypt blob → inner message XML. WeCom uses AES-256-CBC with PKCS7 padded to a
 *  **32-byte** block (pad length can exceed 16), so Web Crypto's AES-CBC — which validates standard
 *  16-byte PKCS7 and would throw on a >16 pad — can't be used. We decrypt with node:crypto and
 *  setAutoPadding(false), then strip the pad + 16-byte random prefix + 4-byte big-endian length
 *  manually. When `expectedReceiveId` is given, the trailing receive id must equal it (anti-spoof). */
export function decryptWecom(encodingAesKey: string, encrypt: string, expectedReceiveId?: string): string {
  const key = Buffer.from(b64ToBytes(`${encodingAesKey}=`)); // EncodingAESKey is 43 chars; pad to 32 bytes
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(Buffer.from(b64ToBytes(encrypt))), decipher.final()]);
  const pad = buf[buf.length - 1] ?? 0;
  if (pad < 1 || pad > 32 || pad > buf.length) throw new Error('wecom: invalid PKCS7 padding');
  const plain = buf.subarray(0, buf.length - pad);
  const len = plain.readUInt32BE(16);
  const xml = plain.subarray(20, 20 + len).toString('utf8');
  if (expectedReceiveId !== undefined && plain.subarray(20 + len).toString('utf8') !== expectedReceiveId) {
    throw new Error('wecom: receive_id mismatch');
  }
  return xml;
}

export function createWecomAdapter(ctx: ChannelContext): ChannelAdapter {
  const corpId = ctx.secrets.corpId ?? '';
  const corpSecret = ctx.secrets.corpSecret ?? ctx.secrets.token ?? '';
  const callbackToken = ctx.secrets.token ?? '';
  const aesKey = ctx.secrets.aesKey ?? '';
  const agentId = String(ctx.config.options.agentId ?? '');
  const port = Number(ctx.config.options.port) || 8805;
  const path = (typeof ctx.config.options.path === 'string' ? ctx.config.options.path : '/wecom') || '/wecom';

  let cached: { token: string; exp: number } | undefined;
  async function accessToken(): Promise<string> {
    if (cached && cached.exp > Date.now()) return cached.token;
    const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`, {
      signal: ctx.signal
    });
    const json = z
      .object({ access_token: z.string().optional(), expires_in: z.number().optional(), errmsg: z.string().optional() })
      .parse(await res.json());
    if (!json.access_token) throw new Error(`wecom token failed: ${json.errmsg ?? res.status}`);
    cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 7200) * 1000 - 60_000 };
    return cached.token;
  }

  async function verifyAndDecrypt(url: URL, raw: string): Promise<string | null> {
    const encrypt = xmlField(raw, 'Encrypt') ?? url.searchParams.get('echostr') ?? '';
    if (!encrypt) return null;
    const sig = url.searchParams.get('msg_signature') ?? '';
    const expected = await wecomSignature(
      callbackToken,
      url.searchParams.get('timestamp') ?? '',
      url.searchParams.get('nonce') ?? '',
      encrypt
    );
    if (!timingSafeEqual(sig, expected)) throw new Error('wecom: bad signature');
    return decryptWecom(aesKey, encrypt, corpId);
  }

  // serveHttpInbound's handle is sync; WeCom's inbound needs async decrypt, so it runs its own server.
  let realServer: ReturnType<typeof Bun.serve> | undefined;

  return {
    type: 'wecom',
    capabilities: WECOM_CAPABILITIES,
    async connect() {
      if (!corpId || !corpSecret || !aesKey || !agentId)
        throw new Error('wecom: corpId/corpSecret/aesKey and options.agentId are required');
      realServer = Bun.serve({
        port,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname !== path) return new Response('not found', { status: 404 });
          try {
            if (req.method === 'GET') {
              // URL verification: decrypt echostr and echo the plaintext.
              const plain = await verifyAndDecrypt(url, '');
              return new Response(plain ?? '', { status: plain ? 200 : 403 });
            }
            const xml = await verifyAndDecrypt(url, await req.text());
            if (xml) {
              const ev = parseWecomMessageXml(xml);
              if (ev) ctx.onMessage(ev);
            }
            return new Response('success');
          } catch (err) {
            ctx.log('warn', `wecom inbound: ${err instanceof Error ? err.message : String(err)}`);
            return new Response('error', { status: 400 });
          }
        }
      });
      ctx.log('info', `wecom listening on :${port}${path}`);
    },
    async disconnect() {
      realServer?.stop(true);
      realServer = undefined;
    },
    async send(chatId: string, content: string): Promise<SentMessage> {
      const token = await accessToken();
      const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ touser: chatId, msgtype: 'text', agentid: Number(agentId), text: { content } }),
        signal: ctx.signal
      });
      const json = z
        .object({ errcode: z.number().optional(), errmsg: z.string().optional(), msgid: z.string().optional() })
        .parse(await res.json().catch(() => ({})));
      if (json.errcode) throw new Error(`wecom send failed: ${json.errmsg}`);
      return { ref: json.msgid ?? `wc-${Date.now()}`, chatId };
    }
  };
}

export const wecomChannelAtom = defineChannel({
  type: 'wecom',
  name: 'WeCom (企业微信)',
  capabilities: WECOM_CAPABILITIES,
  envVars: [
    { name: 'WECOM_CORP_ID', description: 'Corp ID', required: true, secret: true },
    { name: 'WECOM_CORP_SECRET', description: 'App secret', required: true, secret: true }
  ],
  create: createWecomAdapter
});

import { describe, expect, test } from 'bun:test';

import { installedChannelOptions } from './installed-channel-options.ts';

describe('installedChannelOptions', () => {
  test('lists every enabled channel adapter and keeps a shadowed adapter addressable', () => {
    expect(
      installedChannelOptions(
        [
          {
            name: 'monad-builtins',
            version: '1.0.0',
            atoms: ['channel'],
            enabled: true,
            canUpdate: false,
            atomDetails: [
              {
                kind: 'channel',
                id: 'slack',
                name: 'Slack',
                channel: {
                  capabilities: {
                    edit: true,
                    typing: false,
                    threads: true,
                    maxMessageChars: 4000,
                    markdown: false,
                    reactions: true,
                    nativeCommands: true,
                    outboundMirror: true,
                    groupMentionPolicy: true
                  },
                  connectionMode: 'pairing',
                  icon: { title: 'Slack', hex: '4A154B', path: 'M0 0h24v24H0z' },
                  setup: {
                    summary: 'Connect Slack with Socket Mode.',
                    steps: ['Create a Slack app.', 'Enter both tokens.'],
                    docsUrl: 'https://api.slack.com/start/quickstart'
                  },
                  envVars: [
                    {
                      name: 'SLACK_APP_TOKEN',
                      description: 'App token',
                      required: true,
                      secret: true,
                      credentialKey: 'appToken'
                    }
                  ]
                }
              },
              { kind: 'channel', id: 'discord', name: 'Discord' }
            ]
          },
          {
            name: 'workspace-chat',
            version: '1.0.0',
            atoms: ['channel'],
            enabled: true,
            canUpdate: false,
            atomDetails: [{ kind: 'channel', id: 'slack', name: 'Workspace Slack' }]
          },
          {
            name: 'disabled-chat',
            version: '1.0.0',
            atoms: ['channel'],
            enabled: false,
            canUpdate: false,
            atomDetails: [{ kind: 'channel', id: 'matrix', name: 'Matrix' }]
          }
        ],
        [{ kind: 'channel', bareId: 'slack', winner: 'monad-builtins', shadowed: ['workspace-chat'] }]
      )
    ).toEqual([
      {
        type: 'discord',
        packId: 'monad-builtins',
        label: 'Discord',
        description: undefined,
        connectionMode: 'credential',
        envVars: []
      },
      {
        type: 'slack',
        packId: 'monad-builtins',
        label: 'Slack',
        description: undefined,
        capabilities: {
          edit: true,
          typing: false,
          threads: true,
          maxMessageChars: 4000,
          markdown: false,
          reactions: true,
          nativeCommands: true,
          outboundMirror: true,
          groupMentionPolicy: true
        },
        connectionMode: 'pairing',
        icon: { title: 'Slack', hex: '4A154B', path: 'M0 0h24v24H0z' },
        setup: {
          summary: 'Connect Slack with Socket Mode.',
          steps: ['Create a Slack app.', 'Enter both tokens.'],
          docsUrl: 'https://api.slack.com/start/quickstart'
        },
        envVars: [
          {
            name: 'SLACK_APP_TOKEN',
            description: 'App token',
            required: true,
            secret: true,
            credentialKey: 'appToken'
          }
        ]
      },
      {
        type: 'workspace-chat__slack',
        packId: 'workspace-chat',
        label: 'Workspace Slack',
        description: undefined,
        connectionMode: 'credential',
        envVars: []
      }
    ]);
  });
});

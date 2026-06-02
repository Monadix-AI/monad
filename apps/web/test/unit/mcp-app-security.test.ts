import { expect, test } from 'bun:test';

import {
  mcpAppPermissionsPolicy,
  safeMcpAppExternalUrl,
  safeWebSearchUrl,
  sandboxedMcpAppHtml
} from '../../src/features/session/ToolStepView';

test('web search links allow only HTTP origins', () => {
  expect({
    https: safeWebSearchUrl('https://example.com/path'),
    http: safeWebSearchUrl('http://example.com/path'),
    javascript: safeWebSearchUrl('javascript:alert(1)'),
    data: safeWebSearchUrl('data:text/html,hello'),
    vbscript: safeWebSearchUrl('vbscript:msgbox(1)'),
    relative: safeWebSearchUrl('/local/path')
  }).toEqual({
    https: 'https://example.com/path',
    http: 'http://example.com/path',
    javascript: '#',
    data: '#',
    vbscript: '#',
    relative: '#'
  });
});

test('MCP App link handling allows external web links and rejects active or local schemes', () => {
  expect({
    https: safeMcpAppExternalUrl('https://example.com/path'),
    mailto: safeMcpAppExternalUrl('mailto:hello@example.com'),
    javascript: safeMcpAppExternalUrl('javascript:alert(1)'),
    data: safeMcpAppExternalUrl('data:text/html,hello'),
    file: safeMcpAppExternalUrl('file:///etc/passwd')
  }).toEqual({
    https: 'https://example.com/path',
    mailto: 'mailto:hello@example.com',
    javascript: undefined,
    data: undefined,
    file: undefined
  });
});

test('MCP App HTML receives a restrictive default content security policy', () => {
  const html = sandboxedMcpAppHtml('<!doctype html><script>parent.postMessage({}, "*")</script>');

  expect({
    preservesDoctype: html.startsWith('<!doctype html>'),
    blocksNetwork: html.includes('connect-src &apos;none&apos;'),
    blocksForms: html.includes('form-action &apos;none&apos;'),
    permitsInlineAppScript: html.includes('script-src &apos;unsafe-inline&apos;')
  }).toEqual({
    preservesDoctype: true,
    blocksNetwork: true,
    blocksForms: true,
    permitsInlineAppScript: true
  });
});

test('MCP App sandbox uses a proxy frame and admits only declared HTTPS origins', () => {
  const html = sandboxedMcpAppHtml('<script>fetch("https://api.example.com")</script>', {
    connectDomains: ['https://api.example.com/path', 'http://insecure.example.com'],
    resourceDomains: ['https://cdn.example.com']
  });

  expect({
    nestedSandbox: html.includes('<iframe id="app" sandbox="allow-scripts"'),
    declaredConnect: html.includes('connect-src https://api.example.com'),
    declaredResource: html.includes('https://cdn.example.com'),
    rejectsInsecure: !html.includes('insecure.example.com')
  }).toEqual({
    nestedSandbox: true,
    declaredConnect: true,
    declaredResource: true,
    rejectsInsecure: true
  });
});

test('MCP App sandbox grants only permissions declared by the resource', () => {
  const permissions = { camera: {}, clipboardWrite: {}, microphone: false, unknown: {} };
  const policy = mcpAppPermissionsPolicy(permissions);
  const html = sandboxedMcpAppHtml('<main />', undefined, permissions);

  expect({ policy, nestedPolicy: html.includes(`allow="${policy}"`) }).toEqual({
    policy: "camera *; microphone 'none'; geolocation 'none'; clipboard-write *",
    nestedPolicy: true
  });
});

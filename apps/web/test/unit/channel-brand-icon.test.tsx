import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChannelBrandIcon } from '../../src/features/studio/channels-settings/ChannelBrandIcon';

test('renders brand colors and custom vector view boxes from atom metadata', () => {
  expect(
    renderToStaticMarkup(
      <ChannelBrandIcon
        icon={{ title: 'Feishu / Lark', hex: '3370FF', path: 'M0 0h48v48H0z', viewBox: [0, 0, 48, 48] }}
      />
    )
  ).toEqual(
    '<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><svg aria-hidden="true" class="shrink-0 size-5" viewBox="0 0 48 48"><path d="M0 0h48v48H0z" fill="#3370FF"></path></svg></span>'
  );
});

test('renders semantic icons with the current UI color', () => {
  expect(renderToStaticMarkup(<ChannelBrandIcon icon={{ title: 'Email', path: 'M0 0h24v24H0z' }} />)).toEqual(
    '<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><svg aria-hidden="true" class="shrink-0 size-5" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor"></path></svg></span>'
  );
});

test('renders every official logo layer with its own presentation metadata', () => {
  expect(
    renderToStaticMarkup(
      <ChannelBrandIcon
        icon={{
          title: 'Layered brand',
          path: 'M0 0h24v24H0z',
          layers: [
            { path: 'M0 0h24v24H0z', fill: '#01A88D' },
            {
              path: 'M2 2h20v20H2z',
              fill: 'none',
              fillRule: 'evenodd',
              opacity: 0.8,
              stroke: '#FFFFFF',
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              strokeWidth: 2,
              transform: 'scale(0.5)'
            }
          ]
        }}
      />
    )
  ).toEqual(
    '<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><svg aria-hidden="true" class="shrink-0 size-5" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#01A88D"></path><path d="M2 2h20v20H2z" fill="none" fill-rule="evenodd" opacity="0.8" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" transform="scale(0.5)"></path></svg></span>'
  );
});

test('namespaces and renders official gradient fills from atom metadata', () => {
  expect(
    renderToStaticMarkup(
      <ChannelBrandIcon
        icon={{
          title: 'Gradient brand',
          path: 'M0 0h24v24H0z',
          gradients: [
            {
              id: 'aurora',
              type: 'linear',
              x1: 0,
              y1: 0,
              x2: 24,
              y2: 24,
              stops: [
                { offset: 0, color: '#EA4335' },
                { offset: 1, color: '#4285F4', opacity: 0.9 }
              ]
            }
          ],
          layers: [{ path: 'M0 0h24v24H0z', gradient: 'aurora' }]
        }}
      />
    )
  ).toEqual(
    '<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><svg aria-hidden="true" class="shrink-0 size-5" viewBox="0 0 24 24"><defs><linearGradient gradientUnits="userSpaceOnUse" id="_R_0_-aurora" x1="0" x2="24" y1="0" y2="24"><stop offset="0" stop-color="#EA4335"></stop><stop offset="1" stop-color="#4285F4" stop-opacity="0.9"></stop></linearGradient></defs><path d="M0 0h24v24H0z" fill="url(#_R_0_-aurora)"></path></svg></span>'
  );
});

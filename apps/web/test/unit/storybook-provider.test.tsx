import { expect, test } from 'bun:test';
import { useGetLocaleQuery } from '@monad/client-rtk';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { withWebStorybookProviders } from '../../src/storybook/WebStorybookProviders.tsx';

function LocaleProbe() {
  useGetLocaleQuery();
  return createElement('div', null, 'locale probe');
}

test('web Storybook providers include the app Redux store', () => {
  expect(() =>
    renderToStaticMarkup(withWebStorybookProviders(() => createElement(LocaleProbe)) as ReactElement)
  ).not.toThrow();
});

import type { Preview } from '@storybook/react-vite';

import { withWebStorybookProviders } from '../src/storybook/WebStorybookProviders';
import './preview.css';

const preview: Preview = {
  decorators: [withWebStorybookProviders],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    layout: 'centered'
  }
};

export default preview;

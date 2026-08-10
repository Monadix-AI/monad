import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, mock, test } from 'bun:test';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';

import { SessionUiActivity } from '../../src/features/session/SessionUiActivity';

test('hidden session UI disconnects effects and reconnects them when visible again', async () => {
  const connect = mock(() => {});
  const disconnect = mock(() => {});

  function StreamProbe(): React.ReactElement {
    const [count, setCount] = useState(0);
    useEffect(() => {
      connect();
      return disconnect;
    }, []);
    return (
      <button
        onClick={() => setCount((value) => value + 1)}
        type="button"
      >
        session stream {count}
      </button>
    );
  }

  const view = render(
    <SessionUiActivity visible>
      <StreamProbe />
    </SessionUiActivity>
  );
  await waitFor(() => expect(connect.mock.calls).toHaveLength(1));
  fireEvent.click(view.getByRole('button'));
  expect(view.getByRole('button').textContent).toBe('session stream 1');

  view.rerender(
    <SessionUiActivity visible={false}>
      <StreamProbe />
    </SessionUiActivity>
  );
  await waitFor(() => expect(disconnect.mock.calls).toHaveLength(1));

  view.rerender(
    <SessionUiActivity visible>
      <StreamProbe />
    </SessionUiActivity>
  );
  await waitFor(() => expect(connect.mock.calls).toHaveLength(2));
  expect(view.getByRole('button').textContent).toBe('session stream 1');

  view.unmount();
  expect(disconnect.mock.calls).toHaveLength(2);
});

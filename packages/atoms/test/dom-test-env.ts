import { afterEach } from 'bun:test';
import { cleanup } from '@testing-library/react';

export function setupDomTestEnvironment(): void {
  afterEach(cleanup);
}

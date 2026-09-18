import { expect, test } from 'vitest';
import { PROTOCOL_VERSION } from '../src/index.js';

test('freezes the initial protocol version', () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

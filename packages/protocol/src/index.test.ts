import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isSupportedProtocolVersion } from './index.js';

describe('isSupportedProtocolVersion', () => {
  it('accepts the current version', () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION)).toBe(true);
  });

  it.each([0, PROTOCOL_VERSION + 1, '1', null, undefined])('rejects %s', (version) => {
    expect(isSupportedProtocolVersion(version)).toBe(false);
  });
});

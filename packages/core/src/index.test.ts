import { PROTOCOL_VERSION } from '@bildora/protocol';
import { describe, expect, it } from 'vitest';
import { getCoreInfo } from './index.js';

describe('getCoreInfo', () => {
  it('reports the product name and the protocol version in use', () => {
    expect(getCoreInfo()).toEqual({ productName: 'Bildora', protocolVersion: PROTOCOL_VERSION });
  });
});

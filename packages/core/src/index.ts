import { PROTOCOL_VERSION } from '@bildora/protocol';

export interface CoreInfo {
  readonly productName: string;
  readonly protocolVersion: number;
}

/** Identifies this build of the core to its clients. */
export function getCoreInfo(): CoreInfo {
  return { productName: 'Bildora', protocolVersion: PROTOCOL_VERSION };
}

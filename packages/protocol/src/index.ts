/** Current version of the tool protocol. */
export const PROTOCOL_VERSION = 1;

/** Tells whether a value received from a tool names a protocol version this build speaks. */
export function isSupportedProtocolVersion(version: unknown): boolean {
  return version === PROTOCOL_VERSION;
}

export {
  MANIFEST_SCHEMA_VERSION,
  PERMISSIONS,
  buildToolManifestJsonSchema,
  isValidIdentifier,
  toolManifestSchema,
} from './manifest.js';
export type {
  Permission,
  ToolCommand,
  ToolManifest,
  ToolManifestInput,
  ToolOutput,
  ToolParameter,
} from './manifest.js';
export {
  isPathVariableName,
  replacePathVariables,
  startsWithPathVariable,
} from './path-variables.js';

import { MANIFEST_SCHEMA_VERSION, toolManifestSchema } from '@bildora/protocol';
import type { ToolManifest } from '@bildora/protocol';
import { parseDocument, stringify } from 'yaml';
import { DefinitionError } from '../storage/definition-error.js';
import { migrateDefinition } from '../storage/migrations.js';
import type { Migration } from '../storage/migrations.js';

/** Upgrade steps for older manifests. Version 1 is the first, so there are none yet. */
const MANIFEST_MIGRATIONS: readonly Migration[] = [];

const LABEL = 'tool manifest';

/** Reads a manifest from YAML text, upgrading an older format and validating the result. */
export function parseManifest(
  text: string,
  migrations: readonly Migration[] = MANIFEST_MIGRATIONS,
): ToolManifest {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new DefinitionError(
      'The tool manifest is not valid YAML',
      document.errors.map((error) => ({ path: '', message: error.message })),
    );
  }
  const content: unknown = document.toJS();
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new DefinitionError('The tool manifest must be a YAML mapping');
  }

  const migrated = migrateDefinition(
    { ...content },
    {
      label: LABEL,
      versionField: 'schemaVersion',
      currentVersion: MANIFEST_SCHEMA_VERSION,
      migrations,
    },
  );
  const result = toolManifestSchema.safeParse(migrated);
  if (!result.success) {
    throw new DefinitionError(
      'The tool manifest is not valid',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Writes a manifest as the YAML stored in the data directory. */
export function serializeManifest(manifest: ToolManifest): string {
  return stringify(manifest);
}

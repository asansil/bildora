import { DefinitionError } from './definition-error.js';

export type DefinitionDocument = Record<string, unknown>;

/** Moves a definition one step up. A step never skips a version. */
export interface Migration {
  readonly from: number;
  readonly migrate: (document: DefinitionDocument) => DefinitionDocument;
}

export interface VersionedFormat {
  /** Names the definition in messages, such as `tool manifest`. */
  readonly label: string;
  readonly versionField: string;
  readonly currentVersion: number;
  readonly migrations: readonly Migration[];
}

/** Reads a JSON object from text. Anything else gives undefined, for callers that can start over. */
export function parseDefinitionDocument(text: string): DefinitionDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { ...parsed }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Brings a definition to the format this build uses. The caller's document is left alone, and a
 * definition from a newer build is refused rather than guessed at, so nothing can rewrite it.
 */
export function migrateDefinition(
  document: DefinitionDocument,
  format: VersionedFormat,
): DefinitionDocument {
  const { label, versionField, currentVersion, migrations } = format;
  const found = document[versionField];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    throw new DefinitionError(`The ${label} has no valid ${versionField}`);
  }
  if (found > currentVersion) {
    throw new DefinitionError(
      `The ${label} uses ${versionField} ${String(found)}, but this version of Bildora supports up to ${String(currentVersion)}. Update Bildora to use it.`,
    );
  }

  let migrated = document;
  for (let version = found; version < currentVersion; version += 1) {
    const step = migrations.find((migration) => migration.from === version);
    if (step === undefined) {
      throw new DefinitionError(
        `The ${label} uses ${versionField} ${String(found)}, and this version of Bildora cannot upgrade it.`,
      );
    }
    migrated = { ...step.migrate(migrated), [versionField]: version + 1 };
  }
  return migrated;
}

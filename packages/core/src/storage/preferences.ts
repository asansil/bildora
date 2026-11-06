import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, writeFileAtomic } from './data-directory.js';
import { migrateDefinition, parseDefinitionDocument } from './migrations.js';
import type { VersionedFormat } from './migrations.js';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface Preferences {
  readonly theme: Theme;
}

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system' };

const PREFERENCES_FILE = 'preferences.json';
const PREFERENCES_VERSION = 1;
const format: VersionedFormat = {
  label: 'preferences file',
  versionField: 'formatVersion',
  currentVersion: PREFERENCES_VERSION,
  migrations: [],
};

function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

/**
 * Reads the preferences. Losing them is no reason to stop the app, so a damaged file or a bad value
 * gives the default. A file from a newer build throws instead, so it can never be overwritten.
 */
export async function readPreferences(dataDir: string): Promise<Preferences> {
  let text: string;
  try {
    text = await readFile(join(dataDir, PREFERENCES_FILE), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return DEFAULT_PREFERENCES;
    }
    throw error;
  }
  const document = parseDefinitionDocument(text);
  if (document === undefined || document['formatVersion'] === undefined) {
    return DEFAULT_PREFERENCES;
  }
  const { theme } = migrateDefinition(document, format);
  return isTheme(theme) ? { theme } : DEFAULT_PREFERENCES;
}

/** Stores the preferences, refusing to replace a file written by a newer build. */
export async function writePreferences(dataDir: string, preferences: Preferences): Promise<void> {
  await readPreferences(dataDir);
  const document = { formatVersion: PREFERENCES_VERSION, ...preferences };
  await writeFileAtomic(join(dataDir, PREFERENCES_FILE), `${JSON.stringify(document, null, 2)}\n`);
}

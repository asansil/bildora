import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, writeFileAtomic } from './data-directory.js';
import { migrateDefinition, parseDefinitionDocument } from './migrations.js';
import type { VersionedFormat } from './migrations.js';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Runs kept per tool, a limit users can change because history also serves as evidence. */
export const DEFAULT_HISTORY_RUN_LIMIT = 200;
export const HISTORY_RUN_LIMIT_MAX = 100_000;

export interface Preferences {
  /** Only the seed of the first Workspace. After that, each Workspace holds its own theme. */
  readonly theme: Theme;
  readonly historyRunLimit: number;
  /** Whether testing a block from the canvas first warns that real tools will run. */
  readonly warnBeforeTests: boolean;
  /** The Workspace to open with. Absent or gone, the app takes the first one. */
  readonly activeWorkspaceId?: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  historyRunLimit: DEFAULT_HISTORY_RUN_LIMIT,
  warnBeforeTests: true,
};

const PREFERENCES_FILE = 'preferences.json';
const PREFERENCES_VERSION = 1;
const format: VersionedFormat = {
  label: 'preferences file',
  versionField: 'formatVersion',
  currentVersion: PREFERENCES_VERSION,
  migrations: [],
};

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

function isHistoryRunLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= HISTORY_RUN_LIMIT_MAX
  );
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
  const { theme, historyRunLimit, warnBeforeTests, activeWorkspaceId } = migrateDefinition(
    document,
    format,
  );
  return {
    theme: isTheme(theme) ? theme : DEFAULT_PREFERENCES.theme,
    historyRunLimit: isHistoryRunLimit(historyRunLimit)
      ? historyRunLimit
      : DEFAULT_PREFERENCES.historyRunLimit,
    warnBeforeTests:
      typeof warnBeforeTests === 'boolean' ? warnBeforeTests : DEFAULT_PREFERENCES.warnBeforeTests,
    ...(typeof activeWorkspaceId === 'string' ? { activeWorkspaceId } : {}),
  };
}

/** Stores changed preferences, refusing to replace a file written by a newer build. */
export async function writePreferences(
  dataDir: string,
  changes: Partial<Preferences>,
): Promise<void> {
  const current = await readPreferences(dataDir);
  const document = { formatVersion: PREFERENCES_VERSION, ...current, ...changes };
  await writeFileAtomic(join(dataDir, PREFERENCES_FILE), `${JSON.stringify(document, null, 2)}\n`);
}

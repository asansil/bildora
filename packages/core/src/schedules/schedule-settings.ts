import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissingFile, writeFileAtomic } from '../storage/data-directory.js';
import { migrateDefinition, parseDefinitionDocument } from '../storage/migrations.js';
import type { VersionedFormat } from '../storage/migrations.js';
import type { TaskDefinition } from './task-xml.js';

const SETTINGS_FILE = 'schedules.json';
const SETTINGS_VERSION = 1;
const format: VersionedFormat = {
  label: 'schedules file',
  versionField: 'formatVersion',
  currentVersion: SETTINGS_VERSION,
  migrations: [],
};

/** An automation whose schedule is on for this computer. */
export interface ScheduleSetting {
  readonly workspaceId: string;
  readonly automationId: string;
  /** Runs when nobody is signed in, which needs administrator rights to set up. */
  readonly signedOut: boolean;
  /**
   * What Bildora last wrote to the task. A task that no longer matches it was changed by someone
   * else, while one that matches it but not the automation only needs bringing up to date.
   */
  readonly written?: TaskDefinition;
}

const keyOf = ({
  workspaceId,
  automationId,
}: Pick<ScheduleSetting, 'workspaceId' | 'automationId'>) => `${workspaceId}/${automationId}`;

function isSetting(value: unknown): value is ScheduleSetting {
  return (
    typeof value === 'object' &&
    value !== null &&
    'workspaceId' in value &&
    typeof value.workspaceId === 'string' &&
    'automationId' in value &&
    typeof value.automationId === 'string' &&
    'signedOut' in value &&
    typeof value.signedOut === 'boolean'
  );
}

/**
 * Reads which schedules are on for this computer. The file sits outside every Workspace, so an
 * exported or shared automation never carries it and never starts itself somewhere else.
 */
export async function readScheduleSettings(dataDir: string): Promise<readonly ScheduleSetting[]> {
  let text: string;
  try {
    text = await readFile(join(dataDir, SETTINGS_FILE), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const document = parseDefinitionDocument(text);
  if (document === undefined || document['formatVersion'] === undefined) return [];
  const { schedules } = migrateDefinition(document, format);
  return Array.isArray(schedules) ? schedules.filter(isSetting) : [];
}

async function writeSettings(dataDir: string, settings: readonly ScheduleSetting[]): Promise<void> {
  const document = { formatVersion: SETTINGS_VERSION, schedules: settings };
  await writeFileAtomic(join(dataDir, SETTINGS_FILE), `${JSON.stringify(document, null, 2)}\n`);
}

/** Adds or replaces the setting of one automation. */
export async function putScheduleSetting(dataDir: string, setting: ScheduleSetting): Promise<void> {
  const settings = await readScheduleSettings(dataDir);
  const key = keyOf(setting);
  await writeSettings(dataDir, [...settings.filter((item) => keyOf(item) !== key), setting]);
}

/** Turns one automation's schedule off for this computer. */
export async function removeScheduleSetting(
  dataDir: string,
  location: Pick<ScheduleSetting, 'workspaceId' | 'automationId'>,
): Promise<void> {
  const settings = await readScheduleSettings(dataDir);
  const key = keyOf(location);
  if (settings.some((item) => keyOf(item) === key)) {
    await writeSettings(
      dataDir,
      settings.filter((item) => keyOf(item) !== key),
    );
  }
}

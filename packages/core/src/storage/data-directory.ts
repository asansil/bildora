import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isValidIdentifier } from '@bildora/protocol';
import { DefinitionError } from './definition-error.js';
import { migrateDefinition } from './migrations.js';
import type { DefinitionDocument, VersionedFormat } from './migrations.js';

/** Layout version of the data directory itself, as opposed to the definitions inside it. */
export const DATA_FORMAT_VERSION = 1;

const FORMAT_FILE = 'format.json';
const dataFormat: VersionedFormat = {
  label: 'data directory',
  versionField: 'formatVersion',
  currentVersion: DATA_FORMAT_VERSION,
  migrations: [],
};

export type InstallScope =
  { readonly kind: 'global' } | { readonly kind: 'workspace'; readonly workspaceId: string };

export const GLOBAL_SCOPE: InstallScope = { kind: 'global' };

export interface DataDirectoryOptions {
  readonly dataDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

/** Finds the data directory: an explicit one, then `BILDORA_DATA_DIR`, then the user's default. */
export function resolveDataDir(options: DataDirectoryOptions = {}): string {
  const { dataDir, env = process.env, platform = process.platform } = options;
  const override = dataDir ?? env['BILDORA_DATA_DIR'];
  if (override !== undefined && override !== '') {
    return resolve(override);
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData === undefined || appData === '') {
      throw new Error('APPDATA is not set, so the data directory cannot be found');
    }
    return join(appData, 'Bildora');
  }
  const dataHome = env['XDG_DATA_HOME'] ?? (env['HOME'] && join(env['HOME'], '.local', 'share'));
  if (dataHome === undefined || dataHome === '') {
    throw new Error('Neither XDG_DATA_HOME nor HOME is set, so the data directory cannot be found');
  }
  return join(dataHome, 'bildora');
}

/** Creates the data directory if needed, and refuses one written by a newer build. */
export async function openDataDirectory(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, FORMAT_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      await writeFileAtomic(file, formatFileContent());
      return;
    }
    throw error;
  }
  const stored = parseFormatFile(text);
  if (migrateDefinition(stored, dataFormat) !== stored) {
    await writeFileAtomic(file, formatFileContent());
  }
}

function formatFileContent(): string {
  return `${JSON.stringify({ formatVersion: DATA_FORMAT_VERSION }, null, 2)}\n`;
}

function parseFormatFile(text: string): DefinitionDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DefinitionError(`${FORMAT_FILE} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DefinitionError(`${FORMAT_FILE} is not a JSON object`);
  }
  return { ...parsed };
}

/** Folder holding the tools of one install scope. */
export function toolsDirectory(dataDir: string, scope: InstallScope): string {
  if (scope.kind === 'global') {
    return join(dataDir, 'tools');
  }
  assertIdentifier(scope.workspaceId, 'Workspace id');
  return join(dataDir, 'workspaces', scope.workspaceId, 'tools');
}

/** Folder of one tool. The id is checked here because it becomes part of a path. */
export function toolDirectory(dataDir: string, scope: InstallScope, toolId: string): string {
  assertIdentifier(toolId, 'Tool id');
  return join(toolsDirectory(dataDir, scope), toolId);
}

function assertIdentifier(value: string, label: string): void {
  if (!isValidIdentifier(value)) {
    throw new DefinitionError(`${label} "${value}" is not valid`);
  }
}

/** Replaces a file in one step, so a crash leaves the old content or the new, never a mix. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { isPathVariableName } from '@bildora/protocol';
import { isMissingFile, writeFileAtomic } from './data-directory.js';
import { DefinitionError } from './definition-error.js';
import { migrateDefinition, parseDefinitionDocument } from './migrations.js';
import type { VersionedFormat } from './migrations.js';

const VARIABLES_FILE = 'path-variables.json';
const VARIABLES_VERSION = 1;
const format: VersionedFormat = {
  label: 'path variables file',
  versionField: 'formatVersion',
  currentVersion: VARIABLES_VERSION,
  migrations: [],
};

function isAbsolutePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

/**
 * Reads this machine's path variables. The file sits outside every Workspace because its values
 * mean nothing elsewhere, so an export cannot carry them. A damaged file gives none, and tools
 * using them say so. A file from a newer build throws, so it stays intact.
 */
export async function readPathVariables(dataDir: string): Promise<ReadonlyMap<string, string>> {
  let text: string;
  try {
    text = await readFile(join(dataDir, VARIABLES_FILE), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return new Map();
    }
    throw error;
  }
  const document = parseDefinitionDocument(text);
  if (document === undefined || document['formatVersion'] === undefined) {
    return new Map();
  }
  const { variables } = migrateDefinition(document, format);
  if (typeof variables !== 'object' || variables === null) {
    return new Map();
  }
  return new Map(
    Object.entries(variables).filter(
      (entry): entry is [string, string] =>
        isPathVariableName(entry[0]) && typeof entry[1] === 'string' && isAbsolutePath(entry[1]),
    ),
  );
}

async function writeVariables(
  dataDir: string,
  variables: ReadonlyMap<string, string>,
): Promise<void> {
  const document = { formatVersion: VARIABLES_VERSION, variables: Object.fromEntries(variables) };
  await writeFileAtomic(join(dataDir, VARIABLES_FILE), `${JSON.stringify(document, null, 2)}\n`);
}

/** Adds a variable or changes its value. */
export async function setPathVariable(dataDir: string, name: string, value: string): Promise<void> {
  if (!isPathVariableName(name)) {
    throw new DefinitionError(
      `"${name}" cannot name a path variable. Use letters, digits, - and _, starting with a letter.`,
    );
  }
  if (!isAbsolutePath(value)) {
    throw new DefinitionError('The value of a path variable must be an absolute path');
  }
  const variables = new Map(await readPathVariables(dataDir));
  variables.set(name, value);
  await writeVariables(dataDir, variables);
}

export async function removePathVariable(dataDir: string, name: string): Promise<void> {
  const variables = new Map(await readPathVariables(dataDir));
  if (variables.delete(name)) {
    await writeVariables(dataDir, variables);
  }
}

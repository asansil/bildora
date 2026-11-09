import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { startsWithPathVariable } from '@bildora/protocol';
import type { Permission, ToolManifest } from '@bildora/protocol';
import { parseManifest } from '../manifest/parse-manifest.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { resolveExecutable } from '../runner/resolve-executable.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import type { InstallScope } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';

export const MANIFEST_FILE_NAME = 'tool.yaml';
/** Larger than any real manifest, so that a stray file named like one is not read in full. */
const MANIFEST_BYTE_LIMIT = 1024 * 1024;

export interface ManifestProposal {
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly level: 1;
  readonly category?: string;
  readonly description?: string;
  readonly interpreter?: string;
  readonly permissions: readonly Permission[];
  /** A tool with this id exists, and importing replaces its manifest. Its profiles stay. */
  readonly alreadyRegistered: boolean;
}

export interface RefusedManifest {
  readonly path: string;
  readonly reason: string;
}

export interface ManifestImportReport {
  readonly registered: readonly RegisteredTool[];
  readonly failures: readonly { readonly program: string; readonly message: string }[];
}

export function isManifestFile(path: string): boolean {
  return basename(path).toLowerCase() === MANIFEST_FILE_NAME;
}

function describeError(error: unknown): string {
  if (error instanceof DefinitionError) {
    const [first] = error.issues;
    if (first !== undefined) {
      return first.path === '' ? first.message : `${first.path}: ${first.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Reads a manifest as data. Nothing it names is opened or run. */
async function readLevelOneManifest(path: string): Promise<ToolManifest & { level: 1 }> {
  const { size } = await stat(path);
  if (size > MANIFEST_BYTE_LIMIT) {
    throw new DefinitionError('This file is too large to be a tool manifest');
  }
  const manifest = parseManifest(await readFile(path, 'utf8'));
  if (manifest.level === 0) {
    throw new DefinitionError('This is a level 0 manifest. Add its program directly instead');
  }
  return manifest;
}

export async function proposeManifest(
  path: string,
  registeredIds: ReadonlySet<string>,
): Promise<ManifestProposal | RefusedManifest> {
  try {
    const manifest = await readLevelOneManifest(path);
    const { id, name, category, description, interpreter, permissions } = manifest;
    return {
      path,
      id,
      name,
      level: 1,
      ...(category === undefined ? {} : { category }),
      ...(description === undefined ? {} : { description }),
      ...(interpreter === undefined ? {} : { interpreter }),
      permissions,
      alreadyRegistered: registeredIds.has(id),
    };
  } catch (error) {
    return { path, reason: describeError(error) };
  }
}

/**
 * Only the manifest is stored, so the program stays where its author keeps it, and it needs a path
 * that works from there. A plain name found nowhere near the manifest is left for `PATH`.
 */
async function anchorProgram(
  manifest: ToolManifest & { level: 1 },
  folder: string,
): Promise<ToolManifest> {
  const { program } = manifest.run;
  if (isAbsolute(program) || startsWithPathVariable(program)) {
    return manifest;
  }
  const beside = await resolveExecutable(program, { env: {}, searchFirst: [folder] });
  const anchored = beside ?? (/[\\/]/.test(program) ? join(folder, program) : undefined);
  return anchored === undefined
    ? manifest
    : { ...manifest, run: { ...manifest.run, program: anchored } };
}

/**
 * Installs reviewed manifests, read again from disk: what the user confirmed was a path, and only
 * core decides what that file means. One bad entry does not stop the others.
 */
export async function importManifests(
  registry: ToolRegistry,
  paths: readonly string[],
  scope: InstallScope = GLOBAL_SCOPE,
): Promise<ManifestImportReport> {
  const registered: RegisteredTool[] = [];
  const failures: { program: string; message: string }[] = [];
  for (const path of paths) {
    try {
      if (!isManifestFile(path)) {
        throw new DefinitionError(`Only files named ${MANIFEST_FILE_NAME} can be imported`);
      }
      const manifest = await anchorProgram(await readLevelOneManifest(path), dirname(path));
      registered.push(await registry.register(manifest, { replace: true, scope }));
    } catch (error) {
      failures.push({ program: path, message: describeError(error) });
    }
  }
  return { registered, failures };
}

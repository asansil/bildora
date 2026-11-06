import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { RegisteredTool } from '../registry/tool-registry.js';
import { expandPath } from '../runner/expand-paths.js';
import type { PathVariables } from '../runner/expand-paths.js';
import { resolveExecutable } from '../runner/resolve-executable.js';
import { MANIFEST_FILE_NAME, isManifestFile, proposeManifest } from './import-manifest.js';
import type { ManifestProposal, RefusedManifest } from './import-manifest.js';

/** What a scan returns at most, so that pointing it at a whole drive stays usable. */
export const SCAN_RESULT_LIMIT = 500;

/** Interpreters by extension, in order of preference. An empty list means it runs by itself. */
const INTERPRETERS: Readonly<Record<string, readonly string[]>> = {
  '.exe': [],
  '.com': [],
  '.bat': [],
  '.cmd': [],
  '.py': ['python', 'py'],
  '.pyw': ['pythonw', 'pyw'],
  '.js': ['node'],
  '.mjs': ['node'],
  '.ps1': ['powershell'],
};

/** Folders that hold dependencies or tooling rather than the user's own programs. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  'venv',
  'site-packages',
  '__pycache__',
]);

export interface ProgramProposal {
  readonly path: string;
  readonly name: string;
  readonly category?: string;
  readonly interpreter?: string;
  /** The same program is already registered, so importing it again is probably a mistake. */
  readonly alreadyRegistered: boolean;
}

export interface Detection {
  readonly proposals: readonly ProgramProposal[];
  /** Manifests of declarative tools, found by name and read as data. */
  readonly manifests: readonly ManifestProposal[];
  /** Files named like a manifest that Bildora cannot use, with the reason. */
  readonly refused: readonly RefusedManifest[];
  /** Paths given directly that are not a program Bildora recognizes, or cannot be read. */
  readonly skipped: readonly string[];
  /** The scan stopped at its limit, so there may be more. */
  readonly truncated: boolean;
}

export interface DetectOptions {
  /** Whether folders are searched below their first level. */
  readonly recursive?: boolean;
  /** Tools already installed, to mark what would be a duplicate. */
  readonly registered?: readonly RegisteredTool[];
  /** Lets a tool that points through a path variable match the real file. */
  readonly pathVariables?: PathVariables;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly limit?: number;
}

/** Turns a file or folder name into a label: `log_parser` becomes `Log Parser`. */
export function displayName(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const label = spaced === '' ? name : spaced;
  return label.replace(/(^|\s)(\p{Ll}+)/gu, (_match, gap: string, word: string) => {
    return `${gap}${word.charAt(0).toLocaleUpperCase('en')}${word.slice(1)}`;
  });
}

function isDetectable(path: string): boolean {
  return isManifestFile(path) || Object.hasOwn(INTERPRETERS, extname(path).toLowerCase());
}

/** Picks the first interpreter that is installed, or the usual one so the warning can name it. */
async function chooseInterpreter(
  extension: string,
  env: DetectOptions['env'],
): Promise<string | undefined> {
  const candidates = INTERPRETERS[extension] ?? [];
  for (const candidate of candidates) {
    if ((await resolveExecutable(candidate, env === undefined ? {} : { env })) !== undefined) {
      return candidate;
    }
  }
  return candidates[0];
}

function normalizedPath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function comparablePath(program: string, variables: PathVariables): string {
  try {
    return normalizedPath(expandPath(program, variables));
  } catch {
    return normalizedPath(program);
  }
}

function registeredPrograms(
  tools: readonly RegisteredTool[],
  variables: PathVariables,
): Set<string> {
  return new Set(
    tools.flatMap(({ manifest }) =>
      manifest.level === 2 ? [] : [comparablePath(manifest.run.program, variables)],
    ),
  );
}

async function propose(
  path: string,
  registered: ReadonlySet<string>,
  env: DetectOptions['env'],
): Promise<ProgramProposal> {
  const interpreter = await chooseInterpreter(extname(path).toLowerCase(), env);
  const folder = basename(dirname(path));
  return {
    path,
    name: displayName(basename(path, extname(path))),
    ...(folder === '' ? {} : { category: displayName(folder) }),
    ...(interpreter === undefined ? {} : { interpreter }),
    alreadyRegistered: registered.has(normalizedPath(path)),
  };
}

function isSkippedFolder(name: string): boolean {
  return name.startsWith('.') || SKIPPED_FOLDERS.has(name);
}

interface FolderScan {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/**
 * Finds candidate programs by name alone: nothing is opened, let alone executed. Links are not
 * followed, so a scan cannot loop or leave the chosen folder. Unreadable folders are passed over.
 */
async function scanFolder(root: string, recursive: boolean, limit: number): Promise<FolderScan> {
  const files: string[] = [];
  const pending = [root];
  for (let folder = pending.shift(); folder !== undefined; folder = pending.shift()) {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((first, second) => first.name.localeCompare(second.name));
    // A manifest speaks for its whole folder, whose scripts are that tool's parts.
    const manifest = entries.find((entry) => entry.isFile() && entry.name === MANIFEST_FILE_NAME);
    for (const entry of manifest === undefined ? entries : [manifest]) {
      const path = join(folder, entry.name);
      if (entry.isFile() && isDetectable(path)) {
        if (files.length === limit) {
          return { files, truncated: true };
        }
        files.push(path);
      } else if (recursive && entry.isDirectory() && !isSkippedFolder(entry.name)) {
        pending.push(path);
      }
    }
  }
  return { files, truncated: false };
}

type PathKind = 'file' | 'folder' | 'other';

async function kindOf(path: string): Promise<PathKind> {
  try {
    const found = await stat(path);
    if (found.isDirectory()) {
      return 'folder';
    }
    return found.isFile() ? 'file' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Proposes tools for dropped or chosen files and folders, for the user to review. It looks at paths
 * and extensions, and reads manifests as data, so a hostile file cannot do anything by being
 * detected.
 */
export async function detectPrograms(
  paths: readonly string[],
  options: DetectOptions = {},
): Promise<Detection> {
  const { recursive = true, registered = [], env, limit = SCAN_RESULT_LIMIT } = options;
  const known = registeredPrograms(registered, options.pathVariables ?? new Map<string, string>());
  const found = new Map<string, string>();
  const skipped: string[] = [];
  let truncated = false;

  for (const path of paths) {
    const kind = await kindOf(path);
    if (kind === 'folder') {
      const scan = await scanFolder(path, recursive, limit - found.size);
      truncated ||= scan.truncated;
      for (const file of scan.files) {
        found.set(normalizedPath(file), file);
      }
    } else if (kind !== 'file' || !isDetectable(path)) {
      skipped.push(path);
    } else if (found.size < limit) {
      found.set(normalizedPath(path), path);
    } else {
      truncated = true;
    }
  }

  const proposals: ProgramProposal[] = [];
  const manifests: ManifestProposal[] = [];
  const refused: RefusedManifest[] = [];
  const registeredIds = new Set(registered.map((tool) => tool.manifest.id));
  for (const path of found.values()) {
    if (isManifestFile(path)) {
      const proposal = await proposeManifest(path, registeredIds);
      if ('reason' in proposal) {
        refused.push(proposal);
      } else {
        manifests.push(proposal);
      }
    } else {
      proposals.push(await propose(path, known, env));
    }
  }
  return { proposals, manifests, refused, skipped, truncated };
}

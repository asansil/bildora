import { stat } from 'node:fs/promises';
import { delimiter as hostDelimiter, extname, isAbsolute, join, win32 } from 'node:path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface ResolveOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Folders searched before `PATH`, such as the tool's own. */
  readonly searchFirst?: readonly string[];
}

/** Reads an environment variable. Windows names are case-insensitive, but a plain object's are not. */
export function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * A name without a known extension is tried with each one first, as a Windows shell would. The bare
 * name comes last: Node, for one, installs an `npm` shell script beside the `npm.cmd` that runs.
 */
function candidateNames(name: string, platform: NodeJS.Platform, pathExt: string): string[] {
  if (platform !== 'win32') {
    return [name];
  }
  const extensions = pathExt.split(';').filter((extension) => extension !== '');
  const known = extensions.some(
    (extension) => extension.toUpperCase() === extname(name).toUpperCase(),
  );
  return known ? [name] : [...extensions.map((extension) => `${name}${extension}`), name];
}

/**
 * Finds the full path of a program, or undefined when it is not installed. `node-pty` does not
 * search `PATH` for a name without its extension, and this also backs the missing runtime warning.
 * Relative `PATH` entries are skipped, so a file planted in the working folder is never picked.
 */
export async function resolveExecutable(
  name: string,
  options: ResolveOptions = {},
): Promise<string | undefined> {
  const { env = process.env, platform = process.platform, searchFirst = [] } = options;
  const pathExt = readEnv(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
  const names = candidateNames(name, platform, pathExt);
  const absolute = platform === 'win32' ? win32.isAbsolute(name) : isAbsolute(name);

  if (absolute) {
    for (const candidate of names) {
      if (await isFile(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  const delimiter = platform === 'win32' ? ';' : hostDelimiter;
  const pathEntries = (readEnv(env, 'PATH') ?? '')
    .split(delimiter)
    .filter((entry) => (platform === 'win32' ? win32.isAbsolute(entry) : isAbsolute(entry)));
  // A name holding a folder is a path, which only makes sense from the first search locations.
  const named = /[\\/]/.test(name);
  for (const directory of named ? searchFirst : [...searchFirst, ...pathEntries]) {
    for (const candidate of names) {
      const path = join(directory, candidate);
      if (await isFile(path)) {
        return path;
      }
    }
  }
  return undefined;
}

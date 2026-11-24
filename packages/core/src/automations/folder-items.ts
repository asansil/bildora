import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * A file pattern such as `*.pdf` or `report-??.csv` as a test on a file name: `*` stands for any
 * run of characters and `?` for one. Case does not count, as on Windows.
 */
export function filePattern(pattern: string | undefined): (name: string) => boolean {
  if (pattern === undefined || pattern === '*') return () => true;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const expression = new RegExp(`^${source}$`, 'i');
  return (name) => expression.test(name);
}

/** Thrown when a folder holds more matching files than a loop may go through. */
export class TooManyItemsError extends Error {}

/**
 * The files of a folder that match a pattern, as full paths sorted by their path inside the folder.
 * It stops as soon as it finds more than `limit`, so a huge folder is not read to its end.
 */
export async function folderItems(
  folder: string,
  options: { readonly pattern?: string | undefined; readonly subfolders?: boolean | undefined },
  limit: number,
): Promise<string[]> {
  const matches = filePattern(options.pattern);
  const found: string[] = [];
  const visit = async (at: string): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (options.subfolders === true) await visit(path);
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(path);
        if (found.length > limit) throw new TooManyItemsError();
      }
    }
  };
  await visit(folder);
  const key = (path: string): string => relative(folder, path).toLocaleLowerCase('en');
  return found.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

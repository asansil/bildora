import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { categoryKey } from '../tools/tool-status.js';
import { isMissingFile, writeFileAtomic } from './data-directory.js';
import { migrateDefinition, parseDefinitionDocument } from './migrations.js';
import type { VersionedFormat } from './migrations.js';

/** Logos travel inside the tool catalog on every refresh, so they have to stay small. */
export const LOGO_MAX_BYTES = 256 * 1024;

interface ImageFormat {
  readonly mediaType: string;
  readonly matches: (bytes: Buffer) => boolean;
}

function hasBytes(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[index + offset] === value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const WEBP_SIGNATURE_OFFSET = 8;

const jpeg: ImageFormat = {
  mediaType: 'image/jpeg',
  matches: (bytes) => hasBytes(bytes, JPEG_SIGNATURE),
};

const FORMATS = new Map<string, ImageFormat>([
  ['.png', { mediaType: 'image/png', matches: (bytes) => hasBytes(bytes, PNG_SIGNATURE) }],
  ['.jpg', jpeg],
  ['.jpeg', jpeg],
  [
    '.webp',
    {
      mediaType: 'image/webp',
      matches: (bytes) =>
        hasBytes(bytes, RIFF_SIGNATURE) && hasBytes(bytes, WEBP_SIGNATURE, WEBP_SIGNATURE_OFFSET),
    },
  ],
  [
    '.svg',
    {
      mediaType: 'image/svg+xml',
      matches: (bytes) => /<svg[\s>]/i.test(bytes.toString('utf8')),
    },
  ],
]);

/** File extensions a logo can have, without the dot. */
export const LOGO_EXTENSIONS: readonly string[] = [...FORMATS.keys()].map((key) => key.slice(1));

const LOGOS_FILE = 'category-logos.json';
const LOGOS_VERSION = 1;
const DATA_URL_PREFIX = 'data:image/';
const format: VersionedFormat = {
  label: 'category logos file',
  versionField: 'formatVersion',
  currentVersion: LOGOS_VERSION,
  migrations: [],
};

/**
 * Reads the stored logos, as data URLs by category key. A map, because keys are names the user
 * typed, and `constructor` must not find what every object inherits. Losing logos is no reason to
 * stop the app, so a damaged file gives none. A file from a newer build throws, so it stays intact.
 */
export async function readCategoryLogos(dataDir: string): Promise<ReadonlyMap<string, string>> {
  let text: string;
  try {
    text = await readFile(join(dataDir, LOGOS_FILE), 'utf8');
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
  const { logos } = migrateDefinition(document, format);
  if (typeof logos !== 'object' || logos === null) {
    return new Map();
  }
  return new Map(
    Object.entries(logos).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].startsWith(DATA_URL_PREFIX),
    ),
  );
}

async function writeLogos(dataDir: string, logos: ReadonlyMap<string, string>): Promise<void> {
  const document = { formatVersion: LOGOS_VERSION, logos: Object.fromEntries(logos) };
  await writeFileAtomic(join(dataDir, LOGOS_FILE), `${JSON.stringify(document, null, 2)}\n`);
}

async function loadImage(source: string): Promise<string> {
  const imageFormat = FORMATS.get(extname(source).toLowerCase());
  if (imageFormat === undefined) {
    throw new Error('A logo must be a PNG, JPG, WebP or SVG file.');
  }
  const { size } = await stat(source);
  if (size > LOGO_MAX_BYTES) {
    throw new Error(`A logo can be ${String(LOGO_MAX_BYTES / 1024)} KB at most.`);
  }
  const bytes = await readFile(source);
  if (!imageFormat.matches(bytes)) {
    throw new Error('This file is damaged, or is not the kind of image its name says.');
  }
  return `data:${imageFormat.mediaType};base64,${bytes.toString('base64')}`;
}

/** Stores a copy of an image as the logo of a category, so the original can move or go away. */
export async function setCategoryLogo(
  dataDir: string,
  category: string,
  source: string,
): Promise<void> {
  const image = await loadImage(source);
  const logos = new Map(await readCategoryLogos(dataDir));
  logos.set(categoryKey(category), image);
  await writeLogos(dataDir, logos);
}

/** Goes back to the default logo of a category. */
export async function removeCategoryLogo(dataDir: string, category: string): Promise<void> {
  const logos = new Map(await readCategoryLogos(dataDir));
  if (logos.delete(categoryKey(category))) {
    await writeLogos(dataDir, logos);
  }
}

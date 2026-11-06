import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOGO_MAX_BYTES,
  readCategoryLogos,
  removeCategoryLogo,
  setCategoryLogo,
} from './category-logos.js';
import { DefinitionError } from './definition-error.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('category logos', () => {
  let dataDir: string;
  let file: string;

  async function image(name: string, content: Buffer): Promise<string> {
    const path = join(dataDir, name);
    await writeFile(path, content);
    return path;
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-logos-'));
    file = join(dataDir, 'category-logos.json');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('starts with none', async () => {
    expect((await readCategoryLogos(dataDir)).size).toBe(0);
  });

  it.each([
    ['logo.png', PNG, 'image/png'],
    ['logo.PNG', PNG, 'image/png'],
    ['logo.jpg', JPEG, 'image/jpeg'],
    ['logo.jpeg', JPEG, 'image/jpeg'],
    ['logo.webp', WEBP, 'image/webp'],
    ['logo.svg', SVG, 'image/svg+xml'],
  ])('stores %s as a data URL', async (name, content, mediaType) => {
    await setCategoryLogo(dataDir, 'Analysis', await image(name, content));

    const stored = (await readCategoryLogos(dataDir)).get('analysis');
    expect(stored).toBe(`data:${mediaType};base64,${content.toString('base64')}`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ formatVersion: 1 });
  });

  it('keeps working once the original file is gone', async () => {
    const source = await image('logo.png', PNG);
    await setCategoryLogo(dataDir, 'Analysis', source);
    await rm(source);

    expect((await readCategoryLogos(dataDir)).has('analysis')).toBe(true);
  });

  it('treats names differing only in case as one category', async () => {
    await setCategoryLogo(dataDir, 'Analysis', await image('one.png', PNG));
    await setCategoryLogo(dataDir, 'ANALYSIS', await image('two.jpg', JPEG));

    const logos = await readCategoryLogos(dataDir);
    expect([...logos.keys()]).toEqual(['analysis']);
    expect(logos.get('analysis')).toContain('image/jpeg');
  });

  it('leaves the other categories alone when one is removed', async () => {
    await setCategoryLogo(dataDir, 'One', await image('one.png', PNG));
    await setCategoryLogo(dataDir, 'Two', await image('two.png', PNG));

    await removeCategoryLogo(dataDir, 'ONE');

    expect([...(await readCategoryLogos(dataDir)).keys()]).toEqual(['two']);
  });

  it('has nothing to do when removing a logo that was never set', async () => {
    await expect(removeCategoryLogo(dataDir, 'Nothing')).resolves.toBeUndefined();
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'treats %s as any other category name',
    async (category) => {
      const key = category.toLowerCase();
      expect((await readCategoryLogos(dataDir)).has(key)).toBe(false);

      await setCategoryLogo(dataDir, category, await image('logo.png', PNG));

      expect((await readCategoryLogos(dataDir)).has(key)).toBe(true);
    },
  );

  it.each([
    ['an extension that is not an image', 'logo.exe', PNG, 'must be a PNG'],
    ['no extension', 'logo', PNG, 'must be a PNG'],
    ['content that does not match the extension', 'logo.png', JPEG, 'damaged'],
    ['an SVG with no svg element', 'logo.svg', Buffer.from('<html></html>'), 'damaged'],
    ['a file too large', 'logo.png', Buffer.alloc(LOGO_MAX_BYTES + 1), '256 KB'],
  ])('refuses %s, and keeps what was there', async (_label, name, content, message) => {
    await setCategoryLogo(dataDir, 'Analysis', await image('good.png', PNG));
    const before = await readCategoryLogos(dataDir);

    await expect(setCategoryLogo(dataDir, 'Analysis', await image(name, content))).rejects.toThrow(
      message,
    );

    expect(await readCategoryLogos(dataDir)).toEqual(before);
  });

  it('accepts a file of exactly the largest size', async () => {
    const content = Buffer.alloc(LOGO_MAX_BYTES);
    PNG.copy(content);

    await expect(
      setCategoryLogo(dataDir, 'Analysis', await image('logo.png', content)),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['damaged JSON', '{ nope'],
    ['a value that is not an object', '[]'],
    ['no format version', '{"logos":{"a":"data:image/png;base64,AA=="}}'],
    ['logos that are not an object', '{"formatVersion":1,"logos":3}'],
    ['no logos', '{"formatVersion":1}'],
    ['a value that is not a data URL', '{"formatVersion":1,"logos":{"a":"https://x.test/a.png"}}'],
    ['a value that is not text', '{"formatVersion":1,"logos":{"a":1}}'],
  ])('gives no logos with %s', async (_label, text) => {
    await writeFile(file, text);

    expect((await readCategoryLogos(dataDir)).size).toBe(0);
  });

  it('refuses a file from a newer build, and leaves it as it was', async () => {
    const newer = '{"formatVersion":99}';
    await writeFile(file, newer);

    await expect(readCategoryLogos(dataDir)).rejects.toBeInstanceOf(DefinitionError);
    await expect(
      setCategoryLogo(dataDir, 'Analysis', await image('logo.png', PNG)),
    ).rejects.toBeInstanceOf(DefinitionError);
    expect(await readFile(file, 'utf8')).toBe(newer);
  });
});

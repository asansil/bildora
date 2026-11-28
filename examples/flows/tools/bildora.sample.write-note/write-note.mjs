// Writes the text it is given to a file, creating the file's folder first.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { file: { type: 'string' }, text: { type: 'string' } } });

if (values.file === undefined) {
  console.error('Usage: write-note.mjs --file <file> [--text <text>]');
  process.exit(2);
}

await mkdir(dirname(values.file), { recursive: true });
await writeFile(values.file, `${values.text ?? ''}\n`);
console.log(`Wrote ${values.file}`);

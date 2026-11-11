// Checks a text file and writes what it found to summary.json in the folder it is given. It takes
// ordinary arguments and needs nothing from Bildora: an automation reads the file afterwards.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    out: { type: 'string' },
    'max-length': { type: 'string', default: '120' },
  },
});

if (values.file === undefined || values.out === undefined) {
  console.error('Usage: check.mjs --file <text file> --out <folder> [--max-length <n>]');
  process.exit(2);
}

const maxLength = Number(values['max-length']);
const text = await readFile(values.file, 'utf8');
const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
const tooLong = lines.flatMap((line, index) =>
  line.length > maxLength ? [String(index + 1)] : [],
);

const summary = {
  lines: lines.length,
  words: text.split(/\s+/).filter((word) => word !== '').length,
  empty: text.trim() === '',
  longest: Math.max(0, ...lines.map((line) => line.length)),
  tooLong,
  name: basename(values.file),
};

await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${summary.name}: ${String(summary.lines)} lines, ${String(tooLong.length)} too long`);

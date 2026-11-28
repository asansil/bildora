// Counts the lines of a log that hold ERROR or WARN, and writes the counts to scan.json in the
// folder it is given. It takes ordinary arguments and needs nothing from Bildora.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { file: { type: 'string' }, out: { type: 'string' } } });

if (values.file === undefined || values.out === undefined) {
  console.error('Usage: scan-log.mjs --file <log> --out <folder>');
  process.exit(2);
}

const text = await readFile(values.file, 'utf8');
const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
const scan = {
  errors: lines.filter((line) => line.includes('ERROR')).length,
  warnings: lines.filter((line) => line.includes('WARN')).length,
  lines: lines.length,
};

await mkdir(values.out, { recursive: true });
await writeFile(join(values.out, 'scan.json'), `${JSON.stringify(scan, null, 2)}\n`);
console.log(`${String(scan.errors)} errors, ${String(scan.warnings)} warnings`);

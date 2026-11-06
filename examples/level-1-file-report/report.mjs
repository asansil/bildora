// Reports on a text file. It takes ordinary arguments, and needs nothing from Bildora: the optional
// progress lines are plain output, which any other console simply shows.
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    format: { type: 'string', default: 'text' },
    top: { type: 'string', default: '3' },
    minimum: { type: 'string', default: '0' },
    title: { type: 'string', default: 'File report' },
    verbose: { type: 'boolean', default: false },
  },
});

function write(text) {
  return new Promise((resolve) => {
    process.stdout.write(`${text}\n`, resolve);
  });
}

function progress(percent, message) {
  return write(`::bildora-progress ${JSON.stringify({ percent, message })}`);
}

if (values.file === undefined) {
  console.error('--file is required');
  process.exit(2);
}

await progress(0, 'Reading the file');
let text;
try {
  text = await readFile(values.file, 'utf8');
} catch (error) {
  console.error(`Cannot read the file: ${error.message}`);
  process.exit(1);
}

await progress(50, 'Counting');
const minimum = Number(values.minimum);
const lines = text.split(/\r?\n/).filter((line) => line.length >= minimum);
const words = text.split(/\s+/).filter((word) => word !== '').length;
const longest = [...lines].sort((a, b) => b.length - a.length).slice(0, Number(values.top));

if (values.verbose) {
  await write(`Read ${String(text.length)} characters from ${values.file}`);
}

await progress(100, 'Done');
const report = { lines: lines.length, words, bytes: Buffer.byteLength(text), longest };
if (values.format === 'json') {
  await write(JSON.stringify(report, null, 2));
} else {
  await write(values.title);
  await write(`Lines: ${String(report.lines)}`);
  await write(`Words: ${String(report.words)}`);
  await write(`Bytes: ${String(report.bytes)}`);
  for (const line of longest) {
    await write(`  ${line}`);
  }
}
await write(process.env.REPORT_TOKEN === undefined ? 'Unsigned' : 'Signed with a token');

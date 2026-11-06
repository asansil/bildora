import { describe, expect, it } from 'vitest';
import { createProgressParser, isProgressLine, parseProgressLine } from './progress-lines.js';
import type { RunProgress } from './progress-lines.js';

function parseAll(chunks: readonly string[]): RunProgress[] {
  const seen: RunProgress[] = [];
  const parser = createProgressParser((progress) => {
    seen.push(progress);
  });
  chunks.forEach((chunk) => {
    parser.feed(chunk);
  });
  parser.end();
  return seen;
}

describe('parseProgressLine', () => {
  it('reads percent and message', () => {
    expect(parseProgressLine('::bildora-progress {"percent":50,"message":"Half"}')).toEqual({
      percent: 50,
      message: 'Half',
    });
  });

  it.each([-5, 140])('keeps percent %i inside the scale', (percent) => {
    const parsed = parseProgressLine(`::bildora-progress {"percent":${String(percent)}}`);
    expect(parsed?.percent).toBe(percent < 0 ? 0 : 100);
  });

  it.each([
    ['plain text', 'hello'],
    ['broken JSON', '::bildora-progress {"percent":'],
    ['no known field', '::bildora-progress {"other":1}'],
    ['wrong types', '::bildora-progress {"percent":"50","message":7}'],
  ])('treats %s as ordinary output', (_name, line) => {
    expect(parseProgressLine(line)).toBeUndefined();
    expect(isProgressLine(line)).toBe(false);
  });
});

describe('createProgressParser', () => {
  it('follows a line cut across chunks', () => {
    expect(parseAll(['::bildora-pro', 'gress {"perc', 'ent":10}\r\n'])).toEqual([{ percent: 10 }]);
  });

  it('sees through terminal sequences', () => {
    expect(parseAll(['\x1b[32m::bildora-progress {"percent":20}\x1b[0m\x1b[K\r\n'])).toEqual([
      { percent: 20 },
    ]);
  });

  it('reads a last line with no line break', () => {
    expect(parseAll(['::bildora-progress {"percent":100}'])).toEqual([{ percent: 100 }]);
  });

  it('drops a line too long to be progress, and carries on', () => {
    const seen = parseAll(['x'.repeat(300_000), '\n::bildora-progress {"percent":1}\n']);
    expect(seen).toEqual([{ percent: 1 }]);
  });
});

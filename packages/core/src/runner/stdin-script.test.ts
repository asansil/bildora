import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparableText, createScriptDriver, plainOutput } from './stdin-script.js';
import type { ScriptAnswer } from './stdin-script.js';

function drive(answers: readonly ScriptAnswer[]) {
  const written: string[] = [];
  const timeouts: [string, number][] = [];
  const driver = createScriptDriver({
    answers,
    write: (data) => written.push(data),
    onTimeout: (expected, seconds) => timeouts.push([expected, seconds]),
  });
  return { driver, written, timeouts };
}

describe('plainOutput', () => {
  it('drops colours and titles, and turns cursor moves into whitespace', () => {
    expect(plainOutput('\x1b[32mOK\x1b[0m\x1b]0;title\x07 a\x1b[3Cb\x1b[2;1Hc')).toBe(
      'OK a   b\nc',
    );
  });

  it('collapses whitespace for comparison', () => {
    expect(comparableText('a \r\n\t b ')).toBe('a b ');
  });
});

describe('createScriptDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers each prompt once it appears, with Enter', () => {
    const { driver, written } = drive([
      { expect: 'Name:', send: 'Ada' },
      { expect: 'Age:', send: '36' },
    ]);
    expect(written).toEqual([]);

    driver.feed('Welcome\r\nName: ');
    expect(written).toEqual(['Ada\r']);
    driver.feed('Ada\r\nAge:');
    expect(written).toEqual(['Ada\r', '36\r']);
  });

  it('sends answers with no expect at once, after the one before', () => {
    const { driver, written } = drive([
      { send: 'first' },
      { expect: 'Go?', send: 'y' },
      { send: 'after' },
    ]);
    expect(written).toEqual(['first\r']);

    driver.feed('Go?');
    expect(written).toEqual(['first\r', 'y\r', 'after\r']);
  });

  it('finds a prompt split across chunks and escape sequences', () => {
    const { driver, written } = drive([{ expect: 'Choose an option:', send: '2' }]);

    driver.feed('Choo');
    driver.feed('se\x1b[');
    driver.feed('1Can\x1b[0');
    driver.feed('m option');
    expect(written).toEqual([]);
    driver.feed(':');
    expect(written).toEqual(['2\r']);
  });

  it('ignores trailing spaces ConPTY leaves out, and spaces it rewrites', () => {
    const { driver, written } = drive([{ expect: 'Password:  ', send: 'x' }]);

    driver.feed('\x1b[1;1HPassword:');
    expect(written).toEqual(['x\r']);
  });

  it('matches only text that appeared after the answer before', () => {
    const { driver, written } = drive([
      { expect: 'Value:', send: '1' },
      { expect: 'Value:', send: '2' },
    ]);

    driver.feed('Value: ');
    expect(written).toEqual(['1\r']);
    driver.feed('1\r\n');
    expect(written).toEqual(['1\r']);
    driver.feed('Value: ');
    expect(written).toEqual(['1\r', '2\r']);
  });

  it('treats expect as literal text, never as a pattern', () => {
    const { driver, written } = drive([{ expect: 'a.b*', send: 'x' }]);

    driver.feed('axbbb');
    expect(written).toEqual([]);
    driver.feed(' a.b*');
    expect(written).toEqual(['x\r']);
  });

  it('gives up after the default time limit, naming the text', () => {
    const { driver, written, timeouts } = drive([{ expect: 'Never', send: 'x' }]);

    vi.advanceTimersByTime(29_999);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timeouts).toEqual([['Never', 30]]);
    driver.feed('Never');
    expect(written).toEqual([]);
  });

  it('times each wait on its own, with its own limit', () => {
    const { driver, timeouts } = drive([
      { expect: 'A', send: '1', timeout: 2 },
      { expect: 'B', send: '2', timeout: 5 },
    ]);

    vi.advanceTimersByTime(1_500);
    driver.feed('A');
    vi.advanceTimersByTime(4_000);
    expect(timeouts).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(timeouts).toEqual([['B', 5]]);
  });

  it('stops waiting once the tool ends', () => {
    const { driver, timeouts } = drive([{ expect: 'A', send: '1' }]);

    driver.stop();
    vi.advanceTimersByTime(60_000);
    expect(timeouts).toEqual([]);
  });
});

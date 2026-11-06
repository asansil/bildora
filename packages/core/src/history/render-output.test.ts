import { describe, expect, it } from 'vitest';
import {
  createOutputRecorder,
  createStreamRedactor,
  keepTail,
  redactSecrets,
} from './render-output.js';
import type { RenderedOutput } from './render-output.js';

async function render(
  data: string,
  columns = 40,
  secrets: readonly string[] = [],
): Promise<RenderedOutput> {
  const recorder = await createOutputRecorder(columns, 10);
  recorder.write(data);
  return recorder.finish(secrets);
}

describe('createOutputRecorder', () => {
  it('keeps what stayed on screen, not what was overwritten', async () => {
    const { text } = await render('progress 10%\rprogress 99%\r\ndone\r\n');

    expect(text).toBe('progress 99%\ndone');
  });

  it('drops colors and terminal sequences', async () => {
    expect((await render('\x1b[31mred\x1b[0m text\r\n')).text).toBe('red text');
  });

  it('leaves progress lines out, even when they wrap', async () => {
    const line = `::bildora-progress {"percent":50,"message":"${'y'.repeat(300)}"}`;

    expect((await render(`before\r\n${line}\r\nafter\r\n`)).text).toBe('before\nafter');
  });

  it('takes out a secret that wrapped across rows', async () => {
    const secret = 'S3CRET-'.repeat(20);

    const { text } = await render(`token=${secret} end\r\n`, 40, [secret]);

    expect(text).toBe('token=•••••• end');
  });

  it('records a wide run at the size it was resized to', async () => {
    const recorder = await createOutputRecorder(40, 10);
    recorder.resize(80, 10);
    recorder.write(`${'x'.repeat(70)}\r\n`);

    expect((await recorder.finish([])).text).toBe('x'.repeat(70));
  });
});

describe('redactSecrets', () => {
  it('handles one secret inside another', () => {
    expect(redactSecrets('abcdef abc', ['abc', 'abcdef'])).toBe('•••••• ••••••');
  });

  it('ignores an empty secret', () => {
    expect(redactSecrets('text', [''])).toBe('text');
  });
});

describe('createStreamRedactor', () => {
  it('passes everything through when there are no secrets', () => {
    expect(createStreamRedactor([]).write('text')).toBe('text');
  });

  it('finds a secret split across chunks', () => {
    const redactor = createStreamRedactor(['hunter2']);

    const shown = [redactor.write('pass hun'), redactor.write('ter2 end'), redactor.end()];

    expect(shown.join('')).toBe('pass •••••• end');
  });

  it('lets go of text that only looked like the start of a secret', () => {
    const redactor = createStreamRedactor(['hunter2']);

    const shown = [redactor.write('hun'), redactor.write('gry'), redactor.end()];

    expect(shown.join('')).toBe('hungry');
  });

  it('gives back what it held when the stream ends', () => {
    const redactor = createStreamRedactor(['hunter2']);

    expect(redactor.write('hunt')).toBe('');
    expect(redactor.end()).toBe('hunt');
  });
});

describe('keepTail', () => {
  it('leaves a short text alone', () => {
    expect(keepTail('short', 100)).toEqual({ text: 'short', truncated: false });
  });

  it('keeps the last whole lines', () => {
    expect(keepTail('aaaaa\nbbbbb\nccccc', 8)).toEqual({ text: 'ccccc', truncated: true });
  });
});

import { isProgressLine } from '../runner/progress-lines.js';

/** Text kept per run. The end of a run is what explains how it ended, so the tail stays. */
export const OUTPUT_BYTE_LIMIT = 1024 * 1024;
const SCROLLBACK_LINES = 100_000;
const REDACTED = '••••••';

export interface RenderedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

/** Takes the raw stream of a run, and turns it into the text run history keeps. */
export interface OutputRecorder {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  /** Ends the recording. The text leaves here with every secret value taken out. */
  finish(secrets: readonly string[]): Promise<RenderedOutput>;
}

/** Hides each secret, longest first, so that one inside another cannot leave a part showing. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const longestFirst = [...secrets].sort((first, second) => second.length - first.length);
  return longestFirst.reduce(
    (redacted, secret) => (secret === '' ? redacted : redacted.replaceAll(secret, REDACTED)),
    text,
  );
}

/** Hides secrets in a stream cut anywhere, so that one split across chunks is still found. */
export interface StreamRedactor {
  /** Takes a chunk, and returns what is safe to show now. */
  write(data: string): string;
  /** Returns what was held back, once the stream has ended. */
  end(): string;
}

/** How much of the end of a text could be the start of a secret. */
function partialSecretLength(text: string, secrets: readonly string[]): number {
  const longest = Math.max(0, ...secrets.map((secret) => secret.length - 1));
  for (let length = Math.min(longest, text.length); length > 0; length -= 1) {
    const tail = text.slice(-length);
    if (secrets.some((secret) => secret.startsWith(tail))) {
      return length;
    }
  }
  return 0;
}

export function createStreamRedactor(secrets: readonly string[]): StreamRedactor {
  const present = secrets.filter((secret) => secret !== '');
  let pending = '';
  return {
    write(data) {
      if (present.length === 0) {
        return data;
      }
      const text = redactSecrets(`${pending}${data}`, present);
      const held = partialSecretLength(text, present);
      pending = held === 0 ? '' : text.slice(-held);
      return held === 0 ? text : text.slice(0, -held);
    },
    end() {
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}

/** Keeps the end of a text, from the start of a line, within a size in UTF-8 bytes. */
export function keepTail(text: string, limit = OUTPUT_BYTE_LIMIT): RenderedOutput {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) {
    return { text, truncated: false };
  }
  const tail = bytes.subarray(bytes.length - limit).toString('utf8');
  const lineStart = tail.indexOf('\n');
  return { text: lineStart === -1 ? tail : tail.slice(lineStart + 1), truncated: true };
}

/**
 * Renders a stream through a terminal, which is the only way to know what really remained on
 * screen: a regex keeps text a progress bar overwrote. It is async because the terminal loads on
 * first use.
 */
export async function createOutputRecorder(columns: number, rows: number): Promise<OutputRecorder> {
  const { Terminal } = (await import('@xterm/headless')).default;
  const terminal = new Terminal({
    cols: columns,
    rows,
    allowProposedApi: true,
    scrollback: SCROLLBACK_LINES,
  });

  function renderedLines(): string[] {
    const buffer = terminal.buffer.normal;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line === undefined) {
        continue;
      }
      const text = line.translateToString(true);
      const previous = lines.at(-1);
      if (line.isWrapped && previous !== undefined) {
        lines[lines.length - 1] = `${previous}${text}`;
      } else {
        lines.push(text);
      }
    }
    return lines;
  }

  return {
    write(data) {
      terminal.write(data);
    },
    resize(width, height) {
      terminal.resize(width, height);
    },
    async finish(secrets) {
      await new Promise<void>((resolve) => {
        terminal.write('', resolve);
      });
      const scrolledAway = terminal.buffer.normal.baseY >= SCROLLBACK_LINES;
      const lines = renderedLines().filter((line) => !isProgressLine(line));
      terminal.dispose();
      const text = redactSecrets(lines.join('\n').trimEnd(), secrets);
      const kept = keepTail(text);
      return { text: kept.text, truncated: kept.truncated || scrolledAway };
    },
  };
}

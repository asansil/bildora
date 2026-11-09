import { STDIN_TIMEOUT_DEFAULT_SECONDS } from '@bildora/protocol';
import type { ToolScriptEntry } from '@bildora/protocol';

/** A console script entry with its answer ready to type, references already replaced. */
export interface ScriptAnswer {
  readonly expect?: string | undefined;
  readonly send: string;
  readonly timeout?: number | undefined;
}

export interface ScriptDriverOptions {
  readonly answers: readonly ScriptAnswer[];
  /** Types into the tool's console. */
  readonly write: (data: string) => void;
  /** Called once, when a wait runs out. The driver does nothing more afterwards. */
  readonly onTimeout: (expected: string, seconds: number) => void;
}

/** Follows a tool's output and types the script's answers when their text appears. */
export interface ScriptDriver {
  /** Takes raw terminal data, cut anywhere. */
  feed(data: string): void;
  /** Stops waiting, once the tool has ended. */
  stop(): void;
}

/** Text kept while waiting. A prompt is short, so only the end of a long output matters. */
const WAIT_BUFFER_LIMIT = 64 * 1024;
/** Longest escape sequence held back when a chunk ends inside one. */
const PENDING_SEQUENCE_LIMIT = 256;
/** A cursor move forward, which ConPTY writes instead of a run of spaces. */
// eslint-disable-next-line no-control-regex
const CURSOR_FORWARD = /\x1b\[(\d*)C/g;
/** A cursor move to another line or place, which separates what was written before and after. */
// eslint-disable-next-line no-control-regex
const CURSOR_JUMP = /\x1b\[[\d;]*[ABEFGHdf]/g;
/** Every other terminal sequence: CSI, OSC, and the two-character forms. */
// eslint-disable-next-line no-control-regex
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/g;
const COMPLETE_SEQUENCE_AT_START = new RegExp(`^(?:${TERMINAL_SEQUENCE.source})`);

/**
 * Whitespace as the user reads it: any run is one space. ConPTY may leave out trailing spaces or
 * write cursor moves for them, so both sides are compared this way, and `expect` is also trimmed.
 */
export function comparableText(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The text a console shows, without terminal sequences. Cursor moves count as whitespace. */
export function plainOutput(raw: string): string {
  return raw
    .replace(CURSOR_FORWARD, (_match, count: string) =>
      ' '.repeat(Math.min(Number(count) || 1, 80)),
    )
    .replace(CURSOR_JUMP, '\n')
    .replace(TERMINAL_SEQUENCE, '');
}

/** How much of the end of a chunk is the start of a sequence that the next chunk completes. */
function unfinishedSequenceLength(raw: string): number {
  const start = raw.lastIndexOf('\x1b');
  if (start === -1 || raw.length - start > PENDING_SEQUENCE_LIMIT) {
    return 0;
  }
  return COMPLETE_SEQUENCE_AT_START.test(raw.slice(start)) ? 0 : raw.length - start;
}

/** The answers for a run, with each `{{params.<name>}}` replaced by the text of its value. */
export function scriptAnswers(
  script: readonly ToolScriptEntry[],
  render: (send: string) => string,
): readonly ScriptAnswer[] {
  return script.map(({ expect, send, timeout }) => ({ expect, send: render(send), timeout }));
}

/**
 * Types each answer once its `expect` text has appeared in the output since the answer before, or
 * at once when it has none. Each wait has its own time limit.
 */
export function createScriptDriver({
  answers,
  write,
  onTimeout,
}: ScriptDriverOptions): ScriptDriver {
  let next = 0;
  let seen = '';
  let pending = '';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function stop(): void {
    stopped = true;
    clearTimer();
    seen = '';
    pending = '';
  }

  function wait(answer: ScriptAnswer & { expect: string }): void {
    if (timer !== undefined) {
      return;
    }
    const seconds = answer.timeout ?? STDIN_TIMEOUT_DEFAULT_SECONDS;
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) {
        stop();
        onTimeout(answer.expect, seconds);
      }
    }, seconds * 1000);
  }

  /** Sends every answer whose text has appeared, and starts waiting for the next one. */
  function advance(): void {
    while (!stopped && next < answers.length) {
      const answer = answers[next];
      if (answer === undefined) {
        return;
      }
      if (answer.expect !== undefined) {
        const expected = comparableText(answer.expect).trim();
        const found = seen.indexOf(expected);
        if (found === -1) {
          wait({ ...answer, expect: answer.expect });
          return;
        }
        clearTimer();
        seen = seen.slice(found + expected.length);
      }
      next += 1;
      write(`${answer.send}\r`);
    }
    if (next >= answers.length) {
      stop();
    }
  }

  advance();

  return {
    feed(data) {
      if (stopped) {
        return;
      }
      const raw = pending + data;
      const held = unfinishedSequenceLength(raw);
      pending = raw.slice(raw.length - held);
      seen = comparableText(seen + plainOutput(raw.slice(0, raw.length - held)));
      if (seen.length > WAIT_BUFFER_LIMIT) {
        seen = seen.slice(seen.length - WAIT_BUFFER_LIMIT);
      }
      advance();
    },
    stop,
  };
}

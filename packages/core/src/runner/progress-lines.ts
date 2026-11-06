const PROGRESS_LINE = /::bildora-progress (\{.*\})/;
/** Terminal sequences ConPTY adds around text: CSI, OSC, and the two-character forms. */
// eslint-disable-next-line no-control-regex
const TERMINAL_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/g;
const LINE_BUFFER_LIMIT = 256 * 1024;
const MESSAGE_LIMIT = 500;

/** What a tool says about how far it has come. Either part may be missing. */
export interface RunProgress {
  readonly percent?: number;
  readonly message?: string;
}

/** Reads one line of plain text. Anything malformed is ordinary output, so it gives undefined. */
export function parseProgressLine(line: string): RunProgress | undefined {
  const json = PROGRESS_LINE.exec(line)?.[1];
  if (json === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { percent, message } = parsed as { percent?: unknown; message?: unknown };
  const progress: { percent?: number; message?: string } = {};
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    progress.percent = Math.min(100, Math.max(0, percent));
  }
  if (typeof message === 'string') {
    progress.message = message.slice(0, MESSAGE_LIMIT);
  }
  return progress.percent === undefined && progress.message === undefined ? undefined : progress;
}

/** Tells whether rendered text is a progress line, which run history leaves out. */
export function isProgressLine(line: string): boolean {
  return parseProgressLine(line) !== undefined;
}

export interface ProgressParser {
  /** Takes raw terminal data, cut anywhere. */
  feed(data: string): void;
  /** Reads what is left, for a tool whose last line has no line break. */
  end(): void;
}

/** Follows the raw stream, which is cut wherever the PTY chose and holds terminal sequences. */
export function createProgressParser(onProgress: (progress: RunProgress) => void): ProgressParser {
  let pending = '';

  function readLine(line: string): void {
    const progress = parseProgressLine(line.replace(TERMINAL_SEQUENCE, ''));
    if (progress !== undefined) {
      onProgress(progress);
    }
  }

  return {
    feed(data) {
      pending += data;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(readLine);
      if (pending.length > LINE_BUFFER_LIMIT) {
        // No line this long is a progress line, and keeping it would grow without limit.
        pending = '';
      }
    },
    end() {
      readLine(pending);
      pending = '';
    },
  };
}

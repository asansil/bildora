import { randomUUID } from 'node:crypto';
import { createOutputRecorder, createStreamRedactor } from '../history/render-output.js';
import type { OutputRecorder, RenderedOutput, StreamRedactor } from '../history/render-output.js';
import type { RunFinish, RunHistory } from '../history/run-history.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { SecretStore } from '../secrets/secret-store.js';
import type { ParameterValues } from './command-line.js';
import { resolveRunValues } from './resolve-values.js';
import type { ResolvedValues } from './resolve-values.js';
import { TERMINAL_COLUMNS, TERMINAL_ROWS, startRun, startWindowRun } from './run-tool.js';
import type { RunOptions, RunResult, ToolRun } from './run-tool.js';

export interface RecordedRunOptions extends Pick<
  RunOptions,
  'columns' | 'cwd' | 'env' | 'launcherPath' | 'onOutput' | 'onProgress' | 'rows'
> {
  readonly history: RunHistory;
  readonly store: SecretStore;
  /** Runs kept for this tool afterwards. */
  readonly historyRunLimit: number;
  readonly runId?: string;
  readonly profile?: Profile | undefined;
  readonly values?: ParameterValues | undefined;
}

function finishedRecord(result: RunResult, output: RenderedOutput | undefined): RunFinish {
  const shared = {
    durationMs: result.durationMs,
    output: output?.text,
    outputTruncated: output?.truncated,
  };
  switch (result.status) {
    case 'completed':
      return { ...shared, status: result.status, exitCode: result.exitCode };
    case 'cancelled':
      return { ...shared, status: result.status };
    case 'failed':
      return {
        ...shared,
        status: result.status,
        exitCode: result.exitCode,
        failure: result.failure,
      };
  }
}

/** Starts by the tool's level: level 0 opens its own window, and level 1 runs under the console. */
function startByLevel(
  tool: RegisteredTool,
  options: RecordedRunOptions,
  parameters: ParameterValues,
  recorder: OutputRecorder | undefined,
  redactor: StreamRedactor,
): ToolRun {
  const { cwd, env, launcherPath, columns, rows, onOutput, onProgress } = options;
  const shared = {
    parameters,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(launcherPath === undefined ? {} : { launcherPath }),
  };
  if (recorder === undefined) {
    return startWindowRun(tool, shared);
  }
  return startRun(tool, {
    ...shared,
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
    ...(onProgress === undefined ? {} : { onProgress }),
    onOutput: (data) => {
      recorder.write(data);
      const shown = redactor.write(data);
      if (shown !== '') {
        onOutput?.(shown);
      }
    },
  });
}

function settledRun(runId: string, result: RunResult): ToolRun & { readonly runId: string } {
  return {
    runId,
    result: Promise.resolve(result),
    cancel: () => undefined,
    write: () => undefined,
    resize: () => undefined,
  };
}

/**
 * Runs a tool and leaves a record of it. This is what clients call, so that the desktop app and the
 * CLI record runs alike. A problem with the record itself never changes how the run ended.
 * `onOutput` receives the stream with secret values hidden, as far as they appear literally.
 */
export async function startRecordedRun(
  tool: RegisteredTool,
  options: RecordedRunOptions,
): Promise<ToolRun & { readonly runId: string }> {
  const { history, store, historyRunLimit, profile, values } = options;
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const { id: toolId, name: toolName, level } = tool.manifest;
  const shared = { runId, toolId, toolName, level, startedAt };

  let resolved: ResolvedValues;
  try {
    resolved = await resolveRunValues(tool, { profile, values, store });
  } catch {
    const result: RunResult = {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      failure: {
        kind: 'credentials',
        message: 'A saved secret could not be read from the credential store',
      },
    };
    history.start({ ...shared, parameters: [] });
    history.finish(runId, finishedRecord(result, undefined));
    return settledRun(runId, result);
  }

  const recorder =
    level === 0
      ? undefined
      : await createOutputRecorder(
          options.columns ?? TERMINAL_COLUMNS,
          options.rows ?? TERMINAL_ROWS,
        );
  history.start({ ...shared, parameters: resolved.recorded });

  const redactor = createStreamRedactor(resolved.secrets);
  const run = startByLevel(tool, options, resolved.values, recorder, redactor);
  const result = run.result.then(async (ended) => {
    const rest = redactor.end();
    if (rest !== '') {
      options.onOutput?.(rest);
    }
    try {
      const output = await recorder?.finish(resolved.secrets);
      history.finish(runId, finishedRecord(ended, output));
      history.prune(toolId, historyRunLimit);
    } catch {
      // The run has ended either way. Its row stays as running, and becomes interrupted later.
    }
    return ended;
  });

  return {
    runId,
    result,
    cancel: () => {
      run.cancel();
    },
    write: (data) => {
      run.write(data);
    },
    resize: (columns, rows) => {
      recorder?.resize(columns, rows);
      run.resize(columns, rows);
    },
  };
}

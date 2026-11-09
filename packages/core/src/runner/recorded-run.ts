import { randomUUID } from 'node:crypto';
import { createOutputRecorder, createStreamRedactor } from '../history/render-output.js';
import type { OutputRecorder, RenderedOutput, StreamRedactor } from '../history/render-output.js';
import type { RunFinish, RunHistory } from '../history/run-history.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { SecretStore } from '../secrets/secret-store.js';
import type { ParameterValues } from './command-line.js';
import { MissingPathVariableError, expandToolCommand } from './expand-paths.js';
import type { PathVariables } from './expand-paths.js';
import { resolveRunValues } from './resolve-values.js';
import type { RecordedParameter, ResolvedValues } from './resolve-values.js';
import { TERMINAL_COLUMNS, TERMINAL_ROWS, startRun, startWindowRun } from './run-tool.js';
import type { RunFailure, RunOptions, RunResult, ToolRun } from './run-tool.js';

export interface RecordedRunOptions extends Pick<
  RunOptions,
  | 'answerWithScript'
  | 'columns'
  | 'cwd'
  | 'env'
  | 'launcherPath'
  | 'onOutput'
  | 'onProgress'
  | 'rows'
> {
  readonly history: RunHistory;
  /** Whose history this run joins, whichever scope the tool came from. */
  readonly workspaceId: string;
  readonly store: SecretStore;
  /** Runs kept for this tool afterwards. */
  readonly historyRunLimit: number;
  readonly runId?: string;
  readonly profile?: Profile | undefined;
  readonly values?: ParameterValues | undefined;
  readonly pathVariables?: PathVariables | undefined;
  /** The automation run this is a step of. */
  readonly automationRunId?: string | undefined;
}

/** A run with its record. `parameters` is what history shows, so it never holds a secret. */
export interface RecordedToolRun extends ToolRun {
  readonly runId: string;
  readonly parameters: readonly RecordedParameter[];
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
  const { cwd, env, launcherPath, columns, rows, onOutput, onProgress, answerWithScript } = options;
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
    ...(answerWithScript === undefined ? {} : { answerWithScript }),
    onOutput: (data) => {
      recorder.write(data);
      const shown = redactor.write(data);
      if (shown !== '') {
        onOutput?.(shown);
      }
    },
  });
}

function preparationFailure(error: unknown): RunFailure {
  return error instanceof MissingPathVariableError
    ? { kind: 'path-variable', message: error.message }
    : {
        kind: 'credentials',
        message: 'A saved secret could not be read from the credential store',
      };
}

function settledRun(runId: string, result: RunResult): RecordedToolRun {
  return {
    runId,
    parameters: [],
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
): Promise<RecordedToolRun> {
  const { history, workspaceId, store, historyRunLimit, profile, values, pathVariables } = options;
  const { automationRunId, answerWithScript } = options;
  const runId = options.runId ?? randomUUID();
  const startedAt = Date.now();
  const { id: toolId, name: toolName, level } = tool.manifest;
  const shared = { runId, workspaceId, toolId, toolName, level, startedAt, automationRunId };

  let resolved: ResolvedValues;
  let expanded: RegisteredTool;
  try {
    expanded = expandToolCommand(tool, pathVariables ?? new Map<string, string>());
    resolved = await resolveRunValues(tool, {
      profile,
      values,
      store,
      pathVariables,
      answerWithScript,
    });
  } catch (error) {
    const result: RunResult = {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      failure: preparationFailure(error),
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
  const run = startByLevel(expanded, options, resolved.values, recorder, redactor);
  const result = run.result.then(async (ended) => {
    const rest = redactor.end();
    if (rest !== '') {
      options.onOutput?.(rest);
    }
    try {
      const output = await recorder?.finish(resolved.secrets);
      history.finish(runId, finishedRecord(ended, output));
      history.prune(workspaceId, toolId, historyRunLimit);
    } catch {
      // The run has ended either way. Its row stays as running, and becomes interrupted later.
    }
    return ended;
  });

  return {
    runId,
    parameters: resolved.recorded,
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

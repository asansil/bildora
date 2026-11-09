import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { RecordedParameter } from '../runner/resolve-values.js';
import { DefinitionError } from '../storage/definition-error.js';

const HISTORY_FILE = 'history.db';
const SCHEMA_VERSION = 4;
/** Rows a listing returns at most. */
const LIST_LIMIT = 500;

const SCHEMA = `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    level INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms REAL,
    failure_kind TEXT,
    failure_message TEXT,
    parameters TEXT NOT NULL,
    output TEXT,
    output_truncated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX runs_by_tool ON runs (workspace_id, tool_id, started_at DESC);
  CREATE INDEX runs_by_time ON runs (workspace_id, started_at DESC);
`;

/** What automations add. A step's row in `runs` points back at its automation run. */
const UPGRADE_TO_AUTOMATIONS = `
  ALTER TABLE runs ADD COLUMN automation_run_id TEXT;
  ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    automation_name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    duration_ms REAL,
    failure_step TEXT,
    failure_kind TEXT,
    failure_message TEXT,
    steps TEXT NOT NULL,
    owner_pid INTEGER
  );
  CREATE INDEX automation_runs_by_automation
    ON automation_runs (workspace_id, automation_id, started_at DESC);
`;

/**
 * What blocks add. A run from before them holds steps, and a client shows it as the list it was.
 * `paths` holds the connections a run followed.
 */
const UPGRADE_TO_BLOCKS = `
  ALTER TABLE automation_runs ADD COLUMN format TEXT NOT NULL DEFAULT 'steps';
  ALTER TABLE automation_runs ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
`;

/** Runs older than Workspaces belong to the one every upgraded installation starts with. */
const UPGRADE_TO_WORKSPACES = `
  ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
  DROP INDEX runs_by_tool;
  DROP INDEX runs_by_time;
  CREATE INDEX runs_by_tool ON runs (workspace_id, tool_id, started_at DESC);
  CREATE INDEX runs_by_time ON runs (workspace_id, started_at DESC);
`;

const SUMMARY_COLUMNS =
  'id, tool_id, tool_name, level, started_at, status, exit_code, duration_ms, failure_kind, failure_message';

/** `interrupted` means Bildora closed before it could see the run end. */
export type RecordedStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunSummary {
  readonly runId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly level: number;
  /** Milliseconds since the epoch. */
  readonly startedAt: number;
  readonly status: RecordedStatus;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly failure?: { readonly kind: string; readonly message: string };
}

export interface RunRecord extends RunSummary {
  readonly parameters: readonly RecordedParameter[];
  readonly output: string;
  readonly outputTruncated: boolean;
}

export interface RunStart {
  readonly runId: string;
  /** The automation run this is a step of. */
  readonly automationRunId?: string | undefined;
  readonly workspaceId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly level: number;
  readonly startedAt: number;
  readonly parameters: readonly RecordedParameter[];
}

export interface RunFinish {
  readonly status: Exclude<RecordedStatus, 'running' | 'interrupted'>;
  readonly exitCode?: number | undefined;
  readonly durationMs: number;
  readonly failure?: { readonly kind: string; readonly message: string } | undefined;
  readonly output?: string | undefined;
  readonly outputTruncated?: boolean | undefined;
}

export type AutomationTrigger = 'app' | 'cli';

export type StepState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface AutomationFailure {
  readonly stepId: string;
  readonly kind: string;
  readonly message: string;
}

/** Whether a run holds the steps of a list or the blocks of a graph. */
export type AutomationRunFormat = 'steps' | 'blocks';

/** A connection a run followed: the output of a block, and the block it led to. */
export interface TakenPath {
  readonly from: string;
  readonly output: string;
  readonly to: string;
}

/** One block of an automation run, as it stands. */
export interface AutomationStepRecord {
  readonly id: string;
  readonly state: StepState;
  /** The tool run of the latest attempt. */
  readonly toolRunId?: string;
  /** Which try this is, for a step that retries. */
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly failure?: { readonly kind: string; readonly message: string };
}

export interface AutomationRunSummary {
  readonly runId: string;
  readonly workspaceId: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly trigger: AutomationTrigger;
  readonly startedAt: number;
  readonly status: RecordedStatus;
  readonly durationMs?: number;
  /** What stopped the run. A step set to continue shows failed in `steps` and is not here. */
  readonly failure?: AutomationFailure;
  readonly format: AutomationRunFormat;
  readonly steps: readonly AutomationStepRecord[];
  readonly paths: readonly TakenPath[];
}

export interface AutomationRunStart {
  readonly runId: string;
  readonly workspaceId: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly trigger: AutomationTrigger;
  readonly startedAt: number;
  readonly steps: readonly AutomationStepRecord[];
}

export interface AutomationRunFinish {
  readonly status: Exclude<RecordedStatus, 'running' | 'interrupted'>;
  readonly durationMs: number;
  readonly failure?: AutomationFailure | undefined;
  readonly steps: readonly AutomationStepRecord[];
  readonly paths: readonly TakenPath[];
}

/** Names an automation run whose record went, so that its folder can go too. */
export interface RemovedAutomationRun {
  readonly workspaceId: string;
  readonly automationId: string;
  readonly runId: string;
}

export interface HistoryOpenOptions {
  /** Keeps nothing on disk, for when the file cannot be opened. */
  readonly inMemory?: boolean;
}

interface SummaryRow {
  id: string;
  tool_id: string;
  tool_name: string;
  level: number;
  started_at: number;
  status: RecordedStatus;
  exit_code: number | null;
  duration_ms: number | null;
  failure_kind: string | null;
  failure_message: string | null;
}

interface RecordRow extends SummaryRow {
  parameters: string;
  output: string | null;
  output_truncated: number;
}

interface AutomationRow {
  id: string;
  workspace_id: string;
  automation_id: string;
  automation_name: string;
  trigger: AutomationTrigger;
  started_at: number;
  status: RecordedStatus;
  duration_ms: number | null;
  failure_step: string | null;
  failure_kind: string | null;
  failure_message: string | null;
  steps: string;
  format: AutomationRunFormat;
  paths: string;
}

function stepsOf(text: string): readonly AutomationStepRecord[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as AutomationStepRecord[]) : [];
  } catch {
    return [];
  }
}

function pathsOf(text: string): readonly TakenPath[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as TakenPath[]) : [];
  } catch {
    return [];
  }
}

function automationSummaryOf(row: AutomationRow): AutomationRunSummary {
  return {
    runId: row.id,
    workspaceId: row.workspace_id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    trigger: row.trigger,
    startedAt: row.started_at,
    status: row.status,
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.failure_step === null
      ? {}
      : {
          failure: {
            stepId: row.failure_step,
            kind: row.failure_kind ?? '',
            message: row.failure_message ?? '',
          },
        }),
    format: row.format,
    steps: stepsOf(row.steps),
    paths: pathsOf(row.paths),
  };
}

/** Tells whether a process is there. An error other than "no such process" means that it is. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function summaryOf(row: SummaryRow): RunSummary {
  return {
    runId: row.id,
    toolId: row.tool_id,
    toolName: row.tool_name,
    level: row.level,
    startedAt: row.started_at,
    status: row.status,
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.failure_kind === null
      ? {}
      : { failure: { kind: row.failure_kind, message: row.failure_message ?? '' } }),
  };
}

function parametersOf(text: string): readonly RecordedParameter[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as RecordedParameter[]) : [];
  } catch {
    return [];
  }
}

/**
 * Past runs, in SQLite because they are numerous, queried and never hand-edited. Everything given
 * to this class is stored as it is, so what must stay out, such as secrets, is removed before.
 */
export class RunHistory {
  private readonly database: Database;

  private constructor(database: Database) {
    this.database = database;
  }

  /** Opens the history of a data directory. A file from a newer build is refused, not changed. */
  static async open(dataDir: string, options: HistoryOpenOptions = {}): Promise<RunHistory> {
    const { default: Connection } = await import('better-sqlite3');
    const database = new Connection(
      options.inMemory === true ? ':memory:' : join(dataDir, HISTORY_FILE),
    );
    try {
      const version = database.pragma('user_version', { simple: true });
      if (typeof version !== 'number' || version > SCHEMA_VERSION) {
        throw new DefinitionError(
          `The run history uses version ${String(version)}, but this version of Bildora supports up to ${String(SCHEMA_VERSION)}. Update Bildora to use it.`,
        );
      }
      database.pragma('journal_mode = WAL');
      if (version < SCHEMA_VERSION) {
        database.transaction(() => {
          if (version < 2) {
            database.exec(version === 0 ? SCHEMA : UPGRADE_TO_WORKSPACES);
          }
          if (version < 3) {
            database.exec(UPGRADE_TO_AUTOMATIONS);
          }
          database.exec(UPGRADE_TO_BLOCKS);
          database.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
        })();
      }
    } catch (error) {
      database.close();
      throw error;
    }
    return new RunHistory(database);
  }

  close(): void {
    this.database.close();
  }

  /** Writes a run as it starts, so one that never reports back still leaves a trace. */
  start(run: RunStart): void {
    this.database
      .prepare(
        `INSERT INTO runs
           (id, workspace_id, tool_id, tool_name, level, started_at, status, parameters,
            automation_run_id, owner_pid)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        run.runId,
        run.workspaceId,
        run.toolId,
        run.toolName,
        run.level,
        run.startedAt,
        JSON.stringify(run.parameters),
        run.automationRunId ?? null,
        process.pid,
      );
  }

  finish(runId: string, run: RunFinish): void {
    this.database
      .prepare(
        `UPDATE runs SET status = ?, exit_code = ?, duration_ms = ?, failure_kind = ?,
         failure_message = ?, output = ?, output_truncated = ? WHERE id = ?`,
      )
      .run(
        run.status,
        run.exitCode ?? null,
        run.durationMs,
        run.failure?.kind ?? null,
        run.failure?.message ?? null,
        run.output ?? null,
        run.outputTruncated === true ? 1 : 0,
        runId,
      );
  }

  /**
   * Marks runs nothing can finish anymore, because the process that started them has gone. Another
   * process can be working in this file, such as the CLI while the app starts. Call it once, before
   * this process starts a run: a row with this process's id can only be from a reused id.
   */
  recoverInterrupted(isRunning: (pid: number) => boolean = processExists): number {
    const gone = (pid: number | null): boolean =>
      pid === null || pid === process.pid || !isRunning(pid);
    let changes = 0;
    for (const table of ['runs', 'automation_runs']) {
      const owners = this.database
        .prepare<[], { owner_pid: number | null }>(
          `SELECT DISTINCT owner_pid FROM ${table} WHERE status = 'running'`,
        )
        .all();
      for (const { owner_pid: owner } of owners.filter(({ owner_pid: pid }) => gone(pid))) {
        changes += this.database
          .prepare(
            `UPDATE ${table} SET status = 'interrupted'
             WHERE status = 'running' AND owner_pid IS ?`,
          )
          .run(owner).changes;
      }
    }
    return changes;
  }

  startAutomationRun(run: AutomationRunStart): void {
    this.database
      .prepare(
        `INSERT INTO automation_runs
           (id, workspace_id, automation_id, automation_name, trigger, started_at, status, steps,
            owner_pid, format, paths)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, 'blocks', '[]')`,
      )
      .run(
        run.runId,
        run.workspaceId,
        run.automationId,
        run.automationName,
        run.trigger,
        run.startedAt,
        JSON.stringify(run.steps),
        process.pid,
      );
  }

  /** Stores where a run has got to, so that another process can show it. */
  updateAutomationSteps(
    runId: string,
    steps: readonly AutomationStepRecord[],
    paths: readonly TakenPath[],
  ): void {
    this.database
      .prepare('UPDATE automation_runs SET steps = ?, paths = ? WHERE id = ?')
      .run(JSON.stringify(steps), JSON.stringify(paths), runId);
  }

  finishAutomationRun(runId: string, run: AutomationRunFinish): void {
    this.database
      .prepare(
        `UPDATE automation_runs SET status = ?, duration_ms = ?, failure_step = ?, failure_kind = ?,
         failure_message = ?, steps = ?, paths = ? WHERE id = ?`,
      )
      .run(
        run.status,
        run.durationMs,
        run.failure?.stepId ?? null,
        run.failure?.kind ?? null,
        run.failure?.message ?? null,
        JSON.stringify(run.steps),
        JSON.stringify(run.paths),
        runId,
      );
  }

  /** Lists the runs of an automation, newest first, whichever client started them. */
  listAutomationRuns(workspaceId: string, automationId: string): readonly AutomationRunSummary[] {
    return this.database
      .prepare<[string, string], AutomationRow>(
        `SELECT * FROM automation_runs WHERE workspace_id = ? AND automation_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT ${String(LIST_LIMIT)}`,
      )
      .all(workspaceId, automationId)
      .map(automationSummaryOf);
  }

  private removeAutomationRuns(where: string, ...values: unknown[]): RemovedAutomationRun[] {
    const rows = this.database
      .prepare<unknown[], { id: string; workspace_id: string; automation_id: string }>(
        `SELECT id, workspace_id, automation_id FROM automation_runs WHERE ${where}`,
      )
      .all(...values);
    this.database.prepare(`DELETE FROM automation_runs WHERE ${where}`).run(...values);
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      automationId: row.automation_id,
      runId: row.id,
    }));
  }

  /** Keeps an automation's newest finished runs. A run still going is never removed. */
  pruneAutomationRuns(
    workspaceId: string,
    automationId: string,
    keep: number,
  ): readonly RemovedAutomationRun[] {
    return this.removeAutomationRuns(
      `id IN (
         SELECT id FROM automation_runs
         WHERE workspace_id = ? AND automation_id = ? AND status != 'running'
         ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?
       )`,
      workspaceId,
      automationId,
      keep,
    );
  }

  /** Forgets the runs of a deleted automation, which no view could reach anymore. */
  removeAutomation(workspaceId: string, automationId: string): void {
    this.removeAutomationRuns('workspace_id = ? AND automation_id = ?', workspaceId, automationId);
  }

  /** Lists a Workspace's runs, newest first, leaving out what is too large to show in a list. */
  list(workspaceId: string, toolId?: string): readonly RunSummary[] {
    const filter = toolId === undefined ? '' : 'AND tool_id = ?';
    const statement = this.database.prepare<unknown[], SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM runs WHERE workspace_id = ? ${filter}
       ORDER BY started_at DESC, rowid DESC LIMIT ${String(LIST_LIMIT)}`,
    );
    const rows =
      toolId === undefined ? statement.all(workspaceId) : statement.all(workspaceId, toolId);
    return rows.map(summaryOf);
  }

  get(workspaceId: string, runId: string): RunRecord | undefined {
    const row = this.database
      .prepare<[string, string], RecordRow>('SELECT * FROM runs WHERE id = ? AND workspace_id = ?')
      .get(runId, workspaceId);
    return row === undefined
      ? undefined
      : {
          ...summaryOf(row),
          parameters: parametersOf(row.parameters),
          output: row.output ?? '',
          outputTruncated: row.output_truncated === 1,
        };
  }

  /** The tools a Workspace ran most recently, newest first. */
  recentToolIds(workspaceId: string, limit: number): readonly string[] {
    return this.database
      .prepare<[string, number], { tool_id: string }>(
        `SELECT tool_id FROM runs WHERE workspace_id = ?
         GROUP BY tool_id ORDER BY MAX(started_at) DESC LIMIT ?`,
      )
      .all(workspaceId, limit)
      .map((row) => row.tool_id);
  }

  /** Keeps a Workspace's newest finished runs of a tool. A run still going is never removed. */
  prune(workspaceId: string, toolId: string, keep: number): number {
    return this.database
      .prepare(
        `DELETE FROM runs WHERE id IN (
           SELECT id FROM runs WHERE workspace_id = ? AND tool_id = ? AND status != 'running'
           ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(workspaceId, toolId, keep).changes;
  }

  /** Applies a run limit to every tool and automation, for when the user lowers it. */
  pruneAll(keep: number): readonly RemovedAutomationRun[] {
    const tools = this.database
      .prepare<[], { workspace_id: string; tool_id: string }>(
        'SELECT DISTINCT workspace_id, tool_id FROM runs',
      )
      .all();
    for (const { workspace_id: workspaceId, tool_id: toolId } of tools) {
      this.prune(workspaceId, toolId, keep);
    }
    const automations = this.database
      .prepare<[], { workspace_id: string; automation_id: string }>(
        'SELECT DISTINCT workspace_id, automation_id FROM automation_runs',
      )
      .all();
    return automations.flatMap((row) =>
      this.pruneAutomationRuns(row.workspace_id, row.automation_id, keep),
    );
  }

  /** Forgets a Workspace's finished runs, and gives the space back to the disk. */
  clear(workspaceId: string): readonly RemovedAutomationRun[] {
    this.database
      .prepare(`DELETE FROM runs WHERE workspace_id = ? AND status != 'running'`)
      .run(workspaceId);
    const removed = this.removeAutomationRuns(
      `workspace_id = ? AND status != 'running'`,
      workspaceId,
    );
    this.database.exec('VACUUM');
    return removed;
  }

  /** Forgets everything a deleted Workspace ran. */
  removeWorkspace(workspaceId: string): void {
    this.database.prepare('DELETE FROM runs WHERE workspace_id = ?').run(workspaceId);
    this.removeAutomationRuns('workspace_id = ?', workspaceId);
    this.database.exec('VACUUM');
  }
}

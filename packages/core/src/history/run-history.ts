import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { RecordedParameter } from '../runner/resolve-values.js';
import { DefinitionError } from '../storage/definition-error.js';

const HISTORY_FILE = 'history.db';
const SCHEMA_VERSION = 2;
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
          database.exec(version === 0 ? SCHEMA : UPGRADE_TO_WORKSPACES);
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
           (id, workspace_id, tool_id, tool_name, level, started_at, status, parameters)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        run.runId,
        run.workspaceId,
        run.toolId,
        run.toolName,
        run.level,
        run.startedAt,
        JSON.stringify(run.parameters),
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

  /** Marks runs nothing can finish anymore. Call it once, before any run starts. */
  recoverInterrupted(): number {
    return this.database
      .prepare(`UPDATE runs SET status = 'interrupted' WHERE status = 'running'`)
      .run().changes;
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

  /** Applies a run limit to every tool, for when the user lowers it. */
  pruneAll(keep: number): void {
    const tools = this.database
      .prepare<[], { workspace_id: string; tool_id: string }>(
        'SELECT DISTINCT workspace_id, tool_id FROM runs',
      )
      .all();
    for (const { workspace_id: workspaceId, tool_id: toolId } of tools) {
      this.prune(workspaceId, toolId, keep);
    }
  }

  /** Forgets a Workspace's finished runs, and gives the space back to the disk. */
  clear(workspaceId: string): void {
    this.database
      .prepare(`DELETE FROM runs WHERE workspace_id = ? AND status != 'running'`)
      .run(workspaceId);
    this.database.exec('VACUUM');
  }

  /** Forgets everything a deleted Workspace ran. */
  removeWorkspace(workspaceId: string): void {
    this.database.prepare('DELETE FROM runs WHERE workspace_id = ?').run(workspaceId);
    this.database.exec('VACUUM');
  }
}

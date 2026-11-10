import type { AutomationBlock, AutomationConnection } from '@bildora/protocol';
import type {
  HistoryAutomationRunView,
  HistoryStatus,
  HistorySummaryView,
  StepStateView,
} from '../../shared/ipc-contract.js';

/** One try of a tool block, as its tool run recorded it. */
export interface TimelineTry {
  readonly runId: string;
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly status: HistoryStatus;
}

/** A stretch of a row's bar, in milliseconds since the run started. */
export interface TimelineSegment {
  readonly from: number;
  readonly to: number;
  readonly state: StepStateView | HistoryStatus;
}

export interface TimelineRow {
  readonly id: string;
  /** The block as the automation holds it now. Absent when it has since been removed. */
  readonly block?: AutomationBlock;
  readonly state: StepStateView;
  /** How many Parallel blocks it sits inside. */
  readonly depth: number;
  /** When the run reached it, in milliseconds since the epoch. Unknown for some older runs. */
  readonly startedAt?: number;
  readonly durationMs?: number;
  readonly tries: readonly TimelineTry[];
  /** The tool it ran, from its tool runs, for a block no longer in the file. */
  readonly toolId?: string;
  readonly toolName?: string;
  /** The outputs the run left it through, in order. */
  readonly taken: readonly string[];
  readonly failure?: { readonly kind: string; readonly message: string };
  /** Empty for a block that was never reached, or whose start was not recorded. */
  readonly segments: readonly TimelineSegment[];
}

export interface Timeline {
  readonly rows: readonly TimelineRow[];
  /** Milliseconds since the epoch. */
  readonly start: number;
  /** Milliseconds since the epoch: the end of the run, or now while it goes on. */
  readonly end: number;
}

/** How far each block sits inside Parallel blocks, following connections from where it starts. */
function depths(
  types: ReadonlyMap<string, string>,
  starts: readonly string[],
  connections: readonly Pick<AutomationConnection, 'from' | 'to'>[],
): Map<string, number> {
  const found = new Map<string, number>(starts.map((id) => [id, 0]));
  const queue = [...starts];
  while (queue.length > 0) {
    const from = queue.shift() ?? '';
    const depth = found.get(from) ?? 0;
    for (const { to } of connections.filter((connection) => connection.from === from)) {
      if (found.has(to)) continue;
      const inside = depth + (types.get(from) === 'parallel' ? 1 : 0);
      found.set(to, Math.max(0, inside - (types.get(to) === 'join' ? 1 : 0)));
      queue.push(to);
    }
  }
  return found;
}

/**
 * Lays an automation run out over time: one row per block, in the order the run reached them, then
 * the blocks it never reached. `blocks` and `connections` are the automation as it is now, which
 * may differ from the run.
 */
export function timelineOf(
  { run, toolRuns }: HistoryAutomationRunView,
  blocks: readonly AutomationBlock[],
  connections: readonly AutomationConnection[],
  now: number,
): Timeline {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const toolRunsById = new Map<string, HistorySummaryView>(
    toolRuns.map((toolRun) => [toolRun.runId, toolRun]),
  );
  const types = new Map(blocks.map((block) => [block.id, block.type]));
  const startStep = run.steps.find(({ id }) => types.get(id) === 'start') ?? run.steps[0];
  const fileDepths = depths(
    types,
    blocks.filter(({ type }) => type === 'start').map(({ id }) => id),
    connections,
  );
  const pathDepths = depths(types, startStep === undefined ? [] : [startStep.id], run.paths);

  // The order the run went through its blocks: Start, then where each connection led.
  const visits: string[] = [];
  if (startStep !== undefined && startStep.state !== 'idle') visits.push(startStep.id);
  for (const { to } of run.paths) {
    if (!visits.includes(to)) visits.push(to);
  }

  const end =
    run.durationMs === undefined ? Math.max(now, run.startedAt) : run.startedAt + run.durationMs;
  const rows = run.steps.map((step): TimelineRow => {
    const block = byId.get(step.id);
    const ids = step.toolRunIds ?? (step.toolRunId === undefined ? [] : [step.toolRunId]);
    const tries = ids.flatMap((runId): TimelineTry[] => {
      const found = toolRunsById.get(runId);
      return found === undefined
        ? []
        : [
            {
              runId,
              startedAt: found.startedAt,
              status: found.status,
              ...(found.durationMs === undefined ? {} : { durationMs: found.durationMs }),
            },
          ];
    });
    const startedAt = step.startedAt ?? tries[0]?.startedAt;
    const first = tries[0] === undefined ? undefined : toolRunsById.get(tries[0].runId);
    const reached = step.state !== 'idle' && step.state !== 'skipped';
    const offset = (time: number): number => time - run.startedAt;
    const segments: TimelineSegment[] =
      !reached || startedAt === undefined
        ? []
        : tries.length > 1
          ? tries.map((attempt) => ({
              from: offset(attempt.startedAt),
              to: offset(attempt.startedAt + (attempt.durationMs ?? end - attempt.startedAt)),
              state: attempt.status,
            }))
          : [
              {
                from: offset(startedAt),
                to: offset(
                  startedAt +
                    (step.durationMs ??
                      (step.state === 'running' ? end - startedAt : (tries[0]?.durationMs ?? 0))),
                ),
                state: step.state,
              },
            ];
    return {
      id: step.id,
      ...(block === undefined ? {} : { block }),
      state: step.state,
      depth: fileDepths.get(step.id) ?? pathDepths.get(step.id) ?? 0,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      tries,
      ...(first === undefined ? {} : { toolId: first.toolId, toolName: first.toolName }),
      taken: [
        ...new Set(run.paths.filter(({ from }) => from === step.id).map(({ output }) => output)),
      ],
      ...(step.failure === undefined ? {} : { failure: step.failure }),
      segments,
    };
  });

  // A block with no recorded start sorts as if it began when the block before it did.
  const sortTime = new Map<string, number>();
  let latest = run.startedAt;
  for (const id of visits) {
    const row = rows.find((candidate) => candidate.id === id);
    latest = Math.max(latest, row?.startedAt ?? latest);
    sortTime.set(id, row?.startedAt ?? latest);
  }
  const rank = (row: TimelineRow): [number, number, number] => {
    const visit = visits.indexOf(row.id);
    return visit === -1
      ? [1, 0, rows.indexOf(row)]
      : [0, sortTime.get(row.id) ?? run.startedAt, visit];
  };
  const ordered = [...rows].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });

  const lastEnd = Math.max(
    end,
    ...ordered.flatMap(({ segments }) => segments.map(({ to }) => run.startedAt + to)),
  );
  return { rows: ordered, start: run.startedAt, end: Math.max(lastEnd, run.startedAt + 1) };
}

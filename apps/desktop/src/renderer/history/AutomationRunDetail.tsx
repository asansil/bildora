import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Clock,
  GitBranch,
  GitFork,
  GitMerge,
  Hand,
  ListTree,
  Play,
  ListOrdered,
  RefreshCw,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type {
  AutomationView,
  HistoryAutomationRunView,
  HistoryEntryView,
  HistoryRecordView,
  StepRunView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { blockKindText, blockName, outputLabel } from '../automations/canvas/block-text.js';
import { DataView } from '../automations/DataView.js';
import { ProgramIcon } from '../shell/ProgramIcon.js';
import { RunStateBadge, RunStateIcon } from '../shell/RunStateBadge.js';
import type { BlockState } from '../shell/RunStateBadge.js';
import { formatDuration, formatTime, historyState } from './history-format.js';
import { RunFacts } from './RunFacts.js';
import { timelineOf } from './run-timeline.js';
import type { Timeline, TimelineRow } from './run-timeline.js';
import { CalledBy } from '../automations/CalledBy.js';
import { roundText } from '../automations/canvas/block-text.js';

const api = window.bildora;

/** Ticks along the time axis, the ends included. */
const AXIS_TICKS = 5;
/** How far each Parallel level moves a block's name in, in pixels. */
const DEPTH_INDENT = 16;

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  start: Play,
  'wait-for-time': Clock,
  'wait-for-manual-action': Hand,
  if: GitBranch,
  switch: ListTree,
  parallel: GitFork,
  join: GitMerge,
  for: ListOrdered,
  while: RefreshCw,
  'run-automation': Workflow,
};

type AutomationEntry = Extract<HistoryEntryView, { kind: 'automation' }>;

/** Whether the run did the block's work, rather than miss it or pass through it. */
function ran(state: TimelineRow['state']): boolean {
  return state !== 'idle' && state !== 'skipped' && state !== 'disabled';
}

/** A block that never ran reads as skipped, whichever reason kept it from running. */
function shownState(row: TimelineRow): BlockState {
  return row.state === 'idle' ? 'skipped' : row.state;
}

function toolOf(row: TimelineRow, tools: readonly ToolView[]): ToolView | undefined {
  const id = row.block?.type === 'run' ? row.block.tool : row.toolId;
  return tools.find((tool) => tool.id === id);
}

/** A step is named as its block is, and a block since removed by the id it had. */
function rowName(row: TimelineRow): string {
  return row.block === undefined ? row.id : blockName(row.block);
}

/** What the step's block is: its tool's name, or its kind. */
function rowKind(row: TimelineRow, tools: readonly ToolView[]): string {
  if (row.block === undefined) return row.toolName ?? row.toolId ?? '';
  if (row.block.type === 'run') {
    return toolOf(row, tools)?.name ?? row.toolName ?? row.block.tool;
  }
  return blockKindText(row.block, tools);
}

function RowIcon({
  row,
  tools,
}: {
  readonly row: TimelineRow;
  readonly tools: readonly ToolView[];
}) {
  const tool = toolOf(row, tools);
  if (tool !== undefined) {
    return <ProgramIcon tool={tool} />;
  }
  const Icon = (row.block === undefined ? undefined : KIND_ICONS[row.block.type]) ?? SquareTerminal;
  return <Icon className="icon" aria-hidden="true" />;
}

/** What a block that is not a tool did, in a sentence. */
function whatHappened(row: TimelineRow, branches: number): string {
  if (row.state === 'skipped') return t('history.block.skipped');
  if (row.state === 'disabled') return t('history.block.disabled');
  if (row.state === 'idle') return t('history.block.notReached');
  if (row.state === 'running') return t('history.block.running');
  switch (row.block?.type) {
    case 'start':
      return t('history.block.start');
    case 'if':
    case 'switch':
      return row.taken[0] === undefined
        ? ''
        : t('history.block.went', { output: outputLabel(row.taken[0]) });
    case 'wait-for-time':
      return t('history.block.waited', { duration: formatDuration(row.durationMs) });
    case 'wait-for-manual-action':
      return t('history.block.asked', { message: row.block.message });
    case 'for':
    case 'while':
      return row.rounds === undefined ? '' : t('automation.roundsRun', { count: row.rounds });
    case 'parallel':
      return t('history.block.branches', { count: branches });
    case 'join':
      return row.state === 'completed' ? t('history.block.joined') : '';
    default:
      return row.block === undefined ? t('history.block.removed') : '';
  }
}

function percent(value: number, timeline: Timeline): string {
  return `${String((value / (timeline.end - timeline.start)) * 100)}%`;
}

function Bars({ row, timeline }: { readonly row: TimelineRow; readonly timeline: Timeline }) {
  const waits = row.block?.type === 'wait-for-time' || row.block?.type === 'wait-for-manual-action';
  return (
    <span className="timeline-track">
      {row.segments.map((segment, index) => {
        const style: CSSProperties = {
          left: percent(segment.from, timeline),
          width: percent(segment.to - segment.from, timeline),
        };
        const classes = [
          'timeline-bar',
          `state-${historyState(
            segment.state === 'idle' || segment.state === 'skipped' || segment.state === 'disabled'
              ? 'cancelled'
              : segment.state,
          )}`,
          segment.to === segment.from ? 'timeline-bar--tick' : '',
          waits ? 'timeline-bar--wait' : '',
        ];
        return <span key={index} className={classes.join(' ')} style={style} />;
      })}
    </span>
  );
}

interface BlockDetailProps {
  readonly row: TimelineRow;
  readonly tools: readonly ToolView[];
  readonly branches: number;
  /** The block as the run recorded it, with what it received and produced. */
  readonly step: StepRunView | undefined;
  readonly revision: unknown;
  readonly onError: (error: unknown) => void;
}

function BlockDetail({ row, tools, branches, step, revision, onError }: BlockDetailProps) {
  const [chosenTry, setChosenTry] = useState<string | undefined>(undefined);
  const [record, setRecord] = useState<HistoryRecordView | undefined>(undefined);
  const tryId = chosenTry ?? row.tries.at(-1)?.runId;
  const isTool = row.block?.type === 'run' || (row.block === undefined && row.tries.length > 0);

  useEffect(() => {
    if (tryId === undefined) return undefined;
    let current = true;
    void api
      .getHistoryRun(tryId)
      .then((found) => {
        if (current) setRecord(found);
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [tryId, revision, onError]);

  const happened = whatHappened(row, branches);
  return (
    <section className="timeline-detail" data-testid="history-block">
      <header className="tool-header">
        <RowIcon row={row} tools={tools} />
        <h2 title={rowName(row)}>{rowName(row)}</h2>
        <RunStateBadge state={shownState(row)} />
        <span className="muted">{rowKind(row, tools)}</span>
      </header>
      {row.tries.length > 1 ? (
        <div
          className="history-actions"
          role="group"
          aria-label={t('history.tries', { count: row.tries.length })}
        >
          {row.tries.map((attempt, index) => (
            <button
              key={attempt.runId}
              type="button"
              aria-pressed={attempt.runId === tryId}
              onClick={() => {
                setChosenTry(attempt.runId);
              }}
            >
              <RunStateIcon state={historyState(attempt.status)} />
              {t('history.try', { number: index + 1 })}
            </button>
          ))}
        </div>
      ) : null}
      {isTool && ran(row.state) ? (
        record !== undefined && record.runId === tryId ? (
          <RunFacts record={record} />
        ) : tryId === undefined ? (
          <p className="muted">{t('history.tryGone')}</p>
        ) : null
      ) : (
        <dl className="facts">
          {row.startedAt === undefined ? null : (
            <>
              <dt>{t('history.at')}</dt>
              <dd>{formatTime(row.startedAt)}</dd>
            </>
          )}
          {row.durationMs === undefined || row.durationMs < 1 ? null : (
            <>
              <dt>{t('history.duration')}</dt>
              <dd>{formatDuration(row.durationMs)}</dd>
            </>
          )}
          {happened === '' ? null : (
            <>
              <dt>{t('history.whatHappened')}</dt>
              <dd>{happened}</dd>
            </>
          )}
          {row.failure === undefined ? null : (
            <>
              <dt>{t('history.failure')}</dt>
              <dd>{row.failure.message}</dd>
            </>
          )}
        </dl>
      )}
      {isTool && step !== undefined && ran(row.state) ? (
        <section className="history-data" aria-label={t('canvas.data')}>
          <h3>{t('canvas.data')}</h3>
          <DataView step={step} />
        </section>
      ) : null}
    </section>
  );
}

interface AutomationRunDetailProps {
  readonly entry: AutomationEntry;
  /** The automation as it is now, absent when it can no longer be read. */
  readonly automation: AutomationView | undefined;
  readonly tools: readonly ToolView[];
  /** The tool the list is filtered by, whose block is chosen first. */
  readonly focusTool: string | undefined;
  readonly revision: unknown;
  readonly onOpenAutomation: (id: string) => void;
  readonly onShowRun: (id: string, runId: string) => void;
  readonly onError: (error: unknown) => void;
}

/** An automation run: a summary, then its blocks as bars over time, then the block chosen. */
export function AutomationRunDetail({
  entry,
  automation,
  tools,
  focusTool,
  revision,
  onOpenAutomation,
  onShowRun,
  onError,
}: AutomationRunDetailProps) {
  /** The run as last read, and when, so that a block still going reaches that moment. */
  const [loaded, setLoaded] = useState<
    { readonly data: HistoryAutomationRunView | undefined; readonly at: number } | undefined
  >(undefined);
  const data = loaded?.data;
  const [chosen, setChosen] = useState<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void api
      .getHistoryAutomationRun(entry.runId)
      .then((found) => {
        if (current) setLoaded({ data: found, at: Date.now() });
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [entry.runId, revision, onError]);

  const timeline = useMemo(
    () =>
      data === undefined || loaded === undefined || data.run.runId !== entry.runId
        ? undefined
        : timelineOf(data, automation?.blocks ?? [], automation?.connections ?? [], loaded.at),
    [data, loaded, entry.runId, automation],
  );
  const focused =
    focusTool === undefined
      ? undefined
      : timeline?.rows.find(
          (row) => toolOf(row, tools)?.id === focusTool || row.toolId === focusTool,
        )?.key;
  const shown = timeline?.rows.find((row) => row.key === (chosen ?? focused));
  const ranCount = timeline?.rows.filter(({ state }) => ran(state)).length;
  const ticks =
    timeline === undefined
      ? []
      : Array.from({ length: AXIS_TICKS }, (_, index) =>
          formatDuration(((timeline.end - timeline.start) * index) / (AXIS_TICKS - 1)),
        );

  return (
    <section className="history-detail" data-testid="history-detail">
      <header className="tool-header">
        <Workflow className="icon" aria-hidden="true" />
        <h1 title={automation?.name ?? entry.automationName}>
          {automation?.name ?? entry.automationName}
        </h1>
        <RunStateBadge state={historyState(entry.status)} />
      </header>
      {entry.status === 'interrupted' ? <p className="muted">{t('history.interrupted')}</p> : null}
      <dl className="facts">
        <dt>{t('history.started')}</dt>
        <dd>{formatTime(entry.startedAt)}</dd>
        <dt>{t('history.duration')}</dt>
        <dd>{formatDuration(entry.durationMs)}</dd>
        <dt>{t('history.startedFrom')}</dt>
        <dd>{t(entry.trigger === 'cli' ? 'history.fromCli' : 'history.fromApp')}</dd>
        {entry.caller === undefined ? null : (
          <>
            <dt>{t('history.caller')}</dt>
            <dd>
              <CalledBy caller={entry.caller} onShowRun={onShowRun} />
            </dd>
          </>
        )}
        {timeline === undefined || ranCount === undefined ? null : (
          <>
            <dt>{t('history.blocks')}</dt>
            <dd>
              {t('history.blockCount', { ran: ranCount, skipped: timeline.rows.length - ranCount })}
            </dd>
          </>
        )}
        {entry.failure === undefined ? null : (
          <>
            <dt>{t('history.failure')}</dt>
            <dd>{entry.failure.message}</dd>
          </>
        )}
      </dl>
      {automation === undefined ? null : (
        <div className="history-actions">
          <button
            type="button"
            onClick={() => {
              onOpenAutomation(automation.id);
            }}
          >
            {t('history.openAutomation')}
          </button>
          <button
            type="button"
            onClick={() => {
              onShowRun(automation.id, entry.runId);
            }}
          >
            {t('history.showOnCanvas')}
          </button>
        </div>
      )}
      {timeline === undefined ? null : (
        <>
          <h2>{t('history.overTime')}</h2>
          <div className="timeline" data-testid="history-timeline">
            {timeline.rows.map((row) => {
              const name = rowName(row);
              return (
                <button
                  key={row.key}
                  type="button"
                  className="timeline-row"
                  data-block={row.id}
                  data-round={row.round}
                  data-state={shownState(row)}
                  aria-current={row.key === shown?.key ? 'true' : undefined}
                  onClick={() => {
                    setChosen(row.key);
                  }}
                >
                  <span
                    className="timeline-label"
                    style={{ paddingInlineStart: `${String(row.depth * DEPTH_INDENT)}px` }}
                  >
                    <RunStateIcon state={shownState(row)} />
                    <RowIcon row={row} tools={tools} />
                    <span className="truncate" title={name}>
                      {name}
                    </span>
                    {row.round === undefined ? null : (
                      <span className="muted">{roundText(row.round)}</span>
                    )}
                    {row.tries.length > 1 ? (
                      <span className="muted">
                        {t('history.tries', { count: row.tries.length })}
                      </span>
                    ) : null}
                  </span>
                  <Bars row={row} timeline={timeline} />
                </button>
              );
            })}
            <div className="timeline-axis" aria-hidden="true">
              {ticks.map((tick, index) => (
                <span key={index}>{tick}</span>
              ))}
            </div>
          </div>
          {shown === undefined ? (
            <p className="muted">{t('history.pickBlock')}</p>
          ) : (
            <>
              <BlockDetail
                key={`${entry.runId}:${shown.key}`}
                row={shown}
                tools={tools}
                branches={
                  data?.run.paths.filter(
                    ({ from, round }) => from === shown.id && round === shown.round,
                  ).length ?? 0
                }
                step={data?.run.steps.find(
                  ({ id, round }) => id === shown.id && round === shown.round,
                )}
                revision={revision}
                onError={onError}
              />
              {shown.block?.type === 'run-automation' && shown.calledRunId !== undefined ? (
                <button
                  type="button"
                  data-testid="history-open-called-run"
                  onClick={() => {
                    if (shown.block?.type === 'run-automation' && shown.calledRunId !== undefined) {
                      onShowRun(shown.block.automation, shown.calledRunId);
                    }
                  }}
                >
                  {t('automation.openRun')}
                </button>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}

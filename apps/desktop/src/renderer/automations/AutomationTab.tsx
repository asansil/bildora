import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleX,
  Hand,
  History,
  Play,
  Redo2,
  Save,
  Square,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { blockingProblems, isWarning } from '@bildora/protocol';
import type { AutomationBlock, AutomationPosition } from '@bildora/protocol';
import { t } from '../../shared/i18n/translate.js';
import type {
  AutomationDraft,
  AutomationCanvasView,
  AutomationPanelsView,
  AutomationProblemView,
  AutomationRunRecordView,
  AutomationRunStateView,
  AutomationView,
  HistoryRecordView,
  StepRunView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { AUTOMATION_PANEL_SIZES } from '../../shared/ipc-contract.js';
import { formatDuration, formatTime, historyState } from '../history/history-format.js';
import { PanelResizer } from '../shell/PanelResizer.js';
import { RunStateBadge } from '../shell/RunStateBadge.js';
import { ConsolePane } from '../tools/ConsolePane.js';
import { commandFor } from './automation-draft.js';
import { BlockSwatch } from './canvas/BlockIcon.js';
import { BlockLibrary, CONTROL_KINDS } from './canvas/BlockLibrary.js';
import { BlockSettings } from './canvas/BlockSettings.js';
import { blockCardMenu } from './canvas/block-menu.js';
import type { BlockTab } from './canvas/BlockSettings.js';
import { PanelSectionsContext } from './canvas/PanelSection.js';
import type { PanelSections } from './canvas/PanelSection.js';
import { blockKindText, blockNames, kindLabel } from './canvas/block-text.js';
import { Canvas } from './canvas/Canvas.js';
import type { CanvasRun } from './canvas/Canvas.js';
import type { CanvasCommands, EditorCommands } from './canvas/canvas-commands.js';
import {
  GAP_X,
  addAfter,
  addBlocks,
  blockIdProblem,
  blockOf,
  createBlocks,
  namedChoice,
  documentOf,
  draftOf,
  addNote,
  groupBlocks,
  renameBlock,
  replaceBlock,
  sizeOf,
  spliceInto,
  takenIds,
  ungroup,
  unplaced,
  updateBlock,
  updateGroup,
  updateNote,
} from './canvas/flow-document.js';
import { GroupSettings, NoteSettings, SelectionSettings } from './canvas/ItemSettings.js';
import type { LibraryChoice } from './canvas/KeyboardDialogs.js';
import { Outline } from './canvas/Outline.js';
import { record, redo, replace, startHistory, undo } from './canvas/undo.js';
import { placeMissing } from './canvas/layout.js';
import type { ConnectionRef, FlowDocument, NewBlock } from './canvas/flow-document.js';
import { useBlockProfiles } from './canvas/use-profiles.js';
import { inputsOfFlow } from './canvas/values.js';
import type { ValueContext } from './canvas/values.js';
import { RenameDialog } from './canvas/RenameDialog.js';
import { RunInputsDialog } from './RunInputsDialog.js';
import { DataView } from './DataView.js';
import { problemText } from './problem-text.js';

const api = window.bildora;

/** How long editing has to pause before the flow is checked. */
const CHECK_DELAY_MS = 200;
/** How wide a folded side panel stays, as a column of the canvas grid. */
const STRIP = '36px';

/** A run that went on past a failed block finished, but saying only that would hide the failure. */
function finishedLabel(status: string, steps: readonly StepRunView[]): { readonly label?: string } {
  const count = steps.filter(({ state }) => state === 'failed').length;
  return status === 'completed' && count > 0
    ? { label: t('automation.completedWithFailures', { count }) }
    : {};
}

/** What the canvas shows: the flow to edit, or a run of it, read only. */
type View =
  | { readonly kind: 'edit' }
  | { readonly kind: 'live' }
  | { readonly kind: 'past'; readonly record: AutomationRunRecordView };

interface PastRunsProps {
  readonly runs: readonly AutomationRunRecordView[];
  readonly shown: string | undefined;
  readonly onOpen: (record: AutomationRunRecordView) => void;
  /** A double click opens the run and shows the output of its blocks. */
  readonly onOpenOutput: (record: AutomationRunRecordView) => void;
  /** Shows the run in Run history. */
  readonly onOpenInHistory: (runId: string) => void;
}

function PastRuns({ runs, shown, onOpen, onOpenOutput, onOpenInHistory }: PastRunsProps) {
  if (runs.length === 0) {
    return <p className="muted">{t('automation.noRuns')}</p>;
  }
  return (
    <ul className="automation-runs" data-testid="automation-runs">
      {runs.map((run) => (
        <li key={run.runId} className="automation-run-row">
          <button
            type="button"
            className="automation-run"
            aria-pressed={shown === run.runId}
            onClick={() => {
              onOpen(run);
            }}
            onDoubleClick={() => {
              onOpenOutput(run);
            }}
          >
            <RunStateBadge
              state={historyState(run.status)}
              {...finishedLabel(run.status, run.steps)}
            />
            <span className="truncate">{formatTime(run.startedAt)}</span>
            <span className="muted">
              {t(run.trigger === 'cli' ? 'automation.fromCli' : 'automation.fromApp')}
            </span>
            <span className="row-count">{formatDuration(run.durationMs)}</span>
            {run.failure === undefined ? null : (
              <span className="muted automation-run-failure">{run.failure.message}</span>
            )}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('automation.openInHistory')}
            title={t('automation.openInHistory')}
            data-testid="run-open-in-history"
            onClick={() => {
              onOpenInHistory(run.runId);
            }}
          >
            <History className="icon" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

interface ProblemsProps {
  readonly problems: readonly AutomationProblemView[];
  /** Why the last Run started nothing, shown as the first row. */
  readonly refusal?: string | undefined;
  readonly nameOf: (id: string) => string;
  readonly onPick: (blockId: string) => void;
}

function Problems({ problems, refusal, nameOf, onPick }: ProblemsProps) {
  if (problems.length === 0 && refusal === undefined) {
    return <p className="muted">{t('canvas.noProblems')}</p>;
  }
  return (
    <ul className="problem-list" data-testid="automation-problems">
      {refusal === undefined ? null : (
        <li className="problem-item problem-refused" role="alert" data-testid="run-refused">
          <CircleX className="icon" aria-hidden="true" />
          <span className="problem-text">{refusal}</span>
        </li>
      )}
      {[...blockingProblems(problems), ...problems.filter(isWarning)].map((problem, index) => {
        const { what, fix } = problemText(problem, nameOf);
        const warning = isWarning(problem);
        return (
          <li key={`${problem.code}-${String(index)}`}>
            <button
              type="button"
              className={warning ? 'problem-item problem-item--warning' : 'problem-item'}
              data-testid="automation-problem"
              data-severity={warning ? 'warning' : 'error'}
              data-block-id={problem.blockId}
              disabled={problem.blockId === undefined}
              onClick={() => {
                if (problem.blockId !== undefined) onPick(problem.blockId);
              }}
            >
              <TriangleAlert className="icon" aria-hidden="true" />
              <span className="problem-text">
                <span>{what}</span>
                <span className="problem-fix">{fix}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface RunDetailsProps {
  readonly block: AutomationBlock | undefined;
  readonly step: StepRunView | undefined;
  readonly name: string;
  readonly live: boolean;
  readonly tools: readonly ToolView[];
  readonly onContinue: (blockId: string) => void;
  readonly onShowTool: (id: string) => void;
}

/** What one block did in the run on view. */
function RunDetails({ block, step, name, live, tools, onContinue, onShowTool }: RunDetailsProps) {
  if (block === undefined) {
    return <p className="field-hint">{t('canvas.runPick')}</p>;
  }
  const state = step?.state ?? 'idle';
  const waiting = live && state === 'running' && step?.message !== undefined;
  const hasTool = block.type === 'run' && tools.some(({ id }) => id === block.tool);
  return (
    <div className="run-details" data-testid="run-details" data-block-id={block.id}>
      <h2>{name}</h2>
      <p className="muted">{blockKindText(block, tools)}</p>
      <RunStateBadge state={state} />
      {state === 'skipped' ? <p className="muted">{t('automation.skipped')}</p> : null}
      {state === 'disabled' ? <p className="muted">{t('automation.disabled')}</p> : null}
      {step?.durationMs === undefined ? null : <p>{formatDuration(step.durationMs)}</p>}
      {step?.failure === undefined ? null : <p className="field-problem">{step.failure.message}</p>}
      {waiting ? (
        <>
          <p>{step.message}</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onContinue(block.id);
            }}
          >
            {t('automation.continue')}
          </button>
        </>
      ) : null}
      {block.type === 'run' && hasTool && step?.toolRunId !== undefined ? (
        <button
          type="button"
          onClick={() => {
            onShowTool(block.tool);
          }}
        >
          {t('automation.openTool')}
        </button>
      ) : null}
    </div>
  );
}

/** Why pressing Run started nothing. */
type Refusal =
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'problems'; readonly count: number }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Saving a new automation reopens its tab under its id, so a refusal found while saving is
 * handed to the new tab here.
 */
const refusalsForNewTabs = new Map<string, Refusal>();

/**
 * A new automation whose flow takes inputs is run by its reopened tab, which asks for them first,
 * so a required input is never left without a value.
 */
const runRequestsForNewTabs = new Set<string>();

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what a handler throws with the name of the channel.
  return text.replace(/^Error invoking remote method '[^']+': (?:(?:Input)?Error: )?/, '');
}

function refusalText(refusal: Refusal): string {
  switch (refusal.kind) {
    case 'unnamed':
      return t('canvas.runUnnamed');
    case 'problems':
      return t('canvas.runRefused', { count: refusal.count });
    case 'error':
      return refusal.message;
  }
}

function refusalOf(problems: readonly AutomationProblemView[]): Refusal {
  return { kind: 'problems', count: problems.length };
}

/** A step's run keeps the size it started with: its output is only watched here. */
function keepSize(): void {
  // Nothing to resize.
}

interface BlockOutputProps {
  readonly block: AutomationBlock | undefined;
  readonly step: StepRunView | undefined;
  readonly onError: (error: unknown) => void;
}

/** What the tool run of one block wrote: live while it runs, then as History kept it. */
function BlockOutput({ block, step, onError }: BlockOutputProps) {
  const toolRunId = step?.toolRunId;
  const live = step?.state === 'running';
  const [record, setRecord] = useState<HistoryRecordView | undefined>(undefined);

  useEffect(() => {
    if (toolRunId === undefined || live) return undefined;
    let current = true;
    void api
      .getHistoryRun(toolRunId)
      .then((found) => {
        if (current) setRecord(found);
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [toolRunId, live, onError]);

  if (block === undefined) {
    return <p className="muted">{t('canvas.outputPick')}</p>;
  }
  if (block.type !== 'run') {
    return <p className="muted">{t('canvas.outputNone')}</p>;
  }
  if (toolRunId === undefined) {
    return <p className="muted">{t('canvas.outputNotRun')}</p>;
  }
  if (live) {
    return (
      <div className="block-output-console" data-testid="block-output" data-live="true">
        <ConsolePane runId={toolRunId} running={false} onSize={keepSize} />
      </div>
    );
  }
  if (record?.runId !== toolRunId) return null;
  return (
    <div data-testid="block-output">
      {record.outputTruncated ? <p className="muted">{t('history.truncated')}</p> : null}
      <pre className="history-output block-output">
        {record.output === '' ? t('history.noOutput') : record.output}
      </pre>
    </div>
  );
}

interface AutomationTabProps {
  /** Absent for a new automation, which has no file yet. */
  readonly automation: AutomationView | undefined;
  readonly run: AutomationRunStateView | undefined;
  readonly tools: readonly ToolView[];
  /** False while another tab is shown. */
  readonly active: boolean;
  /** Changes when a past run may have appeared, such as one from the CLI. */
  readonly revision: unknown;
  /** How the panels around the canvas are laid out, shared by every automation tab. */
  readonly panels: AutomationPanelsView;
  /** A panel changed. `commit` is false while a drag is still going, so it is stored only after. */
  readonly onPanels: (panels: AutomationPanelsView, commit: boolean) => void;
  /** Canvas options, shared by every automation tab. */
  readonly canvasOptions: AutomationCanvasView;
  readonly onCanvasOptions: (options: AutomationCanvasView) => void;
  readonly onSave: (draft: AutomationDraft) => Promise<AutomationView>;
  /** A new automation was saved, and its tab now shows it. */
  readonly onSaved: (id: string) => void;
  /** Starts the saved automation with this id. Rejects when it cannot start. */
  readonly onRun: (
    id: string,
    inputs?: Readonly<Record<string, string | number | boolean>>,
  ) => Promise<unknown>;
  readonly onShowTool: (id: string) => void;
  /** Shows one of the automation's past runs in Run history. */
  readonly onOpenInHistory: (automationId: string, runId: string) => void;
  readonly onDirty: (dirty: boolean) => void;
  readonly onUsed: () => void;
  readonly onError: (error: unknown) => void;
  /** Changes each time the sidebar asks to rename the automation: its name field is selected. */
  readonly renameRequest?: number | undefined;
  /** Asks to show one of its past runs; a new `count` asks again. */
  readonly showRunRequest?: { readonly runId: string; readonly count: number } | undefined;
  /** Given while this tab is on view, so the app's menus act on its canvas. */
  readonly onCommands?: ((commands: CanvasCommands | undefined) => void) | undefined;
}

/** One automation in its tab: built and watched on a canvas. */
export function AutomationTab(props: AutomationTabProps) {
  return (
    <ReactFlowProvider>
      <FlowEditor {...props} />
    </ReactFlowProvider>
  );
}

function FlowEditor({
  automation,
  run,
  tools,
  active,
  revision,
  panels,
  onPanels,
  canvasOptions,
  onCanvasOptions,
  onSave,
  onSaved,
  onRun,
  onShowTool,
  onOpenInHistory,
  onDirty,
  onUsed,
  onError,
  onCommands,
  renameRequest,
  showRunRequest,
}: AutomationTabProps) {
  const [saved, setSaved] = useState(() => documentOf(automation));
  const [history, setHistory] = useState(() => startHistory(saved));
  const document = history.present;
  /** Changes on undo and redo, so forms holding their own text start again from the document. */
  const [undoCount, setUndoCount] = useState(0);
  /** Changes the document without a step to undo, for what is not an edit. */
  const setDocument = useCallback(
    (next: FlowDocument | ((current: FlowDocument) => FlowDocument)) => {
      setHistory((current) =>
        replace(current, typeof next === 'function' ? next(current.present) : next),
      );
    },
    [],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [checked, setChecked] = useState<readonly AutomationProblemView[]>(
    automation?.problems ?? [],
  );
  const [past, setPast] = useState<readonly AutomationRunRecordView[]>([]);
  const [view, setView] = useState<View>(
    run?.status === 'running' ? { kind: 'live' } : { kind: 'edit' },
  );
  const [refusal, setRefusal] = useState<Refusal | undefined>(() => {
    if (automation === undefined) return undefined;
    const handed = refusalsForNewTabs.get(automation.id);
    refusalsForNewTabs.delete(automation.id);
    return handed;
  });
  const [lower, setLower] = useState<'problems' | 'runs' | 'outline' | 'output' | 'data'>(
    'problems',
  );
  /** The tab of the block panel, kept while other blocks are chosen. */
  const [blockTab, setBlockTab] = useState<BlockTab>('settings');
  const nameField = useRef<HTMLInputElement>(null);
  /** False once the tab has gone, such as after a new automation is saved under its id. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [reveal, setReveal] = useState<{ id: string; count: number; center?: boolean } | undefined>(
    undefined,
  );
  const [saving, setSaving] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | undefined>(undefined);

  // Rename from the sidebar selects the name, once the tab is drawn.
  useEffect(() => {
    if (renameRequest === undefined) return undefined;
    const frame = requestAnimationFrame(() => {
      nameField.current?.focus();
      nameField.current?.select();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [renameRequest]);

  const savedText = useMemo(() => JSON.stringify(draftOf(saved)), [saved]);
  const draft = useMemo(() => draftOf(document, automation?.id), [document, automation?.id]);
  const dirty = JSON.stringify(draftOf(document)) !== savedText;
  const named = draft.name !== '';
  const running = run?.status === 'running';

  // A saved automation that changes on disk, and is not being edited, shows the new version.
  const [known, setKnown] = useState(automation);
  if (known !== automation) {
    setKnown(automation);
    if (automation !== undefined) {
      const next = documentOf(automation);
      setSaved(next);
      if (!dirty) setDocument(next);
    }
  }

  // History asks for a past run, which shows once the list of past runs holds it.
  const [handledShow, setHandledShow] = useState<number | undefined>(undefined);
  const askedRun =
    showRunRequest === undefined || showRunRequest.count === handledShow
      ? undefined
      : past.find(({ runId }) => runId === showRunRequest.runId);
  if (askedRun !== undefined && showRunRequest !== undefined) {
    setHandledShow(showRunRequest.count);
    setView({ kind: 'past', record: askedRun });
    setSelected(new Set());
    setRefusal(undefined);
    setLower('runs');
  }

  // A run that starts takes the canvas, so the person sees it move.
  const [shownRun, setShownRun] = useState(run?.status === 'running' ? run.runId : undefined);
  if (run?.status === 'running' && shownRun !== run.runId) {
    setShownRun(run.runId);
    setView({ kind: 'live' });
    setSelected(new Set());
  }

  // Blocks with no position, from a file written by hand or converted, are placed on opening.
  // That is not an edit: the positions reach the file with the next save.
  const needsPlacing = unplaced(document).length > 0;
  const placeBlocks = useEffectEvent(() => {
    let current = true;
    void placeMissing(document)
      .then((positions) => {
        if (!current || positions === undefined) return;
        const place = (flow: FlowDocument): FlowDocument => ({
          ...flow,
          positions: { ...positions, ...flow.positions },
        });
        setSaved(place);
        setDocument(place);
      })
      .catch(onError);
    return () => {
      current = false;
    };
  });
  // The file can come again from disk as the positions arrive, and undo them in the same render,
  // so new positions start the placing again even when blocks were missing before as well.
  useEffect(() => {
    if (!needsPlacing) return undefined;
    return placeBlocks();
  }, [needsPlacing, document.positions]);

  // The shell passes new callbacks on every render, so the latest ones are read when needed.
  const reportDirty = useEffectEvent((value: boolean) => {
    onDirty(value);
    if (value) onUsed();
  });
  useEffect(() => {
    reportDirty(dirty);
  }, [dirty]);
  useEffect(
    () => () => {
      reportDirty(false);
    },
    [],
  );

  useEffect(() => {
    if (!named) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      void api
        .checkAutomation(draft)
        .then((list) => {
          if (current) setChecked(list);
        })
        .catch(onError);
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [draft, named, onError]);

  const status = run?.status;
  useEffect(() => {
    if (automation === undefined) return undefined;
    let current = true;
    void api
      .automationHistory(automation.id)
      .then((list) => {
        if (current) setPast(list);
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [automation, status, revision, onError]);

  const names = useMemo(() => blockNames(document.blocks), [document.blocks]);
  const profiles = useBlockProfiles(document.blocks, onError);
  const valueContext: ValueContext = useMemo(
    () => ({ blocks: document.blocks, connections: document.connections, tools, profiles }),
    [document.blocks, document.connections, tools, profiles],
  );
  /** The automation whose inputs Run is asking for, while the form is open. */
  const [asking, setAsking] = useState<string | undefined>(() => {
    if (automation === undefined || !runRequestsForNewTabs.has(automation.id)) return undefined;
    runRequestsForNewTabs.delete(automation.id);
    return automation.id;
  });
  /** The canvas's commands, which the selected block's card offers too, passed on to the app. */
  const [canvasCommands, setCanvasCommands] = useState<CanvasCommands | undefined>();
  const keepCommands = useCallback(
    (commands: CanvasCommands | undefined) => {
      setCanvasCommands(commands);
      onCommands?.(commands);
    },
    [onCommands],
  );
  /** The block the Rename dialog is open for. */
  const [renaming, setRenaming] = useState<string | undefined>();
  const nameOf = useCallback((id: string) => names.get(id) ?? id, [names]);
  const problemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    // A block's mark counts what keeps the flow from running; warnings are listed in Problems.
    for (const { blockId } of blockingProblems(checked)) {
      if (blockId !== undefined) counts.set(blockId, (counts.get(blockId) ?? 0) + 1);
    }
    return counts;
  }, [checked]);

  /** An edit, which Undo can take back. Edits with the same key in a row undo as one. */
  const change = useCallback((update: (current: FlowDocument) => FlowDocument, key?: string) => {
    setHistory((current) => record(current, update(current.present), key, Date.now()));
  }, []);

  function step(direction: 'undo' | 'redo'): void {
    setHistory((current) => (direction === 'undo' ? undo(current) : redo(current)));
    setUndoCount((current) => current + 1);
  }

  const watching = view.kind !== 'edit';
  const select = useCallback(
    (ids: ReadonlySet<string>) => {
      setSelected(ids);
      // In a run, choosing a block is asking what it did.
      if (watching && ids.size === 1) setLower('output');
    },
    [watching],
  );

  // Undo, redo or Replace can take a selected item away; it leaves the selection with it, so the
  // next click on a block selects that block alone.
  const present = takenIds(document);
  if ([...selected].some((id) => !present.has(id))) {
    setSelected(new Set([...selected].filter((id) => present.has(id))));
  }
  const [only] = selected.size === 1 ? [...selected] : [];
  const selectedBlock = document.blocks.find(({ id }) => id === only);
  const selectedNote = document.notes.find(({ id }) => id === only);
  const selectedGroup = document.groups.find(({ id }) => id === only);
  const selectedBlocks = document.blocks.filter(({ id }) => selected.has(id));
  const selectedGroups = document.groups.filter(({ id }) => selected.has(id));

  /** Frames the selected blocks under a new name. */
  function group(): void {
    if (selectedBlocks.length === 0) return;
    const name = t('canvas.groupDefault', { number: document.groups.length + 1 });
    const result = groupBlocks(
      document,
      selectedBlocks.map(({ id }) => id),
      name,
    );
    change(() => result.document);
    if (result.id !== undefined) setSelected(new Set([result.id]));
  }

  /** Removes the frames of the selected groups, and selects the blocks they held. */
  function ungroupSelected(): void {
    if (selectedGroups.length === 0) return;
    change((current) => selectedGroups.reduce((flow, { id }) => ungroup(flow, id), current));
    setSelected(new Set(selectedGroups.flatMap(({ blocks }) => blocks)));
  }

  /** A note goes where it was dropped, else under the selected block, or under Start. */
  function note(where?: AutomationPosition): void {
    const below = [only, 'start'].find((id) => id !== undefined && document.positions[id]);
    const at = below === undefined ? undefined : document.positions[below];
    const block = below === undefined ? undefined : document.blocks.find(({ id }) => id === below);
    const spot = where ?? {
      x: at?.x ?? 0,
      y: (at?.y ?? 0) + (block === undefined ? 0 : sizeOf(block).height) + GAP_X,
    };
    const result = addNote(document, spot, '');
    change(() => result.document);
    setSelected(new Set([result.id]));
    setReveal((current) => ({ id: result.id, count: (current?.count ?? 0) + 1 }));
  }

  /**
   * Adds a block where it was dropped, or after a block: the selected one, else the last one
   * added, else Start. Pressing blocks in the library one after another builds a chain.
   */
  function add(
    choice: NewBlock,
    at?: AutomationPosition,
    after?: string,
    into?: ConnectionRef,
  ): string | undefined {
    const anchor = [after, only, lastAdded, 'start'].find(
      (id) => id !== undefined && document.positions[id] !== undefined,
    );
    const blocks = createBlocks(
      document,
      namedChoice(choice, tools),
      t('automation.defaultMessage'),
      anchor,
    );
    const [first] = blocks;
    if (first === undefined) return undefined;
    let next: FlowDocument;
    if (at !== undefined) {
      next = addBlocks(document, blocks, at);
      // Dropped onto a connection, it goes into it, unless it has no way on from there.
      const tail = blocks.find(({ type }) => type === 'join') ?? first;
      if (into !== undefined) next = spliceInto(next, into, first.id, tail.id) ?? next;
    } else if (anchor !== undefined) {
      next = addAfter(document, anchor, blocks).document;
    } else {
      const right = Math.max(
        ...document.blocks.map((block) => {
          const position = document.positions[block.id];
          return position === undefined ? 0 : position.x + sizeOf(block).width;
        }),
      );
      next = addBlocks(document, blocks, {
        x: right + GAP_X,
        y: document.positions['start']?.y ?? 0,
      });
    }
    change(() => next);
    setSelected(new Set([first.id]));
    setLastAdded(blocks.find(({ type }) => type === 'join')?.id ?? first.id);
    setReveal((current) => ({ id: first.id, count: (current?.count ?? 0) + 1 }));
    return first.id;
  }

  const library = useMemo(
    (): LibraryChoice[] => [
      ...tools.map((tool) => ({
        choice: { kind: 'run' as const, tool: tool.id },
        label: tool.name,
        icon: <BlockSwatch kind="run" tool={tool} />,
        ...(tool.category === undefined ? {} : { group: tool.category }),
      })),
      ...CONTROL_KINDS.map((kind) => ({
        choice: { kind },
        label: kindLabel(kind),
        icon: <BlockSwatch kind={kind} />,
      })),
    ],
    [tools],
  );
  const [focusRequest, setFocusRequest] = useState<{ id: string; count: number } | undefined>(
    undefined,
  );

  /** Saves the draft, and gives back what was saved. */
  async function store(): Promise<AutomationView> {
    setSaving(true);
    try {
      const stored = await onSave(draft);
      const next = documentOf(stored);
      setSaved(next);
      setDocument(next);
      setChecked(stored.problems);
      return stored;
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function save(): void {
    void store()
      .then((stored) => {
        if (automation === undefined) onSaved(stored.id);
      })
      .catch(onError);
  }

  function changePanels(change: AutomationPanelsView, commit = true): void {
    onPanels({ ...panels, ...change }, commit);
  }

  const folded = panels.foldedSections;
  const sections = useMemo(
    (): PanelSections => ({
      folded: new Set(folded),
      onFold: (key, fold) => {
        const rest = (folded ?? []).filter((section) => section !== key);
        onPanels({ ...panels, foldedSections: fold ? [...rest, key] : rest }, true);
      },
    }),
    // `panels` changes with every resize; the folded list is what the sections depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folded, onPanels],
  );

  /** Shows a tab of the lower panel, opening the panel if it was folded away. */
  function showLower(tab: typeof lower): void {
    setLower(tab);
    if (panels.lowerCollapsed === true) changePanels({ lowerCollapsed: false });
  }

  /** Shows why nothing ran, beside the problems that say what to fix. */
  function refuse(reason: Refusal): void {
    setRefusal(reason);
    showLower('problems');
    setView({ kind: 'edit' });
  }

  /** Run saves the flow first, so what runs is what is on the canvas. */
  async function saveAndRun(): Promise<void> {
    onUsed();
    setRefusal(undefined);
    if (!named) {
      refuse({ kind: 'unnamed' });
      nameField.current?.focus();
      return;
    }
    let id: string;
    let problems: readonly AutomationProblemView[];
    if (dirty || automation === undefined) {
      const stored = await store();
      id = stored.id;
      problems = blockingProblems(stored.problems);
      if (automation === undefined) {
        // The tab reopens under the new id, so the refusal, or the run that asks for inputs
        // first, is handed to it.
        const asks = problems.length === 0 && inputsOfFlow(document.blocks).length > 0;
        if (problems.length > 0) refusalsForNewTabs.set(id, refusalOf(problems));
        if (asks) runRequestsForNewTabs.add(id);
        onSaved(id);
        if (asks) return;
      } else if (problems.length > 0) {
        refuse(refusalOf(problems));
      }
    } else {
      id = automation.id;
      const found = await api.checkAutomation(draft);
      setChecked(found);
      problems = blockingProblems(found);
      if (problems.length > 0) refuse(refusalOf(problems));
    }
    if (problems.length > 0) return;
    // A new automation's tab reopens under its id, so only a tab that stays can ask.
    if (inputsOfFlow(document.blocks).length > 0 && mounted.current && automation !== undefined) {
      setAsking(id);
      return;
    }
    await start(id);
  }

  async function start(
    id: string,
    inputs?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    await onRun(id, inputs).catch((error: unknown) => {
      const message = messageOf(error);
      // A new automation's tab has reopened by now, so the shell shows why.
      if (mounted.current) refuse({ kind: 'error', message });
      else onError(error);
    });
  }

  function pick(blockId: string): void {
    if (panels.settingsCollapsed === true) changePanels({ settingsCollapsed: false });
    setView({ kind: 'edit' });
    setSelected(new Set([blockId]));
    setReveal((current) => ({ id: blockId, count: (current?.count ?? 0) + 1, center: true }));
  }

  const runOnView: CanvasRun | undefined =
    view.kind === 'live' && run !== undefined
      ? run
      : view.kind === 'past'
        ? view.record
        : undefined;
  // Fixing what stopped the run answers the notice about it.
  if (refusal?.kind === 'problems' && checked.length === 0) setRefusal(undefined);
  if (refusal?.kind === 'unnamed' && named) setRefusal(undefined);
  const libraryCollapsed = panels.libraryCollapsed === true;
  const settingsCollapsed = panels.settingsCollapsed === true;
  const lowerCollapsed = panels.lowerCollapsed === true;
  const libraryWidth = panels.libraryWidth ?? AUTOMATION_PANEL_SIZES.libraryWidth.default;
  const settingsWidth = panels.settingsWidth ?? AUTOMATION_PANEL_SIZES.settingsWidth.default;
  const lowerHeight = panels.lowerHeight ?? AUTOMATION_PANEL_SIZES.lowerHeight.default;
  // A resizer takes no room of its own: its column is as wide as nothing.
  const columns = [
    runOnView === undefined ? (libraryCollapsed ? STRIP : `${String(libraryWidth)}px auto`) : '',
    'minmax(0, 1fr)',
    settingsCollapsed ? STRIP : `auto ${String(settingsWidth)}px`,
  ].join(' ');
  // The Output tab belongs to a run, and editing has none.
  if ((lower === 'output' || lower === 'data') && runOnView === undefined) setLower('problems');

  const editing = view.kind === 'edit';
  const editor: EditorCommands = {
    undo: {
      enabled: editing && history.past.length > 0,
      run: () => {
        step('undo');
      },
    },
    redo: {
      enabled: editing && history.future.length > 0,
      run: () => {
        step('redo');
      },
    },
    group: { enabled: runOnView === undefined && selectedBlocks.length > 0, run: group },
    ungroup: {
      enabled: runOnView === undefined && selectedGroups.length > 0,
      run: ungroupSelected,
    },
    save: { enabled: dirty && named && !saving, run: save },
    saveAndRun: {
      enabled: !saving && !running,
      run: () => {
        saveAndRun().catch(onError);
      },
    },
  };

  return (
    <section
      className="automation-tab flow-tab"
      data-testid="automations"
      onKeyDown={(event) => {
        // Text fields keep their own undo; elsewhere in the tab, undo steps through the flow.
        const target = event.target as HTMLElement;
        const typing = target.closest('input, textarea, select, [contenteditable="true"]') !== null;
        const key = event.key.toLowerCase();
        if (event.ctrlKey && !event.altKey && !typing && view.kind === 'edit') {
          if (key === 'z' && !event.shiftKey) {
            event.preventDefault();
            step('undo');
            return;
          }
          if (key === 'y' || (key === 'z' && event.shiftKey)) {
            event.preventDefault();
            step('redo');
            return;
          }
        }
        // Ctrl+S saves from anywhere in the tab, text fields included; F5 saves and runs.
        if (event.ctrlKey && !event.shiftKey && !event.altKey && key === 's') {
          event.preventDefault();
          if (editor.save.enabled) editor.save.run();
          return;
        }
        if (event.key === 'F5' && !event.ctrlKey && !event.shiftKey && !event.altKey && !typing) {
          event.preventDefault();
          if (editor.saveAndRun.enabled) editor.saveAndRun.run();
          return;
        }
        // Ctrl+G frames the selected blocks, wherever focus is in the tab.
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'g') {
          if (runOnView !== undefined || selectedBlocks.length === 0) return;
          event.preventDefault();
          group();
        }
      }}
    >
      <header className="flow-header">
        <input
          ref={nameField}
          className="flow-name"
          aria-label={t('automation.name')}
          placeholder={t('canvas.namePlaceholder')}
          value={document.name}
          onChange={(event) => {
            const name = event.target.value;
            change((current) => ({ ...current, name }), 'name');
          }}
        />
        <input
          className="flow-description"
          aria-label={t('automation.description')}
          placeholder={t('canvas.descriptionPlaceholder')}
          value={document.description}
          onChange={(event) => {
            const description = event.target.value;
            change((current) => ({ ...current, description }), 'description');
          }}
        />
        {runOnView === undefined ? null : (
          <RunStateBadge
            state={
              view.kind === 'past' ? historyState(view.record.status) : (run?.status ?? 'idle')
            }
            {...finishedLabel(
              view.kind === 'past' ? view.record.status : (run?.status ?? ''),
              runOnView.steps,
            )}
          />
        )}
        <div className="actions">
          {view.kind === 'edit' ? null : (
            <button
              type="button"
              onClick={() => {
                setView({ kind: 'edit' });
                setSelected(new Set());
              }}
            >
              <ArrowLeft className="icon" aria-hidden="true" />
              {t('canvas.backToEditing')}
            </button>
          )}
          {view.kind === 'edit' ? (
            <>
              <button
                type="button"
                className="icon-button"
                aria-label={t('canvas.undo')}
                title={t('canvas.undoShortcut')}
                disabled={history.past.length === 0}
                onClick={() => {
                  step('undo');
                }}
              >
                <Undo2 className="icon" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t('canvas.redo')}
                title={t('canvas.redoShortcut')}
                disabled={history.future.length === 0}
                onClick={() => {
                  step('redo');
                }}
              >
                <Redo2 className="icon" aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label={t('canvas.save')}
            title={named ? t('canvas.saveShortcut') : t('canvas.nameFirst')}
            disabled={!dirty || !named || saving}
            onClick={save}
          >
            <Save className="icon" aria-hidden="true" />
          </button>
          {running ? (
            <button
              type="button"
              className="icon-button"
              aria-label={t('automation.stop')}
              title={t('automation.stop')}
              onClick={() => {
                void api.cancelAutomation(run.runId).catch(onError);
              }}
            >
              <Square className="icon" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button primary"
              aria-label={
                dirty || automation === undefined ? t('canvas.saveAndRun') : t('automation.run')
              }
              title={
                dirty || automation === undefined
                  ? t('canvas.saveAndRunShortcut')
                  : t('canvas.runShortcut')
              }
              disabled={saving}
              onClick={() => {
                saveAndRun().catch(onError);
              }}
            >
              <Play className="icon" aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {view.kind === 'live' && run !== undefined
        ? run.steps
            .filter(({ state, message }) => state === 'running' && message !== undefined)
            .map((step) => (
              <div
                key={step.id}
                className="notice flow-waiting"
                role="status"
                data-testid="automation-waiting"
              >
                <Hand className="icon" aria-hidden="true" />
                <p>
                  <strong>{t('automation.waitingForYou')}</strong> {step.message}
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    void api.confirmAutomation(run.runId, step.id).catch(onError);
                  }}
                >
                  {t('automation.continue')}
                </button>
              </div>
            ))
        : null}
      <div className="flow-body" style={{ gridTemplateColumns: columns }}>
        {runOnView !== undefined ? null : libraryCollapsed ? (
          <div className="flow-strip flow-strip-library">
            <button
              type="button"
              className="icon-button"
              aria-label={t('canvas.showLibrary')}
              title={t('canvas.showLibrary')}
              aria-expanded="false"
              onClick={() => {
                changePanels({ libraryCollapsed: false });
              }}
            >
              <ChevronRight className="icon" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <BlockLibrary
              tools={tools}
              onAdd={(choice) => {
                if (choice.kind === 'note') note();
                else add(choice);
              }}
              onCollapse={() => {
                changePanels({ libraryCollapsed: true });
              }}
            />
            <PanelResizer
              value={libraryWidth}
              {...AUTOMATION_PANEL_SIZES.libraryWidth}
              initial={AUTOMATION_PANEL_SIZES.libraryWidth.default}
              label={t('canvas.resizeLibrary')}
              onResize={(size) => {
                changePanels({ libraryWidth: size }, false);
              }}
              onCommit={(size) => {
                changePanels({ libraryWidth: size });
              }}
            />
          </>
        )}
        <Canvas
          document={document}
          names={names}
          tools={tools}
          problemCounts={problemCounts}
          selected={selected}
          active={active}
          {...(runOnView === undefined ? {} : { run: runOnView })}
          {...(reveal === undefined ? {} : { reveal })}
          onChange={change}
          onSelect={select}
          onAddAt={(choice, at, into) => {
            if (choice.kind === 'note') note(at);
            else add(choice, at, undefined, into);
          }}
          library={library}
          onOpenBlock={(id) => {
            pick(id);
          }}
          onRenameBlock={(id) => {
            pick(id);
            setRenaming(id);
          }}
          onReplaceBlock={(id, choice) => {
            const replaced = replaceBlock(document, id, namedChoice(choice, tools));
            if (replaced === undefined) return undefined;
            change(() => replaced.document);
            setSelected(new Set([replaced.id]));
            return replaced.id;
          }}
          onAddAfter={(anchor, choice) => add(choice, undefined, anchor)}
          {...(focusRequest === undefined ? {} : { focusRequest })}
          options={canvasOptions}
          onOptions={onCanvasOptions}
          editor={editor}
          onCommands={keepCommands}
          onError={onError}
        />
        {settingsCollapsed ? (
          <div className="flow-strip flow-strip-settings">
            <button
              type="button"
              className="icon-button"
              aria-label={t('canvas.showSettings')}
              title={t('canvas.showSettings')}
              aria-expanded="false"
              onClick={() => {
                changePanels({ settingsCollapsed: false });
              }}
            >
              <ChevronLeft className="icon" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <PanelResizer
            value={settingsWidth}
            {...AUTOMATION_PANEL_SIZES.settingsWidth}
            initial={AUTOMATION_PANEL_SIZES.settingsWidth.default}
            invert
            label={t('canvas.resizeSettings')}
            onResize={(size) => {
              changePanels({ settingsWidth: size }, false);
            }}
            onCommit={(size) => {
              changePanels({ settingsWidth: size });
            }}
          />
        )}
        <aside
          className="flow-side flow-settings"
          aria-label={t('canvas.settings')}
          hidden={settingsCollapsed}
        >
          <button
            type="button"
            className="icon-button panel-collapse"
            aria-label={t('canvas.hideSettings')}
            title={t('canvas.hideSettings')}
            aria-expanded="true"
            onClick={() => {
              changePanels({ settingsCollapsed: true });
            }}
          >
            <ChevronRight className="icon" aria-hidden="true" />
          </button>
          {runOnView !== undefined ? (
            <RunDetails
              block={selectedBlock}
              step={runOnView.steps.find(({ id }) => id === only)}
              name={only === undefined ? '' : nameOf(only)}
              live={view.kind === 'live'}
              tools={tools}
              onContinue={(blockId) => {
                if (run !== undefined) {
                  void api.confirmAutomation(run.runId, blockId).catch(onError);
                }
              }}
              onShowTool={onShowTool}
            />
          ) : selectedBlocks.length > 1 ? (
            <SelectionSettings count={selectedBlocks.length} onGroup={group} />
          ) : selectedNote !== undefined ? (
            <NoteSettings
              key={`${selectedNote.id}:${String(undoCount)}`}
              note={selectedNote}
              onChange={(next) => {
                change((current) => updateNote(current, next), `note:${next.id}`);
              }}
            />
          ) : selectedGroup !== undefined ? (
            <GroupSettings
              key={`${selectedGroup.id}:${String(undoCount)}`}
              group={selectedGroup}
              onChange={(next) => {
                change((current) => updateGroup(current, next), `group:${next.id}`);
              }}
              onUngroup={() => {
                change((current) => ungroup(current, selectedGroup.id));
                setSelected(new Set(selectedGroup.blocks));
              }}
            />
          ) : selectedBlock === undefined ? (
            <>
              <p className="field-hint">{t('canvas.pickBlock')}</p>
              {automation === undefined ? null : (
                <>
                  <h2>{t('automation.fromCommandLine')}</h2>
                  <code className="automation-command" data-testid="automation-command">
                    {commandFor(automation.id)}
                  </code>
                </>
              )}
            </>
          ) : (
            <PanelSectionsContext value={sections}>
              <BlockSettings
                key={`${selectedBlock.id}:${String(undoCount)}`}
                block={selectedBlock}
                blocks={document.blocks}
                connections={document.connections}
                tab={blockTab}
                onTab={setBlockTab}
                tools={tools}
                names={names}
                context={valueContext}
                problems={checked.filter(({ blockId }) => blockId === selectedBlock.id)}
                onChange={(block, renamed) => {
                  change(
                    (current) => updateBlock(current, block, renamed),
                    renamed === undefined ? `block:${block.id}` : undefined,
                  );
                }}
                onRename={() => {
                  setRenaming(selectedBlock.id);
                }}
                menu={blockCardMenu(selectedBlock, canvasCommands, {
                  rename: () => {
                    setRenaming(selectedBlock.id);
                  },
                  showOnCanvas: () => {
                    const id = selectedBlock.id;
                    setReveal((current) => ({
                      id,
                      count: (current?.count ?? 0) + 1,
                      center: true,
                    }));
                  },
                  copyId: () => {
                    void navigator.clipboard.writeText(selectedBlock.id).catch(onError);
                  },
                  openTool:
                    selectedBlock.type === 'run' &&
                    tools.some(({ id }) => id === selectedBlock.tool)
                      ? () => {
                          onShowTool(selectedBlock.tool);
                        }
                      : undefined,
                })}
                onDone={() => {
                  const id = selectedBlock.id;
                  setFocusRequest((current) => ({ id, count: (current?.count ?? 0) + 1 }));
                }}
                onGoTo={pick}
                onError={onError}
              />
            </PanelSectionsContext>
          )}
        </aside>
      </div>
      {lowerCollapsed ? null : (
        <PanelResizer
          value={lowerHeight}
          {...AUTOMATION_PANEL_SIZES.lowerHeight}
          initial={AUTOMATION_PANEL_SIZES.lowerHeight.default}
          orientation="horizontal"
          invert
          label={t('canvas.resizeLower')}
          onResize={(size) => {
            changePanels({ lowerHeight: size }, false);
          }}
          onCommit={(size) => {
            changePanels({ lowerHeight: size });
          }}
        />
      )}
      <div
        className={`flow-lower${lowerCollapsed ? ' is-collapsed' : ''}`}
        style={lowerCollapsed ? undefined : { height: lowerHeight }}
      >
        <div className="flow-lower-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={lower === 'problems'}
            onClick={() => {
              showLower('problems');
            }}
          >
            {t('canvas.problems', { count: named ? checked.length : checked.length + 1 })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lower === 'runs'}
            onClick={() => {
              showLower('runs');
            }}
          >
            {t('automation.pastRuns')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lower === 'outline'}
            onClick={() => {
              showLower('outline');
            }}
          >
            {t('canvas.outline')}
          </button>
          {runOnView === undefined ? null : (
            <button
              type="button"
              role="tab"
              aria-selected={lower === 'output'}
              onClick={() => {
                showLower('output');
              }}
            >
              {t('canvas.output')}
            </button>
          )}
          {runOnView === undefined ? null : (
            <button
              type="button"
              role="tab"
              aria-selected={lower === 'data'}
              onClick={() => {
                showLower('data');
              }}
            >
              {t('canvas.data')}
            </button>
          )}
          <button
            type="button"
            className="icon-button panel-collapse"
            aria-label={t(lowerCollapsed ? 'canvas.showLower' : 'canvas.hideLower')}
            title={t(lowerCollapsed ? 'canvas.showLower' : 'canvas.hideLower')}
            aria-expanded={!lowerCollapsed}
            onClick={() => {
              changePanels({ lowerCollapsed: !lowerCollapsed });
            }}
          >
            {lowerCollapsed ? (
              <ChevronUp className="icon" aria-hidden="true" />
            ) : (
              <ChevronDown className="icon" aria-hidden="true" />
            )}
          </button>
        </div>
        <div className="flow-lower-body" role="tabpanel" hidden={lowerCollapsed}>
          {lower === 'data' && runOnView !== undefined ? (
            <DataView step={runOnView.steps.find(({ id }) => id === only)} />
          ) : lower === 'output' && runOnView !== undefined ? (
            <BlockOutput
              block={selectedBlock}
              step={runOnView.steps.find(({ id }) => id === only)}
              onError={onError}
            />
          ) : lower === 'outline' ? (
            <Outline
              document={document}
              names={names}
              onPick={(id) => {
                setSelected(new Set([id]));
                setFocusRequest((current) => ({ id, count: (current?.count ?? 0) + 1 }));
              }}
            />
          ) : lower === 'problems' ? (
            named ? (
              <Problems
                problems={checked}
                refusal={refusal === undefined ? undefined : refusalText(refusal)}
                nameOf={nameOf}
                onPick={pick}
              />
            ) : refusal?.kind === 'unnamed' ? (
              <p className="field-problem" role="alert" data-testid="run-refused">
                {refusalText(refusal)}
              </p>
            ) : (
              <p className="field-problem">{t('canvas.nameFirst')}</p>
            )
          ) : (
            <PastRuns
              runs={past}
              shown={view.kind === 'past' ? view.record.runId : undefined}
              onOpen={(record) => {
                setView({ kind: 'past', record });
                setSelected(new Set());
                setRefusal(undefined);
              }}
              onOpenOutput={(record) => {
                setView({ kind: 'past', record });
                showLower('output');
              }}
              onOpenInHistory={(runId) => {
                if (automation !== undefined) onOpenInHistory(automation.id, runId);
              }}
            />
          )}
        </div>
      </div>
      {asking === undefined ? null : (
        <RunInputsDialog
          name={document.name}
          inputs={inputsOfFlow(document.blocks)}
          onRun={(values) => {
            const id = asking;
            setAsking(undefined);
            void start(id, values);
          }}
          onClose={() => {
            setAsking(undefined);
          }}
          onError={onError}
        />
      )}
      {renaming === undefined || blockOf(document, renaming) === undefined ? null : (
        <RenameDialog
          current={renaming}
          problemOf={(next) => blockIdProblem(document, renaming, next)}
          onRename={(next) => {
            change((current) => renameBlock(current, renaming, next));
            setSelected(new Set([next]));
          }}
          onClose={() => {
            setRenaming(undefined);
          }}
        />
      )}
    </section>
  );
}

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Hand,
  Play,
  Redo2,
  Save,
  Square,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
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
import { ProgramIcon } from '../shell/ProgramIcon.js';
import { BlockLibrary, controlIcon } from './canvas/BlockLibrary.js';
import { BlockSettings } from './canvas/BlockSettings.js';
import { blockNames, kindLabel } from './canvas/block-text.js';
import { Canvas } from './canvas/Canvas.js';
import type { CanvasRun } from './canvas/Canvas.js';
import type { CanvasCommands, EditorCommands } from './canvas/canvas-commands.js';
import {
  GAP_X,
  addAfter,
  addBlocks,
  createBlocks,
  documentOf,
  draftOf,
  addNote,
  groupBlocks,
  sizeOf,
  spliceInto,
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
import { referenceOptionsFor } from './canvas/references.js';
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
}

function PastRuns({ runs, shown, onOpen, onOpenOutput }: PastRunsProps) {
  if (runs.length === 0) {
    return <p className="muted">{t('automation.noRuns')}</p>;
  }
  return (
    <ul className="automation-runs" data-testid="automation-runs">
      {runs.map((run) => (
        <li key={run.runId}>
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
        </li>
      ))}
    </ul>
  );
}

interface ProblemsProps {
  readonly problems: readonly AutomationProblemView[];
  readonly nameOf: (id: string) => string;
  readonly onPick: (blockId: string) => void;
}

function Problems({ problems, nameOf, onPick }: ProblemsProps) {
  if (problems.length === 0) {
    return <p className="muted">{t('canvas.noProblems')}</p>;
  }
  return (
    <ul className="problem-list" data-testid="automation-problems">
      {problems.map((problem, index) => {
        const { what, fix } = problemText(problem, nameOf);
        return (
          <li key={`${problem.code}-${String(index)}`}>
            <button
              type="button"
              className="problem-item"
              data-testid="automation-problem"
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
      <h2>{kindLabel(block.type)}</h2>
      <p>{name}</p>
      <RunStateBadge state={state} />
      {state === 'skipped' ? <p className="muted">{t('automation.skipped')}</p> : null}
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

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what a handler throws with the name of the channel.
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
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
  readonly onRun: (id: string) => Promise<unknown>;
  readonly onShowTool: (id: string) => void;
  readonly onDirty: (dirty: boolean) => void;
  readonly onUsed: () => void;
  readonly onError: (error: unknown) => void;
  /** Changes each time the sidebar asks to rename the automation: its name field is selected. */
  readonly renameRequest?: number | undefined;
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
  onDirty,
  onUsed,
  onError,
  onCommands,
  renameRequest,
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
  const [lower, setLower] = useState<'problems' | 'runs' | 'outline' | 'output'>('problems');
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
  useEffect(() => {
    if (!needsPlacing) return undefined;
    return placeBlocks();
  }, [needsPlacing]);

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

  const names = useMemo(() => blockNames(document.blocks, tools), [document.blocks, tools]);
  const nameOf = useCallback((id: string) => names.get(id) ?? id, [names]);
  const problemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { blockId } of checked) {
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
    const blocks = createBlocks(document, choice, t('automation.defaultMessage'), anchor);
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
        icon: <ProgramIcon tool={tool} />,
        ...(tool.category === undefined ? {} : { group: tool.category }),
      })),
      ...(['wait-for-time', 'wait-for-manual-action', 'if', 'switch', 'parallel'] as const).map(
        (kind) => {
          const Icon = controlIcon(kind);
          return {
            choice: { kind },
            label: kindLabel(kind),
            ...(Icon === undefined ? {} : { icon: <Icon className="icon" aria-hidden="true" /> }),
          };
        },
      ),
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
      problems = stored.problems;
      if (automation === undefined) {
        // The tab reopens under the new id, so the refusal is handed to it.
        if (problems.length > 0) refusalsForNewTabs.set(id, refusalOf(problems));
        onSaved(id);
      } else if (problems.length > 0) {
        refuse(refusalOf(problems));
      }
    } else {
      id = automation.id;
      problems = await api.checkAutomation(draft);
      setChecked(problems);
      if (problems.length > 0) refuse(refusalOf(problems));
    }
    if (problems.length > 0) return;
    await onRun(id).catch((error: unknown) => {
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
  if (lower === 'output' && runOnView === undefined) setLower('problems');

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
      {refusal === undefined ? null : (
        <div className="notice notice-failed flow-refused" role="alert" data-testid="run-refused">
          <TriangleAlert className="icon" aria-hidden="true" />
          <p>{refusalText(refusal)}</p>
          <button
            type="button"
            className="icon-button"
            aria-label={t('banner.dismiss')}
            onClick={() => {
              setRefusal(undefined);
            }}
          >
            <X className="icon" aria-hidden="true" />
          </button>
        </div>
      )}
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
          onAddAfter={(anchor, choice) => add(choice, undefined, anchor)}
          {...(focusRequest === undefined ? {} : { focusRequest })}
          options={canvasOptions}
          onOptions={onCanvasOptions}
          editor={editor}
          onCommands={onCommands}
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
            <BlockSettings
              key={`${selectedBlock.id}:${String(undoCount)}`}
              block={selectedBlock}
              blocks={document.blocks}
              tools={tools}
              names={names}
              references={referenceOptionsFor(document, selectedBlock.id, tools, nameOf)}
              onChange={(block, renamed) => {
                change(
                  (current) => updateBlock(current, block, renamed),
                  renamed === undefined ? `block:${block.id}` : undefined,
                );
              }}
              onError={onError}
            />
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
          {lower === 'output' && runOnView !== undefined ? (
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
              <Problems problems={checked} nameOf={nameOf} onPick={pick} />
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
            />
          )}
        </div>
      </div>
    </section>
  );
}

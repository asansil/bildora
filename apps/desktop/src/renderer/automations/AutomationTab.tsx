import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArrowLeft,
  Hand,
  LayoutGrid,
  Play,
  Redo2,
  Save,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { AutomationBlock, AutomationPosition } from '@bildora/protocol';
import { t } from '../../shared/i18n/translate.js';
import type {
  AutomationDraft,
  AutomationProblemView,
  AutomationRunRecordView,
  AutomationRunStateView,
  AutomationView,
  StepRunView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { formatDuration, formatTime, historyState } from '../history/history-format.js';
import { Dialog } from '../shell/Dialog.js';
import { RunStateBadge } from '../shell/RunStateBadge.js';
import { commandFor } from './automation-draft.js';
import { BlockLibrary } from './canvas/BlockLibrary.js';
import { BlockSettings } from './canvas/BlockSettings.js';
import { blockNames, kindLabel } from './canvas/block-text.js';
import { Canvas } from './canvas/Canvas.js';
import type { CanvasRun } from './canvas/Canvas.js';
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
import { layoutBlocks, placeMissing } from './canvas/layout.js';
import type { FlowDocument, NewBlock } from './canvas/flow-document.js';
import { referenceOptionsFor } from './canvas/references.js';
import { problemText } from './problem-text.js';

const api = window.bildora;

/** How long editing has to pause before the flow is checked. */
const CHECK_DELAY_MS = 200;

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
}

function PastRuns({ runs, shown, onOpen }: PastRunsProps) {
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

interface AutomationTabProps {
  /** Absent for a new automation, which has no file yet. */
  readonly automation: AutomationView | undefined;
  readonly run: AutomationRunStateView | undefined;
  readonly tools: readonly ToolView[];
  /** Category logos by tool id. */
  readonly logos: ReadonlyMap<string, string>;
  /** False while another tab is shown. */
  readonly active: boolean;
  /** Changes when a past run may have appeared, such as one from the CLI. */
  readonly revision: unknown;
  readonly onSave: (draft: AutomationDraft) => Promise<AutomationView>;
  /** A new automation was saved, and its tab now shows it. */
  readonly onSaved: (id: string) => void;
  readonly onRun: () => void;
  readonly onRemove: () => void;
  readonly onShowTool: (id: string) => void;
  readonly onDirty: (dirty: boolean) => void;
  readonly onUsed: () => void;
  readonly onError: (error: unknown) => void;
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
  logos,
  active,
  revision,
  onSave,
  onSaved,
  onRun,
  onRemove,
  onShowTool,
  onDirty,
  onUsed,
  onError,
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
  const [lower, setLower] = useState<'problems' | 'runs' | 'outline'>('problems');
  const [reveal, setReveal] = useState<{ id: string; count: number; center?: boolean } | undefined>(
    undefined,
  );
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | undefined>(undefined);

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

  const select = useCallback((ids: ReadonlySet<string>) => {
    setSelected(ids);
  }, []);

  const [only] = selected.size === 1 ? [...selected] : [];
  const selectedBlock = document.blocks.find(({ id }) => id === only);
  const selectedNote = document.notes.find(({ id }) => id === only);
  const selectedGroup = document.groups.find(({ id }) => id === only);
  const selectedBlocks = document.blocks.filter(({ id }) => selected.has(id));

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

  /** A note goes under the selected block, or under Start. */
  function note(): void {
    const below = [only, 'start'].find((id) => id !== undefined && document.positions[id]);
    const at = below === undefined ? undefined : document.positions[below];
    const block = below === undefined ? undefined : document.blocks.find(({ id }) => id === below);
    const spot = {
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
  function add(choice: NewBlock, at?: AutomationPosition, after?: string): string | undefined {
    const anchor = [after, only, lastAdded, 'start'].find(
      (id) => id !== undefined && document.positions[id] !== undefined,
    );
    const blocks = createBlocks(document, choice, t('automation.defaultMessage'), anchor);
    const [first] = blocks;
    if (first === undefined) return undefined;
    let next: FlowDocument;
    if (at !== undefined) {
      next = addBlocks(document, blocks, at);
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
      })),
      ...(['wait-for-time', 'wait-for-manual-action', 'if', 'switch', 'parallel'] as const).map(
        (kind) => ({ choice: { kind }, label: kindLabel(kind) }),
      ),
    ],
    [tools],
  );
  const [focusRequest, setFocusRequest] = useState<{ id: string; count: number } | undefined>(
    undefined,
  );

  function save(): void {
    setSaving(true);
    void onSave(draft)
      .then((view) => {
        const next = documentOf(view);
        setSaved(next);
        setDocument(next);
        if (automation === undefined) onSaved(view.id);
      })
      .catch(onError)
      .finally(() => {
        setSaving(false);
      });
  }

  function pick(blockId: string): void {
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
  const runReason = dirty
    ? t('canvas.runUnsaved')
    : checked.length > 0
      ? t('canvas.runProblems')
      : undefined;

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
          {view.kind === 'edit' ? (
            <button
              type="button"
              title={t('canvas.tidyHint')}
              onClick={() => {
                void layoutBlocks(document.blocks, document.connections)
                  .then((positions) => {
                    change((current) => ({ ...current, positions }));
                  })
                  .catch(onError);
              }}
            >
              <LayoutGrid className="icon" aria-hidden="true" />
              {t('canvas.tidy')}
            </button>
          ) : null}
          <button
            type="button"
            className={dirty ? 'primary' : ''}
            disabled={!dirty || !named || saving}
            title={named ? undefined : t('canvas.nameFirst')}
            onClick={save}
          >
            <Save className="icon" aria-hidden="true" />
            {t('canvas.save')}
          </button>
          {running ? (
            <button
              type="button"
              onClick={() => {
                void api.cancelAutomation(run.runId).catch(onError);
              }}
            >
              <Square className="icon" aria-hidden="true" />
              {t('automation.stop')}
            </button>
          ) : (
            <button
              type="button"
              className={dirty ? '' : 'primary'}
              disabled={automation === undefined || runReason !== undefined}
              title={runReason}
              onClick={() => {
                onUsed();
                onRun();
              }}
            >
              <Play className="icon" aria-hidden="true" />
              {t('automation.run')}
            </button>
          )}
          {automation === undefined ? null : (
            <button
              type="button"
              disabled={running}
              onClick={() => {
                setRemoving(true);
              }}
            >
              <Trash2 className="icon" aria-hidden="true" />
              {t('automation.remove')}
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
      <div className={`flow-body${runOnView === undefined ? '' : ' is-run'}`}>
        {runOnView === undefined ? (
          <BlockLibrary
            tools={tools}
            logos={logos}
            onAdd={(choice) => {
              add(choice);
            }}
            onAddNote={note}
          />
        ) : null}
        <Canvas
          document={document}
          names={names}
          logos={logos}
          problemCounts={problemCounts}
          selected={selected}
          active={active}
          {...(runOnView === undefined ? {} : { run: runOnView })}
          {...(reveal === undefined ? {} : { reveal })}
          onChange={change}
          onSelect={select}
          onDrop={(choice, at) => {
            add(choice, at);
          }}
          library={library}
          onAddAfter={(anchor, choice) => add(choice, undefined, anchor)}
          {...(focusRequest === undefined ? {} : { focusRequest })}
        />
        <aside className="flow-side flow-settings" aria-label={t('canvas.settings')}>
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
      <div className="flow-lower">
        <div className="flow-lower-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={lower === 'problems'}
            onClick={() => {
              setLower('problems');
            }}
          >
            {t('canvas.problems', { count: named ? checked.length : checked.length + 1 })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lower === 'runs'}
            onClick={() => {
              setLower('runs');
            }}
          >
            {t('automation.pastRuns')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lower === 'outline'}
            onClick={() => {
              setLower('outline');
            }}
          >
            {t('canvas.outline')}
          </button>
        </div>
        <div className="flow-lower-body" role="tabpanel">
          {lower === 'outline' ? (
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
              }}
            />
          )}
        </div>
      </div>
      {removing && automation !== undefined ? (
        <Dialog
          title={t('automation.removeTitle', { name: automation.name })}
          onClose={() => {
            setRemoving(false);
          }}
        >
          <p>{t('automation.removeBody')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setRemoving(false);
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setRemoving(false);
                onRemove();
              }}
            >
              {t('automation.removeConfirm')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Pencil, Play, Square, Trash2, TriangleAlert } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type {
  AutomationDraft,
  AutomationRunRecordView,
  AutomationRunStateView,
  AutomationStep,
  AutomationView,
  StepRunView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { formatDuration, formatTime, historyState } from '../history/history-format.js';
import { Dialog } from '../shell/Dialog.js';
import { RunStateBadge, RunStateIcon } from '../shell/RunStateBadge.js';
import { AutomationEditor } from './AutomationEditor.js';
import { commandFor, stepLabel } from './automation-draft.js';

const api = window.bildora;

/** A run that went on past a failed step finished, but saying only that would hide the failure. */
function finishedLabel(status: string, steps: readonly StepRunView[]): { readonly label?: string } {
  const count = steps.filter(({ state }) => state === 'failed').length;
  return status === 'completed' && count > 0
    ? { label: t('automation.completedWithFailures', { count }) }
    : {};
}

interface StepRowProps {
  readonly step: AutomationStep;
  readonly state: StepRunView | undefined;
  readonly tools: readonly ToolView[];
  readonly problems: readonly string[];
  readonly onContinue: () => void;
  readonly onShowTool: (id: string) => void;
}

function stepDetail(state: StepRunView | undefined): string | undefined {
  if (state === undefined) {
    return undefined;
  }
  if (state.failure !== undefined) {
    return state.failure.message;
  }
  if (state.resumesAt !== undefined) {
    return t('automation.resumesAt', { time: new Date(state.resumesAt).toLocaleTimeString('en') });
  }
  if (state.state === 'running' && state.attempt !== undefined && state.attempt > 1) {
    return t('automation.attempt', { number: state.attempt });
  }
  return state.progress?.message;
}

function StepRow({ step, state, tools, problems, onContinue, onShowTool }: StepRowProps) {
  const detail = stepDetail(state);
  const percent = state?.state === 'running' ? state.progress?.percent : undefined;
  const waitingForUser = state?.state === 'running' && state.message !== undefined;
  const hasTool = step.type === 'run' && tools.some(({ id }) => id === step.tool);
  return (
    <li
      className="automation-step"
      data-testid="automation-step"
      data-step-id={step.id}
      data-state={state?.state ?? 'idle'}
    >
      <RunStateIcon state={state?.state ?? 'idle'} />
      <div className="automation-step-text">
        <span className="truncate" title={stepLabel(step, tools)}>
          {stepLabel(step, tools)}
        </span>
        {waitingForUser ? <span className="muted">{t('automation.waitingForYou')}</span> : null}
        {detail === undefined ? null : <span className="muted">{detail}</span>}
        {percent === undefined ? null : <progress value={percent} max={100} />}
        {problems.map((problem) => (
          <span key={problem} className="field-problem" data-testid="step-broken">
            {problem}
          </span>
        ))}
      </div>
      {waitingForUser ? (
        <button type="button" className="primary" onClick={onContinue}>
          {t('automation.continue')}
        </button>
      ) : null}
      {step.type === 'run' && hasTool && state?.toolRunId !== undefined ? (
        <button
          type="button"
          onClick={() => {
            onShowTool(step.tool);
          }}
        >
          {t('automation.openTool')}
        </button>
      ) : null}
      {state?.durationMs === undefined ? null : (
        <span className="row-count">{formatDuration(state.durationMs)}</span>
      )}
    </li>
  );
}

interface PastRunsProps {
  readonly runs: readonly AutomationRunRecordView[];
}

function PastRuns({ runs }: PastRunsProps) {
  if (runs.length === 0) {
    return <p className="muted">{t('automation.noRuns')}</p>;
  }
  return (
    <ul className="automation-runs" data-testid="automation-runs">
      {runs.map((run) => (
        <li key={run.runId} className="automation-run">
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
            <span className="muted automation-run-failure">
              {run.failure.stepId}: {run.failure.message}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface AutomationDetailProps {
  readonly automation: AutomationView;
  readonly run: AutomationRunStateView | undefined;
  readonly tools: readonly ToolView[];
  /** Changes when a past run may have appeared, such as one from the CLI. */
  readonly revision: unknown;
  readonly onRun: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onShowTool: (id: string) => void;
  readonly onError: (error: unknown) => void;
}

function AutomationDetail({
  automation,
  run,
  tools,
  revision,
  onRun,
  onEdit,
  onRemove,
  onShowTool,
  onError,
}: AutomationDetailProps) {
  const [past, setPast] = useState<readonly AutomationRunRecordView[]>([]);
  const running = run?.status === 'running';
  const status = run?.status;

  useEffect(() => {
    let current = true;
    void api
      .automationHistory(automation.id)
      .then((list) => {
        if (current) {
          setPast(list);
        }
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [automation.id, status, revision, onError]);

  return (
    <section className="history-detail" data-testid="automation-detail">
      <header className="tool-header">
        <h1 title={automation.name}>{automation.name}</h1>
        <RunStateBadge
          state={status ?? 'idle'}
          {...(run === undefined ? {} : finishedLabel(run.status, run.steps))}
        />
      </header>
      {automation.description === undefined ? null : (
        <p className="tool-description">{automation.description}</p>
      )}
      {automation.problems.length === 0 ? null : (
        <div className="notice notice-warning" role="status" data-testid="automation-broken">
          <TriangleAlert className="icon" aria-hidden="true" />
          <p>{t('automation.broken')}</p>
        </div>
      )}
      <div className="actions">
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
            className="primary"
            disabled={automation.problems.length > 0}
            onClick={onRun}
          >
            <Play className="icon" aria-hidden="true" />
            {t('automation.run')}
          </button>
        )}
        <button type="button" onClick={onEdit}>
          <Pencil className="icon" aria-hidden="true" />
          {t('automation.edit')}
        </button>
        <button type="button" disabled={running} onClick={onRemove}>
          <Trash2 className="icon" aria-hidden="true" />
          {t('automation.remove')}
        </button>
      </div>
      <h2>{t('automation.steps')}</h2>
      <ol className="automation-steps">
        {automation.steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            state={run?.steps.find(({ id }) => id === step.id)}
            tools={tools}
            problems={automation.problems
              .filter(({ stepId }) => stepId === step.id)
              .map(({ message }) => message)}
            onContinue={() => {
              if (run !== undefined) {
                void api.confirmAutomation(run.runId).catch(onError);
              }
            }}
            onShowTool={onShowTool}
          />
        ))}
      </ol>
      <h2>{t('automation.fromCommandLine')}</h2>
      <code className="automation-command" data-testid="automation-command">
        {commandFor(automation.id)}
      </code>
      <h2>{t('automation.pastRuns')}</h2>
      <PastRuns runs={past} />
    </section>
  );
}

interface AutomationTabProps {
  /** Absent for a new automation, which opens in the editor and has no tab of its own yet. */
  readonly automation: AutomationView | undefined;
  readonly run: AutomationRunStateView | undefined;
  readonly tools: readonly ToolView[];
  /** Changes when a past run may have appeared, such as one from the CLI. */
  readonly revision: unknown;
  readonly onSave: (draft: AutomationDraft) => Promise<AutomationView>;
  /** A new automation was saved, and its tab now shows it. */
  readonly onSaved: (id: string) => void;
  /** Cancel on a new automation, which leaves nothing to show. */
  readonly onDiscard: () => void;
  readonly onRun: () => void;
  readonly onRemove: () => void;
  readonly onShowTool: (id: string) => void;
  readonly onDirty: (dirty: boolean) => void;
  readonly onUsed: () => void;
  readonly onError: (error: unknown) => void;
}

/** One automation in its tab: its steps, state and past runs, or the editor that changes it. */
export function AutomationTab({
  automation,
  run,
  tools,
  revision,
  onSave,
  onSaved,
  onDiscard,
  onRun,
  onRemove,
  onShowTool,
  onDirty,
  onUsed,
  onError,
}: AutomationTabProps) {
  const [editing, setEditing] = useState(automation === undefined);
  const [removing, setRemoving] = useState(false);

  function save(draft: AutomationDraft): void {
    void onSave(draft)
      .then(({ id }) => {
        setEditing(false);
        if (automation === undefined) {
          onSaved(id);
        }
      })
      .catch(onError);
  }

  return (
    <section className="automation-tab" data-testid="automations">
      {editing || automation === undefined ? (
        <AutomationEditor
          automation={automation}
          tools={tools}
          onSave={save}
          onClose={() => {
            if (automation === undefined) {
              onDiscard();
            } else {
              setEditing(false);
            }
          }}
          onError={onError}
          onDirty={onDirty}
          onUsed={onUsed}
        />
      ) : (
        <AutomationDetail
          automation={automation}
          run={run}
          tools={tools}
          revision={revision}
          onRun={() => {
            onUsed();
            onRun();
          }}
          onEdit={() => {
            onUsed();
            setEditing(true);
          }}
          onRemove={() => {
            setRemoving(true);
          }}
          onShowTool={onShowTool}
          onError={onError}
        />
      )}
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

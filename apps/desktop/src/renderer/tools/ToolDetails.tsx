import { Play, RefreshCw, Square, Star, TriangleAlert } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { RunView, ToolRuntime, ToolView } from '../../shared/ipc-contract.js';
import { RunStateBadge } from '../shell/RunStateBadge.js';
import { summarizeRuns } from './run-state.js';

export function failureText(run: RunView, tool: ToolView): string | undefined {
  const { failure, exitCode } = run;
  if (failure === undefined) {
    return undefined;
  }
  switch (failure.kind) {
    case 'exit-code':
      // The default policy on Windows refuses every script, and the console closes too fast to say.
      return t(
        /^(?:powershell|pwsh)$/i.test(tool.interpreter ?? '')
          ? 'failure.powershell'
          : 'failure.exitCode',
        {
          code: exitCode ?? 1,
        },
      );
    case 'program-not-found':
      return t('failure.programNotFound');
    case 'interpreter-not-found':
      return t('failure.interpreterNotFound');
    default:
      return t('failure.other', { message: failure.message });
  }
}

function resultText(run: RunView | undefined): string {
  if (run === undefined) {
    return t('tool.neverRun');
  }
  if (run.exitCode === undefined) {
    return t(`state.${run.status}`);
  }
  return t('tool.exitCode', { code: run.exitCode });
}

interface FavoriteButtonProps {
  readonly tool: ToolView;
  readonly favorite: boolean;
  readonly onToggle: () => void;
}

/** Marks a tool in this Workspace. Filled or hollow, so that it never relies on color. */
export function FavoriteButton({ tool, favorite, onToggle }: FavoriteButtonProps) {
  const label = t(favorite ? 'tool.unfavorite' : 'tool.favorite', { name: tool.name });
  return (
    <button
      type="button"
      className="icon-button favorite-button"
      aria-pressed={favorite}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <Star className="icon" aria-hidden="true" />
    </button>
  );
}

function runtimeText(runtime: Exclude<ToolRuntime, { status: 'ready' }>): {
  title: string;
  body: string;
} {
  switch (runtime.status) {
    case 'missing-variable':
      return {
        title: t('runtime.variableTitle', { variable: runtime.variable }),
        body: t('runtime.variableBody', { variable: runtime.variable }),
      };
    case 'missing-interpreter':
      return {
        title: t('runtime.interpreterTitle', { interpreter: runtime.interpreter }),
        body: t('runtime.interpreterBody', { interpreter: runtime.interpreter }),
      };
    case 'missing-program':
      return {
        title: t('runtime.programTitle'),
        body: t('runtime.programBody', { program: runtime.program }),
      };
  }
}

interface RuntimeWarningProps {
  readonly runtime: Exclude<ToolRuntime, { status: 'ready' }>;
  readonly onCheckAgain: () => void;
}

export function RuntimeWarning({ runtime, onCheckAgain }: RuntimeWarningProps) {
  const { title, body } = runtimeText(runtime);
  return (
    <div className="notice notice-warning" role="status" data-testid="runtime-warning">
      <TriangleAlert className="icon" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <button type="button" onClick={onCheckAgain}>
        <RefreshCw className="icon" aria-hidden="true" />
        {t('runtime.checkAgain')}
      </button>
    </div>
  );
}

interface ToolDetailsProps {
  readonly tool: ToolView;
  readonly runs: readonly RunView[];
  readonly onLaunch: () => void;
  readonly onStop: (runId: string) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onMove: () => void;
  readonly onCheckAgain: () => void;
  readonly favorite: boolean;
  readonly onToggleFavorite: () => void;
}

/** A tool in the work area. A level 0 program opens in its own window, so this shows its state. */
export function ToolDetails({
  tool,
  runs,
  onLaunch,
  onStop,
  onEdit,
  onRemove,
  onMove,
  onCheckAgain,
  favorite,
  onToggleFavorite,
}: ToolDetailsProps) {
  const summary = summarizeRuns(runs, tool.key);
  const launchable = tool.level === 0 && tool.runtime.status === 'ready';
  const isRunning = summary.running.length > 0;
  const failure = summary.last === undefined ? undefined : failureText(summary.last, tool);

  return (
    <article className="tool" data-testid="tool-details">
      <header className="tool-header">
        <h1 title={tool.name}>{tool.name}</h1>
        <FavoriteButton tool={tool} favorite={favorite} onToggle={onToggleFavorite} />
        <RunStateBadge
          state={summary.state}
          {...(summary.running.length > 1
            ? { label: t('tool.instances', { count: summary.running.length }) }
            : {})}
        />
      </header>
      {tool.program === undefined ? null : (
        <code className="path" title={tool.program}>
          {tool.program}
        </code>
      )}
      {tool.description === undefined ? null : (
        <p className="tool-description">{tool.description}</p>
      )}

      <div className="actions">
        <button type="button" className="primary" disabled={!launchable} onClick={onLaunch}>
          <Play className="icon" aria-hidden="true" />
          {t('tool.launch')}
        </button>
        <button
          type="button"
          disabled={!isRunning}
          onClick={() => {
            for (const run of summary.running) {
              onStop(run.runId);
            }
          }}
        >
          <Square className="icon" aria-hidden="true" />
          {t('tool.stop')}
        </button>
        <button type="button" onClick={onEdit}>
          {t('tool.edit')}
        </button>
        <button type="button" disabled={isRunning} onClick={onMove}>
          {t(tool.scope === 'global' ? 'tool.moveToWorkspace' : 'tool.moveToGlobal')}
        </button>
        <button type="button" disabled={isRunning} onClick={onRemove}>
          {t('tool.remove')}
        </button>
      </div>

      {tool.runtime.status === 'ready' ? null : (
        <RuntimeWarning runtime={tool.runtime} onCheckAgain={onCheckAgain} />
      )}
      {tool.level === 0 ? null : (
        <div className="notice" role="status">
          <p>{t('tool.laterVersion')}</p>
        </div>
      )}
      {failure === undefined ? null : (
        <div className="notice notice-failed" role="status" data-testid="run-failure">
          <p>{failure}</p>
        </div>
      )}

      <dl className="facts">
        <dt>{t('tool.scope')}</dt>
        <dd>{t(tool.scope === 'global' ? 'tool.scopeGlobal' : 'tool.scopeWorkspace')}</dd>
        <dt>{t('tool.category')}</dt>
        <dd>{tool.category ?? t('nav.uncategorized')}</dd>
        <dt>{t('tool.interpreter')}</dt>
        <dd>{tool.interpreter ?? t('tool.none')}</dd>
        <dt>{t('tool.lastResult')}</dt>
        <dd data-testid="last-result">{resultText(summary.last)}</dd>
      </dl>
    </article>
  );
}

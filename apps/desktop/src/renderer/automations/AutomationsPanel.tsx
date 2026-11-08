import { Plus, TriangleAlert } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { AutomationListView, AutomationRunStateView } from '../../shared/ipc-contract.js';
import { RunStateIcon, runStateLabel } from '../shell/RunStateBadge.js';

interface AutomationsPanelProps {
  readonly id: string;
  readonly list: AutomationListView;
  readonly runs: readonly AutomationRunStateView[];
  readonly workspaceId: string;
  readonly width: number;
  /** The automation in the active tab, if it shows one. */
  readonly current: string | undefined;
  /** A single click asks for the preview tab, and a double click for a pinned one. */
  readonly onOpen: (id: string, pin: boolean) => void;
  readonly onNew: () => void;
}

/** The Workspace's automations, opened from the rail like a category. */
export function AutomationsPanel({
  id,
  list,
  runs,
  workspaceId,
  width,
  current,
  onOpen,
  onNew,
}: AutomationsPanelProps) {
  const stateOf = (automationId: string) =>
    runs.find((run) => run.workspaceId === workspaceId && run.automationId === automationId)
      ?.status ?? 'idle';

  return (
    <aside
      className="context-panel"
      id={id}
      aria-label={t('nav.automations')}
      data-testid="automations-panel"
      style={{ width }}
    >
      <h2>
        <span className="truncate">{t('automation.title')}</span>
        <span className="row-count">{list.automations.length}</span>
      </h2>
      <ul className="nav-list">
        <li>
          <button type="button" className="row" onClick={onNew}>
            <Plus className="icon" aria-hidden="true" />
            <span className="truncate">{t('automation.new')}</span>
          </button>
        </li>
      </ul>
      {list.automations.length === 0 ? (
        <p className="muted panel-hint">{t('automation.empty')}</p>
      ) : null}
      <ul className="nav-list">
        {list.automations.map((item) => {
          const state = stateOf(item.id);
          const broken = item.problems.length > 0;
          // Said apart from the name, so a row is found by the automation's name alone.
          const notes = [
            ...(state === 'idle' ? [] : [runStateLabel(state)]),
            ...(broken ? [t('automation.broken')] : []),
          ];
          const noteId = `${id}-note-${item.id}`;
          return (
            <li key={item.id}>
              {notes.length === 0 ? null : (
                <span id={noteId} className="visually-hidden">
                  {notes.join('. ')}
                </span>
              )}
              <button
                type="button"
                className="row"
                title={item.name}
                aria-describedby={notes.length === 0 ? undefined : noteId}
                aria-current={item.id === current ? 'true' : undefined}
                onClick={() => {
                  onOpen(item.id, false);
                }}
                onDoubleClick={() => {
                  onOpen(item.id, true);
                }}
              >
                <RunStateIcon state={state} />
                <span className="truncate">{item.name}</span>
                {broken ? (
                  <TriangleAlert className="icon state-warning row-state" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {list.problems.length === 0 ? null : (
        <dl className="facts panel-hint" data-testid="automation-file-problems">
          {list.problems.map(({ file, message }) => (
            <div key={file}>
              <dt>{file}</dt>
              <dd>{message}</dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
  );
}

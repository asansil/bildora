import { useState } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { WorkspaceListView, WorkspaceView } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';
import { WorkspaceNameDialog } from './WorkspaceNameDialog.js';

interface WorkspacesViewProps {
  readonly list: WorkspaceListView;
  readonly onSwitch: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onClose: () => void;
}

type Pending =
  | { readonly kind: 'rename'; readonly workspace: WorkspaceView }
  | { readonly kind: 'remove'; readonly workspace: WorkspaceView };

/** A dialog where Workspaces are renamed and deleted, and where a damaged one is explained. */
export function WorkspacesView({
  list,
  onSwitch,
  onRename,
  onRemove,
  onClose,
}: WorkspacesViewProps) {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const { workspaces, activeId, problems } = list;
  const last = workspaces.length <= 1;

  function close(): void {
    setPending(undefined);
  }

  return (
    <Dialog title={t('workspace.manageTitle')} className="dialog-wide" onClose={onClose}>
      <div className="settings" data-testid="workspaces-view">
        <p className="muted">{t('workspace.manageBody')}</p>
        <ul className="workspace-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="workspace-row">
              <strong className="truncate" title={workspace.name}>
                {workspace.name}
              </strong>
              {workspace.id === activeId ? (
                <span className="muted">{t('workspace.active')}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onSwitch(workspace.id);
                  }}
                >
                  {t('workspace.open')}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setPending({ kind: 'rename', workspace });
                }}
              >
                {t('workspace.rename')}
              </button>
              <button
                type="button"
                disabled={last}
                title={last ? t('workspace.removeLast') : undefined}
                onClick={() => {
                  setPending({ kind: 'remove', workspace });
                }}
              >
                {t('workspace.remove')}
              </button>
            </li>
          ))}
        </ul>

        {problems.length === 0 ? null : (
          <>
            <h2>{t('workspace.problems')}</h2>
            <p className="muted">{t('workspace.problemsBody')}</p>
            <dl className="facts">
              {problems.map((problem) => (
                <div key={problem.folder}>
                  <dt>{problem.folder}</dt>
                  <dd>{problem.message}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>

      {pending?.kind === 'rename' ? (
        <WorkspaceNameDialog
          title={t('workspace.renameTitle', { name: pending.workspace.name })}
          confirm={t('workspace.renameConfirm')}
          initial={pending.workspace.name}
          onSubmit={(name) => {
            close();
            onRename(pending.workspace.id, name);
          }}
          onClose={close}
        />
      ) : null}
      {pending?.kind === 'remove' ? (
        <Dialog
          title={t('workspace.removeTitle', { name: pending.workspace.name })}
          onClose={close}
        >
          <p>{t('workspace.removeBody')}</p>
          <div className="dialog-actions">
            <button type="button" autoFocus onClick={close}>
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                close();
                onRemove(pending.workspace.id);
              }}
            >
              {t('workspace.remove')}
            </button>
          </div>
        </Dialog>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          {t('dialog.close')}
        </button>
      </div>
    </Dialog>
  );
}

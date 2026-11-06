import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import { Dialog } from '../shell/Dialog.js';

const NAME_MAX_LENGTH = 80;

interface WorkspaceNameDialogProps {
  readonly title: string;
  readonly confirm: string;
  readonly initial?: string;
  readonly onSubmit: (name: string) => void;
  readonly onClose: () => void;
}

/** Asks for a Workspace name, for creating one or renaming it. */
export function WorkspaceNameDialog({
  title,
  confirm,
  initial = '',
  onSubmit,
  onClose,
}: WorkspaceNameDialogProps) {
  const [name, setName] = useState(initial);
  const id = useId();

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (name.trim() !== '') {
      onSubmit(name);
    }
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={id}>
            {t('workspace.name')}
          </label>
          <input
            id={id}
            value={name}
            required
            autoFocus
            maxLength={NAME_MAX_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="primary" disabled={name.trim() === ''}>
            {confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../../shared/i18n/translate.js';
import { Dialog } from '../../shell/Dialog.js';
import type { BlockIdProblem } from './flow-document.js';

interface RenameDialogProps {
  /** The block's name now. */
  readonly current: string;
  /** The automations that read the block through a call, whose links the rename updates too. */
  readonly callers?: readonly string[];
  /** Why another name cannot name the block, or undefined when it can. */
  readonly problemOf: (next: string) => BlockIdProblem | undefined;
  readonly onRename: (next: string) => void;
  readonly onClose: () => void;
}

/**
 * Asks for a block's new name in links, in the middle of the window with the name selected. Enter
 * accepts, Escape cancels, and the dialog says why a name cannot be used.
 */
export function RenameDialog({
  current,
  callers = [],
  problemOf,
  onRename,
  onClose,
}: RenameDialogProps) {
  const [name, setName] = useState(current);
  const fieldId = useId();
  const problemId = useId();
  const problem = name === current ? undefined : problemOf(name);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (problem !== undefined) return;
    if (name !== current) onRename(name);
    onClose();
  }

  return (
    <Dialog title={t('canvas.renameTitle')} onClose={onClose}>
      <form className="form" data-testid="rename-dialog" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={fieldId}>
            {t('canvas.blockId')}
          </label>
          <input
            id={fieldId}
            value={name}
            autoFocus
            spellCheck={false}
            aria-invalid={problem !== undefined}
            aria-describedby={problemId}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <p id={problemId} className={problem === undefined ? 'field-hint' : 'field-problem'}>
            {problem === undefined
              ? t('canvas.blockIdHint', { id: name })
              : t(`canvas.blockIdProblem.${problem}`)}
          </p>
        </div>
        {callers.length === 0 ? null : (
          <p className="field-hint" data-testid="rename-callers">
            {t('canvas.renameCallers', { names: callers.join(', ') })}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="primary" disabled={problem !== undefined}>
            {t('form.ok')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

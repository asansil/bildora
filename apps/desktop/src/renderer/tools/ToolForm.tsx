import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { ToolDetailsInput } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';

interface ToolFormProps {
  readonly mode: 'add' | 'edit';
  /** Shown read-only: a tool's program is fixed once it is registered. */
  readonly program?: string | undefined;
  readonly initial: ToolDetailsInput;
  readonly onSubmit: (details: ToolDetailsInput) => void;
  readonly onClose: () => void;
}

/** Details of a tool, for registering a program or changing one that is registered. */
export function ToolForm({ mode, program, initial, onSubmit, onClose }: ToolFormProps) {
  const [name, setName] = useState(initial.name);
  const [category, setCategory] = useState(initial.category ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [interpreter, setInterpreter] = useState(initial.interpreter ?? '');
  const id = useId();

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    onSubmit({ name, category, description, interpreter });
  }

  return (
    <Dialog title={t(mode === 'add' ? 'form.addTitle' : 'form.editTitle')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {program === undefined ? null : (
          <div className="field">
            <span className="field-label">{t('form.program')}</span>
            <code className="path" title={program}>
              {program}
            </code>
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            {t('form.name')}
          </label>
          <input
            id={`${id}-name`}
            value={name}
            required
            autoFocus
            maxLength={200}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-category`}>
            {t('form.category')}
          </label>
          <input
            id={`${id}-category`}
            value={category}
            maxLength={200}
            aria-describedby={`${id}-category-hint`}
            onChange={(event) => {
              setCategory(event.target.value);
            }}
          />
          <span className="field-hint" id={`${id}-category-hint`}>
            {t('form.categoryHint')}
          </span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-description`}>
            {t('form.description')}
          </label>
          <input
            id={`${id}-description`}
            value={description}
            maxLength={1000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-interpreter`}>
            {t('form.interpreter')}
          </label>
          <input
            id={`${id}-interpreter`}
            value={interpreter}
            maxLength={200}
            spellCheck={false}
            aria-describedby={`${id}-interpreter-hint`}
            onChange={(event) => {
              setInterpreter(event.target.value);
            }}
          />
          <span className="field-hint" id={`${id}-interpreter-hint`}>
            {t('form.interpreterHint')}
          </span>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="primary">
            {t(mode === 'add' ? 'form.add' : 'form.save')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { ToolDetailsInput, ToolScopeChoice } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';
import { ScopeChoice } from './ScopeChoice.js';

interface ToolFormProps {
  readonly mode: 'add' | 'edit';
  /** Read-only when adding, and editable afterwards so it can point through a path variable. */
  readonly program?: string | undefined;
  /** Names the current Workspace in the scope choice, which only adding shows. */
  readonly workspaceName: string;
  readonly initial: ToolDetailsInput;
  readonly onSubmit: (details: ToolDetailsInput, scope: ToolScopeChoice) => void;
  readonly onClose: () => void;
}

/** Details of a tool, for registering a program or changing one that is registered. */
export function ToolForm({
  mode,
  program,
  workspaceName,
  initial,
  onSubmit,
  onClose,
}: ToolFormProps) {
  const [path, setPath] = useState(program ?? '');
  const [scope, setScope] = useState<ToolScopeChoice>('workspace');
  const [name, setName] = useState(initial.name);
  const [category, setCategory] = useState(initial.category ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [interpreter, setInterpreter] = useState(initial.interpreter ?? '');
  const id = useId();

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    const changed = mode === 'edit' && program !== undefined && path.trim() !== program;
    onSubmit(
      { name, category, description, interpreter, ...(changed ? { program: path.trim() } : {}) },
      scope,
    );
  }

  return (
    <Dialog title={t(mode === 'add' ? 'form.addTitle' : 'form.editTitle')} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {program === undefined || mode === 'edit' ? null : (
          <div className="field">
            <span className="field-label">{t('form.program')}</span>
            <code className="path" title={program}>
              {program}
            </code>
          </div>
        )}
        {program !== undefined && mode === 'edit' ? (
          <div className="field">
            <label className="field-label" htmlFor={`${id}-program`}>
              {t('form.program')}
            </label>
            <input
              id={`${id}-program`}
              value={path}
              required
              spellCheck={false}
              aria-describedby={`${id}-program-hint`}
              onChange={(event) => {
                setPath(event.target.value);
              }}
            />
            <span className="field-hint" id={`${id}-program-hint`}>
              {t('form.programHint', { example: '{{paths.tools}}\\run.exe' })}
            </span>
          </div>
        ) : null}
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
        {mode === 'add' ? (
          <ScopeChoice scope={scope} workspaceName={workspaceName} onChange={setScope} />
        ) : null}
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

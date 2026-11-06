import { useCallback, useEffect, useId, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { X } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { PathVariableView } from '../../shared/ipc-contract.js';

const api = window.bildora;
const NAME_MAX_LENGTH = 64;

interface PathVariablesEditorProps {
  readonly onChanged: () => void;
  readonly onError: (error: unknown) => void;
}

/** This computer's values for the path variables tools refer to. */
export function PathVariablesEditor({ onChanged, onError }: PathVariablesEditorProps) {
  const [variables, setVariables] = useState<readonly PathVariableView[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const id = useId();

  const load = useCallback((): Promise<void> => api.listPathVariables().then(setVariables), []);

  useEffect(() => {
    void load().catch(onError);
  }, [load, onError]);

  function changed(): Promise<void> {
    onChanged();
    return load();
  }

  function add(event: SyntheticEvent): void {
    event.preventDefault();
    void api
      .setPathVariable(name.trim(), value.trim())
      .then(() => {
        setName('');
        setValue('');
        return changed();
      })
      .catch(onError);
  }

  return (
    <div className="field settings-field path-variables">
      <h3 className="field-label">{t('settings.pathVariables')}</h3>
      <span className="field-hint">
        {t('settings.pathVariablesHint', { example: '{{paths.name}}' })}
      </span>
      {variables.length === 0 ? (
        <p className="muted">{t('settings.pathVariablesEmpty')}</p>
      ) : (
        <ul className="workspace-list" data-testid="path-variables">
          {variables.map((variable) => (
            <li key={variable.name} className="variable-row">
              <code>{variable.name}</code>
              <code className="path" title={variable.value}>
                {variable.value}
              </code>
              <button
                type="button"
                className="icon-button"
                aria-label={t('settings.pathVariableRemove', { name: variable.name })}
                onClick={() => {
                  void api.removePathVariable(variable.name).then(changed).catch(onError);
                }}
              >
                <X className="icon" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="variable-form" onSubmit={add}>
        <label className="visually-hidden" htmlFor={`${id}-name`}>
          {t('settings.pathVariableName')}
        </label>
        <input
          id={`${id}-name`}
          value={name}
          placeholder={t('settings.pathVariableName')}
          maxLength={NAME_MAX_LENGTH}
          spellCheck={false}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <label className="visually-hidden" htmlFor={`${id}-value`}>
          {t('settings.pathVariableValue')}
        </label>
        <input
          id={`${id}-value`}
          value={value}
          placeholder={t('settings.pathVariableValue')}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <button type="submit" disabled={name.trim() === '' || value.trim() === ''}>
          {t('settings.pathVariableAdd')}
        </button>
      </form>
    </div>
  );
}

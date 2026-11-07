import { useId } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { ToolScopeChoice } from '../../shared/ipc-contract.js';

interface ScopeChoiceProps {
  readonly scope: ToolScopeChoice;
  readonly workspaceName: string;
  readonly onChange: (scope: ToolScopeChoice) => void;
}

/** Where a tool installs. The choice shows at every way in, because it decides who sees it. */
export function ScopeChoice({ scope, workspaceName, onChange }: ScopeChoiceProps) {
  const group = useId();
  return (
    <fieldset className="radio-group">
      <legend>{t('form.scope')}</legend>
      <label>
        <input
          type="radio"
          name={group}
          checked={scope === 'workspace'}
          onChange={() => {
            onChange('workspace');
          }}
        />
        {t('form.scopeWorkspace', { name: workspaceName })}
      </label>
      <label>
        <input
          type="radio"
          name={group}
          checked={scope === 'global'}
          onChange={() => {
            onChange('global');
          }}
        />
        {t('form.scopeGlobal')}
      </label>
    </fieldset>
  );
}

import { useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import type { AutomationInputDeclaration } from '@bildora/protocol';
import { t } from '../../shared/i18n/translate.js';
import type { ParameterView } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';
import { ParameterForm } from '../tools/ParameterForm.js';
import { formProblems, initialValues, submittedValues } from '../tools/parameter-form.js';
import type { FormValues } from '../tools/parameter-form.js';

const api = window.bildora;

/** An input as the form a tool's parameters use shows it. */
export function inputParameter(input: AutomationInputDeclaration): ParameterView {
  return {
    name: input.name,
    label: input.label ?? input.name,
    type: input.type,
    required: input.required === true,
    delivery: 'argument',
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.default === undefined ? {} : { default: input.default }),
    ...(input.type === 'choice' ? { choices: input.choices } : {}),
  };
}

export interface RunInputsDialogProps {
  readonly name: string;
  readonly inputs: readonly AutomationInputDeclaration[];
  readonly onRun: (values: Readonly<Record<string, string | number | boolean>>) => void;
  readonly onClose: () => void;
  readonly onError: (error: unknown) => void;
}

/** Asks for an automation's inputs when it starts, in the same form tools use. */
export function RunInputsDialog({ name, inputs, onRun, onClose, onError }: RunInputsDialogProps) {
  const parameters = useMemo(() => inputs.map(inputParameter), [inputs]);
  const [values, setValues] = useState<FormValues>(() => initialValues(parameters));
  const [tried, setTried] = useState(false);
  const problems = formProblems(parameters, values, []);
  const blocked = Object.keys(problems).length > 0;

  return (
    <Dialog
      title={t('automation.runInputsTitle', { name })}
      className="run-inputs"
      onClose={onClose}
    >
      <form
        className="form"
        data-testid="run-inputs"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (blocked) return;
          const { plain } = submittedValues(parameters, values);
          onRun(plain);
        }}
      >
        <p className="field-hint">{t('automation.runInputsHint')}</p>
        <ParameterForm
          parameters={parameters}
          values={values}
          problems={tried ? problems : {}}
          savedSecrets={[]}
          disabled={false}
          onChange={(field, value) => {
            setValues((current) => ({ ...current, [field]: value }));
          }}
          onBrowse={(field) => {
            void api
              .pickPath()
              .then((path) => {
                if (path !== undefined) setValues((current) => ({ ...current, [field]: path }));
              })
              .catch(onError);
          }}
          onForget={() => undefined}
        />
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('automation.runInputsCancel')}
          </button>
          <button type="submit" className="primary">
            <Play className="icon" aria-hidden="true" />
            {t('automation.runInputsRun')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

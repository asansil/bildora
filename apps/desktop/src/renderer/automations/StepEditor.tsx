import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type {
  AutomationProblemView,
  AutomationStep,
  ParameterView,
  ProfileView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { ParameterForm } from '../tools/ParameterForm.js';
import { parameterProblem, submittedValues } from '../tools/parameter-form.js';
import type { FormValue, FormValues } from '../tools/parameter-form.js';
import { failureChoice, referenceOptions, without, withFailureChoice } from './automation-draft.js';
import type { FailureChoice, RunStep } from './automation-draft.js';

const api = window.bildora;

const KIND_LABELS: Readonly<Record<AutomationStep['type'], MessageKey>> = {
  run: 'automation.kindRun',
  'wait-for-time': 'automation.kindTime',
  'wait-for-manual-action': 'automation.kindManual',
};

interface FailureSelectProps {
  readonly value: FailureChoice;
  readonly allowRetry: boolean;
  readonly onChange: (choice: FailureChoice) => void;
}

function FailureSelect({ value, allowRetry, onChange }: FailureSelectProps) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('automation.onFailure')}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as FailureChoice);
        }}
      >
        <option value="stop">{t('automation.failureStop')}</option>
        <option value="continue">{t('automation.failureContinue')}</option>
        {allowRetry ? <option value="retry">{t('automation.failureRetry')}</option> : null}
      </select>
    </div>
  );
}

interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly onChange: (value: number) => void;
}

function NumberField({ label, value, min, max, onChange }: NumberFieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        {...(max === undefined ? {} : { max })}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min) {
            onChange(next);
          }
        }}
      />
    </div>
  );
}

function formFrom(parameters: readonly ParameterView[], values: RunStep['values']): FormValues {
  return Object.fromEntries(
    parameters.map(({ name, type }) => {
      const value = values?.[name];
      return [name, type === 'boolean' ? value === true : String(value ?? '')];
    }),
  );
}

/** What a form holds, as a step stores it: only what was set, so the rest stays as the tool has it. */
function stepValues(
  parameters: readonly ParameterView[],
  form: FormValues,
): NonNullable<RunStep['values']> {
  const usable = parameters.filter(
    (parameter) => parameterProblem(parameter, form[parameter.name], false) === undefined,
  );
  const { plain } = submittedValues(usable, form);
  return Object.fromEntries(Object.entries(plain).filter(([, value]) => value !== false));
}

interface RunStepFieldsProps {
  readonly step: RunStep;
  readonly index: number;
  readonly steps: readonly AutomationStep[];
  readonly tools: readonly ToolView[];
  readonly onChange: (step: RunStep) => void;
  readonly onError: (error: unknown) => void;
}

function ProfileField({
  step,
  profiles,
  onChange,
}: Pick<RunStepFieldsProps, 'step' | 'onChange'> & { readonly profiles: readonly ProfileView[] }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('automation.profile')}
      </label>
      <select
        id={id}
        value={step.profile ?? ''}
        onChange={(event) => {
          const rest: RunStep = without(step, 'profile');
          onChange(event.target.value === '' ? rest : { ...rest, profile: event.target.value });
        }}
      >
        <option value="">{t('automation.noProfile')}</option>
        {profiles.map(({ id: profileId, name }) => (
          <option key={profileId} value={profileId}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The fields of a run step. Secrets have none here: they only ever come from a profile. */
function RunStepFields({ step, index, steps, tools, onChange, onError }: RunStepFieldsProps) {
  const toolId = useId();
  const tool = tools.find(({ id }) => id === step.tool);
  const parameters = useMemo(
    // All optional here: a value can also come from a profile or from the tool's default.
    () =>
      (tool?.parameters ?? [])
        .filter(({ secret }) => secret !== true)
        .map((parameter) => ({ ...parameter, required: false })),
    [tool],
  );
  const [form, setForm] = useState<FormValues>(() => formFrom(parameters, step.values));
  const [profiles, setProfiles] = useState<readonly ProfileView[]>([]);
  const references = referenceOptions(steps, index, tools);
  const toolLevel = tool?.level;

  useEffect(() => {
    let current = true;
    if (toolLevel === 1) {
      void api
        .listProfiles(step.tool)
        .then((list) => {
          if (current) {
            setProfiles(list);
          }
        })
        .catch(onError);
    }
    return () => {
      current = false;
    };
  }, [step.tool, toolLevel, onError]);

  function setValue(name: string, value: FormValue): void {
    const next = { ...form, [name]: value };
    setForm(next);
    const rest: RunStep = without(step, 'values');
    const values = stepValues(parameters, next);
    onChange(Object.keys(values).length === 0 ? rest : { ...rest, values });
  }

  const problems = Object.fromEntries(
    parameters.flatMap((parameter) => {
      const problem = parameterProblem(parameter, form[parameter.name], false);
      return problem === undefined ? [] : [[parameter.name, problem]];
    }),
  ) as Readonly<Record<string, MessageKey>>;

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={toolId}>
          {t('automation.tool')}
        </label>
        <select
          id={toolId}
          value={step.tool}
          onChange={(event) => {
            onChange({ ...without(step, 'profile', 'values'), tool: event.target.value });
            setForm({});
          }}
        >
          {tool === undefined ? (
            <option value={step.tool}>{t('automation.toolMissing', { id: step.tool })}</option>
          ) : null}
          {tools.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {toolLevel === 1 ? (
        <ProfileField step={step} profiles={profiles} onChange={onChange} />
      ) : null}
      {parameters.length === 0 ? null : (
        <>
          <p className="field-hint">{t('automation.valuesHint')}</p>
          <ParameterForm
            parameters={parameters}
            values={form}
            problems={problems}
            savedSecrets={[]}
            disabled={false}
            onChange={setValue}
            onBrowse={(name) => {
              void api
                .pickPath()
                .then((path) => {
                  if (path !== undefined) {
                    setValue(name, path);
                  }
                })
                .catch(onError);
            }}
            onForget={() => undefined}
            pathControl={(name) => (
              <select
                className="reference-select"
                aria-label={t('automation.insertReference')}
                value=""
                onChange={(event) => {
                  setValue(name, event.target.value);
                }}
              >
                <option value="">{t('automation.reference')}</option>
                {references.map(({ label, value }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          />
        </>
      )}
      <FailureSelect
        value={failureChoice(step)}
        allowRetry
        onChange={(choice) => {
          onChange(withFailureChoice(step, choice));
        }}
      />
      {typeof step.onFailure === 'object' ? (
        <div className="automation-retry">
          <NumberField
            label={t('automation.attempts')}
            value={step.onFailure.retry.attempts}
            min={2}
            max={20}
            onChange={(attempts) => {
              const { retry } = step.onFailure as { retry: { delaySeconds?: number } };
              onChange({ ...step, onFailure: { retry: { ...retry, attempts } } });
            }}
          />
          <NumberField
            label={t('automation.retryDelay')}
            value={step.onFailure.retry.delaySeconds ?? 0}
            min={0}
            onChange={(delaySeconds) => {
              const { retry } = step.onFailure as { retry: { attempts: number } };
              onChange({ ...step, onFailure: { retry: { ...retry, delaySeconds } } });
            }}
          />
        </div>
      ) : null}
    </>
  );
}

interface StepEditorProps {
  readonly step: AutomationStep;
  readonly index: number;
  readonly steps: readonly AutomationStep[];
  readonly tools: readonly ToolView[];
  readonly problems: readonly AutomationProblemView[];
  readonly onChange: (step: AutomationStep) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
  readonly onError: (error: unknown) => void;
}

function PlainFailure({
  step,
  onChange,
}: {
  readonly step: Extract<AutomationStep, { type: 'wait-for-manual-action' }>;
  readonly onChange: (step: AutomationStep) => void;
}) {
  return (
    <FailureSelect
      value={failureChoice(step)}
      allowRetry={false}
      onChange={(choice) => {
        const rest = without(step, 'onFailure') as typeof step;
        onChange(choice === 'continue' ? { ...rest, onFailure: 'continue' } : rest);
      }}
    />
  );
}

function ManualFields({
  step,
  onChange,
}: {
  readonly step: Extract<AutomationStep, { type: 'wait-for-manual-action' }>;
  readonly onChange: (step: AutomationStep) => void;
}) {
  const id = useId();
  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {t('automation.message')}
        </label>
        <input
          id={id}
          value={step.message}
          onChange={(event) => {
            onChange({ ...step, message: event.target.value });
          }}
        />
      </div>
      <PlainFailure step={step} onChange={onChange} />
    </>
  );
}

/** One step in the editor. Moving stays on buttons, so the keyboard reaches everything. */
export function StepEditor({
  step,
  index,
  steps,
  tools,
  problems,
  onChange,
  onMove,
  onRemove,
  onError,
}: StepEditorProps) {
  return (
    <li className="step-card" data-testid="step-editor" data-step-id={step.id}>
      <header className="step-card-head">
        <strong>
          {t('automation.stepNumber', { number: index + 1 })} · {t(KIND_LABELS[step.type])}
        </strong>
        <span className="muted truncate">{step.id}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t('automation.moveUp', { number: index + 1 })}
          disabled={index === 0}
          onClick={() => {
            onMove(-1);
          }}
        >
          <ArrowUp className="icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('automation.moveDown', { number: index + 1 })}
          disabled={index === steps.length - 1}
          onClick={() => {
            onMove(1);
          }}
        >
          <ArrowDown className="icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('automation.removeStep', { number: index + 1 })}
          onClick={onRemove}
        >
          <Trash2 className="icon" aria-hidden="true" />
        </button>
      </header>
      <div className="step-card-body">
        {step.type === 'run' ? (
          <RunStepFields
            key={step.tool}
            step={step}
            index={index}
            steps={steps}
            tools={tools}
            onChange={onChange}
            onError={onError}
          />
        ) : null}
        {step.type === 'wait-for-time' ? (
          <NumberField
            label={t('automation.seconds')}
            value={step.seconds}
            min={1}
            max={604_800}
            onChange={(seconds) => {
              onChange({ ...step, seconds });
            }}
          />
        ) : null}
        {step.type === 'wait-for-manual-action' ? (
          <ManualFields step={step} onChange={onChange} />
        ) : null}
        {problems.map(({ message }) => (
          <p key={message} className="field-problem" data-testid="step-problem">
            {message}
          </p>
        ))}
      </div>
    </li>
  );
}

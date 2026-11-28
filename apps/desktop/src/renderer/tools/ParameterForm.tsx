import { Fragment, useId } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { ParameterView } from '../../shared/ipc-contract.js';
import type { FormValue, FormValues } from './parameter-form.js';

/** A value a field gets when it is left empty, such as from a profile, and where it comes from. */
export interface InheritedValue {
  readonly value: string | number | boolean;
  /** Said on hover, such as which profile gives it. */
  readonly from: string;
}

interface FieldProps {
  readonly parameter: ParameterView;
  readonly value: FormValue | undefined;
  readonly problem: MessageKey | undefined;
  /** The chosen profile holds a value for this secret, which stays in main. */
  readonly secretSaved: boolean;
  readonly onChange: (value: FormValue) => void;
  readonly onBrowse: () => void;
  readonly onForget: () => void;
  /** Something more to offer beside a path, such as a reference to an earlier step. */
  readonly pathControl?: ReactNode;
  /** What the field gets while it is left empty, shown dimmed in it. */
  readonly inherited?: InheritedValue | undefined;
}

function Field({
  parameter,
  value,
  problem,
  secretSaved,
  onChange,
  onBrowse,
  onForget,
  pathControl,
  inherited,
}: FieldProps) {
  const id = useId();
  const { label, description, type, choices, required, secret, delivery } = parameter;
  const text = typeof value === 'string' ? value : '';
  const hintId = `${id}-hint`;
  const described =
    problem === undefined && description === undefined ? {} : { 'aria-describedby': hintId };
  const invalid = problem === undefined ? {} : { 'aria-invalid': true };
  /** The choice a list left empty gets, shown as chosen but dimmed. */
  const inheritedChoice =
    inherited === undefined || text !== '' ? undefined : String(inherited.value);

  if (type === 'boolean') {
    return (
      <div className="field">
        <label
          className={inherited === undefined ? 'field-check' : 'field-check is-inherited'}
          title={inherited?.from}
        >
          <input
            type="checkbox"
            checked={inherited === undefined ? value === true : inherited.value === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          {label}
        </label>
        {description === undefined ? null : <span className="field-hint">{description}</span>}
      </div>
    );
  }

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required ? <span className="field-required"> {t('runner.requiredMark')}</span> : null}
      </label>
      {type === 'choice' ? (
        <select
          id={id}
          value={inheritedChoice ?? text}
          {...(inherited !== undefined && inheritedChoice !== undefined
            ? { className: 'is-inherited', title: inherited.from }
            : {})}
          {...described}
          {...invalid}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {(required && parameter.default !== undefined) || inherited !== undefined ? null : (
            <option value="">{t('runner.noChoice')}</option>
          )}
          {/* A profile may hold a choice the tool no longer offers. */}
          {inheritedChoice === undefined || choices?.includes(inheritedChoice) === true ? null : (
            <option value={inheritedChoice} className="is-inherited">
              {inheritedChoice}
            </option>
          )}
          {choices?.map((choice) => (
            <option
              key={choice}
              value={choice}
              {...(choice === inheritedChoice ? { className: 'is-inherited' } : {})}
            >
              {choice}
            </option>
          ))}
        </select>
      ) : (
        <div className="field-row">
          <input
            id={id}
            {...(secret === true ? { type: 'password', autoComplete: 'off' } : {})}
            value={text}
            spellCheck={false}
            placeholder={
              secretSaved
                ? t('runner.secretSaved')
                : inherited === undefined
                  ? undefined
                  : String(inherited.value)
            }
            {...(inherited !== undefined && text === '' ? { title: inherited.from } : {})}
            {...described}
            {...invalid}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          {type === 'path' ? (
            <button type="button" onClick={onBrowse}>
              {t('runner.browse')}
            </button>
          ) : null}
          {type === 'path' ? pathControl : null}
          {secretSaved ? (
            <button type="button" onClick={onForget}>
              {t('runner.forgetSecret')}
            </button>
          ) : null}
        </div>
      )}
      {problem === undefined ? null : (
        <span className="field-problem" id={hintId}>
          {t(problem)}
        </span>
      )}
      {problem === undefined && description !== undefined ? (
        <span className="field-hint" id={hintId}>
          {description}
        </span>
      ) : null}
      {secret === true && delivery === 'argument' ? (
        <span className="field-hint">{t('runner.secretArgument')}</span>
      ) : null}
    </div>
  );
}

interface ParameterFormProps {
  readonly parameters: readonly ParameterView[];
  readonly values: FormValues;
  readonly problems: Readonly<Record<string, MessageKey>>;
  readonly savedSecrets: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (name: string, value: FormValue) => void;
  readonly onBrowse: (name: string) => void;
  readonly onForget: (name: string) => void;
  readonly pathControl?: (name: string) => ReactNode;
  /** A control to show instead of a field, such as one whose value is worked out from others. */
  readonly replace?: (parameter: ParameterView) => ReactNode;
  /** Wraps each field, such as to give it a menu of its own. */
  readonly decorate?: (parameter: ParameterView, field: ReactNode) => ReactNode;
  /** What each field left empty gets instead, by parameter, shown dimmed in it. */
  readonly inherited?: Readonly<Record<string, InheritedValue>>;
}

/** The form a manifest describes. Nothing here knows about any particular tool. */
export function ParameterForm({
  parameters,
  values,
  problems,
  savedSecrets,
  disabled,
  onChange,
  onBrowse,
  onForget,
  pathControl,
  replace,
  decorate,
  inherited,
}: ParameterFormProps) {
  if (parameters.length === 0) {
    return <p className="muted">{t('runner.noParameters')}</p>;
  }
  return (
    <fieldset className="parameters" disabled={disabled} data-testid="parameter-form">
      {parameters.map((parameter) => {
        const { name } = parameter;
        const field = replace?.(parameter) ?? (
          <Field
            parameter={parameter}
            value={values[name]}
            problem={problems[name]}
            secretSaved={savedSecrets.includes(name)}
            onChange={(value) => {
              onChange(name, value);
            }}
            onBrowse={() => {
              onBrowse(name);
            }}
            onForget={() => {
              onForget(name);
            }}
            pathControl={pathControl?.(name)}
            inherited={inherited?.[name]}
          />
        );
        return <Fragment key={name}>{decorate?.(parameter, field) ?? field}</Fragment>;
      })}
    </fieldset>
  );
}

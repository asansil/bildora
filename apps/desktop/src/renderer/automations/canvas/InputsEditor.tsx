import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AUTOMATION_INPUTS_MAX } from '@bildora/protocol';
import type { AutomationInputDeclaration } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import { without } from '../automation-draft.js';
import { NameField, Select } from './fields.js';

type InputType = AutomationInputDeclaration['type'];

const INPUT_TYPES: readonly InputType[] = [
  'string',
  'path',
  'integer',
  'number',
  'boolean',
  'choice',
];
const INPUT_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** An input of another type, keeping what both types share. */
function retyped(input: AutomationInputDeclaration, type: InputType): AutomationInputDeclaration {
  const { name, label, description, required } = input;
  const shared = {
    name,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
    ...(required === undefined ? {} : { required }),
  };
  return type === 'choice' ? { ...shared, type, choices: ['a', 'b'] } : { ...shared, type };
}

/** An input with another default, or none when the text is empty or does not fit its type. */
function withDefault(
  input: AutomationInputDeclaration,
  text: string | boolean,
): AutomationInputDeclaration {
  if (typeof text === 'boolean') {
    return input.type === 'boolean' ? { ...input, default: text } : input;
  }
  if (text === '') return without(input, 'default') as AutomationInputDeclaration;
  switch (input.type) {
    case 'integer': {
      const value = Number(text);
      return Number.isSafeInteger(value) ? { ...input, default: value } : input;
    }
    case 'number': {
      const value = Number(text);
      return Number.isFinite(value) ? { ...input, default: value } : input;
    }
    case 'boolean':
      return input;
    default:
      return { ...input, default: text };
  }
}

function DefaultField({
  input,
  onChange,
}: {
  readonly input: AutomationInputDeclaration;
  readonly onChange: (input: AutomationInputDeclaration) => void;
}) {
  const id = useId();
  if (input.type === 'boolean') {
    return (
      <div className="field">
        <label className="field-check">
          <input
            type="checkbox"
            checked={input.default === true}
            onChange={(event) => {
              onChange(withDefault(input, event.target.checked));
            }}
          />
          {t('canvas.inputDefaultYes')}
        </label>
      </div>
    );
  }
  if (input.type === 'choice') {
    return (
      <Select
        label={t('canvas.inputDefault')}
        value={input.default ?? ''}
        options={[
          { value: '', label: t('runner.noChoice') },
          ...input.choices.map((choice) => ({ value: choice, label: choice })),
        ]}
        onChange={(choice) => {
          onChange(withDefault(input, choice));
        }}
      />
    );
  }
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.inputDefault')}
      </label>
      <input
        id={id}
        defaultValue={input.default === undefined ? '' : String(input.default)}
        spellCheck={false}
        {...(input.type === 'integer' || input.type === 'number'
          ? { inputMode: 'decimal' as const }
          : {})}
        onChange={(event) => {
          onChange(withDefault(input, event.target.value));
        }}
      />
    </div>
  );
}

/**
 * The inputs of the Start block: what the automation asks for when it starts. Blocks read each as
 * `= inputs.<name>`. Inputs are never secret, since automations are shared.
 */
export function InputsEditor({
  inputs,
  onChange,
}: {
  readonly inputs: readonly AutomationInputDeclaration[];
  readonly onChange: (inputs: readonly AutomationInputDeclaration[]) => void;
}) {
  const set = (index: number, input: AutomationInputDeclaration): void => {
    onChange(inputs.map((item, position) => (position === index ? input : item)));
  };
  return (
    <section className="start-inputs" aria-label={t('canvas.inputs')}>
      <h3>{t('canvas.inputs')}</h3>
      <p className="field-hint">{t('canvas.inputsHint')}</p>
      {inputs.map((input, index) => (
        <fieldset key={index} className="start-input" data-testid="start-input">
          <legend className="visually-hidden">{input.label ?? input.name}</legend>
          <NameField
            label={t('canvas.inputName')}
            value={input.name}
            hint={t('canvas.inputNameHint', { name: input.name })}
            problemOf={(name) =>
              INPUT_NAME.test(name) &&
              !inputs.some((other, position) => position !== index && other.name === name)
                ? undefined
                : t('canvas.inputNameProblem')
            }
            onRename={(name) => {
              set(index, { ...input, name });
            }}
          />
          <LabelField
            value={input.label ?? ''}
            onChange={(label) => {
              set(
                index,
                label === ''
                  ? (without(input, 'label') as AutomationInputDeclaration)
                  : { ...input, label },
              );
            }}
          />
          <Select
            label={t('canvas.inputType')}
            value={input.type}
            options={INPUT_TYPES.map((type) => ({
              value: type,
              label: t(`canvas.inputType.${type}`),
            }))}
            onChange={(type) => {
              if (type !== input.type) set(index, retyped(input, type));
            }}
          />
          {input.type === 'choice' ? (
            <ChoicesField
              choices={input.choices}
              onChange={(choices) => {
                const kept =
                  input.default !== undefined && choices.includes(input.default)
                    ? input
                    : (withDefault(input, '') as typeof input);
                set(index, { ...kept, choices });
              }}
            />
          ) : null}
          <DefaultField
            key={input.type}
            input={input}
            onChange={(next) => {
              set(index, next);
            }}
          />
          <div className="field">
            <label className="field-check">
              <input
                type="checkbox"
                checked={input.required === true}
                onChange={(event) => {
                  set(
                    index,
                    event.target.checked
                      ? { ...input, required: true }
                      : (without(input, 'required') as AutomationInputDeclaration),
                  );
                }}
              />
              {t('canvas.inputRequired')}
            </label>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(inputs.filter((_input, position) => position !== index));
            }}
          >
            <Trash2 className="icon" aria-hidden="true" />
            {t('canvas.removeInput')}
          </button>
        </fieldset>
      ))}
      {inputs.length < AUTOMATION_INPUTS_MAX ? (
        <button
          type="button"
          onClick={() => {
            const taken = new Set(inputs.map(({ name }) => name));
            let number = inputs.length + 1;
            while (taken.has(`input-${String(number)}`)) number += 1;
            onChange([...inputs, { name: `input-${String(number)}`, type: 'string' }]);
          }}
        >
          <Plus className="icon" aria-hidden="true" />
          {t('canvas.addInput')}
        </button>
      ) : null}
    </section>
  );
}

function LabelField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (label: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.inputLabel')}
      </label>
      <input
        id={id}
        defaultValue={value}
        onChange={(event) => {
          onChange(event.target.value.trim());
        }}
      />
    </div>
  );
}

function ChoicesField({
  choices,
  onChange,
}: {
  readonly choices: readonly string[];
  readonly onChange: (choices: string[]) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.inputChoices')}
      </label>
      <input
        id={id}
        defaultValue={choices.join(', ')}
        onChange={(event) => {
          const next = [
            ...new Set(
              event.target.value
                .split(',')
                .map((choice) => choice.trim())
                .filter((choice) => choice !== ''),
            ),
          ];
          if (next.length > 0) onChange(next);
        }}
      />
    </div>
  );
}

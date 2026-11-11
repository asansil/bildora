import { useId, useState } from 'react';
import type { Ref } from 'react';

/** A whole number within limits. Anything else typed is not applied. */
export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly onChange: (value: number) => void;
}) {
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
          if (Number.isInteger(next) && next >= min && (max === undefined || next <= max)) {
            onChange(next);
          }
        }}
      />
    </div>
  );
}

export interface SelectOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

export function Select<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly SelectOption<Value>[];
  readonly onChange: (value: Value) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as Value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled === true}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A name being typed, applied only once it is valid, so that a half-typed name never reaches the
 * flow. While it is not valid, the field says why.
 */
export function NameField({
  label,
  value,
  problemOf,
  onRename,
  hint,
  applyOnBlur = false,
  inputRef,
}: {
  readonly label: string;
  readonly value: string;
  /** Why a name cannot be used, or undefined when it can. */
  readonly problemOf: (name: string) => string | undefined;
  readonly onRename: (name: string) => void;
  readonly hint?: string;
  /** Applies the name on Enter or when the field is left, rather than as it is typed. */
  readonly applyOnBlur?: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const problem = text === value ? undefined : problemOf(text);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        value={text}
        spellCheck={false}
        aria-invalid={problem !== undefined}
        {...(inputRef === undefined ? {} : { ref: inputRef })}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (!applyOnBlur && next !== value && problemOf(next) === undefined) onRename(next);
        }}
        onBlur={() => {
          if (!applyOnBlur) return;
          if (text !== value && problemOf(text) === undefined) onRename(text);
          else setText(value);
        }}
        onKeyDown={(event) => {
          if (!applyOnBlur) return;
          if (event.key === 'Enter' && text !== value && problemOf(text) === undefined) {
            event.preventDefault();
            onRename(text);
          } else if (event.key === 'Escape') {
            setText(value);
          }
        }}
      />
      {problem === undefined ? (
        hint === undefined ? null : (
          <span className="field-hint">{hint}</span>
        )
      ) : (
        <p className="field-problem">{problem}</p>
      )}
    </div>
  );
}

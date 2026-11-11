import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { EXPRESSION_FUNCTIONS } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { ShownValue, ValueChoice } from './values.js';

/** As tall as the suggestion list may grow, in pixels, as the stylesheet caps it. */
const SUGGESTIONS_HEIGHT = 220;
/** Suggestions shown at once while a name is typed. */
const SUGGESTIONS_MAX = 8;
/** What a name being typed is made of, so that the word before the caret can be completed. */
const NAME_PART = /[A-Za-z0-9_.-]+$/;

interface Suggestion {
  readonly text: string;
  /** What it is, such as the label of a parameter. */
  readonly hint: string;
}

function suggestionsFor(
  typed: string,
  choices: readonly ValueChoice[],
  nameOf: (id: string) => string,
): readonly Suggestion[] {
  if (typed === '') return [];
  const lower = typed.toLowerCase();
  const names = choices
    .filter(({ expression }) => expression.toLowerCase().startsWith(lower) && expression !== typed)
    .map(({ expression, label, block }) => ({
      text: expression,
      hint: block === undefined ? label : `${nameOf(block)} › ${label}`,
    }));
  const functions = typed.includes('.')
    ? []
    : Object.keys(EXPRESSION_FUNCTIONS)
        .filter((name) => name.startsWith(lower))
        .map((name) => ({ text: `${name}(`, hint: t('canvas.expressionFunction') }));
  return [...names, ...functions].slice(0, SUGGESTIONS_MAX);
}

/** What shows under a linked field: the problem, or what the value resolves to. */
function shownText(shown: ShownValue): string {
  switch (shown.kind) {
    case 'value':
      return shown.text === ''
        ? t('canvas.valueEmpty')
        : t('canvas.valueResolves', { value: shown.text });
    case 'later':
      return t('canvas.valueLater');
    case 'unknown':
      return '';
  }
}

export interface ExpressionFieldProps {
  readonly label: string;
  /** What follows `=`. */
  readonly text: string;
  readonly shown: ShownValue;
  /** A problem of the flow about this value, worded for people. */
  readonly problem?: string | undefined;
  /** Names the field can read, offered as the person types. */
  readonly choices: readonly ValueChoice[];
  readonly nameOf: (id: string) => string;
  /** Takes the caret when the field has just been linked. */
  readonly autoFocus?: boolean;
  readonly onChange: (text: string) => void;
  /** Called when the person deletes the whole expression and then the `=`. */
  readonly onUnlink: () => void;
}

/**
 * A value worked out from others, written after `=`. It reads back what it resolves to, and offers
 * the names and functions it can use while a name is typed.
 */
export function ExpressionField({
  label,
  text,
  shown,
  problem,
  choices,
  nameOf,
  autoFocus = false,
  onChange,
  onUnlink,
}: ExpressionFieldProps) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const hintId = `${id}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  /** The suggestions open above the field only when there is no room for them below. */
  const [above, setAbove] = useState(false);
  const [caret, setCaret] = useState(text.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!autoFocus) return;
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [autoFocus]);

  const typed = NAME_PART.exec(text.slice(0, caret))?.[0] ?? '';
  const suggestions = open ? suggestionsFor(typed, choices, nameOf) : [];
  const shownLine = problem ?? shownText(shown);
  const showing = suggestions.length > 0;

  useLayoutEffect(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!showing || box === undefined) return;
    const room = window.innerHeight - box.bottom;
    setAbove(room < SUGGESTIONS_HEIGHT && box.top > room);
  }, [showing]);

  function accept(suggestion: Suggestion): void {
    const start = caret - typed.length;
    const next = text.slice(0, start) + suggestion.text + text.slice(caret);
    const at = start + suggestion.text.length;
    onChange(next);
    setCaret(at);
    setOpen(false);
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(at, at);
    });
  }

  return (
    <div className="field expression-field" data-testid="expression-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="expression-anchor" ref={anchor}>
        <div className="field-row expression-row">
          <span className="expression-equals" aria-hidden="true">
            =
          </span>
          <input
            ref={input}
            id={id}
            className="expression-input"
            value={text}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-describedby={hintId}
            {...(problem === undefined ? {} : { 'aria-invalid': true })}
            {...(suggestions.length > 0
              ? { 'aria-activedescendant': `${listId}-${String(active)}` }
              : {})}
            onChange={(event) => {
              onChange(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
              setOpen(true);
              setActive(0);
            }}
            onSelect={(event) => {
              setCaret(event.currentTarget.selectionStart ?? 0);
            }}
            onBlur={() => {
              setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && text === '') {
                event.preventDefault();
                onUnlink();
                return;
              }
              if (suggestions.length === 0) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActive((active + step + suggestions.length) % suggestions.length);
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                const chosen = suggestions[active];
                if (chosen !== undefined) {
                  event.preventDefault();
                  accept(chosen);
                }
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
        </div>
        {suggestions.length > 0 ? (
          <ul
            className={`expression-suggestions${above ? ' is-above' : ''}`}
            id={listId}
            role="listbox"
            aria-label={label}
          >
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion.text}
                id={`${listId}-${String(index)}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : undefined}
                onMouseDown={(event) => {
                  // Keeps the caret in the field.
                  event.preventDefault();
                  accept(suggestion);
                }}
              >
                <span className="expression-suggestion-text">{suggestion.text}</span>
                <span className="expression-suggestion-hint">{suggestion.hint}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <span
        className={problem === undefined ? 'field-hint' : 'field-problem'}
        id={hintId}
        data-testid="expression-shown"
      >
        {shownLine}
      </span>
    </div>
  );
}

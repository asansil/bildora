import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../../shared/i18n/translate.js';
import { Dialog } from '../../shell/Dialog.js';
import type { NewBlock } from './flow-document.js';

/** What can be added: a block, or a note, which joins nothing. */
export type AddChoice = NewBlock | { readonly kind: 'note' };

export interface LibraryChoice {
  readonly choice: AddChoice;
  readonly label: string;
  /** Drawn beside the label in menus. */
  readonly icon?: ReactNode;
  /** The tool's category, which the canvas menu lists tools under. */
  readonly group?: string;
}

function Search({
  value,
  label,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        autoFocus
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

export function matches(text: string, filter: string): boolean {
  return text.toLowerCase().includes(filter.trim().toLowerCase());
}

/** The library in a dialog: what to add after the focused block, or where the canvas was clicked. */
export function AddDialog({
  title,
  choices,
  onPick,
  onClose,
}: {
  readonly title: string;
  readonly choices: readonly LibraryChoice[];
  readonly onPick: (choice: AddChoice) => void;
  readonly onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = choices.filter(({ label }) => matches(label, filter));
  return (
    <Dialog title={title} onClose={onClose}>
      <Search value={filter} label={t('canvas.findBlock')} onChange={setFilter} />
      <p className="muted" aria-live="polite">
        {t('canvas.choiceCount', { count: shown.length })}
      </p>
      <ul className="choice-list" data-testid="add-choices">
        {shown.map(({ choice, label, icon }) => (
          <li key={choice.kind === 'run' ? `run:${choice.tool}` : choice.kind}>
            <button
              type="button"
              onClick={() => {
                onPick(choice);
              }}
            >
              {icon}
              <span className="truncate">{label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {t('form.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

export interface OutputChoice {
  readonly id: string;
  readonly label: string;
  /** Where it leads now, in words, or undefined when it leads nowhere. */
  readonly now?: string | undefined;
}

/** Connecting from the keyboard: an output first, then a block that can follow it. */
export function ConnectDialog({
  sourceName,
  outputs,
  targetsOf,
  onConnect,
  onClose,
}: {
  readonly sourceName: string;
  readonly outputs: readonly OutputChoice[];
  readonly targetsOf: (output: string) => readonly { readonly id: string; readonly name: string }[];
  readonly onConnect: (output: string, target: string) => void;
  readonly onClose: () => void;
}) {
  const [only] = outputs.length === 1 ? outputs : [];
  const [output, setOutput] = useState<OutputChoice | undefined>(only);
  const [filter, setFilter] = useState('');
  const targets =
    output === undefined ? [] : targetsOf(output.id).filter(({ name }) => matches(name, filter));
  return (
    <Dialog
      title={
        output === undefined
          ? t('canvas.connectTitle', { name: sourceName })
          : t('canvas.connectTo', { name: sourceName, output: output.label })
      }
      onClose={onClose}
    >
      {output === undefined ? (
        <ul className="choice-list" data-testid="connect-outputs">
          {outputs.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                autoFocus={choice === outputs[0]}
                onClick={() => {
                  setOutput(choice);
                }}
              >
                {choice.label}
                <span className="muted"> · {choice.now ?? t('canvas.notConnected')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <Search value={filter} label={t('canvas.findBlock')} onChange={setFilter} />
          <p className="muted" aria-live="polite">
            {t('canvas.targetCount', { count: targets.length })}
          </p>
          <ul className="choice-list" data-testid="connect-targets">
            {targets.map((target) => (
              <li key={target.id}>
                <button
                  type="button"
                  onClick={() => {
                    onConnect(output.id, target.id);
                  }}
                >
                  {target.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {t('form.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

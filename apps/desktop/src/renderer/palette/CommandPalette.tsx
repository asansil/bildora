import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { t } from '../../shared/i18n/translate.js';
import { Dialog } from '../shell/Dialog.js';
import { matchCommands } from './match-commands.js';

export interface Command {
  readonly id: string;
  readonly label: string;
  /** Says what kind of item this is: a tool's category, or that it is an action. */
  readonly detail: string;
  /** Drawn before the label, such as a program's icon. */
  readonly icon?: ReactNode;
  readonly run: () => void;
}

interface CommandPaletteProps {
  readonly commands: readonly Command[];
  readonly onClose: () => void;
}

/** One place to find and run anything, as a combobox the keyboard never has to leave. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();
  const matches = useMemo(() => matchCommands(commands, query), [commands, query]);
  const selected = matches[Math.min(active, matches.length - 1)];

  function run(command: Command | undefined): void {
    if (command !== undefined) {
      onClose();
      command.run();
    }
  }

  function onKey(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current) => Math.min(current + 1, matches.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        run(selected);
        break;
    }
  }

  return (
    <Dialog label={t('palette.label')} className="palette" onClose={onClose}>
      <input
        className="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={selected === undefined ? undefined : `${id}-${selected.id}`}
        aria-label={t('palette.label')}
        placeholder={t('search.placeholder')}
        value={query}
        autoFocus
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      <ul className="palette-list" role="listbox" id={`${id}-list`} aria-label={t('palette.label')}>
        {matches.map((command) => (
          <li
            key={command.id}
            id={`${id}-${command.id}`}
            role="option"
            aria-selected={command === selected}
            className="palette-item"
            onClick={() => {
              run(command);
            }}
          >
            <span className="palette-label">
              {command.icon}
              <span className="truncate">{command.label}</span>
            </span>
            <span className="palette-detail truncate">{command.detail}</span>
          </li>
        ))}
      </ul>
      {matches.length === 0 ? <p className="palette-empty">{t('palette.empty')}</p> : null}
      <p className="palette-hint">{t('palette.hint')}</p>
    </Dialog>
  );
}

import { useId, useState } from 'react';
import { Group, Ungroup } from 'lucide-react';
import { NOTE_TEXT_MAX } from '@bildora/protocol';
import type { AutomationGroup, AutomationNote } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';

/** A note's text. It is written here rather than on the canvas, so the keyboard reaches it. */
export function NoteSettings({
  note,
  onChange,
}: {
  readonly note: AutomationNote;
  readonly onChange: (note: AutomationNote) => void;
}) {
  const id = useId();
  return (
    <div className="block-settings" data-testid="note-settings">
      <h2>{t('canvas.kindNote')}</h2>
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {t('canvas.noteText')}
        </label>
        <textarea
          id={id}
          rows={6}
          maxLength={NOTE_TEXT_MAX}
          value={note.text}
          onChange={(event) => {
            onChange({ ...note, text: event.target.value });
          }}
        />
      </div>
      <p className="field-hint">{t('canvas.noteHint')}</p>
    </div>
  );
}

export function GroupSettings({
  group,
  onChange,
  onUngroup,
}: {
  readonly group: AutomationGroup;
  readonly onChange: (group: AutomationGroup) => void;
  readonly onUngroup: () => void;
}) {
  const id = useId();
  // A group needs a name, so an emptied field changes nothing until something is typed.
  const [text, setText] = useState(group.name);
  return (
    <div className="block-settings" data-testid="group-settings">
      <h2>{t('canvas.kindGroup')}</h2>
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {t('canvas.groupName')}
        </label>
        <input
          id={id}
          value={text}
          maxLength={200}
          aria-invalid={text.trim() === ''}
          onChange={(event) => {
            setText(event.target.value);
            if (event.target.value.trim() !== '') onChange({ ...group, name: event.target.value });
          }}
        />
      </div>
      <p className="field-hint">{t('canvas.groupHint')}</p>
      <button type="button" onClick={onUngroup}>
        <Ungroup className="icon" aria-hidden="true" />
        {t('canvas.ungroup')}
      </button>
    </div>
  );
}

/** Several blocks at once: they can be framed together under a name. */
export function SelectionSettings({
  count,
  onGroup,
}: {
  readonly count: number;
  readonly onGroup: () => void;
}) {
  return (
    <div className="block-settings" data-testid="selection-settings">
      <h2>{t('canvas.selectedCount', { count })}</h2>
      <button type="button" onClick={onGroup}>
        <Group className="icon" aria-hidden="true" />
        {t('canvas.group')}
      </button>
      <p className="field-hint">{t('canvas.groupShortcut')}</p>
    </div>
  );
}

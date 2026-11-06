import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { ProfileView } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';

interface ProfileBarProps {
  readonly profiles: readonly ProfileView[];
  readonly selected: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: (id: string | undefined) => void;
  readonly onSave: () => void;
  readonly onSaveAs: (name: string) => void;
  readonly onRemove: () => void;
}

/** Chooses which saved values fill the form, and stores what the form holds. */
export function ProfileBar({
  profiles,
  selected,
  disabled,
  onSelect,
  onSave,
  onSaveAs,
  onRemove,
}: ProfileBarProps) {
  const id = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState(false);
  const current = profiles.find((profile) => profile.id === selected);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    setNaming(false);
    onSaveAs(name.trim());
    setName('');
  }

  return (
    <div className="profile-bar" data-testid="profile-bar">
      <label className="field-label" htmlFor={id}>
        {t('profile.label')}
      </label>
      <select
        id={id}
        value={selected ?? ''}
        disabled={disabled}
        onChange={(event) => {
          onSelect(event.target.value === '' ? undefined : event.target.value);
        }}
      >
        <option value="">{t('profile.none')}</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      {current === undefined ? null : (
        <button type="button" disabled={disabled} onClick={onSave}>
          {t('profile.save')}
        </button>
      )}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setNaming(true);
        }}
      >
        {t('profile.saveAs')}
      </button>
      {current === undefined ? null : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setRemoving(true);
          }}
        >
          {t('profile.remove')}
        </button>
      )}

      {naming ? (
        <Dialog
          title={t('profile.saveAsTitle')}
          onClose={() => {
            setNaming(false);
          }}
        >
          <form className="form" onSubmit={submit}>
            <div className="field">
              <label className="field-label" htmlFor={`${id}-name`}>
                {t('form.name')}
              </label>
              <input
                id={`${id}-name`}
                value={name}
                required
                autoFocus
                maxLength={200}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <span className="field-hint">{t('profile.secretsHint')}</span>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                onClick={() => {
                  setNaming(false);
                }}
              >
                {t('form.cancel')}
              </button>
              <button type="submit" className="primary" disabled={name.trim() === ''}>
                {t('profile.save')}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {removing && current !== undefined ? (
        <Dialog
          title={t('profile.removeTitle', { name: current.name })}
          onClose={() => {
            setRemoving(false);
          }}
        >
          <p>{t('profile.removeBody')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setRemoving(false);
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setRemoving(false);
                onRemove();
              }}
            >
              {t('profile.remove')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

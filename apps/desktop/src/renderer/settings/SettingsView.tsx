import { useId, useState } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { ShellTheme } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';

export const THEME_LABELS: readonly { value: ShellTheme; label: MessageKey }[] = [
  { value: 'system', label: 'settings.themeSystem' },
  { value: 'light', label: 'settings.themeLight' },
  { value: 'dark', label: 'settings.themeDark' },
];

const HISTORY_RUN_LIMIT_MAX = 100_000;

interface SettingsViewProps {
  readonly theme: ShellTheme;
  readonly historyRunLimit: number;
  readonly onTheme: (theme: ShellTheme) => void;
  readonly onHistoryRunLimit: (limit: number) => void;
  readonly onClearHistory: () => void;
}

export function SettingsView({
  theme,
  historyRunLimit,
  onTheme,
  onHistoryRunLimit,
  onClearHistory,
}: SettingsViewProps) {
  const id = useId();
  const [limit, setLimit] = useState(String(historyRunLimit));
  const [clearing, setClearing] = useState(false);

  function commitLimit(): void {
    const value = Number(limit);
    if (Number.isInteger(value) && value >= 1 && value <= HISTORY_RUN_LIMIT_MAX) {
      if (value !== historyRunLimit) {
        onHistoryRunLimit(value);
      }
    } else {
      setLimit(String(historyRunLimit));
    }
  }

  return (
    <section className="settings">
      <h1>{t('settings.title')}</h1>
      <fieldset className="radio-group">
        <legend>{t('settings.theme')}</legend>
        {THEME_LABELS.map(({ value, label }) => (
          <label key={value}>
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => {
                onTheme(value);
              }}
            />
            {t(label)}
          </label>
        ))}
      </fieldset>

      <div className="field settings-field">
        <label className="field-label" htmlFor={id}>
          {t('settings.historyLimit')}
        </label>
        <input
          id={id}
          inputMode="numeric"
          value={limit}
          onChange={(event) => {
            setLimit(event.target.value);
          }}
          onBlur={commitLimit}
        />
        <span className="field-hint">{t('settings.historyLimitHint')}</span>
      </div>
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            setClearing(true);
          }}
        >
          {t('settings.clearHistory')}
        </button>
      </div>

      {clearing ? (
        <Dialog
          title={t('settings.clearHistoryTitle')}
          onClose={() => {
            setClearing(false);
          }}
        >
          <p>{t('settings.clearHistoryBody')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setClearing(false);
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setClearing(false);
                onClearHistory();
              }}
            >
              {t('settings.clearHistory')}
            </button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

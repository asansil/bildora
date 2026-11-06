import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { ShellTheme } from '../../shared/ipc-contract.js';

export const THEME_LABELS: readonly { value: ShellTheme; label: MessageKey }[] = [
  { value: 'system', label: 'settings.themeSystem' },
  { value: 'light', label: 'settings.themeLight' },
  { value: 'dark', label: 'settings.themeDark' },
];

interface SettingsViewProps {
  readonly theme: ShellTheme;
  readonly onTheme: (theme: ShellTheme) => void;
}

export function SettingsView({ theme, onTheme }: SettingsViewProps) {
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
    </section>
  );
}

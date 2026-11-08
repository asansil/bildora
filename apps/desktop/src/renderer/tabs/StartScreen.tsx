import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { ToolView } from '../../shared/ipc-contract.js';
import { BildoraMark } from '../shell/BildoraMark.js';
import { ProgramIcon } from '../shell/ProgramIcon.js';

const SHORTCUTS: readonly { readonly keys: string; readonly label: MessageKey }[] = [
  { keys: 'Ctrl+K', label: 'start.find' },
  { keys: 'Ctrl+Tab', label: 'start.next' },
  { keys: 'Ctrl+W', label: 'start.close' },
];

interface StartScreenProps {
  readonly recent: readonly ToolView[];
  readonly onOpen: (id: string) => void;
}

/** What the work area shows with tools installed and no tab open: a calm way back in. */
export function StartScreen({ recent, onOpen }: StartScreenProps) {
  return (
    <section className="welcome start-screen" data-testid="start-screen">
      <BildoraMark />
      <h1>{t('start.title')}</h1>
      <p>{t('start.body')}</p>
      <dl className="start-shortcuts">
        {SHORTCUTS.map(({ keys, label }) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
      {recent.length === 0 ? null : (
        <>
          <h2>{t('nav.recent')}</h2>
          <ul className="nav-list start-recent">
            {recent.map((tool) => (
              <li key={tool.id}>
                <button
                  type="button"
                  className="row"
                  title={tool.name}
                  onClick={() => {
                    onOpen(tool.id);
                  }}
                >
                  <ProgramIcon tool={tool} />
                  <span className="truncate">{tool.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

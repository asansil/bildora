import { FolderOpen, Plus } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import { BildoraMark } from '../shell/BildoraMark.js';

interface WelcomeProps {
  readonly onAdd: () => void;
  readonly onImport: () => void;
}

/** What an empty installation shows: no sample content, just the two ways to start. */
export function Welcome({ onAdd, onImport }: WelcomeProps) {
  return (
    <section className="welcome" data-testid="welcome">
      <BildoraMark />
      <h1>{t('welcome.title')}</h1>
      <p>{t('welcome.body')}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onAdd}>
          <Plus className="icon" aria-hidden="true" />
          {t('welcome.add')}
        </button>
        <button type="button" onClick={onImport}>
          <FolderOpen className="icon" aria-hidden="true" />
          {t('welcome.import')}
        </button>
      </div>
      <p className="welcome-hint">{t('welcome.drop')}</p>
    </section>
  );
}

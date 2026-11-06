import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { DetectionView, ProposalView, RegisterTools } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';

interface Row {
  readonly path: string;
  readonly name: string;
  readonly category: string;
  readonly interpreter: string;
  readonly included: boolean;
  readonly alreadyRegistered: boolean;
}

function rowOf(proposal: ProposalView): Row {
  return {
    path: proposal.path,
    name: proposal.name,
    category: proposal.category ?? '',
    interpreter: proposal.interpreter ?? '',
    included: !proposal.alreadyRegistered,
    alreadyRegistered: proposal.alreadyRegistered,
  };
}

interface ImportReviewProps {
  readonly detection: DetectionView;
  readonly onConfirm: (programs: RegisterTools['programs']) => void;
  readonly onClose: () => void;
}

/** The last step of assisted import: nothing becomes a tool until the user confirms it here. */
export function ImportReview({ detection, onConfirm, onClose }: ImportReviewProps) {
  const [rows, setRows] = useState(() => detection.proposals.map(rowOf));
  const included = rows.filter((row) => row.included && row.name.trim() !== '');

  function change(path: string, patch: Partial<Row>): void {
    setRows((current) => current.map((row) => (row.path === path ? { ...row, ...patch } : row)));
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    onConfirm(
      included.map(({ path, name, category, interpreter }) => ({
        program: path,
        name,
        category,
        interpreter,
      })),
    );
  }

  return (
    <Dialog title={t('import.title')} className="dialog-wide" onClose={onClose}>
      <form className="form" onSubmit={submit} data-testid="import-review">
        {rows.length === 0 ? (
          <p>{t('import.empty')}</p>
        ) : (
          <p className="muted">{t('import.summary', { count: rows.length })}</p>
        )}
        {detection.truncated ? (
          <p className="muted">{t('import.truncated', { limit: rows.length })}</p>
        ) : null}
        {detection.skipped.length > 0 ? (
          <p className="muted" title={detection.skipped.join('\n')}>
            {t('import.skipped', { count: detection.skipped.length })}
          </p>
        ) : null}
        {rows.length === 0 ? null : (
          <div className="import-table" role="table" aria-label={t('import.title')}>
            <div className="import-row import-head" role="row">
              <span role="columnheader" />
              <span role="columnheader">{t('form.name')}</span>
              <span role="columnheader">{t('form.category')}</span>
              <span role="columnheader">{t('form.interpreter')}</span>
            </div>
            <div className="import-body">
              {rows.map((row) => (
                <div className="import-row" role="row" key={row.path} title={row.path}>
                  <span role="cell">
                    <input
                      type="checkbox"
                      checked={row.included}
                      aria-label={t('import.include', { name: row.name })}
                      onChange={(event) => {
                        change(row.path, { included: event.target.checked });
                      }}
                    />
                  </span>
                  <span role="cell" className="import-name">
                    <input
                      value={row.name}
                      aria-label={t('form.name')}
                      maxLength={200}
                      onChange={(event) => {
                        change(row.path, { name: event.target.value });
                      }}
                    />
                    {row.alreadyRegistered ? (
                      <span className="import-tag">{t('import.already')}</span>
                    ) : null}
                  </span>
                  <span role="cell">
                    <input
                      value={row.category}
                      aria-label={t('form.category')}
                      maxLength={200}
                      onChange={(event) => {
                        change(row.path, { category: event.target.value });
                      }}
                    />
                  </span>
                  <span role="cell">
                    <input
                      value={row.interpreter}
                      aria-label={t('form.interpreter')}
                      maxLength={200}
                      spellCheck={false}
                      onChange={(event) => {
                        change(row.path, { interpreter: event.target.value });
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="primary" disabled={included.length === 0}>
            {t('import.confirm', { count: included.length })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

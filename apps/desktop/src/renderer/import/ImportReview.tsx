import { useState } from 'react';
import type { SyntheticEvent } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type {
  DetectionView,
  ManifestProposalView,
  ProposalView,
  RegisterTools,
  ToolScopeChoice,
} from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';
import { ScopeChoice } from '../tools/ScopeChoice.js';

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
  readonly workspaceName: string;
  readonly onConfirm: (
    programs: RegisterTools['programs'],
    manifests: readonly string[],
    scope: ToolScopeChoice,
  ) => void;
  readonly onClose: () => void;
}

interface ManifestRowProps {
  readonly manifest: ManifestProposalView;
  readonly included: boolean;
  readonly onChange: (included: boolean) => void;
}

/** A declared tool. Its details come from its author, so the user sees them and edits nothing. */
function ManifestRow({ manifest, included, onChange }: ManifestRowProps) {
  const { name, path, permissions, alreadyRegistered, category } = manifest;
  return (
    <label className="manifest-row" title={path} data-testid="manifest-row">
      <input
        type="checkbox"
        checked={included}
        aria-label={t('import.include', { name })}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="manifest-text">
        <span className="manifest-name">
          <strong className="truncate">{name}</strong>
          {category === undefined ? null : <span className="muted truncate">{category}</span>}
          {alreadyRegistered ? <span className="import-tag">{t('import.replaces')}</span> : null}
        </span>
        <code className="path">{path}</code>
        <span className="field-hint">
          {permissions.length === 0
            ? t('import.noPermissions')
            : t('import.permissions', { list: permissions.join(', ') })}
        </span>
      </span>
    </label>
  );
}

/** The last step of assisted import: nothing becomes a tool until the user confirms it here. */
export function ImportReview({ detection, workspaceName, onConfirm, onClose }: ImportReviewProps) {
  const [scope, setScope] = useState<ToolScopeChoice>('workspace');
  const [rows, setRows] = useState(() => detection.proposals.map(rowOf));
  const included = rows.filter((row) => row.included && row.name.trim() !== '');
  const [manifests, setManifests] = useState<readonly string[]>(() =>
    detection.manifests.filter((item) => !item.alreadyRegistered).map((item) => item.path),
  );
  const count = included.length + manifests.length;
  const found = rows.length + detection.manifests.length;

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
      manifests,
      scope,
    );
  }

  return (
    <Dialog title={t('import.title')} className="dialog-wide" onClose={onClose}>
      <form className="form" onSubmit={submit} data-testid="import-review">
        {found === 0 ? (
          <p>{t('import.empty')}</p>
        ) : (
          <p className="muted">{t('import.summary', { count: found })}</p>
        )}
        {detection.truncated ? (
          <p className="muted">{t('import.truncated', { limit: rows.length })}</p>
        ) : null}
        {detection.skipped.length > 0 ? (
          <p className="muted" title={detection.skipped.join('\n')}>
            {t('import.skipped', { count: detection.skipped.length })}
          </p>
        ) : null}
        {detection.refused.map(({ path, reason }) => (
          <p className="notice notice-failed" key={path} data-testid="refused-manifest">
            {t('import.refused', { path, reason })}
          </p>
        ))}
        {detection.manifests.length === 0 ? null : (
          <div className="manifest-list">
            <span className="field-label">{t('import.declared')}</span>
            <span className="field-hint">{t('import.declaredHint')}</span>
            {detection.manifests.map((manifest) => (
              <ManifestRow
                key={manifest.path}
                manifest={manifest}
                included={manifests.includes(manifest.path)}
                onChange={(checked) => {
                  setManifests((current) =>
                    checked
                      ? [...current, manifest.path]
                      : current.filter((path) => path !== manifest.path),
                  );
                }}
              />
            ))}
          </div>
        )}
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
        {found === 0 ? null : (
          <ScopeChoice scope={scope} workspaceName={workspaceName} onChange={setScope} />
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('form.cancel')}
          </button>
          <button type="submit" className="primary" disabled={count === 0}>
            {t('import.confirm', { count })}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

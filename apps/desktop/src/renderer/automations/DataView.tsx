import { useId, useState } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { StepOutputView, StepRunView, StepValueView } from '../../shared/ipc-contract.js';

/** A value as the data view shows it. Lists show one item a line. */
function shown(value: StepOutputView['value']): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'boolean') return value ? t('canvas.yes') : t('canvas.no');
  return String(value);
}

/** What a block received and produced, as plain data, secrets hidden. */
function asJson(
  values: readonly StepValueView[],
  outputs: readonly StepOutputView[],
): Record<string, unknown> {
  const hidden = t('data.hidden');
  return {
    received: Object.fromEntries(
      values.map(({ name, value, secret }) => [name, secret === true ? hidden : (value ?? null)]),
    ),
    produced: Object.fromEntries(
      outputs.map(({ name, value, secret }) => [name, secret === true ? hidden : (value ?? null)]),
    ),
  };
}

/**
 * What one block received and what it left, field names first and raw JSON behind a toggle. A
 * value worked out from others says what it came from. Secrets show as hidden.
 */
export function DataView({ step }: { readonly step: StepRunView | undefined }) {
  const toggleId = useId();
  const [raw, setRaw] = useState(false);
  if (step === undefined) {
    return <p className="muted">{t('data.chooseBlock')}</p>;
  }
  const values = step.values ?? [];
  const outputs = step.outputs ?? [];
  if (values.length === 0 && outputs.length === 0) {
    return (
      <p className="muted" data-testid="data-view">
        {step.values === undefined && step.outputs === undefined
          ? t('data.nothingKept')
          : t('data.nothing')}
      </p>
    );
  }
  return (
    <div className="data-view" data-testid="data-view">
      <label className="field-check data-raw" htmlFor={toggleId}>
        <input
          id={toggleId}
          type="checkbox"
          checked={raw}
          onChange={(event) => {
            setRaw(event.target.checked);
          }}
        />
        {t('data.raw')}
      </label>
      {raw ? (
        <pre className="data-json">{JSON.stringify(asJson(values, outputs), null, 2)}</pre>
      ) : (
        <>
          <section aria-label={t('data.received')}>
            <h3>{t('data.received')}</h3>
            {values.length === 0 ? (
              <p className="muted">{t('data.none')}</p>
            ) : (
              <dl className="facts data-facts" data-testid="data-received">
                {values.map(({ name, label, value, secret, from }) => (
                  <div key={name} className="data-row">
                    <dt>{label}</dt>
                    <dd>
                      {secret === true ? (
                        <span className="muted">{t('data.hidden')}</span>
                      ) : value === undefined ? (
                        <span className="muted">{t('data.unset')}</span>
                      ) : (
                        <span className="data-value">{shown(value)}</span>
                      )}
                      {from === undefined ? null : (
                        <span className="data-from">{t('data.from', { expression: from })}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section aria-label={t('data.produced')}>
            <h3>{t('data.produced')}</h3>
            {outputs.length === 0 ? (
              <p className="muted">{t('data.none')}</p>
            ) : (
              <dl className="facts data-facts" data-testid="data-produced">
                {outputs.map(({ name, value, secret }) => (
                  <div key={name} className="data-row">
                    <dt>{name}</dt>
                    <dd>
                      {secret === true ? (
                        <span className="muted">{t('data.hidden')}</span>
                      ) : (
                        <span className="data-value">{shown(value)}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </>
      )}
      {step.truncated === true ? <p className="field-hint">{t('data.truncated')}</p> : null}
    </div>
  );
}

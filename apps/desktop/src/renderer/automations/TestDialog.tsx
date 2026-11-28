import { useMemo, useState } from 'react';
import { FlaskConical, Play, TriangleAlert } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { TestPlanView } from '../../shared/ipc-contract.js';
import { Dialog } from '../shell/Dialog.js';
import { ParameterForm } from '../tools/ParameterForm.js';
import { formProblems, submittedValues } from '../tools/parameter-form.js';
import type { FormValues } from '../tools/parameter-form.js';
import { formatTime } from '../history/history-format.js';
import { testBlockerText } from './test-text.js';

const api = window.bildora;

export interface TestDialogProps {
  readonly kind: 'block' | 'from';
  /** The tested block's name, as the canvas shows it. */
  readonly name: string;
  readonly plan: TestPlanView;
  /** Whether to warn that real tools will run. */
  readonly warn: boolean;
  readonly nameOf: (id: string) => string;
  readonly onRun: (
    values: Readonly<Record<string, string | number | boolean>> | undefined,
    stopWarning: boolean,
  ) => void;
  readonly onClose: () => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Asks before a test of a block: why it cannot start, or the warning that real tools will run, and
 * for Test block the block's fields, filled from the latest run and open to typing.
 */
export function TestDialog({
  kind,
  name,
  plan,
  warn,
  nameOf,
  onRun,
  onClose,
  onError,
}: TestDialogProps) {
  // A secret comes from the block's profile, as in a run, so nobody types it here.
  const fields = useMemo(
    () => (plan.fields ?? []).filter(({ parameter }) => parameter.secret !== true),
    [plan.fields],
  );
  const parameters = useMemo(() => fields.map(({ parameter }) => parameter), [fields]);
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(
      fields.map(({ parameter, value }) => [
        parameter.name,
        parameter.type === 'boolean' ? value === true : value === undefined ? '' : String(value),
      ]),
    ),
  );
  const [stopWarning, setStopWarning] = useState(false);
  const [tried, setTried] = useState(false);
  const problems = formProblems(parameters, values, []);
  const blocked = Object.keys(problems).length > 0;
  const missing = fields.filter(({ missing: why }) => why !== undefined);
  const title = kind === 'block' ? t('test.titleBlock', { name }) : t('test.titleFrom', { name });

  if (plan.blocker !== undefined) {
    return (
      <Dialog title={title} onClose={onClose}>
        <div className="test-dialog" data-testid="test-blocked">
          <p>{testBlockerText(plan.blocker, nameOf)}</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            {t('dialog.close')}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={title}
      {...(fields.length > 0 ? { className: 'run-inputs' } : {})}
      onClose={onClose}
    >
      <form
        className="form test-dialog"
        data-testid="test-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (blocked) return;
          onRun(
            kind === 'block' ? submittedValues(parameters, values).plain : undefined,
            stopWarning,
          );
        }}
      >
        <p className="field-hint">
          {plan.baseStartedAt === undefined
            ? t('test.noBase')
            : t(kind === 'block' ? 'test.baseBlock' : 'test.baseFrom', {
                time: formatTime(plan.baseStartedAt),
              })}
          {plan.round === undefined ? '' : ` ${t('test.round', { round: plan.round })}`}
        </p>
        {fields.length > 0 ? (
          <ParameterForm
            parameters={parameters}
            values={values}
            problems={tried ? problems : {}}
            savedSecrets={[]}
            disabled={false}
            onChange={(field, value) => {
              setValues((current) => ({ ...current, [field]: value }));
            }}
            onBrowse={(field) => {
              void api
                .pickPath()
                .then((path) => {
                  if (path !== undefined) setValues((current) => ({ ...current, [field]: path }));
                })
                .catch(onError);
            }}
            onForget={() => undefined}
          />
        ) : null}
        {missing.length > 0 ? (
          <ul className="test-missing" data-testid="test-missing">
            {missing.map(({ parameter, missing: why }) => (
              <li key={parameter.name}>
                {t('test.fieldMissing', { field: parameter.label, reason: why ?? '' })}
              </li>
            ))}
          </ul>
        ) : null}
        {warn ? (
          <div className="notice test-warning" role="note">
            <TriangleAlert className="icon" aria-hidden="true" />
            <div>
              <p>{t('test.warning')}</p>
              <label className="field-check">
                <input
                  type="checkbox"
                  checked={stopWarning}
                  onChange={(event) => {
                    setStopWarning(event.target.checked);
                  }}
                />
                {t('test.stopWarning')}
              </label>
            </div>
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('test.cancel')}
          </button>
          <button type="submit" className="primary">
            {kind === 'block' ? (
              <FlaskConical className="icon" aria-hidden="true" />
            ) : (
              <Play className="icon" aria-hidden="true" />
            )}
            {kind === 'block' ? t('test.runBlock') : t('test.runFrom')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

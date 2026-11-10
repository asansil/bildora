import type { ReactNode } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { HistoryRecordView } from '../../shared/ipc-contract.js';
import { formatDuration, formatTime } from './history-format.js';

interface RunFactsProps {
  readonly record: HistoryRecordView;
  /** More facts, after the run's own. */
  readonly children?: ReactNode;
}

/** What a tool run recorded: when, how it ended, its parameters and its output. */
export function RunFacts({ record, children }: RunFactsProps) {
  return (
    <>
      {record.status === 'interrupted' ? <p className="muted">{t('history.interrupted')}</p> : null}
      <dl className="facts">
        <dt>{t('history.started')}</dt>
        <dd>{formatTime(record.startedAt)}</dd>
        <dt>{t('history.duration')}</dt>
        <dd>{formatDuration(record.durationMs)}</dd>
        {record.exitCode === undefined ? null : (
          <>
            <dt>{t('history.exitCode')}</dt>
            <dd>{record.exitCode}</dd>
          </>
        )}
        {record.failure === undefined ? null : (
          <>
            <dt>{t('history.failure')}</dt>
            <dd>{record.failure.message}</dd>
          </>
        )}
        {children}
      </dl>
      {record.parameters.length === 0 ? null : (
        <>
          <h2>{t('history.parameters')}</h2>
          <dl className="facts" data-testid="history-parameters">
            {record.parameters.map((parameter) => (
              <div key={parameter.name}>
                <dt>{parameter.label}</dt>
                <dd>
                  {parameter.secret === true
                    ? t('history.secretHidden')
                    : String(parameter.value ?? t('history.notSet'))}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {record.level === 0 ? null : (
        <>
          <h2>{t('history.output')}</h2>
          {record.outputTruncated ? <p className="muted">{t('history.truncated')}</p> : null}
          <pre className="history-output" data-testid="history-output">
            {record.output === '' ? t('history.noOutput') : record.output}
          </pre>
        </>
      )}
    </>
  );
}

import { useEffect, useId, useState } from 'react';
import { t } from '../../shared/i18n/translate.js';
import type { HistoryRecordView, HistorySummaryView, ToolView } from '../../shared/ipc-contract.js';
import { RunStateBadge, RunStateIcon } from '../shell/RunStateBadge.js';
import { formatDuration, formatTime, historyState } from './history-format.js';

const api = window.bildora;

function RunDetail({ record }: { readonly record: HistoryRecordView }) {
  return (
    <section className="history-detail" data-testid="history-detail">
      <header className="tool-header">
        <h1 title={record.toolName}>{record.toolName}</h1>
        <RunStateBadge state={historyState(record.status)} />
      </header>
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
    </section>
  );
}

interface HistoryViewProps {
  readonly tools: readonly ToolView[];
  /** The tool to show, or undefined for every tool. */
  readonly toolId: string | undefined;
  /** Changes when a run may have ended, so that the list is read again. */
  readonly revision: unknown;
  readonly onToolId: (toolId: string | undefined) => void;
  readonly onError: (error: unknown) => void;
}

/** Past runs, which outlive their tools: a removed tool's runs stay here as evidence. */
export function HistoryView({ tools, toolId, revision, onToolId, onError }: HistoryViewProps) {
  const id = useId();
  const [runs, setRuns] = useState<readonly HistorySummaryView[] | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [record, setRecord] = useState<HistoryRecordView | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void api
      .listHistory(toolId)
      .then((list) => {
        if (current) {
          setRuns(list);
        }
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [toolId, revision, onError]);

  useEffect(() => {
    let current = true;
    if (selected !== undefined) {
      void api
        .getHistoryRun(selected)
        .then((found) => {
          if (current) {
            setRecord(found);
          }
        })
        .catch(onError);
    }
    return () => {
      current = false;
    };
  }, [selected, revision, onError]);

  return (
    <section className="history" data-testid="history">
      <div className="history-list">
        <h1>{t('history.title')}</h1>
        <div className="field">
          <label className="field-label" htmlFor={id}>
            {t('history.tool')}
          </label>
          <select
            id={id}
            value={toolId ?? ''}
            onChange={(event) => {
              onToolId(event.target.value === '' ? undefined : event.target.value);
            }}
          >
            <option value="">{t('history.allTools')}</option>
            {tools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name}
              </option>
            ))}
          </select>
        </div>
        {runs?.length === 0 ? <p className="muted">{t('history.empty')}</p> : null}
        <ul className="nav-list">
          {runs?.map((run) => (
            <li key={run.runId}>
              <button
                type="button"
                className="history-row"
                aria-current={run.runId === selected ? 'true' : undefined}
                onClick={() => {
                  setSelected(run.runId);
                }}
              >
                <RunStateIcon state={historyState(run.status)} />
                <span className="history-row-text">
                  <span className="truncate">{run.toolName}</span>
                  <span className="muted truncate">{formatTime(run.startedAt)}</span>
                </span>
                <span className="row-count">{formatDuration(run.durationMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {record === undefined || record.runId !== selected ? (
        <p className="muted history-hint">{t('history.pick')}</p>
      ) : (
        <RunDetail record={record} />
      )}
    </section>
  );
}

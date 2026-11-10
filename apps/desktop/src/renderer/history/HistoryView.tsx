import { useEffect, useId, useState } from 'react';
import { Workflow } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type {
  AutomationView,
  HistoryEntryView,
  HistoryRecordView,
  HistorySummaryView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { RunStateBadge, RunStateIcon } from '../shell/RunStateBadge.js';
import { AutomationRunDetail } from './AutomationRunDetail.js';
import { formatDuration, formatTime, historyState } from './history-format.js';
import { RunFacts } from './RunFacts.js';

const api = window.bildora;

/** What the list shows: everything, one tool's runs, or one automation's. */
export type HistoryFilter =
  | { readonly toolId?: undefined; readonly automationId?: undefined }
  | { readonly toolId: string; readonly automationId?: undefined }
  | { readonly toolId?: undefined; readonly automationId: string };

const TOOL_PREFIX = 'tool:';
const AUTOMATION_PREFIX = 'automation:';

function filterValue(filter: HistoryFilter): string {
  if (filter.toolId !== undefined) return `${TOOL_PREFIX}${filter.toolId}`;
  if (filter.automationId !== undefined) return `${AUTOMATION_PREFIX}${filter.automationId}`;
  return '';
}

function filterOf(value: string): HistoryFilter {
  if (value.startsWith(TOOL_PREFIX)) return { toolId: value.slice(TOOL_PREFIX.length) };
  if (value.startsWith(AUTOMATION_PREFIX)) {
    return { automationId: value.slice(AUTOMATION_PREFIX.length) };
  }
  return {};
}

/**
 * The automation a tool run was a step of, when the record of that automation run has gone: by its
 * current name while it exists, otherwise by the name it had then.
 */
function originOf(
  run: HistorySummaryView,
  automations: readonly AutomationView[],
): { readonly name: string; readonly id?: string } | undefined {
  const origin = run.automation;
  if (origin === undefined) {
    return undefined;
  }
  const current = automations.find((automation) => automation.id === origin.id);
  return current === undefined
    ? { name: origin.name ?? t('history.someAutomation') }
    : { name: current.name, id: current.id };
}

interface RunDetailProps {
  readonly record: HistoryRecordView;
  readonly automations: readonly AutomationView[];
  readonly onOpenAutomation: (id: string) => void;
}

function RunDetail({ record, automations, onOpenAutomation }: RunDetailProps) {
  const origin = originOf(record, automations);
  return (
    <section className="history-detail" data-testid="history-detail">
      <header className="tool-header">
        <h1 title={record.toolName}>{record.toolName}</h1>
        <RunStateBadge state={historyState(record.status)} />
      </header>
      <RunFacts record={record}>
        {origin === undefined ? null : (
          <>
            <dt>{t('history.automation')}</dt>
            <dd data-testid="history-automation">{origin.name}</dd>
          </>
        )}
      </RunFacts>
      {origin?.id === undefined ? null : (
        <div className="history-actions">
          <button
            type="button"
            onClick={() => {
              if (origin.id !== undefined) {
                onOpenAutomation(origin.id);
              }
            }}
          >
            {t('history.openAutomation')}
          </button>
        </div>
      )}
    </section>
  );
}

function EntryRow({
  entry,
  automations,
}: {
  readonly entry: HistoryEntryView;
  readonly automations: readonly AutomationView[];
}) {
  if (entry.kind === 'automation') {
    const name =
      automations.find((automation) => automation.id === entry.automationId)?.name ??
      entry.automationName;
    const time = formatTime(entry.startedAt);
    return (
      <>
        <RunStateIcon state={historyState(entry.status)} />
        <span className="history-row-text">
          <span className="history-row-name">
            <Workflow className="icon" aria-hidden="true" />
            <span className="truncate">{name}</span>
          </span>
          <span className="muted truncate">
            {t(entry.trigger === 'cli' ? 'history.automationRowCli' : 'history.automationRow', {
              time,
            })}
          </span>
        </span>
        <span className="row-count">{formatDuration(entry.durationMs)}</span>
      </>
    );
  }
  const origin = originOf(entry, automations);
  return (
    <>
      <RunStateIcon state={historyState(entry.status)} />
      <span className="history-row-text">
        <span className="truncate">{entry.toolName}</span>
        {origin === undefined ? null : (
          <span className="muted truncate" data-testid="history-row-automation">
            {t('history.inAutomation', { name: origin.name })}
          </span>
        )}
        <span className="muted truncate">{formatTime(entry.startedAt)}</span>
      </span>
      <span className="row-count">{formatDuration(entry.durationMs)}</span>
    </>
  );
}

interface HistoryViewProps {
  readonly tools: readonly ToolView[];
  readonly automations: readonly AutomationView[];
  readonly filter: HistoryFilter;
  /** Changes when a run may have ended, so that the list is read again. */
  readonly revision: unknown;
  readonly onFilter: (filter: HistoryFilter) => void;
  readonly onOpenAutomation: (id: string) => void;
  /** Opens an automation's tab on one of its past runs. */
  readonly onShowRun: (id: string, runId: string) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Past runs, which outlive their tools: a removed tool's runs stay here as evidence. An automation
 * run is one entry, standing for the tool runs it made.
 */
export function HistoryView({
  tools,
  automations,
  filter,
  revision,
  onFilter,
  onOpenAutomation,
  onShowRun,
  onError,
}: HistoryViewProps) {
  const id = useId();
  const [entries, setEntries] = useState<readonly HistoryEntryView[] | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [record, setRecord] = useState<HistoryRecordView | undefined>(undefined);
  const { toolId, automationId } = filter;
  const chosen = entries?.find((entry) => entry.runId === selected);

  useEffect(() => {
    let current = true;
    void api
      .listHistory({
        ...(toolId === undefined ? {} : { toolId }),
        ...(automationId === undefined ? {} : { automationId }),
      })
      .then((list) => {
        if (current) {
          setEntries(list);
        }
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [toolId, automationId, revision, onError]);

  const toolRunSelected = chosen?.kind === 'tool' ? chosen.runId : undefined;
  useEffect(() => {
    let current = true;
    if (toolRunSelected !== undefined) {
      void api
        .getHistoryRun(toolRunSelected)
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
  }, [toolRunSelected, revision, onError]);

  function detail() {
    if (chosen?.kind === 'automation') {
      return (
        <AutomationRunDetail
          key={`${chosen.runId}:${toolId ?? ''}`}
          entry={chosen}
          automation={automations.find((automation) => automation.id === chosen.automationId)}
          tools={tools}
          focusTool={toolId}
          revision={revision}
          onOpenAutomation={onOpenAutomation}
          onShowRun={onShowRun}
          onError={onError}
        />
      );
    }
    if (record === undefined || record.runId !== toolRunSelected) {
      return <p className="muted history-hint">{t('history.pick')}</p>;
    }
    return (
      <RunDetail record={record} automations={automations} onOpenAutomation={onOpenAutomation} />
    );
  }

  return (
    <section className="history" data-testid="history">
      <div className="history-list">
        <h1>{t('history.title')}</h1>
        <div className="field">
          <label className="field-label" htmlFor={id}>
            {t('history.show')}
          </label>
          <select
            id={id}
            value={filterValue(filter)}
            onChange={(event) => {
              onFilter(filterOf(event.target.value));
            }}
          >
            <option value="">{t('history.everything')}</option>
            {tools.length === 0 ? null : (
              <optgroup label={t('history.tools')}>
                {tools.map((tool) => (
                  <option key={tool.id} value={`${TOOL_PREFIX}${tool.id}`}>
                    {tool.name}
                  </option>
                ))}
              </optgroup>
            )}
            {automations.length === 0 ? null : (
              <optgroup label={t('history.automations')}>
                {automations.map((automation) => (
                  <option key={automation.id} value={`${AUTOMATION_PREFIX}${automation.id}`}>
                    {automation.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {entries?.length === 0 ? <p className="muted">{t('history.empty')}</p> : null}
        <ul className="nav-list">
          {entries?.map((entry) => (
            <li key={`${entry.kind}:${entry.runId}`}>
              <button
                type="button"
                className="history-row"
                data-kind={entry.kind}
                aria-current={entry.runId === selected ? 'true' : undefined}
                onClick={() => {
                  setSelected(entry.runId);
                }}
              >
                <EntryRow entry={entry} automations={automations} />
              </button>
            </li>
          ))}
        </ul>
      </div>
      {detail()}
    </section>
  );
}

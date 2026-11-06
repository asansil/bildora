import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Play, Square } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type {
  ParameterView,
  ProfileView,
  RunRequest,
  RunView,
  ToolView,
} from '../../shared/ipc-contract.js';
import { RunStateBadge } from '../shell/RunStateBadge.js';
import { ConsolePane } from './ConsolePane.js';
import type { ConsoleSize } from './ConsolePane.js';
import { ParameterForm } from './ParameterForm.js';
import { ProfileBar } from './ProfileBar.js';
import { RuntimeWarning, failureText } from './ToolDetails.js';
import { formProblems, initialValues, submittedValues } from './parameter-form.js';
import type { FormValue, FormValues } from './parameter-form.js';
import { summarizeRuns } from './run-state.js';

const api = window.bildora;
const NO_PARAMETERS: readonly ParameterView[] = [];

interface ToolRunnerProps {
  readonly tool: ToolView;
  readonly runs: readonly RunView[];
  readonly onRun: (request: RunRequest) => void;
  readonly onStop: (runId: string) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
  readonly onCheckAgain: () => void;
  readonly onHistory: () => void;
  readonly onError: (error: unknown) => void;
}

/** A level 1 tool in the work area: its generated form, saved profiles and live console. */
export function ToolRunner({
  tool,
  runs,
  onRun,
  onStop,
  onEdit,
  onRemove,
  onCheckAgain,
  onHistory,
  onError,
}: ToolRunnerProps) {
  const parameters = tool.parameters ?? NO_PARAMETERS;
  const [profiles, setProfiles] = useState<readonly ProfileView[]>([]);
  const [profileId, setProfileId] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<FormValues>(() => initialValues(parameters));
  const [forgotten, setForgotten] = useState<readonly string[]>([]);
  const [checked, setChecked] = useState(false);
  const consoleSize = useRef<ConsoleSize | undefined>(undefined);
  const rememberSize = useCallback((size: ConsoleSize) => {
    consoleSize.current = size;
  }, []);

  useEffect(() => {
    let current = true;
    void api
      .listProfiles(tool.id)
      .then((list) => {
        if (current) {
          setProfiles(list);
        }
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [tool.id, onError]);

  const summary = summarizeRuns(runs, tool.id);
  const [active] = summary.running;
  const isRunning = active !== undefined;
  const shownRun = active ?? summary.last;
  const profile = profiles.find((item) => item.id === profileId);
  const savedSecrets = (profile?.secrets ?? []).filter((name) => !forgotten.includes(name));
  const problems = formProblems(parameters, values, savedSecrets);
  const hasProblems = Object.keys(problems).length > 0;
  const failure = summary.last === undefined ? undefined : failureText(summary.last, tool);
  const runnable = tool.runtime.status === 'ready' && !isRunning;

  function chooseProfile(id: string | undefined): void {
    setProfileId(id);
    setForgotten([]);
    setChecked(false);
    setValues(
      initialValues(
        parameters,
        profiles.find((item) => item.id === id),
      ),
    );
  }

  function changeValue(name: string, value: FormValue): void {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function browse(name: string): void {
    void api
      .pickPath()
      .then((path) => {
        if (path !== undefined) {
          changeValue(name, path);
        }
      })
      .catch(onError);
  }

  function run(): void {
    setChecked(true);
    if (hasProblems) {
      return;
    }
    const { plain, secrets } = submittedValues(parameters, values);
    const size = consoleSize.current;
    onRun({
      values: { ...plain, ...secrets },
      ...(profileId === undefined ? {} : { profileId }),
      ...(size === undefined ? {} : size),
    });
  }

  /** Stores the form. Typed secrets go to the credential store, and leave the page for good. */
  function save(target: { id?: string; name: string }): void {
    const { plain, secrets } = submittedValues(parameters, values);
    const cleared = Object.fromEntries(forgotten.map((name) => [name, null]));
    void api
      .saveProfile({
        toolId: tool.id,
        ...target,
        values: plain,
        secrets: { ...cleared, ...secrets },
      })
      .then(async (saved) => {
        setProfiles(await api.listProfiles(tool.id));
        setProfileId(saved.id);
        setForgotten([]);
        setValues((current) => ({
          ...current,
          ...Object.fromEntries(Object.keys(secrets).map((name) => [name, ''])),
        }));
      })
      .catch(onError);
  }

  function removeProfile(): void {
    if (profile !== undefined) {
      void api
        .removeProfile(tool.id, profile.id)
        .then(async () => {
          setProfiles(await api.listProfiles(tool.id));
          setProfileId(undefined);
        })
        .catch(onError);
    }
  }

  return (
    <article className="tool tool-runner" data-testid="tool-runner">
      <header className="tool-header">
        <h1 title={tool.name}>{tool.name}</h1>
        <RunStateBadge state={summary.state} />
      </header>
      {tool.description === undefined ? null : (
        <p className="tool-description">{tool.description}</p>
      )}
      {tool.runtime.status === 'ready' ? null : (
        <RuntimeWarning runtime={tool.runtime} onCheckAgain={onCheckAgain} />
      )}

      <ProfileBar
        profiles={profiles}
        selected={profileId}
        disabled={isRunning}
        onSelect={chooseProfile}
        onSave={() => {
          if (profile !== undefined) {
            save({ id: profile.id, name: profile.name });
          }
        }}
        onSaveAs={(name) => {
          save({ name });
        }}
        onRemove={removeProfile}
      />

      <ParameterForm
        parameters={parameters}
        values={values}
        problems={checked ? problems : {}}
        savedSecrets={savedSecrets}
        disabled={isRunning}
        onChange={changeValue}
        onBrowse={browse}
        onForget={(name) => {
          setForgotten((current) => [...current, name]);
        }}
      />

      <div className="actions">
        <button type="button" className="primary" disabled={!runnable} onClick={run}>
          <Play className="icon" aria-hidden="true" />
          {t('runner.run')}
        </button>
        <button
          type="button"
          disabled={!isRunning}
          onClick={() => {
            if (active !== undefined) {
              onStop(active.runId);
            }
          }}
        >
          <Square className="icon" aria-hidden="true" />
          {t('tool.stop')}
        </button>
        <button type="button" onClick={onHistory}>
          <History className="icon" aria-hidden="true" />
          {t('runner.history')}
        </button>
        <button type="button" onClick={onEdit}>
          {t('tool.edit')}
        </button>
        <button type="button" disabled={isRunning} onClick={onRemove}>
          {t('tool.remove')}
        </button>
      </div>

      {active === undefined ? null : (
        <div className="run-progress" data-testid="run-progress">
          <progress
            max={100}
            aria-label={t('runner.progress')}
            {...(active.progress?.percent === undefined ? {} : { value: active.progress.percent })}
          />
          <span className="truncate">
            {active.progress?.message ??
              (active.progress?.percent === undefined
                ? t('state.running')
                : t('runner.percent', { percent: Math.round(active.progress.percent) }))}
          </span>
        </div>
      )}
      {failure === undefined || isRunning ? null : (
        <div className="notice notice-failed" role="status" data-testid="run-failure">
          <p>{failure}</p>
        </div>
      )}

      <ConsolePane runId={shownRun?.runId} running={isRunning} onSize={rememberSize} />
    </article>
  );
}

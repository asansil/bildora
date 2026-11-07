import type { RunHistory } from '../history/run-history.js';
import { getProfile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { ParameterValues } from '../runner/command-line.js';
import type { RunProgress } from '../runner/progress-lines.js';
import { startRecordedRun } from '../runner/recorded-run.js';
import type { RecordedToolRun } from '../runner/recorded-run.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { readPathVariables } from '../storage/path-variables.js';
import { DEFAULT_PREFERENCES, readPreferences } from '../storage/preferences.js';

export interface ToolStarterContext {
  readonly dataDir: string;
  readonly history: RunHistory;
  readonly store: SecretStore;
}

export interface ToolStartRequest {
  readonly workspaceId: string;
  readonly runId?: string | undefined;
  readonly automationRunId?: string | undefined;
  readonly profileId?: string | undefined;
  readonly values?: ParameterValues | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  readonly onOutput?: ((data: string) => void) | undefined;
  readonly onProgress?: ((progress: RunProgress) => void) | undefined;
}

/**
 * Starts a tool the way every client does: what a run needs from the data directory is read here,
 * so the desktop app and the CLI cannot differ. A profile that has gone throws.
 */
export async function startToolRun(
  tool: RegisteredTool,
  request: ToolStartRequest,
  { dataDir, history, store }: ToolStarterContext,
): Promise<RecordedToolRun> {
  const { profileId, runId, automationRunId, columns, rows } = request;
  const { historyRunLimit } = await readPreferences(dataDir).catch(() => DEFAULT_PREFERENCES);
  const profile = profileId === undefined ? undefined : await getProfile(tool, profileId);
  if (profileId !== undefined && profile === undefined) {
    throw new Error('The chosen profile no longer exists');
  }
  return startRecordedRun(tool, {
    history,
    store,
    historyRunLimit,
    workspaceId: request.workspaceId,
    pathVariables: await readPathVariables(dataDir).catch(() => undefined),
    profile,
    values: request.values,
    automationRunId,
    ...(runId === undefined ? {} : { runId }),
    ...(columns === undefined ? {} : { columns }),
    ...(rows === undefined ? {} : { rows }),
    ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
  });
}

import type { ToolParameter } from '@bildora/protocol';
import { isSecretParameter, readProfileSecrets } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { SecretStore } from '../secrets/secret-store.js';
import type { ParameterValue, ParameterValues } from './command-line.js';
import { expandPath } from './expand-paths.js';
import type { PathVariables } from './expand-paths.js';

/** A parameter as run history shows it. A secret records only that it was set. */
export interface RecordedParameter {
  readonly name: string;
  readonly label: string;
  readonly value?: ParameterValue;
  readonly secret?: true;
}

export interface ResolvedValues {
  readonly values: ParameterValues;
  /** The secret values in this run, so that they can be kept out of what is recorded. */
  readonly secrets: readonly string[];
  readonly recorded: readonly RecordedParameter[];
}

export interface ValueSources {
  readonly profile?: Profile | undefined;
  readonly values?: ParameterValues | undefined;
  readonly store: SecretStore;
  readonly pathVariables?: PathVariables | undefined;
}

function recordedParameter(
  parameter: ToolParameter,
  value: ParameterValue | undefined,
): RecordedParameter {
  const { name, label } = parameter;
  if (isSecretParameter(parameter)) {
    return value === undefined || value === '' ? { name, label } : { name, label, secret: true };
  }
  const shown = value ?? parameter.default;
  return shown === undefined ? { name, label } : { name, label, value: shown };
}

/**
 * Works out what a run receives: a value typed in the form wins over the profile, which wins over
 * the default. A profile can hold values of parameters a newer manifest no longer declares, and
 * those are left out rather than failing the run.
 */
export async function resolveRunValues(
  tool: RegisteredTool,
  sources: ValueSources,
): Promise<ResolvedValues> {
  const parameters = tool.manifest.level === 0 ? [] : tool.manifest.parameters;
  const { profile, store } = sources;
  const profileSecrets =
    profile === undefined ? {} : await readProfileSecrets(tool, profile, store);

  const fromProfile: ParameterValues = { ...profile?.values, ...profileSecrets };
  const values: Record<string, ParameterValue> = {};
  for (const parameter of parameters) {
    const value = fromProfile[parameter.name];
    if (value !== undefined) {
      values[parameter.name] = value;
    }
  }
  // Unknown names stay in, because a form asking for one is a mistake the runner must report.
  Object.assign(values, sources.values);

  // Only paths expand: any other text is the user's, and may hold these characters on purpose.
  for (const parameter of parameters.filter(({ type }) => type === 'path')) {
    const value = values[parameter.name] ?? parameter.default;
    if (typeof value === 'string') {
      const expanded = expandPath(value, sources.pathVariables ?? new Map<string, string>());
      if (expanded !== value) {
        values[parameter.name] = expanded;
      }
    }
  }

  const secrets = parameters.flatMap((parameter) => {
    const value = values[parameter.name];
    return isSecretParameter(parameter) && typeof value === 'string' && value !== '' ? [value] : [];
  });
  return {
    values,
    secrets,
    recorded: parameters.map((parameter) => recordedParameter(parameter, values[parameter.name])),
  };
}

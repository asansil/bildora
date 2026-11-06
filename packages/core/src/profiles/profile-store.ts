import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidIdentifier } from '@bildora/protocol';
import type { ToolParameter } from '@bildora/protocol';
import { parse, stringify } from 'yaml';
import { identifierFromName } from '../import/identifier.js';
import type { RegisteredTool } from '../registry/tool-registry.js';
import type { ParameterValue, ParameterValues } from '../runner/command-line.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { isMissingFile, writeFileAtomic } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';
import { migrateDefinition } from '../storage/migrations.js';
import type { VersionedFormat } from '../storage/migrations.js';

const PROFILES_FOLDER = 'profiles';
const PROFILE_EXTENSION = '.yaml';
const format: VersionedFormat = {
  label: 'profile',
  versionField: 'formatVersion',
  currentVersion: 1,
  migrations: [],
};

/** A saved set of values for a tool. Secrets stay in the credential store, named here only. */
export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly values: ParameterValues;
  /** Parameters with a value in the credential store. */
  readonly secrets: readonly string[];
}

export interface ProfileInput {
  /** Absent for a new profile. */
  readonly id?: string | undefined;
  readonly name: string;
  readonly values: ParameterValues;
  /** New secret values. A secret left out keeps what it has, and `null` clears it. */
  readonly secrets?: Readonly<Record<string, string | null>> | undefined;
}

function profilesFolder(tool: RegisteredTool): string {
  return join(tool.directory, PROFILES_FOLDER);
}

function profileFile(tool: RegisteredTool, id: string): string {
  if (!isValidIdentifier(id)) {
    throw new DefinitionError(`Profile id "${id}" is not valid`);
  }
  return join(profilesFolder(tool), `${id}${PROFILE_EXTENSION}`);
}

/** Where one secret of a profile is stored. Tool and profile ids hold no `/`, so keys cannot clash. */
export function profileSecretKey(toolId: string, profileId: string, parameter: string): string {
  return `${toolId}/${profileId}/${parameter}`;
}

function isParameterValue(value: unknown): value is ParameterValue {
  return ['string', 'number', 'boolean'].includes(typeof value);
}

function parseProfile(id: string, text: string): Profile {
  const content: unknown = parse(text);
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new DefinitionError('The profile must be a YAML mapping');
  }
  const { name, values, secrets } = migrateDefinition({ ...content }, format);
  if (typeof name !== 'string' || name === '') {
    throw new DefinitionError('The profile has no name');
  }
  const storedValues = typeof values === 'object' && values !== null ? values : {};
  return {
    id,
    name,
    values: Object.fromEntries(
      Object.entries(storedValues).filter((entry): entry is [string, ParameterValue] =>
        isParameterValue(entry[1]),
      ),
    ),
    secrets: Array.isArray(secrets)
      ? secrets.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/** Lists a tool's profiles by name. A damaged file is passed over: it must not stop the tool. */
export async function listProfiles(tool: RegisteredTool): Promise<readonly Profile[]> {
  let files: string[];
  try {
    files = await readdir(profilesFolder(tool));
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
  const profiles: Profile[] = [];
  for (const file of files.filter((name) => name.endsWith(PROFILE_EXTENSION))) {
    try {
      const id = file.slice(0, -PROFILE_EXTENSION.length);
      profiles.push(parseProfile(id, await readFile(profileFile(tool, id), 'utf8')));
    } catch {
      continue;
    }
  }
  return profiles.sort((first, second) => first.name.localeCompare(second.name));
}

export async function getProfile(tool: RegisteredTool, id: string): Promise<Profile | undefined> {
  try {
    return parseProfile(id, await readFile(profileFile(tool, id), 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function parametersOf(tool: RegisteredTool): readonly ToolParameter[] {
  return tool.manifest.level === 0 ? [] : tool.manifest.parameters;
}

export function isSecretParameter(parameter: ToolParameter): boolean {
  return parameter.type === 'string' && parameter.secret;
}

function uniqueProfileId(name: string, taken: readonly Profile[]): string {
  const base = identifierFromName(name);
  const ids = new Set(taken.map((profile) => profile.id));
  let candidate = base;
  for (let suffix = 2; ids.has(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/**
 * Creates or changes a profile. Values go by what the manifest declares, so a secret sent as a
 * plain value can never end up in the file, however the caller got it wrong.
 */
export async function saveProfile(
  tool: RegisteredTool,
  input: ProfileInput,
  store: SecretStore,
): Promise<Profile> {
  const parameters = parametersOf(tool);
  const existing = await listProfiles(tool);
  const id = input.id ?? uniqueProfileId(input.name, existing);
  const previous = existing.find((profile) => profile.id === id);
  if (input.id !== undefined && previous === undefined) {
    throw new DefinitionError(`Profile "${input.id}" does not exist`);
  }

  const values = Object.fromEntries(
    Object.entries(input.values).filter(([name]) => {
      const parameter = parameters.find((candidate) => candidate.name === name);
      return parameter !== undefined && !isSecretParameter(parameter);
    }),
  );

  const secrets = new Set(previous?.secrets ?? []);
  for (const parameter of parameters.filter(isSecretParameter)) {
    const value = input.secrets?.[parameter.name];
    const key = profileSecretKey(tool.manifest.id, id, parameter.name);
    if (value === null) {
      await store.delete(key);
      secrets.delete(parameter.name);
    } else if (value !== undefined && value !== '') {
      await store.set(key, value);
      secrets.add(parameter.name);
    }
  }

  const profile: Profile = { id, name: input.name.trim(), values, secrets: [...secrets].sort() };
  await mkdir(profilesFolder(tool), { recursive: true });
  await writeFileAtomic(
    profileFile(tool, id),
    stringify({
      formatVersion: format.currentVersion,
      name: profile.name,
      values: profile.values,
      secrets: profile.secrets,
    }),
  );
  return profile;
}

/** Removes a profile and its secrets. */
export async function removeProfile(
  tool: RegisteredTool,
  id: string,
  store: SecretStore,
): Promise<void> {
  const profile = await getProfile(tool, id);
  for (const parameter of profile?.secrets ?? []) {
    await store.delete(profileSecretKey(tool.manifest.id, id, parameter));
  }
  await rm(profileFile(tool, id), { force: true });
}

/** Reads the secrets a profile holds, for a run. They go no further than the process it starts. */
export async function readProfileSecrets(
  tool: RegisteredTool,
  profile: Profile,
  store: SecretStore,
): Promise<Readonly<Record<string, string>>> {
  const values: Record<string, string> = {};
  for (const parameter of profile.secrets) {
    const value = await store.get(profileSecretKey(tool.manifest.id, profile.id, parameter));
    if (value !== undefined) {
      values[parameter] = value;
    }
  }
  return values;
}

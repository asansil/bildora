import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidIdentifier } from '@bildora/protocol';
import { parse, stringify } from 'yaml';
import { identifierFromName } from '../import/identifier.js';
import {
  isMissingFile,
  workspaceDirectory,
  workspacesDirectory,
  writeFileAtomic,
} from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';
import { migrateDefinition } from '../storage/migrations.js';
import type { DefinitionDocument, VersionedFormat } from '../storage/migrations.js';
import { DEFAULT_PREFERENCES, isTheme, readPreferences } from '../storage/preferences.js';
import type { Theme } from '../storage/preferences.js';

export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_WORKSPACE_NAME = 'Default';
export const WORKSPACE_NAME_MAX_LENGTH = 80;
export const PANEL_WIDTH_MIN = 180;
export const PANEL_WIDTH_MAX = 480;
export const WORKSPACE_TABS_MAX = 100;

const WORKSPACE_FILE = 'workspace.yaml';

export type WorkspaceTabKind = 'tool' | 'automation' | 'history';

/** What a work area tab shows. History has one tab, so it carries no id. */
export interface WorkspaceTab {
  readonly kind: WorkspaceTabKind;
  /** The tool or automation id. Absent for History. */
  readonly id?: string;
  /** Marks the one tab that the next single click in a panel replaces. */
  readonly preview?: boolean;
}

/** Names a tab uniquely within a Workspace, as `tool:<id>`, `automation:<id>` or `history`. */
export function workspaceTabKey(tab: Pick<WorkspaceTab, 'kind' | 'id'>): string {
  return tab.kind === 'history' ? 'history' : `${tab.kind}:${tab.id ?? ''}`;
}

/** Version 1 kept one `selectedTool`. Version 2 keeps tabs, and that tool becomes a pinned one. */
function tabsFromSelectedTool(document: DefinitionDocument): DefinitionDocument {
  const { layout } = document;
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
    return document;
  }
  const { selectedTool, ...rest }: Record<string, unknown> = { ...layout };
  if (typeof selectedTool !== 'string' || selectedTool === '') {
    return { ...document, layout: rest };
  }
  const tab = { kind: 'tool', id: selectedTool } as const;
  return { ...document, layout: { ...rest, tabs: [tab], activeTab: workspaceTabKey(tab) } };
}

const format: VersionedFormat = {
  label: 'Workspace definition',
  versionField: 'formatVersion',
  currentVersion: 2,
  migrations: [{ from: 1, migrate: tabsFromSelectedTool }],
};

export interface WorkspaceLayout {
  /** Category keys in rail order. A key with no category now stays, for when one returns. */
  readonly categoryOrder: readonly string[];
  readonly panelWidth?: number;
  /** The category whose panel was open, restored when switching but not when the app starts. */
  readonly openCategory?: string;
  /** Work area tabs in the order shown. The shell drops a tab whose item is gone. */
  readonly tabs: readonly WorkspaceTab[];
  /** The key of the active tab, always one of `tabs`. */
  readonly activeTab?: string;
  /** The tool id the History tab is filtered by. */
  readonly historyFilter?: string;
  /** Ids of the tools whose form answers their console script, absent when there are none. */
  readonly scriptAnswers?: readonly string[];
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly theme: Theme;
  /** Tool ids. One with no tool now is passed over, so that a reinstall brings it back. */
  readonly favorites: readonly string[];
  readonly layout: WorkspaceLayout;
}

/** A tab as a caller hands it over, where a field left out may also be spelled `undefined`. */
export interface TabChange {
  readonly kind: WorkspaceTabKind;
  readonly id?: string | undefined;
  readonly preview?: boolean | undefined;
}

/** A layout change. `null` clears a field, and a field left out stays as it is. */
export interface LayoutChanges {
  readonly categoryOrder?: readonly string[] | undefined;
  readonly panelWidth?: number | undefined;
  readonly openCategory?: string | null | undefined;
  /** Replaces every tab. Broken or repeated tabs are dropped, as when reading. */
  readonly tabs?: readonly TabChange[] | undefined;
  readonly activeTab?: string | null | undefined;
  readonly historyFilter?: string | null | undefined;
  /** Replaces the list. An empty one clears it. */
  readonly scriptAnswers?: readonly string[] | undefined;
}

export interface WorkspaceChanges {
  readonly name?: string | undefined;
  readonly theme?: Theme | undefined;
  readonly favorites?: readonly string[] | undefined;
  readonly layout?: LayoutChanges | undefined;
}

/** A stored Workspace that cannot be used. It never hides the healthy ones around it. */
export interface WorkspaceProblem {
  readonly folder: string;
  readonly message: string;
}

export interface WorkspaceList {
  /** Sorted by name. */
  readonly workspaces: readonly Workspace[];
  readonly problems: readonly WorkspaceProblem[];
}

function workspaceFile(dataDir: string, id: string): string {
  return join(workspaceDirectory(dataDir, id), WORKSPACE_FILE);
}

function stringsIn(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Tool ids with no repeats, or nothing when there are none. */
function scriptAnswersOf(ids: readonly string[]): { scriptAnswers?: readonly string[] } {
  const unique = [...new Set(ids)];
  return unique.length === 0 ? {} : { scriptAnswers: unique };
}

function isPanelWidth(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PANEL_WIDTH_MIN &&
    value <= PANEL_WIDTH_MAX
  );
}

function tabOf(value: unknown): WorkspaceTab | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { kind, id, preview }: Record<string, unknown> = { ...value };
  const flag = preview === true ? { preview: true } : {};
  if (kind === 'history') {
    return { kind, ...flag };
  }
  if ((kind === 'tool' || kind === 'automation') && typeof id === 'string' && id !== '') {
    return { kind, id, ...flag };
  }
  return undefined;
}

/**
 * Keeps tabs that make sense together: one per item, at most one preview tab, and no more than
 * the limit. Whatever breaks those rules is dropped or pinned rather than refused.
 */
function cleanTabs(values: readonly unknown[]): WorkspaceTab[] {
  const seen = new Set<string>();
  const tabs: WorkspaceTab[] = [];
  let previewTaken = false;
  for (const value of values) {
    const tab = tabOf(value);
    if (tab === undefined || seen.has(workspaceTabKey(tab))) {
      continue;
    }
    seen.add(workspaceTabKey(tab));
    const keepsPreview: boolean = tab.preview === true && !previewTaken;
    previewTaken ||= keepsPreview;
    tabs.push({
      kind: tab.kind,
      ...(tab.id === undefined ? {} : { id: tab.id }),
      ...(keepsPreview ? { preview: true } : {}),
    });
    if (tabs.length === WORKSPACE_TABS_MAX) {
      break;
    }
  }
  return tabs;
}

/** Adds the tabs, keeping the active one only if it names one of them. */
function withTabs(
  base: Omit<WorkspaceLayout, 'tabs' | 'activeTab'>,
  tabs: readonly WorkspaceTab[],
  activeTab: unknown,
): WorkspaceLayout {
  const known =
    typeof activeTab === 'string' && tabs.some((tab) => workspaceTabKey(tab) === activeTab);
  return { ...base, tabs, ...(known ? { activeTab } : {}) };
}

function layoutOf(value: unknown): WorkspaceLayout {
  if (typeof value !== 'object' || value === null) {
    return { categoryOrder: [], tabs: [] };
  }
  const fields: Record<string, unknown> = { ...value };
  const { categoryOrder, panelWidth, openCategory, tabs, activeTab, historyFilter } = fields;
  const { scriptAnswers } = fields;
  return withTabs(
    {
      categoryOrder: stringsIn(categoryOrder),
      ...(isPanelWidth(panelWidth) ? { panelWidth } : {}),
      ...(typeof openCategory === 'string' ? { openCategory } : {}),
      ...(typeof historyFilter === 'string' ? { historyFilter } : {}),
      ...scriptAnswersOf(stringsIn(scriptAnswers)),
    },
    cleanTabs(Array.isArray(tabs) ? tabs : []),
    activeTab,
  );
}

function parseWorkspace(id: string, text: string): Workspace {
  const content: unknown = parse(text);
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new DefinitionError(`${WORKSPACE_FILE} must be a YAML mapping`);
  }
  const { name, theme, favorites, layout } = migrateDefinition({ ...content }, format);
  if (typeof name !== 'string' || name.trim() === '') {
    throw new DefinitionError(`${WORKSPACE_FILE} has no name`);
  }
  return {
    id,
    name,
    theme: isTheme(theme) ? theme : DEFAULT_PREFERENCES.theme,
    favorites: stringsIn(favorites),
    layout: layoutOf(layout),
  };
}

async function writeWorkspace(dataDir: string, workspace: Workspace): Promise<void> {
  const { id, ...fields } = workspace;
  await mkdir(workspaceDirectory(dataDir, id), { recursive: true });
  await writeFileAtomic(
    workspaceFile(dataDir, id),
    stringify({ formatVersion: format.currentVersion, ...fields }),
  );
}

async function workspaceFolders(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(workspacesDirectory(dataDir), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

/** Finds a Workspace. One that exists but cannot be read throws, with the reason. */
export async function getWorkspace(dataDir: string, id: string): Promise<Workspace | undefined> {
  let text: string;
  try {
    text = await readFile(workspaceFile(dataDir, id), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  return parseWorkspace(id, text);
}

export async function listWorkspaces(dataDir: string): Promise<WorkspaceList> {
  const workspaces: Workspace[] = [];
  const problems: WorkspaceProblem[] = [];
  for (const folder of await workspaceFolders(dataDir)) {
    try {
      const workspace = isValidIdentifier(folder) ? await getWorkspace(dataDir, folder) : undefined;
      if (workspace === undefined) {
        problems.push({ folder, message: `No readable ${WORKSPACE_FILE} in this folder` });
      } else {
        workspaces.push(workspace);
      }
    } catch (error) {
      problems.push({ folder, message: error instanceof Error ? error.message : String(error) });
    }
  }
  workspaces.sort((first, second) => first.name.localeCompare(second.name));
  return { workspaces, problems };
}

function uniqueWorkspaceId(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

function normalizedName(name: string): string {
  return name.toLocaleLowerCase('en');
}

function checkedName(name: string, others: readonly Workspace[], self?: string): string {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new DefinitionError(
      `A Workspace name needs 1 to ${String(WORKSPACE_NAME_MAX_LENGTH)} characters`,
    );
  }
  const clash = others.find(
    ({ id, name: other }) => id !== self && normalizedName(other) === normalizedName(trimmed),
  );
  if (clash !== undefined) {
    throw new DefinitionError(`A Workspace named "${clash.name}" already exists`);
  }
  return trimmed;
}

/** Creates an empty Workspace. A damaged folder still holds its id, so it is never overwritten. */
export async function createWorkspace(
  dataDir: string,
  name: string,
  theme: Theme,
): Promise<Workspace> {
  const { workspaces } = await listWorkspaces(dataDir);
  const checked = checkedName(name, workspaces);
  const taken = new Set(await workspaceFolders(dataDir));
  const workspace: Workspace = {
    id: uniqueWorkspaceId(identifierFromName(checked), taken),
    name: checked,
    theme,
    favorites: [],
    layout: { categoryOrder: [], tabs: [] },
  };
  await writeWorkspace(dataDir, workspace);
  return workspace;
}

/**
 * Lists the Workspaces, making sure there is one to work in. The first one takes the theme chosen
 * before Workspaces existed. The history of those days goes to it too, through the default id.
 */
export async function openWorkspaces(dataDir: string): Promise<WorkspaceList> {
  const list = await listWorkspaces(dataDir);
  if (list.workspaces.length > 0) {
    return list;
  }
  const { theme } = await readPreferences(dataDir).catch(() => DEFAULT_PREFERENCES);
  const workspace: Workspace = {
    id: uniqueWorkspaceId(DEFAULT_WORKSPACE_ID, new Set(await workspaceFolders(dataDir))),
    name: DEFAULT_WORKSPACE_NAME,
    theme,
    favorites: [],
    layout: { categoryOrder: [], tabs: [] },
  };
  await writeWorkspace(dataDir, workspace);
  return { workspaces: [workspace], problems: list.problems };
}

/** A change wins over what is stored, and `null` clears the field. */
function merged<T>(stored: T | undefined, change: T | null | undefined): T | undefined {
  return change === null ? undefined : (change ?? stored);
}

function changedLayout(layout: WorkspaceLayout, changes: LayoutChanges): WorkspaceLayout {
  const { categoryOrder = layout.categoryOrder, panelWidth = layout.panelWidth } = changes;
  const openCategory = merged(layout.openCategory, changes.openCategory);
  const historyFilter = merged(layout.historyFilter, changes.historyFilter);
  return withTabs(
    {
      categoryOrder,
      ...(panelWidth === undefined ? {} : { panelWidth }),
      ...(openCategory === undefined ? {} : { openCategory }),
      ...(historyFilter === undefined ? {} : { historyFilter }),
      ...scriptAnswersOf(changes.scriptAnswers ?? layout.scriptAnswers ?? []),
    },
    changes.tabs === undefined ? layout.tabs : cleanTabs(changes.tabs),
    merged(layout.activeTab, changes.activeTab),
  );
}

/** Changes a Workspace, refusing to replace one written by a newer build. */
export async function updateWorkspace(
  dataDir: string,
  id: string,
  changes: WorkspaceChanges,
): Promise<Workspace> {
  const current = await getWorkspace(dataDir, id);
  if (current === undefined) {
    throw new DefinitionError(`Workspace "${id}" does not exist`);
  }
  const { name, theme, favorites, layout } = changes;
  const others = name === undefined ? [] : (await listWorkspaces(dataDir)).workspaces;
  const updated: Workspace = {
    ...current,
    ...(name === undefined ? {} : { name: checkedName(name, others, id) }),
    ...(theme === undefined ? {} : { theme }),
    ...(favorites === undefined ? {} : { favorites }),
    ...(layout === undefined ? {} : { layout: changedLayout(current.layout, layout) }),
  };
  await writeWorkspace(dataDir, updated);
  return updated;
}

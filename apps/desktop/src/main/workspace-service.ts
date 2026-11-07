import {
  createWorkspace,
  getWorkspace,
  openWorkspaces,
  readPreferences,
  removeWorkspace,
  updateWorkspace,
  writePreferences,
} from '@bildora/core';
import type {
  RunHistory,
  SecretStore,
  ToolRegistry,
  Workspace,
  WorkspaceChanges,
} from '@bildora/core';
import type { WorkspaceListView, WorkspaceView } from '../shared/ipc-contract.js';

/** Finds the Workspace to open with: the last one used, or the first if that one is gone. */
async function chooseActive(dataDir: string): Promise<Workspace> {
  const { workspaces } = await openWorkspaces(dataDir);
  const { activeWorkspaceId } = await readPreferences(dataDir).catch(() => ({
    activeWorkspaceId: undefined,
  }));
  const [first] = workspaces;
  const active = workspaces.find(({ id }) => id === activeWorkspaceId) ?? first;
  if (active === undefined) {
    throw new Error('No Workspace could be opened');
  }
  return active;
}

/**
 * Which Workspace the shell is in. Rules stay in core; this only remembers where the user is.
 * Changes run one at a time: each reads a file and writes it back, so two at once would lose one,
 * and a change finishing after a switch would bring the previous Workspace back.
 */
export class WorkspaceService {
  private readonly dataDir: string;
  private readonly registry: ToolRegistry;
  private readonly secrets: SecretStore;
  private readonly history: RunHistory;
  private active: Workspace;
  private lastChange: Promise<unknown> = Promise.resolve();

  private constructor(
    dataDir: string,
    registry: ToolRegistry,
    secrets: SecretStore,
    history: RunHistory,
    active: Workspace,
  ) {
    this.dataDir = dataDir;
    this.registry = registry;
    this.secrets = secrets;
    this.history = history;
    this.active = active;
  }

  static async open(
    registry: ToolRegistry,
    secrets: SecretStore,
    history: RunHistory,
  ): Promise<WorkspaceService> {
    const { dataDir } = registry;
    const active = await chooseActive(dataDir);
    return new WorkspaceService(dataDir, registry, secrets, history, active);
  }

  get activeId(): string {
    return this.active.id;
  }

  /** The active Workspace as it was last read or written. */
  get current(): WorkspaceView {
    return this.active;
  }

  private inTurn<Result>(change: () => Promise<Result>): Promise<Result> {
    const result = this.lastChange.then(change, change);
    this.lastChange = result.catch(() => undefined);
    return result;
  }

  private async enter(id: string): Promise<void> {
    const workspace = await getWorkspace(this.dataDir, id);
    if (workspace === undefined) {
      throw new Error(`Workspace "${id}" does not exist`);
    }
    await writePreferences(this.dataDir, { activeWorkspaceId: id });
    this.active = workspace;
  }

  private async read(): Promise<WorkspaceListView> {
    const { workspaces, problems } = await openWorkspaces(this.dataDir);
    return { activeId: this.active.id, workspaces, problems };
  }

  /** Waits for its turn too, so that it reflects every change asked for before it. */
  list(): Promise<WorkspaceListView> {
    return this.inTurn(() => this.read());
  }

  switchTo(id: string): Promise<WorkspaceListView> {
    return this.inTurn(async () => {
      await this.enter(id);
      return this.read();
    });
  }

  /** Creates a Workspace with the current look, and opens it. */
  create(name: string): Promise<WorkspaceListView> {
    return this.inTurn(async () => {
      const workspace = await createWorkspace(this.dataDir, name, this.active.theme);
      await this.enter(workspace.id);
      return this.read();
    });
  }

  rename(id: string, name: string): Promise<WorkspaceListView> {
    return this.inTurn(async () => {
      const workspace = await updateWorkspace(this.dataDir, id, { name });
      if (id === this.active.id) {
        this.active = workspace;
      }
      return this.read();
    });
  }

  /** Changes the active Workspace. */
  update(changes: WorkspaceChanges): Promise<WorkspaceView> {
    return this.inTurn(async () => {
      this.active = await updateWorkspace(this.dataDir, this.active.id, changes);
      return this.active;
    });
  }

  /** Deletes a Workspace. Deleting the active one opens another first. */
  remove(id: string): Promise<WorkspaceListView> {
    return this.inTurn(async () => {
      const { workspaces } = await openWorkspaces(this.dataDir);
      const other = workspaces.find((workspace) => workspace.id !== id);
      if (workspaces.length > 1 && id === this.active.id && other !== undefined) {
        await this.enter(other.id);
      }
      await removeWorkspace(this.registry, id, this.secrets, this.history);
      return this.read();
    });
  }
}

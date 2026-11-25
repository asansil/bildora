import type {
  AutomationDraft,
  AutomationListView,
  AutomationProblemView,
  AutomationRunRecordView,
  ScheduleStatusView,
  AutomationRunStateView,
  AutomationView,
  DetectionView,
  EditCommand,
  HistoryAutomationRunView,
  HistoryEntryView,
  HistoryRecordView,
  LayoutUpdate,
  PathVariableView,
  ProfileView,
  RegisterTools,
  RegistrationView,
  RunOutputView,
  RunRequest,
  RunView,
  SaveProfileInput,
  ShellInfo,
  ShellPreferences,
  ShellPreferencesChange,
  ToolCatalog,
  ToolDetailsInput,
  ToolScopeChoice,
  WorkspaceListView,
  WorkspaceUpdate,
  WorkspaceView,
} from '../shared/ipc-contract.js';

/** The only surface the renderer can reach. Every addition is reviewed as a public API. */
export interface ShellApi {
  readonly platform: string;
  shellInfo(): Promise<ShellInfo>;
  quit(): Promise<void>;
  edit(command: EditCommand): Promise<void>;
  /** Asks the user for a file, for a path field of a form. */
  pickPath(): Promise<string | undefined>;
  listTools(): Promise<ToolCatalog>;
  pickFiles(): Promise<DetectionView | undefined>;
  pickFolder(recursive: boolean): Promise<DetectionView | undefined>;
  detectPaths(paths: readonly string[]): Promise<DetectionView>;
  /** Finds a dropped file's path, which a sandboxed page cannot read by itself. */
  pathForFile(file: File): string;
  registerTools(input: RegisterTools): Promise<RegistrationView>;
  importManifests(paths: readonly string[], scope: ToolScopeChoice): Promise<RegistrationView>;
  updateTool(id: string, details: ToolDetailsInput): Promise<void>;
  removeTool(id: string): Promise<void>;
  /** Moves a tool between Global and the active Workspace, with its profiles and secrets. */
  setToolScope(id: string, scope: ToolScopeChoice): Promise<void>;
  /** The icon Windows shows for the tool's program, as a PNG data URL, or nothing. */
  toolIcon(id: string): Promise<string | undefined>;
  /** Offers to move a category or change its logo, and tells whether anything changed. */
  openCategoryMenu(category: string): Promise<boolean>;
  startRun(toolId: string, request?: RunRequest): Promise<RunView>;
  cancelRun(runId: string): Promise<void>;
  listRuns(): Promise<readonly RunView[]>;
  /** Calls back on every run change, and returns how to stop listening. */
  onRunsChanged(listener: (runs: readonly RunView[]) => void): () => void;
  /** Calls back as runs write to their console, and returns how to stop listening. */
  onRunOutput(listener: (output: RunOutputView) => void): () => void;
  readRunOutput(runId: string): Promise<RunOutputView | undefined>;
  sendRunInput(runId: string, data: string): Promise<void>;
  resizeRun(runId: string, columns: number, rows: number): Promise<void>;
  listAutomations(): Promise<AutomationListView>;
  saveAutomation(draft: AutomationDraft): Promise<AutomationView>;
  /** Says what keeps a draft from running. Nothing is stored. */
  checkAutomation(draft: AutomationDraft): Promise<readonly AutomationProblemView[]>;
  removeAutomation(id: string): Promise<void>;
  /** Starts an automation, with values for its inputs. Defaults fill the rest. */
  startAutomation(
    id: string,
    inputs?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<AutomationRunStateView>;
  cancelAutomation(runId: string): Promise<void>;
  /** Answers the manual step a run is waiting on. */
  confirmAutomation(runId: string, stepId?: string): Promise<void>;
  listAutomationRuns(): Promise<readonly AutomationRunStateView[]>;
  /** Calls back on every automation run change, and returns how to stop listening. */
  onAutomationsChanged(listener: (runs: readonly AutomationRunStateView[]) => void): () => void;
  automationHistory(id: string): Promise<readonly AutomationRunRecordView[]>;
  /** How an automation's schedule stands on this computer: on or off, next run, last result. */
  scheduleStatus(id: string): Promise<ScheduleStatusView>;
  /**
   * Turns an automation's schedule on or off for this computer. Running with nobody signed in
   * makes Windows ask for administrator rights.
   */
  setSchedule(id: string, on: boolean, signedOut?: boolean): Promise<ScheduleStatusView>;
  listProfiles(toolId: string): Promise<readonly ProfileView[]>;
  saveProfile(input: SaveProfileInput): Promise<ProfileView>;
  removeProfile(toolId: string, id: string): Promise<void>;
  /** Lists tool runs and automation runs, filtered by one tool or one automation. */
  listHistory(filter: {
    readonly toolId?: string;
    readonly automationId?: string;
  }): Promise<readonly HistoryEntryView[]>;
  getHistoryAutomationRun(runId: string): Promise<HistoryAutomationRunView | undefined>;
  getHistoryRun(runId: string): Promise<HistoryRecordView | undefined>;
  recentTools(): Promise<readonly string[]>;
  clearHistory(): Promise<void>;
  getPreferences(): Promise<ShellPreferences>;
  setPreferences(preferences: ShellPreferencesChange): Promise<void>;
  listWorkspaces(): Promise<WorkspaceListView>;
  switchWorkspace(id: string): Promise<WorkspaceListView>;
  createWorkspace(name: string): Promise<WorkspaceListView>;
  renameWorkspace(id: string, name: string): Promise<WorkspaceListView>;
  removeWorkspace(id: string): Promise<WorkspaceListView>;
  /** Changes the active Workspace. */
  updateWorkspace(changes: WorkspaceUpdate): Promise<WorkspaceView>;
  saveLayout(layout: LayoutUpdate): Promise<WorkspaceView>;
  listPathVariables(): Promise<readonly PathVariableView[]>;
  setPathVariable(name: string, value: string): Promise<void>;
  removePathVariable(name: string): Promise<void>;
}

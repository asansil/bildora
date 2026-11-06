import type {
  DetectionView,
  EditCommand,
  RegisterTools,
  RegistrationView,
  RunView,
  ShellInfo,
  ShellPreferences,
  ToolCatalog,
  ToolDetailsInput,
} from '../shared/ipc-contract.js';

/** The only surface the renderer can reach. Every addition is reviewed as a public API. */
export interface ShellApi {
  readonly platform: string;
  shellInfo(): Promise<ShellInfo>;
  quit(): Promise<void>;
  edit(command: EditCommand): Promise<void>;
  listTools(): Promise<ToolCatalog>;
  pickFiles(): Promise<DetectionView | undefined>;
  pickFolder(recursive: boolean): Promise<DetectionView | undefined>;
  detectPaths(paths: readonly string[]): Promise<DetectionView>;
  /** Finds a dropped file's path, which a sandboxed page cannot read by itself. */
  pathForFile(file: File): string;
  registerTools(input: RegisterTools): Promise<RegistrationView>;
  updateTool(id: string, details: ToolDetailsInput): Promise<void>;
  removeTool(id: string): Promise<void>;
  startRun(toolId: string): Promise<RunView>;
  cancelRun(runId: string): Promise<void>;
  listRuns(): Promise<readonly RunView[]>;
  /** Calls back on every run change, and returns how to stop listening. */
  onRunsChanged(listener: (runs: readonly RunView[]) => void): () => void;
  getPreferences(): Promise<ShellPreferences>;
  setPreferences(preferences: ShellPreferences): Promise<void>;
}

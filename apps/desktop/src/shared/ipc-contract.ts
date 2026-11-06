import { z } from 'zod';

/** Longest path Windows accepts. */
const PATH_MAX_LENGTH = 32_767;
const TEXT_MAX_LENGTH = 1024;
const DROPPED_PATHS_MAX = 1000;
const REGISTRATIONS_MAX = 1000;
/** A value can be a long token, so this is far over what a form normally holds. */
const VALUE_MAX_LENGTH = 64 * 1024;
const VALUES_MAX = 200;
const CONSOLE_INPUT_MAX_LENGTH = 64 * 1024;
const CONSOLE_COLUMNS_MAX = 1000;
const CONSOLE_ROWS_MAX = 500;
const HISTORY_RUN_LIMIT_MAX = 100_000;

const textSchema = z.string().max(TEXT_MAX_LENGTH);
const pathSchema = z.string().min(1).max(PATH_MAX_LENGTH);
/** A drive path, a network share or a POSIX path: a registered program has no folder to start from. */
const absolutePathSchema = pathSchema.regex(/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/);
const idSchema = z.string().min(1).max(128);
const parameterNameSchema = z.string().min(1).max(128);
const valuesSchema = z
  .record(parameterNameSchema, z.union([z.string().max(VALUE_MAX_LENGTH), z.number(), z.boolean()]))
  .refine((values) => Object.keys(values).length <= VALUES_MAX);
const secretsSchema = z
  .record(parameterNameSchema, z.string().max(VALUE_MAX_LENGTH).nullable())
  .refine((values) => Object.keys(values).length <= VALUES_MAX);
const columnsSchema = z.int().min(1).max(CONSOLE_COLUMNS_MAX);
const rowsSchema = z.int().min(1).max(CONSOLE_ROWS_MAX);

const toolDetailsFields = {
  name: textSchema.min(1),
  category: textSchema.optional(),
  description: textSchema.optional(),
  interpreter: textSchema.optional(),
};

export const noInputSchema = z.undefined();
export const editCommandSchema = z.enum(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
export const pickFolderSchema = z.strictObject({ recursive: z.boolean() });
export const detectPathsSchema = z.strictObject({
  paths: z.array(pathSchema).min(1).max(DROPPED_PATHS_MAX),
});
export const registerToolsSchema = z.strictObject({
  programs: z
    .array(z.strictObject({ ...toolDetailsFields, program: absolutePathSchema }))
    .min(1)
    .max(REGISTRATIONS_MAX),
});
export const updateToolSchema = z.strictObject({
  id: idSchema,
  details: z.strictObject(toolDetailsFields),
});
export const categoryMenuSchema = z.strictObject({ category: textSchema.min(1) });
export const importManifestsSchema = z.strictObject({
  paths: z.array(absolutePathSchema).min(1).max(REGISTRATIONS_MAX),
});
export const toolIdSchema = z.strictObject({ id: idSchema });
export const runIdSchema = z.strictObject({ runId: idSchema });
export const startRunSchema = z.strictObject({
  id: idSchema,
  profileId: idSchema.optional(),
  values: valuesSchema.optional(),
  columns: columnsSchema.optional(),
  rows: rowsSchema.optional(),
});
export const runInputSchema = z.strictObject({
  runId: idSchema,
  data: z.string().max(CONSOLE_INPUT_MAX_LENGTH),
});
export const runResizeSchema = z.strictObject({
  runId: idSchema,
  columns: columnsSchema,
  rows: rowsSchema,
});
export const saveProfileSchema = z.strictObject({
  toolId: idSchema,
  id: idSchema.optional(),
  name: textSchema.min(1),
  values: valuesSchema,
  secrets: secretsSchema.optional(),
});
export const removeProfileSchema = z.strictObject({ toolId: idSchema, id: idSchema });
export const historyListSchema = z.strictObject({ toolId: idSchema.optional() });
export const preferencesSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  historyRunLimit: z.int().min(1).max(HISTORY_RUN_LIMIT_MAX).optional(),
});

export type EditCommand = z.infer<typeof editCommandSchema>;
export type RegisterTools = z.infer<typeof registerToolsSchema>;
export type ToolDetailsInput = z.infer<typeof updateToolSchema>['details'];
export type ShellPreferencesChange = z.infer<typeof preferencesSchema>;
export type ShellTheme = 'system' | 'light' | 'dark';
export type StartRunInput = z.infer<typeof startRunSchema>;
export type RunRequest = Omit<StartRunInput, 'id'>;
export type SaveProfileInput = z.infer<typeof saveProfileSchema>;

export interface ShellPreferences {
  readonly theme: ShellTheme;
  readonly historyRunLimit: number;
}

export interface ShellInfo {
  readonly version: string;
  /** Why past runs are not being kept, when the history file could not be opened. */
  readonly historyProblem?: string;
}

export type ToolRuntime =
  | { readonly status: 'ready' }
  | { readonly status: 'missing-program'; readonly program: string }
  | { readonly status: 'missing-interpreter'; readonly interpreter: string };

export type ParameterType = 'string' | 'path' | 'integer' | 'number' | 'boolean' | 'choice';

/** A declared parameter, as much as a form needs to know. */
export interface ParameterView {
  readonly name: string;
  readonly label: string;
  readonly type: ParameterType;
  readonly required: boolean;
  readonly description?: string;
  readonly default?: string | number | boolean;
  readonly choices?: readonly string[];
  readonly secret?: boolean;
  /** How the value reaches the tool, which matters for a secret. */
  readonly delivery: 'argument' | 'environment';
}

export interface ToolView {
  readonly id: string;
  readonly name: string;
  readonly level: 0 | 1 | 2;
  readonly category?: string;
  readonly description?: string;
  readonly interpreter?: string;
  /** Absent for level 2 tools, which run through a backend. */
  readonly program?: string;
  /** Absent for level 0 tools, which have none. */
  readonly parameters?: readonly ParameterView[];
  readonly permissions: readonly string[];
  readonly runtime: ToolRuntime;
}

export interface ToolGroupView {
  /** Absent for the tools with no category, shown as Uncategorized. */
  readonly category?: string;
  /** Data URL of the image the user chose. Absent means the default logo. */
  readonly logo?: string;
  readonly tools: readonly ToolView[];
}

export interface ToolProblemView {
  readonly folder: string;
  readonly message: string;
}

export interface ToolCatalog {
  readonly groups: readonly ToolGroupView[];
  readonly problems: readonly ToolProblemView[];
}

export interface ProposalView {
  readonly path: string;
  readonly name: string;
  readonly category?: string;
  readonly interpreter?: string;
  readonly alreadyRegistered: boolean;
}

export interface ManifestProposalView {
  readonly path: string;
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly permissions: readonly string[];
  readonly alreadyRegistered: boolean;
}

export interface DetectionView {
  readonly proposals: readonly ProposalView[];
  readonly manifests: readonly ManifestProposalView[];
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  readonly skipped: readonly string[];
  readonly truncated: boolean;
}

export interface RegistrationView {
  readonly registeredIds: readonly string[];
  readonly failures: readonly { readonly program: string; readonly message: string }[];
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type RunFailureCode =
  | 'invalid-parameters'
  | 'program-not-found'
  | 'interpreter-not-found'
  | 'unsupported'
  | 'launcher'
  | 'credentials'
  | 'exit-code';

export interface RunView {
  readonly runId: string;
  readonly toolId: string;
  readonly status: RunStatus;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly failure?: { readonly kind: RunFailureCode; readonly message: string };
  readonly progress?: { readonly percent?: number; readonly message?: string };
}

/** A piece of a run's console. A higher sequence came later. */
export interface RunOutputView {
  readonly runId: string;
  readonly data: string;
  readonly sequence: number;
}

export interface ProfileView {
  readonly id: string;
  readonly name: string;
  readonly values: Readonly<Record<string, string | number | boolean>>;
  /** Parameters with a saved secret. Saved values never leave the main process. */
  readonly secrets: readonly string[];
}

export type HistoryStatus = Exclude<RunStatus, 'running'> | 'running' | 'interrupted';

export interface HistorySummaryView {
  readonly runId: string;
  readonly toolId: string;
  readonly toolName: string;
  readonly level: number;
  readonly startedAt: number;
  readonly status: HistoryStatus;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly failure?: { readonly kind: string; readonly message: string };
}

export interface HistoryRecordView extends HistorySummaryView {
  readonly parameters: readonly {
    readonly name: string;
    readonly label: string;
    readonly value?: string | number | boolean;
    readonly secret?: true;
  }[];
  readonly output: string;
  readonly outputTruncated: boolean;
}

import { z } from 'zod';

/** Longest path Windows accepts. */
const PATH_MAX_LENGTH = 32_767;
const TEXT_MAX_LENGTH = 1024;
const DROPPED_PATHS_MAX = 1000;
const REGISTRATIONS_MAX = 1000;

const textSchema = z.string().max(TEXT_MAX_LENGTH);
const pathSchema = z.string().min(1).max(PATH_MAX_LENGTH);
/** A drive path, a network share or a POSIX path: a registered program has no folder to start from. */
const absolutePathSchema = pathSchema.regex(/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/);
const idSchema = z.string().min(1).max(128);

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
export const toolIdSchema = z.strictObject({ id: idSchema });
export const runIdSchema = z.strictObject({ runId: idSchema });
export const preferencesSchema = z.strictObject({ theme: z.enum(['system', 'light', 'dark']) });

export type EditCommand = z.infer<typeof editCommandSchema>;
export type RegisterTools = z.infer<typeof registerToolsSchema>;
export type ToolDetailsInput = z.infer<typeof updateToolSchema>['details'];
export type ShellPreferences = z.infer<typeof preferencesSchema>;
export type ShellTheme = ShellPreferences['theme'];

export interface ShellInfo {
  readonly version: string;
}

export type ToolRuntime =
  | { readonly status: 'ready' }
  | { readonly status: 'missing-program'; readonly program: string }
  | { readonly status: 'missing-interpreter'; readonly interpreter: string };

export interface ToolView {
  readonly id: string;
  readonly name: string;
  readonly level: 0 | 1 | 2;
  readonly category?: string;
  readonly description?: string;
  readonly interpreter?: string;
  /** Absent for level 2 tools, which run through a backend. */
  readonly program?: string;
  readonly runtime: ToolRuntime;
}

export interface ToolGroupView {
  /** Absent for the tools with no category, shown as Uncategorized. */
  readonly category?: string;
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

export interface DetectionView {
  readonly proposals: readonly ProposalView[];
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
  | 'exit-code';

export interface RunView {
  readonly runId: string;
  readonly toolId: string;
  readonly status: RunStatus;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly failure?: { readonly kind: RunFailureCode; readonly message: string };
}

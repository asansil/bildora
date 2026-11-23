import { z } from 'zod';
import {
  AUTOMATION_BLOCK_LIMIT,
  AUTOMATION_CONNECTION_LIMIT,
  AUTOMATION_GROUP_LIMIT,
  AUTOMATION_NOTE_LIMIT,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationConnection,
  AutomationGroup,
  AutomationNote,
  AutomationPosition,
  AutomationProblemCode,
  AutomationProblemParams,
} from '@bildora/protocol';

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
const WORKSPACE_NAME_MAX_LENGTH = 80;
const PATH_VARIABLE_NAME_MAX_LENGTH = 64;
const FAVORITES_MAX = 1000;
const SCRIPT_ANSWERS_MAX = 1000;
const CATEGORIES_MAX = 1000;
const WORKSPACE_TABS_MAX = 100;
/** As many folded settings sections as core keeps. */
const FOLDED_SECTIONS_MAX = 64;
export const PANEL_WIDTH_MIN = 180;
export const PANEL_WIDTH_MAX = 480;
export const PANEL_WIDTH_DEFAULT = 248;
/** The sizes an automation tab's panels may take, as core keeps them, with their defaults. */
export const AUTOMATION_PANEL_SIZES = {
  libraryWidth: { min: 160, max: 400, default: 200 },
  settingsWidth: { min: 220, max: 560, default: 300 },
  lowerHeight: { min: 96, max: 600, default: 180 },
} as const;

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
/** Where a tool goes: `workspace` is always the active one, which only main can name. */
const toolScopeSchema = z.enum(['global', 'workspace']);
const workspaceNameSchema = z.string().min(1).max(WORKSPACE_NAME_MAX_LENGTH);
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
  scope: toolScopeSchema,
});
export const updateToolSchema = z.strictObject({
  id: idSchema,
  details: z.strictObject({ ...toolDetailsFields, program: pathSchema.optional() }),
});
export const setToolScopeSchema = z.strictObject({ id: idSchema, scope: toolScopeSchema });
export const categoryMenuSchema = z.strictObject({ category: textSchema.min(1) });
export const importManifestsSchema = z.strictObject({
  paths: z.array(absolutePathSchema).min(1).max(REGISTRATIONS_MAX),
  scope: toolScopeSchema,
});
export const toolIdSchema = z.strictObject({ id: idSchema });
export const runIdSchema = z.strictObject({ runId: idSchema });
export const startRunSchema = z.strictObject({
  id: idSchema,
  profileId: idSchema.optional(),
  values: valuesSchema.optional(),
  columns: columnsSchema.optional(),
  rows: rowsSchema.optional(),
  /** Types the tool's console script. Off, the person answers in the console. */
  answerWithScript: z.boolean().optional(),
});
export const automationIdSchema = z.strictObject({ id: idSchema });
/** Starts an automation, with values for the inputs its Start block declares. */
export const automationStartSchema = z.strictObject({
  id: idSchema,
  inputs: valuesSchema.optional(),
});
export const automationRunIdSchema = z.strictObject({ runId: idSchema });
export const automationConfirmSchema = z.strictObject({
  runId: idSchema,
  /** The block to answer, when a run waits on several at once. */
  stepId: idSchema.optional(),
});
/** Blocks and the rest are checked in main by `automationSchema`, whose problems the canvas shows. */
export const automationDraftSchema = z.strictObject({
  id: idSchema.optional(),
  name: textSchema.min(1),
  description: textSchema.min(1).optional(),
  blocks: z.array(z.unknown()).max(AUTOMATION_BLOCK_LIMIT),
  connections: z.array(z.unknown()).max(AUTOMATION_CONNECTION_LIMIT),
  positions: z.record(idSchema, z.unknown()).optional(),
  notes: z.array(z.unknown()).max(AUTOMATION_NOTE_LIMIT).optional(),
  groups: z.array(z.unknown()).max(AUTOMATION_GROUP_LIMIT).optional(),
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
export const historyListSchema = z.strictObject({
  toolId: idSchema.optional(),
  automationId: idSchema.optional(),
});
export const preferencesSchema = z.strictObject({
  historyRunLimit: z.int().min(1).max(HISTORY_RUN_LIMIT_MAX).optional(),
});
export const workspaceIdSchema = z.strictObject({ id: idSchema });
export const createWorkspaceSchema = z.strictObject({ name: workspaceNameSchema });
export const renameWorkspaceSchema = z.strictObject({ id: idSchema, name: workspaceNameSchema });
function panelSizeSchema(panel: keyof typeof AUTOMATION_PANEL_SIZES) {
  const { min, max } = AUTOMATION_PANEL_SIZES[panel];
  return z.int().min(min).max(max).optional();
}
/** History has a single tab, so only tools and automations name an item. */
const workspaceTabSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.enum(['tool', 'automation']),
    id: idSchema,
    preview: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('history'), preview: z.boolean().optional() }),
]);
export const updateWorkspaceSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  favorites: z.array(idSchema).max(FAVORITES_MAX).optional(),
  layout: z
    .strictObject({
      categoryOrder: z.array(textSchema).max(CATEGORIES_MAX).optional(),
      panelWidth: z.int().min(PANEL_WIDTH_MIN).max(PANEL_WIDTH_MAX).optional(),
      openCategory: textSchema.nullable().optional(),
      tabs: z.array(workspaceTabSchema).max(WORKSPACE_TABS_MAX).optional(),
      activeTab: textSchema.nullable().optional(),
      historyFilter: idSchema.nullable().optional(),
      historyAutomation: idSchema.nullable().optional(),
      scriptAnswers: z.array(idSchema).max(SCRIPT_ANSWERS_MAX).optional(),
      automationPanels: z
        .strictObject({
          libraryWidth: panelSizeSchema('libraryWidth'),
          settingsWidth: panelSizeSchema('settingsWidth'),
          lowerHeight: panelSizeSchema('lowerHeight'),
          libraryCollapsed: z.boolean().optional(),
          settingsCollapsed: z.boolean().optional(),
          lowerCollapsed: z.boolean().optional(),
          foldedSections: z
            .array(z.string().max(65))
            .max(FOLDED_SECTIONS_MAX)
            .readonly()
            .optional(),
        })
        .nullable()
        .optional(),
      automationCanvas: z
        .strictObject({
          snapToGrid: z.boolean().optional(),
          rightAngles: z.boolean().optional(),
          hideGrid: z.boolean().optional(),
          hideNavigator: z.boolean().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});
export const pathVariableSchema = z.strictObject({
  name: z.string().min(1).max(PATH_VARIABLE_NAME_MAX_LENGTH),
  value: absolutePathSchema,
});
export const pathVariableNameSchema = z.strictObject({
  name: z.string().min(1).max(PATH_VARIABLE_NAME_MAX_LENGTH),
});

export type EditCommand = z.infer<typeof editCommandSchema>;
export type RegisterTools = z.infer<typeof registerToolsSchema>;
export type ToolDetailsInput = z.infer<typeof updateToolSchema>['details'];
export type ShellPreferencesChange = z.infer<typeof preferencesSchema>;
export type ShellTheme = 'system' | 'light' | 'dark';
export type ToolScopeChoice = z.infer<typeof toolScopeSchema>;
export type WorkspaceUpdate = z.infer<typeof updateWorkspaceSchema>;
export type LayoutUpdate = NonNullable<WorkspaceUpdate['layout']>;
export type StartRunInput = z.infer<typeof startRunSchema>;
export type RunRequest = Omit<StartRunInput, 'id'>;
export type SaveProfileInput = z.infer<typeof saveProfileSchema>;
/** A draft as main receives it, before `automationFileSchema` reads its contents. */
export type ReceivedAutomationDraft = z.infer<typeof automationDraftSchema>;
/** What the canvas edits, in the terms of the automation file. */
export interface AutomationDraft {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly blocks: readonly AutomationBlock[];
  readonly connections: readonly AutomationConnection[];
  readonly positions?: Readonly<Record<string, AutomationPosition>>;
  readonly notes?: readonly AutomationNote[];
  readonly groups?: readonly AutomationGroup[];
}

export interface ShellPreferences {
  readonly historyRunLimit: number;
}

export interface WorkspaceLayoutView {
  /** Category keys in rail order. */
  readonly categoryOrder: readonly string[];
  readonly panelWidth?: number;
  readonly openCategory?: string;
  /** Work area tabs in the order shown. */
  readonly tabs: readonly WorkspaceTabView[];
  /** The key of the active tab: `tool:<id>`, `automation:<id>` or `history`. */
  readonly activeTab?: string;
  /** The tool id the History tab is filtered by. */
  readonly historyFilter?: string;
  /** The automation id the History tab is filtered by, when no tool is. */
  readonly historyAutomation?: string;
  /** Ids of the tools whose form answers their console script. */
  readonly scriptAnswers?: readonly string[];
  /** How the panels around the automation canvas were left, shared by every automation tab. */
  readonly automationPanels?: AutomationPanelsView;
  /** Options of the automation canvas, shared by every automation tab. */
  readonly automationCanvas?: AutomationCanvasView;
}

export interface AutomationCanvasView {
  /** Blocks land on the background's grid when moved, dropped or pasted. */
  readonly snapToGrid?: boolean;
  /** Connections are drawn with straight lines and right angles instead of curves. */
  readonly rightAngles?: boolean;
  /** The background's dots are not drawn. */
  readonly hideGrid?: boolean;
  /** The overview of the whole flow, in the corner, is not drawn. */
  readonly hideNavigator?: boolean;
}

export interface AutomationPanelsView {
  readonly libraryWidth?: number;
  readonly settingsWidth?: number;
  readonly lowerHeight?: number;
  readonly libraryCollapsed?: boolean;
  readonly settingsCollapsed?: boolean;
  readonly lowerCollapsed?: boolean;
  /** Sections of the settings panel folded shut, such as `run.failure`. */
  readonly foldedSections?: readonly string[];
}

export interface WorkspaceTabView {
  readonly kind: 'tool' | 'automation' | 'history';
  // Spelled to accept what the update schema gives, so a stored layout can be read straight back.
  readonly id?: string | undefined;
  readonly preview?: boolean | undefined;
}

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly theme: ShellTheme;
  /** Tool ids. Some may have no tool now, which leaves them out of what is shown. */
  readonly favorites: readonly string[];
  readonly layout: WorkspaceLayoutView;
}

export interface WorkspaceListView {
  readonly activeId: string;
  readonly workspaces: readonly WorkspaceView[];
  readonly problems: readonly { readonly folder: string; readonly message: string }[];
}

export interface PathVariableView {
  readonly name: string;
  readonly value: string;
}

export interface ShellInfo {
  readonly version: string;
  /** Why past runs are not being kept, when the history file could not be opened. */
  readonly historyProblem?: string;
}

export type ToolRuntime =
  | { readonly status: 'ready' }
  | { readonly status: 'missing-variable'; readonly variable: string }
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
  readonly delivery: 'argument' | 'environment' | 'script';
}

/** A declared output: a path, a parameter's value, or a JSON file with typed fields. */
export interface OutputView {
  readonly name: string;
  readonly description?: string;
  /** What the output itself holds: a path, or text for a parameter that is not a path. */
  readonly type: 'path' | 'text';
  /** Present for a JSON output. */
  readonly fields?: readonly OutputFieldView[];
}

export interface OutputFieldView {
  readonly name: string;
  readonly type: 'string' | 'path' | 'integer' | 'number' | 'boolean' | 'list';
  readonly description?: string;
  /** Kept from history and from other blocks. */
  readonly secret?: true;
}

export interface ToolView {
  /** Unique across scopes, unlike the id, which names a tool only inside a Workspace. */
  readonly key: string;
  readonly id: string;
  readonly scope: ToolScopeChoice;
  readonly name: string;
  readonly level: 0 | 1;
  readonly category?: string;
  readonly description?: string;
  readonly interpreter?: string;
  readonly program: string;
  /** Absent for level 0 tools, which have none. */
  readonly parameters?: readonly ParameterView[];
  /** Names of declared outputs, which automation steps can refer to. */
  readonly outputs?: readonly string[];
  /** The same outputs with what they hold, which values and rules that read them need. */
  readonly outputDetails?: readonly OutputView[];
  /** Present when the tool declares a console script, which its form can choose to answer. */
  readonly hasScript?: true;
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
  readonly scope: ToolScopeChoice;
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
  | 'path-variable'
  | 'stdin-timeout'
  | 'exit-code';

export interface RunView {
  readonly runId: string;
  readonly toolId: string;
  /** Matches `ToolView.key`, so a run shows only on the tool it belongs to. */
  readonly toolKey: string;
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
  /**
   * Set when the run was a step of an automation. `id` and `name` are left out once the record of
   * that automation run has gone, because the automation was deleted or the run was pruned.
   */
  readonly automation?: {
    readonly runId: string;
    readonly id?: string;
    /** The name it had when it ran. */
    readonly name?: string;
  };
}

/** Something that keeps an automation from running, worded by the shell from its code. */
export interface AutomationProblemView {
  readonly code: AutomationProblemCode;
  readonly params: AutomationProblemParams;
  /** Set on a warning, which lets the automation run. */
  readonly severity?: 'warning';
  /** Left out when the problem is with the automation as a whole. */
  readonly blockId?: string;
  /** The problem in English, as the CLI words it. */
  readonly message: string;
}

export interface AutomationView extends Required<Omit<AutomationDraft, 'id' | 'description'>> {
  readonly id: string;
  readonly description?: string;
  /** What is wrong with it now. With no problems but warnings, it can run. */
  readonly problems: readonly AutomationProblemView[];
}

export interface AutomationListView {
  readonly automations: readonly AutomationView[];
  /** Files that could not be read. They never hide the healthy ones. */
  readonly problems: readonly { readonly file: string; readonly message: string }[];
}

export type StepStateView =
  'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'disabled';

export interface StepRunView {
  readonly id: string;
  /** The kind of block, as in the file. */
  readonly type?: string;
  readonly state: StepStateView;
  /** When the run reached it, in milliseconds since the epoch. */
  readonly startedAt?: number;
  readonly toolRunId?: string;
  /** The tool run of every attempt, in order. */
  readonly toolRunIds?: readonly string[];
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly failure?: { readonly kind: string; readonly message: string };
  readonly progress?: { readonly percent?: number; readonly message?: string };
  /** Set while a manual step waits for someone. */
  readonly message?: string;
  /** When a timed wait ends, in milliseconds since the epoch. */
  readonly resumesAt?: number;
  /** What the block's tool received in its latest try. */
  readonly values?: readonly StepValueView[];
  /** What the block left for later blocks, JSON fields as `<output>.<field>`. */
  readonly outputs?: readonly StepOutputView[];
  /** Some values were shortened, or left out, to keep the record small. */
  readonly truncated?: true;
}

/** A value a block's tool received. A secret shows only that it was set. */
export interface StepValueView {
  readonly name: string;
  readonly label: string;
  readonly value?: string | number | boolean;
  readonly secret?: true;
  /** The link or expression it was worked out from, as written after `=`. */
  readonly from?: string;
}

/** A value a block left. A secret field shows only that it was there. */
export interface StepOutputView {
  readonly name: string;
  readonly value?: string | number | boolean | readonly string[];
  readonly secret?: true;
}

/** An automation run this session knows about, going on or the latest finished one. */
export interface AutomationRunStateView {
  readonly runId: string;
  readonly workspaceId: string;
  readonly automationId: string;
  readonly automationName: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly steps: readonly StepRunView[];
  /** Connections the run went along, in order. */
  readonly paths: readonly TakenPathView[];
}

export interface TakenPathView {
  readonly from: string;
  readonly output: string;
  readonly to: string;
}

/** A past run of an automation, from the app or from the CLI. */
export interface AutomationRunRecordView {
  readonly runId: string;
  readonly trigger: 'app' | 'cli';
  readonly startedAt: number;
  readonly status: HistoryStatus;
  readonly durationMs?: number;
  readonly failure?: {
    readonly stepId: string;
    readonly kind: string;
    readonly message: string;
  };
  /** Runs recorded before blocks have no paths. */
  readonly format: 'steps' | 'blocks';
  readonly steps: readonly StepRunView[];
  readonly paths: readonly TakenPathView[];
}

/** One row of Run history: a tool run, or an automation run standing for the tool runs it made. */
export type HistoryEntryView =
  | ({ readonly kind: 'tool' } & HistorySummaryView)
  | ({
      readonly kind: 'automation';
      readonly automationId: string;
      /** The name it had when it ran. */
      readonly automationName: string;
    } & AutomationRunRecordView);

/** An automation run in Run history, with the tool runs it made, every retry included. */
export interface HistoryAutomationRunView {
  readonly run: Extract<HistoryEntryView, { kind: 'automation' }>;
  /** In the order they started. */
  readonly toolRuns: readonly HistorySummaryView[];
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

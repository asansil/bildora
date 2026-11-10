import {
  DefinitionError,
  checkAutomation,
  findVisibleTool,
  getAutomation,
  listAutomations,
  newAutomationId,
  readPathVariables,
  removeAutomation,
  saveAutomation,
  startAutomationRun,
} from '@bildora/core';
import type {
  AutomationRun,
  AutomationRunView,
  ManualAnswer,
  ManualRequest,
  RecordedToolRun,
  RegisteredTool,
  RunHistory,
  ToolRegistry,
} from '@bildora/core';
import {
  AUTOMATION_SCHEMA_VERSION,
  automationFileSchema,
  problemsOfIssues,
} from '@bildora/protocol';
import type { Automation, AutomationProblem } from '@bildora/protocol';
import type {
  ReceivedAutomationDraft,
  AutomationListView,
  AutomationProblemView,
  AutomationView,
} from '../shared/ipc-contract.js';
import type { ServiceRunRequest } from './run-service.js';

/** How often a run's state reaches the shell. A chatty tool must not flood the page. */
const SHELL_UPDATE_MS = 33;

export interface AutomationServiceOptions {
  readonly dataDir: string;
  readonly registry: ToolRegistry;
  readonly history: RunHistory;
  /** The Workspace the shell is in now. */
  readonly workspaceId: () => string;
  readonly startStep: (
    tool: RegisteredTool,
    workspaceId: string,
    request: ServiceRunRequest,
  ) => Promise<RecordedToolRun>;
  readonly onChange: (views: readonly AutomationRunView[]) => void;
}

interface ActiveAutomation {
  readonly run: AutomationRun;
  readonly workspaceId: string;
  readonly automationId: string;
  /** Who is waiting for a person, by block. Answering a block settles it. */
  readonly answers: Map<string, (answer: ManualAnswer) => void>;
}

/** What the canvas sent, as the file would hold it. Empty sections are left out of the file. */
function fileOf(draft: ReceivedAutomationDraft, id: string): unknown {
  const { name, description, blocks, connections, positions, notes, groups } = draft;
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    name,
    ...(description === undefined ? {} : { description }),
    blocks,
    connections,
    ...(positions === undefined || Object.keys(positions).length === 0 ? {} : { positions }),
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
    ...(groups === undefined || groups.length === 0 ? {} : { groups }),
  };
}

type Parsed =
  | { readonly ok: true; readonly automation: Automation }
  | { readonly ok: false; readonly problems: AutomationProblem[] };

function parseDraft(draft: ReceivedAutomationDraft, id: string): Parsed {
  const file = fileOf(draft, id);
  const result = automationFileSchema.safeParse(file);
  return result.success
    ? { ok: true, automation: result.data }
    : { ok: false, problems: problemsOfIssues(result.error.issues, file) };
}

/**
 * Automations of the Workspace the shell is in, and the runs going on in this session. Rules stay
 * in core. Each step goes through `RunService`, so consoles and the status bar work as for any run.
 */
export class AutomationService {
  private readonly options: AutomationServiceOptions;
  private readonly active = new Map<string, ActiveAutomation>();
  private readonly lastFinished = new Map<string, AutomationRunView>();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: AutomationServiceOptions) {
    this.options = options;
  }

  private async viewOf(automation: Automation, workspaceId: string): Promise<AutomationView> {
    const { registry } = this.options;
    const { id, name, description, blocks, connections } = automation;
    return {
      id,
      name,
      ...(description === undefined ? {} : { description }),
      blocks,
      connections,
      positions: automation.positions ?? {},
      notes: automation.notes ?? [],
      groups: automation.groups ?? [],
      problems: await checkAutomation(automation, registry, workspaceId),
    };
  }

  async list(): Promise<AutomationListView> {
    const { dataDir, workspaceId } = this.options;
    const id = workspaceId();
    const { automations, problems } = await listAutomations(dataDir, id);
    return {
      automations: await Promise.all(automations.map((item) => this.viewOf(item, id))),
      problems,
    };
  }

  /**
   * Stores an automation, new when it has no id. Nothing here runs it. A flow being built is stored
   * with its problems, which keep it from running; only a draft no file could hold is refused.
   */
  async save(draft: ReceivedAutomationDraft): Promise<AutomationView> {
    const { dataDir, workspaceId } = this.options;
    const workspace = workspaceId();
    const { automations } = await listAutomations(dataDir, workspace);
    const taken = automations.map(({ id }) => id);
    const id = draft.id ?? newAutomationId(draft.name, taken);
    const parsed = parseDraft(draft, id);
    if (!parsed.ok) {
      throw new DefinitionError(
        'The automation is not valid',
        parsed.problems.map(({ message }) => ({ path: '', message })),
      );
    }
    const saved = await saveAutomation(dataDir, workspace, parsed.automation);
    return this.viewOf(saved, workspace);
  }

  /** What keeps a draft from running, for the canvas. Nothing is stored. */
  async check(draft: ReceivedAutomationDraft): Promise<readonly AutomationProblemView[]> {
    const { registry, workspaceId } = this.options;
    const parsed = parseDraft(draft, draft.id ?? 'draft');
    return parsed.ok
      ? await checkAutomation(parsed.automation, registry, workspaceId())
      : parsed.problems;
  }

  async remove(id: string): Promise<void> {
    const { dataDir, history, workspaceId } = this.options;
    const workspace = workspaceId();
    if (this.isRunning(workspace, id)) {
      throw new Error('This automation is running');
    }
    await removeAutomation(dataDir, workspace, id, history);
    this.lastFinished.delete(`${workspace}/${id}`);
    this.sendChanges();
  }

  /** Tells whether an automation is going on in this session. The CLI's runs are its own. */
  isRunning(workspaceId: string, id: string): boolean {
    return [...this.active.values()].some(
      (entry) => entry.workspaceId === workspaceId && entry.automationId === id,
    );
  }

  /** Starts an automation of the active Workspace, whatever the user switches to afterwards. */
  async start(id: string): Promise<AutomationRunView> {
    const { dataDir, registry, history, workspaceId } = this.options;
    const workspace = workspaceId();
    if (this.isRunning(workspace, id)) {
      throw new Error('This automation is already running');
    }
    const automation = await getAutomation(dataDir, workspace, id);
    if (automation === undefined) {
      throw new Error('This automation no longer exists');
    }
    const [problem] = await checkAutomation(automation, registry, workspace);
    if (problem !== undefined) {
      throw new Error(
        problem.blockId === undefined
          ? problem.message
          : `Block "${problem.blockId}": ${problem.message}`,
      );
    }

    const pathVariables = await readPathVariables(dataDir).catch(() => undefined);
    const entry: ActiveAutomation = {
      workspaceId: workspace,
      automationId: id,
      answers: new Map(),
      run: startAutomationRun({
        automation,
        workspaceId: workspace,
        trigger: 'app',
        dataDir,
        history,
        pathVariables,
        findTool: (toolId) => findVisibleTool(registry, workspace, toolId),
        startStep: (tool, request) => this.options.startStep(tool, workspace, request),
        // No step begins before `startAutomationRun` returns, so `entry` is there by then.
        askForAction: (request) => this.waitForAnswer(entry, request),
        onChange: () => {
          this.scheduleUpdate();
        },
      }),
    };
    const { run } = entry;
    this.active.set(run.runId, entry);
    void run.result.then(() => {
      this.active.delete(run.runId);
      this.lastFinished.set(`${workspace}/${id}`, run.view());
      this.sendChanges();
    });
    this.scheduleUpdate();
    return run.view();
  }

  private waitForAnswer(
    entry: ActiveAutomation,
    { stepId, signal }: ManualRequest,
  ): Promise<ManualAnswer> {
    return new Promise((resolve) => {
      const settle = (answer: ManualAnswer): void => {
        signal.removeEventListener('abort', onAbort);
        entry.answers.delete(stepId);
        resolve(answer);
      };
      const onAbort = (): void => {
        settle('cancelled');
      };
      signal.addEventListener('abort', onAbort);
      entry.answers.set(stepId, settle);
    });
  }

  /**
   * Answers a manual block a run is waiting on, if it still is. With no block named, it answers the
   * ones waiting now, because a list has only one.
   */
  confirm(runId: string, stepId?: string): void {
    const answers = this.active.get(runId)?.answers;
    if (answers === undefined) {
      return;
    }
    for (const [id, settle] of [...answers]) {
      if (stepId === undefined || stepId === id) {
        settle('confirmed');
      }
    }
  }

  cancel(runId: string): void {
    this.active.get(runId)?.run.cancel();
  }

  /** Ends every automation, and settles once all of them have reported. */
  async cancelAll(): Promise<void> {
    const running = [...this.active.values()].map(({ run }) => {
      run.cancel();
      return run.result;
    });
    await Promise.all(running);
  }

  private scheduleUpdate(): void {
    this.updateTimer ??= setTimeout(() => {
      this.updateTimer = undefined;
      this.sendChanges();
    }, SHELL_UPDATE_MS);
  }

  private sendChanges(): void {
    this.options.onChange(this.views());
  }

  views(): readonly AutomationRunView[] {
    const running = [...this.active.values()].map(({ run }) => run.view());
    return [...running, ...this.lastFinished.values()];
  }

  isWorkspaceBusy(workspaceId: string): boolean {
    return [...this.active.values()].some((entry) => entry.workspaceId === workspaceId);
  }

  get activeCount(): number {
    return this.active.size;
  }
}

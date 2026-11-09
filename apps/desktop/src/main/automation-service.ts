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
  automationSchema,
  fromLinear,
  linearOf,
  linearStepSchema,
} from '@bildora/protocol';
import type { Automation } from '@bildora/protocol';
import { z } from 'zod';
import type {
  AutomationDraft,
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

function issuesOf(error: {
  readonly issues: readonly { readonly path: PropertyKey[]; readonly message: string }[];
}) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function draftToAutomation(draft: AutomationDraft, id: string): Automation {
  const { name, description } = draft;
  const listed = z.array(linearStepSchema).safeParse(draft.steps);
  if (!listed.success) {
    throw new DefinitionError('The automation is not valid', issuesOf(listed.error));
  }
  const steps = listed.data;
  const result = automationSchema.safeParse({
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    name,
    ...(description === undefined ? {} : { description }),
    ...fromLinear(steps),
  });
  if (!result.success) {
    throw new DefinitionError('The automation is not valid', issuesOf(result.error));
  }
  return result.data;
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
    const { id, name, description, blocks } = automation;
    const steps = linearOf(automation);
    return {
      id,
      name,
      ...(description === undefined ? {} : { description }),
      steps: steps ?? [],
      editable: steps !== undefined,
      blocks,
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

  /** Stores an automation, new when it has no id. Nothing here runs it. */
  async save(draft: AutomationDraft): Promise<AutomationView> {
    const { dataDir, workspaceId } = this.options;
    const workspace = workspaceId();
    const { automations } = await listAutomations(dataDir, workspace);
    const taken = automations.map(({ id }) => id);
    const id = draft.id ?? newAutomationId(draft.name, taken);
    const existing =
      draft.id === undefined ? undefined : automations.find((item) => item.id === id);
    if (existing !== undefined && linearOf(existing) === undefined) {
      // The list cannot say what its branches do, so saving it would lose them.
      throw new Error('This automation has branches, so it can only be changed in its file');
    }
    const saved = await saveAutomation(dataDir, workspace, draftToAutomation(draft, id));
    return this.viewOf(saved, workspace);
  }

  /** What keeps a draft from running, for the editor. Nothing is stored. */
  async check(draft: AutomationDraft): Promise<readonly AutomationProblemView[]> {
    const { registry, workspaceId } = this.options;
    try {
      const automation = draftToAutomation(draft, draft.id ?? 'draft');
      return await checkAutomation(automation, registry, workspaceId());
    } catch (error) {
      if (error instanceof DefinitionError) {
        return error.issues.map(({ message }) => ({ stepId: '', message }));
      }
      throw error;
    }
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
      throw new Error(`Step "${problem.stepId}": ${problem.message}`);
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

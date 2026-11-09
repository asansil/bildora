import { RUN_FOLDER_REFERENCE, stepOutputReference } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';
import { t } from '../../shared/i18n/translate.js';
import type { AutomationStep, ToolView } from '../../shared/ipc-contract.js';

export type StepKind = AutomationStep['type'];
export type RunStep = Extract<AutomationStep, { type: 'run' }>;
export type FailureChoice = 'stop' | 'continue' | 'retry';

/** A copy without some fields, because a field left out and an undefined one differ in a file. */
export function without<Item extends object, Key extends keyof Item>(
  item: Item,
  ...keys: readonly Key[]
): Omit<Item, Key> {
  const left = Object.entries(item).filter(([key]) => !keys.some((name) => name === key));
  return Object.fromEntries(left) as Omit<Item, Key>;
}

/** A step id is a name a reference can hold, so a tool's dotted id only gives its last part. */
function stepIdBase(text: string): string {
  const last = text.split('.').at(-1) ?? text;
  const cleaned = last.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[^a-zA-Z]+/, '');
  return cleaned === '' ? 'step' : cleaned.slice(0, 56);
}

export function newStepId(text: string, steps: readonly AutomationStep[]): string {
  const base = stepIdBase(text);
  const taken = new Set(steps.map(({ id }) => id));
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/** Tools a step can run. Level 2 tools need a panel, which an automation has no place for. */
export function runnableTools(tools: readonly ToolView[]): readonly ToolView[] {
  return tools.filter(({ level }) => level !== 2);
}

/** Starts a step of a kind, or gives nothing when that kind has nothing to work with yet. */
export function newStep(
  kind: StepKind,
  steps: readonly AutomationStep[],
  tools: readonly ToolView[],
): AutomationStep | undefined {
  switch (kind) {
    case 'run': {
      const [tool] = runnableTools(tools);
      return tool === undefined
        ? undefined
        : { id: newStepId(tool.id, steps), type: 'run', tool: tool.id };
    }
    case 'wait-for-time':
      return { id: newStepId('pause', steps), type: kind, seconds: 60 };
    case 'wait-for-manual-action':
      return {
        id: newStepId('review', steps),
        type: kind,
        message: t('automation.defaultMessage'),
      };
  }
}

/** Moves a step up or down. A move past either end changes nothing. */
export function moveStep(
  steps: readonly AutomationStep[],
  index: number,
  delta: -1 | 1,
): readonly AutomationStep[] {
  const moved = steps[index];
  const target = index + delta;
  if (moved === undefined || target < 0 || target >= steps.length) {
    return steps;
  }
  const others = steps.filter((_step, position) => position !== index);
  return [...others.slice(0, target), moved, ...others.slice(target)];
}

export interface ReferenceOption {
  readonly label: string;
  readonly value: string;
}

/** What a path field can refer to: the run's folder, and outputs of earlier steps. */
export function referenceOptions(
  steps: readonly AutomationStep[],
  index: number,
  tools: readonly ToolView[],
): readonly ReferenceOption[] {
  const outputs = steps.slice(0, index).flatMap((step) => {
    if (step.type !== 'run') {
      return [];
    }
    const declared = tools.find(({ id }) => id === step.tool)?.outputs ?? [];
    return declared.map((output) => ({
      label: `${step.id}: ${output}`,
      value: stepOutputReference({ step: step.id, output }),
    }));
  });
  return [{ label: t('automation.runFolder'), value: `${RUN_FOLDER_REFERENCE}/` }, ...outputs];
}

export function failureChoice(step: AutomationStep): FailureChoice {
  if (step.type === 'wait-for-time' || step.onFailure === undefined) {
    return 'stop';
  }
  return typeof step.onFailure === 'string' ? step.onFailure : 'retry';
}

/** Sets what a run step does on failure. Stop is the default, so it is left out of the file. */
export function withFailureChoice(step: RunStep, choice: FailureChoice): RunStep {
  const rest: RunStep = without(step, 'onFailure');
  switch (choice) {
    case 'stop':
      return rest;
    case 'continue':
      return { ...rest, onFailure: 'continue' };
    case 'retry':
      return { ...rest, onFailure: { retry: { attempts: 3, delaySeconds: 30 } } };
  }
}

/** What a label needs of a step, so that a step and a block of the same kind read the same. */
type Labelled =
  | { readonly type: 'run'; readonly tool: string }
  | { readonly type: 'wait-for-time'; readonly seconds: number }
  | { readonly type: 'wait-for-manual-action'; readonly message: string };

/** A step in a sentence, as lists show it. */
export function stepLabel(step: Labelled, tools: readonly ToolView[]): string {
  switch (step.type) {
    case 'run': {
      const name = tools.find(({ id }) => id === step.tool)?.name ?? step.tool;
      return t('automation.labelRun', { name });
    }
    case 'wait-for-time':
      return t('automation.labelTime', { count: step.seconds });
    case 'wait-for-manual-action':
      return step.message;
  }
}

/** A block in a sentence, for an automation that is not a list. */
export function blockLabel(block: AutomationBlock, tools: readonly ToolView[]): string {
  switch (block.type) {
    case 'run':
    case 'wait-for-time':
    case 'wait-for-manual-action':
      return stepLabel(block, tools);
    case 'start':
      return t('automation.blockStart');
    case 'if':
      return t('automation.blockIf', { id: block.id });
    case 'switch':
      return t('automation.blockSwitch', { id: block.id });
    case 'parallel':
      return t('automation.blockParallel', { id: block.id });
    case 'join':
      return t('automation.blockJoin', { id: block.id });
  }
}

/** The command that runs an automation, quoted the way a Windows shell needs. */
export function commandFor(id: string): string {
  return `bildora run ${id}`;
}

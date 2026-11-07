import { findStepOutputReferences, findUnknownReferences } from '@bildora/protocol';
import type { Automation, RunStep, ToolParameter } from '@bildora/protocol';
import { getProfile, isSecretParameter } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { findVisibleTool } from '../workspaces/visible-tools.js';

/** Something that keeps an automation from running. */
export interface AutomationProblem {
  readonly stepId: string;
  readonly message: string;
}

type StepValue = NonNullable<RunStep['values']>[string];

function hasRightType(parameter: ToolParameter, value: StepValue): boolean {
  switch (parameter.type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'choice':
      return typeof value === 'string' && parameter.choices.includes(value);
    default:
      return typeof value === 'string';
  }
}

function checkReferences(
  automation: Automation,
  index: number,
  text: string,
  tools: ReadonlyMap<string, RegisteredTool>,
): readonly string[] {
  const earlier = automation.steps.slice(0, index);
  const problems = findUnknownReferences(text).map((found) => `Unknown reference ${found}`);
  for (const { step, output } of findStepOutputReferences(text)) {
    const source = earlier.find(({ id }) => id === step);
    if (source?.type !== 'run') {
      problems.push(`Refers to "${step}", which is not an earlier run step`);
      continue;
    }
    const manifest = tools.get(step)?.manifest;
    if (manifest?.level === 1 && !manifest.outputs.some(({ name }) => name === output)) {
      problems.push(`Step "${step}" declares no output "${output}"`);
    }
    if (manifest?.level === 0) {
      problems.push(`Step "${step}" runs a registered program, which declares no outputs`);
    }
    const waited = earlier.some(
      (other) => other.type === 'wait-for-completion' && other.step === step,
    );
    if (source.background === true && !waited) {
      problems.push(`Step "${step}" runs in the background, so it must be waited for first`);
    }
  }
  return problems;
}

function checkValues(
  automation: Automation,
  index: number,
  step: RunStep,
  tool: RegisteredTool,
  tools: ReadonlyMap<string, RegisteredTool>,
): readonly string[] {
  const parameters = tool.manifest.level === 1 ? tool.manifest.parameters : [];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(step.values ?? {})) {
    const parameter = parameters.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      problems.push(`The tool has no parameter "${name}"`);
    } else if (isSecretParameter(parameter)) {
      // The message does not repeat the value, which should not be in a shared file at all.
      problems.push(`"${name}" is secret, so it can only come from a profile`);
    } else if (!hasRightType(parameter, value)) {
      problems.push(`"${name}" does not fit a ${parameter.type} parameter`);
    } else if (parameter.type === 'path' && typeof value === 'string') {
      problems.push(...checkReferences(automation, index, value, tools));
    } else if (typeof value === 'string' && findStepOutputReferences(value).length > 0) {
      problems.push(`"${name}" is not a path parameter, so it cannot hold a reference`);
    }
  }
  return problems;
}

function checkRequired(step: RunStep, tool: RegisteredTool, profile?: Profile): readonly string[] {
  const parameters = tool.manifest.level === 1 ? tool.manifest.parameters : [];
  return parameters
    .filter(
      ({ name, required, default: fallback }) =>
        required &&
        fallback === undefined &&
        step.values?.[name] === undefined &&
        profile?.values[name] === undefined &&
        profile?.secrets.includes(name) !== true,
    )
    .map(({ label }) => `Needs a value for "${label}"`);
}

async function findTool(
  registry: ToolRegistry,
  workspaceId: string,
  id: string,
): Promise<RegisteredTool | string> {
  try {
    return (await findVisibleTool(registry, workspaceId, id)) ?? `Tool "${id}" is not installed`;
  } catch {
    return `Tool "${id}" cannot be read`;
  }
}

/**
 * Checks an automation against what is installed in its Workspace. It only reports: an automation
 * whose tool has gone stays as it was, and works again if the tool comes back.
 */
export async function checkAutomation(
  automation: Automation,
  registry: ToolRegistry,
  workspaceId: string,
): Promise<readonly AutomationProblem[]> {
  const tools = new Map<string, RegisteredTool>();
  for (const step of automation.steps) {
    if (step.type === 'run') {
      const tool = await findTool(registry, workspaceId, step.tool);
      if (typeof tool !== 'string') {
        tools.set(step.id, tool);
      }
    }
  }

  const problems: AutomationProblem[] = [];
  for (const [index, step] of automation.steps.entries()) {
    if (step.type !== 'run') {
      continue;
    }
    const report = (message: string): void => {
      problems.push({ stepId: step.id, message });
    };
    const tool = tools.get(step.id);
    if (tool === undefined) {
      report(`Tool "${step.tool}" is not installed, or cannot be read`);
      continue;
    }
    if (tool.manifest.level === 2) {
      report('Level 2 tools cannot run in an automation yet');
      continue;
    }
    const profile = step.profile === undefined ? undefined : await getProfile(tool, step.profile);
    if (step.profile !== undefined && profile === undefined) {
      report(`Profile "${step.profile}" no longer exists`);
    }
    checkValues(automation, index, step, tool, tools).forEach(report);
    checkRequired(step, tool, profile).forEach(report);
  }
  return problems;
}

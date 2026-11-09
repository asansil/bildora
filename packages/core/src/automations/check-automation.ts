import { findStepOutputReferences, findUnknownReferences, guarantees } from '@bildora/protocol';
import type {
  AutomationCondition,
  Automation,
  Guarantee,
  RunBlock,
  ToolParameter,
} from '@bildora/protocol';
import { getProfile, isSecretParameter } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { findVisibleTool } from '../workspaces/visible-tools.js';

/** Something that keeps an automation from running. */
export interface AutomationProblem {
  readonly stepId: string;
  readonly message: string;
}

type StepValue = NonNullable<RunBlock['values']>[string];

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
  certain: Guarantee,
  text: string,
  tools: ReadonlyMap<string, RegisteredTool>,
): readonly string[] {
  const problems = findUnknownReferences(text).map((found) => `Unknown reference ${found}`);
  for (const { step, output } of findStepOutputReferences(text)) {
    const source = automation.blocks.find(({ id }) => id === step);
    if (source?.type !== 'run') {
      problems.push(`Refers to "${step}", which is not a run block`);
      continue;
    }
    const manifest = tools.get(step)?.manifest;
    if (manifest?.level === 1 && !manifest.outputs.some(({ name }) => name === output)) {
      problems.push(`Step "${step}" declares no output "${output}"`);
    }
    if (manifest?.level === 0) {
      problems.push(`Step "${step}" runs a registered program, which declares no outputs`);
    }
    if (!certain.completed.has(step)) {
      problems.push(
        `Step "${step}" does not finish on every path that reaches this block, so its output may not exist`,
      );
    }
  }
  return problems;
}

function checkValues(
  automation: Automation,
  certain: Guarantee,
  step: RunBlock,
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
      problems.push(...checkReferences(automation, certain, value, tools));
    } else if (typeof value === 'string' && findStepOutputReferences(value).length > 0) {
      problems.push(`"${name}" is not a path parameter, so it cannot hold a reference`);
    }
  }
  return problems;
}

function checkRequired(step: RunBlock, tool: RegisteredTool, profile?: Profile): readonly string[] {
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

/** Rules that read what a block left, which has to exist whichever way the run got there. */
function checkConditions(
  automation: Automation,
  blockId: string,
  condition: AutomationCondition,
  certain: Guarantee,
): readonly string[] {
  const problems: string[] = [];
  for (const rule of condition.rules) {
    if (rule.field !== 'exit-code') {
      continue;
    }
    const source = automation.blocks.find(({ id }) => id === rule.block);
    if (source?.type !== 'run') {
      problems.push(`Reads the exit code of "${rule.block}", which is not a run block`);
    } else if (!certain.ran.has(rule.block)) {
      problems.push(
        `Reads the exit code of "${rule.block}", which does not run on every path that reaches "${blockId}"`,
      );
    }
  }
  return problems;
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
  const known = guarantees(automation);
  const nobody: Guarantee = { completed: new Set(), ran: new Set() };
  const tools = new Map<string, RegisteredTool>();
  for (const block of automation.blocks) {
    if (block.type === 'run') {
      const tool = await findTool(registry, workspaceId, block.tool);
      if (typeof tool !== 'string') {
        tools.set(block.id, tool);
      }
    }
  }

  const problems: AutomationProblem[] = [];
  for (const block of automation.blocks) {
    const certain = known.get(block.id) ?? nobody;
    const report = (message: string): void => {
      problems.push({ stepId: block.id, message });
    };
    if (block.type === 'if') {
      checkConditions(automation, block.id, block.condition, certain).forEach(report);
    }
    if (block.type === 'switch') {
      block.cases
        .flatMap(({ condition }) => checkConditions(automation, block.id, condition, certain))
        .forEach(report);
    }
    if (block.type !== 'run') {
      continue;
    }
    const tool = tools.get(block.id);
    if (tool === undefined) {
      report(`Tool "${block.tool}" is not installed, or cannot be read`);
      continue;
    }
    const profile = block.profile === undefined ? undefined : await getProfile(tool, block.profile);
    if (block.profile !== undefined && profile === undefined) {
      report(`Profile "${block.profile}" no longer exists`);
    }
    checkValues(automation, certain, block, tool, tools).forEach(report);
    checkRequired(block, tool, profile).forEach(report);
  }
  return problems;
}

import { findStepOutputReferences, findUnknownReferences, guarantees } from '@bildora/protocol';
import type {
  Automation,
  AutomationCondition,
  AutomationV2,
  Guarantee,
  RunBlock,
  ToolParameter,
} from '@bildora/protocol';
import { getProfile, isSecretParameter } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { findVisibleTool } from '../workspaces/visible-tools.js';
import { convertAutomationV1 } from './convert-v1.js';

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
  automation: AutomationV2,
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
  automation: AutomationV2,
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
  automation: AutomationV2,
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

/** An automation as blocks, or what stops a list of steps from becoming them. */
function blocksOf(automation: Automation | AutomationV2): AutomationV2 | readonly string[] {
  if (automation.schemaVersion === 2) {
    return automation;
  }
  const converted = convertAutomationV1(automation);
  return converted.ok ? converted.automation : converted.problems;
}

/**
 * Checks an automation against what is installed in its Workspace. It only reports: an automation
 * whose tool has gone stays as it was, and works again if the tool comes back.
 */
export async function checkAutomation(
  source: Automation | AutomationV2,
  registry: ToolRegistry,
  workspaceId: string,
): Promise<readonly AutomationProblem[]> {
  const automation = blocksOf(source);
  if (Array.isArray(automation)) {
    return (automation as readonly string[]).map((message) => ({ stepId: '', message }));
  }
  const flow = automation as AutomationV2;
  const known = guarantees(flow);
  const nobody: Guarantee = { completed: new Set(), ran: new Set() };
  const tools = new Map<string, RegisteredTool>();
  for (const block of flow.blocks) {
    if (block.type === 'run') {
      const tool = await findTool(registry, workspaceId, block.tool);
      if (typeof tool !== 'string') {
        tools.set(block.id, tool);
      }
    }
  }

  const problems: AutomationProblem[] = [];
  for (const block of flow.blocks) {
    const certain = known.get(block.id) ?? nobody;
    const report = (message: string): void => {
      problems.push({ stepId: block.id, message });
    };
    if (block.type === 'if') {
      checkConditions(flow, block.id, block.condition, certain).forEach(report);
    }
    if (block.type === 'switch') {
      block.cases
        .flatMap(({ condition }) => checkConditions(flow, block.id, condition, certain))
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
    if (tool.manifest.level === 2) {
      report('Level 2 tools cannot run in an automation yet');
      continue;
    }
    const profile = block.profile === undefined ? undefined : await getProfile(tool, block.profile);
    if (block.profile !== undefined && profile === undefined) {
      report(`Profile "${block.profile}" no longer exists`);
    }
    checkValues(flow, certain, block, tool, tools).forEach(report);
    checkRequired(block, tool, profile).forEach(report);
  }
  return problems;
}

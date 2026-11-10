import {
  automationProblem,
  automationRuleIssues,
  findStepOutputReferences,
  findUnknownReferences,
  guarantees,
} from '@bildora/protocol';
import type {
  AutomationCondition,
  Automation,
  AutomationProblem,
  AutomationProblemCode,
  AutomationProblemParams,
  Guarantee,
  RunBlock,
  ToolParameter,
} from '@bildora/protocol';
import { getProfile, isSecretParameter } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { findVisibleTool } from '../workspaces/visible-tools.js';

export type { AutomationProblem } from '@bildora/protocol';

/** A problem found inside one block, which the caller files under that block. */
interface Found {
  readonly code: AutomationProblemCode;
  readonly params: AutomationProblemParams;
}

const found = (code: AutomationProblemCode, params: AutomationProblemParams = {}): Found => ({
  code,
  params,
});

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
): readonly Found[] {
  const problems = findUnknownReferences(text).map((reference) =>
    found('reference-unknown', { reference }),
  );
  for (const { step, output } of findStepOutputReferences(text)) {
    const source = automation.blocks.find(({ id }) => id === step);
    if (source?.type !== 'run') {
      problems.push(found('reference-not-run', { source: step }));
      continue;
    }
    const manifest = tools.get(step)?.manifest;
    if (manifest?.level === 1 && !manifest.outputs.some(({ name }) => name === output)) {
      problems.push(found('reference-output-unknown', { source: step, output }));
    }
    if (manifest?.level === 0) {
      problems.push(found('reference-level-0', { source: step }));
    }
    if (!certain.completed.has(step)) {
      problems.push(found('reference-not-certain', { source: step }));
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
): readonly Found[] {
  const parameters = tool.manifest.level === 1 ? tool.manifest.parameters : [];
  const problems: Found[] = [];
  for (const [name, value] of Object.entries(step.values ?? {})) {
    const parameter = parameters.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      problems.push(found('parameter-unknown', { parameter: name }));
    } else if (isSecretParameter(parameter)) {
      // The problem does not repeat the value, which should not be in a shared file at all.
      problems.push(found('parameter-secret', { parameter: name, label: parameter.label }));
    } else if (!hasRightType(parameter, value)) {
      problems.push(
        found('parameter-type', { parameter: name, label: parameter.label, type: parameter.type }),
      );
    } else if (parameter.type === 'path' && typeof value === 'string') {
      problems.push(...checkReferences(automation, certain, value, tools));
    } else if (typeof value === 'string' && findStepOutputReferences(value).length > 0) {
      problems.push(found('reference-not-path', { parameter: name, label: parameter.label }));
    }
  }
  return problems;
}

function checkRequired(step: RunBlock, tool: RegisteredTool, profile?: Profile): readonly Found[] {
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
    .map(({ name, label }) => found('parameter-required', { parameter: name, label }));
}

async function findTool(
  registry: ToolRegistry,
  workspaceId: string,
  id: string,
): Promise<RegisteredTool | undefined> {
  try {
    return await findVisibleTool(registry, workspaceId, id);
  } catch {
    return undefined;
  }
}

/** Rules that read what a block left, which has to exist whichever way the run got there. */
function checkConditions(
  automation: Automation,
  blockId: string,
  condition: AutomationCondition,
  certain: Guarantee,
): readonly Found[] {
  const problems: Found[] = [];
  for (const rule of condition.rules) {
    if (rule.field !== 'exit-code') {
      continue;
    }
    const source = automation.blocks.find(({ id }) => id === rule.block);
    if (source?.type !== 'run') {
      problems.push(found('exit-code-not-run', { source: rule.block }));
    } else if (!certain.ran.has(rule.block)) {
      problems.push(found('exit-code-not-certain', { source: rule.block, block: blockId }));
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
      if (tool !== undefined) {
        tools.set(block.id, tool);
      }
    }
  }

  // Rules a half-built flow may break: saved as it is, but not run.
  const problems: AutomationProblem[] = automationRuleIssues(automation).map(
    ({ code, params, blockId, message }) => ({
      code,
      params,
      ...(blockId === undefined ? {} : { blockId }),
      message,
    }),
  );
  for (const block of automation.blocks) {
    const certain = known.get(block.id) ?? nobody;
    const report = ({ code, params }: Found): void => {
      problems.push(automationProblem(code, params, block.id));
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
      report(found('tool-missing', { tool: block.tool }));
      continue;
    }
    const profile = block.profile === undefined ? undefined : await getProfile(tool, block.profile);
    if (block.profile !== undefined && profile === undefined) {
      report(found('profile-missing', { profile: block.profile }));
    }
    checkValues(automation, certain, block, tool, tools).forEach(report);
    checkRequired(block, tool, profile).forEach(report);
  }
  return problems;
}

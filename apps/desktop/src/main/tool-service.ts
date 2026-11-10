import {
  GLOBAL_SCOPE,
  categoryKey,
  checkRuntime,
  detectPrograms,
  findVisibleTool,
  getWorkspace,
  groupByCategory,
  importManifests,
  listProfiles,
  listVisibleTools,
  locateProgram,
  moveCategory,
  moveTool,
  orderGroups,
  readCategoryLogos,
  readPathVariables,
  registerPrograms,
  removeCategoryLogo,
  removeProfile,
  removeTool,
  saveProfile,
  setCategoryLogo,
  toolKey,
  updateToolDetails,
  workspaceScope,
} from '@bildora/core';
import type {
  Detection,
  InstallScope,
  PathVariables,
  RegisteredTool,
  SecretStore,
  ToolGroup,
  ToolRegistry,
} from '@bildora/core';
import type {
  DetectionView,
  OutputView,
  ParameterView,
  ProfileView,
  RegisterTools,
  RegistrationView,
  SaveProfileInput,
  ToolCatalog,
  ToolDetailsInput,
  ToolGroupView,
  ToolScopeChoice,
  ToolView,
} from '../shared/ipc-contract.js';

type DeclaredManifest = Extract<RegisteredTool['manifest'], { level: 1 }>;
type DeclaredParameter = DeclaredManifest['parameters'][number];

/** An output with what it holds, so that the canvas can check what reads it. */
function viewOfOutput(
  output: DeclaredManifest['outputs'][number],
  parameters: readonly DeclaredParameter[],
): OutputView {
  const { name, description } = output;
  const base = { name, ...(description === undefined ? {} : { description }) };
  if ('json' in output) {
    return {
      ...base,
      type: 'path',
      fields: output.fields.map((field) => ({
        name: field.name,
        type: field.type,
        ...(field.description === undefined ? {} : { description: field.description }),
        ...(field.secret ? { secret: true as const } : {}),
      })),
    };
  }
  if ('path' in output) return { ...base, type: 'path' };
  const parameter = parameters.find(({ name: candidate }) => candidate === output.param);
  return { ...base, type: parameter?.type === 'path' ? 'path' : 'text' };
}

function deliveryOf(parameter: DeclaredParameter): ParameterView['delivery'] {
  if (parameter.stdin) {
    return 'script';
  }
  return parameter.env === undefined ? 'argument' : 'environment';
}

function viewOfParameter(parameter: DeclaredParameter): ParameterView {
  const { name, label, type, required, description } = parameter;
  return {
    name,
    label,
    type,
    required,
    delivery: deliveryOf(parameter),
    ...(description === undefined ? {} : { description }),
    ...(parameter.default === undefined ? {} : { default: parameter.default }),
    ...(type === 'choice' ? { choices: parameter.choices } : {}),
    ...(type === 'string' && parameter.secret ? { secret: true } : {}),
  };
}

function scopeChoice(scope: InstallScope): ToolScopeChoice {
  return scope.kind === 'global' ? 'global' : 'workspace';
}

async function viewOfTool(tool: RegisteredTool, pathVariables: PathVariables): Promise<ToolView> {
  const { manifest } = tool;
  const { id, name, level, category, description, interpreter, permissions } = manifest;
  return {
    key: toolKey(tool),
    id,
    scope: scopeChoice(tool.scope),
    name,
    level,
    ...(category === undefined ? {} : { category }),
    ...(description === undefined ? {} : { description }),
    ...(interpreter === undefined ? {} : { interpreter }),
    program: manifest.run.program,
    ...(manifest.level === 0
      ? {}
      : {
          parameters: manifest.parameters.map(viewOfParameter),
          outputs: manifest.outputs.map((output) => output.name),
          outputDetails: manifest.outputs.map((output) =>
            viewOfOutput(output, manifest.parameters),
          ),
          ...(manifest.stdin === undefined ? {} : { hasScript: true as const }),
        }),
    permissions,
    runtime: await checkRuntime(tool, { pathVariables }),
  };
}

async function viewOfGroup(
  { category, tools }: ToolGroup,
  logos: ReadonlyMap<string, string>,
  pathVariables: PathVariables,
): Promise<ToolGroupView> {
  const views = await Promise.all(tools.map((tool) => viewOfTool(tool, pathVariables)));
  const logo = category === undefined ? undefined : logos.get(categoryKey(category));
  return {
    ...(category === undefined ? {} : { category }),
    ...(logo === undefined ? {} : { logo }),
    tools: views,
  };
}

/** What the shell can do with installed tools. Rules stay in core; this only shapes the results. */
export class ToolService {
  private readonly registry: ToolRegistry;
  private readonly dataDir: string;
  private readonly secrets: SecretStore;
  private readonly workspaceId: () => string;

  /** `workspaceId` is asked on every call, because the user can switch at any time. */
  constructor(
    registry: ToolRegistry,
    dataDir: string,
    secrets: SecretStore,
    workspaceId: () => string,
  ) {
    this.registry = registry;
    this.dataDir = dataDir;
    this.secrets = secrets;
    this.workspaceId = workspaceId;
  }

  private scopeFor(choice: ToolScopeChoice): InstallScope {
    return choice === 'global' ? GLOBAL_SCOPE : workspaceScope(this.workspaceId());
  }

  /** Values from a file the user can edit. Unreadable, the tools using them say what is missing. */
  private pathVariables(): Promise<PathVariables> {
    return readPathVariables(this.dataDir).catch(() => new Map<string, string>());
  }

  private async categoryOrder(): Promise<readonly string[]> {
    const workspace = await getWorkspace(this.dataDir, this.workspaceId()).catch(() => undefined);
    return workspace?.layout.categoryOrder ?? [];
  }

  async catalog(): Promise<ToolCatalog> {
    const [{ tools, problems }, logos, pathVariables, order] = await Promise.all([
      listVisibleTools(this.registry, this.workspaceId()),
      // Logos are decoration: an unreadable file must never cost the user their tools.
      readCategoryLogos(this.dataDir).catch(() => new Map<string, string>()),
      this.pathVariables(),
      this.categoryOrder(),
    ]);
    const groups = orderGroups(groupByCategory(tools), order);
    return {
      groups: await Promise.all(groups.map((group) => viewOfGroup(group, logos, pathVariables))),
      problems: problems.map(({ folder, scope, message }) => ({
        folder,
        scope: scopeChoice(scope),
        message,
      })),
    };
  }

  /** The rail order with a category moved one place, or undefined if it cannot go that way. */
  async movedCategoryOrder(
    category: string,
    offset: -1 | 1,
  ): Promise<readonly string[] | undefined> {
    const [{ tools }, order] = await Promise.all([
      listVisibleTools(this.registry, this.workspaceId()),
      this.categoryOrder(),
    ]);
    const groups = groupByCategory(tools);
    const key = categoryKey(category);
    const named = orderGroups(groups, order).filter((group) => group.category !== undefined);
    const index = named.findIndex((group) => categoryKey(group.category ?? '') === key);
    const target = index + offset;
    return index === -1 || target < 0 || target >= named.length
      ? undefined
      : moveCategory(groups, order, category, offset);
  }

  async hasLogo(category: string): Promise<boolean> {
    const logos = await readCategoryLogos(this.dataDir);
    return logos.has(categoryKey(category));
  }

  async setLogo(category: string, source: string): Promise<void> {
    await setCategoryLogo(this.dataDir, category, source);
  }

  async removeLogo(category: string): Promise<void> {
    await removeCategoryLogo(this.dataDir, category);
  }

  /** Looks at paths only. Nothing is opened or executed. */
  async detect(paths: readonly string[], recursive = true): Promise<DetectionView> {
    const { tools } = await listVisibleTools(this.registry, this.workspaceId());
    const pathVariables = await this.pathVariables();
    const detection: Detection = await detectPrograms(paths, {
      recursive,
      registered: tools,
      pathVariables,
    });
    return detection;
  }

  async register(input: RegisterTools): Promise<RegistrationView> {
    const scope = this.scopeFor(input.scope);
    const { registered, failures } = await registerPrograms(this.registry, input.programs, scope);
    return { registeredIds: registered.map((tool) => tool.manifest.id), failures };
  }

  async importManifests(
    paths: readonly string[],
    choice: ToolScopeChoice,
  ): Promise<RegistrationView> {
    const scope = this.scopeFor(choice);
    const { registered, failures } = await importManifests(this.registry, paths, scope);
    return { registeredIds: registered.map((tool) => tool.manifest.id), failures };
  }

  async profiles(toolId: string): Promise<readonly ProfileView[]> {
    return listProfiles(await this.get(toolId));
  }

  /** Saves a profile. The answer names which secrets are set, and holds none of them. */
  async saveProfile({ toolId, id, name, values, secrets }: SaveProfileInput): Promise<ProfileView> {
    return saveProfile(await this.get(toolId), { id, name, values, secrets }, this.secrets);
  }

  async removeProfile(toolId: string, id: string): Promise<void> {
    await removeProfile(await this.get(toolId), id, this.secrets);
  }

  async update(id: string, details: ToolDetailsInput): Promise<void> {
    const { scope } = await this.get(id);
    await updateToolDetails(this.registry, id, details, scope);
  }

  /** Moves a tool to a scope. Nothing happens if it is there already. */
  async setScope(tool: RegisteredTool, choice: ToolScopeChoice): Promise<void> {
    if (choice !== scopeChoice(tool.scope)) {
      const target = this.scopeFor(choice);
      await moveTool(this.registry, tool.manifest.id, tool.scope, target, this.secrets);
    }
  }

  async get(id: string): Promise<RegisteredTool> {
    const tool = await findVisibleTool(this.registry, this.workspaceId(), id);
    if (tool === undefined) {
      throw new Error(`Tool "${id}" is not installed`);
    }
    return tool;
  }

  async remove(tool: RegisteredTool): Promise<void> {
    await removeTool(this.registry, tool.manifest.id, this.secrets, tool.scope);
  }

  /** Where the tool's program is on this machine, if it can be found. Nothing is run. */
  async programPath(id: string): Promise<string | undefined> {
    const tool = await findVisibleTool(this.registry, this.workspaceId(), id);
    return tool === undefined
      ? undefined
      : locateProgram(tool, { pathVariables: await this.pathVariables() });
  }
}

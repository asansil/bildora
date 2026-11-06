import {
  categoryKey,
  checkRuntime,
  detectPrograms,
  groupByCategory,
  importManifests,
  listProfiles,
  readCategoryLogos,
  registerPrograms,
  removeCategoryLogo,
  removeProfile,
  removeTool,
  saveProfile,
  setCategoryLogo,
  updateToolDetails,
} from '@bildora/core';
import type {
  Detection,
  RegisteredTool,
  SecretStore,
  ToolGroup,
  ToolRegistry,
} from '@bildora/core';
import type {
  DetectionView,
  ParameterView,
  ProfileView,
  RegisterTools,
  RegistrationView,
  SaveProfileInput,
  ToolCatalog,
  ToolDetailsInput,
  ToolGroupView,
  ToolView,
} from '../shared/ipc-contract.js';

type DeclaredParameter = Extract<RegisteredTool['manifest'], { level: 1 }>['parameters'][number];

function viewOfParameter(parameter: DeclaredParameter): ParameterView {
  const { name, label, type, required, description } = parameter;
  return {
    name,
    label,
    type,
    required,
    delivery: parameter.env === undefined ? 'argument' : 'environment',
    ...(description === undefined ? {} : { description }),
    ...(parameter.default === undefined ? {} : { default: parameter.default }),
    ...(type === 'choice' ? { choices: parameter.choices } : {}),
    ...(type === 'string' && parameter.secret ? { secret: true } : {}),
  };
}

async function viewOfTool(tool: RegisteredTool): Promise<ToolView> {
  const { manifest } = tool;
  const { id, name, level, category, description, interpreter, permissions } = manifest;
  return {
    id,
    name,
    level,
    ...(category === undefined ? {} : { category }),
    ...(description === undefined ? {} : { description }),
    ...(interpreter === undefined ? {} : { interpreter }),
    ...(manifest.level === 2 ? {} : { program: manifest.run.program }),
    ...(manifest.level === 0 ? {} : { parameters: manifest.parameters.map(viewOfParameter) }),
    permissions,
    runtime: await checkRuntime(tool),
  };
}

async function viewOfGroup(
  { category, tools }: ToolGroup,
  logos: ReadonlyMap<string, string>,
): Promise<ToolGroupView> {
  const views = await Promise.all(tools.map(viewOfTool));
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

  constructor(registry: ToolRegistry, dataDir: string, secrets: SecretStore) {
    this.registry = registry;
    this.dataDir = dataDir;
    this.secrets = secrets;
  }

  async catalog(): Promise<ToolCatalog> {
    const [{ tools, problems }, logos] = await Promise.all([
      this.registry.list(),
      // Logos are decoration: an unreadable file must never cost the user their tools.
      readCategoryLogos(this.dataDir).catch(() => new Map<string, string>()),
    ]);
    return {
      groups: await Promise.all(groupByCategory(tools).map((group) => viewOfGroup(group, logos))),
      problems: problems.map(({ folder, message }) => ({ folder, message })),
    };
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
    const { tools } = await this.registry.list();
    const detection: Detection = await detectPrograms(paths, { recursive, registered: tools });
    return detection;
  }

  async register(input: RegisterTools): Promise<RegistrationView> {
    const { registered, failures } = await registerPrograms(this.registry, input.programs);
    return { registeredIds: registered.map((tool) => tool.manifest.id), failures };
  }

  async importManifests(paths: readonly string[]): Promise<RegistrationView> {
    const { registered, failures } = await importManifests(this.registry, paths);
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
    const updated = await updateToolDetails(this.registry, id, details);
    if (updated === undefined) {
      throw new Error(`Tool "${id}" is not installed`);
    }
  }

  async get(id: string): Promise<RegisteredTool> {
    const tool = await this.registry.get(id);
    if (tool === undefined) {
      throw new Error(`Tool "${id}" is not installed`);
    }
    return tool;
  }

  async remove(id: string): Promise<void> {
    await removeTool(this.registry, id, this.secrets);
  }
}

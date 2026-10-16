import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import type { OpenClawPluginToolFactory } from "../plugins/tool-types.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { readWorkspaceSkillSources } from "../skills/loading/workspace-skill-source-reader.js";
import { syncWorkspaceSkills } from "../skills/loading/workspace-skill-sync.runtime.js";
import { closeSkillsWatchers, refreshSkillsDiscovery } from "../skills/runtime/refresh.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
} from "../skills/test-support/home-env.test-support.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { resolveSandboxSkillRuntimeInputs } from "./embedded-agent-runner/sandbox-skills.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";

const tempDirs = createTempDirTracker();
let factory: OpenClawPluginToolFactory<2> | undefined;
beforeAll(async () => {
  const { default: autoreview } = await loadBundledPluginFacade<{
    default: OpenClawPluginDefinition;
  }>({ pluginId: "autoreview", artifactBasename: "index.js" });
  autoreview.register!(
    createTestPluginApi({
      registerTool(tool) {
        if (typeof tool === "object" && "contextVersion" in tool) {
          factory = tool;
        }
      },
    }),
  );
});
afterEach(async () => {
  await closeSkillsWatchers(true);
  tempDirs.cleanup();
});

it("binds a discovered personal Auto Review installation but not a project replacement", async () => {
  const home = tempDirs.make("autoreview-personal-");
  const environment = setMockSkillsHomeEnv(home);
  const workspace = path.join(home, "workspace");
  const sandboxDir = path.join(home, "sandbox");
  const personal = path.join(home, ".agents", "skills", "autoreview");
  const options = {
    config: { plugins: { enabled: false }, skills: { load: { watch: false } } },
    managedSkillsDir: path.join(home, "managed"),
    bundledSkillsDir: path.join(home, "bundled"),
  };
  const sandbox = createAgentToolsSandboxContext({
    workspaceDir: sandboxDir,
    agentWorkspaceDir: workspace,
    workspaceAccess: "none",
    containerWorkdir: "/guest/repo",
  });
  sandbox.backend = {
    id: "fixture",
    runtimeId: "personal-skill",
    runtimeLabel: "Personal skill",
    capabilities: { readOnlyResourceMounts: true },
    workdir: "/guest/repo",
    buildExecSpec: vi.fn(),
    runShellCommand: vi.fn(),
  };
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: {
      readFile: vi.fn(),
      readFileWithSource: vi.fn(),
      readDirectory: vi.fn(),
      writeFile: vi.fn(),
      createFileExclusive: vi.fn(),
      stat: vi.fn(),
    },
    loadSkills: async (request) => readWorkspaceSkillSources(request),
  });
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "caller",
    scopes: [],
    assertCurrent() {},
  });
  const bind = async () => {
    const snapshot = await buildSkillSnapshot(workspace, options);
    sandbox.skillUsagePaths = await syncWorkspaceSkills({
      ...options,
      sourceWorkspaceDir: workspace,
      targetWorkspaceDir: sandboxDir,
      skillsSnapshot: snapshot,
    });
    const prepared = resolveSandboxSkillRuntimeInputs({
      sandbox,
      skillsAnchorWorkspace: workspace,
      skillsSnapshot: snapshot,
    });
    const capabilities = preparePluginToolExecutionCapabilities({
      sandbox,
      skillsSnapshot: prepared.skillsSnapshot,
      authority,
    })(() => {});
    return {
      snapshot,
      capabilities,
      tool: factory!.create({
        ...capabilities,
        assertInvocationCurrent() {},
      }),
    };
  };
  try {
    await writeSkill({ dir: personal, name: "autoreview", description: "Installed reviewer" });
    await fs.mkdir(path.join(personal, "scripts"));
    await fs.writeFile(
      path.join(personal, "scripts", "autoreview"),
      "# protected helper fixture\n",
    );
    const installed = await bind();
    expect(installed.snapshot.discoverySkills).toEqual([
      expect.objectContaining({ source: "agents-skills-personal", fileHost: "gateway" }),
    ]);
    expect(installed.snapshot.skills[0]?.source).toEqual({
      filePath: await fs.realpath(path.join(personal, "SKILL.md")),
      fileHost: "gateway",
    });
    expect(installed.capabilities.sandbox?.installedSkillRoots).toEqual({
      autoreview: "/guest/repo/skills/autoreview",
    });
    expect(installed.tool).toMatchObject({ name: "autoreview" });
    expect(
      await fs.readFile(
        path.join(sandboxDir, "skills", "autoreview", "scripts", "autoreview"),
        "utf8",
      ),
    ).toBe("# protected helper fixture\n");
    await writeSkill({
      dir: path.join(workspace, ".agents", "skills", "autoreview"),
      name: "autoreview",
      description: "Project replacement",
    });
    await refreshSkillsDiscovery({ workspaceDir: workspace });
    const project = await bind();
    expect(project.snapshot.discoverySkills).toEqual([
      expect.objectContaining({ source: "agents-skills-project", fileHost: "workspace" }),
    ]);
    expect(project.capabilities.sandbox?.installedSkillRoots).toEqual({});
    expect(project.tool).toBeNull();
  } finally {
    release();
    await closeSkillsWatchers(true);
    await restoreMockSkillsHomeEnv(environment);
  }
});

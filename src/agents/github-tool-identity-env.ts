import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { CLEARED_GITHUB_CREDENTIALS } from "./github-host-runtime.js";
import { GITHUB_PUBLIC_HOST } from "./github-host.js";

export const AGENT_GIT_CONFIG_PARAMETERS = "'maintenance.auto=false' 'gc.auto=0'";

export function managedGitHubIdentityEnvironment(params: {
  profileDir: string;
  host?: string;
  gitAuthor?: { name?: string; email?: string };
  gitConfig?: readonly (readonly [string, string])[];
}): Readonly<Record<string, string> & { GH_CONFIG_DIR: string }> {
  const author = params.gitAuthor;
  const gitConfigEntries = [
    ...(params.gitConfig ?? []),
    ...Object.entries({
      ...(author?.name ? { "user.name": author.name } : {}),
      ...(author?.email ? { "user.email": author.email } : {}),
    }),
  ];
  const gitConfigEnv = Object.fromEntries(
    gitConfigEntries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ]),
  );
  return {
    GH_CONFIG_DIR: params.profileDir,
    GH_HOST: params.host ?? GITHUB_PUBLIC_HOST,
    ...(gitConfigEntries.length > 0
      ? { GIT_CONFIG_COUNT: String(gitConfigEntries.length), ...gitConfigEnv }
      : {}),
    ...(author?.name ? { GIT_AUTHOR_NAME: author.name, GIT_COMMITTER_NAME: author.name } : {}),
    ...(author?.email ? { GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_EMAIL: author.email } : {}),
  };
}

/** Signing keys and preview credentials never enter agent child processes. */
export function githubCredentialEnvironmentExclusions(
  params: {
    config: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
    agentId: string;
  },
  selected?: GitHubToolIdentityConfig,
) {
  const source = params.sourceConfig ?? params.config;
  const sourceIdentity =
    resolveAgentConfig(source, params.agentId)?.tools?.github ?? source.tools?.github;
  const values = [
    source.gateway?.controlUi?.github?.token ?? params.config.gateway?.controlUi?.github?.token,
  ];
  if (selected?.kind === "app-installation") {
    values.push(
      sourceIdentity?.kind === "app-installation"
        ? sourceIdentity.app.privateKey
        : selected.app.privateKey,
    );
  }
  const credentialScrubEnv: Record<string, string> = selected
    ? { ...CLEARED_GITHUB_CREDENTIALS }
    : {};
  const excludedStoreNames: string[] = [];
  for (const value of values) {
    if (!isSecretRef(value)) {
      continue;
    }
    if (value.source === "env" && isValidEnvSecretRefId(value.id)) {
      credentialScrubEnv[value.id] = "";
    } else if (value.source === "store") {
      credentialScrubEnv[value.id] = "";
      excludedStoreNames.push(value.id);
    }
  }
  return { credentialScrubEnv, excludedStoreNames };
}

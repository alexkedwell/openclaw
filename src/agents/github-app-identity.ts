import { isDeepStrictEqual } from "node:util";
import type { GitHubIdentityFacts } from "../../packages/gateway-protocol/src/index.js";
import {
  prepareGitHubAppInstallation,
  readGitHubAppInstallationMetadata,
  type GitHubAppSelection,
} from "./github-app-installation.js";
import type { GitHubCredentialReader } from "./github-credential-reader.js";
import { resolveGitHubHost, resolveGitHubApiBaseUrl } from "./github-host-runtime.js";
import { GitHubIdentityError, type GitHubIdentityPreparation } from "./github-read-identity.js";

export async function prepareAppGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
    readNativeCredential?: GitHubCredentialReader;
  },
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
  env: NodeJS.ProcessEnv,
  host: string,
  apiBaseUrl: string,
) {
  const snapshot = structuredClone(selection);
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (
      resolveGitHubHost() !== host ||
      resolveGitHubApiBaseUrl() !== apiBaseUrl ||
      !isDeepStrictEqual(selection, snapshot)
    ) {
      throw new GitHubIdentityError("changed");
    }
  };
  assertCurrent();
  if (process.env.FACTORY_AUTH_MODE === "github") {
    if (!params.readNativeCredential) {
      throw new GitHubIdentityError("unavailable");
    }
    await params.readNativeCredential(env, { kind: "repository-admission", host, selection });
    assertCurrent();
  }
  const issued = await prepareGitHubAppInstallation({ selection, host, apiBaseUrl, assertCurrent });
  try {
    assertCurrent();
    const prepared = Object.freeze({
      source,
      profileId: selection.profileId,
      host,
      account: issued.account,
      accessExpiresAtMs: issued.expiresAtMs,
      revoke: issued.revoke,
    });
    return { prepared, token: issued.token, readToken: issued.readToken, stale: undefined };
  } catch (error) {
    await issued.revoke().catch(() => {});
    throw error;
  }
}

export function configuredAppGitHubIdentityFacts(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
): GitHubIdentityFacts {
  const metadata = readGitHubAppInstallationMetadata(
    selection,
    resolveGitHubHost(),
    resolveGitHubApiBaseUrl(),
  );
  return {
    source,
    credentialKind: "app-installation",
    credentialState: metadata ? "available" : "configured_unavailable",
    account: metadata ? { login: metadata.account.login } : null,
    gitAuthor: {
      name: selection.gitAuthor?.name ?? null,
      email: selection.gitAuthor?.email ?? null,
    },
    evidence: metadata ? "github-api" : "none",
    accessExpiresAtMs: metadata?.expiresAtMs ?? null,
    refreshState: "not_applicable",
    oauthScopes: [],
    repositoryGrants: "unknown",
  };
}

export function configuredAppGitHubOptionsIdentity(
  selection: GitHubAppSelection,
  source: "system-configured" | "agent-override",
) {
  const metadata = readGitHubAppInstallationMetadata(
    selection,
    resolveGitHubHost(),
    resolveGitHubApiBaseUrl(),
  );
  if (!metadata) {
    throw new GitHubIdentityError("unavailable");
  }
  return { source, account: metadata.account, stale: undefined };
}

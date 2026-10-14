#!/usr/bin/env node
// Verify the packaged entry point after relocation and signing, in isolated state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { auditMacRuntimePortability } from "./lib/mac-runtime-portability.mjs";
import { verifyMacStandaloneRuntime } from "./lib/mac-standalone-runtime.mjs";
import { runManagedCommand, terminateManagedChild } from "./lib/managed-child-process.mts";

const [
  runtimeArg,
  expectedInfoPath,
  appArg,
  arch = process.arch === "x64" ? "x86_64" : process.arch,
] = process.argv.slice(2);
if (!runtimeArg || !expectedInfoPath) {
  throw new Error(
    "Usage: verify-mac-runtime.mjs <runtime> <expected-build-info.json> [app] [architecture]",
  );
}
const runtime = fs.realpathSync(runtimeArg);
const executable = path.join(runtime, "openclaw");
const packageRoot = path.join(runtime, "runtime");
const expected = JSON.parse(fs.readFileSync(expectedInfoPath, "utf8"));
const selected = JSON.parse(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"));
const manifest = await verifyMacStandaloneRuntime(runtime, expected, selected.mode, arch);
assert.match(manifest.buildId, /^[a-f\d]{64}$/u, "Missing packaged runtime build identity");
for (const legacy of ["bin", "lib/node_modules"]) {
  assert(!fs.existsSync(path.join(runtime, legacy)), `Legacy runtime layout remains: ${legacy}`);
}
assert(
  fs.existsSync(path.join(packageRoot, "dist/control-ui/index.html")),
  "Bundled Control UI is missing",
);
const sqliteLibrary = path.join(runtime, "lib/libsqlite3.dylib");
assert(fs.existsSync(sqliteLibrary), "Bundled SQLite library is missing");
assert.equal(
  JSON.parse(fs.readFileSync(path.join(packageRoot, "openclaw-install-owner.json"), "utf8")).owner,
  "macos-app",
);
const nativeFiles = auditMacRuntimePortability(runtime, executable);
assert.equal(
  execFileSync(
    "/usr/bin/find",
    [appArg ? fs.realpathSync(appArg) : runtime, "-type", "f", "-name", "node", "-print"],
    { encoding: "utf8" },
  ),
  "",
  "App bundle contains a Node executable",
);
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-proof-")));
const sandbox = path.join(home, "runtime-proof.sb");
fs.writeFileSync(
  sandbox,
  `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny file-read* (subpath (param "ORIGINAL_HOME")))
(allow file-read* (subpath (param "RUNTIME")))
(allow file-read* file-write* (subpath (param "ISOLATED_ROOT")))
(allow file-write* (literal "/dev/null"))
(deny process-exec (literal "/bin/launchctl"))
(deny mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc"))
(deny ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(deny file-read* file-write* (subpath "/Library/Keychains"))
`,
);
const sandboxArgs = [
  "-D",
  `ORIGINAL_HOME=${os.userInfo().homedir}`,
  "-D",
  `RUNTIME=${runtime}`,
  "-D",
  `ISOLATED_ROOT=${home}`,
  "-f",
  sandbox,
  "/usr/bin/arch",
  `-${arch}`,
  executable,
];
const environment = {
  HOME: home,
  CFFIXED_USER_HOME: home,
  TMPDIR: home,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  OPENCLAW_SQLITE_LIBRARY: sqliteLibrary,
  OPENCLAW_STATE_DIR: path.join(home, "state"),
  OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
  OPENCLAW_NO_RESPAWN: "1",
};
const launch = (args) =>
  execFileSync("/usr/bin/sandbox-exec", [...sandboxArgs, ...args], {
    cwd: home,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
try {
  const version = launch(["--version"]).trim();
  assert.equal(
    /^OpenClaw (\S+)(?: \([^)]+\))?$/u.exec(version)?.[1],
    expected.version,
    `Bundled CLI version mismatch: ${version}`,
  );
  launch(["gateway", "--help"]);
  launch(["doctor", "--non-interactive"]);
  // The builder owns embedded worker dispatch. Exercise its public child entry
  // through the same executable and argv shape used by the app.
  let ready = false;
  let failure;
  let diagnostic = "";
  const exitCode = await runManagedCommand({
    bin: "/usr/bin/sandbox-exec",
    args: [...sandboxArgs, path.join(packageRoot, "dist/mac-node-worker.js"), "node", "worker"],
    cwd: home,
    env: { ...environment, OPENCLAW_NODE_EXEC_HOST: "app", OPENCLAW_NODE_EXEC_FALLBACK: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs: 300_000,
    requireProcessTreeExit: true,
    onReady(child) {
      const lines = createInterface({ input: child.stdout });
      child.stderr.on("data", (data) => {
        diagnostic = (diagnostic + data.toString()).slice(-4000);
      });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type !== "ready") {
          return;
        }
        if (
          message.version !== expected.version ||
          !["system.run", "system.which", "browser.proxy", "mcp.tools.call.v1"].every((command) =>
            message.manifest?.commands?.includes(command),
          )
        ) {
          failure = new Error(
            `Bundled worker capability mismatch: ${JSON.stringify(message.manifest)}`,
          );
        } else {
          ready = true;
        }
        child.stdin.end('{"type":"stop"}\n');
      });
      child.on("close", () => lines.close());
      child.stdin.on("error", (error) => {
        failure = error;
        terminateManagedChild(child, "SIGKILL");
      });
    },
  });
  if (failure || !ready || exitCode !== 0 || /failed during register/u.test(diagnostic)) {
    throw new Error(
      `Bundled worker proof failed (${exitCode}): ${failure?.message ?? "missing readiness or registration failure"}; ${diagnostic}`,
      { cause: failure },
    );
  }
  console.log(
    JSON.stringify({
      architecture: arch,
      buildId: manifest.buildId,
      mode: manifest.mode,
      nativeFiles,
      version,
    }),
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

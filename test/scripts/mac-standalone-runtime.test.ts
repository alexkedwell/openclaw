import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const commit = "a".repeat(40);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const root = temps.make("mac-standalone-");
  for (const directory of ["scripts/lib", "dist", "bin", "input/runtime"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  copyFileSync("scripts/stage-mac-runtime.sh", path.join(root, "scripts/stage-mac-runtime.sh"));
  symlinkSync(
    path.resolve("scripts/lib/mac-standalone-runtime.mjs"),
    path.join(root, "scripts/lib/mac-standalone-runtime.mjs"),
  );
  symlinkSync(process.execPath, path.join(root, "bin/node"));
  writeFileSync(
    path.join(root, "scripts/build-mac-sqlite.sh"),
    '#!/bin/bash\nmkdir -p "$2/lib"\nprintf sqlite > "$2/lib/libsqlite3.dylib"\n',
  );
  const bytes = '#!/bin/sh\nprintf "OpenClaw 2026.10.14\\n"\n';
  writeFileSync(path.join(root, "input/openclaw"), bytes);
  chmodSync(path.join(root, "input/openclaw"), 0o755);
  writeFileSync(path.join(root, "input/runtime/package.json"), "{}");
  const manifest = {
    schemaVersion: 1,
    mode: "jit",
    target: { platform: "darwin", arch: "arm64" },
    openclaw: { version: "2026.10.14", commit },
    executable: { path: "openclaw", sizeBytes: Buffer.byteLength(bytes), sha256: hash(bytes) },
    runtime: {
      path: "runtime",
      sizeBytes: 2,
      sha256: hash(`package.json\0file\0${hash("{}")}\n`),
      fileCount: 1,
      symlinkCount: 0,
    },
    macos: {
      hardenedRuntime: true,
      entitlements: {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
    },
  };
  const save = () =>
    writeFileSync(path.join(root, "input/manifest.json"), JSON.stringify(manifest));
  save();
  writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.10.14", commit }),
  );
  const output = path.join(root, "output");
  const run = (env: Record<string, string> = {}, arches = ["arm64"]) =>
    spawnSync("/bin/bash", [path.join(root, "scripts/stage-mac-runtime.sh"), output, ...arches], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        OPENCLAW_MAC_RUNTIME_PREBUILT: path.join(root, "input"),
        ...env,
      },
    });
  return { root, output, manifest, save, run };
}

describe.skipIf(process.platform !== "darwin")("standalone Mac runtime staging", () => {
  it("stages a validated executable and sidecar, with app ownership and no loose interpreter tree", () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(f.output, "openclaw"), "utf8")).toContain("OpenClaw");
    expect(existsSync(path.join(f.output, "bin/bun"))).toBe(false);
    expect(existsSync(path.join(f.output, "lib/node_modules"))).toBe(false);
    expect(existsSync(path.join(f.output, "lib/libsqlite3.dylib"))).toBe(false);
    expect(readFileSync(path.join(f.output, "runtime/lib/libsqlite3.dylib"), "utf8")).toBe(
      "sqlite",
    );
    expect(
      JSON.parse(readFileSync(path.join(f.output, "runtime/openclaw-install-owner.json"), "utf8"))
        .owner,
    ).toBe("macos-app");
    const packaged = JSON.parse(readFileSync(path.join(f.output, "manifest.json"), "utf8"));
    expect(packaged.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(packaged.openclaw.commit).toBe(commit);
    expect(packaged.runtime.sha256).not.toBe(f.manifest.runtime.sha256);
  });

  it("identifies the completed unsigned sidecar and preserves that identity during signing", () => {
    const first = fixture();
    const second = fixture();
    writeFileSync(
      path.join(second.root, "scripts/build-mac-sqlite.sh"),
      '#!/bin/bash\nmkdir -p "$2/lib"\nprintf other-sqlite > "$2/lib/libsqlite3.dylib"\n',
    );
    for (const f of [first, second]) {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
    }
    const firstManifest = JSON.parse(
      readFileSync(path.join(first.output, "manifest.json"), "utf8"),
    );
    const unsigned = JSON.parse(readFileSync(path.join(second.output, "manifest.json"), "utf8"));
    expect(unsigned.buildId).not.toBe(firstManifest.buildId);
    writeFileSync(path.join(second.output, "openclaw"), "signed executable");
    writeFileSync(path.join(second.output, "runtime/lib/libsqlite3.dylib"), "signed library");
    const sealed = spawnSync(
      process.execPath,
      [path.resolve("scripts/lib/mac-standalone-runtime.mjs"), "seal", second.output],
      { encoding: "utf8" },
    );
    expect(sealed.status, sealed.stderr).toBe(0);
    const signed = JSON.parse(readFileSync(path.join(second.output, "manifest.json"), "utf8"));
    expect(signed.buildId).toBe(unsigned.buildId);
    expect(signed.executable.sha256).not.toBe(unsigned.executable.sha256);
    expect(signed.runtime.sha256).not.toBe(unsigned.runtime.sha256);
  });

  it("reuses the builder's canonical SQLite library without producing a second copy", () => {
    const f = fixture();
    const sqlite = "builder-sqlite";
    mkdirSync(path.join(f.root, "input/runtime/lib"));
    writeFileSync(path.join(f.root, "input/runtime/lib/libsqlite3.dylib"), sqlite);
    f.manifest.runtime = {
      path: "runtime",
      sizeBytes: 2 + Buffer.byteLength(sqlite),
      sha256: hash(
        `lib/libsqlite3.dylib\0file\0${hash(sqlite)}\npackage.json\0file\0${hash("{}")}\n`,
      ),
      fileCount: 2,
      symlinkCount: 0,
    };
    f.save();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(f.output, "runtime/lib/libsqlite3.dylib"), "utf8")).toBe(sqlite);
    expect(existsSync(path.join(f.output, "lib/libsqlite3.dylib"))).toBe(false);
  });

  it.each(["commit", "mode", "executable", "sidecar", "target", "entitlements"])(
    "rejects mismatched %s before publishing",
    (failure) => {
      const f = fixture();
      if (failure === "commit") {
        f.manifest.openclaw.commit = "b".repeat(40);
      }
      if (failure === "mode") {
        f.manifest.mode = "bytecode";
      }
      if (failure === "target") {
        f.manifest.target.arch = "x64";
      }
      if (failure === "entitlements") {
        Object.assign(f.manifest.macos.entitlements, {
          "com.apple.security.cs.allow-unsigned-executable-memory": true,
        });
      }
      if (failure === "executable") {
        writeFileSync(path.join(f.root, "input/openclaw"), "wrong executable");
      }
      if (failure === "sidecar") {
        writeFileSync(path.join(f.root, "input/runtime/package.json"), '{"wrong":true}');
      }
      f.save();
      const result = f.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/mismatch|entitlements/i);
      expect(existsSync(f.output)).toBe(false);
    },
  );

  it("accepts bytecode only with the explicit packaging mode", () => {
    const f = fixture();
    f.manifest.mode = "bytecode";
    f.save();
    const result = f.run({ OPENCLAW_MAC_RUNTIME_MODE: "bytecode" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects universal requests before invoking the single-target builder", () => {
    const f = fixture();
    const result = f.run({}, ["arm64", "x86_64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("one architecture");
    expect(existsSync(f.output)).toBe(false);
  });
});

// Native executable fixture exercises the complete signed-runtime verifier boundary.
// Its fixed CLI replies isolate admission checks; real native loading is release proof.
let verifierExecutable: Buffer | undefined;
function compileVerifierExecutable(root: string) {
  if (verifierExecutable) {
    return verifierExecutable;
  }
  const file = path.join(root, "fixture-cli");
  const result = spawnSync("/usr/bin/xcrun", ["clang", "-x", "c", "-", "-o", file], {
    encoding: "utf8",
    input: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
int main(int argc, char **argv) {
  char root[PATH_MAX], mode[64] = "valid", file[PATH_MAX];
  realpath(argv[0], root); *strrchr(root, '/') = 0;
  snprintf(file, sizeof(file), "%s/proof-case", root);
  FILE *input = fopen(file, "r"); if (input) { fgets(mode, sizeof(mode), input); fclose(input); }
  if (argc > 1 && !strcmp(argv[1], "--version")) { puts("OpenClaw 2026.10.14"); return 0; }
  if (argc > 1 && !strcmp(argv[1], "doctor")) {
    printf("SQLite (doctor process): %s (3.53.0, extension loading enabled)\\n",
      !strcmp(mode, "wrong-sqlite") ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib" : getenv("OPENCLAW_SQLITE_LIBRARY"));
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "memory")) {
    char extension[PATH_MAX];
    snprintf(extension, sizeof(extension), "%s/runtime/node_modules/sqlite-vec/vec0.dylib", root);
    printf("[{\\"agentId\\":\\"main\\",\\"status\\":{\\"backend\\":\\"builtin\\",\\"vector\\":{\\"enabled\\":true,\\"storeAvailable\\":%s,\\"extensionPath\\":\\"%s\\"}}}]\\n",
      !strcmp(mode, "vector-unavailable") ? "false" : "true",
      !strcmp(mode, "outside-vector") ? "/usr/bin/true" : extension);
    return 0;
  }
  if (argc > 1 && strstr(argv[1], "mac-node-worker.js")) {
    puts("{\\"type\\":\\"ready\\",\\"version\\":\\"2026.10.14\\",\\"manifest\\":{\\"commands\\":[\\"system.run\\",\\"system.which\\",\\"browser.proxy\\",\\"mcp.tools.call.v1\\"]}}");
    fflush(stdout); char line[128]; fgets(line, sizeof(line), stdin); return 0;
  }
  return 0;
}
`,
    timeout: 15_000,
  });
  expect(result.status, result.stderr).toBe(0);
  verifierExecutable = readFileSync(file);
  return verifierExecutable;
}

describe.skipIf(process.platform !== "darwin")("Mac packaged SQLite capability admission", () => {
  it.each(["valid", "wrong-sqlite", "vector-unavailable", "outside-vector"])(
    "checks the actual CLI capability replies (%s)",
    async (mode) => {
      const root = temps.make("mac-runtime-capability-");
      const runtime = path.join(root, "runtime");
      for (const directory of ["dist/control-ui", "lib", "node_modules/sqlite-vec"]) {
        mkdirSync(path.join(runtime, directory), { recursive: true });
      }
      const fixtureExecutable = compileVerifierExecutable(root);
      writeFileSync(path.join(root, "openclaw"), fixtureExecutable);
      chmodSync(path.join(root, "openclaw"), 0o755);
      writeFileSync(path.join(root, "proof-case"), mode);
      writeFileSync(path.join(runtime, "dist/control-ui/index.html"), "fixture");
      writeFileSync(path.join(runtime, "lib/libsqlite3.dylib"), "fixture library");
      writeFileSync(path.join(runtime, "node_modules/sqlite-vec/vec0.dylib"), "fixture vector");
      const { describeStandaloneRuntime, sha256File } =
        await import("../../scripts/lib/bun-standalone-contract.mjs");
      writeFileSync(
        path.join(root, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          mode: "jit",
          target: { platform: "darwin", arch: process.arch },
          openclaw: { version: "2026.10.14", commit },
          executable: {
            path: "openclaw",
            sizeBytes: fixtureExecutable.length,
            sha256: await sha256File(path.join(root, "openclaw")),
          },
          runtime: await describeStandaloneRuntime(runtime),
          macos: {
            hardenedRuntime: true,
            entitlements: {
              "com.apple.security.cs.allow-jit": true,
              "com.apple.security.cs.disable-library-validation": true,
            },
          },
        }),
      );
      const stage = spawnSync(
        process.execPath,
        [path.resolve("scripts/lib/mac-standalone-runtime.mjs"), "stage", root],
        { encoding: "utf8" },
      );
      expect(stage.status, stage.stderr).toBe(0);
      const expected = path.join(root, "expected.json");
      writeFileSync(expected, JSON.stringify({ version: "2026.10.14", commit }));
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/verify-mac-runtime.mjs"), root, expected],
        { encoding: "utf8", timeout: 20_000 },
      );
      if (mode === "valid") {
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(result.status, result.stdout + result.stderr).not.toBe(0);
        expect(result.stderr).toContain(mode === "wrong-sqlite" ? "Doctor SQLite" : "vector");
      }
    },
  );
});

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
    expect(
      JSON.parse(readFileSync(path.join(f.output, "runtime/openclaw-install-owner.json"), "utf8"))
        .owner,
    ).toBe("macos-app");
    const packaged = JSON.parse(readFileSync(path.join(f.output, "manifest.json"), "utf8"));
    expect(packaged.buildId).toMatch(/^[a-f0-9]{64}$/);
    expect(packaged.openclaw.commit).toBe(commit);
    expect(packaged.runtime.sha256).not.toBe(f.manifest.runtime.sha256);
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

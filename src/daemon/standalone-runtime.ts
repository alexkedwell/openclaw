import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isMissingPathError } from "../infra/errno.js";

const standaloneManifestSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(["jit", "bytecode"]),
  executable: z.object({ path: z.string().min(1) }),
  runtime: z.object({ path: z.string().min(1) }),
  openclaw: z.object({ version: z.string().min(1) }),
  bun: z.object({ version: z.string().min(1) }),
});

/** Packaging verifies hashes; service planning only needs the artifact's runtime identity. */
export function readStandaloneRuntimeManifest(executable: string) {
  if (!path.isAbsolute(executable)) {
    return undefined;
  }
  const root = path.dirname(executable);
  const manifestPath = path.join(root, "manifest.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Invalid standalone runtime manifest: ${manifestPath}`, { cause });
  }
  const manifest = standaloneManifestSchema.safeParse(parsed);
  const sidecarPath = manifest.success ? path.resolve(root, manifest.data.runtime.path) : root;
  const sidecarRelative = path.relative(root, sidecarPath);
  if (
    !manifest.success ||
    path.isAbsolute(manifest.data.executable.path) ||
    path.resolve(root, manifest.data.executable.path) !== path.resolve(executable) ||
    path.isAbsolute(manifest.data.runtime.path) ||
    !sidecarRelative ||
    sidecarRelative === ".." ||
    sidecarRelative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Invalid standalone runtime manifest: ${manifestPath}`);
  }
  return manifest.data;
}

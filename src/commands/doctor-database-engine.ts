import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { selectDatabaseEngine } from "../infra/database-engine/registry.js";
import { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import type {
  DoctorDatabaseEngineInspection,
  ObservedDatabaseEngines,
} from "./doctor-database-engine-inspection.js";

async function inspectDatabaseEngines(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv },
): Promise<DoctorDatabaseEngineInspection> {
  const env = options.env ?? process.env;
  try {
    const { inspectDoctorDatabaseEngines } = await import("./doctor-database-engine-inspection.js");
    return await inspectDoctorDatabaseEngines({ config: cfg, stateDir: resolveStateDir(env), env });
  } catch {
    return { observed: {}, stateRoots: [], stateInspectionFailed: true };
  }
}

function stateRootFindings(
  cfg: OpenClawConfig,
  inspection: DoctorDatabaseEngineInspection,
): HealthFinding[] {
  const selected = selectDatabaseEngine({ id: "state", postgres: true }, cfg);
  const findings: HealthFinding[] = inspection.stateRoots
    .filter(({ physical }) => physical.engine !== selected)
    .map(({ path, physical }) => ({
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path,
      message: `Shared state root ${path}: physical=${physical.engine}, configured=${selected} (engine mismatch).`,
      fixHint: `Restore the matching state-family engine setting, or stop the Gateway and use openclaw database port --family state --to ${selected} with a supported engine configuration.`,
    }));
  if (inspection.stateInspectionFailed) {
    findings.push({
      checkId: "core/doctor/database-engine",
      severity: "warning",
      source: "doctor",
      path: "database.families.state.engine",
      message: "Shared state roots could not be inspected.",
      fixHint:
        "Verify the selected database connection and installed plugin inventory, then rerun openclaw doctor.",
    });
  }
  return findings;
}

function collectDatabaseEngineHealthFindings(
  cfg: OpenClawConfig,
  observed: ObservedDatabaseEngines = {},
): HealthFinding[] {
  const families = describeDatabaseEngineSelection(cfg);
  const findings: HealthFinding[] = families.some((family) => family.effective === "postgres")
    ? [
        {
          checkId: "core/doctor/database-engine",
          severity: "warning",
          source: "doctor",
          path: "database.engine",
          message:
            "The PostgreSQL database engine is experimental. Stores without a registered PostgreSQL schema remain on SQLite.",
          fixHint:
            "Review the store engine selections and https://docs.openclaw.ai/reference/database-engines before using this configuration.",
        },
      ]
    : [];
  for (const family of families) {
    if (observed[family.id]?.some((engine) => engine !== family.effective)) {
      findings.push({
        checkId: "core/doctor/database-engine",
        severity: "warning",
        source: "doctor",
        path: family.fixedLocal ? "database" : `database.families.${family.id}.engine`,
        message: `${family.label}: configured ${family.effective}, observed ${observed[family.id]!.join(" and ")}. Changing configuration does not migrate existing data.`,
        fixHint: family.fixedLocal
          ? "Restore the local SQLite safety store from its verified backup."
          : `Keep the Gateway stopped and use openclaw database port --family ${family.id} to migrate this family, or restore its matching engine selection.`,
      });
    }
  }
  return findings;
}

function observedFindings(
  cfg: OpenClawConfig,
  inspection: DoctorDatabaseEngineInspection,
): HealthFinding[] {
  return [
    ...stateRootFindings(cfg, inspection),
    ...collectDatabaseEngineHealthFindings(cfg, { ...inspection.observed, state: [] }),
  ];
}

export async function collectObservedDatabaseEngineHealthFindings(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HealthFinding[]> {
  return observedFindings(cfg, await inspectDatabaseEngines(cfg, options));
}

export async function noteDatabaseEngines(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<HealthFinding[]> {
  const inspection = await inspectDatabaseEngines(cfg, options);
  const { stateRoots, observed } = inspection;
  const findings = observedFindings(cfg, inspection);
  const lines = describeDatabaseEngineSelection(cfg).map((family) => {
    const override = family.fixedLocal ? "fixed local" : (family.override ?? "inherit");
    const physical = observed[family.id]?.length
      ? `; observed=${observed[family.id]!.join(",")}`
      : "";
    return `${family.label}: default=${family.default}, override=${override}, effective=${family.effective} (configured)${physical}`;
  });
  for (const { path, physical } of stateRoots) {
    const namespace = physical.engine === "postgres" ? `, namespace=${physical.namespace}` : "";
    lines.push(`Shared state root: ${path} (physical=${physical.engine}${namespace})`);
  }
  const sqliteLibrary = ensureSqliteLibrarySelected();
  if (sqliteLibrary.source !== "runtime") {
    lines.push(
      `SQLite (doctor process): ${sqliteLibrary.path} (${sqliteLibrary.version}, extension loading enabled)`,
    );
  } else if (sqliteLibrary.ignoredOverride) {
    lines.push(`SQLite (doctor process): ${sqliteLibrary.ignoredOverride}; override ignored`);
  }
  for (const finding of findings) {
    lines.push("", finding.message, finding.fixHint ?? "");
  }
  note(lines.join("\n"), "Database engines");
  return findings;
}

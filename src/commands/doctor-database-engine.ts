import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { describeDatabaseEngineSelection } from "../infra/database-engine/report.js";
import type { DatabaseEngineFamily, DatabaseEngineId } from "../infra/database-engine/types.js";

export type ObservedDatabaseEngines = Partial<Record<DatabaseEngineFamily, DatabaseEngineId[]>>;

export function collectDatabaseEngineHealthFindings(
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

export function noteDatabaseEngines(
  cfg: OpenClawConfig,
  observed: ObservedDatabaseEngines = {},
): void {
  const lines = describeDatabaseEngineSelection(cfg).map((family) => {
    const override = family.fixedLocal ? "fixed local" : (family.override ?? "inherit");
    const physical = observed[family.id]?.length
      ? `; observed=${observed[family.id]!.join(",")}`
      : "";
    return `${family.label}: default=${family.default}, override=${override}, effective=${family.effective} (configured)${physical}`;
  });
  const sqliteLibrary = ensureSqliteLibrarySelected();
  if (sqliteLibrary.source !== "runtime") {
    lines.push(
      `SQLite (doctor process): ${sqliteLibrary.path} (${sqliteLibrary.version}, extension loading enabled)`,
    );
  } else if (sqliteLibrary.ignoredOverride) {
    lines.push(`SQLite (doctor process): ${sqliteLibrary.ignoredOverride}; override ignored`);
  }
  for (const finding of collectDatabaseEngineHealthFindings(cfg, observed)) {
    lines.push("", finding.message, finding.fixHint ?? "");
  }
  note(lines.join("\n"), "Database engines");
}

import { chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadClinicalDatabaseCatalogSnapshot } from "./database-catalog-snapshot.js";

const csv = (value: unknown): string => {
  const text = String(value ?? "");
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const exportDatabaseCatalogCsv = async (output = ".local/mimic-iv-catalog.csv"): Promise<{ output: string; rows: number }> => {
  const snapshot = await loadClinicalDatabaseCatalogSnapshot();
  const rows = snapshot.catalog.relations.flatMap((relation) => relation.columns.map((column) => [
    relation.schema,
    relation.name,
    relation.relation_type,
    column.name,
    column.data_type,
    column.nullable ? "true" : "false",
  ]));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, [
    "schema,relation,relation_type,column,data_type,nullable",
    ...rows.map((row) => row.map(csv).join(",")),
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  await chmod(output, 0o600);
  return { output, rows: rows.length };
};

const main = async (): Promise<void> => {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const result = await exportDatabaseCatalogCsv(output);
  process.stdout.write(`Saved ${result.rows} catalog variables to ${result.output}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "DATABASE_CATALOG_CSV_EXPORT_FAILED"}\n`);
    process.exitCode = 1;
  });
}

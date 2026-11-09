import { readFile } from "node:fs/promises";

export interface IndexedItem { id: number; label: string; table: string; category?: string; fluid?: string; rows: number; admissions?: number; median?: number; p01?: number; p99?: number; units?: Array<[string, number]> }
export interface IndexedDrug { label: string; rows: number; admissions: number }
export interface IndexedCode { code: string; version: 9 | 10; label: string; rows: number; admissions: number; table: string }
export interface DictionaryIndexFile { schema_version: "1.0.0"; sections: { lab: IndexedItem[]; item: IndexedItem[]; drug: IndexedDrug[]; diagnosis: IndexedCode[]; procedure: IndexedCode[] } }

export type SearchKind = "item" | "drug" | "diagnosis" | "procedure";
export interface SearchHit { kind: SearchKind; id?: number; code?: string; version?: 9 | 10; label: string; table: string; rows: number; admissions: number; median?: number; p01?: number; p99?: number; units?: Array<[string, number]>; fluid?: string }

const words = (text: string): string[] => text.normalize("NFKC").toLocaleLowerCase("en-US").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The names, counts and distributions of the archive's dictionaries (scripts/build-dictionary-index.py). Read-only, in memory. */
export class DictionaryIndex {
  private readonly items: Map<string, IndexedItem>; private readonly drugs: Map<string, IndexedDrug>; private readonly codes: Map<string, IndexedCode>;

  constructor(private readonly file: DictionaryIndexFile) {
    this.items = new Map([...file.sections.lab, ...file.sections.item].map((item) => [`${item.table}:${item.id}`, item]));
    this.drugs = new Map(file.sections.drug.map((drug) => [drug.label, drug]));
    this.codes = new Map([...file.sections.diagnosis.map((code) => [`d:${code.code}|${code.version}`, code] as const), ...file.sections.procedure.map((code) => [`p:${code.code}|${code.version}`, code] as const)]);
  }

  static async load(path: string | URL): Promise<DictionaryIndex> {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DictionaryIndexFile;
    if (parsed.schema_version !== "1.0.0" || !parsed.sections) throw new Error("The dictionary index has an unsupported format.");
    return new DictionaryIndex(parsed);
  }

  item(table: string, id: number): IndexedItem | undefined { return this.items.get(`${table}:${id}`); }
  drug(label: string): IndexedDrug | undefined { return this.drugs.get(label); }
  code(kind: "diagnosis" | "procedure", code: string, version: 9 | 10): IndexedCode | undefined { return this.codes.get(`${kind === "diagnosis" ? "d" : "p"}:${code}|${version}`); }
  /** Codes starting with `prefix` (a trailing "*" in a definition). */
  codesWithPrefix(kind: "diagnosis" | "procedure", prefix: string, version: 9 | 10): IndexedCode[] {
    return (kind === "diagnosis" ? this.file.sections.diagnosis : this.file.sections.procedure).filter((entry) => entry.version === version && entry.code.startsWith(prefix));
  }

  /** Entries whose label carries every word of the query (prefix match on the last word), most used first. */
  search(kind: SearchKind, query: string, limit = 40): SearchHit[] {
    const wanted = words(query); if (!wanted.length) return [];
    const matches = (label: string): boolean => { const have = words(label); return wanted.every((word, index) => have.some((candidate) => candidate === word || index === wanted.length - 1 && candidate.startsWith(word))); };
    let hits: SearchHit[];
    if (kind === "item") hits = [...this.items.values()].filter((item) => matches(item.label)).map((item) => ({ kind, id: item.id, label: item.label, table: item.table, rows: item.rows, admissions: item.admissions ?? 0, ...(item.fluid ? { fluid: item.fluid } : {}), ...(item.median !== undefined ? { median: item.median, p01: item.p01!, p99: item.p99! } : {}), ...(item.units ? { units: item.units } : {}) }));
    else if (kind === "drug") hits = [...this.drugs.values()].filter((drug) => matches(drug.label)).map((drug) => ({ kind, label: drug.label, table: "prescriptions", rows: drug.rows, admissions: drug.admissions }));
    else hits = [...this.codes.values()].filter((entry) => entry.table === (kind === "diagnosis" ? "diagnoses_icd" : "procedures_icd") && (matches(entry.label) || entry.code.toLowerCase().startsWith(query.trim().toLowerCase()))).map((entry) => ({ kind, code: entry.code, version: entry.version, label: entry.label, table: entry.table, rows: entry.rows, admissions: entry.admissions }));
    return hits.sort((a, b) => b.rows - a.rows).slice(0, limit);
  }
}

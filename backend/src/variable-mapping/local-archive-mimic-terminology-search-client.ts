import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { streamArchiveRows } from "../clinical-data/index.js";
import { VariableMappingError } from "./variable-mapping.js";
import { terminologyDictionariesForCategory } from "./mimic-data-domain-catalog.js";
import type { ClinicalTermExpansion, MimicTerminologyMatch, MimicTerminologySearchGateway } from "./terminology-gateway.js";

const dictionaries = [
  { dictionary: "d_labitems" as const, suffix: "/hosp/d_labitems.csv.gz", id: "itemid", label: "label" },
  { dictionary: "d_items" as const, suffix: "/icu/d_items.csv.gz", id: "itemid", label: "label" },
  { dictionary: "d_icd_diagnoses" as const, suffix: "/hosp/d_icd_diagnoses.csv.gz", id: "icd_code", label: "long_title", version: "icd_version" },
  { dictionary: "d_icd_procedures" as const, suffix: "/hosp/d_icd_procedures.csv.gz", id: "icd_code", label: "long_title", version: "icd_version" },
  { dictionary: "prescriptions_drug" as const, suffix: "/hosp/prescriptions.csv.gz", id: "drug", label: "drug" },
] as const;
const genericSearchWords = new Set(["blood", "serum", "plasma", "level", "measurement", "value", "patient", "patients"]);
const archiveMembers = async (archivePath: string): Promise<string[]> => new Promise((resolve, reject) => {
  const child = spawn("unzip", ["-Z1", archivePath], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8").split(/\r?\n/u).filter(Boolean)) : reject(new Error("archive inspection failed")));
});

/** Searches only local MIMIC dictionary members and never exposes patient rows. */
export class LocalArchiveMimicTerminologySearchClient implements MimicTerminologySearchGateway {
  private readonly cache = new Map<string, MimicTerminologyMatch[]>();
  private members?: Promise<string[]>;
  private readonly dictionaryRows = new Map<string, Promise<Array<Record<string, string>>>>();
  private archiveSignature?: Promise<string>;
  constructor(private readonly archivePath: string, private readonly options: { cacheDirectory?: string } = {}) {}

  private async signature(member: string): Promise<string> {
    const archiveSignature = await (this.archiveSignature ??= (async () => {
      const metadata = await stat(this.archivePath);
      return createHash("sha256").update(`${metadata.size}\u0000${metadata.mtimeMs}`).digest("hex");
    })());
    return createHash("sha256").update(`${archiveSignature}\u0000${member}`).digest("hex");
  }

  private async loadPersistedRows(dictionary: typeof dictionaries[number], member: string): Promise<Array<Record<string, string>> | undefined> {
    if (!this.options.cacheDirectory) return undefined;
    const signature = await this.signature(member);
    const path = join(this.options.cacheDirectory, `${dictionary.dictionary}-${signature}.json`);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (parsed.schema_version !== "1.0.0" || parsed.dictionary !== dictionary.dictionary || parsed.archive_signature !== signature || !Array.isArray(parsed.rows)) return undefined;
      const rows = parsed.rows.filter((row): row is Record<string, string> => Boolean(row && typeof row === "object" && !Array.isArray(row)
        && typeof (row as Record<string, unknown>)[dictionary.id] === "string"
        && typeof (row as Record<string, unknown>)[dictionary.label] === "string"));
      return rows.length === parsed.rows.length ? rows : undefined;
    } catch { return undefined; }
  }

  private async persistRows(dictionary: typeof dictionaries[number], member: string, rows: Array<Record<string, string>>): Promise<void> {
    if (!this.options.cacheDirectory) return;
    const signature = await this.signature(member);
    await mkdir(this.options.cacheDirectory, { recursive: true });
    const path = join(this.options.cacheDirectory, `${dictionary.dictionary}-${signature}.json`);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ schema_version: "1.0.0", dictionary: dictionary.dictionary, archive_signature: signature, rows })}\n`, { mode: 0o600 });
      await rename(temporaryPath, path);
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async rowsForDictionary(dictionary: typeof dictionaries[number], member: string): Promise<Array<Record<string, string>>> {
    const cached = this.dictionaryRows.get(dictionary.dictionary);
    if (cached) return cached;
    const rows = (async () => {
      const persisted = await this.loadPersistedRows(dictionary, member);
      if (persisted) return persisted;
      const values: Array<Record<string, string>> = [];
      const seen = new Set<string>();
      for await (const row of streamArchiveRows(this.archivePath, member)) {
        const identifier = String(row[dictionary.id] ?? "");
        const label = String(row[dictionary.label] ?? "");
        const key = `${identifier}\u0000${label}`;
        if (!identifier || !label || seen.has(key)) continue;
        seen.add(key);
        values.push({
          [dictionary.id]: identifier,
          [dictionary.label]: label,
          ...(typeof row.category === "string" && row.category ? { category: row.category } : {}),
          ...(typeof row.linksto === "string" && row.linksto ? { linksto: row.linksto } : {}),
          ...("version" in dictionary ? { [dictionary.version]: String(row[dictionary.version] ?? "") } : {}),
        });
      }
      await this.persistRows(dictionary, member, values);
      return values;
    })();
    this.dictionaryRows.set(dictionary.dictionary, rows);
    return rows;
  }

  /**
   * Word-aware containment for Latin text: every word of `phrase` must match a word of `text`, in order and adjacent,
   * either whole or as the start of the word when it has at least five letters ("metoprolol" finds "Metoprolol
   * Tartrate"; "statin" does not find "nystatin"; "age" does not find "agent"). Other scripts keep substring matching.
   */
  static containsPhrase(text: string, phrase: string): boolean {
    if (!/^[\p{Script=Latin}\p{N}\s\p{P}\p{S}]*$/u.test(phrase)) return text.includes(phrase);
    const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean); const wanted = phrase.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!wanted.length || wanted.length > words.length) return false;
    const same = (word: string, token: string): boolean => word === token || (token.length >= 5 && word.startsWith(token));
    for (let start = 0; start + wanted.length <= words.length; start += 1) if (wanted.every((token, offset) => same(words[start + offset]!, token))) return true;
    return false;
  }

  private async memberFor(dictionary: typeof dictionaries[number]): Promise<string | undefined> {
    const members = await (this.members ??= archiveMembers(this.archivePath));
    const matchingMembers = members.filter((member) => member.endsWith(dictionary.suffix));
    if (matchingMembers.length > 1) throw new Error("dictionary member is not unique");
    return matchingMembers[0];
  }

  /** The match a dictionary row stands for; the same object whichever search finds it. */
  private static toMatch(dictionary: typeof dictionaries[number], row: Record<string, string>): MimicTerminologyMatch | undefined {
    const label = String(row[dictionary.label] ?? "");
    const identifier = String(row[dictionary.id] ?? "");
    if (!label || !identifier) return undefined;
    const rawVersion = "version" in dictionary ? Number(row[dictionary.version] ?? 10) : undefined;
    return {
      dictionary: dictionary.dictionary,
      identifier,
      label,
      ...(typeof row.category === "string" && row.category ? { category: row.category } : {}),
      ...(typeof row.linksto === "string" && row.linksto ? { source_table: row.linksto } : {}),
      ...(dictionary.dictionary === "prescriptions_drug" ? { category: "Medication", source_table: "prescriptions" } : {}),
      ...(rawVersion === 9 || rawVersion === 10 ? { code_version: rawVersion } : {}),
    };
  }

  /** Every entry of one dictionary, as the searches return them (used to build an embedding index of the labels). */
  async listEntries(dictionaryName: MimicTerminologyMatch["dictionary"]): Promise<MimicTerminologyMatch[]> {
    const dictionary = dictionaries.find(({ dictionary: name }) => name === dictionaryName)!;
    const member = await this.memberFor(dictionary);
    if (!member) return [];
    const seen = new Set<string>();
    return (await this.rowsForDictionary(dictionary, member)).flatMap((row) => {
      const match = LocalArchiveMimicTerminologySearchClient.toMatch(dictionary, row);
      const key = match ? `${match.identifier}\u0000${match.label}` : "";
      if (!match || seen.has(key)) return [];
      seen.add(key);
      return [match];
    });
  }

  private async searchDictionary(dictionary: typeof dictionaries[number], normalized: string): Promise<MimicTerminologyMatch[]> {
    const member = await this.memberFor(dictionary);
    if (!member) return [];
    const distinctiveTokens = normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 4 && !genericSearchWords.has(token));
    const normalizedCodeQuery = normalized.replaceAll(".", "");
    const codePrefixQuery = (dictionary.dictionary === "d_icd_diagnoses" || dictionary.dictionary === "d_icd_procedures")
      && /^(?=.*\d)[a-z0-9]{2,12}$/u.test(normalizedCodeQuery);
    const matches: Array<{ match: MimicTerminologyMatch; score: number; normalizedLabel: string }> = [];
    const seen = new Set<string>();
    const rows = await this.rowsForDictionary(dictionary, member);
    for (const row of rows) {
      const label = String(row[dictionary.label] ?? "");
      const identifier = String(row[dictionary.id] ?? "");
      if (!label || !identifier) continue;
      const normalizedLabel = label.normalize("NFKC").toLocaleLowerCase();
      const normalizedIdentifier = identifier.normalize("NFKC").replaceAll(".", "").toLocaleLowerCase();
      const identifierPrefixMatch = codePrefixQuery && normalizedIdentifier.startsWith(normalizedCodeQuery);
      const contains = LocalArchiveMimicTerminologySearchClient.containsPhrase;
      const phraseMatch = contains(normalizedLabel, normalized);
      const reversePhraseMatch = normalizedLabel.length >= 4 && contains(normalized, normalizedLabel);
      const tokenMatches = distinctiveTokens.filter((token) => contains(normalizedLabel, token)).length;
      const tokenMatch = distinctiveTokens.length === 1 ? tokenMatches === 1 : distinctiveTokens.length > 1 && tokenMatches === distinctiveTokens.length;
      const score = identifierPrefixMatch ? 4 : phraseMatch ? 3 : reversePhraseMatch ? 2 : tokenMatch ? 1 : 0;
      if (!score) continue;
      const deduplicationKey = `${identifier}\u0000${label}`;
      if (seen.has(deduplicationKey)) continue;
      seen.add(deduplicationKey);
      const match = LocalArchiveMimicTerminologySearchClient.toMatch(dictionary, row)!;
      matches.push({ match, score, normalizedLabel });
      if (matches.length >= (codePrefixQuery ? 5_000 : 250)) break;
    }
    return matches.sort((left, right) => right.score - left.score || left.normalizedLabel.length - right.normalizedLabel.length || left.match.identifier.localeCompare(right.match.identifier)).map(({ match }) => match);
  }

  async searchCodePrefix(prefix: string): Promise<MimicTerminologyMatch[]> {
    const normalized = prefix.normalize("NFKC").trim().replaceAll(".", "").toLocaleLowerCase();
    if (!/^(?=.*\d)[a-z0-9]{2,12}$/u.test(normalized)) throw new VariableMappingError("MAPPING_INVALID", "The terminology code prefix is invalid.");
    const codeDictionaries = dictionaries.filter(({ dictionary }) => dictionary === "d_icd_diagnoses" || dictionary === "d_icd_procedures");
    const matches = (await Promise.all(codeDictionaries.map((dictionary) => this.searchDictionary(dictionary, normalized)))).flat()
      .filter(({ identifier }) => identifier.replaceAll(".", "").toLocaleLowerCase().startsWith(normalized));
    return [...new Map(matches.map((match) => [`${match.dictionary}\u0000${match.code_version ?? "code"}\u0000${match.identifier}`, match])).values()];
  }

  async searchNonMedication(term: string): Promise<MimicTerminologyMatch[]> {
    const normalized = term.normalize("NFKC").trim().toLocaleLowerCase();
    if (normalized.length < 2 || normalized.length > 120) throw new VariableMappingError("MAPPING_INVALID", "The terminology search term is invalid.");
    const cacheKey = `non-medication:${normalized}`;
    const cached = this.cache.get(cacheKey); if (cached) return structuredClone(cached);
    try {
      const searchDictionaries = dictionaries.filter(({ dictionary }) => dictionary !== "prescriptions_drug");
      const matches = [...new Map((await Promise.all(searchDictionaries.map((dictionary) => this.searchDictionary(dictionary, normalized)))).flat()
        .map((match) => [`${match.dictionary}\u0000${match.code_version ?? "item"}\u0000${match.identifier}`, match])).values()];
      this.cache.set(cacheKey, structuredClone(matches));
      return matches;
    } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The local MIMIC terminology dictionaries are unavailable."); }
  }

  async searchMedication(term: string): Promise<MimicTerminologyMatch[]> {
    const normalized = term.normalize("NFKC").trim().toLocaleLowerCase();
    if (normalized.length < 2 || normalized.length > 120) throw new VariableMappingError("MAPPING_INVALID", "The terminology search term is invalid.");
    const cacheKey = `medication:${normalized}`;
    const cached = this.cache.get(cacheKey); if (cached) return structuredClone(cached);
    try {
      const dictionary = dictionaries.find(({ dictionary }) => dictionary === "prescriptions_drug")!;
      const matches = await this.searchDictionary(dictionary, normalized);
      this.cache.set(cacheKey, structuredClone(matches));
      return matches;
    } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The local MIMIC medication dictionary is unavailable."); }
  }

  async searchByCategory(term: string, category: ClinicalTermExpansion["category"]): Promise<MimicTerminologyMatch[]> {
    const normalized = term.normalize("NFKC").trim().toLocaleLowerCase();
    if (normalized.length < 2 || normalized.length > 120) throw new VariableMappingError("MAPPING_INVALID", "The terminology search term is invalid.");
    const dictionaryNames = terminologyDictionariesForCategory(category);
    if (!dictionaryNames.length) return [];
    const cacheKey = `category:${category}:${normalized}`;
    const cached = this.cache.get(cacheKey); if (cached) return structuredClone(cached);
    try {
      const selected = dictionaries.filter(({ dictionary }) => dictionaryNames.includes(dictionary));
      const matches = [...new Map((await Promise.all(selected.map((dictionary) => this.searchDictionary(dictionary, normalized)))).flat()
        .map((match) => [`${match.dictionary}\u0000${match.code_version ?? "item"}\u0000${match.identifier}`, match])).values()];
      this.cache.set(cacheKey, structuredClone(matches));
      return matches;
    } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", `The local MIMIC ${category} terminology domain is unavailable.`); }
  }

  async search(term: string): Promise<MimicTerminologyMatch[]> {
    const normalized = term.normalize("NFKC").trim().toLocaleLowerCase();
    if (normalized.length < 2 || normalized.length > 120) throw new VariableMappingError("MAPPING_INVALID", "The terminology search term is invalid.");
    const cached = this.cache.get(normalized); if (cached) return structuredClone(cached);
    try {
      const queries = [normalized];
      let matches: MimicTerminologyMatch[] = [];
      for (const query of queries) {
        const nonMedicationDictionaries = dictionaries.filter((dictionary) => dictionary.dictionary !== "prescriptions_drug");
        const dictionaryMatches = (await Promise.all(nonMedicationDictionaries.map((dictionary) => this.searchDictionary(dictionary, query)))).flat();
        matches.push(...dictionaryMatches);
        const prescriptionDictionary = dictionaries.find((dictionary) => dictionary.dictionary === "prescriptions_drug")!;
        matches.push(...await this.searchDictionary(prescriptionDictionary, query));
      }
      matches = [...new Map(matches.map((match) => [`${match.dictionary}\u0000${match.code_version ?? "item"}\u0000${match.identifier}`, match])).values()];
      this.cache.set(normalized, structuredClone(matches));
      return matches;
    } catch { throw new VariableMappingError("MAPPING_SEARCH_UNAVAILABLE", "The local MIMIC terminology dictionaries are unavailable."); }
  }
}

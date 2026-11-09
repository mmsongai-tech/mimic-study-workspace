import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { streamArchiveRows } from "../clinical-data/index.js";
import type { VariableMappingRecord } from "./variable-mapping.js";

export type MappingDataProfile = NonNullable<VariableMappingRecord["evidence"]["data_profile"]>;
export interface MappingEvidenceProfiler { profile(mapping: VariableMappingRecord): Promise<MappingDataProfile>; profileMany?(mappings: VariableMappingRecord[]): Promise<Map<string, MappingDataProfile>>; }
export interface LocalArchiveEvidenceProfilerOptions { now?: () => string; maxOnlineScanBytes?: number; scanTimeoutMs?: number; cacheDirectory?: string; }

const inventory = async (archivePath: string): Promise<Map<string, number>> => new Promise((resolve, reject) => {
  const child = spawn("unzip", ["-l", archivePath], { stdio: ["ignore", "pipe", "ignore"] }); const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk)); child.once("error", reject);
  child.once("close", (code) => code === 0 ? resolve(new Map(Buffer.concat(chunks).toString("utf8").split(/\r?\n/u).flatMap((line) => { const match=line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+\.csv\.gz)$/u); return match ? [[match[2]!,Number(match[1])]] : []; }))) : reject(new Error("archive inspection failed")));
});
const directory = (schema: string): string => schema.replace(/^mimiciv_/u, "");
const safeAggregates = (counts: Map<string, number>, limit = 10): Array<{ value: string; count: number }> => [...counts.entries()]
  .filter(([value, count]) => count >= 10 && value.length <= 80 && !/[\r\n\u0000-\u001f]/u.test(value))
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([value, count]) => ({ value, count }));
type State = { matched: number; missing: number; numericCount: number; numericSum: number; minimum: number; maximum: number; values: Map<string, number>; units: Map<string, number> };
const state = (): State => ({ matched: 0, missing: 0, numericCount: 0, numericSum: 0, minimum: Number.POSITIVE_INFINITY, maximum: Number.NEGATIVE_INFINITY, values: new Map(), units: new Map() });
const valueColumn = (mapping: VariableMappingRecord): string | undefined => { const source=mapping.sources[0]; return source?.value_filters?.[0]?.column ?? (source?.columns.includes("valuenum") ? "valuenum" : source?.columns.find((column) => !["subject_id","hadm_id","stay_id","itemid","icd_code","icd_version","charttime","starttime","stoptime","endtime"].includes(column))); };
const codeSetCache = new WeakMap<VariableMappingRecord, Set<string>>();
const includesRow = (mapping: VariableMappingRecord, row: Record<string, unknown>): boolean => { const source=mapping.sources[0]!; if (source.item_ids?.length) return source.item_ids.includes(Number(row.itemid)); if (source.codes?.length) { let codes=codeSetCache.get(mapping); if(!codes){codes=new Set(source.codes.map(({code,version})=>`${version}:${code}`));codeSetCache.set(mapping,codes);} return codes.has(`${Number(row.icd_version)}:${String(row.icd_code)}`); } return source.value_filters?.length ? source.value_filters.every(({ column, values }) => values.some((value) => String(row[column]).toLocaleLowerCase() === value.toLocaleLowerCase())) : true; };

/** Profiles one verified mapping using aggregate-only local MIMIC evidence. */
export class LocalArchiveMappingEvidenceProfiler implements MappingEvidenceProfiler {
  private archiveInventory?: Promise<Map<string, number>>;
  private readonly cache = new Map<string, MappingDataProfile>();
  private readonly now: () => string;
  private readonly maxOnlineScanBytes: number;
  private readonly scanTimeoutMs: number;
  private readonly cacheDirectory: string | undefined;
  constructor(private readonly archivePath: string, optionsOrNow: LocalArchiveEvidenceProfilerOptions | (() => string) = {}, legacyMaxOnlineScanBytes?: number) {
    const options = typeof optionsOrNow === "function" ? { now: optionsOrNow, ...(legacyMaxOnlineScanBytes === undefined ? {} : { maxOnlineScanBytes: legacyMaxOnlineScanBytes }) } : optionsOrNow;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxOnlineScanBytes = options.maxOnlineScanBytes ?? 512_000_000;
    this.scanTimeoutMs = options.scanTimeoutMs ?? 300_000;
    this.cacheDirectory = options.cacheDirectory;
  }

  private async cacheKey(mapping: VariableMappingRecord): Promise<string> {
    const archive = await stat(this.archivePath);
    return createHash("sha256").update(JSON.stringify({ archive: { size: archive.size, mtime_ms: archive.mtimeMs }, mapping: { mapping_id: mapping.mapping_id, mapping_version: mapping.mapping_version, sources: mapping.sources } })).digest("hex");
  }

  private async readPersistent(mapping: VariableMappingRecord): Promise<MappingDataProfile | undefined> {
    if (!this.cacheDirectory) return undefined;
    try { return JSON.parse(await readFile(join(this.cacheDirectory, `${await this.cacheKey(mapping)}.json`), "utf8")) as MappingDataProfile; } catch { return undefined; }
  }

  private async writePersistent(mapping: VariableMappingRecord, profile: MappingDataProfile): Promise<void> {
    if (!this.cacheDirectory) return;
    await mkdir(this.cacheDirectory, { recursive: true }); const path=join(this.cacheDirectory, `${await this.cacheKey(mapping)}.json`); const temporary=`${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(profile)}\n`, { encoding:"utf8", mode:0o600 }); await rename(temporary,path);
  }

  async profile(mapping: VariableMappingRecord): Promise<MappingDataProfile> {
    const cached = this.cache.get(mapping.mapping_id); if (cached) return structuredClone(cached);
    return (await this.profileMany([mapping])).get(mapping.mapping_id)!;
  }

  async profileMany(mappings: VariableMappingRecord[]): Promise<Map<string, MappingDataProfile>> {
    const result = new Map<string, MappingDataProfile>(); const pending: VariableMappingRecord[]=[];
    for (const mapping of mappings) { const cached=this.cache.get(mapping.mapping_id) ?? await this.readPersistent(mapping); if(cached){this.cache.set(mapping.mapping_id,structuredClone(cached));result.set(mapping.mapping_id,structuredClone(cached));}else pending.push(mapping); }
    const groups = new Map<string, VariableMappingRecord[]>();
    for (const mapping of pending) { const source=mapping.sources[0]; if(!source) throw new Error("The mapping has no source to profile."); const key=`${source.schema}.${source.table}`; groups.set(key,[...(groups.get(key)??[]),mapping]); }
    const archiveInventory = await (this.archiveInventory ??= inventory(this.archivePath)); const archiveMembers=[...archiveInventory.keys()];
    const generated = await Promise.all([...groups.entries()].map(async ([sourceId, group]) => {
      const source=group[0]!.sources[0]!; const found=archiveMembers.filter((member)=>member.endsWith(`/${directory(source.schema)}/${source.table}.csv.gz`)); if(found.length!==1) throw new Error("The mapped source is unavailable in the local archive.");
      if ((archiveInventory.get(found[0]!) ?? Number.POSITIVE_INFINITY) > this.maxOnlineScanBytes) throw new Error(`Archive member exceeds the online evidence scan budget: ${found[0]}`);
      const states=new Map(group.map((mapping)=>[mapping.mapping_id,state()])); const started=Date.now();
      for await (const row of streamArchiveRows(this.archivePath,found[0]!)) { if(Date.now()-started>this.scanTimeoutMs) throw new Error(`Archive evidence scan timed out for ${sourceId}.`); for(const mapping of group) { if(!includesRow(mapping,row)) continue; const current=states.get(mapping.mapping_id)!; current.matched+=1; const column=valueColumn(mapping); const raw=column?row[column]:true; if(raw===undefined||raw===null||raw==="") current.missing+=1; else { const text=String(raw); current.values.set(text,(current.values.get(text)??0)+1); const number=Number(raw); if(Number.isFinite(number)){current.numericCount+=1;current.numericSum+=number;current.minimum=Math.min(current.minimum,number);current.maximum=Math.max(current.maximum,number);} } const unit=row.valueuom??row.amountuom;if(unit!==undefined&&unit!==null&&unit!=="")current.units.set(String(unit),(current.units.get(String(unit))??0)+1); } }
      return group.map((mapping) => { const current=states.get(mapping.mapping_id)!; const profile:MappingDataProfile={source_id:sourceId,matched_record_count:current.matched,missing_value_count:current.missing,distinct_value_count:current.values.size,...(current.numericCount?{numeric:{minimum:current.minimum,maximum:current.maximum,mean:current.numericSum/current.numericCount}}:{}),units:safeAggregates(current.units),top_values:safeAggregates(current.values),profiled_at:this.now()}; return [mapping.mapping_id,profile] as const; });
    }));
    for (const [mappingId, profile] of generated.flat()) { const mapping=pending.find((item)=>item.mapping_id===mappingId)!; await this.writePersistent(mapping,profile); this.cache.set(mappingId,structuredClone(profile)); result.set(mappingId,profile); }
    return result;
  }
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileVariableMappingPackRepository, SqliteVariableMappingRepository, VariableMappingDiscoveryService, VariableMappingPackService } from "../index.js";

type Role = "population" | "exposure" | "outcome" | "covariate";
interface Entry { concept_id: string; labels: { en: string; zh: string }; synonyms: string[]; category: string }
// The role a request for each kind of concept normally has.
const ROLE: Record<string, Role> = { diagnosis: "population", encounter: "population", demographic: "covariate", laboratory: "exposure", vital_sign: "exposure", medication: "exposure", intervention: "exposure", score: "covariate", outcome: "outcome" };
const DERIVED_ONLY = /^(readmission_|history_of_)/u;

/**
 * Every name a concept carries must resolve to a concept that is acceptable for it. Adding a concept can steal the name of an
 * existing one (a readmission concept once answered a plain diagnosis), so the whole pack is checked on every change.
 */
// About two minutes: run with FULL_PACK_RESOLUTION=1 after any change to the pack, the resolver or the derived layer.
test("every label and synonym of the pack resolves to its own concept", { skip: !process.env.FULL_PACK_RESOLUTION && "set FULL_PACK_RESOLUTION=1" }, async () => {
  const pack = JSON.parse(await readFile(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url), "utf8")) as { mappings: Entry[] };
  const directory = await mkdtemp(join(tmpdir(), "pack-resolution-"));
  const mappings = new SqliteVariableMappingRepository(join(directory, "mappings.sqlite"));
  await new VariableMappingPackService({ pack: new FileVariableMappingPackRepository(new URL("../../../../config/mappings/mimic-iv-core.json", import.meta.url)), mappings }).seed();
  const discovery = new VariableMappingDiscoveryService({ mappings });
  const stolen: string[] = [];
  for (const entry of pack.mappings) {
    // A readmission is asked as an outcome and a history as a baseline factor; everything else by its category.
    const role = entry.concept_id.startsWith("readmission_") ? "outcome" : entry.concept_id.startsWith("history_of_") ? "covariate" : ROLE[entry.category];
    if (!role) continue;
    const names = [entry.labels.en, entry.labels.zh, ...entry.synonyms].filter((name) => name.length >= 4 || /\p{Script=Han}{2,}/u.test(name));
    for (const name of new Set(names)) {
      const top = (await discovery.search({ term: name, role })).candidates[0]?.mapping.concept_id;
      if (top === entry.concept_id) continue;
      // A readmission or history concept answers only a request that says so, so it may take a plain name from no one.
      const owners = pack.mappings.filter((other) => other.concept_id !== entry.concept_id && [other.labels.en, other.labels.zh, ...other.synonyms].some((alias) => alias.toLowerCase() === name.toLowerCase()));
      if (top && owners.some((owner) => owner.concept_id === top)) continue; // two concepts legitimately share this exact name
      stolen.push(`${entry.concept_id}: "${name}" → ${top ?? "nothing"}`);
    }
  }
  mappings.close();
  assert.deepEqual(stolen.filter((line) => !DERIVED_ONLY.test(line)), [], "a name resolved to another concept");
  assert.deepEqual(stolen.filter((line) => DERIVED_ONLY.test(line.split(":")[0]!)), [], "a readmission or history name resolved elsewhere");
});

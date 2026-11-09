import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StudyFrame } from "../study-framing/index.js";

/**
 * When a question names an outcome that measures nothing ("efficacy"), the platform offers up to three readings instead of
 * stopping. The researcher picks one; a batch test may let the platform pick, and the run records who chose.
 */
export interface Reading { id: string; zh: string; en: string; outcome_zh: string; outcome_en: string }
export interface ReadingCatalog { schema_version: "1.0.0"; catalog_version: string; purposes: Array<{ id: string; when: string; readings: Reading[] }>; generic: Reading[] }

/** How a choice is made: `ask` leaves it to the researcher; `first` takes the best-ranked reading; `random` takes one by a hash of the question. */
export type ClarifyPolicy = "ask" | "first" | "random";
export const CLARIFY_POLICIES: readonly ClarifyPolicy[] = ["ask", "first", "random"];

export interface ClarificationOption {
  option_id: string;
  label: { en: string; zh: string };
  /** The question with this reading written in, ready to be asked again. */
  question: string;
  /** The sub-question as it reads with this option. */
  sub_question: string;
}
export interface ClarificationRecord {
  frame_id: string;
  slot: "outcome";
  /** The words of the question that named nothing measurable. */
  text: string;
  sub_question: string;
  options: ClarificationOption[];
  chosen?: { option_id: string; by: "user" | "automatic_first" | "automatic_random" };
  catalog_version: string;
}

export class FileReadingCatalogRepository {
  constructor(private readonly file: URL) {}
  async load(): Promise<ReadingCatalog> {
    const catalog = JSON.parse(await readFile(this.file, "utf8")) as ReadingCatalog;
    for (const reading of [...catalog.generic, ...catalog.purposes.flatMap(({ readings }) => readings)]) {
      if (!reading.id || !reading.zh || !reading.en || !reading.outcome_zh || !reading.outcome_en) throw new Error(`A reading in the clarification catalog is incomplete: ${JSON.stringify(reading)}`);
    }
    return catalog;
  }
}

const HAN = /\p{Script=Han}/u;
const MAX_OPTIONS = 3;

const contextOf = (frame: StudyFrame): string => [frame.sub_question, frame.exposure?.text, frame.exposure?.normalized?.label_en, frame.population?.text, frame.population?.normalized?.label_en]
  .filter(Boolean).join(" ").toLowerCase();

/** Readings for a frame whose outcome is vague: those that fit the treatment or condition first, then the general ones; at most three. */
export const readingsFor = (frame: StudyFrame, catalog: ReadingCatalog): Reading[] => {
  const context = contextOf(frame);
  const specific = catalog.purposes.filter(({ when }) => new RegExp(when, "iu").test(context)).flatMap(({ readings }) => readings);
  const seen = new Set<string>();
  return [...specific, ...catalog.generic].filter(({ id }) => !seen.has(id) && seen.add(id)).slice(0, MAX_OPTIONS);
};

const replaceOnce = (text: string, from: string, to: string): string => { const at = text.indexOf(from); return at < 0 ? text : `${text.slice(0, at)}${to}${text.slice(at + from.length)}`; };

/** The offers for every frame that stopped for a vague outcome; a frame whose wording cannot be located in the question gets none. */
export const clarificationOffers = (question: string, frames: StudyFrame[], catalog: ReadingCatalog): ClarificationRecord[] => {
  const records: ClarificationRecord[] = [];
  for (const frame of frames) {
    const vague = frame.ambiguities.some(({ code }) => code === "VAGUE_OUTCOME");
    const text = frame.outcome?.text;
    if (frame.status !== "needs_clarification" || !vague || !text) continue;
    const inSubQuestion = frame.sub_question.includes(text);
    if (!inSubQuestion || !question.includes(frame.sub_question)) continue;
    const han = HAN.test(frame.sub_question);
    const options = readingsFor(frame, catalog).map((reading): ClarificationOption => {
      const sub = replaceOnce(frame.sub_question, text, han ? reading.outcome_zh : reading.outcome_en);
      return { option_id: reading.id, label: { en: reading.en, zh: reading.zh }, sub_question: sub, question: replaceOnce(question, frame.sub_question, sub) };
    });
    if (options.length) records.push({ frame_id: frame.frame_id, slot: "outcome", text, sub_question: frame.sub_question, options, catalog_version: catalog.catalog_version });
  }
  return records;
};

/** The index a policy picks; `random` is a hash of the question and aim, so a batch varies across questions but a rerun repeats. */
export const pickIndex = (policy: Exclude<ClarifyPolicy, "ask">, question: string, frameId: string, count: number): number =>
  policy === "first" ? 0 : createHash("sha256").update(`${question}\n${frameId}`).digest().readUInt32BE(0) % count;

/** The question after every offer is resolved by `chosen` (option id by frame id); frames without a choice keep their words. */
export const resolvedQuestion = (question: string, records: ClarificationRecord[], chosen: Record<string, string>): string =>
  records.reduce((text, record) => {
    const option = record.options.find(({ option_id }) => option_id === chosen[record.frame_id]);
    return option ? replaceOnce(text, record.sub_question, option.sub_question) : text;
  }, question);

export const decide = (question: string, records: ClarificationRecord[], policy: ClarifyPolicy): { records: ClarificationRecord[]; question: string } => {
  if (policy === "ask") return { records, question };
  const chosen: Record<string, string> = {};
  const decided = records.map((record) => {
    const option = record.options[pickIndex(policy, question, record.frame_id, record.options.length)]!;
    chosen[record.frame_id] = option.option_id;
    return { ...record, chosen: { option_id: option.option_id, by: policy === "first" ? "automatic_first" as const : "automatic_random" as const } };
  });
  return { records: decided, question: resolvedQuestion(question, records, chosen) };
};

/** The statement added to the aim that was read this way. */
export const readingAssumption = (record: ClarificationRecord): string | undefined => {
  const option = record.options.find(({ option_id }) => option_id === record.chosen?.option_id);
  if (!option || !record.chosen) return undefined;
  const who = record.chosen.by === "user" ? "chosen by the researcher" : "chosen automatically for a test run (a researcher would be asked)";
  return `“${record.text}” names no measurement. It is read as “${option.label.en}” (${who}). Other readings offered: ${record.options.filter((other) => other !== option).map(({ label }) => label.en).join("; ") || "none"}. （“${record.text}”本身没有给出测量方式，这里按“${option.label.zh}”理解。）`;
};

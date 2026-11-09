import { createHash } from "node:crypto";
import { contentWords } from "../variable-mapping/index.js";
import type { ProposedDefinition } from "../variable-definitions/index.js";
import type { ClarifyPolicy } from "./clarification-options.js";

/**
 * A mapping that carries only part of what the question says ("heparin" for "prophylactic heparin", "stroke" for "acute ischemic
 * stroke") stops the plan. The researcher is offered up to three ways on: a narrower definition drafted from the dictionary, the
 * broader concept with the dropped words stated, or stopping. A batch test may choose, and the run records the choice.
 */
export interface MappingOption {
  option_id: "define" | "broader" | "stop";
  label: { en: string; zh: string };
  /** `define`: the definition drafted from the dictionary, and what it covers in the archive. */
  proposal?: ProposedDefinition;
}
export interface MappingClarificationRecord {
  plan_id: string; frame_id: string; role: string; term: string;
  /** The concept the term resolved to, and the words of the term it does not carry. */
  candidate?: string; uncovered: string[];
  options: MappingOption[];
  chosen?: { option_id: MappingOption["option_id"]; by: "user" | "automatic_first" | "automatic_random" };
}

export interface MappingVariableSummary { role: string; requested_term: string; status: string; candidates: Array<{ label: string }>; reason?: string }

export const acceptKey = (role: string, term: string): string => `${role}|${term.toLowerCase()}`;

/**
 * The variables that stopped a plan because no concept carries every word of the request: the concept found carries only part of it,
 * or nothing was found at all (then every content word is uncovered and only a definition drafted from the dictionary can help).
 */
export const fidelityStops = (mapping: MappingVariableSummary[], includeResolved = false): Array<{ role: string; term: string; candidate?: string; uncovered: string[] }> =>
  mapping.filter((variable) => (variable.status === "needs_confirmation" || includeResolved && variable.status === "resolved") && /does not carry:/u.test(variable.reason ?? "") || variable.status === "unmapped" && variable.role !== "index_time").map((variable) => {
    if (variable.status === "unmapped") return { role: variable.role, term: variable.requested_term, uncovered: contentWords(variable.requested_term) };
    const listed = /does not carry: (.+?)\. The matched/u.exec(variable.reason ?? "")?.[1] ?? "";
    const candidate = variable.candidates[0]?.label;
    return { role: variable.role, term: variable.requested_term, ...(candidate ? { candidate } : {}), uncovered: [...new Set(listed.split(",").map((word) => word.trim()).filter(Boolean))] };
  });

/** The broader concept is offered only when it is a generalisation of the term (every word of its name is in the term), not a different thing. */
const isGeneralisation = (candidate: string | undefined, term: string): boolean => {
  if (!candidate) return false;
  const have = new Set(contentWords(term)); const words = contentWords(candidate.replace(/\s*\([^)]*\)/gu, " "));
  return words.length > 0 && words.every((word) => have.has(word));
};

export const mappingOptions = async (stop: { role: string; term: string; candidate?: string; uncovered: string[] }, propose: (term: string, role: string) => Promise<ProposedDefinition | undefined>): Promise<MappingOption[]> => {
  const options: MappingOption[] = [];
  const proposal = await propose(stop.term, stop.role);
  if (proposal) options.push({ option_id: "define", proposal, label: {
    en: `Define “${stop.term}” as ${proposal.facts.codes} dictionary entr${proposal.facts.codes === 1 ? "y" : "ies"} that carry it (${proposal.facts.admissions.toLocaleString("en-US")} admissions); drafted from the dictionary, not reviewed`,
    zh: `把“${stop.term}”定义为字典中包含它的 ${proposal.facts.codes} 个条目（${proposal.facts.admissions.toLocaleString("zh-CN")} 次住院）；由字典检索草拟，未经审核` } });
  if (isGeneralisation(stop.candidate, stop.term)) options.push({ option_id: "broader", label: {
    en: `Use the broader “${stop.candidate}” and state that “${stop.uncovered.join(" ")}” is not applied`,
    zh: `使用更宽的“${stop.candidate}”，并写明“${stop.uncovered.join(" ")}”没有被应用` } });
  options.push({ option_id: "stop", label: { en: "Stop here and rephrase the question", zh: "到此为止，换一种问法" } });
  return options;
};

/** The option a policy takes (never “stop”); undefined when the policy is `ask` or nothing but “stop” is on offer. */
export const chooseMappingOption = (policy: ClarifyPolicy, question: string, record: Pick<MappingClarificationRecord, "plan_id" | "term" | "options">): MappingOption["option_id"] | undefined => {
  if (policy === "ask") return undefined;
  const usable = record.options.filter(({ option_id }) => option_id !== "stop");
  if (!usable.length) return undefined;
  if (policy === "first") return usable[0]!.option_id;
  // A definition drafted from the dictionary always comes before the broader concept, which changes the question when the dropped word matters (“before CRRT”, “albumin-corrected”).
  if (usable[0]!.option_id === "define") return "define";
  return usable[createHash("sha256").update(`${question}\n${record.plan_id}\n${record.term}`).digest().readUInt32BE(0) % usable.length]!.option_id;
};

export const broaderAssumption = (record: Pick<MappingClarificationRecord, "term" | "candidate" | "uncovered">): string =>
  `“${record.term}” is analysed as the broader “${record.candidate}”; the part “${record.uncovered.join(" ")}” is not applied, so the result describes the broader group. （“${record.term}”按更宽的“${record.candidate}”分析，“${record.uncovered.join(" ")}”这一限定没有被应用，结果描述的是更宽的人群或暴露。）`;
export const defineAssumption = (record: Pick<MappingClarificationRecord, "term">, proposal: ProposedDefinition): string =>
  `“${record.term}” is defined as ${proposal.facts.codes} dictionary entries that carry it (${proposal.facts.admissions.toLocaleString("en-US")} admissions), drafted by the platform and not reviewed by a clinician. （“${record.term}”由平台从字典检索草拟为 ${proposal.facts.codes} 个条目，未经临床医生审核。）`;

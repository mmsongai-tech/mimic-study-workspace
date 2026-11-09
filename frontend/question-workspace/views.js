"use strict";

// HTML builders for the question workspace. Summary first; details one click away (progressive disclosure).
const state = { lang: localStorageGet("mimic-lang") || "zh", selected: null, record: null, result: null, draft: null, poll: null, asking: false, open: new Set() };
function localStorageGet(key) { try { return window.localStorage.getItem(key); } catch { return null; } }
function localStorageSet(key, value) { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } }
const L = () => I18N[state.lang];
const t = (key) => L()[key] ?? key;
const zh = () => state.lang === "zh";
const pick = (pair) => (pair ? pair[zh() ? 0 : 1] : "");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? "–" : Math.abs(value) >= 1000 ? Number(value).toFixed(0) : Number(value).toPrecision(3));
const pval = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? "–" : value < 0.001 ? "<0.001" : Number(value).toFixed(3));
const fmt = (n) => Number(n).toLocaleString("en-US");
const since = (iso) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`; };
const stageName = (stage) => L().stageNames[stage] || stage;
const toggle = (key, label, body) => `<button type="button" class="linkish" data-toggle="${esc(key)}">${state.open.has(key) ? t("hideDetails") : label}</button>${state.open.has(key) ? `<div class="reveal">${body}</div>` : ""}`;

// ---- Step rail: where this run is in question → plan → running → results.
function stepIndex(record) {
  if (record.status === "completed") return 3;
  if (record.status === "running" || (record.status === "queued" && record.lock_id) || record.reanalysis_of) return 2;
  return 1;
}
function stepRail(record) {
  const current = stepIndex(record); const failed = record.status === "failed" || record.live?.stalled;
  return `<ol class="rail">${L().steps.map((label, index) => `<li class="${index < current || (index === 3 && record.status === "completed") ? "done" : index === current ? (failed ? "fail" : "active") : ""}"><span class="dot">${index < current || (index === 3 && record.status === "completed") ? "✓" : index + 1}</span>${esc(label)}</li>`).join("")}</ol>`;
}
function statusBadge(run) { return run.live?.stalled ? `<span class="badge failed">${esc(t("stalled"))}</span>` : `<span class="badge ${esc(run.status)}">${esc(t(run.status))}</span>`; }

// ---- Plain-language description of one plan.
function levelLabel(frame, level) { return zh() ? level : frame?.exposure?.categories_normalized?.find((c) => c.text === level)?.label_en || level; }
function slotText(slot) { return slot ? (zh() ? slot.text : slot.normalized?.label_en || slot.text) : ""; }
function planSentence(plan, frame) {
  const spec = plan.study_spec || {}; const S = L().sentence;
  const levels = frame?.exposure?.categories || [];
  // Only treatments are compared with each other or with non-users; measurements and factors are related to the outcome.
  const treatment = frame?.facets?.goal === "evaluate_treatment";
  const active = treatment && plan.exposure_level && !frame?.comparator?.text && frame?.comparator?.kind !== "absence";
  const population = slotText(frame?.population) || (active ? t("listedAny") : t("allAdults"));
  const exposure = plan.exposure_level ? levelLabel(frame, plan.exposure_level) : slotText(frame?.exposure) || spec.exposure_or_predictors?.[0]?.name || "";
  const comparator = frame?.comparator?.text ? (zh() ? frame.comparator.text : L().without(exposure))
    : active ? L().others(exposure, levels.filter((l) => l !== plan.exposure_level).map((l) => levelLabel(frame, l)).join(zh() ? "、" : ", "))
    : L().without(exposure);
  let outcome = slotText(frame?.outcome) || spec.outcome?.name || "";
  if (frame?.facets?.outcome_kind === "change_over_time") outcome = L().changeOf(outcome);
  const list = (slots) => slots.map(slotText).join(zh() ? "、" : ", ");
  // A whole aim over several listed classes (no single level chosen) reads as the classes compared with each other.
  const listed = treatment && !plan.exposure_level && levels.length >= 2 && !frame?.comparator?.text && frame?.comparator?.kind !== "absence";
  const levelList = levels.map((l) => levelLabel(frame, l)).join(zh() ? "、" : ", ");
  if (!treatment && !plan.exposure_level && levels.length >= 2 && frame?.study_type !== "prediction") return S.relate(population, levelList, outcome);
  if (listed && frame?.study_type === "mediation") return S.mediate(t("listedAny"), levelList, outcome, list(frame.mediators));
  if (listed) return S.compareLevels(t("listedAny"), levelList, outcome);
  switch (frame?.study_type) {
    case "effect_modification": return S.modify(population, exposure, comparator, outcome, list(frame.modifiers));
    case "mediation": return S.mediate(population, exposure, outcome, list(frame.mediators));
    case "descriptive": return S.describe(population, outcome);
    case "prediction": return S.predict(population, list(frame.predictors), outcome);
    case "dose_response": return S.dose(population, exposure, outcome);
    case "association": return S.relate(population, exposure, outcome);
    case "group_comparison": return S.groups(population, exposure, outcome);
    default: return treatment ? S.compare(population, exposure, comparator, outcome) : S.relate(population, exposure, outcome);
  }
}

// ---- Shared detail blocks.
function protocolTable(protocol) {
  if (!protocol) return "";
  return `<h5>${t("trial")}</h5><div class="table-wrap"><table>${protocol.elements.map((e) => `<tr><th>${esc(e.label[state.lang])}</th><td>${esc(zh() && e.emulation_zh ? e.emulation_zh : e.emulation)}</td></tr>`).join("")}</table></div>`;
}
function mappingTable(mapping) {
  if (!mapping?.length) return "";
  return `<h5>${t("variables")}</h5><div class="table-wrap"><table><tr><th>${t("role")}</th><th>${t("variable")}</th><th>${t("source")}</th></tr>
    ${mapping.map((v) => `<tr><td>${esc(v.role)}</td><td>${esc(v.requested_term)}${v.status === "resolved" ? "" : ` <span class="badge blocked">${esc(v.status)}</span>`}</td>
    <td>${esc(v.selected ? `${v.selected.label} (${v.selected.table})` : v.candidates.map((c) => `${c.label}?`).join("; ") || "–")}
    ${v.selected?.values?.length ? `<details><summary class="muted">${esc(t("codesUsed"))} (${v.selected.values.length})</summary><div class="muted small">${esc(v.selected.values.join(", "))}</div></details>` : ""}</td></tr>`).join("")}</table></div>`;
}
function assumptionsList(spec) {
  return spec?.assumptions?.length ? `<h5>${t("assumptions")}</h5><ul class="notes">${spec.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : "";
}
function warningsOf(protocol) { return (protocol?.design_checks || []).filter((c) => c.status === "warn"); }

// ---- Step 2: plan review, grouped by aim; one method choice per aim.
function aimsOf(plans, frames, planOf) {
  const aims = [];
  for (const item of plans) {
    const plan = planOf(item); const frame = frames.find((f) => f.frame_id === plan.frame_id);
    let aim = aims.find((a) => a.frame_id === plan.frame_id);
    if (!aim) { aim = { frame_id: plan.frame_id, frame, items: [] }; aims.push(aim); }
    aim.items.push(item);
  }
  return aims;
}
function reviewAim(aim, index) {
  const ready = aim.items.filter((item) => item.status === "ready"); const blocked = aim.items.filter((item) => item.status !== "ready");
  const first = aim.items[0]; const frame = aim.frame; const warnings = warningsOf(first.protocol);
  const multi = aim.items.length > 1;
  const options = first.method_options || [];
  const sentence = planSentence(multi ? { ...first.plan, exposure_level: undefined } : first.plan, frame);
  return `<section class="card aim">
    <div class="aim-head"><span class="aim-tag">${esc(t("aim"))} ${index + 1}</span><span class="muted">${esc(pick(STUDY_TYPE[frame?.study_type]))}</span></div>
    <p class="sentence">${esc(sentence)}</p>
    ${multi ? `<div class="choice"><div class="choice-label">${t("levels")}</div><div class="chips">${aim.items.map((item) => item.status === "ready"
      ? `<label class="chip-check"><input type="checkbox" data-include="${esc(item.plan.plan_id)}" checked> ${esc(levelLabel(frame, item.plan.exposure_level))}</label>`
      : `<span class="chip-check off" title="${esc(t("notRunnable"))}">${esc(levelLabel(frame, item.plan.exposure_level))}</span>`).join("")}</div></div>`
      : ready.length ? `<input type="checkbox" data-include="${esc(first.plan.plan_id)}" checked hidden>` : ""}
    ${ready.length && options.length ? `<div class="choice"><div class="choice-label">${t("method")}</div><div class="seg">${options.map((option, i) => `<label class="${option.method_id === first.default_method ? "on" : ""}">
      <input type="radio" name="aim-${esc(aim.frame_id)}" value="${esc(option.method_id)}" data-aim-method="${esc(aim.frame_id)}" ${option.method_id === first.default_method ? "checked" : ""}>${esc(option.label[state.lang])}${i === 0 ? ` <em>${esc(t("recommended"))}</em>` : ""}</label>`).join("")}</div>
      <div class="muted small" data-method-why="${esc(aim.frame_id)}">${esc(options.find((o) => o.method_id === first.default_method)?.when_preferred[state.lang] || "")}</div></div>` : ""}
    ${ready.length ? designOptionsBlock(aim.frame_id, ready[0].design_options) : ""}
    ${blocked.length ? `<div class="notice bad"><b>${esc(t("notRunnable"))}</b>${multi ? `: ${blocked.map((item) => esc(levelLabel(frame, item.plan.exposure_level))).join(", ")}` : ""}<ul>${[...new Set(blocked.flatMap((item) => (item.blocked_outcome?.blockers || []).map((b) => b.message[state.lang])))].map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
    ${warnings.length ? `<details class="notice warn"><summary>⚠ ${esc(L().thingsToKnow(warnings.length))}</summary><ul>${warnings.map((w) => `<li>${esc(w.message[state.lang])}</li>`).join("")}</ul></details>` : ""}
    ${toggle(`review:${aim.frame_id}`, t("details"), `${protocolTable(first.protocol)}${mappingTable(first.mapping)}${assumptionsList(first.plan.study_spec)}`)}
  </section>`;
}
// Design choices of an aim (they apply to every analysis of the aim): follow-up start and severity adjustment.
function designOptionsBlock(aimId, options) {
  if (!options) return "";
  const landmark = options.landmark; const severity = options.severity;
  const name = (value) => L().severityNames[value] || value;
  return `<div class="choice"><div class="choice-label">${t("designOptions")}</div>
    ${landmark ? `<div class="option-row"><span class="option-name">${t("followUpStart")}</span><div class="seg">
      <label class="${landmark.default ? "on" : ""}"><input type="radio" name="landmark-${esc(aimId)}" value="on" data-aim-landmark="${esc(aimId)}" ${landmark.default ? "checked" : ""}>${esc(L().landmarkOn(landmark.hours))}</label>
      <label class="${landmark.default ? "" : "on"}"><input type="radio" name="landmark-${esc(aimId)}" value="off" data-aim-landmark="${esc(aimId)}" ${landmark.default ? "" : "checked"}>${esc(t("landmarkOff"))}</label></div>
      <div class="muted small">${esc(L().landmarkWhy(landmark.hours))}</div></div>` : ""}
    ${severity?.names.length ? `<div class="option-row"><span class="option-name">${t("severity")}</span><div class="chips">${severity.names.map((value) => `<label class="chip-check ${severity.default_on.includes(value) ? "" : "off"}"><input type="checkbox" data-aim-severity="${esc(aimId)}" value="${esc(value)}" ${severity.default_on.includes(value) ? "checked" : ""}> ${esc(name(value))}</label>`).join("")}</div>
      <div class="muted small">${esc(t("severityWhy"))}</div></div>` : ""}</div>`;
}

function reviewView(draft) {
  const aims = aimsOf(draft.plans, draft.frame_set.frames, (item) => item.plan);
  const runnable = draft.plans.filter((item) => item.status === "ready").length;
  const unanswered = draft.unanswered_frames?.length ? `<section class="card"><h3>${t("clarify")}</h3><p class="muted">${t("clarifyHint")}</p>${draft.unanswered_frames.map(({ frame, reasons }) => `<p><b>${esc(frame.sub_question)}</b></p><ul class="notes">${reasons.map((r) => `<li>${esc(r[state.lang])}</li>`).join("")}</ul>`).join("")}</section>` : "";
  return `<section class="card intro"><h3>${t("reviewTitle")}</h3><p class="muted">${t("reviewHint")}</p></section>
    ${aims.map(reviewAim).join("")}${unanswered}
    <div class="confirm-bar"><span id="run-count">${esc(L().willRun(runnable))}</span><span id="confirm-error" class="error" hidden></span><button id="confirm-plan" class="primary" type="button" ${runnable ? "" : "disabled"}>${t("confirmRun")}</button></div>`;
}

// ---- Step 3: running.
function runningView(record) {
  const live = record.live;
  if (record.status === "drafting" || (record.status === "queued" && !record.lock_id && !record.reanalysis_of)) {
    return `<section class="card"><div class="bar indeterminate"><span></span></div><p>${t("preparing")}</p>${liveLine(live)}${logBlock(live)}</section>`;
  }
  const events = live?.events || [];
  const last = [...events].reverse().find((e) => e.stage === "plan" && /\d+\/\d+/.test(e.detail || ""));
  const [done, total] = last ? last.detail.match(/(\d+)\/(\d+)/).slice(1).map(Number) : [0, 0];
  const readingAll = !last && events.some((e) => e.stage === "cohort" && /^all/.test(e.detail || ""));
  const percent = total ? Math.round((done / total) * 100) : 0;
  return `<section class="card"><h3>${t("runningTitle")}</h3><p class="muted">${t("runningHint")}</p>
    <div class="bar ${total ? "" : "indeterminate"}"><span style="${total ? `width:${percent}%` : ""}"></span></div>
    <p><b>${esc(total ? L().plansDone(done, total) : readingAll ? t("readingAll") : stageName(live?.current?.stage || ""))}</b></p>
    ${liveLine(live)}${logBlock(live)}</section>`;
}
function liveLine(live) {
  if (!live) return "";
  return `<div class="live-line"><span class="pulse ${live.stalled ? "bad" : ""}"></span>${esc(stageName(live.current?.stage || ""))}${live.current?.detail ? ` · ${esc(live.current.detail.replace(/^all · /u, ""))}` : ""}<span class="muted"> · ${t("lastSignal")} ${esc(since(live.heartbeat_at))}</span></div>
    ${live.stalled ? `<p class="error">${esc(t("stalledHint"))}</p>` : ""}`;
}
function logBlock(live) {
  if (!live?.events?.length) return "";
  return `<details class="log"><summary>${t("log")}</summary><ul class="progress">${[...live.events].reverse().slice(0, 30).map((e) => `<li>${esc(e.at.slice(11, 19))} · ${esc(stageName(e.stage))}${e.detail ? ` · ${esc(e.detail)}` : ""}</li>`).join("")}</ul></details>`;
}

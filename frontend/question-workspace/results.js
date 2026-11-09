"use strict";

// Step 4: results. Each analysis leads with one answer and a trust badge; the rest sits behind tabs.
function mainEstimate(run) {
  return run.estimates.find((row) => MEASURE[row.measure] && !["proportion", "mean"].includes(row.measure)) || run.estimates[0];
}
function trustBadge(quality) {
  if (!quality) return "";
  const warned = quality.checks.filter((c) => c.status === "warn").length;
  const text = quality.status === "fail" ? `✗ ${t("trustFail")}` : quality.status === "warn" ? `⚠ ${L().trustWarn(warned)}` : `✓ ${t("trustPass")}`;
  return `<span class="badge check-${esc(quality.status)}">${esc(text)}</span>`;
}
function estimateText(row) {
  if (!row) return "–";
  const label = pick(MEASURE[row.measure]) || row.measure;
  return `${label} ${num(row.estimate)}${row.ci_low !== null && row.ci_high !== null ? ` (${num(row.ci_low)}–${num(row.ci_high)})` : ""}`;
}
function direction(row) {
  if (!row || row.ci_low === null || row.ci_high === null) return "";
  const null_ = RATIO.has(row.measure) ? 1 : 0;
  return row.ci_low > null_ ? t("higher") : row.ci_high < null_ ? t("lower") : t("noDiff");
}
function figureUrl(run, figure) {
  const marker = "/analyses/"; const at = run.output_dir.indexOf(marker);
  const relative = at >= 0 ? `analyses/${run.output_dir.slice(at + marker.length)}/${figure.file}` : figure.file;
  return `/api/runs/${encodeURIComponent(state.selected)}/files/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

function checksPanel(quality) {
  if (!quality) return `<p class="muted">–</p>`;
  const label = { pass: t("checkPass"), warn: t("checkWarn"), fail: t("checkFail") };
  const order = { fail: 0, warn: 1, pass: 2 };
  return `<div class="table-wrap"><table class="checks">${[...quality.checks].sort((a, b) => order[a.status] - order[b.status]).map((c) => `<tr class="c-${esc(c.status)}"><td><span class="badge check-${esc(c.status)}">${esc(label[c.status])}</span></td>
    <td><b>${esc(c.title[state.lang])}</b><div class="muted small">${esc(c.message[state.lang])}</div></td><td class="small">${esc(c.observed)}<div class="muted">${esc(c.expected)}</div></td></tr>`).join("")}</table></div><p class="muted small">rules ${esc(quality.rules_version)}</p>`;
}
function flowPanel(plan) {
  const cohort = plan.cohort;
  if (!cohort) return `<p class="muted">–</p>`;
  let remaining = cohort.analysis_units;
  const steps = ["not_in_population", "not_first_eligible_unit_of_patient", "incomplete_required_variables", "incomplete_model_variables"].filter((k) => cohort.exclusion_reasons?.[k])
    .map((k) => { remaining -= cohort.exclusion_reasons[k]; return `<div class="flow-out">− ${esc(t("excluded"))}: ${esc(L().reasons[k])} <b>${fmt(cohort.exclusion_reasons[k])}</b></div><div class="flow-box">${esc(t("remaining"))} ${fmt(Math.max(remaining, 0))}</div>`; }).join("");
  const model = plan.result?.status === "completed" && plan.result.n_analysed !== cohort.rows ? `<div class="flow-box strong">${esc(t("flowModel"))}: ${fmt(plan.result.n_analysed)}</div>` : "";
  return `<div class="flow"><div class="flow-box">${esc(t("flowAssessed"))}: ${fmt(cohort.analysis_units)}</div>${steps}<div class="flow-box strong">${esc(t("flowCohort"))}: ${fmt(cohort.rows)}</div>${model}</div>`;
}
function table1Panel(run) {
  const rows = run.tables.table1 || [];
  if (!rows.length) return `<p class="muted">–</p>`;
  const keys = Object.keys(rows[0]);
  return `<div class="table-wrap"><table><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${keys.map((k) => `<td>${esc(row[k] ?? "–")}</td>`).join("")}</tr>`).join("")}</table></div>`;
}
function figuresPanel(run) {
  return run.figures.length ? `<div class="figures">${run.figures.map((f) => `<figure><img loading="lazy" src="${figureUrl(run, f)}" alt="${esc(f.title)}"><figcaption>${esc(f.title)}</figcaption></figure>`).join("")}</div>` : `<p class="muted">–</p>`;
}
function designPanel(plan) {
  const run = plan.result;
  const options = plan.method_options || [];
  return `${protocolTable(plan.protocol)}
    ${run ? `<h5>${t("estimates")}</h5><div class="table-wrap"><table><tr><th></th><th>${t("measure")}</th><th>${t("value")}</th><th>${t("ci")}</th><th>${t("p")}</th></tr>${run.estimates.map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(pick(MEASURE[r.measure]) || r.measure)}</td><td>${num(r.estimate)}</td><td>${r.ci_low !== null ? `${num(r.ci_low)}–${num(r.ci_high)}` : "–"}</td><td>${pval(r.p_value)}</td></tr>`).join("")}</table></div>` : ""}
    ${run?.warnings?.length ? `<h5>${t("cautions")}</h5><ul class="notes">${run.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    ${mappingTable(plan.mapping)}${assumptionsList(plan.study_spec)}
    ${options.length ? `<h5>${t("changeMethod")}</h5><div class="seg">${options.map((o) => `<label class="${o.method_id === plan.chosen_method ? "on" : ""} ${o.readiness?.available === false ? "off" : ""}"><input type="radio" name="re-${esc(plan.plan_id)}" value="${esc(o.method_id)}" data-plan="${esc(plan.plan_id)}" ${o.method_id === plan.chosen_method ? "checked" : ""} ${o.readiness?.available === false ? "disabled" : ""}>${esc(o.label[state.lang])}</label>`).join("")}</div>` : ""}`;
}
function tabsFor(plan) {
  const run = plan.result; const key = `tab:${plan.plan_id}`;
  const current = [...state.open].find((k) => k.startsWith(`${key}:`))?.split(":").pop();
  const names = ["checks", "patients", "table1", "figures", "design"];
  const panel = { checks: () => checksPanel(plan.quality), patients: () => flowPanel(plan), table1: () => table1Panel(run), figures: () => figuresPanel(run), design: () => designPanel(plan) };
  return `<div class="tabs">${names.map((name) => `<button type="button" class="tab ${current === name ? "on" : ""}" data-tab="${esc(plan.plan_id)}" data-name="${name}">${esc(L().tabs[name])}</button>`).join("")}</div>
    ${current ? `<div class="panel">${panel[current]()}</div>` : ""}`;
}

function answerCard(plan, frame) {
  const run = plan.result;
  if (plan.status !== "completed" || !run) {
    return `<div class="answer blocked-answer"><div class="answer-head"><span>${esc(plan.exposure_level ? levelLabel(frame, plan.exposure_level) : planSentence(plan, frame))}</span><span class="badge ${esc(plan.status)}">${esc(t(plan.status))}</span></div>
      <ul class="notes">${plan.blockers.map((b) => `<li>${esc(b.message[state.lang])}</li>`).join("")}</ul></div>`;
  }
  const main = mainEstimate(run);
  const interaction = run.diagnostics?.p_interaction; const mediated = run.estimates.find((r) => r.measure === "proportion_mediated");
  // A group comparison answers with the outcome in each group; its test gives the P value.
  const groups = run.estimates.filter((r) => String(r.term).startsWith("group:"));
  const groupLine = (r) => `${esc(r.label)}: ${r.measure === "proportion" ? `${(r.estimate * 100).toFixed(1)}% (${(r.ci_low * 100).toFixed(1)}–${(r.ci_high * 100).toFixed(1)})` : `${num(r.estimate)} (${num(r.ci_low)}–${num(r.ci_high)})`}`;
  const headline = main?.measure === "test_statistic" ? `P ${pval(main.p_value)}` : estimateText(main);
  return `<div class="answer">
    <div class="answer-head"><span class="big">${esc(headline)}</span>${trustBadge(plan.quality)}</div>
    ${groups.length ? `<div class="group-lines">${groups.map((r) => `<div>${groupLine(r)}</div>`).join("")}</div>` : ""}
    <div class="answer-line">${direction(main) ? `<b>${esc(direction(main))}</b> · ` : ""}${esc(main?.label || "")}${interaction !== undefined ? ` · ${t("interactionP")} ${pval(Number(interaction))}` : ""}${mediated ? ` · ${t("mediated")} ${num(mediated.estimate)}` : ""} · <span class="muted">${esc(L().analysed(fmt(run.n_analysed)))}</span></div>
    ${plan.method_note ? `<p class="notice warn small">${esc(plan.method_note[state.lang])}</p>` : ""}
    ${(plan.design_notes || []).map((note) => `<p class="muted small">${esc(note[state.lang])}</p>`).join("")}
    ${tabsFor(plan)}
  </div>`;
}
function resultAim(aim, index) {
  const frame = aim.frame; const multi = aim.items.length > 1; const first = aim.items[0];
  const sentence = planSentence(multi ? { ...first, exposure_level: undefined } : first, frame);
  const table = multi ? `<div class="table-wrap"><table class="levels">${aim.items.map((plan) => { const main = plan.result ? mainEstimate(plan.result) : undefined;
    return `<tr><td><b>${esc(levelLabel(frame, plan.exposure_level))}</b></td><td>${plan.status === "completed" ? esc(estimateText(main)) : `<span class="badge ${esc(plan.status)}">${esc(t(plan.status))}</span>`}</td><td>${esc(direction(main))}</td><td>${trustBadge(plan.quality)}</td>
      <td><button type="button" class="linkish" data-toggle="level:${esc(plan.plan_id)}">${state.open.has(`level:${plan.plan_id}`) ? t("hideDetails") : t("details")}</button></td></tr>
      ${state.open.has(`level:${plan.plan_id}`) ? `<tr><td colspan="5">${answerCard(plan, frame)}</td></tr>` : ""}`; }).join("")}</table></div>` : answerCard(first, frame);
  return `<section class="card aim"><div class="aim-head"><span class="aim-tag">${esc(t("aim"))} ${index + 1}</span><span class="muted">${esc(pick(STUDY_TYPE[frame?.study_type]))}</span></div>
    <p class="sentence">${esc(sentence)}</p>${table}</section>`;
}
function resultsView(record, result) {
  const aims = aimsOf(result.plans, result.frame_set.frames, (plan) => plan);
  const files = ["docx", "md", "txt"].flatMap((ext) => ["zh", "en"].map((lang) => `<a href="/api/runs/${encodeURIComponent(record.id)}/files/report.${lang}.${ext}">${lang === "zh" ? "中文" : "EN"} .${ext}</a>`)).join("");
  const unanswered = result.unanswered_frames?.length ? `<section class="card"><h3>${t("unanswered")}</h3>${result.unanswered_frames.map(({ frame, reasons }) => `<p><b>${esc(frame.sub_question)}</b></p><ul class="notes">${reasons.map((r) => `<li>${esc(r[state.lang])}</li>`).join("")}</ul>`).join("")}</section>` : "";
  const changed = result.plans.some((p) => p.method_options?.length);
  return `<section class="card summary-bar"><b>${esc(L().summaryLine(result.summary.completed, result.summary.plans))}</b>
      <span class="downloads"><span class="muted">${t("downloads")}:</span> ${files}</span></section>
    ${aims.map(resultAim).join("")}${unanswered}
    ${changed ? `<div class="row-actions"><span class="muted small">${t("reanalyseHint")}</span><button id="reanalyse" type="button" disabled>${t("reanalyse")}</button></div>` : ""}`;
}

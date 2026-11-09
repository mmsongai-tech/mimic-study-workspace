"use strict";

// State, polling and events of the question workspace. Views are in views.js and results.js, text in i18n.js.
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function applyStaticText() {
  document.documentElement.lang = zh() ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  $("language-toggle").textContent = t("switchLang");
  $("examples").innerHTML = EXAMPLES.map((text, index) => `<button type="button" class="chip" data-example="${index}" title="${esc(text)}">Q${index + 1} · ${esc(text)}</button>`).join("");
}

// The question form is shown when asking; otherwise it folds into one button so the run gets the space.
function renderAsk() {
  const open = state.asking || !state.selected;
  $("ask-form").hidden = !open; $("ask-open").hidden = open;
}

async function loadRuns() {
  const { runs } = await api("/api/runs");
  $("run-list").innerHTML = runs.length ? runs.map((run) => `<li data-run="${esc(run.id)}" class="${run.id === state.selected ? "active" : ""}">
      <div class="q">${esc(run.question)}</div>
      <div class="meta">${statusBadge(run)}<span>${esc(run.created_at.slice(5, 16).replace("T", " "))}</span>${run.source === "command_line" ? `<span>· ${esc(t("commandLine"))}</span>` : ""}</div></li>`).join("")
    : `<li class="muted">${esc(t("noRuns"))}</li>`;
}
setInterval(() => { loadRuns().catch(() => undefined); }, 5000);

async function select(id) {
  if (state.selected !== id) { state.open.clear(); state.asking = false; }
  state.selected = id;
  clearTimeout(state.poll);
  const record = await api(`/api/runs/${encodeURIComponent(id)}`);
  const result = record.status === "completed" ? await api(`/api/runs/${encodeURIComponent(id)}/result`).catch(() => null) : null;
  const draft = record.status === "awaiting_confirmation" ? await api(`/api/runs/${encodeURIComponent(id)}/plan`).catch(() => null) : null;
  // A poll of an earlier selection can still be in flight; it must not take the view back.
  if (state.selected !== id) return;
  // Keep unsent choices on the review page; nothing there changes while it waits.
  if (draft && state.draft?.draft_id === draft.draft_id && state.record?.id === id) { state.record = record; return scheduleSelect(); }
  state.record = record; state.result = result; state.draft = draft;
  render();
  await loadRuns();
  if (state.selected === id) scheduleSelect();
}
function scheduleSelect() {
  clearTimeout(state.poll);
  if (["queued", "drafting", "running"].includes(state.record?.status)) state.poll = setTimeout(() => select(state.selected).catch(showError), 3000);
}

function render() {
  renderAsk();
  const record = state.record; const container = $("run-detail");
  if (!record) { container.hidden = true; return; }
  container.hidden = false;
  const header = `<section class="card run-head"><div class="section-title"><h2>${esc(record.question)}</h2>${statusBadge(record)}</div>${stepRail(record)}
    ${record.lock_id ? `<p class="muted small">${t("lockedAs")} <code>${esc(record.lock_id.slice(-12))}</code> · ${esc(L().confirmedBy[record.confirmed_by] || "")}</p>` : ""}
    ${record.error ? `<p class="error">${t("error")}: ${esc(record.error)}</p>` : ""}</section>`;
  const body = record.status === "awaiting_confirmation" && state.draft ? reviewView(state.draft)
    : record.status === "completed" && state.result ? resultsView(record, state.result)
    : ["queued", "drafting", "running"].includes(record.status) ? runningView(record)
    : "";
  container.innerHTML = header + body;
}

function showError(error) { const box = $("ask-error"); box.hidden = false; box.textContent = `${t("error")}: ${error.message}`; }

async function startRun() {
  const question = $("question").value.trim();
  if (!question) return;
  $("ask-error").hidden = true; $("run-button").disabled = true;
  try { const record = await api("/api/runs", { method: "POST", body: JSON.stringify({ question, auto_confirm: $("auto-confirm").checked }) }); state.asking = false; await select(record.id); }
  catch (error) { showError(error); }
  finally { $("run-button").disabled = false; }
}

// One method per aim applies to every included plan of that aim.
function currentChoices() {
  const draft = state.draft;
  const excluded = [...document.querySelectorAll("[data-include]")].filter((box) => !box.checked).map((box) => box.dataset.include);
  const aimMethod = Object.fromEntries([...document.querySelectorAll("[data-aim-method]:checked")].map((input) => [input.dataset.aimMethod, input.value]));
  const methods = Object.fromEntries(draft.plans.filter((item) => item.status === "ready" && aimMethod[item.plan.frame_id]).map((item) => [item.plan.plan_id, aimMethod[item.plan.frame_id]]));
  const runnable = draft.plans.filter((item) => item.status === "ready" && !excluded.includes(item.plan.plan_id)).length;
  // Design choices are made per aim and sent for every ready plan of the aim that offers them.
  const options = {};
  for (const item of draft.plans.filter((entry) => entry.status === "ready" && entry.design_options)) {
    const aimId = item.plan.frame_id; const choice = {};
    const landmark = document.querySelector(`[data-aim-landmark="${CSS.escape(aimId)}"]:checked`);
    if (landmark && item.design_options.landmark) choice.landmark = landmark.value === "on";
    const severity = [...document.querySelectorAll(`[data-aim-severity="${CSS.escape(aimId)}"]`)];
    if (severity.length && item.design_options.severity) choice.severity_on = severity.filter((box) => box.checked).map((box) => box.value).filter((value) => item.design_options.severity.names.includes(value));
    if (Object.keys(choice).length) options[item.plan.plan_id] = choice;
  }
  return { excluded, methods, runnable, options };
}
function refreshConfirmBar() {
  if (!state.draft || !$("run-count")) return;
  const { runnable } = currentChoices();
  $("run-count").textContent = L().willRun(runnable); $("confirm-plan").disabled = runnable === 0;
}
async function confirmPlan() {
  const { excluded, methods, runnable, options } = currentChoices();
  const box = $("confirm-error");
  if (!runnable) { box.hidden = false; box.textContent = t("noPlanSelected"); return; }
  $("confirm-plan").disabled = true;
  try { await api(`/api/runs/${encodeURIComponent(state.selected)}/confirm`, { method: "POST", body: JSON.stringify({ methods, excluded, options }) }); state.draft = null; await select(state.selected); }
  catch (error) { box.hidden = false; box.textContent = `${t("error")}: ${error.message}`; $("confirm-plan").disabled = false; }
}

// Methods the user changed on the results page; re-analysis is offered only when at least one differs.
function changedMethods() {
  const methods = {};
  document.querySelectorAll("input[type=radio][data-plan]:checked").forEach((input) => {
    const plan = state.result?.plans.find((p) => p.plan_id === input.dataset.plan);
    if (plan && input.value !== plan.chosen_method) methods[input.dataset.plan] = input.value;
  });
  return methods;
}

async function reanalyse() {
  const methods = changedMethods();
  if (!Object.keys(methods).length) return;
  try { const record = await api("/api/runs", { method: "POST", body: JSON.stringify({ reanalysis_of: state.selected, methods }) }); await select(record.id); }
  catch (error) { showError(error); }
}

document.addEventListener("change", (event) => {
  const input = event.target;
  if (input.dataset.aimMethod) {
    input.closest(".seg").querySelectorAll("label").forEach((label) => label.classList.toggle("on", label.contains(input)));
    const option = state.draft?.plans.find((item) => item.plan.frame_id === input.dataset.aimMethod)?.method_options.find((o) => o.method_id === input.value);
    const why = document.querySelector(`[data-method-why="${CSS.escape(input.dataset.aimMethod)}"]`); if (why && option) why.textContent = option.when_preferred[state.lang];
  }
  if (input.dataset.plan && input.type === "radio") {
    input.closest(".seg").querySelectorAll("label").forEach((label) => label.classList.toggle("on", label.contains(input)));
    if ($("reanalyse")) $("reanalyse").disabled = !Object.keys(changedMethods()).length;
  }
  if (input.dataset.include !== undefined) { input.closest(".chip-check")?.classList.toggle("off", !input.checked); refreshConfirmBar(); }
  if (input.dataset.aimSeverity !== undefined) input.closest(".chip-check")?.classList.toggle("off", !input.checked);
  if (input.dataset.aimLandmark !== undefined) input.closest(".seg").querySelectorAll("label").forEach((label) => label.classList.toggle("on", label.contains(input)));
});

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-run],[data-example],[data-toggle],[data-tab],#language-toggle,#run-button,#reanalyse,#confirm-plan,#ask-open,#ask-close");
  if (!target) return;
  if (target.id === "language-toggle") { state.lang = zh() ? "en" : "zh"; localStorageSet("mimic-lang", state.lang); applyStaticText(); render(); loadRuns().catch(showError); }
  else if (target.id === "run-button") startRun();
  else if (target.id === "reanalyse") reanalyse();
  else if (target.id === "confirm-plan") confirmPlan();
  else if (target.id === "ask-open") { state.asking = true; renderAsk(); $("question").focus(); }
  else if (target.id === "ask-close") { state.asking = false; renderAsk(); }
  else if (target.dataset.example !== undefined) $("question").value = EXAMPLES[Number(target.dataset.example)];
  else if (target.dataset.toggle) { const key = target.dataset.toggle; if (state.open.has(key)) state.open.delete(key); else state.open.add(key); keepChoices(render); }
  else if (target.dataset.tab) {
    const prefix = `tab:${target.dataset.tab}:`; const key = `${prefix}${target.dataset.name}`; const wasOpen = state.open.has(key);
    [...state.open].filter((k) => k.startsWith(prefix)).forEach((k) => state.open.delete(k));
    if (!wasOpen) state.open.add(key);
    render();
  }
  else if (target.dataset.run) select(target.dataset.run).catch(showError);
});

// Re-rendering the review page must not reset choices the user has made but not yet sent.
function keepChoices(renderFn) {
  const selector = "input[data-include],input[data-aim-method],input[data-aim-landmark],input[data-aim-severity]";
  const checked = new Map([...document.querySelectorAll(selector)].map((input) => [`${input.name}|${input.value}|${input.dataset.include ?? input.dataset.aimSeverity ?? ""}`, input.checked]));
  renderFn();
  document.querySelectorAll(selector).forEach((input) => {
    const key = `${input.name}|${input.value}|${input.dataset.include ?? input.dataset.aimSeverity ?? ""}`;
    if (checked.has(key)) input.checked = checked.get(key);
  });
  // Replay only what is selected, so each control's styling and method description follow the restored choice.
  document.querySelectorAll("input[data-include],input[data-aim-severity],input[data-aim-method]:checked,input[data-aim-landmark]:checked").forEach((input) => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

applyStaticText();
renderAsk();
loadRuns().then(() => { const first = document.querySelector("[data-run]"); if (first) return select(first.dataset.run); renderAsk(); }).catch(showError);

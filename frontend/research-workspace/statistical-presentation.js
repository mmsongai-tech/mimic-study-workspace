// Presentation consumes aggregate artifacts only. It never selects an executor.
const copy = (language, zh, en) => language === "zh" ? zh : en;
const list = (value) => Array.isArray(value) ? value : [];
const node = (document, tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = String(text);
  if (className) result.className = className;
  return result;
};
const shown = (value) => value === null || value === undefined ? "—" : String(value);

export const buildReportSections = (artifact) => {
  if (!artifact) return [];
  const objectives = Array.isArray(artifact.objectives) ? artifact.objectives : artifact.analysis ? [artifact] : [];
  return objectives.map((objective) => {
    const analysis = objective.analysis;
    return {
      id: objective.objective_id ?? objective.run_id ?? "analysis",
      status: objective.status ?? analysis?.status ?? "unknown",
      method: analysis?.method,
      methodId: analysis?.registered_method_id,
      version: analysis?.registered_method_version,
      counts: analysis?.counts ?? {},
      estimates: analysis?.estimates ?? {},
      warnings: list(objective.warnings),
      blockers: list(objective.blockers),
      tables: list(analysis?.publication_outputs?.tables),
      listings: list(analysis?.publication_outputs?.listings).filter((item) => item.privacy === "aggregate_only"),
      figures: list(analysis?.publication_outputs?.figures).filter((item) => item.mime_type === "image/svg+xml" && typeof item.content === "string"),
    };
  });
};

export const buildMethodComparison = (method) => [
  { label: method.primary_method, role: "planned", selectable: false },
  ...list(method.alternative_methods).map((label) => ({ label, role: "alternative", selectable: false })),
];

export const renderMethodComparison = (host, plan, language = "zh") => {
  const document = host.ownerDocument;
  host.replaceChildren();
  const method = plan.method;
  host.append(node(document, "h4", copy(language, "方法比较与执行边界", "Method comparison and execution boundaries")));
  host.append(node(document, "p", `${method.method_id} · ${method.method_version}`, "method-version"));
  host.append(node(document, "p", copy(language,
    "以下是当前计划与备选方法，不是已完成的分析。备选方法尚未接入切换执行，不能在这里选择后直接重算。多目标研究应分别评估方法；最终以各目标报告中的实际运行方法为准。",
    "These are planned and alternative methods, not completed analyses. Alternative executor selection is not connected. Each objective needs its own assessment; its report identifies the method actually executed.")));
  const cards = node(document, "div", undefined, "method-comparison-grid");
  for (const option of buildMethodComparison(method)) {
    const card = node(document, "article", undefined, "method-comparison-card");
    card.append(node(document, "strong", option.label));
    card.append(node(document, "p", option.role === "planned"
      ? copy(language, "当前计划 · 仍需数据与诊断检查", "Current plan · data and diagnostic checks required")
      : copy(language, "备选 · 尚未接入可选择执行", "Alternative · selectable execution not connected")));
    cards.append(card);
  }
  host.append(cards);
  if (list(method.sensitivity_analyses).length) {
    host.append(node(document, "h4", copy(language, "计划中的敏感性分析（不代表已经运行）", "Planned sensitivity analyses (not yet run)")));
    const items = node(document, "ul");
    for (const value of method.sensitivity_analyses) items.append(node(document, "li", value));
    host.append(items);
  }
};

const tableView = (document, table) => {
  const wrapper = node(document, "div", undefined, "publication-table-scroll");
  const element = node(document, "table");
  element.append(node(document, "caption", table.title));
  const header = node(document, "thead");
  const headerRow = node(document, "tr");
  for (const title of list(table.columns)) {
    const cell = node(document, "th", title);
    cell.scope = "col";
    headerRow.append(cell);
  }
  header.append(headerRow);
  const body = node(document, "tbody");
  for (const row of list(table.rows)) {
    const tr = node(document, "tr");
    for (const value of list(row)) tr.append(node(document, "td", shown(value)));
    body.append(tr);
  }
  element.append(header, body);
  wrapper.append(element);
  return wrapper;
};

const resources = new WeakMap();
export const renderPublicationReport = (host, artifact, language = "zh", urlApi = URL) => {
  for (const resource of resources.get(host) ?? []) resource.release();
  const allocated = [];
  resources.set(host, allocated);
  host.replaceChildren();
  const sections = buildReportSections(artifact);
  host.hidden = sections.length === 0;
  if (host.hidden) return;
  const document = host.ownerDocument;
  host.append(node(document, "h3", copy(language, "按研究目标查看统计结果", "Statistical results by objective")));
  host.append(node(document, "p", copy(language,
    "下列内容来自已保存的聚合统计产物，打开页面不会重新计算。每个目标单独显示样本、方法、图表与限制；运行完成不等于因果结论已经成立。",
    "These saved aggregate artifacts are not recomputed when displayed. Samples, methods, figures and limitations are shown separately for each objective. Completed execution does not establish causality.")));
  for (const section of sections) {
    const card = node(document, "section", undefined, "publication-objective");
    card.append(node(document, "h4", `${section.id} · ${section.status}`));
    if (section.method) {
      card.append(node(document, "p", `${copy(language, "实际运行方法", "Executed method")}: ${section.method}`));
      card.append(node(document, "p", `${shown(section.methodId)} @ ${shown(section.version)}`, "method-version"));
      const summary = node(document, "dl", undefined, "publication-numbers");
      const values = [
        [copy(language, "分析样本", "Analysis sample"), section.counts.complete],
        [copy(language, "效应尺度", "Effect scale"), section.estimates.effect_scale],
        [copy(language, "估计值", "Estimate"), section.estimates.estimate],
        [copy(language, "置信区间下限", "Confidence interval lower"), section.estimates.ci_lower],
        [copy(language, "置信区间上限", "Confidence interval upper"), section.estimates.ci_upper],
      ];
      for (const [label, value] of values) {
        const item = node(document, "div");
        item.append(node(document, "dt", label), node(document, "dd", shown(value)));
        summary.append(item);
      }
      card.append(summary);
    }
    const notices = [...section.blockers.map((item) => `${item.code ?? "blocked"}: ${item.message ?? ""}`), ...section.warnings];
    if (notices.length) {
      const warning = node(document, "ul", undefined, "publication-warnings");
      for (const notice of notices) warning.append(node(document, "li", notice));
      card.append(warning);
    }
    for (const figure of section.figures) {
      const wrapper = node(document, "figure", undefined, "publication-figure");
      const caption = node(document, "figcaption", figure.title);
      // An SVG image is isolated from the document; never inject SVG as HTML.
      const url = urlApi.createObjectURL(new Blob([figure.content], { type: "image/svg+xml" }));
      allocated.push({ release: () => urlApi.revokeObjectURL(url) });
      const img = node(document, "img");
      img.src = url;
      img.alt = `${section.id}: ${figure.title}`;
      const link = node(document, "a", copy(language, "下载 SVG 图", "Download SVG"));
      link.href = url;
      link.download = `${section.id}-${figure.id}.svg`.replace(/[^a-z0-9._-]/giu, "_");
      wrapper.append(caption, img, link);
      card.append(wrapper);
    }
    if (!section.figures.length) card.append(node(document, "p", copy(language, "此目标没有可用的图形产物。", "No figure artifact is available for this objective.")));
    for (const table of section.tables) card.append(tableView(document, table));
    for (const listing of section.listings) card.append(tableView(document, listing));
    host.append(card);
  }
};

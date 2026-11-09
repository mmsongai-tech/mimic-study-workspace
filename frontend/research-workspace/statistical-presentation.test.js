import assert from "node:assert/strict";
import test from "node:test";
import { buildReportSections, buildMethodComparison, renderPublicationReport, renderMethodComparison } from "./statistical-presentation.js";

// Synthetic aggregate-only presentation fixtures; never clinical acceptance data.
const analysis = {
  method: "registered_method", registered_method_id: "association.binary.v1", registered_method_version: "1.0.0",
  counts: { complete: 20 }, estimates: { estimate: 0, ci_lower: -1, ci_upper: 1, effect_scale: "difference" },
  publication_outputs: {
    tables: [{ id: "results", title: "Results", columns: ["Estimate"], rows: [[0]] }],
    listings: [{ id: "flow", title: "Flow", privacy: "aggregate_only", columns: ["Count"], rows: [[20]] }, { privacy: "patient_level" }],
    figures: [{ id: "effect", title: "Effect", mime_type: "image/svg+xml", content: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" }],
  },
};
const artifact = { objectives: [{ objective_id: "first", status: "completed", analysis, warnings: ["Review confounding"] }, { objective_id: "second", status: "blocked", blockers: [{ code: "MISSING_DATA", message: "No supported mapping" }] }] };
class Element {
  constructor(tag, document) { this.tag = tag; this.ownerDocument = document; this.children = []; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}
const document = { createElement: (tag) => new Element(tag, document) };
const walk = (element) => [element, ...element.children.flatMap(walk)];
const text = (element) => walk(element).map((item) => item.textContent).join(" ");
const urls = () => { const revoked = []; let id = 0; return { revoked, createObjectURL: () => `blob:test-${++id}`, revokeObjectURL: (url) => revoked.push(url) }; };

test("single and multiple objective artifacts preserve actual methods, zero estimates and blocked objectives", () => {
  assert.equal(buildReportSections({ analysis })[0].estimates.estimate, 0);
  const sections = buildReportSections(artifact);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].method, "registered_method");
  assert.equal(sections[0].listings.length, 1);
  assert.equal(sections[1].blockers[0].code, "MISSING_DATA");
  assert.deepEqual(buildReportSections(null), []);
});

test("report renders real artifact images, readable tables and target-specific blockers", () => {
  const host = new Element("section", document);
  renderPublicationReport(host, artifact, "zh", urls());
  assert.equal(walk(host).filter((item) => item.tag === "img").length, 1);
  assert.equal(walk(host).filter((item) => item.tag === "table").length, 2);
  assert.match(text(host), /registered_method/);
  assert.match(text(host), /MISSING_DATA: No supported mapping/);
  assert.match(text(host), /Review confounding/);
  const img = walk(host).find((item) => item.tag === "img");
  assert.equal(img.src, "blob:test-1");
  assert.equal(img.alt, "first: Effect");
});

test("rerender and clearing a study release old figure resources", () => {
  const host = new Element("section", document); const api = urls();
  renderPublicationReport(host, artifact, "en", api);
  renderPublicationReport(host, artifact, "zh", api);
  assert.deepEqual(api.revoked, ["blob:test-1"]);
  renderPublicationReport(host, null, "zh", api);
  assert.deepEqual(api.revoked, ["blob:test-1", "blob:test-2"]);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

test("alternatives are not falsely exposed as executable selections", () => {
  const method = { method_id: "generic.v1", method_version: "1", primary_method: "Actual plan", alternative_methods: ["Alternative A", "Alternative B"], sensitivity_analyses: ["Weight truncation"] };
  assert.equal(buildMethodComparison(method).length, 3);
  assert.ok(buildMethodComparison(method).every((item) => item.selectable === false));
  const host = new Element("section", document);
  renderMethodComparison(host, { method }, "zh");
  assert.match(text(host), /尚未接入/);
  assert.match(text(host), /不代表已经运行/);
  assert.equal(walk(host).filter((item) => item.tag === "select").length, 0);
});

test("untrusted labels remain plain text and unavailable figures are explicit", () => {
  const host = new Element("section", document);
  renderPublicationReport(host, { analysis: { ...analysis, method: "<script>bad()</script>", publication_outputs: {} } }, "en", urls());
  assert.match(text(host), /<script>bad\(\)<\/script>/);
  assert.equal(walk(host).filter((item) => item.tag === "script").length, 0);
  assert.match(text(host), /No figure artifact/);
});

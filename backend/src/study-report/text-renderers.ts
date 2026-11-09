import { relative } from "node:path";
import type { ReportDocument } from "./report-document.js";

const escapeCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");

/** Markdown rendering; figure paths are written relative to the report file's directory. */
export const renderMarkdown = (document: ReportDocument, reportDirectory: string): string => document.blocks.map((block) => {
  switch (block.kind) {
    case "heading": return `${"#".repeat(block.level)} ${block.text}`;
    case "paragraph": return block.text;
    case "list": return block.items.map((item) => `- ${item}`).join("\n");
    case "figure": return `![${block.caption}](${relative(reportDirectory, block.path)})\n\n*${block.caption}*`;
    case "table": return [
      ...(block.caption ? [`**${block.caption}**`, ""] : []),
      `| ${block.columns.map(escapeCell).join(" | ")} |`,
      `| ${block.columns.map(() => "---").join(" | ")} |`,
      ...block.rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
    ].join("\n");
  }
}).join("\n\n") + "\n";

const width = (text: string): number => [...text].reduce((sum, character) => sum + (/[ᄀ-￿]/u.test(character) ? 2 : 1), 0);
const pad = (text: string, size: number): string => text + " ".repeat(Math.max(0, size - width(text)));

/** Plain-text rendering with aligned tables, for email bodies and terminals. */
export const renderText = (document: ReportDocument): string => document.blocks.map((block) => {
  switch (block.kind) {
    case "heading": return block.level === 1 ? `${block.text}\n${"=".repeat(width(block.text))}` : block.level === 2 ? `${block.text}\n${"-".repeat(width(block.text))}` : `[${block.text}]`;
    case "paragraph": return block.text;
    case "list": return block.items.map((item) => `  * ${item}`).join("\n");
    case "figure": return `  (figure: ${block.caption} — ${block.path})`;
    case "table": {
      const rows = [block.columns, ...block.rows].map((row) => row.map((value) => value.length > 60 ? `${value.slice(0, 57)}...` : value));
      const sizes = block.columns.map((_, index) => Math.max(...rows.map((row) => width(row[index] ?? ""))));
      const line = sizes.map((size) => "-".repeat(size)).join("-+-");
      return [...(block.caption ? [block.caption] : []), rows[0]!.map((value, index) => pad(value, sizes[index]!)).join(" | "), line, ...rows.slice(1).map((row) => row.map((value, index) => pad(value ?? "", sizes[index]!)).join(" | "))].join("\n");
    }
  }
}).join("\n\n") + "\n";

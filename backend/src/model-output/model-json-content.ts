/** Extracts one JSON object from a chat-completion message, tolerating a sole code fence or surrounding prose. */
export const parseModelJsonObject = (content: unknown): unknown | undefined => {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.find((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))?.text
    : undefined;
  if (!text) return undefined;
  for (const candidate of [text, text.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/iu)?.[1]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* continue */ }
  }
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) try { return JSON.parse(text.slice(start, end + 1)); } catch { /* invalid */ }
  return undefined;
};

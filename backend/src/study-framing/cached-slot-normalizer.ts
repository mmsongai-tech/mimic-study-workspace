import { readFile, rename, writeFile } from "node:fs/promises";
import type { SlotCategory } from "./domain/study-frame.js";
import type { SlotNormalizer } from "./study-framing-service.js";

type Normalized = { label_en: string; category: SlotCategory };
export interface NormalizationStore { get(key: string): Promise<Normalized | undefined>; set(key: string, value: Normalized): Promise<void> }

/**
 * Makes slot normalization reproducible: the same phrase, role, model and prompt version always yields the same English
 * label and category, so re-running a question cannot silently change which MIMIC concept is searched.
 */
export class CachedSlotNormalizer implements SlotNormalizer {
  constructor(private readonly inner: SlotNormalizer, private readonly store: NormalizationStore, private readonly scope: string) {}

  async normalize(input: { text: string; role: string }): Promise<Normalized> {
    const key = JSON.stringify([this.scope, input.role, input.text.trim()]);
    const cached = await this.store.get(key);
    if (cached) return cached;
    const value = await this.inner.normalize(input);
    await this.store.set(key, value);
    return value;
  }
}

/** A small JSON-file store; writes are atomic (temporary file + rename). */
export class JsonFileNormalizationStore implements NormalizationStore {
  private entries?: Record<string, Normalized>;
  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, Normalized>> {
    if (!this.entries) {
      try { this.entries = JSON.parse(await readFile(this.path, "utf8")) as Record<string, Normalized>; } catch { this.entries = {}; }
    }
    return this.entries;
  }

  async get(key: string): Promise<Normalized | undefined> { return (await this.load())[key]; }

  async set(key: string, value: Normalized): Promise<void> {
    const entries = await this.load();
    entries[key] = value;
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`);
    await rename(temporary, this.path);
  }
}

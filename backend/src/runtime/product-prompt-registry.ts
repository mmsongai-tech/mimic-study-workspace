import { readFile } from "node:fs/promises";

export interface ProductPromptReference {
  id: string;
  version: string;
}

export interface ProductPromptAsset extends ProductPromptReference {
  status: "testing" | "active";
  body: string;
}

export interface ProductPromptRegistry {
  load(reference: ProductPromptReference): Promise<ProductPromptAsset>;
}

export class ProductPromptRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductPromptRegistryError";
  }
}

export class RegisteredProductPromptRegistry implements ProductPromptRegistry {
  private readonly entries: Map<string, URL>;

  constructor(entries: Array<{ id: string; source: URL }>) {
    this.entries = new Map(entries.map(({ id, source }) => [id, source]));
    if (this.entries.size !== entries.length) {
      throw new ProductPromptRegistryError("Product prompt identifiers must be unique.");
    }
  }

  async load(reference: ProductPromptReference): Promise<ProductPromptAsset> {
    const source = this.entries.get(reference.id);
    if (!source) throw new ProductPromptRegistryError(`Unknown product prompt: ${reference.id}`);

    let text: string;
    try {
      text = await readFile(source, "utf8");
    } catch {
      throw new ProductPromptRegistryError(`Product prompt could not be loaded: ${reference.id}`);
    }
    const asset = this.parse(text);
    if (asset.id !== reference.id || asset.version !== reference.version) {
      throw new ProductPromptRegistryError(
        `Product prompt metadata does not match ${reference.id}@${reference.version}`,
      );
    }
    return asset;
  }

  private parse(text: string): ProductPromptAsset {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(text);
    if (!match) throw new ProductPromptRegistryError("Product prompt front matter is invalid.");
    const metadata = Object.fromEntries(
      (match[1] ?? "")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(":");
          if (separator < 1) throw new ProductPromptRegistryError("Product prompt metadata is invalid.");
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
        }),
    );
    const keys = Object.keys(metadata);
    if (keys.some((key) => !["id", "version", "status"].includes(key))) {
      throw new ProductPromptRegistryError("Product prompt metadata contains unsupported fields.");
    }
    if (!metadata.id || !metadata.version || !["testing", "active"].includes(metadata.status ?? "")) {
      throw new ProductPromptRegistryError("Product prompt metadata is incomplete.");
    }
    return {
      id: metadata.id,
      version: metadata.version,
      status: metadata.status as "testing" | "active",
      body: match[2] ?? "",
    };
  }
}

export const createRepositoryProductPromptRegistry = (): ProductPromptRegistry =>
  new RegisteredProductPromptRegistry([
    {
      id: "research-design",
      source: new URL("../../../prompts/product/research-design/current.md", import.meta.url),
    },
    {
      id: "generated-analysis",
      source: new URL("../../../prompts/product/generated-analysis/current.md", import.meta.url),
    },
    {
      id: "variable-mapping",
      source: new URL("../../../prompts/product/variable-mapping/current.md", import.meta.url),
    },
    {
      id: "mapping-evidence-review",
      source: new URL("../../../prompts/product/mapping-evidence-review/current.md", import.meta.url),
    },
    {
      id: "research-objectives",
      source: new URL("../../../prompts/product/research-objectives/current.md", import.meta.url),
    },
    {
      id: "research-objective-coverage",
      source: new URL("../../../prompts/product/research-objective-coverage/current.md", import.meta.url),
    },
    {
      id: "study-question-split",
      source: new URL("../../../prompts/product/study-question-split/current.md", import.meta.url),
    },
    {
      id: "study-frame-extraction",
      source: new URL("../../../prompts/product/study-frame-extraction/current.md", import.meta.url),
    },
    {
      id: "study-frame-extraction-en",
      source: new URL("../../../prompts/product/study-frame-extraction-en/current.md", import.meta.url),
    },
    {
      id: "research-objective-study-spec",
      source: new URL("../../../prompts/product/research-objective-study-spec/current.md", import.meta.url),
    },
  ]);

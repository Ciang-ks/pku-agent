import type { EmbeddingProvider } from "../domain/types.js";

export interface OpenAiEmbeddingProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(options: OpenAiEmbeddingProviderOptions = {}) {
    const model = options.model ?? process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
    this.id = `openai:${model}`;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async embed(input: string[]): Promise<number[][]> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for semantic course search.");
    if (input.length === 0) return [];
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.id.slice("openai:".length), input }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OpenAI embedding request failed (${response.status}).`);
    const payload = await response.json() as { data?: { embedding?: unknown }[] };
    const vectors = payload.data?.map((item) => item.embedding);
    if (!vectors || vectors.length !== input.length || !vectors.every(isNumberVector)) {
      throw new Error("OpenAI embedding response is invalid.");
    }
    return vectors;
  }
}

function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

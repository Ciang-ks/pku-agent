import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { TranscriptionInput, TranscriptionProvider } from "../domain/types.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);

export interface OpenAiTranscriptionProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiTranscriptionProvider implements TranscriptionProvider {
  readonly id: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiTranscriptionProviderOptions = {}) {
    const model = options.model ?? process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-transcribe";
    this.id = `openai:${model}`;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async transcribe(input: TranscriptionInput): Promise<{ text: string }> {
    if (!this.apiKey) throw new TranscriptionProviderError("OPENAI_API_KEY_MISSING", "OPENAI_API_KEY is required for recording transcription.");
    const extension = extname(input.filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      throw new TranscriptionProviderError("AUDIO_FORMAT_UNSUPPORTED", `Unsupported audio format: ${extension || "unknown"}.`);
    }
    const fileStat = await stat(input.filePath);
    if (fileStat.size <= 0 || fileStat.size > MAX_UPLOAD_BYTES) {
      throw new TranscriptionProviderError("AUDIO_FILE_TOO_LARGE", "Audio chunks must be larger than zero and at most 25 MB.");
    }

    const body = new FormData();
    body.set("model", this.id.slice("openai:".length));
    body.set("file", new Blob([await readFile(input.filePath)]), basename(input.filePath));
    const prompt = input.prompt?.trim();
    if (prompt) body.set("prompt", prompt.slice(0, 6_000));
    for (const keyword of input.keywords ?? []) body.append("keywords[]", validateHint(keyword, "keyword"));
    for (const language of input.languages ?? []) body.append("languages[]", validateHint(language, "language"));

    const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new TranscriptionProviderError(
        "OPENAI_TRANSCRIPTION_FAILED",
        `OpenAI transcription request failed (${response.status}).`,
      );
    }
    const payload = await response.json() as { text?: unknown };
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      throw new TranscriptionProviderError("OPENAI_TRANSCRIPTION_INVALID", "OpenAI transcription response did not include text.");
    }
    return { text: payload.text.trim() };
  }
}

export class TranscriptionProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function validateHint(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[<>\r\n]/.test(normalized)) {
    throw new TranscriptionProviderError("TRANSCRIPTION_HINT_INVALID", `Each ${label} must be a single safe line.`);
  }
  return normalized;
}

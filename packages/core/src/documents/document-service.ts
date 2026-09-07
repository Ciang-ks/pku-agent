import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type {
  CourseDocumentBlock,
  CourseNoteSource,
  EmbeddingProvider,
  DocumentParserProvider,
  DocumentSearchResult,
  ParsedDocument,
  ParsedDocumentBlock,
} from "../domain/types.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { CourseWorkspaceService } from "../storage/course-workspace-service.js";
import { OpenAiEmbeddingProvider } from "./openai-embedding-provider.js";

const execFileAsync = promisify(execFile);

export class TextDocumentParser implements DocumentParserProvider {
  async parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    const lines = input.content.replace(/\r\n?/g, "\n").split("\n");
    const blocks: ParsedDocumentBlock[] = [];
    let heading = basename(input.filePath).replace(/\.[^.]+$/, "");
    let paragraph: string[] = [];
    const flush = (): void => {
      const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
      if (text) blocks.push({ contentType: "paragraph", text, heading });
      paragraph = [];
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const markdownHeading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (markdownHeading?.[2]) {
        flush();
        heading = markdownHeading[2].trim();
        blocks.push({ contentType: "heading", text: heading, heading });
        continue;
      }
      if (!line) {
        flush();
        continue;
      }
      paragraph.push(line);
    }
    flush();
    return { title: basename(input.filePath), blocks };
  }
}

export class MineruMarkdownParser implements DocumentParserProvider {
  async parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    const lines = input.content.replace(/\r\n?/g, "\n").split("\n");
    const blocks: ParsedDocumentBlock[] = [];
    let heading = basename(input.filePath).replace(/\.[^.]+$/, "");
    let page: number | undefined;
    let paragraph: string[] = [];
    const flush = (): void => {
      const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
      if (text) blocks.push({ contentType: "paragraph", text, heading, ...(page === undefined ? {} : { page }) });
      paragraph = [];
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const marker = /^(?:<!--\s*(?:page(?:\s+number)?|page_number)\s*[:=]\s*(\d+)\s*-->|\[page\s+(\d+)\])$/i.exec(line);
      if (marker) {
        flush();
        page = Number(marker[1] ?? marker[2]);
        continue;
      }
      const markdownHeading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (markdownHeading?.[2]) {
        flush();
        heading = markdownHeading[2].trim();
        blocks.push({ contentType: "heading", text: heading, heading, ...(page === undefined ? {} : { page }) });
        continue;
      }
      if (!line) {
        flush();
        continue;
      }
      paragraph.push(line);
    }
    flush();
    return { title: basename(input.filePath), blocks };
  }
}

export interface MineruDocumentParserOptions {
  executable?: string;
  /** MinerU cloud model used by the Standard API. */
  model?: "pipeline" | "vlm" | "MinerU-HTML";
  /** @deprecated Use model. Kept for callers compiled against the old local CLI adapter. */
  backend?: "pipeline" | "hybrid-auto" | "vlm-auto";
  api?: "auto" | "agent" | "standard";
  timeoutMs?: number;
}

export class MineruDocumentParser implements DocumentParserProvider {
  private readonly executable: string;
  private readonly model: "pipeline" | "vlm" | "MinerU-HTML";
  private readonly api: "auto" | "agent" | "standard";
  private readonly timeoutMs: number;
  private readonly markdownParser = new MineruMarkdownParser();

  constructor(options: MineruDocumentParserOptions = {}) {
    this.executable = options.executable ?? process.env.PKU_STUDY_MINERU_COMMAND ?? "mineru";
    this.model = options.model ?? (options.backend === "pipeline" ? "pipeline" : "vlm");
    this.api = options.api ?? "auto";
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    const outputDir = await mkdtemp(join(tmpdir(), "pku-study-mineru-"));
    try {
      // MinerU-Skill is a zero-dependency cloud wrapper. Keep the output on disk
      // so images/Markdown can be normalized and indexed without trusting stdout.
      // `--engine cloud` is explicit to prevent accidentally enabling its optional
      // local PyMuPDF path on a machine where no model weights should be present.
      await execFileAsync(this.executable, [
        input.filePath,
        "--output", outputDir,
        "--api", this.api,
        "--model", this.model,
        "--engine", "cloud",
        "--workers", "1",
        "--timeout", String(Math.ceil(this.timeoutMs / 1000)),
        "--quiet",
      ], {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      const markdownPath = await findFirstMarkdown(outputDir);
      if (!markdownPath) throw new Error("MinerU did not produce a Markdown output.");
      return this.markdownParser.parse({ filePath: input.filePath, content: await readFile(markdownPath, "utf8") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DocumentServiceError("MINERU_FAILED", `MinerU parsing failed: ${message.slice(0, 500)}`, 502);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

class CompositeDocumentParser implements DocumentParserProvider {
  private readonly text = new TextDocumentParser();
  private readonly mineru: MineruDocumentParser;

  constructor(mineru?: MineruDocumentParser) {
    this.mineru = mineru ?? new MineruDocumentParser();
  }

  parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    return /\.pdf$/i.test(input.filePath) ? this.mineru.parse(input) : this.text.parse(input);
  }
}

export interface DocumentServiceOptions {
  store: SqliteStore;
  courses: CourseWorkspaceService;
  parser?: DocumentParserProvider;
  embeddings?: EmbeddingProvider;
}

export class DocumentService {
  private readonly parser: DocumentParserProvider;
  private readonly embeddings: EmbeddingProvider;

  constructor(private readonly options: DocumentServiceOptions) {
    this.parser = options.parser ?? new CompositeDocumentParser();
    this.embeddings = options.embeddings ?? new OpenAiEmbeddingProvider();
  }

  async indexAsset(courseId: string, requestedPath: string): Promise<CourseDocumentBlock[]> {
    const course = this.options.courses.get(courseId);
    if (!course) throw new DocumentServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    const path = this.resolveCoursePath(course.rootPath, requestedPath);
    if (!/\.(md|markdown|txt|pdf)$/i.test(path)) {
      throw new DocumentServiceError("UNSUPPORTED_DOCUMENT", "Only PDF, Markdown and text assets can be indexed.", 415);
    }
    try {
      await access(path, constants.R_OK);
    } catch {
      throw new DocumentServiceError("ASSET_NOT_FOUND", "Course asset not found.", 404);
    }
    // Do not follow symlinks supplied through the API. A lexical path check
    // alone cannot prevent a link inside the course workspace from pointing
    // outside that workspace (or from targeting a directory).
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      throw new DocumentServiceError("ASSET_NOT_FOUND", "Course asset not found.", 404);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new DocumentServiceError(
        "ASSET_PATH_FORBIDDEN",
        "Only regular files inside the course workspace can be indexed.",
        400,
      );
    }
    const sourcePath = relative(course.rootPath, path);
    const parsed = await this.parser.parse({ filePath: path, content: /\.pdf$/i.test(path) ? "" : await readFile(path, "utf8") });
    const indexedSourcePath = /\.pdf$/i.test(path)
      ? await this.writeNormalizedMarkdown(course.rootPath, sourcePath, parsed)
      : sourcePath;
    const blocks = parsed.blocks.map((block, index) => ({
      blockId: createHash("sha256").update(`${courseId}\0${path}\0${index}\0${block.text}`).digest("hex").slice(0, 32),
      courseId,
      sourcePath: indexedSourcePath,
      title: parsed.title,
      ...(block.page === undefined ? {} : { page: block.page }),
      contentType: block.contentType,
      text: block.text,
      updatedAt: new Date().toISOString(),
    } satisfies CourseDocumentBlock));
    this.options.store.replaceDocumentBlocks(courseId, indexedSourcePath, blocks);
    await this.indexEmbeddings(blocks);
    return blocks;
  }

  async parseAsset(courseId: string, requestedPath: string): Promise<CourseDocumentBlock[]> {
    return this.indexAsset(courseId, requestedPath);
  }

  async rebuildCourseIndex(courseId: string): Promise<{ assetCount: number; blockCount: number }> {
    const course = this.options.courses.get(courseId);
    if (!course) throw new DocumentServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    const paths = await this.findTextAssets(course.rootPath);
    this.options.store.clearDocumentBlocks(courseId);
    let blockCount = 0;
    for (const path of paths) {
      blockCount += (await this.indexAsset(courseId, path)).length;
    }
    return { assetCount: paths.length, blockCount };
  }

  async search(courseId: string, query: string, limit = 10): Promise<DocumentSearchResult[]> {
    if (!this.options.courses.get(courseId)) {
      throw new DocumentServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    }
    const fullText = this.options.store.searchDocumentBlocks(courseId, query, Math.max(limit * 5, 50));
    if (!this.embeddings.isAvailable()) return fullText.slice(0, limit);
    let queryVector: number[] | undefined;
    try {
      queryVector = (await this.embeddings.embed([query]))[0];
    } catch {
      return fullText.slice(0, limit);
    }
    if (!queryVector) return fullText.slice(0, limit);
    const semantic = this.options.store
      .getDocumentVectors(courseId, this.embeddings.id)
      .map(({ blockId, vector }) => ({ blockId, score: cosineSimilarity(queryVector, vector) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score);
    const blocks = new Map(this.options.store.listDocumentBlocks(courseId).map((block) => [block.blockId, block]));
    return reciprocalRankFusion(
      fullText.map((result) => result.block.blockId),
      semantic.map((result) => result.blockId),
    ).flatMap(({ blockId, score }) => {
      const block = blocks.get(blockId);
      return block ? [{ block, score }] : [];
    }).slice(0, limit);
  }

  listNoteSources(courseId: string): CourseNoteSource[] {
    if (!this.options.courses.get(courseId)) {
      throw new DocumentServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    }
    const grouped = new Map<string, CourseNoteSource>();
    for (const block of this.options.store.listDocumentBlocks(courseId)) {
      const kind = block.sourcePath.startsWith("recordings/transcripts/")
        ? "recording-transcript"
        : block.sourcePath.startsWith("materials/text/")
          ? "material"
          : undefined;
      if (!kind) continue;
      const existing = grouped.get(block.sourcePath);
      if (!existing) {
        grouped.set(block.sourcePath, {
          sourcePath: block.sourcePath,
          title: block.title,
          kind,
          blockCount: 1,
          updatedAt: block.updatedAt,
        });
      } else {
        existing.blockCount += 1;
        if (block.updatedAt > existing.updatedAt) existing.updatedAt = block.updatedAt;
      }
    }
    return [...grouped.values()].sort(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.sourcePath.localeCompare(right.sourcePath),
    );
  }

  readIndexedAsset(courseId: string, sourcePath: string): CourseDocumentBlock[] {
    if (!this.options.courses.get(courseId)) {
      throw new DocumentServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    }
    const blocks = this.options.store.listDocumentBlocksForSource(courseId, sourcePath);
    if (blocks.length === 0) {
      throw new DocumentServiceError(
        "DOCUMENT_NOT_INDEXED",
        "The requested asset is not indexed for this course.",
        404,
      );
    }
    return blocks;
  }

  private async indexEmbeddings(blocks: CourseDocumentBlock[]): Promise<void> {
    if (!this.embeddings.isAvailable() || blocks.length === 0) return;
    let vectors: number[][];
    try {
      vectors = await this.embeddings.embed(blocks.map((block) => block.text));
    } catch {
      return;
    }
    if (vectors.length !== blocks.length) throw new Error("Embedding provider returned an unexpected number of vectors.");
    this.options.store.upsertDocumentVectors(
      this.embeddings.id,
      blocks.map((block, index) => ({ blockId: block.blockId, vector: vectors[index]! })),
    );
  }

  private resolveCoursePath(rootPath: string, requestedPath: string): string {
    const root = resolve(rootPath);
    const candidate = resolve(root, requestedPath);
    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || candidate === root) {
      throw new DocumentServiceError("ASSET_PATH_FORBIDDEN", "Asset path must stay inside the course workspace.", 400);
    }
    return candidate;
  }

  private async writeNormalizedMarkdown(
    rootPath: string,
    sourcePath: string,
    parsed: ParsedDocument,
  ): Promise<string> {
    const hash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 12);
    const stem = basename(sourcePath).replace(/\.pdf$/i, "").replace(/[^\p{Letter}\p{Number}._-]+/gu, "-") || "document";
    const relativeOutputPath = join("materials", "text", "parsed", `${stem}-${hash}.md`);
    const outputPath = this.resolveCoursePath(rootPath, relativeOutputPath);
    await mkdir(join(rootPath, "materials", "text", "parsed"), { recursive: true });
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, normalizedMarkdown(parsed), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
    return relativeOutputPath;
  }

  private async findTextAssets(rootPath: string): Promise<string[]> {
    const allowedDirectories = [
      "materials/text",
      "announcements",
      "recordings/transcripts",
      "notes",
      "assignments",
      "practice",
    ];
    const assets: string[] = [];
    for (const directory of allowedDirectories) {
      const absoluteDirectory = join(rootPath, directory);
      try {
        await access(absoluteDirectory, constants.R_OK);
      } catch {
        continue;
      }
      await this.collectTextAssets(rootPath, absoluteDirectory, assets);
    }
    return assets.sort();
  }

  private async collectTextAssets(rootPath: string, directory: string, assets: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await this.collectTextAssets(rootPath, path, assets);
        continue;
      }
      if (entry.isFile() && /\.(md|markdown|txt|pdf)$/i.test(entry.name)) {
        const stat = await lstat(path);
        if (stat.isFile()) assets.push(relative(rootPath, path));
      }
    }
  }
}

async function findFirstMarkdown(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstMarkdown(path);
      if (nested) return nested;
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      return path;
    }
  }
  return undefined;
}

export function normalizedMarkdown(parsed: ParsedDocument): string {
  const lines: string[] = [];
  let previousPage: number | undefined;
  for (const block of parsed.blocks) {
    if (block.page !== undefined && block.page !== previousPage) {
      lines.push(`<!-- page: ${block.page} -->`, "");
      previousPage = block.page;
    }
    lines.push(block.contentType === "heading" ? `# ${block.text}` : block.text, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm);
}

export function reciprocalRankFusion(...rankings: string[][]): { blockId: string; score: number }[] {
  const scores = new Map<string, number>();
  const k = 60;
  for (const ranking of rankings) {
    ranking.forEach((blockId, index) => scores.set(blockId, (scores.get(blockId) ?? 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()]
    .map(([blockId, score]) => ({ blockId, score }))
    .sort((left, right) => right.score - left.score || left.blockId.localeCompare(right.blockId));
}

export class DocumentServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

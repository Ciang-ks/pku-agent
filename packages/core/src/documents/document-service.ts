import { createHash, randomUUID } from "node:crypto";
import { access, lstat, realpath, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  CourseDocumentBlock,
  CourseNoteSource,
  EmbeddingProvider,
  DocumentParserProvider,
  DocumentSearchResult,
  ParsedDocument,
} from "../domain/types.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import type { CourseWorkspaceService } from "../storage/course-workspace-service.js";
import { OpenAiEmbeddingProvider } from "./openai-embedding-provider.js";

import { CompositeDocumentParser, MineruMarkdownParser } from "./parsers/index.js";
import { cosineSimilarity, reciprocalRankFusion } from "./ranking.js";
import { normalizedMarkdown } from "./normalized-markdown.js";
import { DocumentServiceError } from "./errors.js";
// Compatibility exports for existing CLI, tests and library consumers.
export * from "./parsers/index.js";
export * from "./ranking.js";
export * from "./normalized-markdown.js";
export * from "./errors.js";

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
    if (!/\.(md|markdown|txt|pdf|pptx?|docx?|png|jpe?g|webp)$/i.test(path)) {
      throw new DocumentServiceError("UNSUPPORTED_DOCUMENT", "Unsupported document format.", 415);
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
    const realRoot = await realpath(course.rootPath);
    const realFile = await realpath(path);
    if (!realFile.startsWith(`${realRoot}${sep}`)) throw new DocumentServiceError("ASSET_PATH_FORBIDDEN", "Asset escapes course workspace.", 400);
    const sourcePath = relative(course.rootPath, path);
    const parsed = await this.parser.parse({ filePath: path, content: /\.(md|markdown|txt)$/i.test(path) ? await readFile(path, "utf8") : "" });
    const indexedSourcePath = !/\.(md|markdown|txt)$/i.test(path) || sourcePath.startsWith(`materials${sep}original${sep}`)
      ? await this.writeNormalizedMarkdown(course.rootPath, sourcePath, parsed)
      : sourcePath;
    const blocks = parsed.blocks.map((block, index) => ({
      blockId: createHash("sha256").update(`${courseId}\0${indexedSourcePath}\0${index}\0${block.text}`).digest("hex").slice(0, 32),
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
    const stem = basename(sourcePath).replace(/\.[^.]+$/, "").replace(/[^\p{Letter}\p{Number}._-]+/gu, "-") || "document";
    const relativeOutputPath = join("materials", "text", "parsed", `${stem}-${hash}.md`);
    const outputPath = this.resolveCoursePath(rootPath, relativeOutputPath);
    await mkdir(join(rootPath, "materials", "text", "parsed"), { recursive: true });
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    let markdown = normalizedMarkdown(parsed);
    for (const attachment of parsed.attachments ?? []) {
      const assetPath = join("materials", "text", "parsed", `${stem}-${hash}-assets`, attachment.path);
      const destination = this.resolveCoursePath(rootPath, assetPath);
      const imageRoot = join(rootPath, "materials", "text", "parsed", `${stem}-${hash}-assets`);
      if (!destination.startsWith(`${imageRoot}${sep}`) || !/\.(png|jpe?g|webp|gif)$/i.test(destination))
        throw new DocumentServiceError("PARSER_ATTACHMENT_INVALID", "Invalid parser attachment path.", 502);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, attachment.data);
      const portablePath = assetPath.split(sep).join("/");
      markdown = markdown.split(`](${attachment.path})`).join(`](${portablePath})`);
      for (const block of parsed.blocks) block.text = block.text.split(`](${attachment.path})`).join(`](${portablePath})`);
    }
    await writeFile(temporaryPath, markdown, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
    // Index the same paragraph boundaries that a rebuild reads from disk.
    // Structured cloud blocks may contain multiple paragraphs or captions.
    parsed.blocks = (await new MineruMarkdownParser().parse({ filePath: outputPath, content: markdown })).blocks;
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

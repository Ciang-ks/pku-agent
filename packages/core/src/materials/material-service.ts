import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { CourseWorkspaceService } from "../storage/course-workspace-service.js";
import type { DocumentService } from "../documents/document-service.js";
import { LearningRepository } from "../learning/learning-repository.js";
import { LearningError } from "../learning/lesson-service.js";
import { classifyMaterialSchema } from "../learning/schemas.js";
import type { Material, MaterialRole } from "../learning/types.js";

export const documentExtensions = new Set([".pdf", ".md", ".markdown", ".txt", ".ppt", ".pptx", ".doc", ".docx", ".png", ".jpg", ".jpeg", ".webp"]);
const mediaExtensions = new Set([".mp3", ".mp4", ".m4a", ".wav", ".webm", ".mpeg", ".mpga"]);
export const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;

/** Course-wide originals and typed roles; a lesson references spans, never copies a book. */
export class MaterialService {
  private readonly processing = new Map<string, Promise<Material>>();
  constructor(private readonly repo: LearningRepository, private readonly courses: CourseWorkspaceService,
    private readonly documents: DocumentService) {}
  list(courseId: string): Material[] { this.course(courseId); return this.repo.materials(courseId); }
  get(courseId: string, assetId: string): Material {
    const material = this.list(courseId).find(m => m.assetId === assetId);
    if (!material) throw new LearningError("MATERIAL_NOT_FOUND", "资料不存在", 404);
    return material;
  }
  classify(courseId: string, assetId: string, role: MaterialRole): Material {
    const material = this.get(courseId, assetId);
    material.role = classifyMaterialSchema.parse({ role }).role;
    material.updatedAt = new Date().toISOString();
    this.repo.saveMaterial(material);
    return material;
  }
  async upload(courseId: string, filename: string, bytes: Buffer, role: MaterialRole, coursePublic = true): Promise<Material> {
    const course = this.course(courseId);
    classifyMaterialSchema.parse({ role });
    if (basename(filename) !== filename || /[\\/\x00-\x1f]/.test(filename) || filename.length > 200)
      throw new LearningError("INVALID_FILENAME", "文件名无效");
    const extension = extname(filename).toLowerCase();
    if (!documentExtensions.has(extension) && !mediaExtensions.has(extension))
      throw new LearningError("UNSUPPORTED_MATERIAL", "暂不支持此文件格式", 415);
    if (!bytes.length || bytes.length > MAX_MATERIAL_BYTES) throw new LearningError("MATERIAL_SIZE", "文件须为 1 字节至 100 MB", 413);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.list(courseId).find(m => m.sha256 === sha256);
    if (existing) return this.promote(existing, coursePublic);
    const directory = join(course.rootPath, "materials", "original", sha256);
    await mkdir(directory, { recursive: true });
    const path = join(directory, filename);
    const temporary = join(directory, `.upload-${randomUUID()}`);
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
    // Another request may have completed the same upload while the file was written.
    const concurrent = this.list(courseId).find(m => m.sha256 === sha256);
    if (concurrent) return this.promote(concurrent, coursePublic);
    const material: Material = {
      assetId: randomUUID(), courseId, sha256, title: filename, coursePublic,
      role: mediaExtensions.has(extension) ? "recording" : role,
      originalPath: relative(course.rootPath, path), status: "imported", updatedAt: new Date().toISOString(),
    };
    this.repo.saveMaterial(material);
    return material;
  }
  async importDirectory(courseId: string, directory: string, remoteResourceId: string): Promise<Material[]> {
    const course = this.course(courseId);
    const root = await realpath(course.rootPath);
    const source = await realpath(directory);
    if (!source.startsWith(`${root}${sep}`)) throw new LearningError("MATERIAL_PATH", "资料必须位于当前课程内");
    const imported: Material[] = [];
    const visit = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile() && documentExtensions.has(extname(entry.name).toLowerCase())) {
          const bytes = await readFile(child);
          // pku3b writes description.txt even when a resource has no description.
          if (entry.name === "description.txt" && !bytes.toString("utf8").trim()) continue;
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          let material = this.list(courseId).find(m => m.sha256 === sha256);
          if (!material) {
            material = { assetId: randomUUID(), courseId, sha256, title: entry.name, role: entry.name === "description.txt" ? "other" : "slides",
              originalPath: relative(course.rootPath, child), remoteResourceId,
              status: "imported", updatedAt: new Date().toISOString() };
            this.repo.saveMaterial(material);
          }
          this.promote(material, true);
          imported.push(await this.parse(courseId, material.assetId));
        }
      }
    };
    await visit(source);
    return imported;
  }
  parse(courseId: string, assetId: string, force = false): Promise<Material> {
    const material = this.get(courseId, assetId);
    if (!documentExtensions.has(extname(material.originalPath).toLowerCase()))
      throw new LearningError("TRANSCRIPTION_REQUIRED", "音视频资料请使用录播转写");
    const running = this.processing.get(assetId);
    if (running) return running;
    if (material.status === "ready" && !force) return Promise.resolve(material);
    const promise = this.process(material).finally(() => this.processing.delete(assetId));
    this.processing.set(assetId, promise);
    return promise;
  }
  async file(courseId: string, requestedPath: string): Promise<string> {
    const root = await realpath(this.course(courseId).rootPath);
    const file = await realpath(resolve(root, requestedPath));
    if (!file.startsWith(`${root}${sep}`) || !(await lstat(file)).isFile())
      throw new LearningError("MATERIAL_PATH", "文件必须位于当前课程内");
    // Only registered originals or generated parser images are served.
    if (!this.list(courseId).some(m => resolve(root, m.originalPath) === file) &&
      !(file.startsWith(join(root, "materials", "text", "parsed") + sep) && /\.(png|jpe?g|webp|gif)$/i.test(file)))
      throw new LearningError("MATERIAL_PATH", "文件未注册", 404);
    return file;
  }
  private async process(material: Material): Promise<Material> {
    material.status = "processing";
    delete material.error;
    this.repo.saveMaterial(material);
    try {
      const blocks = await this.documents.indexAsset(material.courseId, material.originalPath);
      if (!blocks.length) throw new Error("解析结果没有可用内容");
      material.sourcePath = blocks[0]!.sourcePath;
      material.status = "ready";
      const ids = new Set(blocks.map(block => block.blockId));
      for (const lesson of this.repo.lessons(material.courseId)) {
        if (!lesson.selections.some(selection => selection.sourcePath === material.sourcePath && selection.blockIds.some(id => !ids.has(id)))) continue;
        const previousRevision = lesson.revision;
        lesson.selections = lesson.selections.filter(selection => selection.sourcePath !== material.sourcePath);
        lesson.documentStale = Boolean(lesson.document);
        lesson.revision++;
        lesson.updatedAt = new Date().toISOString();
        this.repo.saveLesson(lesson, previousRevision);
      }
    } catch (error) {
      material.status = "failed";
      material.error = error instanceof Error ? error.message.slice(0, 500) : "解析失败";
    }
    // Preserve a role change made while a cloud request was running.
    const latest = this.get(material.courseId, material.assetId);
    material.role = latest.role;
    material.coursePublic = latest.coursePublic ?? true;
    material.updatedAt = new Date().toISOString();
    this.repo.saveMaterial(material);
    return material;
  }
  private promote(material: Material, coursePublic: boolean): Material {
    if (coursePublic && material.coursePublic === false) { material.coursePublic = true; this.repo.saveMaterial(material); }
    return material;
  }
  private course(courseId: string) {
    const course = this.courses.get(courseId);
    if (!course) throw new LearningError("COURSE_NOT_FOUND", "课程不存在", 404);
    return course;
  }
}

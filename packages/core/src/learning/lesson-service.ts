import { recordingLessonDate } from "./lesson-order.js";
import { buildLessonContext } from "./lesson-context.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CourseWorkspaceService } from "../storage/course-workspace-service.js";
import type { DocumentService } from "../documents/document-service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { lessonInputsSchema, createLessonSchema, outlineSchema, selectionsSchema, saveLearningDocumentSchema } from "./schemas.js";
import type { CreateLessonInput, Lesson, LessonOutline, SourceSelection, LessonContext, LessonArtifact } from "./types.js";
import { LearningRepository } from "./learning-repository.js";

export class LearningError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}
export class LessonService {
  constructor(private readonly repo: LearningRepository, private readonly courses: CourseWorkspaceService,
    private readonly documents: DocumentService, private readonly store: SqliteStore) {}

  list(courseId: string): Lesson[] { this.course(courseId); return this.repo.lessons(courseId); }
  get(courseId: string, lessonId: string): Lesson {
    this.course(courseId);
    const lesson = this.repo.lesson(courseId, lessonId);
    if (!lesson) throw new LearningError("LESSON_NOT_FOUND", "课次不存在", 404);
    return lesson;
  }
  create(courseId: string, raw: CreateLessonInput): Lesson {
    this.course(courseId);
    const input = createLessonSchema.parse(raw);
    const recordingIds = [...new Set(input.recordingIds ?? [])];
    for (const id of recordingIds) {
      if (!this.store.listTeachingItems(courseId, "video").some(r => r.remoteId === id && r.remoteIdStable))
        throw new LearningError("RECORDING_NOT_FOUND", "录播不属于当前课程或尚未同步");
    }
    const recordingAssetIds = [...new Set(input.recordingAssetIds ?? [])];
    for (const id of recordingAssetIds) {
      if (!this.repo.materials(courseId).some(m => m.assetId === id && m.role === "recording"))
        throw new LearningError("RECORDING_NOT_FOUND", "上传录播不属于当前课程");
    }
    const transcriptPaths = [...new Set(input.transcriptPaths ?? [])];
    transcriptPaths.forEach(path => this.transcript(courseId, path));
    const date = input.date ?? this.recordingDate(courseId, recordingIds);
    const lesson: Lesson = {
      lessonId: randomUUID(), courseId, title: input.title, date: date ?? "",
      recordingIds, recordingAssetIds, transcriptPaths, outline: null, selections: [], document: null,
      revision: 0, documentStale: false, updatedAt: new Date().toISOString(),
    };
    this.repo.saveLesson(lesson);
    return lesson;
  }
  attachTranscript(courseId: string, lessonId: string, revision: number, path: string): Lesson {
    const lesson = this.current(courseId, lessonId, revision);
    this.transcript(courseId, path);
    if (lesson.transcriptPaths.includes(path)) return lesson;
    lesson.transcriptPaths.push(path);
    lesson.outline = null;
    lesson.selections = [];
    lesson.documentStale = Boolean(lesson.document);
    return this.save(lesson);
  }
  saveOutline(courseId: string, lessonId: string, revision: number, raw: LessonOutline): Lesson {
    const lesson = this.current(courseId, lessonId, revision);
    const outline = outlineSchema.parse(raw);
    if (outline.basis === "recording" && lesson.transcriptPaths.length === 0)
      throw new LearningError("TRANSCRIPT_REQUIRED", "先完成本节录播转写，再保存录播大纲");
    lesson.outline = outline;
    lesson.selections = [];
    lesson.documentStale = Boolean(lesson.document);
    return this.save(lesson);
  }
  saveSelections(courseId: string, lessonId: string, revision: number, raw: SourceSelection[]): Lesson {
    const lesson = this.current(courseId, lessonId, revision);
    if (!lesson.outline) throw new LearningError("OUTLINE_REQUIRED", "先保存本节大纲");
    const selections = selectionsSchema.parse(raw);
    this.validateSelections(lesson, selections);
    lesson.selections = selections;
    lesson.documentStale = Boolean(lesson.document);
    return this.save(lesson);
  }
  sources(courseId: string, lessonId: string) {
    const lesson = this.get(courseId, lessonId);
    this.validateSelections(lesson, lesson.selections);
    return lesson.selections.map(selection => ({ ...selection,
      blocks: this.documents.readIndexedAsset(courseId, selection.sourcePath).filter(b => selection.blockIds.includes(b.blockId)),
    }));
  }
  saveDocument(courseId: string, lessonId: string, revision: number, markdown: string, editedBy: "user" | "agent"): Lesson {
    return this.store.db.transaction(() => this.writeDocument(courseId, lessonId, revision, markdown, editedBy)).immediate();
  }
  private writeDocument(courseId: string, lessonId: string, revision: number, markdown: string, editedBy: "user" | "agent"): Lesson {
    const lesson = this.current(courseId, lessonId, revision);
    const input = saveLearningDocumentSchema.parse({ revision, markdown });
    if (editedBy === "agent") {
      if (!lesson.outline) throw new LearningError("OUTLINE_REQUIRED", "先保存本节大纲");
      if (!lesson.selections.length) throw new LearningError("SOURCES_REQUIRED", "先选择支持讲义的资料片段");
      this.validateSelections(lesson, lesson.selections);
    }
    const sourcePath = `lessons/${lessonId}/lecture.md`;
    // Synchronous critical section: revision check, mirror write and repository update
    // cannot interleave with another edit in this process. SQLite remains canonical.
    const directory = join(this.course(courseId).rootPath, "lessons", lessonId);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.lecture-${randomUUID()}.tmp`);
    writeFileSync(temporary, `${input.markdown}\n`, { flag: "wx" });
    renameSync(temporary, join(directory, "lecture.md"));
    lesson.document = { markdown: input.markdown, sourcePath, editedBy, updatedAt: new Date().toISOString() };
    lesson.documentStale = false;
    return this.save(lesson);
  }
  saveInputs(courseId: string, lessonId: string, raw: unknown): Lesson {
    const input = lessonInputsSchema.parse(raw);
    const lesson = this.current(courseId, lessonId, input.revision);
    const materials = this.repo.materials(courseId);
    if (new Set(input.materialRefs.map(r => r.assetId)).size !== input.materialRefs.length)
      throw new LearningError("DUPLICATE_REFERENCE", "资料引用不可重复");
    for (const ref of input.materialRefs) {
      const material = materials.find(m => m.assetId === ref.assetId);
      if (!material) throw new LearningError("MATERIAL_NOT_FOUND", "资料不属于当前课程", 404);
      if (ref.blockIds.length && (!material.sourcePath || ref.blockIds.some(id => !this.documents.readIndexedAsset(courseId, material.sourcePath!).some(b => b.blockId === id))))
        throw new LearningError("SOURCE_CHANGED", "片段已过期或不属于该资料", 409);
    }
    lesson.materialRefs = input.materialRefs;
    lesson.autoPublic = input.autoPublic; lesson.focus = input.focus; lesson.excludedBlockIds = input.excludedBlockIds;
    lesson.documentStale = Boolean(lesson.document);
    return this.save(lesson);
  }
  context(courseId: string, lessonId: string, assetIds: string[] = []): LessonContext {
    const lesson = this.get(courseId, lessonId);
    const materials = this.repo.materials(courseId);
    for (const id of assetIds) {
      if (!materials.some(m => m.assetId === id && (m.coursePublic !== false || lesson.materialRefs?.some(r => r.assetId === id))))
        throw new LearningError("SOURCE_FORBIDDEN", "引用资料不在本课次或公共库中", 403);
    }
    return buildLessonContext(lesson, materials, this.documents, assetIds);
  }
  validateContext(courseId: string, snapshot: LessonContext): void {
    const lesson = this.get(courseId, snapshot.lessonId);
    const materials = this.repo.materials(courseId);
    for (const source of snapshot.sources) for (const block of source.blocks) {
      const material = materials.find(m => m.sourcePath === block.sourcePath);
      const available = lesson.transcriptPaths.includes(block.sourcePath) || (material?.status === "ready" && (material.coursePublic !== false || lesson.materialRefs?.some(r => r.assetId === material.assetId)));
      if (!available || !this.documents.readIndexedAsset(courseId, block.sourcePath).some(b => b.blockId === block.blockId && b.text === block.text))
        throw new LearningError("CONTEXT_STALE", "来源已更新，请重新打开助手", 409);
    }
  }
  saveContextDocument(courseId: string, lessonId: string, revision: number, context: LessonContext, markdown: string, blockIds: string[]): Lesson {
    saveLearningDocumentSchema.parse({ revision, markdown });
    return this.store.db.transaction(() => {
      let lesson = this.current(courseId, lessonId, revision);
      if (!blockIds.length || blockIds.some(id => !context.sources.some(s => s.blocks.some(b => b.blockId === id))))
        throw new LearningError("SOURCE_FORBIDDEN", "讲义只能引用当前上下文中的原文片段", 403);
      if (!lesson.outline) lesson = this.saveOutline(courseId, lessonId, revision, { basis: lesson.transcriptPaths.length ? "recording" : "materials", topics: [{ topicId: "lesson", title: lesson.title, summary: lesson.focus ?? "" }] });
      const grouped = new Map<string, string[]>();
      for (const source of context.sources) for (const block of source.blocks) if (blockIds.includes(block.blockId)) grouped.set(block.sourcePath, [...(grouped.get(block.sourcePath) ?? []), block.blockId]);
      lesson = this.saveSelections(courseId, lessonId, lesson.revision, [...grouped].map(([sourcePath, ids]) => ({ topicId: lesson.outline!.topics[0]!.topicId, sourcePath, blockIds: ids, reason: "本节上下文中用于生成讲义的原文" })));
      lesson.lastContext = context;
      // Persist provenance together with the document in the same transaction.
      this.repo.saveLesson(lesson, lesson.revision);
      return this.writeDocument(courseId, lessonId, lesson.revision, markdown, "agent");
    }).immediate();
  }
  saveArtifact(courseId: string, lessonId: string, revision: number, artifact: Omit<LessonArtifact, "artifactId" | "updatedAt">, context?: LessonContext): Lesson {
    const lesson = this.current(courseId, lessonId, revision);
    if (!artifact.title.trim() || artifact.title.length > 200 || !["practice", "other"].includes(artifact.kind)) throw new LearningError("INVALID_ARTIFACT", "资料标题或类型无效");
    saveLearningDocumentSchema.parse({ revision, markdown: artifact.markdown });
    if (artifact.kind === "practice") saveLearningDocumentSchema.parse({ revision, markdown: artifact.answersMarkdown });
    if (context) lesson.lastContext = context;
    lesson.artifacts = [...(lesson.artifacts ?? []), { ...artifact, artifactId: randomUUID(), updatedAt: new Date().toISOString() }];
    return this.save(lesson);
  }
  private validateSelections(lesson: Lesson, selections: SourceSelection[]) {
    const allowedPaths = new Set([
      ...this.documents.listNoteSources(lesson.courseId).filter(s => s.kind === "material" && !this.repo.materials(lesson.courseId).some(m => m.sourcePath === s.sourcePath && m.coursePublic === false && !lesson.materialRefs?.some(r => r.assetId === m.assetId))).map(s => s.sourcePath),
      ...lesson.transcriptPaths,
    ]);
    for (const selection of selections) {
      if (!lesson.outline?.topics.some(t => t.topicId === selection.topicId))
        throw new LearningError("TOPIC_NOT_FOUND", "选材必须对应本节大纲中的主题");
      if (!allowedPaths.has(selection.sourcePath)) throw new LearningError("SOURCE_FORBIDDEN", "资料不在本课次可用范围内");
      const ids = new Set(this.documents.readIndexedAsset(lesson.courseId, selection.sourcePath).map(b => b.blockId));
      if (selection.blockIds.some(id => !ids.has(id))) throw new LearningError("SOURCE_CHANGED", "选材已过期或文本块不属于该资料，请重新选材", 409);
    }
  }
  private transcript(courseId: string, path: string) {
    if (!this.documents.listNoteSources(courseId).some(s => s.sourcePath === path && s.kind === "recording-transcript"))
      throw new LearningError("TRANSCRIPT_NOT_FOUND", "转写稿必须来自当前课程的已索引录播", 404);
  }
  private recordingDate(courseId: string, recordingIds: string[]): string | undefined {
    const dates = this.store.listTeachingItems(courseId, "video")
      .filter(recording => recordingIds.includes(recording.remoteId) && recording.remoteIdStable)
      .flatMap(recording => { const date = recordingLessonDate(recording); return date ? [date] : []; })
      .sort();
    return dates[0];
  }
  private current(courseId: string, lessonId: string, revision: number) {
    const lesson = this.get(courseId, lessonId);
    if (lesson.revision !== revision) throw new LearningError("REVISION_CONFLICT", "课次已更新，请重新读取后再保存", 409);
    return lesson;
  }
  private save(lesson: Lesson): Lesson {
    lesson.revision++;
    lesson.updatedAt = new Date().toISOString();
    this.repo.saveLesson(lesson, lesson.revision - 1);
    return lesson;
  }
  private course(courseId: string) {
    const course = this.courses.get(courseId);
    if (!course) throw new LearningError("COURSE_NOT_FOUND", "课程不存在", 404);
    return course;
  }
}

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LessonService } from "../learning/lesson-service.js";
import type { MaterialService } from "../materials/material-service.js";
import type { RecordingService } from "../recordings/recording-service.js";
import type { TeachingNetworkService } from "../integrations/pku3b/teaching-network-service.js";
import type { DocumentService } from "../documents/document-service.js";
import { materialRoles } from "../learning/types.js";

export const learningToolNames = ["list_lessons", "get_lesson", "create_lesson", "list_materials", "classify_material",
  "parse_material", "transcribe_uploaded_recording", "sync_course", "list_recordings", "transcribe_lesson_recording", "attach_lesson_transcript",
  "read_source_range", "save_lesson_outline", "save_lesson_selections", "read_lesson_sources", "save_lesson_document"] as const;
export interface LearningToolsServices {
  lessons: LessonService; materials: MaterialService; recordings: RecordingService;
  teachingNetwork: TeachingNetworkService; documents: DocumentService;
}
const id = Type.String({ minLength: 1, maxLength: 200 });
const path = Type.String({ minLength: 1, maxLength: 1000 });
const revision = Type.Integer({ minimum: 0 });
const scope = { lessonId: id, revision };

/** Domain tool definitions live beside the workflows, independently of Pi session lifecycle. */
export function createLearningTools(courseId: string, services: LearningToolsServices): ToolDefinition[] {
  const { lessons, materials, recordings, teachingNetwork, documents } = services;
  async function result<T>(operation: () => T | Promise<T>) {
    let envelope: unknown;
    try { envelope = { ok: true, data: await operation() }; }
    catch (error) { envelope = { ok: false, error: {
      code: error && typeof error === "object" && "code" in error ? error.code : "LEARNING_FAILED",
      message: error instanceof Error ? error.message : "学习任务失败", retryable: false,
    } }; }
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], details: { envelope } };
  }
  return [
    defineTool({ name: "list_lessons", label: "课次", description: "List this course's lessons with saved progress and document revisions.", parameters: Type.Object({}),
      execute: async () => result(() => lessons.list(courseId)) }),
    defineTool({ name: "get_lesson", label: "读取课次", description: "Read outline, selections, current document and revision before modifying a lesson.", parameters: Type.Object({ lessonId: id }),
      execute: async (_, p) => result(() => lessons.get(courseId, p.lessonId)) }),
    defineTool({ name: "create_lesson", label: "建立课次", description: "Create a lesson from selected recording IDs or indexed transcript paths in this course.",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), date: Type.Optional(Type.String()), recordingIds: Type.Optional(Type.Array(id)), recordingAssetIds: Type.Optional(Type.Array(id)), transcriptPaths: Type.Optional(Type.Array(path)) }),
      execute: async (_, p) => result(() => lessons.create(courseId, p)) }),
    defineTool({ name: "list_materials", label: "课程资料库", description: "List uploaded/downloaded materials, their roles, parsing status and indexed source paths.", parameters: Type.Object({}),
      execute: async () => result(() => materials.list(courseId)) }),
    defineTool({ name: "classify_material", label: "资料分类", description: "Assign textbook, supplement, slides, recording or other role to a course asset.",
      parameters: Type.Object({ assetId: id, role: Type.Union(materialRoles.map(role => Type.Literal(role))) }),
      execute: async (_, p) => result(() => materials.classify(courseId, p.assetId, p.role)) }),
    defineTool({ name: "parse_material", label: "解析资料", description: "Parse a registered document through the cloud provider and index it; reports ready or failed.", parameters: Type.Object({ assetId: id }),
      execute: async (_, p) => result(() => materials.parse(courseId, p.assetId)) }),
    defineTool({ name: "transcribe_uploaded_recording", label: "上传录播转写", description: "Transcribe a registered uploaded audio/video asset and attach its transcript to the lesson. Returns the updated lesson or authentication/error job state.",
      parameters: Type.Object({ ...scope, assetId: id }),
      execute: async (_, p) => result(async () => {
        const lesson = lessons.get(courseId, p.lessonId);
        if (lesson.revision !== p.revision) throw new Error("课次已更新，请重新读取");
        if (!lesson.recordingAssetIds.includes(p.assetId)) throw new Error("上传录播未关联本课次");
        const asset = materials.get(courseId, p.assetId);
        if (asset.role !== "recording") throw new Error("请选择录播或音频资料");
        const job = await recordings.transcribeFile(courseId, await materials.file(courseId, asset.originalPath), asset.title);
        if (job.status !== "completed" || !job.message) return job;
        return lessons.attachTranscript(courseId, p.lessonId, p.revision, job.message);
      }) }),
    defineTool({ name: "sync_course", label: "同步课程", description: "Refresh teaching-network resources and recordings. Returns terminal or authentication-required job state.", parameters: Type.Object({}),
      execute: async () => result(async () => {
        const content = await teachingNetwork.wait(teachingNetwork.syncCourseContent(courseId).jobId);
        if (content.status !== "completed") return { content };
        const overview = await teachingNetwork.wait(teachingNetwork.syncCourseOverview(courseId).jobId);
        return { content, overview };
      }) }),
    defineTool({ name: "list_recordings", label: "录播清单", description: "List synchronized recordings for this course.", parameters: Type.Object({}),
      execute: async () => result(() => teachingNetwork.listTeachingItems(courseId, "video")) }),
    defineTool({ name: "transcribe_lesson_recording", label: "录播转写", description: "Transcribe a recording already bound to this lesson. Returns a job; after completion attach its transcript path using attach_lesson_transcript.",
      parameters: Type.Object({ lessonId: id, recordingId: id }),
      execute: async (_, p) => result(async () => {
        if (!lessons.get(courseId, p.lessonId).recordingIds.includes(p.recordingId)) throw new Error("录播未关联本课次");
        return recordings.wait(recordings.transcribe(courseId, p.recordingId).jobId);
      }) }),
    defineTool({ name: "attach_lesson_transcript", label: "关联转写稿", description: "Attach an indexed transcript to a lesson. This invalidates a previous outline and selections.", parameters: Type.Object({ ...scope, sourcePath: path }),
      execute: async (_, p) => result(() => lessons.attachTranscript(courseId, p.lessonId, p.revision, p.sourcePath)) }),
    defineTool({ name: "read_source_range", label: "读取资料片段", description: "Read an indexed source by zero-based block offset/count, optionally restricted to original PDF pages. Returns total and stable block IDs for selecting only relevant content.",
      parameters: Type.Object({ sourcePath: path, offset: Type.Optional(Type.Integer({ minimum: 0 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 80 })), pageFrom: Type.Optional(Type.Integer({ minimum: 1 })), pageTo: Type.Optional(Type.Integer({ minimum: 1 })) }),
      execute: async (_, p) => result(() => {
        const blocks = documents.readIndexedAsset(courseId, p.sourcePath).filter(b =>
          (p.pageFrom === undefined || (b.page !== undefined && b.page >= p.pageFrom)) &&
          (p.pageTo === undefined || (b.page !== undefined && b.page <= p.pageTo)));
        return { total: blocks.length, blocks: blocks.slice(p.offset ?? 0, (p.offset ?? 0) + (p.count ?? 40)) };
      }) }),
    defineTool({ name: "save_lesson_outline", label: "保存本节大纲", description: "Save the actual lecture scope BEFORE selecting textbook/slide passages. Use unique topic IDs and source timestamps. Invalidates old selections.",
      parameters: Type.Object({ ...scope, outline: Type.Object({ basis: Type.Union([Type.Literal("recording"), Type.Literal("materials"), Type.Literal("manual")]),
        topics: Type.Array(Type.Object({ topicId: id, title: Type.String(), summary: Type.String(), startSeconds: Type.Optional(Type.Number()), endSeconds: Type.Optional(Type.Number()) })) }) }),
      execute: async (_, p) => result(() => lessons.saveOutline(courseId, p.lessonId, p.revision, p.outline)) }),
    defineTool({ name: "save_lesson_selections", label: "保存选材", description: "Map outline topics to exact block IDs from course materials or this lesson's transcripts, with selection reasons. Do not include irrelevant entire chapters.",
      parameters: Type.Object({ ...scope, selections: Type.Array(Type.Object({ topicId: id, sourcePath: path, blockIds: Type.Array(id), reason: Type.String() })) }),
      execute: async (_, p) => result(() => lessons.saveSelections(courseId, p.lessonId, p.revision, p.selections)) }),
    defineTool({ name: "read_lesson_sources", label: "读取已选内容", description: "Read and validate the selected source passages for composing the lesson document.", parameters: Type.Object({ lessonId: id }),
      execute: async (_, p) => result(() => lessons.sources(courseId, p.lessonId)) }),
    defineTool({ name: "save_lesson_document", label: "保存本节讲义", description: "Save a readable Markdown lesson document after outline and source selection. Revision conflict means the user edited the lesson: reread and reconcile, never blindly overwrite.",
      parameters: Type.Object({ ...scope, markdown: Type.String({ minLength: 1, maxLength: 1_000_000 }) }),
      execute: async (_, p) => result(() => lessons.saveDocument(courseId, p.lessonId, p.revision, p.markdown, "agent")) }),
  ];
}

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LearningError, type LessonService } from "../learning/lesson-service.js";
import type { LessonContext } from "../learning/types.js";

/** Closed tool set: no course search, arbitrary asset reader, filesystem, ASR or other lessons. */
export function createLessonTools(courseId: string, lessons: LessonService, snapshot: LessonContext, assetIds: string[]): ToolDefinition[] {
  let revision = snapshot.revision;
  const assertCurrent = () => {
    const current = lessons.get(courseId, snapshot.lessonId);
    if (current.revision !== revision) throw new LearningError("CONTEXT_STALE", "课次已更新，请重新打开助手以更新上下文", 409);
    lessons.validateContext(courseId, snapshot);
    return current;
  };
  const result = async (operation: () => unknown) => {
    let envelope: unknown;
    try { assertCurrent(); envelope = { ok: true, data: operation() }; }
    catch (error) { envelope = { ok: false, error: { code: (error as { code?: string }).code ?? "LESSON_TOOL_FAILED", message: error instanceof Error ? error.message : "课次操作失败" } }; }
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], details: { envelope } };
  };
  return [
    defineTool({ name: "read_lesson_context", label: "读取本节上下文", description: "Read the immutable, bounded sources, warnings and current lesson document. Only these blocks may be used as source evidence.", parameters: Type.Object({}), execute: async () => result(() => ({ context: snapshot, lesson: (() => { const l = assertCurrent(); return { title: l.title, outline: l.outline, document: l.document, artifacts: (l.artifacts ?? []).map(a => ({ artifactId: a.artifactId, kind: a.kind, title: a.title })) }; })() })) }),
    defineTool({ name: "save_lesson_lecture", label: "保存本节讲义", description: "Save the lecture to this lesson with cited block IDs from the context. Preserve existing manual edits. Stale context requires a new session; never retry blindly.", parameters: Type.Object({ markdown: Type.String({ minLength: 1, maxLength: 1_000_000 }), blockIds: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }) }), execute: async (_, p) => result(() => {
      const lesson = lessons.saveContextDocument(courseId, snapshot.lessonId, revision, snapshot, p.markdown, p.blockIds); revision = lesson.revision; return { lessonId: lesson.lessonId, revision, sourcePath: lesson.document!.sourcePath };
    }) }),
    defineTool({ name: "save_lesson_artifact", label: "保存本节练习或资料", description: "Save a new lesson-linked practice set or other document. Practice requires separate answersMarkdown. Does not submit work.", parameters: Type.Object({ kind: Type.Union([Type.Literal("practice"), Type.Literal("other")]), title: Type.String({ minLength: 1, maxLength: 200 }), markdown: Type.String({ minLength: 1, maxLength: 1_000_000 }), answersMarkdown: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000_000 })) }), execute: async (_, p) => result(() => {
      const lesson = lessons.saveArtifact(courseId, snapshot.lessonId, revision, { ...p, contextId: snapshot.contextId }, snapshot); revision = lesson.revision; return { lessonId: lesson.lessonId, revision, artifactId: lesson.artifacts!.at(-1)!.artifactId };
    }) }),
  ];
}

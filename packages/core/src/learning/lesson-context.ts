import { createHash } from "node:crypto";
import type { DocumentService } from "../documents/document-service.js";
import type { CourseDocumentBlock } from "../domain/types.js";
import type { Lesson, LessonContext, Material } from "./types.js";

function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]+/gu) ?? [];
  return new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 1
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]));
}
/** Deterministic, bounded lexical retrieval within public assets only. No model sees the full books. */
export function buildLessonContext(lesson: Lesson, materials: Material[], documents: DocumentService, assetIds: string[] = []): LessonContext {
  const context: LessonContext = { contextId: "", lessonId: lesson.lessonId, revision: lesson.revision,
    query: [lesson.title, lesson.focus, ...(lesson.outline?.topics.map(t => `${t.title} ${t.summary}`) ?? [])].filter(Boolean).join(" "),
    sources: [], warnings: [], characters: 0 };
  const excluded = new Set(lesson.excludedBlockIds ?? []);
  const seen = new Set<string>();
  const read = (path: string) => documents.readIndexedAsset(lesson.courseId, path);
  const append = (title: string, origin: LessonContext["sources"][number]["origin"], blocks: CourseDocumentBlock[], budget: number) => {
    const included: CourseDocumentBlock[] = []; let used = 0; let omitted = 0;
    for (const block of blocks) {
      if (seen.has(block.blockId) || excluded.has(block.blockId)) continue;
      if (used + block.text.length > budget || context.characters + block.text.length > 60_000) { omitted++; continue; }
      included.push(block); seen.add(block.blockId); used += block.text.length; context.characters += block.text.length;
    }
    if (included.length) context.sources.push({ title, origin, blocks: included });
    if (omitted) context.warnings.push(`${title}：${omitted} 个文本块超出上下文预算，请缩小范围后重试。`);
  };
  // Explicit lesson ranges and @ references are prioritized over automatic public retrieval.
  const refs = [...(lesson.materialRefs ?? [])];
  for (const id of assetIds) if (!refs.some(ref => ref.assetId === id)) refs.push({ assetId: id, blockIds: [] });
  for (const ref of refs) {
    const material = materials.find(m => m.assetId === ref.assetId);
    if (!material?.sourcePath || material.status !== "ready") { context.warnings.push(`${material?.title ?? ref.assetId}：尚未解析，未进入上下文。`); continue; }
    let blocks = read(material.sourcePath);
    if (ref.blockIds.length) {
      if (ref.blockIds.some(id => !blocks.some(block => block.blockId === id))) {
        context.warnings.push(`${material.title}：所选片段已过期，请重新选择。`); continue;
      }
      blocks = blocks.filter(b => ref.blockIds.includes(b.blockId));
    }
    append(material.title, assetIds.includes(ref.assetId) ? "mention" : "lesson", blocks, 30_000);
  }
  for (const path of lesson.transcriptPaths) append(path, "transcript", read(path), 25_000);
  if ((lesson.recordingIds.length || lesson.recordingAssetIds.length || refs.some(r => materials.find(m => m.assetId === r.assetId)?.role === "recording")) && !lesson.transcriptPaths.length)
    context.warnings.push("关联录播尚无转写稿，当前上下文不包含录播内容。");
  if (!lesson.focus?.trim() && !lesson.outline?.topics.length) context.query += " " + context.sources.flatMap(s => s.blocks.map(b => b.text)).join(" ").slice(0, 1200);
  if (lesson.autoPublic !== false) {
    const queryTerms = terms(context.query);
    const candidates = materials.filter(m => m.coursePublic !== false && m.status === "ready" && m.sourcePath && !refs.some(r => r.assetId === m.assetId))
      .flatMap(m => {
        const blocks = read(m.sourcePath!);
        return blocks.map((block, index) => {
          const passage = [block];
          // A matching heading needs its explanatory paragraphs, but never the next chapter.
          if (block.contentType === "heading") for (const next of blocks.slice(index + 1, index + 4)) {
            if (next.contentType === "heading") break;
            passage.push(next);
          }
          return { block, passage, title: m.title, score: [...queryTerms].filter(term => block.text.toLowerCase().includes(term)).length };
        });
      });
    const ranked = candidates.filter(c => c.score > 0 && !excluded.has(c.block.blockId)).sort((a, b) => b.score - a.score || a.block.blockId.localeCompare(b.block.blockId)).slice(0, 16);
    const publicStart = context.characters;
    for (const match of ranked) append(match.title, "public", match.passage, Math.min(8_000, Math.max(0, 12_000 - (context.characters - publicStart))));
    if (!ranked.length && !refs.some(r => materials.some(m => m.assetId === r.assetId && m.coursePublic !== false))) context.warnings.push("公共库未找到相关片段；可填写本节范围或手动选择教材片段。");
  }
  if (!context.sources.length) context.warnings.push("当前没有可用原文，请先加入资料或选择教材片段。");
  context.contextId = createHash("sha256").update(JSON.stringify(context)).digest("hex");
  return context;
}

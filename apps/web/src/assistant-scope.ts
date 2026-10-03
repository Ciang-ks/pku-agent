import type { Lesson } from "./types";
export interface AssistantScope {
  key: string;
  kind: "course" | "lesson" | "lecture-notes";
  label: string;
  lessonId?: string;
  sourcePaths?: string[];
}
export interface AssistantRequest { id: number; prompt: string; autoSend: boolean }
export function pageAssistantScope(courseId: string, courseName: string, page: string, lesson?: Pick<Lesson, "lessonId" | "title">): AssistantScope {
  if (page === "lessons" && lesson) return { key: `${courseId}:lesson:${lesson.lessonId}`, kind: "lesson", lessonId: lesson.lessonId, label: lesson.title };
  return { key: `${courseId}:course`, kind: "course", label: courseName };
}
export function noteAssistantScope(courseId: string, sourcePaths: string[]): AssistantScope {
  const paths = [...new Set(sourcePaths)].sort();
  return { key: `${courseId}:notes:${JSON.stringify(paths)}`, kind: "lecture-notes", label: "独立笔记 · 已选素材", sourcePaths: paths };
}

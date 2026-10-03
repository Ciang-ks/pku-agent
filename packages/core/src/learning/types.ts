/** Shared, transport-safe contracts for the course learning workspace. */
export const materialRoles = ["textbook", "supplement", "slides", "recording", "other"] as const;
export type MaterialRole = (typeof materialRoles)[number];
export interface Material {
  assetId: string;
  courseId: string;
  title: string;
  role: MaterialRole;
  originalPath: string;
  sourcePath?: string;
  remoteResourceId?: string;
  sha256: string;
  /** Missing on legacy assets means public. Originals remain deduplicated per course. */
  coursePublic?: boolean;
  status: "imported" | "processing" | "ready" | "failed";
  error?: string;
  updatedAt: string;
}
export interface OutlineTopic {
  topicId: string;
  title: string;
  summary: string;
  startSeconds?: number | undefined;
  endSeconds?: number | undefined;
}
export interface LessonOutline {
  basis: "recording" | "materials" | "manual";
  topics: OutlineTopic[];
}
export interface SourceSelection {
  topicId: string;
  sourcePath: string;
  blockIds: string[];
  reason: string;
}
export interface LearningDocument {
  markdown: string;
  sourcePath: string;
  updatedAt: string;
  editedBy: "user" | "agent";
}
export interface Lesson {
  lessonId: string;
  courseId: string;
  title: string;
  date: string;
  recordingIds: string[];
  recordingAssetIds: string[];
  transcriptPaths: string[];
  materialRefs?: LessonMaterialRef[];
  autoPublic?: boolean;
  focus?: string;
  excludedBlockIds?: string[];
  artifacts?: LessonArtifact[];
  lastContext?: LessonContext;
  outline: LessonOutline | null;
  selections: SourceSelection[];
  document: LearningDocument | null;
  /** Revisions prevent an agent run from overwriting a concurrent user edit. */
  revision: number;
  documentStale: boolean;
  updatedAt: string;
}
export interface CreateLessonInput {
  title: string;
  date?: string;
  recordingIds?: string[];
  recordingAssetIds?: string[];
  transcriptPaths?: string[];
}

export interface LessonMaterialRef { assetId: string; blockIds: string[] }
export interface LessonArtifact {
  artifactId: string; kind: "practice" | "other"; title: string;
  markdown: string; answersMarkdown?: string; updatedAt: string; contextId: string;
}
export interface LessonContext {
  contextId: string; lessonId: string; revision: number; query: string;
  sources: { title: string; origin: "lesson" | "public" | "transcript" | "mention";
    blocks: import("../domain/types.js").CourseDocumentBlock[] }[];
  warnings: string[]; characters: number;
}

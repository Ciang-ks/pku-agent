import type { RemoteResourceKind, ToolResult } from "../../domain/types.js";

/** Versioned, transport-independent contract. IDs always come from Blackboard. */
export interface TeachingCourseRef {
  remoteCourseId: string;
  title: string;
  isCurrent: boolean;
}
export interface TeachingContent {
  remoteResourceId: string;
  parentRemoteId?: string;
  title: string;
  kind: RemoteResourceKind;
  sourceUrl: string;
  descriptions: string[];
  attachments: { name: string; url: string }[];
}
export interface TeachingContentSnapshot {
  schemaVersion: 1;
  remoteCourseId: string;
  fetchedAt: string;
  contents: TeachingContent[];
}
export interface TeachingReadOptions { force?: boolean; otp?: string }
export interface StructuredTeachingAccess {
  listCourses(options?: TeachingReadOptions): Promise<ToolResult<TeachingCourseRef[]>>;
  readCourse(courseId: string, options?: TeachingReadOptions): Promise<ToolResult<TeachingContentSnapshot>>;
  downloadResource(content: TeachingContent, courseId: string, directory: string, options?: TeachingReadOptions): Promise<ToolResult<{ version: string }>>;
}

export class TeachingAccessError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

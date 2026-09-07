export const jobStatuses = [
  "queued",
  "running",
  "waiting_for_auth",
  "waiting_for_review",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const authStates = [
  "ready",
  "needs_password",
  "needs_otp",
  "expired",
  "error",
] as const;

export type AuthState = (typeof authStates)[number];

export type TreeholeAuthState = AuthState;

export const remoteResourceKinds = [
  "section",
  "folder",
  "document",
  "file",
  "assignment",
  "announcement",
  "video",
  "audio",
  "quiz",
  "unknown",
] as const;

export type RemoteResourceKind = (typeof remoteResourceKinds)[number];

export interface CourseWorkspace {
  courseId: string;
  name: string;
  teacher: string;
  term: string;
  remoteCourseId?: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCourseInput {
  name: string;
  teacher: string;
  term: string;
  remoteCourseId?: string;
}

export const candidateStatuses = ["followed", "rejected"] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

export const candidateReviewConfidences = ["low", "medium", "high"] as const;
export type CandidateReviewConfidence = (typeof candidateReviewConfidences)[number];

export interface CourseCandidateReview {
  teachingClarity: number;
  contentValue: number;
  grading: number;
  workload: number;
  predictability: number;
  overall: number;
  confidence: CandidateReviewConfidence;
  summary: string;
  positives: string[];
  negatives: string[];
  relatedPids: string[];
  reviewedAt: string;
}

export interface CourseCandidate {
  candidateId: string;
  name: string;
  teacher: string;
  aliases: string[];
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
  review?: CourseCandidateReview;
}

export interface CreateCourseCandidateInput {
  name: string;
  teacher: string;
  aliases?: string[];
}

export interface TreeholeComment {
  commentId: string;
  text: string;
  createdAt?: string;
}

export interface TreeholePost {
  pid: string;
  text: string;
  commentCount: number;
  comments: TreeholeComment[];
}

export interface TreeholeSearchResult {
  keyword: string;
  posts: TreeholePost[];
}

export interface TreeholeEvidence {
  query: string;
  keywords: string[];
  posts: TreeholePost[];
}

export interface RemoteResourceRef {
  resourceId: string;
  courseId: string;
  provider: "pku3b";
  remoteCourseId: string;
  remoteResourceId: string;
  kind: RemoteResourceKind;
  title: string;
  parentId?: string;
  hasDetails: boolean;
  isImported: boolean;
  localPath?: string;
  updatedAt: string;
}

export interface RemoteContentNode extends RemoteResourceRef {
  children: RemoteContentNode[];
}

export interface IntegrationState {
  provider: "pku3b";
  authState: AuthState;
  detail?: string;
  version?: string;
  updatedAt: string;
}

export const teachingItemKinds = ["announcement", "assignment", "video", "grade"] as const;
export type TeachingItemKind = (typeof teachingItemKinds)[number];

export interface TeachingItem {
  itemId: string;
  courseId: string;
  provider: "pku3b";
  remoteId: string;
  remoteIdStable: boolean;
  kind: TeachingItemKind;
  title: string;
  courseLabel: string;
  occurredAt?: string;
  occurredText?: string;
  dueAt?: string;
  dueText?: string;
  completed?: boolean;
  score?: number;
  possibleScore?: number;
  attachmentCount?: number;
  updatedAt: string;
}

export interface CourseTimelineItem {
  courseId: string;
  courseName: string;
  teacher: string;
  item?: TeachingItem;
  resource?: RemoteResourceRef;
  sortAt: string;
}

export interface TeachingNetworkAnnouncementDetail {
  courseId: string;
  announcementId: string;
  courseLabel: string;
  title: string;
  publishedAt?: string;
  descriptions: string[];
  attachments: string[];
}

export interface ParsedDocumentBlock {
  heading?: string;
  page?: number;
  contentType: "heading" | "paragraph";
  text: string;
}

export interface ParsedDocument {
  title: string;
  blocks: ParsedDocumentBlock[];
}

export interface DocumentParserProvider {
  parse(input: { filePath: string; content: string }): Promise<ParsedDocument>;
}

export interface PdfRenderer {
  readonly id: string;
  render(input: { markdownPath: string; outputPath: string }): Promise<void>;
}

export interface EmbeddingProvider {
  readonly id: string;
  isAvailable(): boolean;
  embed(input: string[]): Promise<number[][]>;
}

export interface TranscriptionInput {
  filePath: string;
  prompt?: string;
  keywords?: string[];
  languages?: string[];
}

export interface TranscriptionProvider {
  readonly id: string;
  isAvailable(): boolean;
  transcribe(input: TranscriptionInput): Promise<{ text: string }>;
}

export interface CourseDocumentBlock {
  blockId: string;
  courseId: string;
  sourcePath: string;
  title: string;
  page?: number;
  contentType: "heading" | "paragraph";
  text: string;
  updatedAt: string;
}

export interface AssignmentApproval {
  approvalId: string;
  courseId: string;
  assignmentRemoteId: string;
  filePath: string;
  sha256: string;
  expiresAt: string;
}

export interface DocumentSearchResult {
  block: CourseDocumentBlock;
  score: number;
}

export type CourseNoteSourceKind = "material" | "recording-transcript";

export interface CourseNoteSource {
  sourcePath: string;
  title: string;
  kind: CourseNoteSourceKind;
  blockCount: number;
  updatedAt: string;
}

export interface PracticeSetSummary {
  name: string;
  questionsPath: string;
  answersPath: string;
  updatedAt: string;
}

export interface PracticeSet extends PracticeSetSummary {
  questionsMarkdown: string;
  answersMarkdown: string;
}

export type TeachingNetworkJobContext =
  | {
      operation: "sync-course-content";
      courseId: string;
      force: boolean;
    }
  | {
      operation: "import-course-resource";
      courseId: string;
      resourceId: string;
    }
  | {
      operation: "sync-course-overview";
      courseId: string;
      force: boolean;
    }
  | {
      operation: "download-assignment";
      courseId: string;
      assignmentId: string;
    };

export type RecordingJobContext = {
  operation: "transcribe-recording";
  courseId: string;
  recordingId: string;
};

export type AssignmentJobContext = {
  operation: "submit-assignment";
  courseId: string;
  assignmentId: string;
  approvalId: string;
};

export type JobContext = TeachingNetworkJobContext | RecordingJobContext | AssignmentJobContext;

export interface JobRecord {
  jobId: string;
  kind: string;
  status: JobStatus;
  progress: number;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
  requiresAction?: string;
  createdAt: string;
  updatedAt: string;
}

export type ToolResult<T> =
  | { ok: true; data: T; jobId?: string }
  | {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
      requiresAction?: string;
    };

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "missing" | "unsupported";
  detail: string;
  version?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

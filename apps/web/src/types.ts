export interface CourseWorkspace {
  courseId: string;
  name: string;
  teacher: string;
  term: string;
  remoteCourseId?: string;
  createdAt: string;
  updatedAt: string;
  rootPath: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "missing" | "unsupported";
  detail: string;
  version?: string;
}

export interface JobRecord {
  jobId: string;
  kind: string;
  status:
    | "queued"
    | "running"
    | "waiting_for_auth"
    | "waiting_for_review"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number;
  message?: string;
  errorCode?: string;
  errorMessage?: string;
  requiresAction?: string;
  createdAt: string;
  updatedAt: string;
}

export type RemoteResourceKind =
  | "section"
  | "folder"
  | "document"
  | "file"
  | "assignment"
  | "announcement"
  | "video"
  | "audio"
  | "quiz"
  | "unknown";

export interface RemoteResource {
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

export interface RemoteContentNode extends RemoteResource {
  children: RemoteContentNode[];
}

export interface IntegrationState {
  provider: "pku3b";
  authState: "ready" | "needs_password" | "needs_otp" | "expired" | "error";
  detail?: string;
  version?: string;
  updatedAt: string;
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

export type TeachingItemKind = "announcement" | "assignment" | "video" | "grade";

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
  resource?: RemoteResource;
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

export interface AssignmentApproval {
  approvalId: string;
  courseId: string;
  assignmentRemoteId: string;
  filePath: string;
  sha256: string;
  expiresAt: string;
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

export interface AgentSessionInfo {
  sessionId: string;
  courseId: string;
  tools: string[];
  modelAvailable: boolean;
  persistent: boolean;
  name?: string;
  messages: AgentChatMessage[];
  modelFallbackMessage?: string;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AgentSessionSummary {
  sessionId: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage?: string;
}

export interface AgentStreamEvent {
  type: "ready" | "text_delta" | "tool_start" | "tool_end" | "complete" | "error";
  data: Record<string, unknown>;
}

export type CandidateStatus = "followed" | "rejected";
export type CandidateReviewConfidence = "low" | "medium" | "high";

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

export interface TreeholeEvidence {
  query: string;
  keywords: string[];
  posts: TreeholePost[];
}

export interface TreeholeAuthStatus {
  provider: "treehole";
  authState: "ready" | "needs_password" | "needs_otp" | "expired" | "error";
  detail?: string;
  updatedAt: string;
}

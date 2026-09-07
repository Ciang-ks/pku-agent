import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  defineTool,
  type AgentToolResult,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type SessionInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { courseSkillNames, ensureCourseSkills, type CourseSkillName } from "./course-skills.js";
import { CourseCandidateError, CourseCandidateService } from "../candidates/course-candidate-service.js";
import type { CourseDocumentBlock, DocumentSearchResult, JobRecord, RemoteResourceRef, ToolResult } from "../domain/types.js";
import { DocumentService, DocumentServiceError } from "../documents/document-service.js";
import { TeachingNetworkError, TeachingNetworkService } from "../integrations/pku3b/teaching-network-service.js";
import { JobManager } from "../jobs/job-manager.js";
import { CourseWorkspaceError, CourseWorkspaceService } from "../storage/course-workspace-service.js";
import { SqliteStore } from "../storage/sqlite-store.js";

export const piToolNames = [
  "search_course",
  "read_course_asset",
  "list_course_resources",
  "get_course_resource",
  "import_course_resource",
  "review_course_candidate",
  "save_lecture_note",
  "save_assignment_draft",
  "save_practice_set",
  "get_job_status",
  "ask_treehole",
] as const;

export type PiToolName = (typeof piToolNames)[number];
export { courseSkillNames } from "./course-skills.js";

export interface SearchCourseInput {
  courseId: string;
  query: string;
  limit?: number;
}

export interface ReadCourseAssetInput {
  courseId: string;
  sourcePath: string;
}

export interface CourseResourceInput {
  courseId: string;
  resourceId: string;
}

export interface SaveLectureNoteInput {
  courseId: string;
  noteName: string;
  markdown: string;
}

export interface SaveAssignmentDraftInput {
  courseId: string;
  assignmentId: string;
  markdown: string;
}

export interface SavePracticeSetInput {
  courseId: string;
  practiceName: string;
  questionsMarkdown: string;
  answersMarkdown: string;
}

export interface GetJobStatusInput {
  courseId: string;
  jobId: string;
}

export interface ReviewCourseCandidateInput {
  candidateId: string;
  keywords?: string[];
}

export interface AskTreeholeInput {
  query: string;
  keywords?: string[];
}

export interface PiAgentServiceOptions {
  courses: CourseWorkspaceService;
  documents: DocumentService;
  candidates: CourseCandidateService;
  teachingNetwork: TeachingNetworkService;
  jobs: JobManager;
  store: SqliteStore;
  agentDir: string;
  sessionDir: string;
  sessionFactory?: PiSessionFactory;
}

export interface CourseSessionOptions {
  /** A name opts into JSONL persistence; unnamed sessions remain in memory. */
  name?: string;
}

export interface LectureNotesSessionOptions {
  sourcePaths: string[];
}

export interface CourseAgentSessionSummary {
  sessionId: string;
  name?: string;
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
  firstMessage?: string;
}

export type PiSessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<CreateAgentSessionResult>;

interface PiToolDetails {
  envelope: ToolResult<unknown>;
}

interface ScopedSessionOptions {
  toolNames: readonly PiToolName[];
  skillNames: readonly CourseSkillName[];
  allowedReadPaths?: ReadonlySet<string>;
  allowLiveTreehole?: boolean;
  systemPrompt?: string;
}

/**
 * A narrow application facade for Pi. It deliberately contains no shell or
 * arbitrary filesystem capability; generated content goes through course storage.
 */
export class PiAgentService {
  private readonly sessionFactory: PiSessionFactory;

  constructor(private readonly options: PiAgentServiceOptions) {
    this.sessionFactory = options.sessionFactory ?? createAgentSession;
  }

  toolNames(): readonly PiToolName[] {
    return piToolNames;
  }

  skillNames(): readonly string[] {
    return courseSkillNames;
  }

  async searchCourse(input: SearchCourseInput): Promise<ToolResult<DocumentSearchResult[]>> {
    return this.run(() => this.options.documents.search(input.courseId, input.query, input.limit));
  }

  async readCourseAsset(input: ReadCourseAssetInput): Promise<ToolResult<CourseDocumentBlock[]>> {
    return this.run(() => this.options.documents.readIndexedAsset(input.courseId, input.sourcePath));
  }

  async listCourseResources(courseId: string): Promise<ToolResult<RemoteResourceRef[]>> {
    return this.run(() => {
      this.requireCourse(courseId);
      return this.options.teachingNetwork.listResources(courseId);
    });
  }

  async getCourseResource(input: CourseResourceInput): Promise<ToolResult<RemoteResourceRef>> {
    return this.run(() => {
      this.requireCourse(input.courseId);
      const resource = this.options.store.getRemoteResource(input.resourceId);
      if (!resource || resource.courseId !== input.courseId) {
        throw new PiAgentError("RESOURCE_NOT_FOUND", "Course resource not found.", 404);
      }
      return resource;
    });
  }

  async importCourseResource(input: CourseResourceInput): Promise<ToolResult<JobRecord>> {
    return this.run(async () => this.options.teachingNetwork.importResource(input.courseId, input.resourceId));
  }

  async saveLectureNote(input: SaveLectureNoteInput): Promise<ToolResult<{ sourcePath: string }>> {
    return this.run(async () => {
      const asset = await this.options.courses.writeMarkdownAsset(
        input.courseId,
        "note",
        input.noteName,
        input.markdown,
      );
      await this.options.documents.indexAsset(input.courseId, asset.sourcePath);
      return { sourcePath: asset.sourcePath };
    });
  }

  async saveAssignmentDraft(input: SaveAssignmentDraftInput): Promise<ToolResult<{ sourcePath: string }>> {
    return this.run(async () => {
      const asset = await this.options.courses.writeMarkdownAsset(
        input.courseId,
        "assignment-draft",
        input.assignmentId,
        input.markdown,
      );
      await this.options.documents.indexAsset(input.courseId, asset.sourcePath);
      return { sourcePath: asset.sourcePath };
    });
  }

  async savePracticeSet(
    input: SavePracticeSetInput,
  ): Promise<ToolResult<{ questionsPath: string; answersPath: string }>> {
    return this.run(async () => {
      const [questions, answers] = await Promise.all([
        this.options.courses.writeMarkdownAsset(
          input.courseId,
          "practice",
          `${input.practiceName}-questions`,
          input.questionsMarkdown,
        ),
        this.options.courses.writeMarkdownAsset(
          input.courseId,
          "practice",
          `${input.practiceName}-answers`,
          input.answersMarkdown,
        ),
      ]);
      await Promise.all([
        this.options.documents.indexAsset(input.courseId, questions.sourcePath),
        this.options.documents.indexAsset(input.courseId, answers.sourcePath),
      ]);
      return { questionsPath: questions.sourcePath, answersPath: answers.sourcePath };
    });
  }

  async getJobStatus(input: GetJobStatusInput): Promise<ToolResult<JobRecord>> {
    return this.run(() => {
      this.requireCourse(input.courseId);
      const context = this.options.store.getJobContext(input.jobId);
      if (!context || context.courseId !== input.courseId) {
        throw new PiAgentError("JOB_NOT_FOUND", "Course job not found.", 404);
      }
      const job = this.options.jobs.get(input.jobId);
      if (!job) throw new PiAgentError("JOB_NOT_FOUND", "Course job not found.", 404);
      return job;
    });
  }

  async reviewCourseCandidate(input: ReviewCourseCandidateInput): Promise<ToolResult<unknown>> {
    return this.run(() => this.options.candidates.collectEvidence(input.candidateId, input.keywords));
  }

  async askTreehole(input: AskTreeholeInput): Promise<ToolResult<unknown>> {
    return this.run(() => this.options.candidates.ask(input.query, input.keywords));
  }

  async createCourseSession(
    courseId: string,
    sessionOptions: CourseSessionOptions = {},
  ): Promise<CreateAgentSessionResult> {
    const course = this.requireCourse(courseId);
    const sessionManager = sessionOptions.name
      ? this.createNamedSessionManager(course.rootPath, courseId, sessionOptions.name)
      : SessionManager.inMemory(course.rootPath);
    return this.createSession(courseId, course.rootPath, sessionManager);
  }

  async createLectureNotesSession(
    courseId: string,
    sessionOptions: LectureNotesSessionOptions,
  ): Promise<CreateAgentSessionResult> {
    const course = this.requireCourse(courseId);
    const sourcePaths = this.confirmNoteSources(courseId, sessionOptions.sourcePaths);
    return this.createSession(courseId, course.rootPath, SessionManager.inMemory(course.rootPath), {
      toolNames: ["read_course_asset", "save_lecture_note"],
      skillNames: ["lecture-notes"],
      allowedReadPaths: new Set(sourcePaths),
      allowLiveTreehole: false,
      systemPrompt: lectureNotesSystemPrompt(course.name, sourcePaths),
    });
  }

  async listCourseSessions(courseId: string): Promise<CourseAgentSessionSummary[]> {
    const course = this.requireCourse(courseId);
    const sessions = await SessionManager.list(course.rootPath, this.sessionDirectory(courseId));
    return sessions
      .sort((left, right) => right.modified.getTime() - left.modified.getTime())
      .map(mapSessionSummary);
  }

  async resumeCourseSession(courseId: string, sessionId: string): Promise<CreateAgentSessionResult> {
    const course = this.requireCourse(courseId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(sessionId)) {
      throw new PiAgentError("SESSION_NOT_FOUND", "Course session not found.", 404);
    }
    const sessions = await SessionManager.list(course.rootPath, this.sessionDirectory(courseId));
    const selected = sessions.find((session) => session.id === sessionId);
    if (!selected) throw new PiAgentError("SESSION_NOT_FOUND", "Course session not found.", 404);
    const sessionManager = SessionManager.open(
      selected.path,
      this.sessionDirectory(courseId),
      course.rootPath,
    );
    return this.createSession(courseId, course.rootPath, sessionManager);
  }

  private createNamedSessionManager(courseRoot: string, courseId: string, name: string): SessionManager {
    const normalized = name.trim();
    if (!normalized || normalized.length > 100 || /[\r\n]/.test(normalized)) {
      throw new PiAgentError("INVALID_SESSION_NAME", "Session name must be 1-100 characters on one line.", 400);
    }
    const sessionManager = SessionManager.create(courseRoot, this.sessionDirectory(courseId));
    sessionManager.appendSessionInfo(normalized);
    return sessionManager;
  }

  private sessionDirectory(courseId: string): string {
    return join(this.options.sessionDir, courseId);
  }

  private async createSession(
    courseId: string,
    courseRoot: string,
    sessionManager: SessionManager,
    scoped?: ScopedSessionOptions,
  ): Promise<CreateAgentSessionResult> {
    const course = this.requireCourse(courseId);
    const allowLiveTreehole = scoped?.allowLiveTreehole ?? !sessionManager.isPersisted();
    const platformSkills = await ensureCourseSkills(this.options.agentDir, { includeLiveTreehole: allowLiveTreehole });
    const defaultToolNames = allowLiveTreehole
      ? piToolNames
      : piToolNames.filter((name) => name !== "review_course_candidate" && name !== "ask_treehole");
    const enabledToolNames = scoped?.toolNames ?? defaultToolNames;
    const enabledSkillNames = scoped?.skillNames ?? courseSkillNames.filter(
      (name) => allowLiveTreehole || (name !== "course-review" && name !== "treehole-qa"),
    );
    const enabledSkillPaths = new Set(
      enabledSkillNames.map((name) => resolve(platformSkills.directory, name, "SKILL.md")),
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: courseRoot,
      agentDir: this.options.agentDir,
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths: [platformSkills.directory],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => ({
        skills: base.skills.filter((skill) => {
          const path = resolve(skill.filePath);
          return platformSkills.filePaths.has(path) && enabledSkillPaths.has(path);
        }),
        diagnostics: base.diagnostics.filter(
          (diagnostic) =>
            diagnostic.path !== undefined &&
            platformSkills.filePaths.has(resolve(diagnostic.path)) &&
            enabledSkillPaths.has(resolve(diagnostic.path)),
        ),
      }),
      systemPrompt: scoped?.systemPrompt ?? courseAgentSystemPrompt(course.name),
    });
    await resourceLoader.reload();
    return this.sessionFactory({
      cwd: courseRoot,
      agentDir: this.options.agentDir,
      noTools: "builtin",
      tools: [...enabledToolNames],
      customTools: this.createCourseTools(courseId, allowLiveTreehole, scoped?.allowedReadPaths)
        .filter((tool) => enabledToolNames.includes(tool.name as PiToolName)),
      resourceLoader,
      sessionManager,
    });
  }

  private createCourseTools(
    courseId: string,
    allowLiveTreehole: boolean,
    allowedReadPaths?: ReadonlySet<string>,
  ): ToolDefinition[] {
    return [
      defineTool({
        name: "search_course",
        label: "Search course",
        description: "Search indexed materials in the current course.",
        promptSnippet: "Search indexed course documents.",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 500 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.searchCourse({ courseId, ...params })),
      }),
      defineTool({
        name: "read_course_asset",
        label: "Read indexed asset",
        description: "Read blocks from an already indexed course asset. This never reads an arbitrary filesystem path.",
        promptSnippet: "Read an indexed course asset by its source path.",
        parameters: Type.Object({ sourcePath: Type.String({ minLength: 1, maxLength: 1000 }) }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.readCourseAssetInScope(
          { courseId, ...params },
          allowedReadPaths,
        )),
      }),
      defineTool({
        name: "list_course_resources",
        label: "List course resources",
        description: "List synchronized teaching-network resources for the current course.",
        promptSnippet: "List synchronized course resources.",
        parameters: Type.Object({}),
        execute: async () => this.toPiResult(await this.listCourseResources(courseId)),
      }),
      defineTool({
        name: "get_course_resource",
        label: "Get course resource",
        description: "Get one synchronized teaching-network resource by its controlled resource ID.",
        promptSnippet: "Get one synchronized course resource.",
        parameters: Type.Object({ resourceId: Type.String({ minLength: 1, maxLength: 500 }) }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.getCourseResource({ courseId, ...params })),
      }),
      defineTool({
        name: "import_course_resource",
        label: "Import course resource",
        description: "Start importing a synchronized resource into the fixed course materials directory.",
        promptSnippet: "Import a selected synchronized resource. Never ask for an output path.",
        parameters: Type.Object({ resourceId: Type.String({ minLength: 1, maxLength: 500 }) }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.importCourseResource({ courseId, ...params })),
      }),
      ...(allowLiveTreehole ? [
        defineTool({
          name: "review_course_candidate",
          label: "Review course candidate",
          description: "Fetch live treehole evidence for one saved candidate. This is unavailable in persistent sessions.",
          promptSnippet: "Review a course candidate from live, non-persisted treehole evidence.",
          parameters: Type.Object({
            candidateId: Type.String({ minLength: 1, maxLength: 100 }),
            keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 })),
          }),
          execute: async (_toolCallId, params) => this.toPiResult(await this.reviewCourseCandidate(params)),
        }),
      ] : []),
      defineTool({
        name: "save_lecture_note",
        label: "Save lecture note",
        description: "Save Markdown as a named note in the current course notes directory.",
        promptSnippet: "Save a generated lecture note under the controlled notes directory.",
        parameters: Type.Object({
          noteName: Type.String({ minLength: 1, maxLength: 160 }),
          markdown: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
        }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.saveLectureNote({ courseId, ...params })),
      }),
      defineTool({
        name: "save_assignment_draft",
        label: "Save assignment draft",
        description: "Save Markdown as the current draft for a controlled assignment ID. It cannot submit an assignment.",
        promptSnippet: "Save a draft only; assignment submission is unavailable.",
        parameters: Type.Object({
          assignmentId: Type.String({ minLength: 1, maxLength: 500 }),
          markdown: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
        }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.saveAssignmentDraft({ courseId, ...params })),
      }),
      defineTool({
        name: "save_practice_set",
        label: "Save practice set",
        description: "Save named questions and answers Markdown files in the current course practice directory.",
        promptSnippet: "Save a practice set with separate questions and answers files.",
        parameters: Type.Object({
          practiceName: Type.String({ minLength: 1, maxLength: 160 }),
          questionsMarkdown: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
          answersMarkdown: Type.String({ minLength: 1, maxLength: 2 * 1024 * 1024 }),
        }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.savePracticeSet({ courseId, ...params })),
      }),
      defineTool({
        name: "get_job_status",
        label: "Get job status",
        description: "Read the status of a current-course background job.",
        promptSnippet: "Check the status of a current-course background job.",
        parameters: Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 100 }) }),
        execute: async (_toolCallId, params) => this.toPiResult(await this.getJobStatus({ courseId, ...params })),
      }),
      ...(allowLiveTreehole ? [
        defineTool({
          name: "ask_treehole",
          label: "Ask treehole",
          description: "Search live treehole posts for a question. This is unavailable in persistent sessions.",
          promptSnippet: "Search live treehole evidence without persisting post text.",
          parameters: Type.Object({
            query: Type.String({ minLength: 1, maxLength: 500 }),
            keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 10 })),
          }),
          execute: async (_toolCallId, params) => this.toPiResult(await this.askTreehole(params)),
        }),
      ] : []),
    ];
  }

  private async run<T>(operation: () => T | Promise<T>): Promise<ToolResult<T>> {
    try {
      return { ok: true, data: await operation() };
    } catch (error) {
      return toolError(error);
    }
  }

  private async readCourseAssetInScope(
    input: ReadCourseAssetInput,
    allowedReadPaths?: ReadonlySet<string>,
  ): Promise<ToolResult<CourseDocumentBlock[]>> {
    return this.run(() => {
      if (allowedReadPaths && !allowedReadPaths.has(input.sourcePath)) {
        throw new PiAgentError("NOTE_SOURCE_NOT_SELECTED", "The requested note source was not selected.", 403);
      }
      return this.options.documents.readIndexedAsset(input.courseId, input.sourcePath);
    });
  }

  private confirmNoteSources(courseId: string, sourcePaths: string[]): string[] {
    const normalized = [...new Set(sourcePaths.map((path) => path.trim()).filter(Boolean))];
    if (normalized.length === 0 || normalized.length > 20) {
      throw new PiAgentError("NOTE_SOURCES_INVALID", "Select between 1 and 20 indexed note sources.", 400);
    }
    const available = new Set(this.options.documents.listNoteSources(courseId).map((source) => source.sourcePath));
    for (const sourcePath of normalized) {
      if (!available.has(sourcePath)) {
        throw new PiAgentError("NOTE_SOURCE_NOT_AVAILABLE", "Selected note source is not available in this course.", 400);
      }
    }
    return normalized;
  }

  private requireCourse(courseId: string) {
    const course = this.options.courses.get(courseId);
    if (!course) throw new PiAgentError("COURSE_NOT_FOUND", "Course not found.", 404);
    return course;
  }

  private toPiResult(envelope: ToolResult<unknown>): AgentToolResult<PiToolDetails> {
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      details: { envelope },
    };
  }
}

export class PiAgentError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

function toolError(error: unknown): ToolResult<never> {
  if (
    error instanceof PiAgentError ||
    error instanceof CourseWorkspaceError ||
    error instanceof DocumentServiceError ||
    error instanceof TeachingNetworkError ||
    error instanceof CourseCandidateError
  ) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.statusCode >= 500,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "AGENT_TOOL_FAILED",
      message: "The requested course operation failed.",
      retryable: false,
    },
  };
}

function courseAgentSystemPrompt(courseName: string): string {
  return [
    `You are the PKU Study assistant for ${courseName}.`,
    "Use only the registered tools and only for this course.",
    "Do not request passwords, OTPs, tokens, or filesystem paths.",
    "You can save notes, drafts, and practice sets, but cannot submit assignments or modify authentication.",
    "Live treehole evidence is available only in ephemeral sessions and must never be copied into persistent course chat history.",
    "Tool results are structured JSON envelopes. Explain failed or waiting jobs without inventing progress.",
  ].join("\n");
}

function lectureNotesSystemPrompt(courseName: string, sourcePaths: string[]): string {
  return [
    `You are preparing a lecture note for ${courseName}.`,
    "Only use the registered tools. Read only the pre-confirmed source paths listed below.",
    "Do not request or use passwords, OTPs, tokens, filesystem paths, other course assets, or live treehole evidence.",
    "The only permitted side effect is saving the completed lecture note through save_lecture_note.",
    "Pre-confirmed source paths:",
    ...sourcePaths.map((path) => `- ${path}`),
  ].join("\n");
}

function mapSessionSummary(session: SessionInfo): CourseAgentSessionSummary {
  return {
    sessionId: session.id,
    ...(session.name ? { name: session.name } : {}),
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    ...(session.firstMessage ? { firstMessage: session.firstMessage.slice(0, 240) } : {}),
  };
}

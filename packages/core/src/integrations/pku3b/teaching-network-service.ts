import { access, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  IntegrationState,
  JobRecord,
  RemoteContentNode,
  RemoteResourceRef,
  TeachingItem,
  TeachingItemKind,
  TeachingNetworkJobContext,
  TeachingNetworkAnnouncementDetail,
  ToolResult,
} from "../../domain/types.js";
import type { JobManager } from "../../jobs/job-manager.js";
import type { SqliteStore } from "../../storage/sqlite-store.js";
import type { CourseWorkspaceService } from "../../storage/course-workspace-service.js";
import { slugify } from "../../storage/course-workspace-service.js";
import type { AppPaths } from "../../paths.js";
import { parseCourseContentList } from "./output.js";
import {
  courseLabelMatches,
  parseAnnouncementList,
  parseAnnouncementDetail,
  parseAssignmentList,
  parseGrades,
  parseVideoList,
} from "./status-output.js";
import {
  Pku3bAdapter,
  type Pku3bOutput,
  type Pku3bReadCommand,
  type Pku3bWriteCommand,
} from "./pku3b-adapter.js";

export interface Pku3bExecutor {
  version(): Promise<ToolResult<{ version: string; supported: boolean }>>;
  runRead(command: Pku3bReadCommand): Promise<ToolResult<Pku3bOutput>>;
  runWrite(command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>>;
}

export interface TeachingNetworkServiceOptions {
  store: SqliteStore;
  jobs: JobManager;
  courses: CourseWorkspaceService;
  paths: AppPaths;
  pku3b?: Pku3bExecutor;
}

export class TeachingNetworkService {
  private readonly inFlight = new Map<string, Promise<JobRecord>>();
  private readonly pku3b: Pku3bExecutor;

  constructor(private readonly options: TeachingNetworkServiceOptions) {
    this.pku3b =
      options.pku3b ??
      new Pku3bAdapter({
        configPath: options.paths.pku3bConfigPath,
        cacheDir: options.paths.pku3bCacheDir,
      });
  }

  async status(): Promise<IntegrationState> {
    const stored = this.options.store.getIntegrationState("pku3b");
    const version = await this.pku3b.version();
    if (!version.ok) {
      return this.saveState("error", "pku3b executable is unavailable.");
    }
    if (!version.data.supported) {
      return this.saveState(
        "error",
        `Unsupported pku3b version ${version.data.version}; expected >=0.16.0 <0.17.0.`,
        version.data.version,
      );
    }
    if (!(await exists(this.options.paths.pku3bConfigPath))) {
      return this.saveState(
        "needs_password",
        `Initialize pku3b configuration at ${this.options.paths.pku3bConfigPath}.`,
        version.data.version,
      );
    }
    if (stored) return { ...stored, version: version.data.version };
    return this.saveState(
      "expired",
      "Configuration exists; authenticate by starting a sync.",
      version.data.version,
    );
  }

  listResources(courseId: string): RemoteResourceRef[] {
    return this.options.store.listRemoteResources(courseId);
  }

  listTeachingItems(courseId: string, kind?: TeachingItemKind): TeachingItem[] {
    return this.options.store.listTeachingItems(courseId, kind);
  }

  async getAnnouncement(
    courseId: string,
    announcementId: string,
    input: { force?: boolean; otp?: string } = {},
  ): Promise<TeachingNetworkAnnouncementDetail> {
    const course = this.requireMappedCourse(courseId);
    this.requireAnnouncement(courseId, announcementId);
    const result = await this.pku3b.runRead({
      kind: "announcement-show",
      id: announcementId,
      allTerm: true,
      force: input.force ?? false,
      ...(input.otp ? { otp: input.otp } : {}),
    });
    if (!result.ok) {
      if (result.requiresAction) {
        throw new TeachingNetworkError(
          result.error.code,
          result.error.message,
          result.requiresAction === "provide_otp" ? 401 : 409,
          result.requiresAction,
        );
      }
      throw new TeachingNetworkError(result.error.code, result.error.message, result.error.retryable ? 502 : 400);
    }
    const detail = parseAnnouncementDetail(result.data.stdout, { courseId: course.courseId, announcementId });
    if (!detail) {
      throw new TeachingNetworkError("ANNOUNCEMENT_DETAIL_UNREADABLE", "Unable to parse the pku3b announcement detail.", 502);
    }
    if (!courseLabelMatches(detail.courseLabel, course.name)) {
      throw new TeachingNetworkError("ANNOUNCEMENT_COURSE_MISMATCH", "The announcement detail belongs to a different course.", 502);
    }
    this.saveState("ready", "Teaching-network session is ready.", result.data.version);
    return detail;
  }

  resourceTree(courseId: string): RemoteContentNode[] {
    return buildResourceTree(this.listResources(courseId));
  }

  syncCourseContent(
    courseId: string,
    input: { force?: boolean; otp?: string } = {},
  ): JobRecord {
    const course = this.requireMappedCourse(courseId);
    const job = this.options.jobs.create("pku3b.course-content.sync", `同步 ${course.name} 的教学网资料`);
    const context: TeachingNetworkJobContext = {
      operation: "sync-course-content",
      courseId,
      force: input.force ?? false,
    };
    this.options.store.setJobContext(job.jobId, context);
    this.track(job.jobId, this.executeContext(job.jobId, context, input.otp));
    return job;
  }

  syncCourseOverview(
    courseId: string,
    input: { force?: boolean; otp?: string } = {},
  ): JobRecord {
    const course = this.requireMappedCourse(courseId);
    const job = this.options.jobs.create(
      "pku3b.course-overview.sync",
      `同步 ${course.name} 的公告、作业、录播与成绩`,
    );
    const context: TeachingNetworkJobContext = {
      operation: "sync-course-overview",
      courseId,
      force: input.force ?? false,
    };
    this.options.store.setJobContext(job.jobId, context);
    this.track(job.jobId, this.executeContext(job.jobId, context, input.otp));
    return job;
  }

  importResource(
    courseId: string,
    resourceId: string,
    input: { otp?: string } = {},
  ): JobRecord {
    const course = this.requireMappedCourse(courseId);
    const resource = this.options.store.getRemoteResource(resourceId);
    if (!resource || resource.courseId !== courseId) {
      throw new TeachingNetworkError("RESOURCE_NOT_FOUND", "Remote resource not found.", 404);
    }
    if (resource.isImported && resource.localPath) {
      const job = this.options.jobs.create("pku3b.course-content.import", `资料已导入：${resource.title}`);
      this.options.jobs.update(job.jobId, {
        status: "running",
        progress: 0.5,
        message: "检查已导入资料",
      });
      return this.options.jobs.update(job.jobId, {
        status: "completed",
        progress: 1,
        message: resource.localPath,
      });
    }
    const job = this.options.jobs.create("pku3b.course-content.import", `导入 ${resource.title}`);
    const context: TeachingNetworkJobContext = {
      operation: "import-course-resource",
      courseId: course.courseId,
      resourceId,
    };
    this.options.store.setJobContext(job.jobId, context);
    this.track(job.jobId, this.executeContext(job.jobId, context, input.otp));
    return job;
  }

  downloadAssignment(
    courseId: string,
    assignmentId: string,
    input: { otp?: string } = {},
  ): JobRecord {
    const course = this.requireMappedCourse(courseId);
    const assignment = this.requireAssignment(courseId, assignmentId);
    const job = this.options.jobs.create("pku3b.assignment.download", `下载作业题目：${assignment.title}`);
    const context: TeachingNetworkJobContext = {
      operation: "download-assignment",
      courseId: course.courseId,
      assignmentId,
    };
    this.options.store.setJobContext(job.jobId, context);
    this.track(job.jobId, this.executeContext(job.jobId, context, input.otp));
    return job;
  }

  resume(jobId: string, otp: string): JobRecord {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new TeachingNetworkError("JOB_NOT_FOUND", "Job not found.", 404);
    if (job.status !== "waiting_for_auth") {
      throw new TeachingNetworkError(
        "JOB_NOT_WAITING_FOR_AUTH",
        "Only a job waiting for authentication can be resumed.",
        409,
      );
    }
    const context = this.options.store.getJobContext(jobId);
    if (!context || !isTeachingNetworkContext(context)) {
      throw new TeachingNetworkError("JOB_CONTEXT_MISSING", "Job cannot be resumed.", 409);
    }
    this.options.jobs.update(jobId, {
      status: "running",
      progress: Math.max(0.05, job.progress),
      message: "使用本次 OTP 恢复任务",
      requiresAction: "",
      errorCode: "",
      errorMessage: "",
    });
    this.track(jobId, this.executeContext(jobId, context, otp, true));
    return this.options.jobs.get(jobId) as JobRecord;
  }

  async wait(jobId: string): Promise<JobRecord> {
    return this.inFlight.get(jobId) ?? this.requireJob(jobId);
  }

  async downloadVideo(recordingId: string, outdir: string, otp?: string): Promise<ToolResult<Pku3bOutput>> {
    return this.pku3b.runWrite({
      kind: "video-download",
      id: recordingId,
      outdir,
      ...(otp ? { otp } : {}),
    });
  }

  async submitAssignment(assignmentId: string, path: string, otp?: string): Promise<ToolResult<Pku3bOutput>> {
    return this.pku3b.runWrite({
      kind: "assignment-submit",
      id: assignmentId,
      path,
      ...(otp ? { otp } : {}),
    });
  }

  async clearVideoCache(recordingId: string): Promise<void> {
    if (!/^[_A-Za-z0-9-]+$/.test(recordingId)) {
      throw new TeachingNetworkError("INVALID_RECORDING_ID", "Recording ID is invalid.", 400);
    }
    await rm(join(this.options.paths.pku3bCacheDir, "video_download", recordingId), {
      recursive: true,
      force: true,
    });
  }

  private async executeContext(
    jobId: string,
    context: TeachingNetworkJobContext,
    otp?: string,
    alreadyRunning = false,
  ): Promise<JobRecord> {
    if (!alreadyRunning) {
      this.options.jobs.update(jobId, {
        status: "running",
        progress: 0.05,
        message: "正在连接教学网",
      });
    }

    try {
      if (context.operation === "sync-course-content") {
        return await this.executeSync(jobId, context, otp);
      }
      if (context.operation === "import-course-resource") {
        return await this.executeImport(jobId, context, otp);
      }
      if (context.operation === "download-assignment") {
        return await this.executeAssignmentDownload(jobId, context, otp);
      }
      return await this.executeOverviewSync(jobId, context, otp);
    } catch (error) {
      return this.failUnexpected(jobId, error);
    }
  }

  private async executeSync(
    jobId: string,
    context: Extract<TeachingNetworkJobContext, { operation: "sync-course-content" }>,
    otp?: string,
  ): Promise<JobRecord> {
    const course = this.requireMappedCourse(context.courseId);
    let result = await this.pku3b.runRead({
      kind: "course-content-list",
      allTerm: true,
      force: context.force,
      courseTitle: course.name,
      ...(otp ? { otp } : {}),
    });
    if (!result.ok) return this.handleToolFailure(jobId, result);

    let allResources = parseCourseContentList(result.data.stdout, course.courseId);
    if (!allResources.some((item) => item.resource.remoteCourseId === course.remoteCourseId)) {
      result = await this.pku3b.runRead({
        kind: "course-content-list",
        allTerm: true,
        force: context.force,
        ...(otp ? { otp } : {}),
      });
      if (!result.ok) return this.handleToolFailure(jobId, result);
      allResources = parseCourseContentList(result.data.stdout, course.courseId);
    }

    this.options.jobs.update(jobId, {
      progress: 0.65,
      message: "正在解析课程资源",
    });
    const resources = allResources
      .map((item) => item.resource)
      .filter((resource) => resource.remoteCourseId === course.remoteCourseId);
    this.options.store.replaceRemoteResources(course.courseId, resources);
    this.saveState("ready", "Teaching-network session is ready.", result.data.version);
    return this.options.jobs.update(jobId, {
      status: "completed",
      progress: 1,
      message: `已同步 ${resources.length} 项教学网资料`,
    });
  }

  private async executeImport(
    jobId: string,
    context: Extract<TeachingNetworkJobContext, { operation: "import-course-resource" }>,
    otp?: string,
  ): Promise<JobRecord> {
    const course = this.requireMappedCourse(context.courseId);
    const resource = this.options.store.getRemoteResource(context.resourceId);
    if (!resource || resource.courseId !== course.courseId) {
      throw new TeachingNetworkError("RESOURCE_NOT_FOUND", "Remote resource not found.", 404);
    }

    const destination = join(course.rootPath, "materials", "original", resource.resourceId);
    if (await exists(destination)) {
      this.options.store.markRemoteResourceImported(resource.resourceId, destination);
      return this.options.jobs.update(jobId, {
        status: "completed",
        progress: 1,
        message: destination,
      });
    }

    const staging = join(course.rootPath, "materials", `.staging-${jobId}`);
    await mkdir(dirname(staging), { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: false });

    let result: Awaited<ReturnType<Pku3bExecutor["runWrite"]>>;
    try {
      result = await this.pku3b.runWrite({
        kind: "course-content-download",
        ccid: resource.remoteResourceId,
        outdir: staging,
        outputDescription: "description.txt",
        allTerm: true,
        ...(otp ? { otp } : {}),
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    if (!result.ok) {
      await rm(staging, { recursive: true, force: true });
      return this.handleToolFailure(jobId, result);
    }

    this.options.jobs.update(jobId, { progress: 0.8, message: "正在验证下载结果" });
    await validateStagingTree(staging);
    await mkdir(dirname(destination), { recursive: true });
    await rename(staging, destination);
    this.options.store.markRemoteResourceImported(resource.resourceId, destination);
    this.saveState("ready", "Teaching-network session is ready.", result.data.version);
    return this.options.jobs.update(jobId, {
      status: "completed",
      progress: 1,
      message: destination,
    });
  }

  private async executeOverviewSync(
    jobId: string,
    context: Extract<TeachingNetworkJobContext, { operation: "sync-course-overview" }>,
    otp?: string,
  ): Promise<JobRecord> {
    const course = this.requireMappedCourse(context.courseId);
    const syncedAt = new Date();
    const commands: {
      kind: TeachingItemKind;
      command: Pku3bReadCommand;
      parse: (output: string) => TeachingItem[];
    }[] = [
      {
        kind: "announcement",
        command: {
          kind: "announcement-list",
          allTerm: true,
          force: context.force,
          ...(otp ? { otp } : {}),
        },
        parse: (output) => parseAnnouncementList(output, { courseId: course.courseId, syncedAt }),
      },
      {
        kind: "assignment",
        command: {
          kind: "assignment-list",
          all: true,
          allTerm: true,
          force: context.force,
          ...(otp ? { otp } : {}),
        },
        parse: (output) => parseAssignmentList(output, { courseId: course.courseId, syncedAt }),
      },
      {
        kind: "video",
        command: {
          kind: "video-list",
          allTerm: true,
          force: context.force,
          ...(otp ? { otp } : {}),
        },
        parse: (output) => parseVideoList(output, { courseId: course.courseId, syncedAt }),
      },
      {
        kind: "grade",
        command: {
          kind: "grades",
          allTerm: true,
          force: context.force,
          ...(otp ? { otp } : {}),
        },
        parse: (output) => parseGrades(output, { courseId: course.courseId, syncedAt }),
      },
    ];

    const parsedItems: TeachingItem[] = [];
    for (const [index, entry] of commands.entries()) {
      this.options.jobs.update(jobId, {
        progress: 0.08 + index * 0.2,
        message: `正在同步${kindLabel(entry.kind)}`,
      });
      const result = await this.pku3b.runRead(entry.command);
      if (!result.ok) return this.handleToolFailure(jobId, result);
      const candidates = entry.parse(result.data.stdout);
      parsedItems.push(
        ...candidates.filter((item) => courseLabelMatches(item.courseLabel, course.name)),
      );
      if (index === 0) this.saveState("ready", "Teaching-network session is ready.", result.data.version);
    }

    this.options.store.replaceTeachingItems(
      course.courseId,
      ["announcement", "assignment", "video", "grade"],
      parsedItems,
    );
    const counts = Object.fromEntries(
      ["announcement", "assignment", "video", "grade"].map((kind) => [
        kind,
        parsedItems.filter((item) => item.kind === kind).length,
      ]),
    );
    return this.options.jobs.update(jobId, {
      status: "completed",
      progress: 1,
      message: `公告 ${counts.announcement} · 作业 ${counts.assignment} · 录播 ${counts.video} · 成绩 ${counts.grade}`,
    });
  }

  private async executeAssignmentDownload(
    jobId: string,
    context: Extract<TeachingNetworkJobContext, { operation: "download-assignment" }>,
    otp?: string,
  ): Promise<JobRecord> {
    const course = this.requireMappedCourse(context.courseId);
    const assignment = this.requireAssignment(course.courseId, context.assignmentId);
    const directory = join(course.rootPath, "assignments", slugify(context.assignmentId));
    const destination = join(directory, "original");
    if (await exists(destination)) {
      const fileCount = await validateDownloadedTree(destination);
      return this.options.jobs.update(jobId, {
        status: "completed",
        progress: 1,
        message: `${fileCount} 个作业附件已在 ${relative(course.rootPath, destination)}`,
      });
    }

    const staging = join(directory, `.staging-${jobId}`);
    await mkdir(directory, { recursive: true });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: false });
    try {
      this.options.jobs.update(jobId, { progress: 0.45, message: "正在下载作业附件" });
      const result = await this.pku3b.runWrite({
        kind: "assignment-download",
        id: context.assignmentId,
        outdir: staging,
        ...(otp ? { otp } : {}),
      });
      if (!result.ok) {
        await rm(staging, { recursive: true, force: true });
        return this.handleToolFailure(jobId, result);
      }
      this.options.jobs.update(jobId, { progress: 0.8, message: "正在验证作业附件" });
      const fileCount = await validateDownloadedTree(staging);
      await rename(staging, destination);
      this.saveState("ready", "Teaching-network session is ready.", result.data.version);
      return this.options.jobs.update(jobId, {
        status: "completed",
        progress: 1,
        message: `${fileCount} 个作业附件已保存至 ${relative(course.rootPath, destination)}`,
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private handleToolFailure(jobId: string, result: Extract<ToolResult<unknown>, { ok: false }>): JobRecord {
    if (result.requiresAction === "provide_otp" || result.requiresAction === "configure_pku3b") {
      const authState = result.requiresAction === "provide_otp" ? "needs_otp" : "needs_password";
      this.saveState(authState, result.error.message);
      return this.options.jobs.update(jobId, {
        status: "waiting_for_auth",
        progress: 0.05,
        message:
          result.requiresAction === "provide_otp"
            ? "教学网需要本次手机令牌"
            : "需要先初始化 pku3b 配置",
        errorCode: result.error.code,
        errorMessage: result.error.message,
        requiresAction: result.requiresAction,
      });
    }
    this.saveState("error", result.error.message);
    return this.options.jobs.update(jobId, {
      status: "failed",
      errorCode: result.error.code,
      errorMessage: result.error.message,
      message: "教学网操作失败",
    });
  }

  private failUnexpected(jobId: string, error: unknown): JobRecord {
    const code = error instanceof TeachingNetworkError ? error.code : "TEACHING_NETWORK_INTERNAL";
    const message = error instanceof Error ? error.message : String(error);
    this.saveState("error", message);
    return this.options.jobs.update(jobId, {
      status: "failed",
      errorCode: code,
      errorMessage: message,
      message: "教学网操作失败",
    });
  }

  private saveState(
    authState: IntegrationState["authState"],
    detail: string,
    version?: string,
  ): IntegrationState {
    const state: IntegrationState = {
      provider: "pku3b",
      authState,
      detail,
      ...(version ? { version } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.options.store.setIntegrationState(state);
    return state;
  }

  private requireMappedCourse(courseId: string) {
    const course = this.options.courses.get(courseId);
    if (!course) throw new TeachingNetworkError("COURSE_NOT_FOUND", "Course not found.", 404);
    if (!course.remoteCourseId) {
      throw new TeachingNetworkError(
        "COURSE_NOT_MAPPED",
        "Set a stable teaching-network course ID before syncing.",
        409,
      );
    }
    return course;
  }

  private requireAssignment(courseId: string, assignmentId: string): TeachingItem {
    const assignment = this.options.store
      .listTeachingItems(courseId, "assignment")
      .find((item) => item.remoteId === assignmentId && item.remoteIdStable);
    if (!assignment) {
      throw new TeachingNetworkError("ASSIGNMENT_NOT_FOUND", "A synchronized assignment with a stable remote ID is required.", 404);
    }
    return assignment;
  }

  private requireAnnouncement(courseId: string, announcementId: string): TeachingItem {
    const announcement = this.options.store
      .listTeachingItems(courseId, "announcement")
      .find((item) => item.remoteId === announcementId && item.remoteIdStable);
    if (!announcement) {
      throw new TeachingNetworkError("ANNOUNCEMENT_NOT_FOUND", "A synchronized announcement with a stable remote ID is required.", 404);
    }
    return announcement;
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new TeachingNetworkError("JOB_NOT_FOUND", "Job not found.", 404);
    return job;
  }

  private track(jobId: string, promise: Promise<JobRecord>): void {
    const tracked = promise.finally(() => this.inFlight.delete(jobId));
    this.inFlight.set(jobId, tracked);
  }
}

function kindLabel(kind: TeachingItemKind): string {
  return { announcement: "公告", assignment: "作业", video: "录播", grade: "成绩" }[kind];
}

function isTeachingNetworkContext(
  context: import("../../domain/types.js").JobContext,
): context is TeachingNetworkJobContext {
  return context.operation === "sync-course-content" ||
    context.operation === "import-course-resource" ||
    context.operation === "sync-course-overview" ||
    context.operation === "download-assignment";
}

export class TeachingNetworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly requiresAction?: string,
  ) {
    super(message);
  }
}

export function buildResourceTree(resources: RemoteResourceRef[]): RemoteContentNode[] {
  const nodes = new Map<string, RemoteContentNode>();
  for (const resource of resources) nodes.set(resource.resourceId, { ...resource, children: [] });

  const roots: RemoteContentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && parent.resourceId !== node.resourceId) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

async function validateStagingTree(root: string): Promise<void> {
  await validateDownloadedTree(root);
}

async function validateDownloadedTree(root: string): Promise<number> {
  const rootPath = resolve(root);
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TeachingNetworkError("DOWNLOADED_DIRECTORY_INVALID", "Downloaded output must be a regular directory.", 502);
  }
  const entries = await readdir(rootPath, { recursive: true, withFileTypes: true });
  let fileCount = 0;
  for (const entry of entries) {
    const path = resolve(entry.parentPath, entry.name);
    const inside = path === rootPath || (!relative(rootPath, path).startsWith(`..${sep}`) && relative(rootPath, path) !== "..");
    if (!inside) throw new Error(`Downloaded path escaped staging directory: ${basename(path)}`);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Downloaded symbolic links are not allowed: ${entry.name}`);
    if (stat.isFile()) fileCount += 1;
  }
  if (fileCount === 0) {
    throw new TeachingNetworkError("DOWNLOADED_FILES_MISSING", "pku3b did not produce any downloadable files.", 502);
  }
  return fileCount;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

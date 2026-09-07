import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssignmentApproval, AssignmentJobContext, JobRecord, TeachingItem } from "../domain/types.js";
import type { TeachingNetworkService } from "../integrations/pku3b/teaching-network-service.js";
import type { JobManager } from "../jobs/job-manager.js";
import { slugify, type CourseWorkspaceService } from "../storage/course-workspace-service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";

const APPROVAL_LIFETIME_MS = 30 * 60_000;
const MAX_ANSWER_BYTES = 50 * 1024 * 1024;

export interface AssignmentServiceOptions {
  store: SqliteStore;
  courses: CourseWorkspaceService;
  jobs: JobManager;
  teachingNetwork: TeachingNetworkService;
  now?: () => Date;
}

export class AssignmentService {
  private readonly inFlight = new Map<string, Promise<JobRecord>>();
  private readonly now: () => Date;

  constructor(private readonly options: AssignmentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async approve(courseId: string, assignmentId: string): Promise<AssignmentApproval> {
    this.requireCourse(courseId);
    this.requireAssignment(courseId, assignmentId);
    const filePath = this.answerPath(courseId, assignmentId);
    const sha256 = await hashAnswer(filePath);
    const approval: AssignmentApproval = {
      approvalId: randomUUID(),
      courseId,
      assignmentRemoteId: assignmentId,
      filePath,
      sha256,
      expiresAt: new Date(this.now().getTime() + APPROVAL_LIFETIME_MS).toISOString(),
    };
    this.options.store.insertAssignmentApproval(approval);
    return approval;
  }

  submit(
    courseId: string,
    assignmentId: string,
    approvalId: string,
    input: { otp?: string } = {},
  ): JobRecord {
    this.requireCourse(courseId);
    this.requireAssignment(courseId, assignmentId);
    const job = this.options.jobs.create("assignment.submit", `提交作业 ${assignmentId}`);
    const context: AssignmentJobContext = {
      operation: "submit-assignment",
      courseId,
      assignmentId,
      approvalId,
    };
    this.options.store.setJobContext(job.jobId, context);
    this.track(job.jobId, this.execute(job.jobId, context, input.otp));
    return job;
  }

  resume(jobId: string, otp: string): JobRecord {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new AssignmentServiceError("JOB_NOT_FOUND", "Job not found.", 404);
    if (job.status !== "waiting_for_auth") {
      throw new AssignmentServiceError("JOB_NOT_WAITING_FOR_AUTH", "Only a job waiting for authentication can be resumed.", 409);
    }
    const context = this.options.store.getJobContext(jobId);
    if (!context || context.operation !== "submit-assignment") {
      throw new AssignmentServiceError("JOB_CONTEXT_MISSING", "Job cannot be resumed as an assignment submission.", 409);
    }
    this.options.jobs.update(jobId, {
      status: "running",
      progress: Math.max(0.1, job.progress),
      message: "使用本次 OTP 恢复作业提交",
      requiresAction: "",
      errorCode: "",
      errorMessage: "",
    });
    this.track(jobId, this.execute(jobId, context, otp, true));
    return this.options.jobs.get(jobId) as JobRecord;
  }

  async wait(jobId: string): Promise<JobRecord> {
    return this.inFlight.get(jobId) ?? this.requireJob(jobId);
  }

  private async execute(
    jobId: string,
    context: AssignmentJobContext,
    otp?: string,
    alreadyRunning = false,
  ): Promise<JobRecord> {
    if (!alreadyRunning) {
      this.options.jobs.update(jobId, {
        status: "running",
        progress: 0.1,
        message: "正在校验已审批的答案文件",
      });
    }
    try {
      const approval = await this.verifyApproval(context);
      this.options.jobs.update(jobId, { progress: 0.45, message: "正在提交作业" });
      const result = await this.options.teachingNetwork.submitAssignment(context.assignmentId, approval.filePath, otp);
      if (!result.ok) return this.handleSubmissionFailure(jobId, result);
      this.options.store.deleteAssignmentApproval(approval.approvalId);
      return this.options.jobs.update(jobId, {
        status: "completed",
        progress: 1,
        message: "作业已提交",
      });
    } catch (error) {
      const code = error instanceof AssignmentServiceError ? error.code : "ASSIGNMENT_SUBMISSION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      return this.options.jobs.update(jobId, {
        status: "failed",
        errorCode: code,
        errorMessage: message.slice(0, 500),
        message: "作业提交失败",
      });
    }
  }

  private async verifyApproval(context: AssignmentJobContext): Promise<AssignmentApproval> {
    const approval = this.options.store.getAssignmentApproval(context.approvalId);
    if (!approval || approval.courseId !== context.courseId || approval.assignmentRemoteId !== context.assignmentId) {
      throw new AssignmentServiceError("ASSIGNMENT_APPROVAL_INVALID", "A matching active approval is required before submission.", 409);
    }
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) {
      this.options.store.deleteAssignmentApproval(approval.approvalId);
      throw new AssignmentServiceError("ASSIGNMENT_APPROVAL_EXPIRED", "The approval has expired; review the answer and approve it again.", 409);
    }
    if (approval.filePath !== this.answerPath(context.courseId, context.assignmentId)) {
      this.options.store.deleteAssignmentApproval(approval.approvalId);
      throw new AssignmentServiceError("ASSIGNMENT_APPROVAL_INVALID", "The approved file path is not valid for this assignment.", 409);
    }
    if (await hashAnswer(approval.filePath) !== approval.sha256) {
      this.options.store.deleteAssignmentApproval(approval.approvalId);
      throw new AssignmentServiceError("ASSIGNMENT_APPROVAL_STALE", "The answer changed after approval; review and approve it again.", 409);
    }
    return approval;
  }

  private handleSubmissionFailure(
    jobId: string,
    result: Awaited<ReturnType<TeachingNetworkService["submitAssignment"]>>,
  ): JobRecord {
    if (result.ok) throw new Error("Expected a failed assignment submission result.");
    if (result.requiresAction) {
      return this.options.jobs.update(jobId, {
        status: "waiting_for_auth",
        progress: 0.45,
        message: result.requiresAction === "provide_otp" ? "教学网需要本次手机令牌" : "需要先初始化 pku3b 配置",
        errorCode: result.error.code,
        errorMessage: result.error.message,
        requiresAction: result.requiresAction,
      });
    }
    return this.options.jobs.update(jobId, {
      status: "failed",
      errorCode: result.error.code,
      errorMessage: result.error.message,
      message: "作业提交失败",
    });
  }

  private requireCourse(courseId: string) {
    const course = this.options.courses.get(courseId);
    if (!course) throw new AssignmentServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    return course;
  }

  private requireAssignment(courseId: string, assignmentId: string): TeachingItem {
    const assignment = this.options.store
      .listTeachingItems(courseId, "assignment")
      .find((item) => item.remoteId === assignmentId && item.remoteIdStable);
    if (!assignment) {
      throw new AssignmentServiceError("ASSIGNMENT_NOT_FOUND", "A synchronized assignment with a stable remote ID is required.", 404);
    }
    return assignment;
  }

  private answerPath(courseId: string, assignmentId: string): string {
    const course = this.requireCourse(courseId);
    return join(course.rootPath, "assignments", slugify(assignmentId), "answer.pdf");
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new AssignmentServiceError("JOB_NOT_FOUND", "Job not found.", 404);
    return job;
  }

  private track(jobId: string, promise: Promise<JobRecord>): void {
    const tracked = promise.finally(() => this.inFlight.delete(jobId));
    this.inFlight.set(jobId, tracked);
  }
}

export class AssignmentServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

async function hashAnswer(path: string): Promise<string> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new AssignmentServiceError("ASSIGNMENT_ANSWER_NOT_FOUND", "Export answer.pdf before approving submission.", 404);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_ANSWER_BYTES) {
    throw new AssignmentServiceError("ASSIGNMENT_ANSWER_INVALID", "The final answer must be a regular PDF file up to 50 MiB.", 400);
  }
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

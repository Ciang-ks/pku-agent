import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PdfRenderer } from "../domain/types.js";
import { PandocPdfRenderer } from "../documents/pdf-renderer.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { slugify, type CourseWorkspaceService } from "../storage/course-workspace-service.js";

export interface PdfExportServiceOptions {
  store: SqliteStore;
  courses: CourseWorkspaceService;
  renderer?: PdfRenderer;
}

export interface ExportedAssignmentPdf {
  assignmentId: string;
  sourcePath: string;
}

export class PdfExportService {
  private readonly renderer: PdfRenderer;

  constructor(private readonly options: PdfExportServiceOptions) {
    this.renderer = options.renderer ?? new PandocPdfRenderer();
  }

  async exportAssignment(courseId: string, assignmentId: string): Promise<ExportedAssignmentPdf> {
    const course = this.options.courses.get(courseId);
    if (!course) throw new PdfExportServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    const assignment = this.options.store
      .listTeachingItems(courseId, "assignment")
      .find((item) => item.remoteId === assignmentId && item.remoteIdStable);
    if (!assignment) throw new PdfExportServiceError("ASSIGNMENT_NOT_FOUND", "A synchronized assignment with a stable remote ID is required.", 404);

    const directory = join(course.rootPath, "assignments", slugify(assignmentId));
    const markdownPath = join(directory, "draft.md");
    const sourcePath = join("assignments", slugify(assignmentId), "answer.pdf");
    const outputPath = join(course.rootPath, sourcePath);
    const temporaryPath = `${outputPath}.${randomUUID()}.pdf`;
    await assertRegularFile(markdownPath, "Assignment draft");
    await mkdir(dirname(outputPath), { recursive: true });
    try {
      await this.renderer.render({ markdownPath, outputPath: temporaryPath });
      await assertRegularFile(temporaryPath, "Rendered PDF");
      await rename(temporaryPath, outputPath);
      return { assignmentId, sourcePath };
    } catch (error) {
      if (error instanceof PdfExportServiceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PdfExportServiceError("PDF_EXPORT_FAILED", message, 502);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

export class PdfExportServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error();
  } catch {
    throw new PdfExportServiceError("PDF_SOURCE_INVALID", `${label} must be a non-empty regular file.`, 400);
  }
}

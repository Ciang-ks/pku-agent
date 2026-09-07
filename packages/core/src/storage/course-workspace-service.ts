import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { createCourseSchema } from "../domain/schemas.js";
import type { CourseWorkspace, CreateCourseInput, PracticeSet, PracticeSetSummary } from "../domain/types.js";
import type { SqliteStore } from "./sqlite-store.js";

const WORKSPACE_DIRS = [
  "prompts",
  "materials/original",
  "materials/text",
  "announcements",
  "recordings/transcripts",
  "notes",
  "assignments",
  "practice",
] as const;

export type CourseMarkdownAssetKind = "note" | "assignment-draft" | "practice" | "recording-transcript";

export interface CourseMarkdownAsset {
  sourcePath: string;
  absolutePath: string;
}

export class CourseWorkspaceService {
  constructor(
    private readonly store: SqliteStore,
    private readonly coursesDir: string,
  ) {}

  list(): CourseWorkspace[] {
    return this.store.listCourses();
  }

  get(courseId: string): CourseWorkspace | undefined {
    return this.store.getCourse(courseId);
  }

  async create(rawInput: CreateCourseInput): Promise<CourseWorkspace> {
    const input = createCourseSchema.parse(rawInput);
    const courseId = randomUUID();
    const slug = slugify(`${input.term}-${input.name}-${input.teacher}`);
    const rootPath = join(this.coursesDir, `${slug}-${courseId.slice(0, 8)}`);
    const now = new Date().toISOString();
    const course: CourseWorkspace = {
      courseId,
      name: input.name,
      teacher: input.teacher,
      term: input.term,
      ...(input.remoteCourseId ? { remoteCourseId: input.remoteCourseId } : {}),
      rootPath,
      createdAt: now,
      updatedAt: now,
    };

    await mkdir(rootPath, { recursive: false });
    try {
      await Promise.all(WORKSPACE_DIRS.map((dir) => mkdir(join(rootPath, dir), { recursive: true })));
      await Promise.all([
        writePrompt(join(rootPath, "prompts", "notes.md"), "课堂笔记提示词"),
        writePrompt(join(rootPath, "prompts", "homework.md"), "作业解答提示词"),
        writePrompt(join(rootPath, "prompts", "practice.md"), "自测练习提示词"),
        writePrompt(join(rootPath, "prompts", "treehole-review.md"), "树洞课程风评提示词"),
      ]);
      await atomicWrite(join(rootPath, "course.yaml"), stringify(courseManifest(course)));
      this.store.insertCourse(course);
      return course;
    } catch (error) {
      this.store.deleteCourse(courseId);
      await rm(rootPath, { recursive: true, force: true });
      throw error;
    }
  }

  async writeMarkdownAsset(
    courseId: string,
    kind: CourseMarkdownAssetKind,
    name: string,
    content: string,
  ): Promise<CourseMarkdownAsset> {
    const course = this.get(courseId);
    if (!course) throw new CourseWorkspaceError("COURSE_NOT_FOUND", "Course not found.", 404);
    if (!content.trim()) {
      throw new CourseWorkspaceError("EMPTY_MARKDOWN", "Markdown content must not be empty.", 400);
    }
    if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) {
      throw new CourseWorkspaceError("MARKDOWN_TOO_LARGE", "Markdown content must not exceed 2 MiB.", 413);
    }

    const assetName = slugify(name.trim());
    const sourcePath = markdownAssetPath(kind, assetName);
    const absolutePath = join(course.rootPath, sourcePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await atomicWrite(absolutePath, `${content.replace(/\r\n?/g, "\n").trimEnd()}\n`);
    return { sourcePath, absolutePath };
  }

  async listPracticeSets(courseId: string): Promise<PracticeSetSummary[]> {
    const course = this.requireCourse(courseId);
    const practiceDir = join(course.rootPath, "practice");
    const entries = await readdir(practiceDir, { withFileTypes: true });
    const names = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith("-questions.md")) {
        names.add(entry.name.slice(0, -"-questions.md".length));
      }
    }

    const summaries = await Promise.all(
      [...names].map(async (name) => {
        try {
          return await this.practiceSetSummary(course, name);
        } catch {
          return undefined;
        }
      }),
    );
    return summaries
      .filter((summary): summary is PracticeSetSummary => summary !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
  }

  async readPracticeSet(courseId: string, name: string): Promise<PracticeSet> {
    const course = this.requireCourse(courseId);
    const normalizedName = slugify(name.trim());
    const summary = await this.practiceSetSummary(course, normalizedName);
    const [questionsMarkdown, answersMarkdown] = await Promise.all([
      readPracticeMarkdown(join(course.rootPath, summary.questionsPath)),
      readPracticeMarkdown(join(course.rootPath, summary.answersPath)),
    ]);
    return { ...summary, questionsMarkdown, answersMarkdown };
  }

  private requireCourse(courseId: string): CourseWorkspace {
    const course = this.get(courseId);
    if (!course) throw new CourseWorkspaceError("COURSE_NOT_FOUND", "Course not found.", 404);
    return course;
  }

  private async practiceSetSummary(course: CourseWorkspace, name: string): Promise<PracticeSetSummary> {
    const questionsPath = join("practice", `${name}-questions.md`);
    const answersPath = join("practice", `${name}-answers.md`);
    let questionsStat;
    let answersStat;
    try {
      [questionsStat, answersStat] = await Promise.all([
        practiceMarkdownStat(join(course.rootPath, questionsPath)),
        practiceMarkdownStat(join(course.rootPath, answersPath)),
      ]);
    } catch (error) {
      if (isMissingFile(error)) {
        throw new CourseWorkspaceError("PRACTICE_SET_NOT_FOUND", "Practice set not found.", 404);
      }
      throw error;
    }
    return {
      name,
      questionsPath,
      answersPath,
      updatedAt: new Date(Math.max(questionsStat.mtimeMs, answersStat.mtimeMs)).toISOString(),
    };
  }
}

export class CourseWorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

function courseManifest(course: CourseWorkspace): Record<string, unknown> {
  return {
    schemaVersion: 1,
    courseId: course.courseId,
    name: course.name,
    teacher: course.teacher,
    term: course.term,
    ...(course.remoteCourseId ? { remoteCourseId: course.remoteCourseId } : {}),
  };
}

function markdownAssetPath(kind: CourseMarkdownAssetKind, name: string): string {
  if (kind === "note") return join("notes", `${name}.md`);
  if (kind === "assignment-draft") return join("assignments", name, "draft.md");
  if (kind === "recording-transcript") return join("recordings", "transcripts", `${name}.md`);
  return join("practice", `${name}.md`);
}

async function writePrompt(path: string, title: string): Promise<void> {
  await atomicWrite(
    path,
    `# ${title}\n\n在这里填写本课程的覆盖提示词。留空时使用平台默认模板。\n`,
  );
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, path);
}

async function practiceMarkdownStat(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) {
    throw new CourseWorkspaceError("PRACTICE_SET_INVALID", "Practice files must be regular Markdown files below 2 MiB.", 409);
  }
  return metadata;
}

async function readPracticeMarkdown(path: string): Promise<string> {
  await practiceMarkdownStat(path);
  return readFile(path, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "course";
}

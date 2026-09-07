import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "@pku-study/core";
import type {
  Pku3bOutput,
  Pku3bReadCommand,
  Pku3bWriteCommand,
  TreeholeProvider,
  ToolResult,
  PdfRenderer,
} from "@pku-study/core";
import { createServer, type PkuStudyServer } from "../src/server.js";

const instances: PkuStudyServer[] = [];
const apps: ReturnType<typeof createApplication>[] = [];

function fakeTreehole(): TreeholeProvider {
  return {
    async authStatus() {
      return { ok: true, data: { provider: "treehole", authState: "ready", updatedAt: new Date().toISOString() } };
    },
    async login() {
      return { ok: true, data: { provider: "treehole", authState: "ready", updatedAt: new Date().toISOString() } };
    },
    async searchPosts(input) {
      return {
        ok: true,
        data: {
          keyword: input.keyword,
          posts: [{
            pid: "8001234",
            text: "课程评价原文",
            commentCount: 1,
            comments: [{ commentId: "7", text: "评论原文" }],
          }],
        },
      };
    },
    async getPost() {
      return { ok: true, data: { pid: "8001234", text: "课程评价原文", commentCount: 0, comments: [] } };
    },
    async getComments() {
      return { ok: true, data: [] };
    },
  };
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close();
  for (const app of apps.splice(0)) app.close();
});

describe("local API", () => {
  it("requires the API token and creates a course", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-server-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    apps.push(app);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);

    const unauthorized = await instance.server.inject({ method: "GET", url: "/api/courses" });
    expect(unauthorized.statusCode).toBe(401);

    const web = await instance.server.inject({ method: "GET", url: "/" });
    expect(web.statusCode).toBe(200);
    expect(web.headers["content-type"]).toContain("text/html");
    expect(web.body).toContain('<div id="app"></div>');

    const created = await instance.server.inject({
      method: "POST",
      url: "/api/courses",
      headers: { authorization: "Bearer test-token" },
      payload: { name: "编译原理", teacher: "李老师", term: "2026-fall" },
    });
    expect(created.statusCode).toBe(201);

    const courses = await instance.server.inject({
      method: "GET",
      url: "/api/courses",
      headers: { authorization: "Bearer test-token" },
    });
    expect(courses.json().data).toHaveLength(1);
  });

  it("returns a bounded cross-course timeline for the requested range", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-timeline-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    apps.push(app);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const course = await app.courses.create({ name: "算法", teacher: "李老师", term: "2026-fall" });
    const now = new Date();
    app.store.replaceTeachingItems(course.courseId, ["assignment", "announcement"], [
      {
        itemId: "assignment-timeline", courseId: course.courseId, provider: "pku3b", remoteId: "_assignment_timeline",
        remoteIdStable: true, kind: "assignment", title: "本周作业", courseLabel: course.name,
        dueAt: new Date(now.getTime() + 86_400_000).toISOString(), dueText: "明天", updatedAt: now.toISOString(),
      },
      {
        itemId: "announcement-timeline", courseId: course.courseId, provider: "pku3b", remoteId: "_announcement_timeline",
        remoteIdStable: true, kind: "announcement", title: "今日通知", courseLabel: course.name,
        updatedAt: now.toISOString(),
      },
    ]);
    app.store.replaceRemoteResources(course.courseId, [{
      resourceId: "resource-timeline",
      courseId: course.courseId,
      provider: "pku3b",
      remoteCourseId: "_course_timeline",
      remoteResourceId: "_document_timeline",
      kind: "document",
      title: "本周讲义",
      hasDetails: true,
      isImported: false,
      updatedAt: now.toISOString(),
    }]);
    const response = await instance.server.inject({
      method: "GET",
      url: "/api/timeline?range=today&limit=1",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0]).toMatchObject({ courseId: course.courseId, courseName: "算法" });
    const week = await instance.server.inject({
      method: "GET",
      url: "/api/timeline?range=week&limit=10",
      headers: { authorization: "Bearer test-token" },
    });
    expect(week.json().data).toHaveLength(3);
    expect(week.json().data.some((entry: { resource?: { resourceId: string } }) => entry.resource?.resourceId === "resource-timeline")).toBe(true);
  });

  it("collects live candidate evidence without persisting post text and accepts an explicit final review", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-candidate-"));
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      treehole: fakeTreehole(),
    });
    apps.push(app);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const headers = { authorization: "Bearer test-token" };

    const authStatus = await instance.server.inject({
      method: "GET",
      url: "/api/auth/treehole/status",
      headers,
    });
    expect(authStatus.statusCode).toBe(200);
    expect(authStatus.json().data).toMatchObject({ provider: "treehole", authState: "ready" });

    const login = await instance.server.inject({
      method: "POST",
      url: "/api/auth/treehole/login",
      headers,
      payload: { username: "student", password: "secret" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().data).toMatchObject({ provider: "treehole", authState: "ready" });

    const created = await instance.server.inject({
      method: "POST",
      url: "/api/candidates",
      headers,
      payload: { name: "操作系统", teacher: "李老师", aliases: ["OS"] },
    });
    expect(created.statusCode).toBe(201);
    const candidateId = created.json().data.candidateId as string;

    const evidence = await instance.server.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review`,
      headers,
      payload: {},
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().data.evidence.posts[0]).toMatchObject({ pid: "8001234", text: "课程评价原文" });
    expect(app.store.db.prepare("SELECT aliases_json FROM course_candidates").get()).not.toMatchObject({
      aliases_json: expect.stringContaining("课程评价原文"),
    });

    const reviewed = await instance.server.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/review`,
      headers,
      payload: {
        review: {
          teachingClarity: 5,
          contentValue: 4,
          grading: 3,
          workload: 2,
          predictability: 4,
          overall: 4,
          confidence: "medium",
          summary: "需要预留作业时间。",
          positives: ["讲解清晰"],
          negatives: ["作业较多"],
          relatedPids: ["8001234"],
        },
      },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().data.candidate.review).toMatchObject({ overall: 4, relatedPids: ["8001234"] });

    const updated = await instance.server.inject({
      method: "PATCH",
      url: `/api/candidates/${candidateId}`,
      headers,
      payload: { status: "rejected" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.status).toBe("rejected");

    const asked = await instance.server.inject({
      method: "POST",
      url: "/api/treehole/ask",
      headers,
      payload: { query: "操作系统怎么样" },
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().data.posts).toHaveLength(1);
  });

  it("reports a Treehole verification challenge without treating it as a service outage", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-treehole-auth-"));
    const treehole: TreeholeProvider = {
      async authStatus() {
        return { ok: true, data: { provider: "treehole", authState: "needs_password", updatedAt: new Date().toISOString() } };
      },
      async login() {
        return { ok: false, error: { code: "TREEHOLE_VERIFICATION_REQUIRED", message: "验证码", retryable: true } };
      },
      async searchPosts() {
        return { ok: false, error: { code: "TREEHOLE_AUTH_REQUIRED", message: "认证", retryable: false } };
      },
      async getPost() {
        return { ok: false, error: { code: "TREEHOLE_AUTH_REQUIRED", message: "认证", retryable: false } };
      },
      async getComments() {
        return { ok: false, error: { code: "TREEHOLE_AUTH_REQUIRED", message: "认证", retryable: false } };
      },
    };
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      treehole,
    });
    apps.push(app);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const response = await instance.server.inject({
      method: "POST",
      url: "/api/auth/treehole/login",
      headers: { authorization: "Bearer test-token" },
      payload: { username: "student", password: "secret" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TREEHOLE_VERIFICATION_REQUIRED");
  });

  it("starts a teaching-network sync and exposes its resource tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-sync-"));
    const pku3b = {
      async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
        return { ok: true, data: { version: "0.16.0", supported: true } };
      },
      async runRead(_command: Pku3bReadCommand): Promise<ToolResult<Pku3bOutput>> {
        return {
          ok: true,
          data: {
            stdout: "编译原理 (2026 Fall)\n• (Document) 第一讲 [1 附件] _321_1:_654_1",
            stderr: "",
            version: "0.16.0",
          },
        };
      },
      async runWrite(_command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>> {
        return { ok: true, data: { stdout: "Done.", stderr: "", version: "0.16.0" } };
      },
    };
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      pku3b,
    });
    apps.push(app);
    const course = await app.courses.create({
      name: "编译原理",
      teacher: "李老师",
      term: "2026-fall",
      remoteCourseId: "_321_1",
    });
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);

    const started = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/remote-resources/sync`,
      headers: { authorization: "Bearer test-token" },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().jobId as string;
    expect((await app.teachingNetwork.wait(jobId)).status).toBe("completed");

    const resources = await instance.server.inject({
      method: "GET",
      url: `/api/courses/${course.courseId}/remote-resources`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(resources.statusCode).toBe(200);
    expect(resources.json().data.tree).toHaveLength(1);
    expect(resources.json().data.tree[0].remoteResourceId).toBe("_321_1:_654_1");
  });

  it("starts a recording transcription job from a synchronized stable video ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-recording-"));
    const pku3b = {
      async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
        return { ok: true, data: { version: "0.16.0", supported: true } };
      },
      async runRead(): Promise<ToolResult<Pku3bOutput>> {
        return { ok: true, data: { stdout: "", stderr: "", version: "0.16.0" } };
      },
      async runWrite(command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>> {
        if (command.kind === "video-download") {
          await mkdir(command.outdir, { recursive: true });
          await writeFile(join(command.outdir, "recording.mp4"), "fixture-video");
        }
        return { ok: true, data: { stdout: "Done.", stderr: "", version: "0.16.0" } };
      },
    };
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b,
      audioProcessor: {
        async split(input) {
          const filePath = join(input.outputDir, "audio-001.webm");
          await writeFile(filePath, "fixture-audio");
          return [{ filePath, startSeconds: 0, endSeconds: 42 }];
        },
      },
      transcriptions: { id: "test:transcription", isAvailable: () => true, async transcribe() { return { text: "课程转写内容。" }; } },
    });
    apps.push(app);
    const course = await app.courses.create({ name: "操作系统", teacher: "李老师", term: "2026-fall", remoteCourseId: "_321_1" });
    app.store.replaceTeachingItems(course.courseId, ["video"], [{
      itemId: "pku3b:video:_video_1", courseId: course.courseId, provider: "pku3b", remoteId: "_video_1",
      remoteIdStable: true, kind: "video", title: "第一讲", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);

    const started = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/recordings/_video_1/transcribe`,
      headers: { authorization: "Bearer test-token" },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().jobId as string;
    expect((await app.recordings.wait(jobId)).status).toBe("completed");
    const job = await instance.server.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(job.statusCode).toBe(200);
    expect(job.json().data.message).toMatch(/^recordings\/transcripts\//);
  });

  it("requires an exported PDF and explicit approval before assignment submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-assignment-"));
    const pku3b = {
      async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
        return { ok: true, data: { version: "0.16.0", supported: true } };
      },
      async runRead(): Promise<ToolResult<Pku3bOutput>> {
        return { ok: true, data: { stdout: "", stderr: "", version: "0.16.0" } };
      },
      async runWrite(): Promise<ToolResult<Pku3bOutput>> {
        return { ok: true, data: { stdout: "Submitted.", stderr: "", version: "0.16.0" } };
      },
    };
    const renderer: PdfRenderer = {
      id: "test:pdf",
      async render(input) {
        await writeFile(input.outputPath, "%PDF-test");
      },
    };
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b,
      pdfRenderer: renderer,
    });
    apps.push(app);
    const course = await app.courses.create({ name: "算法", teacher: "李老师", term: "2026-fall", remoteCourseId: "_321_1" });
    app.store.replaceTeachingItems(course.courseId, ["assignment"], [{
      itemId: "pku3b:assignment:_assignment_1", courseId: course.courseId, provider: "pku3b", remoteId: "_assignment_1",
      remoteIdStable: true, kind: "assignment", title: "第一次作业", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);
    await mkdir(join(course.rootPath, "assignments", "assignment-1"), { recursive: true });
    await writeFile(join(course.rootPath, "assignments", "assignment-1", "draft.md"), "# 作业答案\n");
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const headers = { authorization: "Bearer test-token" };

    const exported = await instance.server.inject({ method: "POST", url: `/api/courses/${course.courseId}/assignments/_assignment_1/export`, headers });
    expect(exported.statusCode).toBe(200);
    const approved = await instance.server.inject({ method: "POST", url: `/api/courses/${course.courseId}/assignments/_assignment_1/approve`, headers, payload: {} });
    expect(approved.statusCode).toBe(201);
    const submitted = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/assignments/_assignment_1/submit`,
      headers,
      payload: { approvalId: approved.json().data.approvalId },
    });
    expect(submitted.statusCode).toBe(202);
    expect((await app.assignments.wait(submitted.json().jobId as string)).status).toBe("completed");
  });

  it("starts a controlled assignment attachment download job", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-assignment-download-"));
    const pku3b = {
      async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
        return { ok: true, data: { version: "0.16.0", supported: true } };
      },
      async runRead(): Promise<ToolResult<Pku3bOutput>> {
        return { ok: true, data: { stdout: "", stderr: "", version: "0.16.0" } };
      },
      async runWrite(command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>> {
        await mkdir(command.outdir, { recursive: true });
        await writeFile(join(command.outdir, "题目.pdf"), "fixture");
        return { ok: true, data: { stdout: "Done.", stderr: "", version: "0.16.0" } };
      },
    };
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b,
    });
    apps.push(app);
    const course = await app.courses.create({ name: "算法", teacher: "李老师", term: "2026-fall", remoteCourseId: "_321_1" });
    app.store.replaceTeachingItems(course.courseId, ["assignment"], [{
      itemId: "pku3b:assignment:_assignment_2", courseId: course.courseId, provider: "pku3b", remoteId: "_assignment_2",
      remoteIdStable: true, kind: "assignment", title: "第二次作业", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const response = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/assignments/_assignment_2/download`,
      headers: { authorization: "Bearer test-token" },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    expect((await app.teachingNetwork.wait(response.json().jobId as string)).status).toBe("completed");
    expect(response.json().data.message).toContain("作业题目");
  });

  it("returns structured announcement detail for a synchronized stable ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-announcement-detail-"));
    const pku3b = {
      async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
        return { ok: true, data: { version: "0.16.0", supported: true } };
      },
      async runRead(command: Pku3bReadCommand): Promise<ToolResult<Pku3bOutput>> {
        if (command.kind === "announcement-show") {
          return { ok: true, data: { stdout: "> 公告详情 <\n\n算法 > 课程通知\nID: _announcement_2\n发布时间: 2026-08-21 10:00\n\n请查看课程主页。\n\n[附件] syllabus.pdf\n", stderr: "", version: "0.16.0" } };
        }
        return { ok: true, data: { stdout: "", stderr: "", version: "0.16.0" } };
      },
      async runWrite(_command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>> {
        return { ok: true, data: { stdout: "Done.", stderr: "", version: "0.16.0" } };
      },
    };
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b,
    });
    apps.push(app);
    const course = await app.courses.create({ name: "算法", teacher: "李老师", term: "2026-fall", remoteCourseId: "_321_1" });
    app.store.replaceTeachingItems(course.courseId, ["announcement"], [{
      itemId: "pku3b:announcement:_announcement_2", courseId: course.courseId, provider: "pku3b", remoteId: "_announcement_2",
      remoteIdStable: true, kind: "announcement", title: "课程通知", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const response = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/announcements/_announcement_2/show`,
      headers: { authorization: "Bearer test-token" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ title: "课程通知", descriptions: ["请查看课程主页。"], attachments: ["syllabus.pdf"] });
  });

  it("indexes a course asset and searches only within that course", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-docs-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    apps.push(app);
    const course = await app.courses.create({ name: "机器学习", teacher: "李老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "lecture.md"), "# 梯度下降\n\n梯度下降用于优化损失函数。\n");
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);

    const indexed = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/documents/index`,
      headers: { authorization: "Bearer test-token" },
      payload: { path: "materials/text/lecture.md" },
    });
    expect(indexed.statusCode).toBe(200);
    expect(indexed.json().data).toHaveLength(2);

    const searched = await instance.server.inject({
      method: "GET",
      url: `/api/courses/${course.courseId}/documents/search?query=${encodeURIComponent("梯度下降")}`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(searched.statusCode).toBe(200);
    expect(searched.json().data[0].block.text).toContain("梯度下降");

    const forbidden = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/documents/index`,
      headers: { authorization: "Bearer test-token" },
      payload: { path: "../../outside.md" },
    });
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json().error.code).toBe("ASSET_PATH_FORBIDDEN");
  });

  it("rebuilds the course document index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-rebuild-"));
    const app = createApplication({ dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") });
    apps.push(app);
    const course = await app.courses.create({ name: "线性代数", teacher: "周老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "notes", "vectors.md"), "# 向量\n\n向量空间有基。\n");
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const response = await instance.server.inject({ method: "POST", url: `/api/courses/${course.courseId}/documents/rebuild`, headers: { authorization: "Bearer test-token" }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ assetCount: 1, blockCount: 2 });
  });

  it("returns confirmed note-source candidates from the indexed course", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-note-sources-"));
    const app = createApplication({ dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") });
    apps.push(app);
    const course = await app.courses.create({ name: "编译原理", teacher: "周老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "grammar.md"), "# 文法\n\n文法描述语言结构。\n");
    await writeFile(join(course.rootPath, "recordings", "transcripts", "lecture-1.md"), "# 录播\n\n讲解上下文无关文法。\n");
    await app.documents.indexAsset(course.courseId, "materials/text/grammar.md");
    await app.documents.indexAsset(course.courseId, "recordings/transcripts/lecture-1.md");
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const response = await instance.server.inject({
      method: "GET",
      url: `/api/courses/${course.courseId}/note-sources`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "materials/text/grammar.md", kind: "material" }),
      expect.objectContaining({ sourcePath: "recordings/transcripts/lecture-1.md", kind: "recording-transcript" }),
    ]));
  });

  it("lists and reads only complete named practice sets", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-practice-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    apps.push(app);
    const course = await app.courses.create({ name: "离散数学", teacher: "赵老师", term: "2026-fall" });
    await app.agent.savePracticeSet({
      courseId: course.courseId,
      practiceName: "集合练习",
      questionsMarkdown: "# 题目\n\n证明集合恒等式。",
      answersMarkdown: "# 答案\n\n使用德摩根律。",
    });
    await writeFile(join(course.rootPath, "practice", "partial-questions.md"), "# incomplete\n");
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const headers = { authorization: "Bearer test-token" };

    const listed = await instance.server.inject({
      method: "GET",
      url: `/api/courses/${course.courseId}/practice`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject([{ name: "集合练习" }]);
    expect(listed.json().data).toHaveLength(1);

    const selected = await instance.server.inject({
      method: "GET",
      url: `/api/courses/${course.courseId}/practice/${encodeURIComponent("集合练习")}`,
      headers,
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().data).toMatchObject({
      questionsMarkdown: expect.stringContaining("集合恒等式"),
      answersMarkdown: expect.stringContaining("德摩根律"),
    });

    const missing = await instance.server.inject({
      method: "GET",
      url: `/api/courses/${course.courseId}/practice/partial`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("PRACTICE_SET_NOT_FOUND");
  });

  it("creates an in-memory course agent session with only restricted tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-agent-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    apps.push(app);
    const course = await app.courses.create({ name: "概率论", teacher: "陈老师", term: "2026-fall" });
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);

    const created = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/sessions`,
      headers: { authorization: "Bearer test-token" },
      payload: { name: "概率复习" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ persistent: true, name: "概率复习" });
    expect(created.json().data.tools).toEqual([
      "search_course",
      "read_course_asset",
      "list_course_resources",
      "get_course_resource",
      "import_course_resource",
      "save_lecture_note",
      "save_assignment_draft",
      "save_practice_set",
      "get_job_status",
    ]);
    expect(created.json().data.tools).not.toContain("bash");
    expect(created.json().data.tools).not.toContain("write");
    expect(created.json().data.tools).not.toContain("submit_assignment");

    const closed = await instance.server.inject({
      method: "DELETE",
      url: `/api/sessions/${created.json().data.sessionId as string}`,
      headers: { authorization: "Bearer test-token" },
    });
    expect(closed.statusCode).toBe(204);
  });

  it("creates a lecture-notes session scoped to confirmed indexed sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-api-note-session-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    apps.push(app);
    const course = await app.courses.create({ name: "计算机网络", teacher: "孙老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "tcp.md"), "# TCP\n\n可靠传输。\n");
    await app.documents.indexAsset(course.courseId, "materials/text/tcp.md");
    const instance = await createServer({ app, apiToken: "test-token", logger: false });
    instances.push(instance);
    const headers = { authorization: "Bearer test-token" };

    const created = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/lecture-notes/session`,
      headers,
      payload: { sourcePaths: ["materials/text/tcp.md"] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({
      persistent: false,
      tools: ["read_course_asset", "save_lecture_note"],
    });

    const rejected = await instance.server.inject({
      method: "POST",
      url: `/api/courses/${course.courseId}/lecture-notes/session`,
      headers,
      payload: { sourcePaths: ["notes/private.md"] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("NOTE_SOURCE_NOT_AVAILABLE");
  });
});

import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication } from "../src/application.js";
import { PiAgentService, courseSkillNames, piToolNames } from "../src/agent/pi-agent-service.js";
import { HttpTreeholeProvider, type TreeholeProvider } from "../src/integrations/treehole/treehole-provider.js";
import type { PdfRenderer, ToolResult, TranscriptionProvider } from "../src/domain/types.js";
import type { AudioProcessor } from "../src/recordings/ffmpeg-audio-processor.js";
import { OpenAiTranscriptionProvider } from "../src/recordings/openai-transcription-provider.js";
import type {
  Pku3bOutput,
  Pku3bReadCommand,
  Pku3bWriteCommand,
} from "../src/integrations/pku3b/pku3b-adapter.js";
import type { Pku3bExecutor } from "../src/integrations/pku3b/teaching-network-service.js";
import { parseCourseContentList, parsePku3bVersion, stripAnsi } from "../src/integrations/pku3b/output.js";
import { MineruMarkdownParser, cosineSimilarity, normalizedMarkdown, reciprocalRankFusion } from "../src/documents/document-service.js";
import {
  parseAnnouncementList,
  parseAnnouncementDetail,
  parseAssignmentList,
  parseGrades,
  parseVideoList,
} from "../src/integrations/pku3b/status-output.js";

const contexts: ReturnType<typeof createApplication>[] = [];

afterEach(() => {
  for (const context of contexts.splice(0)) context.close();
});

class FakePku3b implements Pku3bExecutor {
  readonly reads: Pku3bReadCommand[] = [];
  readonly writes: Pku3bWriteCommand[] = [];
  needsOtp = false;

  async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
    return { ok: true, data: { version: "0.16.0", supported: true } };
  }

  async runRead(command: Pku3bReadCommand): Promise<ToolResult<Pku3bOutput>> {
    this.reads.push(command);
    if (this.needsOtp && !("otp" in command && command.otp)) {
      return {
        ok: false,
        error: { code: "PKU3B_AUTH_OTP_REQUIRED", message: "OTP required", retryable: true },
        requiresAction: "provide_otp",
      };
    }
    const fixture = command.kind === "course-content-list"
      ? "course-content-list.txt"
      : command.kind === "announcement-list"
        ? "announcement-list.txt"
        : command.kind === "assignment-list"
          ? "assignment-list.txt"
          : command.kind === "video-list"
            ? "video-list.txt"
            : "grades.txt";
    const stdout = await readFile(new URL(`./fixtures/pku3b-0.16/${fixture}`, import.meta.url), "utf8");
    return { ok: true, data: { stdout, stderr: "", version: "0.16.0" } };
  }

  async runWrite(command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>> {
    this.writes.push(command);
    if (this.needsOtp && !command.otp) {
      return {
        ok: false,
        error: { code: "PKU3B_AUTH_OTP_REQUIRED", message: "OTP required", retryable: true },
        requiresAction: "provide_otp",
      };
    }
    if ("outdir" in command) {
      await mkdir(command.outdir, { recursive: true });
      await writeFile(
        join(command.outdir, command.kind === "video-download" ? "recording.mp4" : "lecture.pdf"),
        "fixture",
      );
    }
    return { ok: true, data: { stdout: "Done.", stderr: "", version: "0.16.0" } };
  }
}

class FakeTreehole implements TreeholeProvider {
  readonly searches: string[] = [];

  async authStatus() {
    return { ok: true as const, data: { provider: "treehole" as const, authState: "ready" as const, updatedAt: new Date().toISOString() } };
  }

  async login() {
    return { ok: true as const, data: { provider: "treehole" as const, authState: "ready" as const, updatedAt: new Date().toISOString() } };
  }

  async searchPosts(input: { keyword: string }) {
    this.searches.push(input.keyword);
    return {
      ok: true as const,
      data: {
        keyword: input.keyword,
        posts: [{
          pid: "8001234",
          text: "这门课讲得很清楚。",
          commentCount: 1,
          comments: [{ commentId: "1", text: "作业较多。" }],
        }],
      },
    };
  }

  async getPost() {
    return {
      ok: true as const,
      data: { pid: "8001234", text: "这门课讲得很清楚。", commentCount: 0, comments: [] },
    };
  }

  async getComments() {
    return { ok: true as const, data: [] };
  }
}

describe("teaching-network sync", () => {
  it("syncs only the stably mapped remote course and imports into a controlled path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-sync-"));
    const fake = new FakePku3b();
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      pku3b: fake,
    });
    contexts.push(app);
    const course = await app.courses.create({
      name: "机器学习",
      teacher: "张老师",
      term: "2026-fall",
      remoteCourseId: "_123_1",
    });

    const sync = app.teachingNetwork.syncCourseContent(course.courseId);
    expect((await app.teachingNetwork.wait(sync.jobId)).status).toBe("completed");
    const resources = app.teachingNetwork.listResources(course.courseId);
    expect(resources).toHaveLength(2);
    expect(resources.every((resource) => resource.remoteCourseId === "_123_1")).toBe(true);
    expect(fake.reads[0]).toMatchObject({ kind: "course-content-list", allTerm: true });

    const imported = app.teachingNetwork.importResource(course.courseId, resources[0]!.resourceId);
    expect((await app.teachingNetwork.wait(imported.jobId)).status).toBe("completed");
    const saved = app.teachingNetwork.listResources(course.courseId)[0]!;
    expect(saved.isImported).toBe(true);
    expect(saved.localPath).toContain(join(course.rootPath, "materials", "original"));
    expect(await readFile(join(saved.localPath!, "lecture.pdf"), "utf8")).toBe("fixture");
    expect(fake.writes[0]).toMatchObject({
      kind: "course-content-download",
      outdir: join(course.rootPath, "materials", `.staging-${imported.jobId}`),
    });
  });

  it("pauses for an OTP and resumes without persisting the token in job context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-otp-"));
    const fake = new FakePku3b();
    fake.needsOtp = true;
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      pku3b: fake,
    });
    contexts.push(app);
    const course = await app.courses.create({
      name: "机器学习",
      teacher: "张老师",
      term: "2026-fall",
      remoteCourseId: "_123_1",
    });

    const sync = app.teachingNetwork.syncCourseContent(course.courseId);
    expect((await app.teachingNetwork.wait(sync.jobId)).status).toBe("waiting_for_auth");
    app.teachingNetwork.resume(sync.jobId, "123456");
    const completed = await app.teachingNetwork.wait(sync.jobId);
    expect(completed.status).toBe("completed");
    expect(fake.reads[1]).toMatchObject({ otp: "123456" });
    expect(JSON.stringify(app.store.getJobContext(sync.jobId))).not.toContain("123456");
    expect(JSON.stringify(completed)).not.toContain("123456");
  });

  it("reads structured announcement details by stable remote ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-announcement-detail-"));
    const fake = new FakePku3b();
    const originalRead = fake.runRead.bind(fake);
    fake.runRead = async (command) => {
      if (command.kind === "announcement-show") {
        return {
          ok: true,
          data: {
            stdout: await readFile(new URL("./fixtures/pku3b-0.16/announcement-show.txt", import.meta.url), "utf8"),
            stderr: "",
            version: "0.16.0",
          },
        };
      }
      return originalRead(command);
    };
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b: fake,
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "机器学习", teacher: "张老师", term: "2026-fall", remoteCourseId: "_123_1" });
    app.store.replaceTeachingItems(course.courseId, ["announcement"], [{
      itemId: "pku3b:announcement:_announcement_1", courseId: course.courseId, provider: "pku3b", remoteId: "_announcement_1",
      remoteIdStable: true, kind: "announcement", title: "第一次课程通知", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);
    await expect(app.teachingNetwork.getAnnouncement(course.courseId, "_announcement_1")).resolves.toEqual({
      courseId: course.courseId,
      announcementId: "_announcement_1",
      courseLabel: "机器学习",
      title: "第一次课程通知",
      publishedAt: "2026-08-20 09:30",
      descriptions: ["请在下周上课前阅读课程说明。", "课堂资料会在资源页持续更新。"],
      attachments: ["课程说明.pdf", "课程日历.xlsx"],
    });
    expect(parseAnnouncementDetail("not a detail", { courseId: course.courseId, announcementId: "x" })).toBeUndefined();
    await expect(app.teachingNetwork.getAnnouncement(course.courseId, "unstable"))
      .rejects.toMatchObject({ code: "ANNOUNCEMENT_NOT_FOUND" });
  });

  it("downloads stable assignment attachments into the fixed assignment workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-assignment-download-"));
    const fake = new FakePku3b();
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b: fake,
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "机器学习", teacher: "张老师", term: "2026-fall", remoteCourseId: "_123_1" });
    app.store.replaceTeachingItems(course.courseId, ["assignment"], [{
      itemId: "pku3b:assignment:_assignment_1", courseId: course.courseId, provider: "pku3b", remoteId: "_assignment_1",
      remoteIdStable: true, kind: "assignment", title: "第一次作业", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);

    const job = app.teachingNetwork.downloadAssignment(course.courseId, "_assignment_1");
    expect((await app.teachingNetwork.wait(job.jobId)).status).toBe("completed");
    expect(fake.writes.at(-1)).toMatchObject({
      kind: "assignment-download",
      id: "_assignment_1",
      outdir: join(course.rootPath, "assignments", "assignment-1", `.staging-${job.jobId}`),
    });
    expect(await readFile(join(course.rootPath, "assignments", "assignment-1", "original", "lecture.pdf"), "utf8")).toBe("fixture");

    const second = app.teachingNetwork.downloadAssignment(course.courseId, "_assignment_1");
    expect((await app.teachingNetwork.wait(second.jobId)).status).toBe("completed");
    expect(fake.writes.filter((write) => write.kind === "assignment-download")).toHaveLength(1);
    expect(() => app.teachingNetwork.downloadAssignment(course.courseId, "unstable"))
      .toThrow(expect.objectContaining({ code: "ASSIGNMENT_NOT_FOUND" }));
  });
});

describe("course workspace", () => {
  it("creates a portable manifest and current SQLite record", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
    });
    contexts.push(app);

    const course = await app.courses.create({
      name: "机器学习",
      teacher: "张老师",
      term: "2026-fall",
      remoteCourseId: "_123_1",
    });

    expect(app.courses.list()).toHaveLength(1);
    expect(await readFile(join(course.rootPath, "course.yaml"), "utf8")).toContain(
      "remoteCourseId: _123_1",
    );
    expect(await readFile(join(course.rootPath, "prompts", "notes.md"), "utf8")).toContain(
      "课堂笔记提示词",
    );
  });
});

describe("recording transcription", () => {
  it("writes and indexes timestamped Markdown while deleting reconstructable media", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-recording-"));
    const pku3b = new FakePku3b();
    const audioProcessor: AudioProcessor = {
      async split(input) {
        const filePath = join(input.outputDir, "audio-001.webm");
        await writeFile(filePath, "fixture-audio");
        return [{ filePath, startSeconds: 0, endSeconds: 75 }];
      },
    };
    const transcriptions: TranscriptionProvider = {
      id: "test:transcription",
      isAvailable: () => true,
      async transcribe() {
        return { text: "今天介绍梯度下降的基本思想。" };
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
      audioProcessor,
      transcriptions,
    });
    contexts.push(app);
    const course = await app.courses.create({
      name: "机器学习",
      teacher: "张老师",
      term: "2026-fall",
      remoteCourseId: "_123_1",
    });
    app.store.replaceTeachingItems(course.courseId, ["video"], [{
      itemId: "pku3b:video:_video_1",
      courseId: course.courseId,
      provider: "pku3b",
      remoteId: "_video_1",
      remoteIdStable: true,
      kind: "video",
      title: "第一讲",
      courseLabel: course.name,
      updatedAt: new Date().toISOString(),
    }]);
    await mkdir(join(app.paths.pku3bCacheDir, "video_download", "_video_1"), { recursive: true });
    await writeFile(join(app.paths.pku3bCacheDir, "video_download", "_video_1", "stale.mp4"), "old");
    await writeFile(join(app.paths.pku3bCacheDir, "ua.json"), "cookie");

    const job = app.recordings.transcribe(course.courseId, "_video_1");
    const completed = await app.recordings.wait(job.jobId);
    expect(completed).toMatchObject({ status: "completed", message: expect.stringMatching(/^recordings\/transcripts\//) });
    const transcript = await readFile(join(course.rootPath, completed.message!), "utf8");
    expect(transcript).toContain("[00:00:00–00:01:15] 今天介绍梯度下降的基本思想。");
    await expect(app.documents.search(course.courseId, "梯度下降")).resolves.toMatchObject([
      { block: { sourcePath: completed.message } },
    ]);
    await expect(readFile(join(app.paths.cacheDir, "recording-jobs", job.jobId))).rejects.toThrow();
    await expect(readFile(join(app.paths.pku3bCacheDir, "video_download", "_video_1", "stale.mp4"))).rejects.toThrow();
    expect(await readFile(join(app.paths.pku3bCacheDir, "ua.json"), "utf8")).toBe("cookie");
    expect(pku3b.writes).toContainEqual(expect.objectContaining({ kind: "video-download", id: "_video_1" }));
  });

  it("waits for an OTP without persisting it, then reruns the recording download", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-recording-otp-"));
    const pku3b = new FakePku3b();
    pku3b.needsOtp = true;
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      pku3b,
      audioProcessor: {
        async split(input) {
          const filePath = join(input.outputDir, "audio-001.webm");
          await writeFile(filePath, "audio");
          return [{ filePath, startSeconds: 0, endSeconds: 30 }];
        },
      },
      transcriptions: { id: "test:transcription", isAvailable: () => true, async transcribe() { return { text: "课程开始。" }; } },
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "算法", teacher: "李老师", term: "2026-fall", remoteCourseId: "_123_1" });
    app.store.replaceTeachingItems(course.courseId, ["video"], [{
      itemId: "pku3b:video:_video_2", courseId: course.courseId, provider: "pku3b", remoteId: "_video_2",
      remoteIdStable: true, kind: "video", title: "第一讲", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);

    const job = app.recordings.transcribe(course.courseId, "_video_2");
    expect((await app.recordings.wait(job.jobId)).status).toBe("waiting_for_auth");
    app.recordings.resume(job.jobId, "123456");
    expect((await app.recordings.wait(job.jobId)).status).toBe("completed");
    expect(JSON.stringify(app.store.getJobContext(job.jobId))).not.toContain("123456");
    expect(JSON.stringify(pku3b.writes)).toContain("123456");
  });
});

describe("OpenAI transcription provider", () => {
  it("uses the file transcription endpoint with prompt, keyword and language hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-openai-transcribe-"));
    const audioPath = join(root, "recording.webm");
    await writeFile(audioPath, "fixture-audio");
    const calls: Array<{ url: string; form: FormData }> = [];
    const provider = new OpenAiTranscriptionProvider({
      apiKey: "test-key",
      baseUrl: "https://openai.example/v1/",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), form: init?.body as FormData });
        return new Response(JSON.stringify({ text: "转写完成。" }), { status: 200 });
      },
    });

    await expect(provider.transcribe({
      filePath: audioPath,
      prompt: "机器学习课程，教师张老师。",
      keywords: ["梯度下降"],
      languages: ["zh-cn", "en"],
    })).resolves.toEqual({ text: "转写完成。" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openai.example/v1/audio/transcriptions");
    expect(calls[0]!.form.get("model")).toBe("gpt-transcribe");
    expect(calls[0]!.form.get("prompt")).toBe("机器学习课程，教师张老师。");
    expect(calls[0]!.form.getAll("keywords[]")).toEqual(["梯度下降"]);
    expect(calls[0]!.form.getAll("languages[]")).toEqual(["zh-cn", "en"]);
  });
});

describe("assignment approval and submission", () => {
  it("binds approval to the exported PDF hash, requires OTP, and consumes approval after success", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-assignment-"));
    const pku3b = new FakePku3b();
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
    contexts.push(app);
    const course = await app.courses.create({ name: "算法", teacher: "李老师", term: "2026-fall", remoteCourseId: "_123_1" });
    app.store.replaceTeachingItems(course.courseId, ["assignment"], [{
      itemId: "pku3b:assignment:_assignment_1", courseId: course.courseId, provider: "pku3b", remoteId: "_assignment_1",
      remoteIdStable: true, kind: "assignment", title: "第一次作业", courseLabel: course.name, updatedAt: new Date().toISOString(),
    }]);
    await mkdir(join(course.rootPath, "assignments", "assignment-1"), { recursive: true });
    await writeFile(join(course.rootPath, "assignments", "assignment-1", "draft.md"), "# 作业答案\n\n初稿。\n");

    await expect(app.pdf.exportAssignment(course.courseId, "_assignment_1")).resolves.toEqual({
      assignmentId: "_assignment_1",
      sourcePath: "assignments/assignment-1/answer.pdf",
    });
    const approval = await app.assignments.approve(course.courseId, "_assignment_1");
    expect(approval.sha256).toHaveLength(64);
    pku3b.needsOtp = true;
    const submit = app.assignments.submit(course.courseId, "_assignment_1", approval.approvalId);
    expect((await app.assignments.wait(submit.jobId)).status).toBe("waiting_for_auth");
    app.assignments.resume(submit.jobId, "123456");
    expect((await app.assignments.wait(submit.jobId)).status).toBe("completed");
    expect(app.store.getAssignmentApproval(approval.approvalId)).toBeUndefined();
    expect(JSON.stringify(app.store.getJobContext(submit.jobId))).not.toContain("123456");
    expect(pku3b.writes).toContainEqual(expect.objectContaining({ kind: "assignment-submit", id: "_assignment_1", path: join(course.rootPath, "assignments", "assignment-1", "answer.pdf") }));

    pku3b.needsOtp = false;
    const nextApproval = await app.assignments.approve(course.courseId, "_assignment_1");
    await writeFile(join(course.rootPath, "assignments", "assignment-1", "answer.pdf"), "%PDF-changed");
    const stale = app.assignments.submit(course.courseId, "_assignment_1", nextApproval.approvalId);
    const staleJob = await app.assignments.wait(stale.jobId);
    expect(staleJob).toMatchObject({ status: "failed", errorCode: "ASSIGNMENT_APPROVAL_STALE" });
    expect(app.store.getAssignmentApproval(nextApproval.approvalId)).toBeUndefined();
  });
});

describe("course candidates and treehole evidence", () => {
  it("keeps live post text out of persisted candidate records while retaining the final conclusion and PIDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-candidate-"));
    const treehole = new FakeTreehole();
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      treehole,
    });
    contexts.push(app);

    const candidate = app.candidates.create({
      name: "操作系统", teacher: "李老师", aliases: ["OS", "os", "计算机系统"] ,
    });
    expect(candidate).toMatchObject({ status: "followed", aliases: ["OS", "计算机系统"] });

    const result = await app.candidates.collectEvidence(candidate.candidateId);
    expect(treehole.searches).toContain("操作系统 李老师");
    expect(result.evidence.posts).toMatchObject([{ pid: "8001234", comments: [{ text: "作业较多。" }] }]);

    const reviewed = app.candidates.saveReview(candidate.candidateId, {
      teachingClarity: 5,
      contentValue: 4,
      grading: 3,
      workload: 2,
      predictability: 4,
      overall: 4,
      confidence: "medium",
      summary: "讲解清晰，但作业需要提前安排。",
      positives: ["讲解清晰"],
      negatives: ["作业较多"],
      relatedPids: ["8001234", "8001234"],
    });
    expect(reviewed.review).toMatchObject({ overall: 4, relatedPids: ["8001234"] });
    expect(app.store.db.prepare("SELECT aliases_json FROM course_candidates").get()).not.toMatchObject({
      aliases_json: expect.stringContaining("这门课讲得很清楚"),
    });
  });

  it("uses caller-provided, in-memory headers for the documented list-comments endpoint", async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const provider = new HttpTreeholeProvider({
      baseUrl: "https://treehole.example",
      getHeaders: () => ({ authorization: "Bearer ephemeral" }),
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
        return new Response(JSON.stringify({
          code: 20000,
          data: {
            list: [{ pid: 8001234, text: "课程评价", comment_total: 1, comment_list: [{ cid: 7, text: "有帮助" }] }],
          },
        }));
      },
    });

    await expect(provider.searchPosts({ keyword: "操作系统", limit: 5, commentLimit: 2 })).resolves.toMatchObject({
      ok: true,
      data: { posts: [{ pid: "8001234", comments: [{ commentId: "7" }] }] },
    });
    expect(calls).toEqual([{ url: "https://treehole.example/chapi/api/v3/hole/list_comments?keyword=%E6%93%8D%E4%BD%9C%E7%B3%BB%E7%BB%9F&page=1&limit=5&comment_limit=2", authorization: "Bearer ephemeral" }]);
  });

  it("creates an in-memory Treehole session through PKU OAuth, SSO and mobile-token verification", async () => {
    const calls: Array<{ url: string; authorization?: string; body?: string }> = [];
    let authChecks = 0;
    const provider = new HttpTreeholeProvider({
      baseUrl: "https://treehole.example",
      oauthLoginUrl: "https://iaaa.example/oauthlogin.do",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, authorization: headers.get("authorization") ?? undefined, body: typeof init?.body === "string" ? init.body : undefined });
        if (url === "https://iaaa.example/oauthlogin.do") {
          return new Response(JSON.stringify({ success: true, token: "iaaa-sso-token" }));
        }
        if (url.startsWith("https://treehole.example/cas_iaaa_login")) {
          return new Response(JSON.stringify({ token: "treehole-session-token" }));
        }
        if (url === "https://treehole.example/api/mail/un_read") {
          authChecks += 1;
          return new Response(JSON.stringify(authChecks === 1
            ? { success: false, message: "请进行令牌验证" }
            : { success: true }));
        }
        if (url === "https://treehole.example/api/login_iaaa_check_token") {
          expect(headers.get("authorization")).toBe("Bearer treehole-session-token");
          return new Response(JSON.stringify({ success: true, token: "verified-session-token" }));
        }
        if (url.startsWith("https://treehole.example/chapi/api/v3/hole/list_comments")) {
          return new Response(JSON.stringify({ code: 20000, data: { list: [] } }));
        }
        throw new Error(`Unexpected Treehole request: ${url}`);
      },
    });

    await expect(provider.login({ username: "student", password: "secret", verificationCode: "123456" }))
      .resolves.toMatchObject({ ok: true, data: { authState: "ready" } });
    await expect(provider.searchPosts({ keyword: "算法" })).resolves.toMatchObject({ ok: true, data: { posts: [] } });
    const searchCall = calls.find((call) => call.url.startsWith("https://treehole.example/chapi/api/v3/hole/list_comments"));
    expect(searchCall).toMatchObject({ authorization: "Bearer verified-session-token" });
    expect(searchCall?.body).toBeUndefined();
  });
});

describe("restricted Pi tools", () => {
  it("uses indexed reads and fixed course destinations without exposing shell, generic writes or submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-agent-"));
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "操作系统", teacher: "李老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "process.md"), "# 进程\n\n进程调度需要保存上下文。\n");
    const indexed = await app.documents.indexAsset(course.courseId, "materials/text/process.md");

    await expect(app.agent.searchCourse({ courseId: course.courseId, query: "进程调度" })).resolves.toMatchObject({
      ok: true,
      data: [{ block: { sourcePath: "materials/text/process.md" } }],
    });
    const indexedRead = await app.agent.readCourseAsset({
      courseId: course.courseId,
      sourcePath: indexed[0]!.sourcePath,
    });
    expect(indexedRead).toMatchObject({ ok: true });
    if (indexedRead.ok) expect(indexedRead.data.map((block) => block.text)).toContain("进程");
    await expect(app.agent.readCourseAsset({ courseId: course.courseId, sourcePath: "../../outside.md" })).resolves.toMatchObject({
      ok: false,
      error: { code: "DOCUMENT_NOT_INDEXED" },
    });

    const note = await app.agent.saveLectureNote({
      courseId: course.courseId,
      noteName: "Week 1 / 进程",
      markdown: "# 调度\n\n保存寄存器状态。",
    });
    const draft = await app.agent.saveAssignmentDraft({
      courseId: course.courseId,
      assignmentId: "../assignment-1",
      markdown: "# 解答\n\n草稿内容。",
    });
    const practice = await app.agent.savePracticeSet({
      courseId: course.courseId,
      practiceName: "进程练习",
      questionsMarkdown: "# 题目\n\n什么是上下文切换？",
      answersMarkdown: "# 答案\n\n保存与恢复执行状态。",
    });
    expect(note).toMatchObject({ ok: true, data: { sourcePath: "notes/week-1-进程.md" } });
    expect(draft).toMatchObject({ ok: true, data: { sourcePath: "assignments/assignment-1/draft.md" } });
    expect(practice).toMatchObject({
      ok: true,
      data: { questionsPath: "practice/进程练习-questions.md", answersPath: "practice/进程练习-answers.md" },
    });
    if (note.ok) expect(await readFile(join(course.rootPath, note.data.sourcePath), "utf8")).toContain("保存寄存器");
    if (draft.ok) expect(await readFile(join(course.rootPath, draft.data.sourcePath), "utf8")).toContain("草稿内容");
    if (practice.ok) expect(await readFile(join(course.rootPath, practice.data.answersPath), "utf8")).toContain("保存与恢复");
    await writeFile(join(course.rootPath, "practice", "incomplete-questions.md"), "# 未完成\n");
    await expect(app.courses.listPracticeSets(course.courseId)).resolves.toMatchObject([
      { name: "进程练习", questionsPath: "practice/进程练习-questions.md", answersPath: "practice/进程练习-answers.md" },
    ]);
    await expect(app.courses.readPracticeSet(course.courseId, "进程练习")).resolves.toMatchObject({
      name: "进程练习",
      questionsMarkdown: expect.stringContaining("上下文切换"),
      answersMarkdown: expect.stringContaining("恢复执行状态"),
    });
    await expect(app.documents.search(course.courseId, "保存寄存器")).resolves.toMatchObject([
      { block: { sourcePath: "notes/week-1-进程.md" } },
    ]);

    let capturedOptions: Parameters<NonNullable<ConstructorParameters<typeof PiAgentService>[0]["sessionFactory"]>>[0] | undefined;
    const agent = new PiAgentService({
      store: app.store,
      courses: app.courses,
      jobs: app.jobs,
      teachingNetwork: app.teachingNetwork,
      documents: app.documents,
      candidates: app.candidates,
      agentDir: join(root, "config", "pi-agent"),
      sessionDir: join(root, "data", "agent-sessions"),
      sessionFactory: async (options) => {
        capturedOptions = options;
        return {} as Awaited<ReturnType<NonNullable<ConstructorParameters<typeof PiAgentService>[0]["sessionFactory"]>>>;
      },
    });
    await agent.createCourseSession(course.courseId);

    expect(capturedOptions).toMatchObject({ noTools: "builtin", tools: [...piToolNames] });
    expect(capturedOptions?.sessionManager?.getSessionFile()).toBeUndefined();
    const registered = capturedOptions?.customTools?.map((tool) => tool.name) ?? [];
    expect(registered).toEqual([...piToolNames]);
    expect(registered).not.toEqual(expect.arrayContaining(["bash", "write", "edit", "submit_assignment"]));
    const skills = capturedOptions?.resourceLoader?.getSkills().skills ?? [];
    expect(skills.map((skill) => skill.name).sort()).toEqual([...courseSkillNames].sort());
    expect(skills.every((skill) => skill.disableModelInvocation)).toBe(true);
    expect(skills.every((skill) => skill.filePath.startsWith(join(root, "config", "pi-agent", "pku-study-skills")))).toBe(true);
    expect(await readFile(join(root, "config", "pi-agent", "pku-study-skills", "lecture-notes", "SKILL.md"), "utf8")).toContain(
      "save_lecture_note",
    );

    await writeFile(join(course.rootPath, "recordings", "transcripts", "week-1.md"), "# 转写\n\n进程调度。\n");
    await app.documents.indexAsset(course.courseId, "recordings/transcripts/week-1.md");
    await agent.createLectureNotesSession(course.courseId, {
      sourcePaths: ["materials/text/process.md", "recordings/transcripts/week-1.md"],
    });
    expect(capturedOptions).toMatchObject({
      noTools: "builtin",
      tools: ["read_course_asset", "save_lecture_note"],
    });
    expect(capturedOptions?.customTools?.map((tool) => tool.name)).toEqual([
      "read_course_asset",
      "save_lecture_note",
    ]);
    expect(capturedOptions?.resourceLoader?.getSkills().skills.map((skill) => skill.name)).toEqual(["lecture-notes"]);
    const scopedRead = capturedOptions?.customTools?.find((tool) => tool.name === "read_course_asset");
    if (!scopedRead) throw new Error("Lecture-notes read tool was not registered.");
    const rejectedRead = await scopedRead.execute(
      "test-call",
      { sourcePath: "notes/week-1-进程.md" },
      undefined,
      undefined,
      {} as never,
    );
    expect(rejectedRead.details).toMatchObject({
      envelope: { ok: false, error: { code: "NOTE_SOURCE_NOT_SELECTED" } },
    });
    await expect(agent.createLectureNotesSession(course.courseId, {
      sourcePaths: ["notes/not-an-allowed-source.md"],
    })).rejects.toMatchObject({ code: "NOTE_SOURCE_NOT_AVAILABLE" });
  });

  it("persists and resumes only explicitly named course sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-named-agent-"));
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "编译原理", teacher: "周老师", term: "2026-fall" });

    const created = await app.agent.createCourseSession(course.courseId, { name: "期末复习" });
    expect(created.session.sessionManager.isPersisted()).toBe(true);
    expect(created.session.sessionManager.getSessionName()).toBe("期末复习");
    expect(created.session.getActiveToolNames()).not.toEqual(
      expect.arrayContaining(["review_course_candidate", "ask_treehole"]),
    );
    expect(created.session.resourceLoader.getSkills().skills.map((skill) => skill.name)).not.toEqual(
      expect.arrayContaining(["course-review", "treehole-qa"]),
    );
    const sessionId = created.session.sessionId;
    created.session.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "复习重点是什么？" }],
      timestamp: Date.now(),
    } as never);
    created.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "先复习语法分析。" }],
      timestamp: Date.now(),
    } as never);
    created.session.dispose();

    await expect(app.agent.listCourseSessions(course.courseId)).resolves.toMatchObject([
      { sessionId, name: "期末复习", messageCount: 2, firstMessage: "复习重点是什么？" },
    ]);
    const resumed = await app.agent.resumeCourseSession(course.courseId, sessionId);
    expect(resumed.session.sessionId).toBe(sessionId);
    expect(resumed.session.sessionManager.isPersisted()).toBe(true);
    resumed.session.dispose();
    await expect(app.agent.resumeCourseSession(course.courseId, "not-a-real-session")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });
});

describe("document indexing", () => {
  it("parses Markdown headings, indexes blocks and enforces the workspace boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-docs-"));
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      embeddings: new FakeEmbeddings(),
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "数学分析", teacher: "王老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "limits.md"), "# 极限\n\n极限描述函数在邻域中的行为。\n## 连续性\n\n连续函数满足局部性质。\n");

    const blocks = await app.documents.indexAsset(course.courseId, "materials/text/limits.md");
    expect(blocks.map((block) => block.contentType)).toEqual(["heading", "paragraph", "heading", "paragraph"]);
    expect((await app.documents.search(course.courseId, "连续函数"))[0]!.block.text).toContain("连续函数");
    await expect(app.documents.search(course.courseId, "连续函数 (")).resolves.toEqual(expect.any(Array));
    await expect(app.documents.indexAsset(course.courseId, "../../outside.md")).rejects.toMatchObject({
      code: "ASSET_PATH_FORBIDDEN",
    });
    await writeFile(join(root, "outside.md"), "机密内容\n");
    await symlink(
      join(root, "outside.md"),
      join(course.rootPath, "materials", "text", "outside-link.md"),
    );
    await expect(app.documents.indexAsset(course.courseId, "materials/text/outside-link.md")).rejects.toMatchObject({
      code: "ASSET_PATH_FORBIDDEN",
    });
  });

  it("groups only indexed course materials and recording transcripts as note sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-note-sources-"));
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "操作系统", teacher: "李老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "lecture.md"), "# 进程\n\n进程切换保存上下文。\n");
    await writeFile(join(course.rootPath, "recordings", "transcripts", "week-1.md"), "# 课堂转写\n\n介绍进程调度。\n");
    await writeFile(join(course.rootPath, "notes", "private.md"), "# 私人笔记\n\n不应成为素材。\n");
    await app.documents.indexAsset(course.courseId, "materials/text/lecture.md");
    await app.documents.indexAsset(course.courseId, "recordings/transcripts/week-1.md");

    expect(app.documents.listNoteSources(course.courseId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "materials/text/lecture.md", kind: "material", blockCount: 2 }),
      expect.objectContaining({ sourcePath: "recordings/transcripts/week-1.md", kind: "recording-transcript", blockCount: 2 }),
    ]));
    expect(app.documents.listNoteSources(course.courseId)).toHaveLength(2);
  });

  it("normalizes parsed PDF blocks with page markers and indexes the portable Markdown asset", async () => {
    const parser = new MineruMarkdownParser();
    const parsed = await parser.parse({
      filePath: "lecture.pdf",
      content: "<!-- page: 1 -->\n# 第一讲\n\n梯度下降。\n\n<!-- page_number: 2 -->\n## 第二讲\n\n反向传播。\n",
    });
    expect(parsed.blocks.map((block) => block.page)).toEqual([1, 1, 2, 2]);
    expect(normalizedMarkdown(parsed)).toContain("<!-- page: 2 -->");

    const root = await mkdtemp(join(tmpdir(), "pku-study-pdf-"));
    const app = createApplication({
      paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") },
      documentParser: { parse: async () => parsed },
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "深度学习", teacher: "孙老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "original", "lecture.pdf"), "fixture pdf");
    const blocks = await app.documents.parseAsset(course.courseId, "materials/original/lecture.pdf");
    expect(blocks[0]?.sourcePath).toMatch(/^materials[\\/]text[\\/]parsed[\\/]/);
    expect(blocks[2]).toMatchObject({ page: 2, text: "第二讲" });
    expect(await readFile(join(course.rootPath, blocks[0]!.sourcePath), "utf8")).toContain("<!-- page: 1 -->");
  });
});

describe("hybrid document search", () => {
  it("uses cosine similarity and reciprocal-rank fusion for indexed vectors", async () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(reciprocalRankFusion(["full-text", "both"], ["semantic", "both"])[0]?.blockId).toBe("both");
    const root = await mkdtemp(join(tmpdir(), "pku-study-hybrid-"));
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses"),
      },
      embeddings: new FakeEmbeddings(),
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "算法", teacher: "陈老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "search.md"), "# 搜索\n\n二分查找适合有序数组。\n\n图搜索用于遍历节点。\n");
    await app.documents.indexAsset(course.courseId, "materials/text/search.md");
    expect((await app.documents.search(course.courseId, "binary query"))[0]!.block.text).toContain("二分查找");
  });

  it("keeps full-text indexing available when the embedding provider fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-embedding-fallback-"));
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses"),
      },
      embeddings: { id: "test:failing", isAvailable: () => true, embed: async () => { throw new Error("offline"); } },
    });
    contexts.push(app);
    const course = await app.courses.create({ name: "数据库", teacher: "赵老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "materials", "text", "index.md"), "# 索引\n\nB 树减少磁盘访问。\n");
    await expect(app.documents.indexAsset(course.courseId, "materials/text/index.md")).resolves.toHaveLength(2);
    await expect(app.documents.search(course.courseId, "B 树")).resolves.toHaveLength(1);
  });

  it("rebuilds only the supported course text directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-reindex-"));
    const app = createApplication({ paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") } });
    contexts.push(app);
    const course = await app.courses.create({ name: "物理", teacher: "刘老师", term: "2026-fall" });
    await writeFile(join(course.rootPath, "notes", "week1.md"), "# 力学\n\n牛顿定律。\n");
    await writeFile(join(course.rootPath, "materials", "original", "ignored.md"), "不应自动索引");
    await expect(app.documents.rebuildCourseIndex(course.courseId)).resolves.toEqual({ assetCount: 1, blockCount: 2 });
    expect((await app.documents.search(course.courseId, "牛顿"))).toHaveLength(1);
    expect((await app.documents.search(course.courseId, "不应自动索引"))).toHaveLength(0);
  });
});

class FakeEmbeddings {
  readonly id = "test:embeddings";
  isAvailable(): boolean { return true; }
  async embed(input: string[]): Promise<number[][]> {
    return input.map((text) => {
      const lower = text.toLowerCase();
      return [lower.includes("二分") || lower.includes("binary") ? 1 : 0, lower.includes("图搜索") ? 1 : 0];
    });
  }
}

describe("job state machine", () => {
  it("rejects illegal terminal-state transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-job-"));
    const app = createApplication({
      dataDir: join(root, "data"),
      configDir: join(root, "config"),
      cacheDir: join(root, "cache"),
      coursesDir: join(root, "courses"),
      databasePath: join(root, "state.sqlite"),
    });
    contexts.push(app);
    const job = app.jobs.create("course-sync");
    app.jobs.update(job.jobId, { status: "running", progress: 0.5 });
    app.jobs.update(job.jobId, { status: "completed", progress: 1 });
    expect(() => app.jobs.update(job.jobId, { status: "running" })).toThrow(
      "Invalid job transition",
    );
  });
});

describe("pku3b output", () => {
  it("parses versions, removes ANSI and retains remote IDs", () => {
    expect(parsePku3bVersion("pku3b 0.16.0")).toBe("0.16.0");
    expect(stripAnsi("\u001b[31mError\u001b[0m")).toBe("Error");
    const parsed = parseCourseContentList(
      "\u001b[36m机器学习 (2026 Fall)\u001b[0m\n• (Document) 第一讲 [2 附件] _123_1:_456_1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(parsed[0]?.resource.remoteCourseId).toBe("_123_1");
    expect(parsed[0]?.resource.remoteResourceId).toBe("_123_1:_456_1");
    expect(parsed[0]?.attachmentCount).toBe(2);
  });

  it("parses the versioned overview output fixtures", () => {
    const courseId = "11111111-1111-4111-8111-111111111111";
    const syncedAt = new Date("2026-08-13T00:00:00.000Z");
    const readFixture = async (name: string) =>
      readFile(new URL(`./fixtures/pku3b-0.16/${name}`, import.meta.url), "utf8");

    return Promise.all([
      readFixture("announcement-list.txt"),
      readFixture("assignment-list.txt"),
      readFixture("video-list.txt"),
      readFixture("grades.txt"),
    ]).then(([announcements, assignments, videos, grades]) => {
      expect(parseAnnouncementList(announcements, { courseId, syncedAt })).toHaveLength(3);
      expect(parseAssignmentList(assignments, { courseId, syncedAt })[0]).toMatchObject({
        remoteId: "asg-001",
        dueText: "in 2d 3h 4m 5s",
        completed: false,
      });
      expect(parseAssignmentList(assignments, { courseId, syncedAt })[1]).toMatchObject({
        remoteId: "asg-000",
        completed: true,
      });
      expect(parseVideoList(videos, { courseId, syncedAt })).toHaveLength(3);
      expect(parseGrades(grades, { courseId, syncedAt })).toHaveLength(3);
      expect(parseGrades(grades, { courseId, syncedAt })[0]).toMatchObject({
        title: "作业 1",
        score: 88,
        possibleScore: 100,
      });
    });
  });
});

describe("teaching-network overview sync", () => {
  it("stores only current-course announcements, assignments, videos and grades", async () => {
    const root = await mkdtemp(join(tmpdir(), "pku-study-overview-"));
    const fake = new FakePku3b();
    const app = createApplication({
      paths: {
        dataDir: join(root, "data"),
        configDir: join(root, "config"),
        cacheDir: join(root, "cache"),
        coursesDir: join(root, "courses"),
      },
      pku3b: fake,
    });
    contexts.push(app);
    const course = await app.courses.create({
      name: "机器学习",
      teacher: "张老师",
      term: "2026-fall",
      remoteCourseId: "_123_1",
    });

    const sync = app.teachingNetwork.syncCourseOverview(course.courseId);
    expect((await app.teachingNetwork.wait(sync.jobId)).status).toBe("completed");
    const items = app.teachingNetwork.listTeachingItems(course.courseId);
    expect(Object.fromEntries(
      ["announcement", "assignment", "video", "grade"].map((kind) => [
        kind,
        items.filter((item) => item.kind === kind).length,
      ]),
    )).toEqual({ announcement: 1, assignment: 2, video: 2, grade: 2 });
    expect(items.every((item) => item.courseLabel.includes("机器学习"))).toBe(true);
    expect(app.teachingNetwork.listTeachingItems(course.courseId, "grade")).toHaveLength(2);
  });
});

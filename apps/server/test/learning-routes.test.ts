import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApplication, type CreateApplicationOptions } from "@pku-study/core";
import { createServer } from "../src/server.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(options: CreateApplicationOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "learning-api-"));
  const app = createApplication({ ...options, paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") }, embeddings: { id: "off", isAvailable: () => false, embed: async () => [] } });
  const instance = await createServer({ app, apiToken: "learning-token", logger: false });
  cleanups.push(async () => { await instance.close(); app.close(); await rm(root, { recursive: true, force: true }); });
  const course = await app.courses.create({ name: "概率", teacher: "教师", term: "秋" });
  return { app, course, server: instance.server, headers: { authorization: "Bearer learning-token" }, base: `/api/courses/${course.courseId}` };
}
it("serves structured resource details, preserves downloaded identity and keeps snapshots on failed sync", async () => {
  let fail = false;
  const id = "_1_1", sectionId = `${id}:section:_10_1`, remoteId = `${id}:_11_1`;
  const { app, server, headers } = await setup({ pku3b: {
    version: async () => ({ ok: true, data: { version: "0.16.0", supported: true } }),
    runRead: async () => { throw new Error("CLI text must not be read"); },
    runWrite: async () => { throw new Error("CLI download must not be used"); },
    structured: {
      listCourses: async () => ({ ok: true, data: [{ remoteCourseId: id, title: "数学(秋)", isCurrent: true }] }),
      readCourse: async () => fail ? { ok: false, error: { code: "TEACHING_HTTP_FAILED", message: "failed", retryable: true } } : { ok: true, data: {
        schemaVersion: 1, remoteCourseId: id, fetchedAt: new Date().toISOString(), contents: [
          { remoteResourceId: sectionId, title: "课件", kind: "section", sourceUrl: "https://course.pku.edu.cn/section", descriptions: [], attachments: [] },
          { remoteResourceId: remoteId, parentRemoteId: sectionId, title: "Lecture", kind: "document", sourceUrl: "https://course.pku.edu.cn/content", descriptions: ["课程说明"], attachments: [{ name: "slides.md", url: "https://course.pku.edu.cn/private-link" }] },
        ],
      } },
      downloadResource: async (_content, _course, directory) => {
        await writeFile(join(directory, "slides.md"), "# Lecture\n\nStructured download.");
        return { ok: true, data: { version: "0.16.0" } };
      },
    },
  } });
  const discovered = await server.inject({ method: "POST", url: "/api/teaching-network/courses/discover", headers, payload: {} });
  expect(discovered.json().data[0].remoteCourseId).toBe(id);
  const course = await app.courseDiscovery.import({ remoteCourseId: id, title: "数学(秋)" });
  const sync = () => app.teachingNetwork.wait(app.teachingNetwork.syncCourseContent(course.courseId).jobId);
  expect((await sync()).status).toBe("completed");
  const resource = app.teachingNetwork.listResources(course.courseId).find(r => r.remoteResourceId === remoteId)!;
  const url = `/api/courses/${course.courseId}/remote-resources/${resource.resourceId}`;
  expect((await server.inject({ method: "GET", url })).statusCode).toBe(401);
  const detail = await server.inject({ method: "GET", url, headers });
  expect(detail.json().data).toMatchObject({ descriptions: ["课程说明"], attachments: [{ name: "slides.md" }], detailsAvailable: true });
  expect(detail.body).not.toContain("private-link");
  const other = await app.courses.create({ name: "Other", term: "fall", teacher: "T", remoteCourseId: "_2_1" });
  expect((await server.inject({ method: "GET", url: `/api/courses/${other.courseId}/remote-resources/${resource.resourceId}`, headers })).statusCode).toBe(404);
  expect(app.teachingNetwork.resourceTree(course.courseId)[0]!.children[0]!.resourceId).toBe(resource.resourceId);
  const section = app.teachingNetwork.listResources(course.courseId).find(r => r.kind === "section")!;
  expect(() => app.teachingNetwork.importResource(course.courseId, section.resourceId)).toThrow("展开");
  expect((await app.teachingNetwork.wait(app.teachingNetwork.importResource(course.courseId, resource.resourceId).jobId)).status).toBe("completed");
  expect((await sync()).status).toBe("completed");
  expect(app.teachingNetwork.getResourceDetail(course.courseId, resource.resourceId).isImported).toBe(true);
  fail = true;
  expect((await sync()).status).toBe("failed");
  expect(app.teachingNetwork.listResources(course.courseId)).toHaveLength(2);
  expect(app.teachingNetwork.getResourceDetail(course.courseId, resource.resourceId).descriptions).toEqual(["课程说明"]);
});
it("uploads and parses a book, selects one passage, saves and reads the document through authenticated APIs", async () => {
  const { server, app, course, headers, base } = await setup();
  expect((await server.inject({ method: "GET", url: `${base}/lessons` })).statusCode).toBe(401);
  const uploaded = await server.inject({ method: "POST", url: `${base}/materials?filename=book.md&role=textbook`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("# 概率\n\n独立性的定义。\n\n未讲章节。") });
  expect(uploaded.statusCode).toBe(200);
  const material = uploaded.json().data;
  const parsed = await server.inject({ method: "POST", url: `${base}/materials/${material.assetId}/parse`, headers });
  expect(parsed.json().data.status).toBe("ready");
  const blocks = app.documents.readIndexedAsset(course.courseId, parsed.json().data.sourcePath);
  const created = await server.inject({ method: "POST", url: `${base}/lessons`, headers, payload: { title: "第一节" } });
  expect(created.statusCode).toBe(200);
  const lessonUrl = `${base}/lessons/${created.json().data.lessonId}`;
  const outline = await server.inject({ method: "PUT", url: `${lessonUrl}/outline`, headers, payload: { revision: 0, outline: { basis: "manual", topics: [{ topicId: "p", title: "独立性", summary: "定义" }] } } });
  expect(outline.statusCode).toBe(200);
  const selections = await server.inject({ method: "PUT", url: `${lessonUrl}/selections`, headers, payload: { revision: 1, selections: [{ topicId: "p", sourcePath: parsed.json().data.sourcePath, blockIds: [blocks[1]!.blockId], reason: "定义所在段" }] } });
  expect(selections.statusCode).toBe(200);
  const saved = await server.inject({ method: "PUT", url: `${lessonUrl}/document`, headers, payload: { revision: 2, markdown: "# 独立性\n我的笔记" } });
  expect(saved.statusCode).toBe(200);
  const stale = await server.inject({ method: "PUT", url: `${lessonUrl}/document`, headers, payload: { revision: 2, markdown: "旧结果" } });
  expect(stale.statusCode).toBe(409);
  const read = await server.inject({ method: "GET", url: lessonUrl, headers });
  expect(read.json().data.document.markdown).toContain("我的笔记");
  const sources = await server.inject({ method: "GET", url: `${lessonUrl}/sources`, headers });
  expect(sources.json().data[0].blocks).toHaveLength(1);
  expect(JSON.stringify(sources.json())).not.toContain("未讲章节");
});

it("runs discovery, import, semester sync, resource ingestion, search and lesson persistence without ASR", async () => {
  const title = "人工智能中的编程(26-27学年第1学期)";
  const writes: string[] = [];
  let populated = false;
  const { server, app, headers } = await setup({ pku3b: {
    version: async () => ({ ok: true, data: { version: "0.16.0", supported: true } }),
    courseCatalog: async () => [{ title, remoteCourseId: "_104187_1" }],
    runRead: async command => {
      const stdout = command.kind === "course-content-list" ? `${title}\n${populated ? "• (Document) 第一讲 _104187_1:_200_1\n" : ""}`
        : command.kind === "assignment-list" ? `${title} > 作业一 (无截止时间) assignment-current\n人工智能中的编程(25-26学年第1学期) > 旧作业 (无截止时间) assignment-old`
        : command.kind === "video-list" ? `[${title}]\n• 第一讲 (2026-09-08 08:00) recording-current\n[人工智能中的编程(25-26学年第1学期)]\n• 旧录播 (2025-09-08 08:00) recording-old`
        : command.kind === "grades" ? `${title}\n* 作业一 90 / 100\n人工智能中的编程(25-26学年第1学期)\n* 旧成绩 60 / 100`
        : "[ 1] 人工智能中的编程 > 开课通知 announcement-current";
      return { ok: true, data: { version: "0.16.0", stderr: "", stdout } };
    },
    runWrite: async command => {
      writes.push(command.kind);
      if (command.kind !== "course-content-download") throw new Error("Only material downloads are expected");
      await writeFile(join(command.outdir, "description.txt"), "\n");
      await writeFile(join(command.outdir, "slides.md"), "# Programming\n\nPython functions accept arguments and return values.\n\n# Later\n\nNeural networks are covered next week.");
      return { ok: true, data: { version: "0.16.0", stderr: "", stdout: "Done" } };
    },
  } });
  const request = async (method: "GET" | "POST" | "PUT", url: string, payload?: object) => {
    const response = await server.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json().data;
  };
  const discovered = await request("POST", "/api/teaching-network/courses/discover", {});
  expect(discovered).toEqual([{ title, remoteCourseId: "_104187_1" }]);
  const imported = await request("POST", "/api/teaching-network/courses/import", discovered[0]);
  expect(imported.term).toBe("26-27学年第1学期");
  const again = await request("POST", "/api/teaching-network/courses/import", discovered[0]);
  expect(again.courseId).toBe(imported.courseId);
  const base = `/api/courses/${imported.courseId}`;
  const sync = async (path: string) => {
    const job = await request("POST", base + path, {});
    expect((await app.teachingNetwork.wait(job.jobId)).status).toBe("completed");
  };
  await sync("/remote-resources/sync");
  expect(app.teachingNetwork.listResources(imported.courseId)).toHaveLength(0);
  populated = true;
  await sync("/remote-resources/sync");
  await sync("/overview/sync");
  const overview = await request("GET", base + "/overview");
  expect(overview).toHaveLength(4);
  expect(JSON.stringify(overview)).not.toContain("旧");
  const resource = app.teachingNetwork.listResources(imported.courseId)[0]!;
  await sync(`/remote-resources/${resource.resourceId}/import`);
  await sync(`/remote-resources/${resource.resourceId}/import`);
  expect(writes).toEqual(["course-content-download"]);
  const materials = await request("GET", base + "/materials");
  expect(materials).toHaveLength(1);
  expect(materials[0].status).toBe("ready");
  const search = await request("GET", base + "/documents/search?query=functions");
  expect(JSON.stringify(search)).toContain("Python functions");
  const blocks = app.documents.readIndexedAsset(imported.courseId, materials[0].sourcePath);
  const lesson = await request("POST", base + "/lessons", { title: "第一讲", recordingIds: ["recording-current"] });
  const lessonUrl = base + "/lessons/" + lesson.lessonId;
  await request("PUT", lessonUrl + "/outline", { revision: 0, outline: { basis: "manual", topics: [{ topicId: "functions", title: "函数", summary: "参数和返回值" }] } });
  await request("PUT", lessonUrl + "/selections", { revision: 1, selections: [{ topicId: "functions", sourcePath: materials[0].sourcePath, blockIds: blocks.filter(b => b.text.includes("Python functions")).map(b => b.blockId), reason: "本节定义" }] });
  await request("PUT", lessonUrl + "/document", { revision: 2, markdown: "# 函数\n\n参数与返回值。" });
  await request("POST", base + "/documents/rebuild", {});
  const sources = await request("GET", lessonUrl + "/sources");
  expect(JSON.stringify(sources)).toContain("Python functions");
  expect(JSON.stringify(sources)).not.toContain("Neural networks");
  expect((await request("GET", lessonUrl)).document.markdown).toContain("参数与返回值");
});
it("rejects path traversal, invalid outlines and cross-course writes", async () => {
  const { server, app, headers, base } = await setup();
  const upload = await server.inject({ method: "POST", url: `${base}/materials?filename=..%2Fsecret.md&role=textbook`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("x") });
  expect(upload.statusCode).toBe(400);
  const created = await server.inject({ method: "POST", url: `${base}/lessons`, headers, payload: { title: "课次" } });
  const lessonId = created.json().data.lessonId;
  const invalid = await server.inject({ method: "PUT", url: `${base}/lessons/${lessonId}/outline`, headers, payload: { revision: 0, outline: { basis: "manual", topics: [{ topicId: "x", title: "x", summary: "", startSeconds: 60, endSeconds: 20 }] } } });
  expect(invalid.statusCode).toBe(400);
  const other = await app.courses.create({ name: "其他", teacher: "教师", term: "秋" });
  const cross = await server.inject({ method: "PUT", url: `/api/courses/${other.courseId}/lessons/${lessonId}/document`, headers, payload: { revision: 0, markdown: "跨课写入" } });
  expect(cross.statusCode).toBe(404);
});

it("emits SSE error rather than complete when SDK prompt resolves with a failed assistant turn", async () => {
  const { server, app, headers, base } = await setup();
  const messages: { role: string; stopReason?: string; errorMessage?: string }[] = [];
  const session = {
    sessionId: "failed-turn", isStreaming: false,
    state: { messages }, model: undefined,
    sessionManager: { getSessionName: () => undefined },
    getActiveToolNames: () => [], subscribe: () => () => {}, dispose: () => {},
    prompt: async () => { messages.push({ role: "assistant", stopReason: "error", errorMessage: "Connection error. private-provider-details" }); },
  };
  const spy = vi.spyOn(app.agent, "createCourseSession").mockResolvedValue({ session } as never);
  try {
    const created = await server.inject({ method: "POST", url: `${base}/sessions`, headers, payload: {} });
    expect(created.statusCode).toBe(201);
    const response = await server.inject({ method: "POST", url: "/api/sessions/failed-turn/messages", headers, payload: { message: "测试" } });
    expect(response.body).toContain("event: error");
    expect(response.body).toContain("AGENT_CONNECTION_FAILED");
    expect(response.body).not.toContain("event: complete");
    expect(response.body).not.toContain("private-provider-details");
  } finally { spy.mockRestore(); }
});

it("uploads directly into a lesson index and validates scope, revisions and session context", async () => {
  const { app, course, server, headers, base } = await setup();
  const lesson = app.lessons.create(course.courseId, { title: "条件概率" });
  const uploadUrl = `${base}/materials?filename=lesson.md&role=supplement&lessonId=${lesson.lessonId}&revision=0`;
  const upload = await server.inject({ method: "POST", url: uploadUrl, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("# 条件概率\n\n这是本节补充文件。") });
  expect(upload.statusCode).toBe(200);
  const material = upload.json().data;
  expect(material.coursePublic).toBe(false);
  const current = app.lessons.get(course.courseId, lesson.lessonId);
  expect(current.materialRefs).toEqual([{ assetId: material.assetId, blockIds: [] }]);
  expect((await server.inject({ method: "POST", url: uploadUrl, headers: { ...headers, "content-type": "application/octet-stream" }, payload: Buffer.from("other") })).statusCode).toBe(409);
  await app.materials.parse(course.courseId, material.assetId);
  const contextUrl = `${base}/lessons/${lesson.lessonId}/context`;
  expect((await server.inject({ method: "POST", url: contextUrl, payload: {} })).statusCode).toBe(401);
  const context = await server.inject({ method: "POST", url: contextUrl, headers, payload: {} });
  expect(context.statusCode).toBe(200);
  expect(context.json().data.sources[0].blocks.length).toBeGreaterThan(0);
  const other = app.lessons.create(course.courseId, { title: "另一节" });
  expect((await server.inject({ method: "POST", url: `${base}/lessons/${other.lessonId}/context`, headers, payload: { assetIds: [material.assetId] } })).statusCode).toBe(403);
  const wrongCourse = await app.courses.create({ name: "别的课", teacher: "T", term: "秋" });
  expect((await server.inject({ method: "GET", url: `/api/courses/${wrongCourse.courseId}/materials/${material.assetId}/blocks`, headers })).statusCode).toBe(404);
  const stale = await server.inject({ method: "POST", url: `${base}/lessons/${lesson.lessonId}/session`, headers, payload: { contextId: "stale" } });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error.code).toBe("CONTEXT_STALE");
  const inputs = await server.inject({ method: "PUT", url: `${base}/lessons/${lesson.lessonId}/inputs`, headers, payload: { revision: current.revision, materialRefs: [], autoPublic: false, focus: "" } });
  expect(inputs.statusCode).toBe(200);
  expect((await server.inject({ method: "POST", url: contextUrl, headers, payload: {} })).json().data.sources).toHaveLength(0);
});

it("creates lessons with recording dates and returns dated lessons before undated ones", async () => {
  const { app, course, server, headers, base } = await setup();
  app.store.replaceTeachingItems(course.courseId, ["video"], [{
    itemId: "date-video", courseId: course.courseId, provider: "pku3b", remoteId: "date-video", remoteIdStable: true,
    kind: "video", title: "录播", courseLabel: course.name, occurredAt: "2026-09-01T16:30:00Z", updatedAt: "2026-09-10T00:00:00Z",
  }]);
  for (const payload of [{ title: "无日期" }, { title: "有录播", recordingIds: ["date-video"] }, { title: "最早", date: "2026-09-01" }]) {
    const response = await server.inject({ method: "POST", url: `${base}/lessons`, headers, payload });
    expect(response.statusCode).toBe(200);
    if (payload.title === "有录播") expect(response.json().data.date).toBe("2026-09-02");
  }
  const listed = await server.inject({ method: "GET", url: `${base}/lessons`, headers });
  expect(listed.json().data.map((l: { title: string }) => l.title)).toEqual(["最早", "有录播", "无日期"]);
});

import { createLessonTools } from "../src/agent/lesson-tools.js";
import { PiAgentService } from "../src/agent/pi-agent-service.js";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplication, type ApplicationContext } from "../src/application.js";
import { MineruMarkdownParser } from "../src/documents/document-service.js";
import { createLearningTools } from "../src/agent/learning-tools.js";
import type { CreateApplicationOptions } from "../src/application.js";
const cleanup: { app: ApplicationContext; root: string }[] = [];
afterEach(async () => { for (const { app, root } of cleanup.splice(0)) { app.close(); await rm(root, { recursive: true, force: true }); } });
async function setup(options: CreateApplicationOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "learning-test-"));
  const app = createApplication({ ...options, paths: { dataDir: join(root, "data"), configDir: join(root, "config"), cacheDir: join(root, "cache"), coursesDir: join(root, "courses") }, embeddings: { id: "none", isAvailable: () => false, embed: async () => [] } });
  cleanup.push({ app, root });
  const course = await app.courses.create({ name: "线性代数", teacher: "教师", term: "2026" });
  return { app, course, root };
}
async function material(app: ApplicationContext, courseId: string, filename = "教材.md") {
  const uploaded = await app.materials.upload(courseId, filename, Buffer.from("# 特征值\n\n定义和推导。\n\n# 未讲章节\n\n本节不涉及的内容。"), "textbook");
  return app.materials.parse(courseId, uploaded.assetId);
}

describe("lesson learning workflow", () => {
  it("sorts dates ascending with all undated lessons last, and derives the linked recording date", async () => {
    const { app, course } = await setup();
    const now = new Date().toISOString();
    app.store.replaceTeachingItems(course.courseId, ["video"], [
      { itemId: "video-old", courseId: course.courseId, provider: "pku3b", remoteId: "video-old", remoteIdStable: true,
        kind: "video", title: "旧录播", courseLabel: course.name, occurredAt: "2026-09-02T10:00:00.000Z", occurredText: "2026-09-02", updatedAt: now },
      { itemId: "video-new", courseId: course.courseId, provider: "pku3b", remoteId: "video-new", remoteIdStable: true,
        kind: "video", title: "新录播", courseLabel: course.name, occurredAt: "2026-09-05T10:00:00.000Z", occurredText: "2026-09-05", updatedAt: now },
    ]);
    app.lessons.create(course.courseId, { title: "无日期" });
    app.lessons.create(course.courseId, { title: "普通日期", date: "2026-09-01" });
    const recorded = app.lessons.create(course.courseId, { title: "已关联录播", recordingIds: ["video-new"] });
    const recordedExplicit = app.lessons.create(course.courseId, { title: "录播手动日期", date: "2026-09-01", recordingIds: ["video-old"] });
    expect(recorded.date).toBe("2026-09-05");
    expect(recordedExplicit.date).toBe("2026-09-01");
    const media = await app.materials.upload(course.courseId, "未知日期.mp4", Buffer.from("test media metadata only"), "recording");
    const undatedRecording = app.lessons.create(course.courseId, { title: "未知日期录播", recordingAssetIds: [media.assetId] });
    expect(undatedRecording.date).toBe("");
    const listed = app.lessons.list(course.courseId);
    expect(listed.map(lesson => lesson.date)).toEqual(["2026-09-01", "2026-09-01", "2026-09-05", "", ""]);
    expect(listed.slice(0, 2).map(l => l.title)).toEqual(expect.arrayContaining(["普通日期", "录播手动日期"]));
    expect(listed.at(-1)!.date).toBe("");
  });

  it("uses Beijing dates and raw recording dates, preserves explicit dates and upgrades undated legacy reads", async () => {
    const { app, course } = await setup();
    const items = [
      { remoteId: "midnight", occurredAt: "2026-09-01T16:15:00Z" },
      { remoteId: "display", occurredAt: "invalid", occurredText: "2026年9月3日 上午08:00" },
      { remoteId: "invalid", occurredText: "2026-02-30 08:00" },
    ].map(item => ({ ...item, itemId: item.remoteId, courseId: course.courseId, provider: "pku3b" as const, remoteIdStable: true,
      kind: "video" as const, title: item.remoteId, courseLabel: course.name, updatedAt: "2026-09-10T00:00:00Z" }));
    app.store.replaceTeachingItems(course.courseId, ["video"], items);
    expect(app.lessons.create(course.courseId, { title: "北京时间", recordingIds: ["midnight"] }).date).toBe("2026-09-02");
    expect(app.lessons.create(course.courseId, { title: "原始显示日期", recordingIds: ["display"] }).date).toBe("2026-09-03");
    expect(app.lessons.create(course.courseId, { title: "最早片段", recordingIds: ["display", "midnight"] }).date).toBe("2026-09-02");
    expect(app.lessons.create(course.courseId, { title: "日期未知", recordingIds: ["invalid"] }).date).toBe("");
    expect(() => app.lessons.create(course.courseId, { title: "非法日期", date: "2026-02-30" })).toThrow();
    const explicit = app.lessons.create(course.courseId, { title: "手动", date: "2026-09-08", recordingIds: ["midnight"] });
    expect(app.lessons.get(course.courseId, explicit.lessonId).date).toBe("2026-09-08");
    const legacy = app.lessons.create(course.courseId, { title: "历史课次", recordingIds: ["display"] });
    app.store.db.prepare("UPDATE learning_lessons SET payload = json_set(payload, '$.date', '') WHERE lesson_id = ?").run(legacy.lessonId);
    expect(app.lessons.list(course.courseId).find(l => l.lessonId === legacy.lessonId)?.date).toBe("2026-09-03");
    expect(app.lessons.get(course.courseId, legacy.lessonId)).toMatchObject({ date: "2026-09-03", revision: 0 });
    // Reading does not rewrite historical data or invalidate existing revision tokens.
    const row = app.store.db.prepare("SELECT payload FROM learning_lessons WHERE lesson_id = ?").get(legacy.lessonId) as { payload: string };
    expect(JSON.parse(row.payload).date).toBe("");
  });

  it("builds a bounded context from lesson references, excludes other lessons and supports explicit block removal", async () => {
    const { app, course } = await setup();
    const book = await material(app, course.courseId);
    const privateFile = await app.materials.upload(course.courseId, "另一节.md", Buffer.from("特征值 OTHER_LESSON_SECRET"), "supplement", false);
    await app.materials.parse(course.courseId, privateFile.assetId);
    let lesson = app.lessons.create(course.courseId, { title: "特征值" });
    const automatic = app.lessons.context(course.courseId, lesson.lessonId);
    expect(JSON.stringify(automatic)).toContain("特征值");
    expect(JSON.stringify(automatic)).not.toContain("OTHER_LESSON_SECRET");
    expect(JSON.stringify(automatic)).not.toContain("本节不涉及的内容");
    expect(() => app.lessons.context(course.courseId, lesson.lessonId, [privateFile.assetId])).toThrow("不在本课次");
    const blocks = app.documents.readIndexedAsset(course.courseId, book.sourcePath!);
    lesson = app.lessons.saveInputs(course.courseId, lesson.lessonId, { revision: lesson.revision, materialRefs: [{ assetId: book.assetId, blockIds: [blocks[1]!.blockId] }], autoPublic: false, focus: "只学定义" });
    const context = app.lessons.context(course.courseId, lesson.lessonId);
    expect(context.sources.flatMap(s => s.blocks)).toEqual([blocks[1]]);
    expect(app.lessons.context(course.courseId, lesson.lessonId).contextId).toBe(context.contextId);
    lesson = app.lessons.saveInputs(course.courseId, lesson.lessonId, { revision: lesson.revision, materialRefs: lesson.materialRefs, autoPublic: false, focus: "只学定义", excludedBlockIds: [blocks[1]!.blockId] });
    expect(app.lessons.context(course.courseId, lesson.lessonId).sources).toHaveLength(0);
    expect(() => app.lessons.saveInputs(course.courseId, lesson.lessonId, { revision: 0, materialRefs: [], autoPublic: false, focus: "" })).toThrow("已更新");
  });
  it("saves lecture and exercises to one lesson, rejects fabricated evidence and concurrent edits", async () => {
    const { app, course } = await setup();
    const book = await material(app, course.courseId);
    let lesson = app.lessons.create(course.courseId, { title: "特征值" });
    lesson = app.lessons.saveInputs(course.courseId, lesson.lessonId, { revision: 0, materialRefs: [{ assetId: book.assetId, blockIds: [] }], autoPublic: false, focus: "" });
    const context = app.lessons.context(course.courseId, lesson.lessonId);
    const tools = createLessonTools(course.courseId, app.lessons, context, []);
    expect(tools.map(t => t.name)).toEqual(["read_lesson_context", "save_lesson_lecture", "save_lesson_artifact"]);
    const call = async (name: string, params: unknown = {}) => JSON.parse((await tools.find(t => t.name === name)!.execute("test", params as never)).content[0]!.text as string);
    expect((await call("save_lesson_lecture", { markdown: "bad", blockIds: ["fabricated"] })).error.code).toBe("SOURCE_FORBIDDEN");
    expect((await call("save_lesson_lecture", { markdown: "# 本节讲义", blockIds: context.sources.flatMap(s => s.blocks.map(b => b.blockId)) })).ok).toBe(true);
    expect((await call("save_lesson_artifact", { kind: "practice", title: "特征值自测", markdown: "题目", answersMarkdown: "答案" })).ok).toBe(true);
    lesson = app.lessons.get(course.courseId, lesson.lessonId);
    expect(lesson.artifacts?.[0]).toMatchObject({ kind: "practice", markdown: "题目", answersMarkdown: "答案", contextId: context.contextId });
    expect(lesson.lastContext?.contextId).toBe(context.contextId);
    expect((await call("read_lesson_context")).ok).toBe(true);
    app.lessons.saveDocument(course.courseId, lesson.lessonId, lesson.revision, "我的人工编辑", "user");
    expect((await call("save_lesson_artifact", { kind: "other", title: "覆盖", markdown: "覆盖" })).error.code).toBe("CONTEXT_STALE");
    expect(app.lessons.get(course.courseId, lesson.lessonId).document?.markdown).toBe("我的人工编辑");
  });
  it("isolates registered session tools, rejects old context IDs and does not load course prompt files", async () => {
    const { app, course, root } = await setup();
    await material(app, course.courseId);
    const lesson = app.lessons.create(course.courseId, { title: "特征值" });
    await writeFile(join(course.rootPath, "prompts", "notes.md"), "UNRELATED_COURSE_CONTEXT");
    let captured: Parameters<NonNullable<ConstructorParameters<typeof PiAgentService>[0]["sessionFactory"]>>[0] | undefined;
    const agent = new PiAgentService({ store: app.store, courses: app.courses, jobs: app.jobs, teachingNetwork: app.teachingNetwork, documents: app.documents, candidates: app.candidates,
      agentDir: join(root, "agent"), sessionDir: join(root, "sessions"), learning: { lessons: app.lessons, materials: app.materials, recordings: app.recordings, documents: app.documents, teachingNetwork: app.teachingNetwork },
      sessionFactory: async options => { captured = options; return {} as never; } });
    const context = app.lessons.context(course.courseId, lesson.lessonId);
    await agent.createLessonSession(course.courseId, lesson.lessonId, context.contextId);
    expect(captured?.tools).toEqual(["read_lesson_context", "save_lesson_lecture", "save_lesson_artifact"]);
    expect(captured?.customTools?.map(t => t.name)).toEqual(captured?.tools);
    expect(captured?.resourceLoader?.getSkills().skills.map(s => s.name).sort()).toEqual(["lesson-learning", "lesson-review", "practice-generator"]);
    expect(captured?.resourceLoader?.getSystemPrompt()).not.toContain("UNRELATED_COURSE_CONTEXT");
    expect(captured?.sessionManager?.getSessionFile()).toBeUndefined();
    await expect(agent.createLessonSession(course.courseId, lesson.lessonId, "old-id")).rejects.toThrow("上下文已更新");
  });
  it("rejects context after source replacement even without a lesson revision change", async () => {
    const { app, course } = await setup();
    const book = await material(app, course.courseId);
    const lesson = app.lessons.create(course.courseId, { title: "特征值" });
    const snapshot = app.lessons.context(course.courseId, lesson.lessonId);
    const tools = createLessonTools(course.courseId, app.lessons, snapshot, []);
    await writeFile(join(course.rootPath, book.originalPath), "# 特征值\n\n替换后的定义");
    await app.materials.parse(course.courseId, book.assetId, true);
    expect(app.lessons.get(course.courseId, lesson.lessonId).revision).toBe(0);
    const result = await tools[0]!.execute("test", {});
    expect(JSON.stringify(result)).toContain("CONTEXT_STALE");
  });
  it("caps large selected sources and reports omitted content rather than silently sending a whole book", async () => {
    const { app, course } = await setup();
    const uploaded = await app.materials.upload(course.courseId, "长教材.md", Buffer.from(Array.from({ length: 120 }, (_, i) => `# 第${i}章\n\n${"限定范围正文。".repeat(150)}`).join("\n\n")), "textbook");
    const book = await app.materials.parse(course.courseId, uploaded.assetId);
    let lesson = app.lessons.create(course.courseId, { title: "指定长资料" });
    lesson = app.lessons.saveInputs(course.courseId, lesson.lessonId, { revision: 0, materialRefs: [{ assetId: book.assetId, blockIds: [] }], autoPublic: false, focus: "" });
    const context = app.lessons.context(course.courseId, lesson.lessonId);
    expect(context.characters).toBeLessThanOrEqual(30_000);
    expect(context.characters).toBeGreaterThan(0);
    expect(context.warnings.join(" ")).toContain("超出上下文预算");
    expect(context.characters).toBe(context.sources.flatMap(s => s.blocks).reduce((n, b) => n + b.text.length, 0));
  });
  it("retains legacy public assets and deduplicates a file shared between course and lesson", async () => {
    const { app, course } = await setup();
    const privateFile = await app.materials.upload(course.courseId, "补充.md", Buffer.from("测试资料"), "supplement", false);
    expect(privateFile.coursePublic).toBe(false);
    const promoted = await app.materials.upload(course.courseId, "共享.md", Buffer.from("测试资料"), "textbook");
    expect(promoted.assetId).toBe(privateFile.assetId);
    expect(promoted.coursePublic).toBe(true);
    const duplicate = await app.materials.upload(course.courseId, "本节.md", Buffer.from("测试资料"), "supplement", false);
    expect(duplicate.coursePublic).toBe(true);
  });

  it("stores topic-scoped selections and a document; preserves user edits on stale agent writes", async () => {
    const { app, course } = await setup();
    const book = await material(app, course.courseId);
    const blocks = app.documents.readIndexedAsset(course.courseId, book.sourcePath!);
    let lesson = app.lessons.create(course.courseId, { title: "第 1 讲" });
    expect(() => app.lessons.saveSelections(course.courseId, lesson.lessonId, 0, [])).toThrow("先保存本节大纲");
    lesson = app.lessons.saveOutline(course.courseId, lesson.lessonId, lesson.revision, { basis: "manual", topics: [{ topicId: "eigen", title: "特征值", summary: "只学习定义" }] });
    lesson = app.lessons.saveSelections(course.courseId, lesson.lessonId, lesson.revision, [{ topicId: "eigen", sourcePath: book.sourcePath!, blockIds: [blocks[1]!.blockId], reason: "本节定义" }]);
    expect(app.lessons.sources(course.courseId, lesson.lessonId)[0]!.blocks).toHaveLength(1);
    const sources = app.lessons.sources(course.courseId, lesson.lessonId);
    expect(JSON.stringify(sources)).not.toContain("本节不涉及的内容");
    lesson = app.lessons.saveDocument(course.courseId, lesson.lessonId, lesson.revision, "# 讲义\n定义", "agent");
    const agentRevision = lesson.revision;
    lesson = app.lessons.saveDocument(course.courseId, lesson.lessonId, lesson.revision, "# 我的修改", "user");
    expect(() => app.lessons.saveDocument(course.courseId, lesson.lessonId, agentRevision, "覆盖", "agent")).toThrow("已更新");
    expect(await readFile(join(course.rootPath, lesson.document!.sourcePath), "utf8")).toContain("我的修改");
    lesson = app.lessons.saveOutline(course.courseId, lesson.lessonId, lesson.revision, { basis: "manual", topics: [{ topicId: "new", title: "新范围", summary: "调整" }] });
    expect(lesson.documentStale).toBe(true);
    expect(lesson.document!.markdown).toBe("# 我的修改");
    expect(lesson.selections).toEqual([]);
    expect(app.lessons.get(course.courseId, lesson.lessonId)).toEqual(lesson);
  });
  it("rejects cross-course blocks, wrong topics and fabricated recording outlines", async () => {
    const { app, course } = await setup();
    const other = await app.courses.create({ name: "别的课", teacher: "教师", term: "2026" });
    const book = await material(app, other.courseId);
    let lesson = app.lessons.create(course.courseId, { title: "本节" });
    expect(() => app.lessons.saveOutline(course.courseId, lesson.lessonId, 0, { basis: "recording", topics: [{ topicId: "x", title: "x", summary: "x" }] })).toThrow("转写");
    lesson = app.lessons.saveOutline(course.courseId, lesson.lessonId, 0, { basis: "manual", topics: [{ topicId: "x", title: "x", summary: "x" }] });
    const selection = { topicId: "x", sourcePath: book.sourcePath!, blockIds: ["missing"], reason: "测试" };
    expect(() => app.lessons.saveSelections(course.courseId, lesson.lessonId, lesson.revision, [selection])).toThrow("范围");
    expect(() => app.lessons.saveSelections(course.courseId, lesson.lessonId, lesson.revision, [{ ...selection, topicId: "wrong" }])).toThrow("主题");
    expect(() => app.lessons.get(other.courseId, lesson.lessonId)).toThrow("课次不存在");
  });
  it("deduplicates uploaded books and retains source identities after rebuilding indexes", async () => {
    const { app, course } = await setup();
    const book = await material(app, course.courseId);
    const same = await material(app, course.courseId, "另一个文件名.md");
    expect(same.assetId).toBe(book.assetId);
    const ids = app.documents.readIndexedAsset(course.courseId, book.sourcePath!).map(b => b.blockId);
    await app.documents.rebuildCourseIndex(course.courseId);
    expect(app.documents.readIndexedAsset(course.courseId, book.sourcePath!).map(b => b.blockId)).toEqual(ids);
    expect(app.materials.list(course.courseId)).toHaveLength(1);
  });
  it("preserves parser images and table line breaks, and exposes parse failures for retry", async () => {
    let fail = false;
    const { app, course } = await setup({ documentParser: { parse: async (input) => {
      if (/\.md$/.test(input.filePath)) return new MineruMarkdownParser().parse(input);
      if (fail) throw new Error("云端不可用");
      return { title: "课件", blocks: [{ contentType: "paragraph", page: 3, text: "| A | B |\n|---|---|\n| 1 | 2 |" }, { contentType: "paragraph", page: 3, text: "![图](images/plot.png)" }], attachments: [{ path: "images/plot.png", data: new Uint8Array([1, 2, 3]) }] };
    } } });
    const upload = await app.materials.upload(course.courseId, "slides.pptx", Buffer.from("office-data"), "slides");
    const parsed = await app.materials.parse(course.courseId, upload.assetId);
    expect(parsed.status).toBe("ready");
    const block = app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!)[0]!;
    expect(block.page).toBe(3);
    expect(block.text).toContain("\n|---|---|\n");
    const imagePath = /!\[图\]\(([^)]+)\)/.exec(app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!).map(b => b.text).join("\n"))![1]!;
    expect(await readFile(await app.materials.file(course.courseId, imagePath))).toEqual(Buffer.from([1, 2, 3]));
    const ids = app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!).map(b => b.blockId);
    await app.documents.rebuildCourseIndex(course.courseId);
    expect(app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!).map(b => b.blockId)).toEqual(ids);
    expect(app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!)[0]!.page).toBe(3);
    fail = true;
    const bad = await app.materials.upload(course.courseId, "bad.pdf", Buffer.from("bad-data"), "textbook");
    expect((await app.materials.parse(course.courseId, bad.assetId)).status).toBe("failed");
    fail = false;
    expect((await app.materials.parse(course.courseId, bad.assetId)).status).toBe("ready");
    const markdown = await new MineruMarkdownParser().parse({ filePath: "a.pdf", content: "| A | B |\n|---|---|\n| 1 | 2 |" });
    expect(markdown.blocks[0]!.text).toContain("\n|---|---|\n");
  });
  it("retains selections across rebuilds for structured cloud blocks with captions and multiple paragraphs", async () => {
    const parser = new MineruMarkdownParser();
    const { app, course } = await setup({ documentParser: { parse: async input => {
      if (/\.md$/.test(input.filePath)) return parser.parse(input);
      return { title: "slides", blocks: [
        { contentType: "heading", page: 1, text: "Overview" },
        { contentType: "paragraph", page: 1, text: "First paragraph.\n\nSecond paragraph." },
        { contentType: "paragraph", page: 2, text: "图表说明\n\n![图](images/plot.png)\n\n数据来源" },
      ], attachments: [{ path: "images/plot.png", data: new Uint8Array([1, 2, 3]) }] };
    } } });
    const uploaded = await app.materials.upload(course.courseId, "slides.pdf", Buffer.from("structured-slides"), "slides");
    const parsed = await app.materials.parse(course.courseId, uploaded.assetId);
    const blocks = app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!);
    let lesson = app.lessons.create(course.courseId, { title: "Overview" });
    lesson = app.lessons.saveOutline(course.courseId, lesson.lessonId, 0, { basis: "materials", topics: [{ topicId: "x", title: "Overview", summary: "Intro" }] });
    lesson = app.lessons.saveSelections(course.courseId, lesson.lessonId, lesson.revision, [{ topicId: "x", sourcePath: parsed.sourcePath!, blockIds: blocks.map(b => b.blockId), reason: "Figures and introduction" }]);
    await app.documents.rebuildCourseIndex(course.courseId);
    const rebuilt = app.lessons.sources(course.courseId, lesson.lessonId)[0]!.blocks;
    expect(rebuilt.map(b => [b.blockId, b.page, b.text])).toEqual(blocks.map(b => [b.blockId, b.page, b.text]));
    expect(rebuilt.some(b => b.page === 2 && b.text.includes("![图](materials/"))).toBe(true);
  });
  it("invalidates changed selections after an explicit reparse while preserving the edited document", async () => {
    let version = 0;
    const { app, course } = await setup({ documentParser: { parse: async () => ({ title: "slides", blocks: [{ contentType: "paragraph", text: `version ${version}` }] }) } });
    const uploaded = await app.materials.upload(course.courseId, "slides.pdf", Buffer.from("sample"), "slides");
    const parsed = await app.materials.parse(course.courseId, uploaded.assetId);
    const block = app.documents.readIndexedAsset(course.courseId, parsed.sourcePath!)[0]!;
    let lesson = app.lessons.create(course.courseId, { title: "Lesson" });
    lesson = app.lessons.saveOutline(course.courseId, lesson.lessonId, 0, { basis: "manual", topics: [{ topicId: "x", title: "x", summary: "x" }] });
    lesson = app.lessons.saveSelections(course.courseId, lesson.lessonId, lesson.revision, [{ topicId: "x", sourcePath: parsed.sourcePath!, blockIds: [block.blockId], reason: "source" }]);
    lesson = app.lessons.saveDocument(course.courseId, lesson.lessonId, lesson.revision, "My edit", "user");
    version++;
    await app.materials.parse(course.courseId, parsed.assetId, true);
    const current = app.lessons.get(course.courseId, lesson.lessonId);
    expect(current.document?.markdown).toBe("My edit"); expect(current.documentStale).toBe(true);
    expect(current.selections).toEqual([]); expect(current.revision).toBe(lesson.revision + 1);
  });
  it("transcribes an uploaded recording using the shared cloud pipeline and attaches it to a lesson", async () => {
    const { app, course } = await setup({
      transcriptions: { id: "fake-cloud", isAvailable: () => true, transcribe: async () => ({ text: "本节讲特征值定义。" }) },
      audioProcessor: { split: async ({ outputDir }) => { await mkdir(outputDir, { recursive: true }); const filePath = join(outputDir, "audio.webm"); await writeFile(filePath, "audio"); return [{ filePath, startSeconds: 0, endSeconds: 60 }]; } },
    });
    const upload = await app.materials.upload(course.courseId, "class.mp4", Buffer.from("video"), "recording");
    const lesson = app.lessons.create(course.courseId, { title: "上传的一节课", recordingAssetIds: [upload.assetId] });
    const tools = createLearningTools(course.courseId, { lessons: app.lessons, materials: app.materials, recordings: app.recordings, documents: app.documents, teachingNetwork: app.teachingNetwork });
    const tool = tools.find(t => t.name === "transcribe_uploaded_recording")!;
    const result = await tool.execute("call", { lessonId: lesson.lessonId, revision: 0, assetId: upload.assetId }, undefined, undefined, {} as never);
    expect(JSON.stringify(result)).toContain('"ok":true');
    const current = app.lessons.get(course.courseId, lesson.lessonId);
    expect(current.transcriptPaths).toHaveLength(1);
    expect(app.documents.readIndexedAsset(course.courseId, current.transcriptPaths[0]!).map(b => b.text).join("\n")).toContain("特征值");
    expect(await readFile(await app.materials.file(course.courseId, upload.originalPath), "utf8")).toBe("video");
  });
  it("discovers stable course IDs without inventing IDs for empty courses, and imports idempotently", async () => {
    const { app } = await setup({ pku3b: {
      version: async () => ({ ok: true, data: { version: "0.16.0", supported: true } }),
      runRead: async () => ({ ok: true, data: { version: "0.16.0", stderr: "", stdout: "线性代数 (2026 Fall)\n• (Document) 第一讲 _math_1:_content_1\n空课程 (2026 Fall)\n" } }),
      runWrite: async () => { throw new Error("discovery must not download"); },
    } });
    const discovered = await app.courseDiscovery.discover();
    expect(discovered).toEqual([{ title: "线性代数 (2026 Fall)", remoteCourseId: "_math_1" }, { title: "空课程 (2026 Fall)" }]);
    const [first, second] = await Promise.all([
      app.courseDiscovery.import({ title: discovered[0]!.title, remoteCourseId: "_math_1" }),
      app.courseDiscovery.import({ title: discovered[0]!.title, remoteCourseId: "_math_1" }),
    ]);
    expect(first).toEqual(second);
    expect(app.courses.list().filter(c => c.remoteCourseId === "_math_1")).toHaveLength(1);
    await expect(app.courseDiscovery.import({ title: "伪造", remoteCourseId: "_unknown_1" })).rejects.toThrow("不在当前教学网列表");
  });

});

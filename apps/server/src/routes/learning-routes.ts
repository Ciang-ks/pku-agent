import { createReadStream } from "node:fs";
import { extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ApplicationContext, createLessonSchema, saveOutlineSchema, saveSelectionsSchema,
  saveLearningDocumentSchema, classifyMaterialSchema, LearningError, MAX_MATERIAL_BYTES } from "@pku-study/core";

/** Transport-only handlers. Domain rules are shared with Agent tools. */
export async function registerLearningRoutes(server: FastifyInstance, app: ApplicationContext) {
  await server.register(async routes => {
    routes.setErrorHandler((error, _request, reply) => {
      const e = error as Error & { statusCode?: number; code?: string };
      const status = error instanceof z.ZodError ? 400 : e.statusCode ?? 500;
      return reply.code(status).send({ ok: false, error: { code: e.code ?? "LEARNING_ERROR", message: e.message, retryable: status >= 500 } });
    });
    routes.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_MATERIAL_BYTES }, (_req, body, done) => done(null, body));
    type Course = { courseId: string };
    type Lesson = Course & { lessonId: string };
    type Asset = Course & { assetId: string };
    routes.post("/api/teaching-network/courses/discover", async request => {
      const input = z.object({ otp: z.string().regex(/^\d{4,12}$/).optional() }).strict().parse(request.body ?? {});
      return { ok: true, data: await app.courseDiscovery.discover(input.otp) };
    });
    routes.post("/api/teaching-network/courses/import", async request => {
      const input = z.object({ remoteCourseId: z.string().min(1).max(100), title: z.string().min(1).max(200),
        teacher: z.string().max(100).optional(), term: z.string().max(50).optional(), otp: z.string().regex(/^\d{4,12}$/).optional() }).strict().parse(request.body);
      return { ok: true, data: await app.courseDiscovery.import({ remoteCourseId: input.remoteCourseId, title: input.title,
        ...(input.teacher ? { teacher: input.teacher } : {}), ...(input.term ? { term: input.term } : {}), ...(input.otp ? { otp: input.otp } : {}) }) };
    });
    routes.get<{ Params: Course & { resourceId: string } }>("/api/courses/:courseId/remote-resources/:resourceId", async req => ({ ok: true,
      data: app.teachingNetwork.getResourceDetail(req.params.courseId, req.params.resourceId) }));
    routes.get<{ Params: Course }>("/api/courses/:courseId/lessons", async req => ({ ok: true, data: app.lessons.list(req.params.courseId) }));
    routes.post<{ Params: Course }>("/api/courses/:courseId/lessons", async req => {
      const input = createLessonSchema.parse(req.body);
      return { ok: true, data: app.lessons.create(req.params.courseId, { title: input.title,
        ...(input.date ? { date: input.date } : {}), ...(input.recordingIds ? { recordingIds: input.recordingIds } : {}),
        ...(input.recordingAssetIds ? { recordingAssetIds: input.recordingAssetIds } : {}),
        ...(input.transcriptPaths ? { transcriptPaths: input.transcriptPaths } : {}) }) };
    });
    routes.get<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId", async req => ({ ok: true, data: app.lessons.get(req.params.courseId, req.params.lessonId) }));
    routes.put<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId/outline", async req => {
      const input = saveOutlineSchema.parse(req.body);
      return { ok: true, data: app.lessons.saveOutline(req.params.courseId, req.params.lessonId, input.revision, input.outline) };
    });
    routes.put<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId/selections", async req => {
      const input = saveSelectionsSchema.parse(req.body);
      return { ok: true, data: app.lessons.saveSelections(req.params.courseId, req.params.lessonId, input.revision, input.selections) };
    });
    routes.get<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId/sources", async req => ({ ok: true, data: app.lessons.sources(req.params.courseId, req.params.lessonId) }));
    routes.put<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId/document", async req => {
      const input = saveLearningDocumentSchema.parse(req.body);
      return { ok: true, data: app.lessons.saveDocument(req.params.courseId, req.params.lessonId, input.revision, input.markdown, "user") };
    });
    routes.put<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId/inputs", async req => ({ ok: true, data: app.lessons.saveInputs(req.params.courseId, req.params.lessonId, req.body) }));
    routes.post<{ Params: Lesson }>("/api/courses/:courseId/lessons/:lessonId/context", async req => {
      const input = z.object({ assetIds: z.array(z.uuid()).max(20).default([]) }).strict().parse(req.body ?? {});
      return { ok: true, data: app.lessons.context(req.params.courseId, req.params.lessonId, input.assetIds) };
    });
    routes.get<{ Params: Asset }>("/api/courses/:courseId/materials/:assetId/blocks", async req => {
      const material = app.materials.get(req.params.courseId, req.params.assetId);
      return { ok: true, data: material.sourcePath ? app.documents.readIndexedAsset(req.params.courseId, material.sourcePath) : [] };
    });
    routes.get<{ Params: Course }>("/api/courses/:courseId/materials", async req => ({ ok: true, data: app.materials.list(req.params.courseId) }));
    routes.post<{ Params: Course; Querystring: { filename: string; role: string; lessonId?: string; revision?: string } }>("/api/courses/:courseId/materials", { bodyLimit: MAX_MATERIAL_BYTES }, async req => {
      const role = classifyMaterialSchema.parse({ role: req.query.role }).role;
      if (!Buffer.isBuffer(req.body)) throw new LearningError("INVALID_UPLOAD", "请上传文件二进制内容");
      const filename = z.string().min(1).max(200).parse(req.query.filename);
      const lessonId = req.query.lessonId ? z.uuid().parse(req.query.lessonId) : undefined;
      const lesson = lessonId ? app.lessons.get(req.params.courseId, lessonId) : undefined;
      const revision = lesson ? z.coerce.number().int().nonnegative().parse(req.query.revision) : undefined;
      if (lesson && revision !== lesson.revision) throw new LearningError("REVISION_CONFLICT", "课次已更新，请刷新", 409);
      const material = await app.materials.upload(req.params.courseId, filename, req.body, role, !lesson);
      if (lesson) {
        // Additive membership can merge with edits that completed while the file was written.
        const latest = app.lessons.get(req.params.courseId, lesson.lessonId);
        if (!latest.materialRefs?.some(r => r.assetId === material.assetId)) app.lessons.saveInputs(req.params.courseId, latest.lessonId, { revision: latest.revision,
          materialRefs: [...(latest.materialRefs ?? []), { assetId: material.assetId, blockIds: [] }],
          focus: latest.focus ?? "", autoPublic: latest.autoPublic !== false, excludedBlockIds: latest.excludedBlockIds ?? [] });
      }
      return { ok: true, data: material };
    });
    routes.patch<{ Params: Asset }>("/api/courses/:courseId/materials/:assetId", async req => ({ ok: true,
      data: app.materials.classify(req.params.courseId, req.params.assetId, classifyMaterialSchema.parse(req.body).role) }));
    routes.post<{ Params: Asset }>("/api/courses/:courseId/materials/:assetId/parse", async req => {
      const input = z.object({ force: z.boolean().optional() }).strict().parse(req.body ?? {});
      return { ok: true, data: await app.materials.parse(req.params.courseId, req.params.assetId, input.force) };
    });
    routes.get<{ Params: Course; Querystring: { path: string } }>("/api/courses/:courseId/material-file", async (req, reply) => {
      const file = await app.materials.file(req.params.courseId, z.string().min(1).max(1000).parse(req.query.path));
      const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" };
      reply.header("x-content-type-options", "nosniff");
      return reply.type(mime[extname(file).toLowerCase()] ?? "application/octet-stream").send(createReadStream(file));
    });
  });
}

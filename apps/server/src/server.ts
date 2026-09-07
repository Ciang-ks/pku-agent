import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import {
  createApplication,
  createAgentSessionSchema,
  createLectureNotesSessionSchema,
  createCourseCandidateSchema,
  createCourseSchema,
  reviewCourseCandidateSchema,
  treeholeAskSchema,
  treeholeLoginSchema,
  updateCourseCandidateSchema,
  importRemoteResourceSchema,
  indexCourseAssetSchema,
  searchCourseSchema,
  rebuildCourseIndexSchema,
  resumeTeachingNetworkJobSchema,
  transcribeRecordingSchema,
  downloadAssignmentSchema,
  showAnnouncementSchema,
  timelineQuerySchema,
  approveAssignmentSchema,
  submitAssignmentSchema,
  runDoctor,
  sendAgentMessageSchema,
  syncCourseContentSchema,
  TeachingNetworkError,
  RecordingServiceError,
  AssignmentServiceError,
  PdfExportServiceError,
  CourseWorkspaceError,
  CourseCandidateError,
  DocumentServiceError,
  type ApplicationContext,
  type JobRecord,
} from "@pku-study/core";
import Fastify, { type FastifyInstance } from "fastify";
import { loadOrCreateApiToken, tokenMatches } from "./token.js";

export interface CreateServerOptions {
  app?: ApplicationContext;
  apiToken?: string;
  allowedOrigins?: string[];
  webRoot?: string;
  logger?: boolean;
}

export interface PkuStudyServer {
  server: FastifyInstance;
  app: ApplicationContext;
  apiToken: string;
  close(): Promise<void>;
}

type AgentSession = Awaited<ReturnType<ApplicationContext["agent"]["createCourseSession"]>>["session"];

interface AgentSessionRecord {
  courseId: string;
  session: AgentSession;
}

export async function createServer(options: CreateServerOptions = {}): Promise<PkuStudyServer> {
  const app = options.app ?? createApplication();
  const ownsApp = !options.app;
  const apiToken = options.apiToken ?? (await loadOrCreateApiToken(app.paths.tokenPath));
  const allowedOrigins = options.allowedOrigins ?? [
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ];
  const server = Fastify({ logger: options.logger ?? true, bodyLimit: 2 * 1024 * 1024 });
  const agentSessions = new Map<string, AgentSessionRecord>();

  await server.register(cors, {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Origin is not allowed"), false);
    },
    allowedHeaders: ["content-type", "authorization", "x-pku-study-token"],
  });

  server.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const headerToken = request.headers["x-pku-study-token"];
    const supplied = bearer ?? (Array.isArray(headerToken) ? headerToken[0] : headerToken);
    if (!tokenMatches(apiToken, supplied)) {
      return reply.code(401).send({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "A valid local API token is required.", retryable: false },
      });
    }
  });

  server.get("/health", async () => ({ status: "ok", service: "pku-study" }));

  server.get("/api/system", async () => ({
    ok: true,
    data: {
      version: "0.1.0",
      dataDir: app.paths.dataDir,
      coursesDir: app.paths.coursesDir,
    },
  }));

  server.get("/api/doctor", async () => ({ ok: true, data: await runDoctor({ paths: app.paths }) }));

  server.get("/api/courses", async () => ({ ok: true, data: app.courses.list() }));

  server.get<{ Querystring: { limit?: string; range?: string } }>("/api/timeline", async (request, reply) => {
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
    const now = Date.now();
    const rangeStart = parsed.data.range === "today" ? startOfDay(now) : parsed.data.range === "week" ? now - 7 * 86_400_000 : Number.NEGATIVE_INFINITY;
    const rangeEnd = parsed.data.range === "today" ? rangeStart + 86_400_000 : parsed.data.range === "week" ? now + 7 * 86_400_000 : Number.POSITIVE_INFINITY;
    const timeline = app.courses.list()
      .flatMap((course) => [
        ...app.teachingNetwork.listTeachingItems(course.courseId).map((item) => ({
          courseId: course.courseId,
          courseName: course.name,
          teacher: course.teacher,
          item,
          sortAt: item.dueAt ?? item.occurredAt ?? item.updatedAt,
        })),
        ...app.teachingNetwork.listResources(course.courseId).map((resource) => ({
          courseId: course.courseId,
          courseName: course.name,
          teacher: course.teacher,
          resource,
          sortAt: resource.updatedAt,
        })),
      ])
      .filter((entry) => {
        const timestamp = Date.parse(entry.sortAt);
        return Number.isFinite(timestamp) && timestamp >= rangeStart && timestamp <= rangeEnd;
      })
      .sort((left, right) => right.sortAt.localeCompare(left.sortAt))
      .slice(0, parsed.data.limit);
    return { ok: true, data: timeline };
  });

  server.get("/api/candidates", async () => ({ ok: true, data: app.candidates.list() }));

  server.post<{ Body: unknown }>("/api/candidates", async (request, reply) => {
    const parsed = createCourseCandidateSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
    try {
      return reply.code(201).send({ ok: true, data: app.candidates.create(parsed.data) });
    } catch (error) {
      return candidateError(reply, error);
    }
  });

  server.patch<{ Params: { candidateId: string }; Body: unknown }>(
    "/api/candidates/:candidateId",
    async (request, reply) => {
      const parsed = updateCourseCandidateSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        return { ok: true, data: app.candidates.updateStatus(request.params.candidateId, parsed.data.status) };
      } catch (error) {
        return candidateError(reply, error);
      }
    },
  );

  server.post<{ Params: { candidateId: string }; Body: unknown }>(
    "/api/candidates/:candidateId/review",
    async (request, reply) => {
      const parsed = reviewCourseCandidateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const result = await app.candidates.collectEvidence(request.params.candidateId, parsed.data.keywords);
        const candidate = parsed.data.review
          ? app.candidates.saveReview(request.params.candidateId, parsed.data.review)
          : result.candidate;
        return { ok: true, data: { candidate, evidence: result.evidence } };
      } catch (error) {
        return candidateError(reply, error);
      }
    },
  );

  server.post<{ Body: unknown }>("/api/treehole/ask", async (request, reply) => {
    const parsed = treeholeAskSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
    try {
      return { ok: true, data: await app.candidates.ask(parsed.data.query, parsed.data.keywords) };
    } catch (error) {
      return candidateError(reply, error);
    }
  });

  server.get("/api/integrations/pku3b/status", async () => ({
    ok: true,
    data: await app.teachingNetwork.status(),
  }));

  server.get("/api/auth/treehole/status", async (_request, reply) => {
    const result = await app.treehole.authStatus();
    return treeholeResult(reply, result);
  });

  server.post<{ Body: unknown }>("/api/auth/treehole/login", async (request, reply) => {
    const parsed = treeholeLoginSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
    const result = await app.treehole.login({
      username: parsed.data.username,
      password: parsed.data.password,
      ...(parsed.data.verificationCode ? { verificationCode: parsed.data.verificationCode } : {}),
    });
    return treeholeResult(reply, result);
  });

  server.get<{ Params: { courseId: string } }>("/api/courses/:courseId", async (request, reply) => {
    const course = app.courses.get(request.params.courseId);
    if (!course) {
      return reply.code(404).send({
        ok: false,
        error: { code: "COURSE_NOT_FOUND", message: "Course not found.", retryable: false },
      });
    }
    return { ok: true, data: course };
  });

  server.post<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/sessions",
    async (request, reply) => {
      if (!app.courses.get(request.params.courseId)) return courseNotFound(reply);
      const parsed = createAgentSessionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const created = await app.agent.createCourseSession(
          request.params.courseId,
          parsed.data.name ? { name: parsed.data.name } : {},
        );
        agentSessions.set(created.session.sessionId, {
          courseId: request.params.courseId,
          session: created.session,
        });
        return reply.code(201).send({
          ok: true,
          data: {
            ...agentSessionInfo(created.session, request.params.courseId, Boolean(parsed.data.name)),
            modelAvailable: Boolean(created.session.model),
            ...(created.modelFallbackMessage ? { modelFallbackMessage: created.modelFallbackMessage } : {}),
          },
        });
      } catch (error) {
        return agentError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string }; Body: unknown }>(
    "/api/courses/:courseId/lecture-notes/session",
    async (request, reply) => {
      if (!app.courses.get(request.params.courseId)) return courseNotFound(reply);
      const parsed = createLectureNotesSessionSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const created = await app.agent.createLectureNotesSession(request.params.courseId, parsed.data);
        agentSessions.set(created.session.sessionId, {
          courseId: request.params.courseId,
          session: created.session,
        });
        return reply.code(201).send({
          ok: true,
          data: {
            ...agentSessionInfo(created.session, request.params.courseId, false),
            modelAvailable: Boolean(created.session.model),
            ...(created.modelFallbackMessage ? { modelFallbackMessage: created.modelFallbackMessage } : {}),
          },
        });
      } catch (error) {
        return agentError(reply, error);
      }
    },
  );

  server.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/sessions",
    async (request, reply) => {
      if (!app.courses.get(request.params.courseId)) return courseNotFound(reply);
      try {
        return { ok: true, data: await app.agent.listCourseSessions(request.params.courseId) };
      } catch (error) {
        return agentError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string; sessionId: string } }>(
    "/api/courses/:courseId/sessions/:sessionId/resume",
    async (request, reply) => {
      if (!app.courses.get(request.params.courseId)) return courseNotFound(reply);
      const existing = agentSessions.get(request.params.sessionId);
      if (existing) {
        if (existing.courseId !== request.params.courseId) return agentSessionNotFound(reply);
        return { ok: true, data: agentSessionInfo(existing.session, existing.courseId, true) };
      }
      try {
        const created = await app.agent.resumeCourseSession(request.params.courseId, request.params.sessionId);
        agentSessions.set(created.session.sessionId, {
          courseId: request.params.courseId,
          session: created.session,
        });
        return { ok: true, data: agentSessionInfo(created.session, request.params.courseId, true) };
      } catch (error) {
        return agentError(reply, error);
      }
    },
  );

  server.post<{ Params: { sessionId: string }; Body: unknown }>(
    "/api/sessions/:sessionId/messages",
    async (request, reply) => {
      const parsed = sendAgentMessageSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      const record = agentSessions.get(request.params.sessionId);
      if (!record) return agentSessionNotFound(reply);
      if (record.session.isStreaming) {
        return reply.code(409).send({
          ok: false,
          error: { code: "SESSION_BUSY", message: "The agent session is already processing a message.", retryable: true },
        });
      }

      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      writeAgentEvent(response, "ready", {
        sessionId: request.params.sessionId,
        courseId: record.courseId,
      });
      const unsubscribe = record.session.subscribe((event) => {
        const projected = projectAgentEvent(event);
        if (projected) writeAgentEvent(response, projected.type, projected.data);
      });
      try {
        await record.session.prompt(parsed.data.message, { expandPromptTemplates: false, source: "rpc" });
        writeAgentEvent(response, "complete", { sessionId: request.params.sessionId });
      } catch (error) {
        writeAgentEvent(response, "error", {
          code: "AGENT_UNAVAILABLE",
          message: "The local agent could not process the message.",
          retryable: true,
        });
      } finally {
        unsubscribe();
        response.end();
      }
    },
  );

  server.delete<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
    const record = agentSessions.get(request.params.sessionId);
    if (!record) return agentSessionNotFound(reply);
    record.session.dispose();
    agentSessions.delete(request.params.sessionId);
    return reply.code(204).send();
  });

  server.post<{ Body: unknown }>("/api/courses", async (request, reply) => {
    const parsed = createCourseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "INVALID_COURSE",
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
          retryable: false,
        },
      });
    }
    const course = await app.courses.create({
      name: parsed.data.name,
      teacher: parsed.data.teacher,
      term: parsed.data.term,
      ...(parsed.data.remoteCourseId ? { remoteCourseId: parsed.data.remoteCourseId } : {}),
    });
    return reply.code(201).send({ ok: true, data: course });
  });

  server.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/remote-resources",
    async (request, reply) => {
      if (!app.courses.get(request.params.courseId)) return courseNotFound(reply);
      return {
        ok: true,
        data: {
          resources: app.teachingNetwork.listResources(request.params.courseId),
          tree: app.teachingNetwork.resourceTree(request.params.courseId),
        },
      };
    },
  );

  server.post<{ Params: { courseId: string }; Body: unknown }>(
    "/api/courses/:courseId/documents/index",
    async (request, reply) => {
      const parsed = indexCourseAssetSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        return { ok: true, data: await app.documents.indexAsset(request.params.courseId, parsed.data.path) };
      } catch (error) {
        return documentError(reply, error);
      }
    },
  );

  server.get<{ Params: { courseId: string }; Querystring: unknown }>(
    "/api/courses/:courseId/documents/search",
    async (request, reply) => {
      const parsed = searchCourseSchema.safeParse(request.query);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        return { ok: true, data: await app.documents.search(request.params.courseId, parsed.data.query, parsed.data.limit) };
      } catch (error) {
        return documentError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string }; Body: unknown }>(
    "/api/courses/:courseId/documents/rebuild",
    async (request, reply) => {
      const parsed = rebuildCourseIndexSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        return { ok: true, data: await app.documents.rebuildCourseIndex(request.params.courseId) };
      } catch (error) {
        return documentError(reply, error);
      }
    },
  );

  server.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/note-sources",
    async (request, reply) => {
      try {
        return { ok: true, data: app.documents.listNoteSources(request.params.courseId) };
      } catch (error) {
        return documentError(reply, error);
      }
    },
  );

  server.get<{ Params: { courseId: string } }>(
    "/api/courses/:courseId/practice",
    async (request, reply) => {
      try {
        return { ok: true, data: await app.courses.listPracticeSets(request.params.courseId) };
      } catch (error) {
        return courseWorkspaceError(reply, error);
      }
    },
  );

  server.get<{ Params: { courseId: string; name: string } }>(
    "/api/courses/:courseId/practice/:name",
    async (request, reply) => {
      try {
        return { ok: true, data: await app.courses.readPracticeSet(request.params.courseId, request.params.name) };
      } catch (error) {
        return courseWorkspaceError(reply, error);
      }
    },
  );

  server.get<{
    Params: { courseId: string };
    Querystring: { kind?: "announcement" | "assignment" | "video" | "grade" };
  }>("/api/courses/:courseId/overview", async (request, reply) => {
    if (!app.courses.get(request.params.courseId)) return courseNotFound(reply);
    return {
      ok: true,
      data: app.teachingNetwork.listTeachingItems(request.params.courseId, request.query.kind),
    };
  });

  server.post<{ Params: { courseId: string; recordingId: string }; Body: unknown }>(
    "/api/courses/:courseId/recordings/:recordingId/transcribe",
    async (request, reply) => {
      const parsed = transcribeRecordingSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const job = app.recordings.transcribe(request.params.courseId, request.params.recordingId, {
          ...(parsed.data.otp ? { otp: parsed.data.otp } : {}),
        });
        return reply.code(202).send({ ok: true, data: job, jobId: job.jobId });
      } catch (error) {
        return recordingError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string; assignmentId: string }; Body: unknown }>(
    "/api/courses/:courseId/assignments/:assignmentId/download",
    async (request, reply) => {
      const parsed = downloadAssignmentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const job = app.teachingNetwork.downloadAssignment(
          request.params.courseId,
          request.params.assignmentId,
          parsed.data.otp ? { otp: parsed.data.otp } : {},
        );
        return reply.code(202).send({ ok: true, data: job, jobId: job.jobId });
      } catch (error) {
        return teachingNetworkError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string; announcementId: string }; Body: unknown }>(
    "/api/courses/:courseId/announcements/:announcementId/show",
    async (request, reply) => {
      const parsed = showAnnouncementSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const detail = await app.teachingNetwork.getAnnouncement(
          request.params.courseId,
          request.params.announcementId,
          {
            force: parsed.data.force,
            ...(parsed.data.otp ? { otp: parsed.data.otp } : {}),
          },
        );
        return reply.send({ ok: true, data: detail });
      } catch (error) {
        return teachingNetworkError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string; assignmentId: string }; Body: unknown }>(
    "/api/courses/:courseId/assignments/:assignmentId/approve",
    async (request, reply) => {
      const parsed = approveAssignmentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        return reply.code(201).send({ ok: true, data: await app.assignments.approve(request.params.courseId, request.params.assignmentId) });
      } catch (error) {
        return assignmentError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string; assignmentId: string }; Body: unknown }>(
    "/api/courses/:courseId/assignments/:assignmentId/export",
    async (request, reply) => {
      if (request.body && typeof request.body === "object" && Object.keys(request.body).length > 0) {
        return invalidRequest(reply, ["Export does not accept a request body."]);
      }
      try {
        return { ok: true, data: await app.pdf.exportAssignment(request.params.courseId, request.params.assignmentId) };
      } catch (error) {
        return pdfExportError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string; assignmentId: string }; Body: unknown }>(
    "/api/courses/:courseId/assignments/:assignmentId/submit",
    async (request, reply) => {
      const parsed = submitAssignmentSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const job = app.assignments.submit(
          request.params.courseId,
          request.params.assignmentId,
          parsed.data.approvalId,
          ...(parsed.data.otp ? [{ otp: parsed.data.otp }] : []),
        );
        return reply.code(202).send({ ok: true, data: job, jobId: job.jobId });
      } catch (error) {
        return assignmentError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string }; Body: unknown }>(
    "/api/courses/:courseId/remote-resources/sync",
    async (request, reply) => {
      const parsed = syncCourseContentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const job = app.teachingNetwork.syncCourseContent(request.params.courseId, {
          force: parsed.data.force,
          ...(parsed.data.otp ? { otp: parsed.data.otp } : {}),
        });
        return reply.code(202).send({ ok: true, data: job, jobId: job.jobId });
      } catch (error) {
        return teachingNetworkError(reply, error);
      }
    },
  );

  server.post<{ Params: { courseId: string }; Body: unknown }>(
    "/api/courses/:courseId/overview/sync",
    async (request, reply) => {
      const parsed = syncCourseContentSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const job = app.teachingNetwork.syncCourseOverview(request.params.courseId, {
          force: parsed.data.force,
          ...(parsed.data.otp ? { otp: parsed.data.otp } : {}),
        });
        return reply.code(202).send({ ok: true, data: job, jobId: job.jobId });
      } catch (error) {
        return teachingNetworkError(reply, error);
      }
    },
  );

  server.post<{
    Params: { courseId: string; resourceId: string };
    Body: unknown;
  }>(
    "/api/courses/:courseId/remote-resources/:resourceId/import",
    async (request, reply) => {
      const parsed = importRemoteResourceSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const job = app.teachingNetwork.importResource(
          request.params.courseId,
          request.params.resourceId,
          parsed.data.otp ? { otp: parsed.data.otp } : {},
        );
        return reply.code(202).send({ ok: true, data: job, jobId: job.jobId });
      } catch (error) {
        return teachingNetworkError(reply, error);
      }
    },
  );

  server.get("/api/jobs", async () => ({ ok: true, data: app.jobs.listActive() }));

  server.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const job = app.jobs.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send({
        ok: false,
        error: { code: "JOB_NOT_FOUND", message: "Job not found.", retryable: false },
      });
    }
    return { ok: true, data: job };
  });

  server.post<{ Params: { jobId: string }; Body: unknown }>(
    "/api/jobs/:jobId/resume-auth",
    async (request, reply) => {
      const parsed = resumeTeachingNetworkJobSchema.safeParse(request.body);
      if (!parsed.success) return invalidRequest(reply, parsed.error.issues.map((issue) => issue.message));
      try {
        const context = app.store.getJobContext(request.params.jobId);
        if (context?.operation === "transcribe-recording") {
          return { ok: true, data: app.recordings.resume(request.params.jobId, parsed.data.otp) };
        }
        if (context?.operation === "submit-assignment") {
          return { ok: true, data: app.assignments.resume(request.params.jobId, parsed.data.otp) };
        }
        return { ok: true, data: app.teachingNetwork.resume(request.params.jobId, parsed.data.otp) };
      } catch (error) {
        return assignmentRecordingOrTeachingNetworkError(reply, error);
      }
    },
  );

  server.get("/api/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ activeJobs: app.jobs.listActive() })}\n\n`);

    const onJob = (job: JobRecord): void => {
      response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    };
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    app.jobs.on("job", onJob);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      app.jobs.off("job", onJob);
    });
  });

  const webRoot = options.webRoot ?? join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (await pathExists(join(webRoot, "index.html"))) {
    await server.register(fastifyStatic, { root: webRoot, wildcard: false });
    server.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: "API route not found.", retryable: false },
        });
      }
      return reply.sendFile("index.html");
    });
  }

  return {
    server,
    app,
    apiToken,
    close: async () => {
      for (const { session } of agentSessions.values()) session.dispose();
      agentSessions.clear();
      await server.close();
      if (ownsApp) app.close();
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function invalidRequest(reply: import("fastify").FastifyReply, issues: string[]) {
  return reply.code(400).send({
    ok: false,
    error: { code: "INVALID_REQUEST", message: issues.join("; "), retryable: false },
  });
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function courseNotFound(reply: import("fastify").FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: { code: "COURSE_NOT_FOUND", message: "Course not found.", retryable: false },
  });
}

function teachingNetworkError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof TeachingNetworkError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
      ...(error.requiresAction ? { requiresAction: error.requiresAction } : {}),
    });
  }
  throw error;
}

function recordingError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof RecordingServiceError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
    });
  }
  throw error;
}

function recordingOrTeachingNetworkError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof RecordingServiceError) return recordingError(reply, error);
  return teachingNetworkError(reply, error);
}

function assignmentError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof AssignmentServiceError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
    });
  }
  throw error;
}

function pdfExportError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof PdfExportServiceError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
    });
  }
  throw error;
}

function assignmentRecordingOrTeachingNetworkError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof AssignmentServiceError) return assignmentError(reply, error);
  return recordingOrTeachingNetworkError(reply, error);
}

function documentError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof DocumentServiceError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: false },
    });
  }
  throw error;
}

function courseWorkspaceError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof CourseWorkspaceError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: false },
    });
  }
  throw error;
}

function candidateError(reply: import("fastify").FastifyReply, error: unknown) {
  if (error instanceof CourseCandidateError) {
    return reply.code(error.statusCode).send({
      ok: false,
      error: { code: error.code, message: error.message, retryable: error.statusCode >= 500 },
    });
  }
  throw error;
}

function treeholeResult<T>(
  reply: import("fastify").FastifyReply,
  result: import("@pku-study/core").ToolResult<T>,
) {
  if (result.ok) return { ok: true, data: result.data };
  const statusCode = result.error.code === "TREEHOLE_VERIFICATION_REQUIRED"
    ? 409
    : result.error.code === "TREEHOLE_LOGIN_REJECTED" ||
        result.error.code === "TREEHOLE_AUTH_REQUIRED" ||
        result.error.code === "TREEHOLE_AUTH_EXPIRED"
      ? 401
      : result.error.retryable
        ? 503
        : 400;
  return reply.code(statusCode).send({
    ok: false,
    error: result.error,
  });
}

function agentSessionNotFound(reply: import("fastify").FastifyReply) {
  return reply.code(404).send({
    ok: false,
    error: { code: "SESSION_NOT_FOUND", message: "Agent session not found.", retryable: false },
  });
}

function agentError(reply: import("fastify").FastifyReply, error: unknown) {
  const statusCode = isAgentDomainError(error) ? error.statusCode : 503;
  const code = isAgentDomainError(error) ? error.code : "AGENT_UNAVAILABLE";
  const message = statusCode === 404
    ? "Agent session not found."
    : statusCode === 400
      ? "Invalid agent session request."
      : "Agent runtime is unavailable.";
  return reply.code(statusCode).send({
    ok: false,
    error: {
      code,
      message,
      retryable: statusCode >= 500,
    },
  });
}

function agentSessionInfo(
  session: AgentSession,
  courseId: string,
  persistent: boolean,
): {
  sessionId: string;
  courseId: string;
  tools: string[];
  modelAvailable: boolean;
  persistent: boolean;
  name?: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
} {
  const name = session.sessionManager.getSessionName();
  return {
    sessionId: session.sessionId,
    courseId,
    tools: session.getActiveToolNames(),
    modelAvailable: Boolean(session.model),
    persistent,
    ...(name ? { name } : {}),
    messages: projectSessionMessages(session),
  };
}

function projectSessionMessages(session: AgentSession): Array<{ role: "user" | "assistant"; text: string }> {
  return session.state.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textContent(message);
    return text ? [{ role: message.role, text }] : [];
  });
}

function textContent(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
    })
    .join("");
}

function isAgentDomainError(error: unknown): error is { code: string; statusCode: number } {
  return typeof error === "object" && error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { statusCode?: unknown }).statusCode === "number";
}

function writeAgentEvent(response: import("node:http").ServerResponse, type: string, data: unknown): void {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function projectAgentEvent(event: {
  type: string;
  [key: string]: unknown;
}): { type: string; data: Record<string, unknown> } | undefined {
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      return { type: "text_delta", data: { delta: update.delta } };
    }
    return undefined;
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_start",
      data: {
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
        toolName: typeof event.toolName === "string" ? event.toolName : "",
      },
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_end",
      data: {
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
        toolName: typeof event.toolName === "string" ? event.toolName : "",
        isError: event.isError === true,
      },
    };
  }
  return undefined;
}

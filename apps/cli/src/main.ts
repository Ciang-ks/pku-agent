#!/usr/bin/env node
import { createApplication, runDoctor } from "@pku-study/core";
import { createServer, loadOrCreateApiToken } from "@pku-study/server";
import { Command } from "commander";

const program = new Command()
  .name("pku-study")
  .description("Local-first PKU learning workspace")
  .version("0.1.0")
  .option("--pretty", "pretty-print JSON output", false);

program
  .command("doctor")
  .description("Check local runtime and external learning tools")
  .action(async () => {
    const app = createApplication();
    try {
      print(await runDoctor({ paths: app.paths }));
    } finally {
      app.close();
    }
  });

program
  .command("serve")
  .description("Start the authenticated local Web/API service")
  .option("--host <host>", "listen host", "127.0.0.1")
  .option("--port <port>", "listen port", "4317")
  .action(async (options: { host: string; port: string }) => {
    const instance = await createServer();
    await instance.server.listen({ host: options.host, port: Number(options.port) });
    print({
      ok: true,
      data: {
        url: `http://${options.host}:${options.port}`,
        tokenPath: instance.app.paths.tokenPath,
      },
    });
    const shutdown = async (): Promise<void> => {
      await instance.close();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

const course = program.command("course").description("Manage local course workspaces");
const candidate = program.command("candidate").description("Manage course candidates and live treehole evidence");
const recording = program.command("recording").description("Download and transcribe synchronized course recordings");
const assignment = program.command("assignment").description("Approve and submit reviewed assignment answers");
const practice = program.command("practice").description("Read saved self-study practice sets");

candidate.command("list").action(() => {
  const app = createApplication();
  try {
    print({ ok: true, data: app.candidates.list() });
  } finally {
    app.close();
  }
});

candidate
  .command("add")
  .requiredOption("--name <name>")
  .requiredOption("--teacher <teacher>")
  .option("--alias <alias...>")
  .action((options: { name: string; teacher: string; alias?: string[] }) => {
    const app = createApplication();
    try {
      print({
        ok: true,
        data: app.candidates.create({ name: options.name, teacher: options.teacher, aliases: options.alias ?? [] }),
      });
    } finally {
      app.close();
    }
  });

candidate
  .command("status")
  .requiredOption("--candidate-id <id>")
  .requiredOption("--status <status>", "followed|rejected")
  .action((options: { candidateId: string; status: string }) => {
    if (options.status !== "followed" && options.status !== "rejected") {
      throw new Error("Candidate status must be followed or rejected.");
    }
    const app = createApplication();
    try {
      print({ ok: true, data: app.candidates.updateStatus(options.candidateId, options.status) });
    } finally {
      app.close();
    }
  });

candidate
  .command("review")
  .requiredOption("--candidate-id <id>")
  .option("--keyword <keyword...>")
  .action(async (options: { candidateId: string; keyword?: string[] }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.candidates.collectEvidence(options.candidateId, options.keyword) });
    } finally {
      app.close();
    }
  });

const treehole = program.command("treehole").description("Search live treehole posts without persisting their text");

treehole.command("status").action(async () => {
  const app = createApplication();
  try {
    print(await app.treehole.authStatus());
  } finally {
    app.close();
  }
});

treehole
  .command("ask")
  .requiredOption("--query <query>")
  .option("--keyword <keyword...>")
  .action(async (options: { query: string; keyword?: string[] }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.candidates.ask(options.query, options.keyword) });
    } finally {
      app.close();
    }
  });

recording
  .command("transcribe")
  .requiredOption("--course-id <id>")
  .requiredOption("--recording-id <id>")
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; recordingId: string; otp?: string }) => {
    const app = createApplication();
    try {
      const job = app.recordings.transcribe(options.courseId, options.recordingId, {
        ...(options.otp ? { otp: options.otp } : {}),
      });
      print({ ok: true, data: await app.recordings.wait(job.jobId), jobId: job.jobId });
    } finally {
      app.close();
    }
  });

assignment
  .command("download")
  .description("Download attachments for a synchronized stable assignment into its controlled workspace directory")
  .requiredOption("--course-id <id>")
  .requiredOption("--assignment-id <id>")
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; assignmentId: string; otp?: string }) => {
    const app = createApplication();
    try {
      const job = app.teachingNetwork.downloadAssignment(options.courseId, options.assignmentId, {
        ...(options.otp ? { otp: options.otp } : {}),
      });
      print({ ok: true, data: await app.teachingNetwork.wait(job.jobId), jobId: job.jobId });
    } finally {
      app.close();
    }
  });

assignment
  .command("export")
  .requiredOption("--course-id <id>")
  .requiredOption("--assignment-id <id>")
  .action(async (options: { courseId: string; assignmentId: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.pdf.exportAssignment(options.courseId, options.assignmentId) });
    } finally {
      app.close();
    }
  });

assignment
  .command("approve")
  .requiredOption("--course-id <id>")
  .requiredOption("--assignment-id <id>")
  .action(async (options: { courseId: string; assignmentId: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.assignments.approve(options.courseId, options.assignmentId) });
    } finally {
      app.close();
    }
  });

assignment
  .command("submit")
  .requiredOption("--course-id <id>")
  .requiredOption("--assignment-id <id>")
  .requiredOption("--approval-id <id>")
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; assignmentId: string; approvalId: string; otp?: string }) => {
    const app = createApplication();
    try {
      const job = app.assignments.submit(options.courseId, options.assignmentId, options.approvalId, {
        ...(options.otp ? { otp: options.otp } : {}),
      });
      print({ ok: true, data: await app.assignments.wait(job.jobId), jobId: job.jobId });
    } finally {
      app.close();
    }
  });

practice
  .command("list")
  .requiredOption("--course-id <id>")
  .action(async (options: { courseId: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.courses.listPracticeSets(options.courseId) });
    } finally {
      app.close();
    }
  });

practice
  .command("show")
  .requiredOption("--course-id <id>")
  .requiredOption("--name <name>")
  .action(async (options: { courseId: string; name: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.courses.readPracticeSet(options.courseId, options.name) });
    } finally {
      app.close();
    }
  });

course.command("list").action(() => {
  const app = createApplication();
  try {
    print({ ok: true, data: app.courses.list() });
  } finally {
    app.close();
  }
});

course
  .command("add")
  .requiredOption("--name <name>")
  .requiredOption("--teacher <teacher>")
  .requiredOption("--term <term>")
  .option("--remote-course-id <id>")
  .action(async (options: { name: string; teacher: string; term: string; remoteCourseId?: string }) => {
    const app = createApplication();
    try {
      const created = await app.courses.create({
        name: options.name,
        teacher: options.teacher,
        term: options.term,
        ...(options.remoteCourseId ? { remoteCourseId: options.remoteCourseId } : {}),
      });
      print({ ok: true, data: created });
    } finally {
      app.close();
    }
  });

course
  .command("sync")
  .description("Synchronize teaching-network resources for a mapped course")
  .requiredOption("--course-id <id>")
  .option("--force", "bypass pku3b metadata cache", false)
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; force: boolean; otp?: string }) => {
    const app = createApplication();
    try {
      const job = app.teachingNetwork.syncCourseContent(options.courseId, {
        force: options.force,
        ...(options.otp ? { otp: options.otp } : {}),
      });
      print({ ok: true, data: await app.teachingNetwork.wait(job.jobId), jobId: job.jobId });
    } finally {
      app.close();
    }
  });

course
  .command("sync-overview")
  .description("Synchronize announcements, assignments, videos and grades")
  .requiredOption("--course-id <id>")
  .option("--force", "bypass pku3b metadata cache", false)
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; force: boolean; otp?: string }) => {
    const app = createApplication();
    try {
      const job = app.teachingNetwork.syncCourseOverview(options.courseId, {
        force: options.force,
        ...(options.otp ? { otp: options.otp } : {}),
      });
      print({ ok: true, data: await app.teachingNetwork.wait(job.jobId), jobId: job.jobId });
    } finally {
      app.close();
    }
  });

course
  .command("overview")
  .description("List synchronized announcements, assignments, videos and grades")
  .requiredOption("--course-id <id>")
  .option("--kind <kind>", "announcement|assignment|video|grade")
  .action((options: { courseId: string; kind?: string }) => {
    const kinds = ["announcement", "assignment", "video", "grade"] as const;
    if (options.kind && !kinds.includes(options.kind as (typeof kinds)[number])) {
      throw new Error(`Unsupported overview kind: ${options.kind}`);
    }
    const app = createApplication();
    try {
      print({
        ok: true,
        data: app.teachingNetwork.listTeachingItems(
          options.courseId,
          options.kind as (typeof kinds)[number] | undefined,
        ),
      });
    } finally {
      app.close();
    }
  });

course
  .command("announcement")
  .description("Show the structured detail for a synchronized announcement")
  .requiredOption("--course-id <id>")
  .requiredOption("--announcement-id <id>")
  .option("--force", "bypass pku3b metadata cache", false)
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; announcementId: string; force: boolean; otp?: string }) => {
    const app = createApplication();
    try {
      print({
        ok: true,
        data: await app.teachingNetwork.getAnnouncement(options.courseId, options.announcementId, {
          force: options.force,
          ...(options.otp ? { otp: options.otp } : {}),
        }),
      });
    } finally {
      app.close();
    }
  });

course
  .command("resources")
  .description("List synchronized remote resources")
  .requiredOption("--course-id <id>")
  .action((options: { courseId: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: app.teachingNetwork.resourceTree(options.courseId) });
    } finally {
      app.close();
    }
  });

course
  .command("index")
  .description("Index a Markdown or text asset inside a course workspace")
  .requiredOption("--course-id <id>")
  .requiredOption("--path <path>")
  .action(async (options: { courseId: string; path: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.documents.indexAsset(options.courseId, options.path) });
    } finally {
      app.close();
    }
  });

course
  .command("search")
  .description("Search indexed course assets")
  .requiredOption("--course-id <id>")
  .requiredOption("--query <query>")
  .option("--limit <limit>", "maximum number of results", "10")
  .action(async (options: { courseId: string; query: string; limit: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.documents.search(options.courseId, options.query, Number(options.limit)) });
    } finally {
      app.close();
    }
  });

course
  .command("reindex")
  .description("Rebuild the searchable index from course text assets")
  .requiredOption("--course-id <id>")
  .action(async (options: { courseId: string }) => {
    const app = createApplication();
    try {
      print({ ok: true, data: await app.documents.rebuildCourseIndex(options.courseId) });
    } finally {
      app.close();
    }
  });

course
  .command("import")
  .description("Import a synchronized resource into the controlled course directory")
  .requiredOption("--course-id <id>")
  .requiredOption("--resource-id <id>")
  .option("--otp <code>", "one-time mobile token; never persisted")
  .action(async (options: { courseId: string; resourceId: string; otp?: string }) => {
    const app = createApplication();
    try {
      const job = app.teachingNetwork.importResource(options.courseId, options.resourceId, {
        ...(options.otp ? { otp: options.otp } : {}),
      });
      print({ ok: true, data: await app.teachingNetwork.wait(job.jobId), jobId: job.jobId });
    } finally {
      app.close();
    }
  });

program
  .command("resume-auth")
  .description("Resume a teaching-network job waiting for a one-time token")
  .requiredOption("--job-id <id>")
  .requiredOption("--otp <code>")
  .action(async (options: { jobId: string; otp: string }) => {
    const app = createApplication();
    try {
      const context = app.store.getJobContext(options.jobId);
      if (context?.operation === "transcribe-recording") {
        app.recordings.resume(options.jobId, options.otp);
        print({ ok: true, data: await app.recordings.wait(options.jobId), jobId: options.jobId });
      } else if (context?.operation === "submit-assignment") {
        app.assignments.resume(options.jobId, options.otp);
        print({ ok: true, data: await app.assignments.wait(options.jobId), jobId: options.jobId });
      } else {
        app.teachingNetwork.resume(options.jobId, options.otp);
        print({ ok: true, data: await app.teachingNetwork.wait(options.jobId), jobId: options.jobId });
      }
    } finally {
      app.close();
    }
  });

program.command("pku3b-status").description("Show the pku3b integration state").action(async () => {
  const app = createApplication();
  try {
    print({ ok: true, data: await app.teachingNetwork.status() });
  } finally {
    app.close();
  }
});

program.command("token").description("Print the local API token").action(async () => {
  const app = createApplication();
  try {
    const token = await loadOrCreateApiToken(app.paths.tokenPath);
    print({ ok: true, data: { token, tokenPath: app.paths.tokenPath } });
  } finally {
    app.close();
  }
});

await program.parseAsync(process.argv);

function print(value: unknown): void {
  const pretty = program.opts<{ pretty: boolean }>().pretty;
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

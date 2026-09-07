import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PiAgentService } from "./agent/pi-agent-service.js";
import { CourseCandidateService } from "./candidates/course-candidate-service.js";
import { JobManager } from "./jobs/job-manager.js";
import {
  TeachingNetworkService,
  type Pku3bExecutor,
} from "./integrations/pku3b/teaching-network-service.js";
import { resolveAppPaths, type AppPaths } from "./paths.js";
import { CourseWorkspaceService } from "./storage/course-workspace-service.js";
import { SqliteStore } from "./storage/sqlite-store.js";
import { DocumentService } from "./documents/document-service.js";
import type { DocumentParserProvider, EmbeddingProvider, PdfRenderer, TranscriptionProvider } from "./domain/types.js";
import { RecordingService } from "./recordings/recording-service.js";
import type { AudioProcessor } from "./recordings/ffmpeg-audio-processor.js";
import { AssignmentService } from "./assignments/assignment-service.js";
import { PdfExportService } from "./assignments/pdf-export-service.js";
import {
  HttpTreeholeProvider,
  type TreeholeProvider,
} from "./integrations/treehole/treehole-provider.js";

export interface ApplicationContext {
  paths: AppPaths;
  store: SqliteStore;
  courses: CourseWorkspaceService;
  jobs: JobManager;
  teachingNetwork: TeachingNetworkService;
  documents: DocumentService;
  recordings: RecordingService;
  assignments: AssignmentService;
  pdf: PdfExportService;
  candidates: CourseCandidateService;
  treehole: TreeholeProvider;
  agent: PiAgentService;
  close(): void;
}

export interface CreateApplicationOptions {
  paths?: Partial<AppPaths>;
  pku3b?: Pku3bExecutor;
  documentParser?: DocumentParserProvider;
  embeddings?: EmbeddingProvider;
  transcriptions?: TranscriptionProvider;
  audioProcessor?: AudioProcessor;
  pdfRenderer?: PdfRenderer;
  treehole?: TreeholeProvider;
}

export function createApplication(
  overridesOrOptions: Partial<AppPaths> | CreateApplicationOptions = {},
): ApplicationContext {
  const options = isApplicationOptions(overridesOrOptions)
    ? overridesOrOptions
    : { paths: overridesOrOptions };
  const overrides = options.paths ?? {};
  const paths = resolveAppPaths(overrides);
  for (const path of [
    paths.dataDir,
    paths.configDir,
    paths.cacheDir,
    paths.coursesDir,
    paths.pku3bCacheDir,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  const store = new SqliteStore(paths.databasePath);
  const courses = new CourseWorkspaceService(store, paths.coursesDir);
  const jobs = new JobManager(store);
  const teachingNetwork = new TeachingNetworkService({
    store,
    courses,
    jobs,
    paths,
    ...(options.pku3b ? { pku3b: options.pku3b } : {}),
  });
  const documents = new DocumentService({
    store,
    courses,
    ...(options.documentParser ? { parser: options.documentParser } : {}),
    ...(options.embeddings ? { embeddings: options.embeddings } : {}),
  });
  const treehole = options.treehole ?? defaultTreeholeProvider();
  const candidates = new CourseCandidateService(store, treehole);
  const recordings = new RecordingService({
    store,
    courses,
    jobs,
    documents,
    teachingNetwork,
    paths,
    ...(options.transcriptions ? { transcriptions: options.transcriptions } : {}),
    ...(options.audioProcessor ? { audioProcessor: options.audioProcessor } : {}),
  });
  const assignments = new AssignmentService({
    store,
    courses,
    jobs,
    teachingNetwork,
  });
  const pdf = new PdfExportService({
    store,
    courses,
    ...(options.pdfRenderer ? { renderer: options.pdfRenderer } : {}),
  });
  return {
    paths,
    store,
    courses,
    jobs,
    teachingNetwork,
    documents,
    recordings,
    assignments,
    pdf,
    candidates,
    treehole,
    agent: new PiAgentService({
      store,
      courses,
      jobs,
      teachingNetwork,
      documents,
      candidates,
      agentDir: join(paths.configDir, "pi-agent"),
      sessionDir: join(paths.dataDir, "agent-sessions"),
    }),
    close: () => store.close(),
  };
}

function defaultTreeholeProvider(): TreeholeProvider {
  const baseUrl = process.env.PKU_STUDY_TREEHOLE_BASE_URL?.trim() || "https://treehole.pku.edu.cn";
  const authorization = process.env.PKU_STUDY_TREEHOLE_AUTHORIZATION?.trim();
  return new HttpTreeholeProvider({
    baseUrl,
    ...(authorization ? { getHeaders: () => ({ authorization }) } : {}),
  });
}

function isApplicationOptions(
  value: Partial<AppPaths> | CreateApplicationOptions,
): value is CreateApplicationOptions {
  return "paths" in value || "pku3b" in value || "documentParser" in value || "embeddings" in value ||
    "transcriptions" in value || "audioProcessor" in value || "pdfRenderer" in value || "treehole" in value;
}

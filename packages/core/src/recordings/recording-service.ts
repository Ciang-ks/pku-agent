import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type {
  JobRecord,
  RecordingJobContext,
  TeachingItem,
  TranscriptionProvider,
} from "../domain/types.js";
import type { DocumentService } from "../documents/document-service.js";
import type { TeachingNetworkService } from "../integrations/pku3b/teaching-network-service.js";
import type { JobManager } from "../jobs/job-manager.js";
import type { AppPaths } from "../paths.js";
import type { CourseWorkspaceService } from "../storage/course-workspace-service.js";
import type { SqliteStore } from "../storage/sqlite-store.js";
import { type AudioChunk, type AudioProcessor, FfmpegAudioProcessor } from "./ffmpeg-audio-processor.js";
import { OpenAiTranscriptionProvider, TranscriptionProviderError } from "./openai-transcription-provider.js";

const MAX_AUDIO_CHUNK_BYTES = 25 * 1024 * 1024;
const DOWNLOADED_VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".flv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".webm"]);

export interface RecordingServiceOptions {
  store: SqliteStore;
  jobs: JobManager;
  courses: CourseWorkspaceService;
  documents: DocumentService;
  teachingNetwork: TeachingNetworkService;
  paths: AppPaths;
  transcriptions?: TranscriptionProvider;
  audioProcessor?: AudioProcessor;
}

export class RecordingService {
  private readonly inFlight = new Map<string, Promise<JobRecord>>();
  private readonly transcriptions: TranscriptionProvider;
  private readonly audioProcessor: AudioProcessor;

  constructor(private readonly options: RecordingServiceOptions) {
    this.transcriptions = options.transcriptions ?? new OpenAiTranscriptionProvider();
    this.audioProcessor = options.audioProcessor ?? new FfmpegAudioProcessor();
  }

  transcribe(courseId: string, recordingId: string, input: { otp?: string } = {}): JobRecord {
    const course = this.requireCourse(courseId);
    const recording = this.requireRecording(courseId, recordingId);
    if (!this.transcriptions.isAvailable()) {
      throw new RecordingServiceError(
        "TRANSCRIPTION_UNAVAILABLE",
        "Configure OPENAI_API_KEY or provide a transcription provider before starting a recording job.",
        503,
      );
    }
    const job = this.options.jobs.create("recording.transcribe", `转写 ${course.name}：${recording.title}`);
    const context: RecordingJobContext = { operation: "transcribe-recording", courseId, recordingId };
    this.options.store.setJobContext(job.jobId, context);
    this.track(job.jobId, this.execute(job.jobId, context, input.otp));
    return job;
  }

  resume(jobId: string, otp: string): JobRecord {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new RecordingServiceError("JOB_NOT_FOUND", "Job not found.", 404);
    if (job.status !== "waiting_for_auth") {
      throw new RecordingServiceError("JOB_NOT_WAITING_FOR_AUTH", "Only a job waiting for authentication can be resumed.", 409);
    }
    const context = this.options.store.getJobContext(jobId);
    if (!context || context.operation !== "transcribe-recording") {
      throw new RecordingServiceError("JOB_CONTEXT_MISSING", "Job cannot be resumed as a recording task.", 409);
    }
    this.options.jobs.update(jobId, {
      status: "running",
      progress: Math.max(0.05, job.progress),
      message: "使用本次 OTP 恢复录播转写",
      requiresAction: "",
      errorCode: "",
      errorMessage: "",
    });
    this.track(jobId, this.execute(jobId, context, otp, true));
    return this.options.jobs.get(jobId) as JobRecord;
  }

  async wait(jobId: string): Promise<JobRecord> {
    return this.inFlight.get(jobId) ?? this.requireJob(jobId);
  }

  private async execute(
    jobId: string,
    context: RecordingJobContext,
    otp?: string,
    alreadyRunning = false,
  ): Promise<JobRecord> {
    if (!alreadyRunning) {
      this.options.jobs.update(jobId, {
        status: "running",
        progress: 0.05,
        message: "正在下载教学网录播",
      });
    }
    const workDir = join(this.options.paths.cacheDir, "recording-jobs", jobId);
    try {
      await rm(workDir, { recursive: true, force: true });
      const downloadDir = join(workDir, "download");
      const audioDir = join(workDir, "audio");
      await Promise.all([mkdir(downloadDir, { recursive: true }), mkdir(audioDir, { recursive: true })]);

      const download = await this.options.teachingNetwork.downloadVideo(context.recordingId, downloadDir, otp);
      if (!download.ok) return this.handleDownloadFailure(jobId, download);
      const videoPath = await findDownloadedMedia(downloadDir);
      this.options.jobs.update(jobId, { progress: 0.2, message: "正在按静音边界提取音频" });
      const chunks = await this.audioProcessor.split({ videoPath, outputDir: audioDir });
      await validateAudioChunks(chunks, audioDir);

      const course = this.requireCourse(context.courseId);
      const recording = this.requireRecording(context.courseId, context.recordingId);
      const transcripts: Array<AudioChunk & { text: string }> = [];
      let previousText = "";
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        this.options.jobs.update(jobId, {
          progress: 0.2 + (0.65 * index) / chunks.length,
          message: `正在转写片段 ${index + 1}/${chunks.length}`,
        });
        const result = await this.transcriptions.transcribe({
          filePath: chunk.filePath,
          prompt: transcriptionPrompt(course.name, course.teacher, recording.title, previousText),
          keywords: [course.name, course.teacher, recording.title].filter(Boolean),
          languages: ["zh-cn", "en"],
        });
        previousText = result.text.slice(-1_500);
        transcripts.push({ ...chunk, text: result.text });
      }

      validateTranscriptCoverage(transcripts);
      this.options.jobs.update(jobId, { progress: 0.9, message: "正在保存并索引转写稿" });
      const asset = await this.options.courses.writeMarkdownAsset(
        context.courseId,
        "recording-transcript",
        `${recording.title}-${context.recordingId}`,
        transcriptMarkdown(course.name, recording.title, transcripts),
      );
      await this.options.documents.indexAsset(context.courseId, asset.sourcePath);
      return this.options.jobs.update(jobId, {
        status: "completed",
        progress: 1,
        message: asset.sourcePath,
      });
    } catch (error) {
      return this.fail(jobId, error);
    } finally {
      await Promise.allSettled([
        rm(workDir, { recursive: true, force: true }),
        this.options.teachingNetwork.clearVideoCache(context.recordingId),
      ]);
    }
  }

  private handleDownloadFailure(
    jobId: string,
    result: Awaited<ReturnType<TeachingNetworkService["downloadVideo"]>>,
  ): JobRecord {
    if (result.ok) throw new Error("Expected a failed video download result.");
    if (result.requiresAction) {
      return this.options.jobs.update(jobId, {
        status: "waiting_for_auth",
        progress: 0.05,
        message: result.requiresAction === "provide_otp" ? "教学网需要本次手机令牌" : "需要先初始化 pku3b 配置",
        errorCode: result.error.code,
        errorMessage: result.error.message,
        requiresAction: result.requiresAction,
      });
    }
    return this.options.jobs.update(jobId, {
      status: "failed",
      errorCode: result.error.code,
      errorMessage: result.error.message,
      message: "录播下载失败",
    });
  }

  private fail(jobId: string, error: unknown): JobRecord {
    const code = error instanceof RecordingServiceError || error instanceof TranscriptionProviderError
      ? error.code
      : "RECORDING_TRANSCRIPTION_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    return this.options.jobs.update(jobId, {
      status: "failed",
      errorCode: code,
      errorMessage: message.slice(0, 500),
      message: "录播转写失败",
    });
  }

  private requireCourse(courseId: string) {
    const course = this.options.courses.get(courseId);
    if (!course) throw new RecordingServiceError("COURSE_NOT_FOUND", "Course not found.", 404);
    return course;
  }

  private requireRecording(courseId: string, recordingId: string): TeachingItem {
    const recording = this.options.store
      .listTeachingItems(courseId, "video")
      .find((item) => item.remoteId === recordingId && item.remoteIdStable);
    if (!recording) {
      throw new RecordingServiceError("RECORDING_NOT_FOUND", "A synchronized recording with a stable remote ID is required.", 404);
    }
    return recording;
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new RecordingServiceError("JOB_NOT_FOUND", "Job not found.", 404);
    return job;
  }

  private track(jobId: string, promise: Promise<JobRecord>): void {
    const tracked = promise.finally(() => this.inFlight.delete(jobId));
    this.inFlight.set(jobId, tracked);
  }
}

export class RecordingServiceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
  }
}

async function findDownloadedMedia(root: string): Promise<string> {
  const candidates: string[] = [];
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new RecordingServiceError("DOWNLOADED_MEDIA_UNSAFE", "Downloaded media contains a symbolic link.", 502);
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile() && DOWNLOADED_VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) candidates.push(path);
    }
  };
  await scan(root);
  if (candidates.length === 0) throw new RecordingServiceError("RECORDING_MEDIA_MISSING", "pku3b did not produce a supported recording file.", 502);
  const sizes = await Promise.all(candidates.map(async (path) => ({ path, size: (await stat(path)).size })));
  return sizes.sort((left, right) => right.size - left.size)[0]!.path;
}

async function validateAudioChunks(chunks: AudioChunk[], outputDir: string): Promise<void> {
  const root = resolve(outputDir);
  if (chunks.length === 0) throw new RecordingServiceError("AUDIO_CHUNKS_MISSING", "No audio chunks were produced.", 502);
  for (const chunk of chunks) {
    const absolutePath = resolve(chunk.filePath);
    const rel = relative(root, absolutePath);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || !AUDIO_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
      throw new RecordingServiceError("AUDIO_CHUNK_UNSAFE", "Audio processor returned an unsafe chunk path.", 502);
    }
    if (!Number.isFinite(chunk.startSeconds) || !Number.isFinite(chunk.endSeconds) || chunk.endSeconds <= chunk.startSeconds) {
      throw new RecordingServiceError("AUDIO_CHUNK_INVALID", "Audio processor returned invalid timestamps.", 502);
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_AUDIO_CHUNK_BYTES) {
      throw new RecordingServiceError("AUDIO_CHUNK_INVALID", "Audio processor returned an invalid chunk file.", 502);
    }
  }
}

function validateTranscriptCoverage(chunks: Array<AudioChunk & { text: string }>): void {
  let previousEnd: number | undefined;
  for (const chunk of chunks) {
    if (!chunk.text.trim()) throw new RecordingServiceError("TRANSCRIPT_EMPTY", "A transcription chunk was empty.", 502);
    if (
      chunk.endSeconds <= chunk.startSeconds ||
      (previousEnd === undefined && chunk.startSeconds > 2) ||
      (previousEnd !== undefined && Math.abs(chunk.startSeconds - previousEnd) > 2)
    ) {
      throw new RecordingServiceError("TRANSCRIPT_TIMELINE_INVALID", "Transcription chunks have a gap or overlap in time.", 502);
    }
    previousEnd = chunk.endSeconds;
  }
}

function transcriptionPrompt(courseName: string, teacher: string, recordingTitle: string, previousText: string): string {
  const context = [
    `北京大学课程：${courseName}。`,
    `教师：${teacher}。`,
    `录播：${recordingTitle}。`,
    previousText ? `上一片段末尾：${previousText}` : "",
  ].filter(Boolean).join("\n");
  return context.slice(0, 6_000);
}

function transcriptMarkdown(
  courseName: string,
  recordingTitle: string,
  chunks: Array<AudioChunk & { text: string }>,
): string {
  return [
    `# ${recordingTitle} - 录播转写`,
    "",
    `课程：${courseName}`,
    `生成时间：${new Date().toISOString()}`,
    "",
    ...chunks.map((chunk) => `[${timestamp(chunk.startSeconds)}–${timestamp(chunk.endSeconds)}] ${chunk.text.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
}

function timestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":");
}

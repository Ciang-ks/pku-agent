import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MEBIBYTE = 1024 * 1024;

export interface AudioChunk {
  filePath: string;
  startSeconds: number;
  endSeconds: number;
}

export interface AudioProcessor {
  split(input: { videoPath: string; outputDir: string }): Promise<AudioChunk[]>;
}

export interface FfmpegAudioProcessorOptions {
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
  maxChunkBytes?: number;
  maxChunkSeconds?: number;
  silenceNoise?: string;
  silenceDurationSeconds?: number;
}

export class FfmpegAudioProcessor implements AudioProcessor {
  private readonly ffmpegExecutable: string;
  private readonly ffprobeExecutable: string;
  private readonly maxChunkBytes: number;
  private readonly maxChunkSeconds: number;
  private readonly silenceNoise: string;
  private readonly silenceDurationSeconds: number;

  constructor(options: FfmpegAudioProcessorOptions = {}) {
    this.ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
    this.ffprobeExecutable = options.ffprobeExecutable ?? "ffprobe";
    // 24 kbps Opus keeps a 10 minute chunk well below the 25 MB API maximum.
    this.maxChunkBytes = options.maxChunkBytes ?? 24 * MEBIBYTE;
    this.maxChunkSeconds = options.maxChunkSeconds ?? 10 * 60;
    this.silenceNoise = options.silenceNoise ?? "-35dB";
    this.silenceDurationSeconds = options.silenceDurationSeconds ?? 0.5;
  }

  async split(input: { videoPath: string; outputDir: string }): Promise<AudioChunk[]> {
    const duration = await this.readDuration(input.videoPath);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new AudioProcessorError("MEDIA_DURATION_INVALID", "Could not determine the recording duration.");
    }
    const silenceBoundaries = await this.detectSilenceBoundaries(input.videoPath);
    const ranges = chunkRanges(duration, silenceBoundaries, this.maxChunkSeconds);
    const chunks: AudioChunk[] = [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index]!;
      const filePath = join(input.outputDir, `audio-${String(index + 1).padStart(3, "0")}.webm`);
      await execFileAsync(this.ffmpegExecutable, [
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", input.videoPath,
        "-ss", formatSeconds(range.startSeconds),
        "-t", formatSeconds(range.endSeconds - range.startSeconds),
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-c:a", "libopus",
        "-b:a", "24k",
        filePath,
      ], { windowsHide: true, maxBuffer: 2 * MEBIBYTE });
      const size = (await stat(filePath)).size;
      if (size <= 0 || size > this.maxChunkBytes) {
        throw new AudioProcessorError(
          "AUDIO_CHUNK_TOO_LARGE",
          `Audio chunk ${index + 1} is outside the permitted size range.`,
        );
      }
      chunks.push({ filePath, ...range });
    }
    return chunks;
  }

  private async readDuration(videoPath: string): Promise<number> {
    const { stdout } = await execFileAsync(this.ffprobeExecutable, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ], { encoding: "utf8", windowsHide: true });
    return Number.parseFloat(stdout.trim());
  }

  private async detectSilenceBoundaries(videoPath: string): Promise<number[]> {
    const { stderr } = await execFileAsync(this.ffmpegExecutable, [
      "-hide_banner",
      "-i", videoPath,
      "-map", "0:a:0",
      "-af", `silencedetect=noise=${this.silenceNoise}:d=${this.silenceDurationSeconds}`,
      "-f", "null",
      "-",
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * MEBIBYTE });
    return [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)]
      .map((match) => Number.parseFloat(match[1] ?? ""))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);
  }
}

export class AudioProcessorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function chunkRanges(duration: number, silenceBoundaries: number[], maxChunkSeconds: number): Array<{
  startSeconds: number;
  endSeconds: number;
}> {
  const ranges: Array<{ startSeconds: number; endSeconds: number }> = [];
  let startSeconds = 0;
  while (startSeconds < duration - 0.01) {
    const maximumEnd = Math.min(duration, startSeconds + maxChunkSeconds);
    const preferredBoundary = silenceBoundaries
      .filter((boundary) => boundary > startSeconds + 20 && boundary <= maximumEnd)
      .at(-1);
    const endSeconds = preferredBoundary ?? maximumEnd;
    if (endSeconds <= startSeconds) throw new AudioProcessorError("AUDIO_CHUNK_INVALID", "Audio chunks must advance in time.");
    ranges.push({ startSeconds, endSeconds });
    startSeconds = endSeconds;
  }
  return ranges;
}

function formatSeconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}

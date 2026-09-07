import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import type { AppPaths } from "../paths.js";
import type { DoctorCheck, DoctorReport } from "../domain/types.js";
import { Pku3bAdapter } from "../integrations/pku3b/pku3b-adapter.js";

const execFileAsync = promisify(execFile);

export interface DoctorOptions {
  paths: AppPaths;
  pku3b?: Pku3bAdapter;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkNode(),
    checkCommand("pnpm", ["--version"], "pnpm", "Install pnpm 10 with Corepack."),
    checkPku3b(options.pku3b ?? new Pku3bAdapter()),
    checkCommand("ffmpeg", ["-version"], "FFmpeg", "Install FFmpeg to process recordings."),
    checkCommand("ffprobe", ["-version"], "FFprobe", "Install FFprobe with FFmpeg to inspect recordings."),
    checkOpenAiTranscription(),
    checkCommand("pandoc", ["--version"], "Pandoc", "Install Pandoc for PDF export."),
    checkOneOf([
      ["tectonic", ["--version"]],
      ["xelatex", ["--version"]],
    ], "LaTeX renderer", "Install Tectonic or TeX Live/XeLaTeX."),
    checkCommand(
      process.env.PKU_STUDY_MINERU_COMMAND?.trim() || "mineru",
      ["--version"],
      "MinerU cloud parser",
      "Install the zero-dependency MinerU-Skill cloud CLI or set PKU_STUDY_MINERU_COMMAND.",
    ),
    checkWritable(options.paths.dataDir, "Application data directory"),
    checkWritable(options.paths.coursesDir, "Course workspace directory"),
  ]);
  return {
    ok: checks.every((check) => check.status === "ok" || check.status === "warning"),
    checks,
  };
}

function checkOpenAiTranscription(): DoctorCheck {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-transcribe";
  if (!apiKey) {
    return {
      id: "openai-transcription",
      label: "OpenAI transcription",
      status: "warning",
      detail: "OPENAI_API_KEY is not set; recording transcription needs a configured or injected provider.",
    };
  }
  return ok("openai-transcription", "OpenAI transcription", model);
}

async function checkNode(): Promise<DoctorCheck> {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (major === 22) return ok("node", "Node.js", version);
  if (major >= 22 && major < 26) {
    return {
      id: "node",
      label: "Node.js",
      status: "warning",
      version,
      detail: `Node.js ${version} is compatible; Node.js 22 LTS is the supported release target.`,
    };
  }
  return {
    id: "node",
    label: "Node.js",
    status: "unsupported",
    version,
    detail: "Install Node.js 22 LTS.",
  };
}

async function checkPku3b(adapter: Pku3bAdapter): Promise<DoctorCheck> {
  const result = await adapter.version();
  if (!result.ok) {
    return { id: "pku3b", label: "pku3b", status: "missing", detail: result.error.message };
  }
  return {
    id: "pku3b",
    label: "pku3b",
    status: result.data.supported ? "ok" : "unsupported",
    version: result.data.version,
    detail: result.data.supported
      ? "Teaching-network adapter version is supported."
      : "Install pku3b >=0.16.0 <0.17.0.",
  };
}

async function checkCommand(
  command: string,
  args: string[],
  label: string,
  missingDetail: string,
): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const version = `${stdout}\n${stderr}`.split(/\r?\n/).find(Boolean)?.trim();
    return ok(command, label, version);
  } catch {
    return { id: command, label, status: "missing", detail: missingDetail };
  }
}

async function checkOneOf(
  commands: [string, string[]][],
  label: string,
  missingDetail: string,
): Promise<DoctorCheck> {
  for (const [command, args] of commands) {
    const result = await checkCommand(command, args, label, missingDetail);
    if (result.status === "ok") return { ...result, id: "pdf-renderer" };
  }
  return { id: "pdf-renderer", label, status: "missing", detail: missingDetail };
}

async function checkWritable(path: string, label: string): Promise<DoctorCheck> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return { id: `path:${path}`, label, status: "ok", detail: path };
  } catch {
    return {
      id: `path:${path}`,
      label,
      status: "missing",
      detail: `Directory is missing or not writable: ${path}`,
    };
  }
}

function ok(id: string, label: string, version?: string): DoctorCheck {
  return {
    id,
    label,
    status: "ok",
    ...(version ? { version } : {}),
    detail: version ?? "Available",
  };
}

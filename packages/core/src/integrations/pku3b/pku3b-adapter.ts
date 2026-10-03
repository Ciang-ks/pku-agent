import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolResult } from "../../domain/types.js";
import { isSupportedPku3bVersion, parseCourseContentList, parsePku3bVersion, stripAnsi } from "./output.js";
import { readCourseCatalog } from "./course-catalog.js";
import { downloadPku3bContent } from "./download-compat.js";
import { BlackboardReader } from "./blackboard-reader.js";
import { TeachingAccessError, type StructuredTeachingAccess, type TeachingReadOptions } from "./structured-types.js";

const execFileAsync = promisify(execFile);

export interface Pku3bAdapterOptions {
  executable?: string;
  configPath?: string;
  cacheDir?: string;
  timeoutMs?: number;
  structured?: boolean;
}

export type Pku3bReadCommand =
  | { kind: "course-table" }
  | { kind: "course-content-list"; allTerm?: boolean; courseTitle?: string; force?: boolean; otp?: string }
  | { kind: "announcement-list"; allTerm?: boolean; force?: boolean; otp?: string }
  | { kind: "announcement-show"; id: string; allTerm?: boolean; force?: boolean; otp?: string }
  | { kind: "assignment-list"; all?: boolean; allTerm?: boolean; force?: boolean; otp?: string }
  | { kind: "video-list"; allTerm?: boolean; force?: boolean; otp?: string }
  | { kind: "grades"; allTerm?: boolean; force?: boolean; otp?: string };

export type Pku3bWriteCommand =
  | {
      kind: "course-content-download";
      ccid: string;
      outdir: string;
      outputDescription?: string;
      allTerm?: boolean;
      otp?: string;
    }
  | { kind: "assignment-download"; id: string; outdir: string; allTerm?: boolean; otp?: string; remoteCourseId?: string; assignmentTitle?: string }
  | { kind: "video-download"; id: string; outdir: string; otp?: string }
  | { kind: "assignment-submit"; id: string; path: string; otp?: string };

export interface Pku3bOutput {
  stdout: string;
  stderr: string;
  version: string;
}

export class Pku3bAdapter {
  private readonly executable: string;
  private readonly timeoutMs: number;
  readonly structured?: StructuredTeachingAccess;

  constructor(private readonly options: Pku3bAdapterOptions = {}) {
    this.executable = options.executable ?? "pku3b";
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (options.cacheDir && (options.structured ?? process.env.PKU_STUDY_STRUCTURED_TEACHING !== "0")) {
      const reader = new BlackboardReader(options.cacheDir);
      this.structured = {
        listCourses: (input = {}) => this.withSession(() => reader.listCourses(), input),
        readCourse: (id, input = {}) => this.withSession(() => reader.readCourse(id), input),
        downloadResource: (content, id, directory, input = {}) => this.withSession(async () => {
          await reader.download(content, id, directory);
          return { version: "0.16.x" };
        }, input),
      };
    }
  }

  private async withSession<T>(operation: () => Promise<T>, input: TeachingReadOptions): Promise<ToolResult<T>> {
    const version = await this.version();
    if (!version.ok) return version;
    if (!version.data.supported) return failure("PKU3B_UNSUPPORTED_VERSION", `Expected pku3b 0.16.x, found ${version.data.version}`, false);
    const refresh = () => this.runRead({ kind: "course-content-list", allTerm: true, force: true, ...(input.otp ? { otp: input.otp } : {}) });
    let refreshed = false;
    if (input.force) { const result = await refresh(); if (!result.ok) return result; refreshed = true; }
    try { return { ok: true, data: await operation() }; }
    catch (error) {
      if (!refreshed && error instanceof TeachingAccessError && error.code === "TEACHING_AUTH_REQUIRED") {
        const result = await refresh();
        if (!result.ok) return result;
        try { return { ok: true, data: await operation() }; } catch (retryError) { error = retryError; }
      }
      return error instanceof TeachingAccessError
        ? failure(error.code, error.message, /NETWORK|HTTP|AUTH/.test(error.code))
        : failure("TEACHING_READ_FAILED", "教学网资源读取失败，请重新同步。", true);
    }
  }

  async version(): Promise<ToolResult<{ version: string; supported: boolean }>> {
    try {
      const { stdout, stderr } = await this.execute(["--version"], 10_000);
      const version = parsePku3bVersion(`${stdout}\n${stderr}`);
      if (!version) {
        return failure("PKU3B_VERSION_UNREADABLE", "Unable to parse pku3b version", false);
      }
      return { ok: true, data: { version, supported: isSupportedPku3bVersion(version) } };
    } catch (error) {
      return failure(
        "PKU3B_NOT_AVAILABLE",
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
  }

  async runRead(command: Pku3bReadCommand): Promise<ToolResult<Pku3bOutput>> {
    return this.run(commandArgs(command), false);
  }

  async courseCatalog(titles: string[]) {
    return this.options.cacheDir ? readCourseCatalog(this.options.cacheDir, titles) : [];
  }

  async runWrite(command: Pku3bWriteCommand): Promise<ToolResult<Pku3bOutput>> {
    const result = await this.run(commandArgs(command), true);
    if (!result.ok && (command.kind === "course-content-download" || command.kind === "assignment-download") && this.options.cacheDir &&
      result.error.code === "PKU3B_COMMAND_FAILED" && /expect redirection, but got status 200 OK/i.test(result.error.message)) {
      try {
        let ccid: string;
        if (command.kind === "course-content-download") ccid = command.ccid;
        else {
          if (!command.remoteCourseId || !command.assignmentTitle) return result;
          const listing = await this.runRead({ kind: "course-content-list", allTerm: true, ...(command.otp ? { otp: command.otp } : {}) });
          if (!listing.ok) return listing;
          const matches = parseCourseContentList(listing.data.stdout, "download").filter(({ resource }) =>
            resource.remoteCourseId === command.remoteCourseId && resource.kind === "assignment" && resource.title === command.assignmentTitle);
          if (matches.length !== 1) return result;
          ccid = matches[0]!.resource.remoteResourceId;
        }
        await downloadPku3bContent({ cacheDir: this.options.cacheDir, ccid, outdir: command.outdir,
          ...(command.kind === "course-content-download" && command.outputDescription ? { outputDescription: command.outputDescription } : {}) });
        const version = await this.version();
        if (!version.ok) return version;
        return { ok: true, data: { stdout: "Downloaded course content using pku3b 0.16 WebDAV compatibility.", stderr: "", version: version.data.version } };
      } catch {
        return failure("PKU3B_DOWNLOAD_FAILED", "教学网文件下载失败，请刷新课程后重试。", true);
      }
    }
    return result;
  }

  private async run(args: string[], sideEffect: boolean): Promise<ToolResult<Pku3bOutput>> {
    const versionResult = await this.version();
    if (!versionResult.ok) return versionResult;
    if (!versionResult.data.supported) {
      return failure(
        "PKU3B_UNSUPPORTED_VERSION",
        `Expected pku3b >=0.16.0 <0.17.0, found ${versionResult.data.version}`,
        false,
      );
    }
    if (sideEffect && args.length === 0) {
      return failure("PKU3B_COMMAND_REJECTED", "Empty side-effect command rejected", false);
    }

    try {
      const globalArgs = [
        ...(this.options.configPath ? ["--config", this.options.configPath] : []),
        ...(this.options.cacheDir ? ["--cache-dir", this.options.cacheDir] : []),
      ];
      const { stdout, stderr } = await this.execute([...globalArgs, ...args], this.timeoutMs);
      return {
        ok: true,
        data: {
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          version: versionResult.data.version,
        },
      };
    } catch (error) {
      const message = redactProcessError(error instanceof Error ? error.message : String(error));
      const needsOtp = /OTP|手机令牌|令牌验证|not a terminal|非交互/i.test(message);
      const needsConfiguration =
        /read config file|config(?:uration)?[^\n]*(?:not found|no such file)|配置文件[^\n]*(?:不存在|未找到)/i.test(
          message,
        );
      return failure(
        needsOtp
          ? "PKU3B_AUTH_OTP_REQUIRED"
          : needsConfiguration
            ? "PKU3B_CONFIG_REQUIRED"
            : "PKU3B_COMMAND_FAILED",
        message,
        needsOtp || needsConfiguration || !sideEffect,
        needsOtp ? "provide_otp" : needsConfiguration ? "configure_pku3b" : undefined,
      );
    }
  }

  private execute(args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.executable, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        CLICOLOR: "0",
        TERM: "dumb",
      },
    });
  }
}

function commandArgs(command: Pku3bReadCommand | Pku3bWriteCommand): string[] {
  const authFlags = (force?: boolean, otp?: string): string[] => [
    ...(force ? ["--force"] : []),
    ...(otp ? ["--otp-code", otp] : []),
  ];

  switch (command.kind) {
    case "course-table":
      return ["coursetable", "--raw"];
    case "course-content-list":
      return [
        "course-content",
        ...authFlags(command.force, command.otp),
        "list",
        ...(command.allTerm ? ["--all-term"] : []),
        ...(command.courseTitle ? ["--course-title", command.courseTitle] : []),
      ];
    case "announcement-list":
      return [
        "announcement",
        ...authFlags(command.force, command.otp),
        "list",
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "announcement-show":
      return [
        "announcement",
        ...authFlags(command.force, command.otp),
        "show",
        command.id,
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "assignment-list":
      return [
        "assignment",
        ...authFlags(command.force, command.otp),
        "list",
        ...(command.all ? ["--all"] : []),
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "video-list":
      return [
        "video",
        ...authFlags(command.force, command.otp),
        "list",
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "grades":
      return [
        "grades",
        ...authFlags(command.force, command.otp),
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "course-content-download":
      return [
        "course-content",
        ...authFlags(false, command.otp),
        "download",
        command.ccid,
        "--outdir",
        command.outdir,
        ...(command.outputDescription
          ? ["--output-desc", command.outputDescription]
          : []),
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "assignment-download":
      return [
        "assignment",
        ...authFlags(false, command.otp),
        "download",
        command.id,
        "--dir",
        command.outdir,
        ...(command.allTerm ? ["--all-term"] : []),
      ];
    case "video-download":
      return [
        "video",
        ...authFlags(false, command.otp),
        "download",
        command.id,
        "--outdir",
        command.outdir,
      ];
    case "assignment-submit":
      return [
        "assignment",
        ...authFlags(false, command.otp),
        "submit",
        command.id,
        command.path,
      ];
  }
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
  requiresAction?: string,
): ToolResult<never> {
  return {
    ok: false,
    error: { code, message, retryable },
    ...(requiresAction ? { requiresAction } : {}),
  };
}

function redactProcessError(message: string): string {
  return stripAnsi(message)
    .replace(/(--otp-code\s+)\S+/gi, "$1<redacted>")
    .replace(/(password[=:]\s*)\S+/gi, "$1<redacted>")
    .slice(0, 8_000);
}

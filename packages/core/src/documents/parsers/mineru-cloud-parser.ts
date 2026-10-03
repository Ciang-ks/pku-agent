import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { DocumentParserProvider, ParsedDocument } from "../../domain/types.js";
import { DocumentServiceError } from "../errors.js";
import { MineruMarkdownParser } from "./markdown-parser.js";
import { readMineruContentList } from "./mineru-content-list.js";
const execFileAsync = promisify(execFile);

export interface MineruDocumentParserOptions {
  executable?: string;
  /** MinerU cloud model used by the Standard API. */
  model?: "pipeline" | "vlm" | "MinerU-HTML";
  /** @deprecated Use model. Kept for callers compiled against the old local CLI adapter. */
  backend?: "pipeline" | "hybrid-auto" | "vlm-auto";
  api?: "auto" | "agent" | "standard";
  /** Use MinerU-Skill's optional pypdf splitting for documents over the page cap. */
  split?: boolean;
  timeoutMs?: number;
}

export class MineruDocumentParser implements DocumentParserProvider {
  private readonly executable: string;
  private readonly model: "pipeline" | "vlm" | "MinerU-HTML";
  private readonly api: "auto" | "agent" | "standard";
  private readonly timeoutMs: number;
  private readonly split: boolean;
  private readonly markdownParser = new MineruMarkdownParser();

  constructor(options: MineruDocumentParserOptions = {}) {
    this.executable = options.executable ?? process.env.PKU_STUDY_MINERU_COMMAND ?? "mineru";
    this.model = options.model ?? (options.backend === "pipeline" ? "pipeline" : "vlm");
    this.api = options.api ?? (process.env.MINERU_TOKEN?.trim() ? "standard" : "auto");
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.split = options.split ?? process.env.PKU_STUDY_MINERU_SPLIT === "1";
  }

  async parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    const outputDir = await mkdtemp(join(tmpdir(), "pku-study-mineru-"));
    try {
      // MinerU-Skill is a zero-dependency cloud wrapper. Keep the output on disk
      // so images/Markdown can be normalized and indexed without trusting stdout.
      // `--engine cloud` is explicit to prevent accidentally enabling its optional
      // local PyMuPDF path on a machine where no model weights should be present.
      await execFileAsync(this.executable, [
        input.filePath,
        "--output", outputDir,
        "--api", this.api,
        "--model", this.model,
        "--engine", "cloud",
        ...(this.split ? ["--split"] : []),
        "--workers", "1",
        "--timeout", String(Math.ceil(this.timeoutMs / 1000)),
        "--quiet",
        "--json",
      ], {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      const markdownPath = await findFirstMarkdown(outputDir);
      if (!markdownPath) throw new Error("MinerU did not produce a Markdown output.");
      const parsed = await this.markdownParser.parse({ filePath: input.filePath, content: await readFile(markdownPath, "utf8") });
      const structured = await readMineruContentList(dirname(markdownPath));
      if (structured) parsed.blocks = structured;
      const attachments: NonNullable<ParsedDocument["attachments"]> = [];
      const collect = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await collect(path);
          else if (entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name))
            attachments.push({ path: relative(dirname(markdownPath), path).split(sep).join("/"), data: await readFile(path) });
        }
      };
      await collect(dirname(markdownPath));
      return { ...parsed, attachments };
    } catch (error) {
      throw new DocumentServiceError("MINERU_FAILED", mineruFailureMessage(error), 502);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

/** Never expose signed upload URLs, tokens, or command-line paths in the UI. */
export function mineruFailureMessage(error: unknown): string {
  const failure = error as { stdout?: string; code?: string; killed?: boolean; message?: string };
  let detail = failure?.message ?? "";
  try {
    const status = JSON.parse(failure?.stdout ?? "") as { results?: { error?: string }[] };
    detail = status.results?.map(result => result.error ?? "").join(" ") || detail;
  } catch { /* A missing executable or timeout has no JSON output. */ }
  if (failure?.code === "ENOENT") return "未找到 MinerU 命令，请检查 PKU_STUDY_MINERU_COMMAND 配置。";
  if (failure?.killed || /timeout|timed.out/i.test(detail)) return "MinerU 云端解析超时，请稍后重试。";
  if (/needs the pypdf|no module named .?pypdf/i.test(detail)) return "MinerU 分卷需要 pypdf，请为 MinerU 使用的 Python 安装该依赖。";
  if (/too (?:large|many pages)|(?:exceeds?|exceeded).*(?:limit|pages)|page.limit|20-page|10 MB/i.test(detail)) return "资料超过 MinerU 接口的大小或页数限制；可安装 pypdf 并设置 PKU_STUDY_MINERU_SPLIT=1 分卷解析，或配置 Standard API token。";
  if (/network|connect|urlopen|unreachable/i.test(detail)) return "无法连接 MinerU 云端服务，请检查网络与代理配置。";
  if (/token|401|403|unauthori[sz]ed/i.test(detail)) return "MinerU 认证失败或此文件需要 Standard API token，请检查解析配置。";
  if (/429|rate.limit|quota/i.test(detail)) return "MinerU 请求受到限流或额度不足，请稍后重试。";
  return "MinerU 云端解析失败，请检查文件格式和解析服务配置后重试。";
}

async function findFirstMarkdown(root: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstMarkdown(path);
      if (nested) return nested;
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      return path;
    }
  }
  return undefined;
}

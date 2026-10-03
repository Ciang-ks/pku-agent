import { execFile } from "node:child_process";
import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import type { PdfRenderer } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export interface PandocPdfRendererOptions {
  pandocExecutable?: string;
  pdfEngine?: string;
  timeoutMs?: number;
  cjkFont?: string;
}

export class PandocPdfRenderer implements PdfRenderer {
  readonly id = "pandoc-pdf";
  private readonly pandocExecutable: string;
  private readonly pdfEngine: string | undefined;
  private readonly timeoutMs: number;
  private readonly cjkFont: string | undefined;

  constructor(options: PandocPdfRendererOptions = {}) {
    this.pandocExecutable = options.pandocExecutable ?? "pandoc";
    this.pdfEngine = options.pdfEngine ?? (process.env.PKU_STUDY_PDF_ENGINE?.trim() || "xelatex");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.cjkFont = options.cjkFont ?? process.env.PKU_STUDY_PDF_CJK_FONT?.trim();
  }

  async render(input: { markdownPath: string; outputPath: string }): Promise<void> {
    await assertRegularFile(input.markdownPath, "PDF source Markdown");
    const args = [input.markdownPath, "-o", input.outputPath, "--standalone"];
    if (this.pdfEngine) args.push(`--pdf-engine=${this.pdfEngine}`);
    try {
      if (/[\u3400-\u9fff\uf900-\ufaff]/.test(await readFile(input.markdownPath, "utf8"))) {
        const font = this.cjkFont || await detectCjkFont();
        if (!font) throw new PdfRendererError("PDF_FONT_MISSING", "中文 PDF 需要中文字体，请设置 PKU_STUDY_PDF_CJK_FONT。");
        args.push("--variable", `CJKmainfont=${font}`);
      }
      const { stderr } = await execFileAsync(this.pandocExecutable, args, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      if (/Missing character:|Missing character /i.test(stderr)) throw new PdfRendererError("PDF_FONT_MISSING", "PDF 字体缺少正文字符，请检查 PKU_STUDY_PDF_CJK_FONT；未保存不完整的导出。");
      await assertRegularFile(input.outputPath, "PDF output");
    } catch (error) {
      if (error instanceof PdfRendererError) throw error;
      if (error && typeof error === "object" && "killed" in error && error.killed) {
        throw new PdfRendererError("PDF_RENDER_TIMEOUT", "PDF 导出超时；Tectonic 首次使用需要下载 TeX bundle，请完成初始化后重试。");
      }
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error);
      throw new PdfRendererError("PDF_RENDER_FAILED", `Pandoc PDF export failed: ${detail}`);
    }
  }
}

async function detectCjkFont(): Promise<string | undefined> {
  if (process.platform === "win32") return "Microsoft YaHei";
  if (process.platform === "darwin") return "PingFang SC";
  try {
    const { stdout } = await execFileAsync("fc-list", [":lang=zh", "family"], { encoding: "utf8", timeout: 5_000 });
    const families = stdout.split(/\r?\n/).flatMap(line => line.split(",")).map(s => s.trim()).filter(Boolean);
    return ["Noto Serif CJK SC", "Noto Sans CJK SC", "WenQuanYi Zen Hei"].find(font => families.includes(font)) ?? families[0];
  } catch { return undefined; }
}

export class PdfRendererError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) throw new Error();
  } catch {
    throw new PdfRendererError("PDF_SOURCE_INVALID", `${label} must be a non-empty regular file.`);
  }
}

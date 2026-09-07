import { execFile } from "node:child_process";
import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import type { PdfRenderer } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export interface PandocPdfRendererOptions {
  pandocExecutable?: string;
  pdfEngine?: string;
  timeoutMs?: number;
}

export class PandocPdfRenderer implements PdfRenderer {
  readonly id = "pandoc-pdf";
  private readonly pandocExecutable: string;
  private readonly pdfEngine: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: PandocPdfRendererOptions = {}) {
    this.pandocExecutable = options.pandocExecutable ?? "pandoc";
    this.pdfEngine = options.pdfEngine ?? process.env.PKU_STUDY_PDF_ENGINE?.trim() ?? "xelatex";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async render(input: { markdownPath: string; outputPath: string }): Promise<void> {
    await assertRegularFile(input.markdownPath, "PDF source Markdown");
    const args = [input.markdownPath, "-o", input.outputPath, "--standalone"];
    if (this.pdfEngine) args.push(`--pdf-engine=${this.pdfEngine}`);
    try {
      await execFileAsync(this.pandocExecutable, args, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      await assertRegularFile(input.outputPath, "PDF output");
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error);
      throw new PdfRendererError("PDF_RENDER_FAILED", `Pandoc PDF export failed: ${detail}`);
    }
  }
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

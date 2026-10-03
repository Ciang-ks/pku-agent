import type { ParsedDocument } from "../domain/types.js";

export function normalizedMarkdown(parsed: ParsedDocument): string {
  const lines: string[] = [];
  let previousPage: number | undefined;
  for (const block of parsed.blocks) {
    if (block.page !== undefined && block.page !== previousPage) {
      lines.push(`<!-- page: ${block.page} -->`, "");
      previousPage = block.page;
    }
    lines.push(block.contentType === "heading" ? `# ${block.text}` : block.text, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}


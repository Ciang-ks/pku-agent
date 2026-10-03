import { basename } from "node:path";
import type { DocumentParserProvider, ParsedDocument, ParsedDocumentBlock } from "../../domain/types.js";

export class TextDocumentParser implements DocumentParserProvider {
  async parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    const lines = input.content.replace(/\r\n?/g, "\n").split("\n");
    const blocks: ParsedDocumentBlock[] = [];
    let heading = basename(input.filePath).replace(/\.[^.]+$/, "");
    let paragraph: string[] = [];
    const flush = (): void => {
      const text = paragraph.join("\n").trim();
      if (text) blocks.push({ contentType: "paragraph", text, heading });
      paragraph = [];
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const markdownHeading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (markdownHeading?.[2]) {
        flush();
        heading = markdownHeading[2].trim();
        blocks.push({ contentType: "heading", text: heading, heading });
        continue;
      }
      if (!line) {
        flush();
        continue;
      }
      paragraph.push(line);
    }
    flush();
    return { title: basename(input.filePath), blocks };
  }
}

export class MineruMarkdownParser implements DocumentParserProvider {
  async parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    const lines = input.content.replace(/\r\n?/g, "\n").split("\n");
    const blocks: ParsedDocumentBlock[] = [];
    let heading = basename(input.filePath).replace(/\.[^.]+$/, "");
    let page: number | undefined;
    let paragraph: string[] = [];
    const flush = (): void => {
      const text = paragraph.join("\n").trim();
      if (text) blocks.push({ contentType: "paragraph", text, heading, ...(page === undefined ? {} : { page }) });
      paragraph = [];
    };
    for (const rawLine of lines) {
      const line = rawLine.trim();
      const marker = /^(?:<!--\s*(?:page(?:\s+number)?|page_number)\s*[:=]\s*(\d+)\s*-->|\[page\s+(\d+)\])$/i.exec(line);
      if (marker) {
        flush();
        page = Number(marker[1] ?? marker[2]);
        continue;
      }
      const markdownHeading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (markdownHeading?.[2]) {
        flush();
        heading = markdownHeading[2].trim();
        blocks.push({ contentType: "heading", text: heading, heading, ...(page === undefined ? {} : { page }) });
        continue;
      }
      if (!line) {
        flush();
        continue;
      }
      paragraph.push(line);
    }
    flush();
    return { title: basename(input.filePath), blocks };
  }
}


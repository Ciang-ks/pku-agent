import type { DocumentParserProvider, ParsedDocument } from "../../domain/types.js";
import { MineruMarkdownParser } from "./markdown-parser.js";
import { MineruDocumentParser } from "./mineru-cloud-parser.js";
export * from "./markdown-parser.js";
export * from "./mineru-cloud-parser.js";

export class CompositeDocumentParser implements DocumentParserProvider {
  private readonly text = new MineruMarkdownParser();
  private readonly mineru: MineruDocumentParser;

  constructor(mineru?: MineruDocumentParser) {
    this.mineru = mineru ?? new MineruDocumentParser();
  }

  parse(input: { filePath: string; content: string }): Promise<ParsedDocument> {
    return !/\.(md|markdown|txt)$/i.test(input.filePath) ? this.mineru.parse(input) : this.text.parse(input);
  }
}


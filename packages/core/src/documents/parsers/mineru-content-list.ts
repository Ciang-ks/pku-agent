import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedDocumentBlock } from '../../domain/types.js';

/** Standard API's content list retains original page numbers and image paths. */
export async function readMineruContentList(directory: string): Promise<ParsedDocumentBlock[] | undefined> {
  const entry = (await readdir(directory)).find(name => /(?:^|_)content_list\.json$/.test(name));
  if (!entry) return undefined;
  const content: unknown = JSON.parse(await readFile(join(directory, entry), 'utf8'));
  if (!Array.isArray(content)) return undefined;
  const blocks: ParsedDocumentBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.page_idx) || item.page_idx < 0) return undefined;
    if (item.type === 'page_number') continue;
    const texts: string[] = [];
    if (typeof item.text === 'string') texts.push(item.text);
    const captions = [item.image_caption,item.chart_caption,item.table_caption];
    for (const caption of captions) if (Array.isArray(caption)) texts.push(...caption.filter((s: unknown) => typeof s === 'string'));
    if (typeof item.img_path === 'string') {
      const path = item.img_path;
      if (path.startsWith('images/') && !path.split('/').includes('..') && !/[\\\x00-\x1f]/.test(path)) {
        texts.push(`![原资料第 ${item.page_idx + 1} 页图表](${encodeURI(path)})`);
      }
    }
    if (typeof item.table_body === 'string') {
      const rows = [...item.table_body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
        [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cell[1].replace(/<[^>]+>/g,' ').replace(/\|/g,'\\|').trim()));
      if (rows.length) {
        const width = Math.max(...rows.map(row => row.length));
        const line = (row: string[]) => `| ${Array.from({length:width},(_,i)=>row[i]??'').join(' | ')} |`;
        texts.push([line(rows[0]!),line(Array(width).fill('---')),...rows.slice(1).map(line)].join('\n'));
      }
    }
    for (const footnotes of [item.image_footnote,item.chart_footnote,item.table_footnote])
      if (Array.isArray(footnotes)) texts.push(...footnotes.filter((s: unknown) => typeof s === 'string'));
    const text = texts.filter(Boolean).join('\n\n').trim();
    if (text) blocks.push({contentType: item.text_level ? 'heading' : 'paragraph', text, page: item.page_idx + 1});
  }
  return blocks.length ? blocks : undefined;
}

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(() => {}, { [promisify.custom]: run }) };
});
const { PandocPdfRenderer } = await import('../src/documents/pdf-renderer.js');

it('selects a configured CJK font and preserves Chinese text in the export input', async () => {
 const root=await mkdtemp(join(tmpdir(),'pdf-font-'));
 try {
  const markdownPath=join(root,'draft.md'),outputPath=join(root,'answer.pdf');await writeFile(markdownPath,'# 中文作业\n公式 $x^2$');
  run.mockImplementation(async (_:string,args:string[])=>{await writeFile(args[args.indexOf('-o')+1]!, '%PDF-test');return {stdout:'',stderr:''};});
  await new PandocPdfRenderer({pdfEngine:'tectonic',cjkFont:'WenQuanYi Zen Hei'}).render({markdownPath,outputPath});
  expect(run.mock.calls.at(-1)![1]).toContain('CJKmainfont=WenQuanYi Zen Hei');
  run.mockResolvedValue({stdout:'',stderr:'Missing character: There is no 中 in font Latin Modern!'});
  await expect(new PandocPdfRenderer({pdfEngine:'tectonic',cjkFont:'WenQuanYi Zen Hei'}).render({markdownPath,outputPath})).rejects.toMatchObject({code:'PDF_FONT_MISSING'});
  run.mockRejectedValue(Object.assign(new Error('terminated'),{killed:true}));
  await expect(new PandocPdfRenderer({pdfEngine:'tectonic',cjkFont:'WenQuanYi Zen Hei'}).render({markdownPath,outputPath})).rejects.toMatchObject({code:'PDF_RENDER_TIMEOUT'});
 }finally{run.mockReset();await rm(root,{recursive:true,force:true});}
});

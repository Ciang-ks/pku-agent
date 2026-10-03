import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { downloadPku3bContent } from '../src/integrations/pku3b/download-compat.js';

async function fixture(kind='File', attachments: string[][]=[]) {
  const root=await mkdtemp(join(tmpdir(),'pku-download-'));
  const outdir=join(root,'stage');await mkdir(outdir);
  await writeFile(join(root,'ua.json'),JSON.stringify([
    {raw_cookie:'session=private; HttpOnly',domain:{HostOnly:'course.pku.edu.cn'},path:['/',true],expires:'SessionEnd'},
    {raw_cookie:'other=never-send',domain:{HostOnly:'iaaa.pku.edu.cn'},path:['/',true],expires:'SessionEnd'},
  ]));
  await writeFile(join(root,'with_cache-a'),JSON.stringify([{id:'_2_1',kind,descriptions:['course description'],attachments}]));
  return {root,input:{cacheDir:root,ccid:'_1_1:_2_1',outdir,outputDescription:'description.txt'}};
}
it('downloads file links when WebDAV returns either a redirect or the final PDF',async()=>{
  const {root,input}=await fixture();
  try {
    const request=vi.fn().mockResolvedValueOnce(new Response("<script>document.location = '/bbcswebdav/file';</script>",{headers:{'content-type':'text/html'}}))
      .mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'/files/lecture.pdf'}}))
      .mockResolvedValueOnce(new Response('%PDF-test',{headers:{'content-type':'application/pdf'}}));
    await downloadPku3bContent({...input,fetch:request});
    expect(await readFile(join(input.outdir,'lecture.pdf'),'utf8')).toBe('%PDF-test');
    expect(await readFile(join(input.outdir,'description.txt'),'utf8')).toBe('course description');
    expect(request.mock.calls.every(call=>call[1].headers.cookie==='session=private')).toBe(true);
  }finally{await rm(root,{recursive:true,force:true});}
});
it('accepts a direct 200 attachment but rejects login HTML, foreign redirects and unsafe filenames',async()=>{
  const {root,input}=await fixture('Document',[['lecture.pdf','/bbcswebdav/file']]);
  try {
    await downloadPku3bContent({...input,fetch:vi.fn().mockResolvedValue(new Response('%PDF-direct',{headers:{'content-type':'application/pdf'}}))});
    expect(await readFile(join(input.outdir,'lecture.pdf'),'utf8')).toBe('%PDF-direct');
    await expect(downloadPku3bContent({...input,fetch:vi.fn().mockResolvedValue(new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}))})).rejects.toThrow('HTML');
    const redirect=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://other.example/collect'}}));
    await expect(downloadPku3bContent({...input,fetch:redirect})).rejects.toThrow('origin');expect(redirect).toHaveBeenCalledTimes(1);
    await writeFile(join(root,'with_cache-a'),JSON.stringify([{id:'_2_1',kind:'Document',descriptions:[],attachments:[['../escape.pdf','/file']]}]));
    await expect(downloadPku3bContent({...input,fetch:vi.fn().mockResolvedValue(new Response('%PDF-test'))})).rejects.toThrow('filename');
  }finally{await rm(root,{recursive:true,force:true});}
});
it('rejects oversized downloads before consuming the body',async()=>{
 const {root,input}=await fixture('Document',[['large.pdf','/file']]);
 try {await expect(downloadPku3bContent({...input,fetch:vi.fn().mockResolvedValue(new Response('large',{headers:{'content-length':String(101*1024*1024)}}))})).rejects.toThrow('size limit');}
 finally{await rm(root,{recursive:true,force:true});}
});

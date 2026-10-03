import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readMineruContentList } from '../src/documents/parsers/mineru-content-list.js';
it('retains original pages, diagrams, formulas and tabular data from Standard output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mineru-content-'));
 try {
  await writeFile(join(root,'result_content_list.json'),JSON.stringify([
   {type:'text',text:'GDP',text_level:1,page_idx:0},
   {type:'image',img_path:'images/plot.jpg',image_caption:['GDP chart'],page_idx:2},
   {type:'equation',text:'$$x^2$$',page_idx:3},
   {type:'table',table_body:'<table><tr><td>Year</td><td>GDP</td></tr><tr><td>2020</td><td>100</td></tr></table>',page_idx:4},
   {type:'page_number',text:'5',page_idx:4},
  ]));
  const blocks=await readMineruContentList(root);expect(blocks?.map(b=>b.page)).toEqual([1,3,4,5]);
  expect(blocks?.[1]?.text).toContain('](images/plot.jpg)');expect(blocks?.[2]?.text).toBe('$$x^2$$');expect(blocks?.[3]?.text).toContain('| 2020 | 100 |');
 }finally{await rm(root,{recursive:true,force:true});}
});

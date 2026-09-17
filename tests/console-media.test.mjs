import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byteRange, createMediaService } from '../scripts/console-media.mjs';

test('视频 Range 支持拖动、尾部探测、越界截断，并拒绝无效范围',()=>{
  assert.deepEqual(byteRange('bytes=0-1',100),{start:0,end:1});
  assert.deepEqual(byteRange('bytes=80-',100),{start:80,end:99});
  assert.deepEqual(byteRange('bytes=-20',100),{start:80,end:99});
  assert.deepEqual(byteRange('bytes=90-200',100),{start:90,end:99});
  assert.equal(byteRange(undefined,100),null);
  for(const range of ['bytes=100-','bytes=5-1','bytes=-0','bytes=-','bytes=1-2,4-5','bytes=9007199254740992-'])assert.throws(()=>byteRange(range,100),e=>e.status===416);
  assert.throws(()=>byteRange('bytes=0-',0),e=>e.status===416);
});

test('封面请求合并，兼容副本单任务运行，缓存随原文件改变失效且不替换原片',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-media-'))),source=join(home,'video.mp4');
  writeFileSync(source,'original');let removed=false,calls=0,release;
  const pending=new Promise(r=>{release=r;});
  const store={fileFor:id=>{assert.match(String(id),/^\d+$/);if(removed)throw new Error('视频已清理');return source;},policy:()=>({free:0})};
  const media=createMediaService({store,home,run:async(_cmd,args)=>{calls++;if(args.includes('libx264'))await pending;writeFileSync(args.at(-1),'generated');}});
  try{
    const [p1,p2]=await Promise.all([media.poster('1'),media.poster('1')]);assert.equal(p1,p2);assert.equal(calls,1);
    assert.equal(media.prepare('1').state,'processing');assert.equal(media.prepare('1').state,'processing');
    assert.throws(()=>media.prepare('2'),e=>e.status===409);release();
    for(let n=0;n<50&&media.status('1').state==='processing';n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(media.status('1').state,'ready');assert.equal(calls,2);assert.notEqual(media.video('1',true),source);
    assert.equal(readFileSync(source,'utf8'),'original');assert.equal(existsSync(media.video('1',true)),true);
    writeFileSync(source,'original changed');assert.equal(media.status('1').state,'idle');
    assert.throws(()=>media.video('1',true),e=>e.status===404);
    removed=true;assert.throws(()=>media.status('1'),/已清理/);assert.throws(()=>media.video('1'),/已清理/);
  }finally{release();rmSync(home,{recursive:true,force:true});}
});

test('转码失败会返回明确状态并删除未完成文件，保留原片',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-media-'))),source=join(home,'video.mp4');writeFileSync(source,'original');let part;
  const media=createMediaService({home,store:{fileFor:()=>source,policy:()=>({free:0})},run:async(_cmd,args)=>{part=args.at(-1);writeFileSync(part,'incomplete');throw new Error('codec failure');}});
  try{
    media.prepare('1');for(let n=0;n<50&&media.status('1').state==='processing';n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(media.status('1').state,'failed');assert.equal(existsSync(part),false);assert.equal(readFileSync(source,'utf8'),'original');
  }finally{rmSync(home,{recursive:true,force:true});}
});

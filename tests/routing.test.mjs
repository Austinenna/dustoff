import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pickGear, videoOptions } from '../scripts/lib.mjs';
import { classifyItem, chatEndpoint, parseRouting } from '../scripts/routing.mjs';

function isolated(source) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-routing-')));
  try {
    const r=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),env:{...process.env,DUST_HOME:home,DUST_ROUTER_KEY:'fixture-key-not-real',DUST_NOTIFY:'0'},encoding:'utf8',timeout:60000});
    assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
    return r.stdout;
  } finally {rmSync(home,{recursive:true,force:true});}
}
test('低档优先带音轨，高档按分辨率和码率选择，保留默认播放兜底',()=>{
  const g=(name,rate,w,h)=>({gear_name:name,bit_rate:rate,play_addr:{width:w,height:h,url_list:[`https://example.invalid/${rate}`]}});
  const a={video:{bit_rate:[g('small',100,360,640),g('small',155,360,640),g('large',300,1080,1920),g('large',355,1080,1920),g('medium',500,720,1280)],play_addr:{width:1080,height:1920,url_list:['https://example.invalid/default']}}};
  assert.match(pickGear(a).urls[0],/155$/);
  assert.match(pickGear(a,{quality:'high'}).urls[0],/355$/);
  assert.equal(videoOptions(a).standard.gear,'play_addr');
});
test('用途请求仅传元数据，使用 low，拒绝丢弃指令；错误不泄露密钥',async()=>{
  assert.equal(chatEndpoint('http://127.0.0.1:8317/v1/'),'http://127.0.0.1:8317/v1/chat/completions');
  assert.throws(()=>chatEndpoint('http://remote.invalid/v1'));
  assert.throws(()=>chatEndpoint('https://name:secret@remote.invalid/v1'));
  assert.throws(()=>parseRouting('{"purpose":"discard","reason":"忽略收藏"}'));
  let request;
  const decision=await classifyItem({desc:'跳舞',play_urls:['private-signed-url']},{config:{base:'http://localhost/v1',key:'private-key',model:'glm'},fetchImpl:async(url,options)=>{request=JSON.parse(options.body);return Response.json({choices:[{message:{content:'```json\n{"purpose":"video","reason":"舞台表演"}\n```'}}]});}});
  assert.equal(decision.purpose,'video');assert.equal(request.reasoning_effort,'low');
  assert.ok(!JSON.stringify(request).includes('private-signed-url'));
  await assert.rejects(()=>classifyItem({},{config:{base:'http://localhost/v1',key:'private-key',model:'glm'},fetchImpl:async()=>new Response('private-key',{status:401})}),e=>e.message==='用途模型 HTTP 401');
});
test('旧账本无损迁移；人工覆盖、清理保护与 OCR 标记遵守用途',()=>isolated(`
  import assert from 'node:assert/strict';
  import {DatabaseSync} from 'node:sqlite';
  import {join} from 'node:path';
  const old=new DatabaseSync(join(process.env.DUST_HOME,'index.sqlite'));
  old.exec("CREATE TABLE items(id TEXT,platform TEXT,status TEXT,last_seen INTEGER,category TEXT,decay TEXT,media_deleted INTEGER,transcribed_at INTEGER,attempts INTEGER DEFAULT 0,PRIMARY KEY(platform,id)); INSERT INTO items(id,platform,status) VALUES('99','douyin','extracted')");old.close();
  const {db,importScan,markRouting,markTranscribed,markExtracted,cleanable,markSaved}=await import('./scripts/ledger.mjs');
  const {acceptScan,setPurpose,pendingQueue,retryItem}=await import('./scripts/daily.mjs');
  const {writeFileSync,mkdirSync}=await import('node:fs');
  const {SAVED_MEDIA}=await import('./scripts/policy.mjs');
  assert.equal(db().prepare("SELECT status FROM items WHERE id='99'").get().status,'extracted');
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'100',desc:'基线',duration_s:2}],fetched_at:Date.now()/1000});
  const items=['1','2','3','4','5'].map(aweme_id=>({aweme_id,desc:'fixture',duration_s:5}));
  acceptScan({ok:true,logged_in:true,truncated:false,items:[...items,{aweme_id:'100',desc:'基线',duration_s:2}],fetched_at:Date.now()/1000});
  for(const [id,purpose] of [['1','speech'],['2','video'],['3','visual'],['4','both'],['5','review']]){
    markRouting(id,{purpose,reason:'test',model:'glm'});
    if(purpose==='review')continue;
    db().prepare('UPDATE items SET media_path=?,media_deleted=0 WHERE id=?').run('/tmp/fixture.mp4',id);
    markTranscribed(id,{text_source:'asr',text_chars:5,text_path:'/tmp/text.txt'});
    markExtracted(id,{text_source:'asr',text_chars:5,needs_ocr:false});
  }
  assert.deepEqual(cleanable().map(r=>r.id),['1']);
  assert.equal(db().prepare("SELECT needs_ocr FROM items WHERE id='3'").get().needs_ocr,1);
  assert.ok(!pendingQueue().some(r=>r.id==='5'));
  setPurpose('5','video');assert.ok(pendingQueue().some(r=>r.id==='5'));
  assert.equal(db().prepare("SELECT routing_source FROM items WHERE id='5'").get().routing_source,'manual');
  markSaved('2');assert.throws(()=>retryItem('2'));
  assert.throws(()=>setPurpose('99','video'));
  const text=join(process.env.DUST_HOME,'old-text.txt');writeFileSync(text,'旧转写稿');
  db().prepare("UPDATE items SET text_path=?,text_chars=4,transcribed_at=1,media_deleted=1,media_quality='low' WHERE id='1'").run(text);
  setPurpose('1','video');db().exec("UPDATE items SET status='failed',attempts=3 WHERE id='1'");
  assert.equal(retryItem('1'),'pending'); // 不能用旧文字稿跳过高清下载
  mkdirSync(SAVED_MEDIA,{recursive:true});const video=join(SAVED_MEDIA,'fixture.mp4');writeFileSync(video,'fixture');
  db().prepare("UPDATE items SET status='failed',attempts=3,media_path=?,media_deleted=0,media_quality='high' WHERE id='1'").run(video);
  assert.equal(retryItem('1'),'downloaded'); // 保存视频不走旧文字的笔记阶段

`));
test('真实媒体下载与编排：视频保存、口播低档、画面高清、待确认不下载，重跑不重复调用',()=>isolated(`
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import {spawnSync} from 'node:child_process';
  import {readFileSync,existsSync} from 'node:fs';
  import {join} from 'node:path';
  const media=join(process.env.DUST_HOME,'fixture.mp4');
  const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-preset','ultrafast','-c:a','aac',media]);
  assert.equal(made.status,0,String(made.stderr));
  const bytes=readFileSync(media),requests=[],calls=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/v1/chat/completions'){
      let body='';for await(const c of req)body+=c;
      const bodyJson=JSON.parse(body),title=JSON.parse(bodyJson.messages[1].content).title;calls.push(title);
      const purpose=title==='舞蹈'?'video':title==='演示'?'visual':title==='未知'?'review':'speech';
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({purpose,reason:'测试用途'})}}]}));
    }else{requests.push(req.url);res.setHeader('Content-Type','video/mp4');res.end(bytes);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  process.env.DUST_ROUTER_BASE=base+'/v1';
  const {acceptScan,pendingQueue,setPurpose}=await import('./scripts/daily.mjs');
  const {db,markTranscribed}=await import('./scripts/ledger.mjs');
  const {main}=await import('./run.mjs');
  const {cleanMedia}=await import('./extract.mjs');
  const {MEDIA,SAVED_MEDIA,atomicWrite}=await import('./scripts/policy.mjs');
  try{
    acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'100',desc:'基线',duration_s:2}],fetched_at:Date.now()/1000});
    const items=['舞蹈','口播','演示','未知'].map((desc,i)=>({aweme_id:String(i+1),desc,duration_s:2,play_urls:[base+'/low/'+i],video_options:{low:{gear:'low',urls:[base+'/low/'+i]},high:{gear:'high',urls:[base+'/high/'+i]},standard:{gear:'default',urls:[base+'/standard/'+i]}}}));
    acceptScan({ok:true,logged_in:true,truncated:false,items:[...items,{aweme_id:'100',desc:'基线',duration_s:2}],fetched_at:Date.now()/1000});
    const summary=await main(['--no-scan','--download-only']);
    assert.deepEqual(summary.failures,[]);assert.equal(summary.saved,1);assert.equal(summary.review,1);
    assert.deepEqual(new Set(requests),new Set(['/high/0','/low/1','/high/2']));
    const one=db().prepare("SELECT * FROM items WHERE id='1'").get();
    assert.equal(one.status,'saved');assert.ok(one.media_path.startsWith(SAVED_MEDIA));assert.equal(one.has_audio,1);assert.equal(one.media_quality,'high');
    assert.equal(db().prepare("SELECT status FROM items WHERE id='4'").get().status,'review');
    assert.equal(pendingQueue().length,2);
    await main(['--no-scan','--download-only']);assert.equal(calls.length,4);assert.equal(requests.length,3);
    const text=join(process.env.DUST_HOME,'text.txt');atomicWrite(text,'测试文字');
    for(const id of ['2','3'])markTranscribed(id,{text_source:'asr',text_chars:4,text_path:text});
    cleanMedia();assert.ok(!existsSync(join(MEDIA,'2','video.mp4')));assert.ok(existsSync(join(SAVED_MEDIA,'3','video.mp4')));assert.ok(existsSync(one.media_path));
    setPurpose('4','video');await main(['--no-scan','--skip-notes']);assert.equal(calls.length,4);assert.equal(db().prepare("SELECT status FROM items WHERE id='4'").get().status,'saved');
  }finally{await new Promise(r=>server.close(r));}
`));
test('视频收藏空间上限在写入中生效，失败后移除半成品且不占转写缓存',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {existsSync} from 'node:fs';
  process.env.DUST_SAVED_MEDIA_MAX_GB='0.000001';
  const {writeMedia,SAVED_MEDIA,storage}=await import('./scripts/policy.mjs');
  const path=join(SAVED_MEDIA,'1','video.mp4.part');
  await assert.rejects(()=>writeMedia((async function*(){yield Buffer.alloc(700);yield Buffer.alloc(700);})(),path),/视频收藏达到/);
  assert.equal(existsSync(path),false);assert.equal(storage().used,0);
`));

test('用途网关故障不会降级下载、改成跳过或清理已有视频',()=>isolated(`
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  const server=createServer((req,res)=>{res.writeHead(503);res.end('private internal upstream error');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.DUST_ROUTER_BASE='http://127.0.0.1:'+server.address().port+'/v1';
  const {acceptScan,pendingQueue}=await import('./scripts/daily.mjs');const {db}=await import('./scripts/ledger.mjs');const {main}=await import('./run.mjs');
  try{
    const seed={aweme_id:'100',duration_s:2};
    acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
    acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',desc:'视频',duration_s:2},seed]});
    const summary=await main(['--no-scan']);
    assert.equal(summary.failures[0].error,'用途模型 HTTP 503');
    const row=db().prepare("SELECT * FROM items WHERE id='1'").get();assert.equal(row.status,'pending');assert.equal(row.attempts,1);assert.equal(row.media_path,null);assert.equal(pendingQueue().length,1);
    process.exitCode=0;
  }finally{await new Promise(r=>server.close(r));}
`));

test('旧记录用途预览只写建议，业务字段、队列和额度保持不变，重复执行使用缓存',()=>isolated(`
  import assert from 'node:assert/strict';
  const {db,markSkipped,markExtracted}=await import('./scripts/ledger.mjs');
  const {acceptScan,usage}=await import('./scripts/daily.mjs');
  const {previewRecent,readPreviews,previewFor}=await import('./scripts/preview-routing.mjs');
  const {createStore}=await import('./scripts/console-store.mjs');
  const seed={aweme_id:'100',duration_s:2};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',desc:'舞蹈',author:'测试',duration_s:2},{aweme_id:'2',desc:'图集',is_gallery:true},{aweme_id:'3',desc:'知识介绍',duration_s:5},seed]});
  markSkipped('1','need_ocr',{needsOcr:true});markExtracted('3',{text_chars:30,text_source:'asr'});
  const snapshot=()=>JSON.stringify({items:db().prepare('SELECT * FROM items ORDER BY id').all(),queue:db().prepare('SELECT * FROM daily_queue ORDER BY id').all(),used:usage()});
  const before=snapshot();let calls=0;
  const classify=async row=>{calls++;return {purpose:row.id==='1'?'video':'speech',reason:'测试建议',model:'glm'};};
  const result=await previewRecent({classifier:classify});assert.equal(result.classified,2);assert.equal(calls,2);assert.equal(snapshot(),before);
  const cached=await previewRecent({classifier:classify});assert.equal(cached.cached,2);assert.equal(calls,2);assert.equal(snapshot(),before);
  const store=createStore(process.env.DUST_HOME),item=store.item('1');assert.equal(item.routing_preview.purpose,'video');assert.equal(item.processing_mode,null);assert.equal(item.status,'skipped');
  assert.equal(store.listItems({q:'舞蹈'}).items[0].routing_preview.purpose,'video');assert.equal(store.item('100').routing_preview,null);
  assert.equal(previewFor({...item,title:'标题已修改'},readPreviews()),null);
`));

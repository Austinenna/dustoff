import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createConsole } from '../console.mjs';
import { createStore } from '../scripts/console-store.mjs';
import { renderMarkdown } from '../web/markdown.mjs';
import { deleteLocalVideo } from '../scripts/delete-video.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-console-')));
  const init=spawnSync(process.execPath,['--input-type=module','-e',`import {db} from ${JSON.stringify(new URL('../scripts/ledger.mjs',import.meta.url).href)};db().close();`],{env:{...process.env,DUST_HOME:home},encoding:'utf8'});
  assert.equal(init.status,0,init.stderr);
  mkdirSync(join(home,'text'));mkdirSync(join(home,'notes'));
  writeFileSync(join(home,'text','1.txt'),'测试原稿。');writeFileSync(join(home,'notes','1.md'),'---\n标题: "整理后的标题"\n---\n# 测试笔记\n\n**核心观点**\n\n测试原稿。');
  const db=new DatabaseSync(join(home,'index.sqlite'));
  db.exec("CREATE TABLE daily_state(name TEXT PRIMARY KEY,value TEXT); CREATE TABLE daily_queue(id TEXT PRIMARY KEY,metadata TEXT,enqueued INTEGER); CREATE TABLE daily_usage(day TEXT,id TEXT,PRIMARY KEY(day,id));");
  db.prepare('INSERT INTO daily_state VALUES(?,?)').run('baseline',JSON.stringify({created_at:Date.now(),anchors:['1']}));
  for(let n=1;n<=18;n++)db.prepare("INSERT INTO items(id,platform,title,author,status,first_seen,last_seen,updated_at,note_path,text_path,extracted_at,transcribed_at,text_chars,attempts) VALUES(?,'douyin',?,'测试作者',?,1,1,?, ?,?,?,?,?,?)").run(String(n),n===2?'100% 字面搜索':'测试作品 '+n,n===18?'failed':'extracted',n,n===18?null:join(home,'notes','1.md'),join(home,'text','1.txt'),n===18?null:n,1,'测试原稿。'.length,n===18?3:0);
  db.prepare('INSERT INTO daily_queue VALUES(?,?,?)').run('18',JSON.stringify({aweme_id:'18'}),Date.now());db.close();
  writeFileSync(join(home,'dustoff.conf'),`# 保留这条注释\nDUST_DAILY_LIMIT=50\nDUST_MIN_FREE_GB=10\nDUST_NOTES=${join(home,'notes')}\nDUST_TEXT=${join(home,'text')}\nDUST_DASHSCOPE_KEY=fixture-only-secret-not-real\n`);
  return {home,cleanup:()=>rmSync(home,{recursive:true,force:true})};
}
const fakeScheduler=()=>{let current={loaded:false,running:false,time:'22:00',intervalHours:24,nextRun:null,autoStartAfterReboot:false,timezone:'Asia/Taipei'};return {status:()=>({...current}),update:v=>Object.assign(current,v),start:()=>{current.loaded=true;},stop:()=>{current.loaded=false;current.autoStartAfterReboot=false;}};};

test('笔记、视频、图集按处理类型独立展示；旧文字产物不让视频混入笔记区',()=>{
  const f=fixture();
  try{
    const db=new DatabaseSync(join(f.home,'index.sqlite'));
    db.exec("UPDATE items SET media_path='/saved.mp4',media_deleted=0,processing_mode='video',status='failed' WHERE id='1'; UPDATE items SET media_path='/removed.mp4',media_deleted=1,processing_mode='video' WHERE id='2'; UPDATE items SET media_path='/cache.mp4',media_deleted=0,processing_mode='note' WHERE id='3'; UPDATE items SET media_path='/saved2.mp4',media_deleted=0,processing_mode='video',status='saved' WHERE id='18';");
    db.close();const store=createStore(f.home),videos=store.listItems({videos:'1'}),o=store.overview();
    assert.deepEqual(videos.items.map(i=>i.id),['18','1']);
    assert.equal(store.listItems({videos:'1',q:'100%'}).total,0);
    assert.equal(o.videos,2);assert.equal(o.notes,15);assert.equal(o.textOnly,0);
    assert.equal(o.recentVideos.length,2);assert.equal(store.listItems({results:'1',q:'1'}).items.some(i=>i.id==='1'),false);
  }finally{f.cleanup();}
});
async function serve(options){const app=createConsole({...options,scheduler:fakeScheduler()});const url=await app.listen(0);const html=await (await fetch(url)).text();const token=html.match(/name="dustoff-token" content="([^"]+)"/)[1];return {...app,url,token,post:(path,data,headers={})=>fetch(url+'/api/'+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Dustoff-Token':token,...headers},body:JSON.stringify(data)}),close:()=>new Promise(resolve=>app.server.close(resolve))};}

test('紧凑前端默认入口及依赖均可加载，旧入口不参与运行',async()=>{
  const f=fixture(),app=await serve({home:f.home});
  try{
    const html=await(await fetch(app.url)).text();assert.ok(html.includes('/studio.mjs'));for(const route of ['overview','notes','videos'])assert.ok(html.includes(`href="#${route}"`));assert.ok(!html.includes('__CSRF_TOKEN__'));
    for(const path of ['/studio.mjs','/studio-view.mjs','/schedule-plan.mjs','/markdown.mjs','/login-ui.mjs','/studio.css'])assert.equal((await fetch(app.url+path)).status,200,path);
    assert.equal((await fetch(app.url+'/studio.html')).status,404);
    assert.equal((await fetch(app.url+'/app.js')).status,404);
  }finally{await app.close();f.cleanup();}
});
test('运行页队列沿用真实处理范围与顺序，只读且不暴露下载元数据',async()=>{
  const f=fixture();let app;
  try{
    const db=new DatabaseSync(join(f.home,'index.sqlite'));
    db.exec("UPDATE items SET status='pending',attempts=0 WHERE id IN ('1','2','3'); UPDATE items SET status='transcribed',attempts=2 WHERE id='4'; UPDATE items SET status='pending',attempts=3 WHERE id='5';");
    for(const [id,enqueued] of [['1',10],['2',10],['4',20],['5',1]])db.prepare('INSERT INTO daily_queue VALUES(?,?,?)').run(id,JSON.stringify({url:'https://signed.invalid/private-download'}),enqueued);
    db.close();const before=readFileSync(join(f.home,'index.sqlite'));
    app=await serve({home:f.home});const data=await(await fetch(app.url+'/api/queue')).json();
    assert.deepEqual(data.items.map(i=>i.id),['2','1','4']);
    assert.ok(data.items.every(i=>!Object.hasOwn(i,'metadata')));assert.ok(!JSON.stringify(data).includes('signed.invalid'));
    assert.deepEqual(readFileSync(join(f.home,'index.sqlite')),before);
  }finally{if(app)await app.close();f.cleanup();}
});

test('只读账本分页、字面搜索、缺失文件和查询期间业务锁不冲突',()=>{const f=fixture();try{const store=createStore(f.home),before=readFileSync(join(f.home,'index.sqlite'));writeFileSync(join(f.home,'.lock.pipeline'),String(process.pid));const a=store.listItems({results:'1',page:2,size:6});assert.equal(a.items.length,6);assert.equal(a.page,2);assert.equal(a.total,18);assert.equal(store.listItems({q:'%'}).total,1);assert.equal(store.listItems({q:"' OR 1=1 --"}).total,0);assert.equal(store.overview().lock.running,true);assert.equal(store.overview().pending,0);assert.ok(store.document('1','note').content.includes('# 测试'));assert.equal(store.item('1').display_title,'整理后的标题');assert.equal(a.items[0].display_title,'整理后的标题');assert.equal(store.item('18').display_title,'测试作品 18');assert.throws(()=>store.document('../dustoff.conf','text'));assert.throws(()=>store.document('18','note'));assert.deepEqual(readFileSync(join(f.home,'index.sqlite')),before);}finally{f.cleanup();}});

test('配置验证、即时有效值、保留注释、密钥不回显及过期保存拦截',()=>{const f=fixture();try{const store=createStore(f.home),original=store.settings();assert.ok(!JSON.stringify(original).includes('fixture-only-secret'));assert.throws(()=>store.saveSettings({revision:original.revision,values:{DUST_DAILY_LIMIT:51}}));assert.throws(()=>store.saveSettings({revision:original.revision,values:{DUST_TEXT:join(f.home,'tmp-media','text')}}));assert.throws(()=>store.saveSettings({revision:original.revision,values:{DUST_TEXT:join(f.home,'media')}}));assert.throws(()=>store.saveSettings({revision:original.revision,values:{DUST_DAILY_LIMIT:'5\nDUST_LLM_KEY=oops'}}));const saved=store.saveSettings({revision:original.revision,values:{DUST_DAILY_LIMIT:20,DUST_DASHSCOPE_KEY:'',DUST_ASR_CONTEXT:'术语一\n术语二'}});assert.equal(store.policy().daily,20);assert.ok(readFileSync(join(f.home,'dustoff.conf'),'utf8').includes('# 保留这条注释'));assert.ok(readFileSync(join(f.home,'dustoff.conf'),'utf8').includes('fixture-only-secret'));assert.throws(()=>store.saveSettings({revision:original.revision,values:{DUST_DAILY_LIMIT:10}}),/刷新/);assert.notEqual(saved.revision,original.revision);assert.equal(store.redact('token fixture-only-secret-not-real'),'token [已隐藏密钥]');}finally{f.cleanup();}});

test('HTTP 来源验证、静态文件边界、分页读取和受控打开',async()=>{const f=fixture();const opened=[];const app=await serve({home:f.home,openFile:async args=>opened.push(args)});try{assert.equal((await fetch(app.url+'/api/health')).status,200);assert.equal(await new Promise((resolve,reject)=>{const r=request(app.url+'/api/overview',{headers:{Host:'malicious.invalid'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();}),403);assert.equal((await app.post('settings',{}, {'X-Dustoff-Token':'wrong'})).status,403);assert.equal((await app.post('run',{}, {Origin:'https://other.invalid'})).status,403);assert.equal((await fetch(app.url+'/api/overview',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await fetch(app.url+'/scripts/config.mjs')).status,404);const result=await (await fetch(app.url+'/api/items?results=1&size=6')).json();assert.equal(result.items.length,6);assert.equal((await app.post('open',{kind:'file',path:'/etc/passwd'})).status,400);assert.equal((await app.post('open',{kind:'note',id:'1'})).status,200);assert.deepEqual(opened,[['-a','Obsidian',join(f.home,'notes','1.md')]]);const settings=await (await fetch(app.url+'/api/settings')).json();assert.equal((await app.post('settings',{revision:settings.revision,values:{DUST_DAILY_LIMIT:25}})).status,200);assert.equal((await(await fetch(app.url+'/api/overview')).json()).policy.daily,25);}finally{await app.close();f.cleanup();}});

test('页内视频通过作品ID受控读取，支持HEAD和分段，清理标记立即阻止播放',async()=>{
  const f=fixture(),app=await serve({home:f.home});
  try{
    const video=join(f.home,'video.mp4');writeFileSync(video,'0123456789');
    const db=new DatabaseSync(join(f.home,'index.sqlite'));db.prepare("UPDATE items SET media_path=?,media_deleted=0 WHERE id='1'").run(video);db.close();
    const url=app.url+'/api/video?id=1';
    const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('Content-Length'),'10');assert.equal(await head.text(),'');
    const part=await fetch(url,{headers:{Range:'bytes=3-6'}});assert.equal(part.status,206);assert.equal(part.headers.get('Content-Range'),'bytes 3-6/10');assert.equal(part.headers.get('Content-Type'),'video/mp4');assert.equal(await part.text(),'3456');
    assert.equal(await(await fetch(url,{headers:{Range:'bytes=-3'}})).text(),'789');
    const invalid=await fetch(url,{headers:{Range:'bytes=10-'}});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('Content-Range'),'bytes */10');
    assert.equal(await(await fetch(url)).text(),'0123456789');
    assert.equal((await fetch(url,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await fetch(app.url+'/api/video?id=../video.mp4')).status,400);
    assert.equal((await app.post('video-prepare',{id:'1'},{'X-Dustoff-Token':'wrong'})).status,403);
    const changed=new DatabaseSync(join(f.home,'index.sqlite'));changed.exec("UPDATE items SET media_deleted=1 WHERE id='1'");changed.close();
    assert.equal((await fetch(url)).status,404);assert.equal((await fetch(app.url+'/api/video-status?id=1')).status,404);assert.equal((await app.post('video-prepare',{id:'1'})).status,404);
  }finally{await app.close();f.cleanup();}
});

test('控制台操作互斥且能停止自己启动的进程组',async()=>{const f=fixture();const app=await serve({home:f.home,spawnProcess:(node,args,opts)=>spawn(node,['-e','console.log("fixture running");setInterval(()=>{},1000)'],opts)});try{assert.equal((await app.post('run',{limit:1})).status,200);assert.equal((await app.post('run',{limit:1})).status,409);assert.equal((await app.post('login',{})).status,409);assert.equal((await app.post('stop',{})).status,200);for(let n=0;n<50&&app.execution().running;n++)await new Promise(r=>setTimeout(r,20));assert.equal(app.execution().running,false);assert.ok(app.execution().lastAction.finishedAt);}finally{if(app.execution().running)await app.post('stop',{});await app.close();f.cleanup();}});

test('真实 retry 子进程只恢复失败待办，不调用模型也不占额度',async()=>{const f=fixture();const app=await serve({home:f.home});try{assert.equal((await app.post('retry',{id:'1'})).status,400);assert.equal((await app.post('retry',{id:'18'})).status,200);for(let n=0;n<100&&app.execution().running;n++)await new Promise(r=>setTimeout(r,20));assert.equal(app.execution().lastAction.exitCode,0);assert.equal(app.store.item('18').status,'transcribed');assert.equal(app.store.overview().usedToday,0);assert.equal(app.store.overview().pending,1);}finally{await app.close();f.cleanup();}});

test('删除只移动对应视频，保留文字与恢复记录，停止自动处理并支持重复请求',async()=>{
  const f=fixture(),store=createStore(f.home),moved=[];
  try {
    const db=new DatabaseSync(join(f.home,'index.sqlite'));
    for(const id of ['1','18']){const file=join(f.home,id+'.mp4');writeFileSync(file,'video '+id);db.prepare("UPDATE items SET media_path=?,media_deleted=0,processing_mode='note',status='downloaded',needs_ocr=1 WHERE id=?").run(file,id);}
    db.close();
    const trashFile=async file=>{const to=file+'.trashed';renameSync(file,to);moved.push(to);};
    for(const id of ['1','18'])assert.equal((await deleteLocalVideo({id,home:f.home,trashFile})).deleted,true);
    assert.equal(store.overview().videos,0);assert.equal(store.overview().notes,17);assert.equal(store.pendingItems().items.length,0);
    assert.equal(store.item('1').status,'extracted');assert.equal(store.item('18').status,'skipped');
    assert.equal(store.item('18').skip_reason,'video_deleted');assert.equal(store.item('18').needs_ocr,0);
    assert.equal(store.item('1').media_deleted,1);assert.equal(store.overview().usedToday,0);
    assert.equal(readFileSync(moved[0],'utf8'),'video 1');assert.equal(store.document('1','text').content,'测试原稿。');assert.ok(store.document('1','note').content.includes('核心观点'));
    assert.equal((await deleteLocalVideo({id:'1',home:f.home,trashFile})).alreadyDeleted,true);assert.equal(moved.length,2);
    const records=join(f.home,'console','deleted-videos');assert.equal(readdirSync(records).length,2);
    const record=JSON.parse(readFileSync(join(records,readdirSync(records).find(n=>n.startsWith('1-'))),'utf8'));
    assert.equal(record.state,'trashed');assert.equal(record.item.status,'downloaded');assert.equal(record.item.media_deleted,0);
    assert.throws(()=>store.fileFor('1','video'),/视频已清理/);
  } finally {f.cleanup();}
});

test('移入废纸篓失败不改账本；拒绝图集、符号链接和被其他收藏引用的视频',async()=>{
  const f=fixture(),store=createStore(f.home),video=join(f.home,'video.mp4');let calls=0;
  const trashFile=async()=>{calls++;throw new Error('trash unavailable');};
  try {
    writeFileSync(video,'keep me');const db=new DatabaseSync(join(f.home,'index.sqlite'));
    db.prepare("UPDATE items SET media_path=?,status='saved' WHERE id='1'").run(video);
    await assert.rejects(deleteLocalVideo({id:'1',home:f.home,trashFile}),/trash unavailable/);
    assert.equal(store.item('1').media_deleted,0);assert.equal(store.item('1').status,'saved');assert.equal(readFileSync(video,'utf8'),'keep me');
    db.prepare("UPDATE items SET media_path=? WHERE id='2'").run(video);
    await assert.rejects(deleteLocalVideo({id:'1',home:f.home,trashFile}),/其他收藏/);
    db.exec("UPDATE items SET media_type='gallery' WHERE id='1'");
    await assert.rejects(deleteLocalVideo({id:'1',home:f.home,trashFile}),/只支持视频/);
    const link=join(f.home,'link.mp4');symlinkSync(video,link);db.prepare("UPDATE items SET media_type='video',media_path=? WHERE id='1'").run(link);db.close();
    await assert.rejects(deleteLocalVideo({id:'1',home:f.home,trashFile}),/普通文件/);
    assert.equal(calls,1);assert.equal(readFileSync(video,'utf8'),'keep me');
  } finally {f.cleanup();}
});

test('删除接口验证确认与来源、等待子进程结果，运行期间拒绝删除',async()=>{
  const f=fixture(),video=join(f.home,'18.mp4');let calls=0;
  writeFileSync(video,'fixture video');const db=new DatabaseSync(join(f.home,'index.sqlite'));
  db.prepare("UPDATE items SET media_path=?,media_deleted=0,status='saved',processing_mode='video' WHERE id='18'").run(video);db.close();
  const app=await serve({home:f.home,spawnProcess:(node,args,opts)=>{
    calls++;assert.deepEqual(args.slice(1),['video-delete','18']);
    const script=`import {renameSync} from 'node:fs';import {deleteLocalVideo} from ${JSON.stringify(new URL('../scripts/delete-video.mjs',import.meta.url).href)};await deleteLocalVideo({id:'18',home:process.env.DUST_HOME,trashFile:async p=>renameSync(p,p+'.trashed')});`;
    return spawn(node,['--input-type=module','-e',script],opts);
  }});
  try {
    assert.equal((await app.post('video-delete',{id:'18'})).status,400);
    assert.equal((await app.post('video-delete',{id:'18',confirm:true},{'X-Dustoff-Token':'wrong'})).status,403);
    assert.equal((await app.post('video-delete',{id:'18',confirm:true},{Origin:'https://other.invalid'})).status,403);
    assert.equal((await app.post('video-delete',{id:'../18',confirm:true})).status,400);
    writeFileSync(join(f.home,'.lock.pipeline'),String(process.pid));
    assert.equal((await app.post('video-delete',{id:'18',confirm:true})).status,409);rmSync(join(f.home,'.lock.pipeline'));
    assert.equal(calls,0);
    const response=await app.post('video-delete',{id:'18',confirm:true});assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);
    assert.equal(calls,1);assert.equal(app.execution().running,false);assert.equal(app.store.item('18').media_deleted,1);
    assert.equal((await fetch(app.url+'/api/video?id=18')).status,404);assert.equal(readFileSync(video+'.trashed','utf8'),'fixture video');
  } finally {await app.close();f.cleanup();}
});

test('笔记阅读渲染支持常用结构且原始 HTML、脚本链接和图片不会执行',()=>{const html=renderMarkdown('---\nsecret: metadata\n---\n# 标题\n\n**要点**\n\n- 项目\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[x](javascript:alert)\n\n![图](https://track.invalid/i.png)\n\n```js\n<img onerror=alert(1)>\n```');assert.ok(html.includes('<h1'));assert.ok(html.includes('<strong>要点</strong>'));assert.ok(html.includes('<table>'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('metadata'));assert.ok(renderMarkdown('# 段落标题',{headingOffset:1}).startsWith('<h2'));});


test('登录接口校验来源、只返回窗口进度且不提供二维码图片',async()=>{
  const f=fixture();let child;
  const app=await serve({home:f.home,spawnProcess:(node,args,opts)=>(child=spawn(node,['-e','setInterval(()=>{},1000)'],opts))});
  try{
    assert.equal((await app.post('session-check',{}, {'X-Dustoff-Token':'wrong'})).status,403);
    assert.equal((await app.post('login',{})).status,200);
    child.emit('message',{type:'session',phase:'window',message:'请在 Chrome 完成登录',image:'ZmFrZS1wbmc=',deadline:Date.now()+60000});
    const session=await(await fetch(app.url+'/api/session')).json();assert.equal(session.active,true);assert.equal(session.auth.phase,'window');assert.equal(session.qrAt,undefined);assert.ok(!JSON.stringify(session).includes('ZmFrZS'));
    assert.equal((await fetch(app.url+'/api/login-image')).status,404);
    assert.equal((await fetch(app.url+'/api/login-image',{headers:{'X-Dustoff-Token':app.token}})).status,404);
    await app.post('stop',{});for(let n=0;n<50&&app.execution().running;n++)await new Promise(r=>setTimeout(r,20));
    assert.equal((await fetch(app.url+'/api/login-image',{headers:{'X-Dustoff-Token':app.token}})).status,404);
    assert.equal((await app.post('login-control',{action:'refresh'})).status,400);
  }finally{if(app.execution().running)await app.post('stop',{});await app.close();f.cleanup();}
});

test('定时 API 同步保存起始时间和小时间隔，拒绝缺失或错误类型',async()=>{
  const f=fixture(),app=await serve({home:f.home});
  try{
    assert.equal((await app.post('schedule',{action:'save',time:'22:00',autoStartAfterReboot:false})).status,400);
    assert.equal((await app.post('schedule',{action:'save',time:'22:00',intervalHours:'12',autoStartAfterReboot:false})).status,400);
    const r=await app.post('schedule',{action:'save',time:'22:00',intervalHours:12,autoStartAfterReboot:false});assert.equal(r.status,200);const s=await r.json();assert.equal(s.time,'22:00');assert.equal(s.intervalHours,12);
  }finally{await app.close();f.cleanup();}
});

test('用途覆盖接口、视频打开、状态筛选及本机网关设置',async()=>{
  const f=fixture(),opened=[],app=await serve({home:f.home,openFile:async args=>opened.push(args)});
  try{
    assert.equal((await app.post('purpose',{id:'1',purpose:'video'})).status,400);
    for(const purpose of ['discard','speech','visual','both','gallery'])assert.equal((await app.post('purpose',{id:'18',purpose})).status,400);
    assert.equal((await app.post('purpose',{id:'18',purpose:'video'},{'X-Dustoff-Token':'wrong'})).status,403);
    assert.equal((await app.post('purpose',{id:'18',purpose:'video'})).status,200);
    for(let n=0;n<100&&app.execution().running;n++)await new Promise(r=>setTimeout(r,20));
    assert.equal(app.execution().lastAction.exitCode,0);
    assert.equal(app.store.item('18').processing_mode,'video');assert.equal(app.store.item('18').status,'pending');
    assert.equal(app.store.overview().usedToday,0);
    const settings=app.store.settings();
    app.store.saveSettings({revision:settings.revision,values:{DUST_ROUTER_BASE:'http://127.0.0.1:8317/v1',DUST_ROUTER_KEY:'fixture-router-secret',DUST_ROUTER_MODEL:'glm'}});
    assert.ok(!JSON.stringify(app.store.settings()).includes('fixture-router-secret'));
    assert.equal(app.store.redact('fixture-router-secret'),'[已隐藏密钥]');
    assert.throws(()=>app.store.saveSettings({revision:app.store.settings().revision,values:{DUST_SAVED_MEDIA:join(f.home,'media','saved')}}));
    const video=join(f.home,'saved-media','18','video.mp4');mkdirSync(dirname(video),{recursive:true});writeFileSync(video,'fixture');
    const db=new DatabaseSync(join(f.home,'index.sqlite'));db.prepare("UPDATE items SET status='saved',media_path=?,media_deleted=0 WHERE id='18'").run(video);db.close();
    assert.equal(app.store.listItems({status:'saved'}).total,1);
    assert.equal((await app.post('open',{kind:'video',id:'18'})).status,200);assert.deepEqual(opened,[[video]]);
    assert.equal((await fetch(app.url+'/api/document?id=18&kind=video')).status,400);
  }finally{await app.close();f.cleanup();}
});

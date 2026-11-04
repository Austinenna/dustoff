import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createConsole } from '../console.mjs';
import { createLibrary } from '../scripts/library-store.mjs';
import { setConsolePassword } from '../scripts/console-auth.mjs';

// 虚构笔记：两篇带标签和分类，一篇只有文字稿。
function fixture(){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-library-')));
  const init=spawnSync(process.execPath,['--input-type=module','-e',`import {db} from ${JSON.stringify(new URL('../scripts/ledger.mjs',import.meta.url).href)};db().close();`],{env:{...process.env,DUST_HOME:home},encoding:'utf8'});
  assert.equal(init.status,0,init.stderr);
  mkdirSync(join(home,'notes'));mkdirSync(join(home,'text'));
  const note=(file,title,tags,body)=>writeFileSync(join(home,'notes',file),`---\n标题: "${title}"\n标签: ${JSON.stringify(tags)}\n---\n# 核心观点\n\n${body}\n`);
  note('1.md','剪辑命令行入门',['剪辑','命令行'],'用命令行**批量剪辑**视频。');
  note('2.md','命令行剪辑进阶',['剪辑','脚本'],'把剪辑写成脚本。');
  writeFileSync(join(home,'text','3.txt'),'只有文字稿。');
  const db=new DatabaseSync(join(home,'index.sqlite'));
  const insert=db.prepare("INSERT INTO items(id,platform,title,author,status,first_seen,last_seen,updated_at,note_path,text_path,extracted_at,category,decay,processing_mode) VALUES(?,'douyin',?,'测试作者',?,1,1,1,?,?,?,?,?,'note')");
  insert.run('1','原标题一','extracted',join(home,'notes','1.md'),null,100,'视频工具','slow');
  insert.run('2','原标题二','extracted',join(home,'notes','2.md'),null,200,'视频工具','fast');
  insert.run('3','只有文字稿','transcribed',null,join(home,'text','3.txt'),null,null,null);
  db.close();
  writeFileSync(join(home,'dustoff.conf'),`DUST_NOTES=${join(home,'notes')}\nDUST_TEXT=${join(home,'text')}\n`);
  return {home,cleanup:()=>rmSync(home,{recursive:true,force:true})};
}
const scheduler={status:()=>({loaded:false,running:false,time:'22:00',intervalHours:24,nextRun:null,autoStartAfterReboot:false}),update(){},start(){},stop(){}};
async function serve(home,options={}){
  const app=createConsole({home,scheduler,...options});const url=await app.listen(0);
  const html=await(await fetch(url)).text(),token=html.match(/name="dustoff-token" content="([^"]+)"/)[1];
  const post=(path,data)=>fetch(url+'/api/'+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Dustoff-Token':token},body:JSON.stringify(data)});
  const v1=(path,{secret,method='GET',body}={})=>fetch(url+'/api/v1'+path,{method,headers:{...(secret?{Authorization:'Bearer '+secret}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body&&JSON.stringify(body)});
  return {...app,url,post,v1,close:()=>new Promise(resolve=>app.server.close(resolve))};
}

test('素材箱：选题与素材的增改删，删除选题时素材回到未归类，同一作品整篇只收一次',()=>{
  const f=fixture();let clock=1000;const lib=createLibrary(f.home,{now:()=>clock++});
  try{
    const topic=lib.saveTopic({name:'剪辑选题',description:'写一篇剪辑工具对比',channels:['公众号','公众号','视频']});
    assert.deepEqual(topic.channels,['公众号','视频']);
    assert.throws(()=>lib.saveTopic({name:'剪辑选题'}),/同名/);
    assert.throws(()=>lib.saveTopic({name:'  '}),/名称/);
    const a=lib.addMaterial({item:'1',kind:'note',topic_id:topic.id,memo:'开头用'});
    const again=lib.addMaterial({item:'1',kind:'note',memo:'改了备注'});
    assert.equal(again.id,a.id);assert.equal(again.memo,'改了备注');assert.equal(again.topic_id,topic.id);
    assert.throws(()=>lib.addMaterial({item:'1',kind:'excerpt'}),/选中/);
    assert.throws(()=>lib.addMaterial({item:'../etc',kind:'note'}),/ID/);
    assert.throws(()=>lib.addMaterial({item:'1',kind:'pdf'}),/类型/);
    const e1=lib.addMaterial({item:'2',kind:'excerpt',excerpt:'把剪辑写成脚本。'}),e2=lib.addMaterial({item:'2',kind:'excerpt',excerpt:'第二段'});
    assert.notEqual(e1.id,e2.id);assert.equal(e1.topic_id,null);
    assert.equal(lib.updateMaterial(e1.id,{status:'using',topic_id:topic.id}).status,'using');
    assert.throws(()=>lib.updateMaterial(e1.id,{status:'done'}),/状态/);
    const used=lib.recordUsage(a.id,{channel:'公众号',title:'剪辑工具对比',url:'https://example.test/a'});
    assert.equal(used.status,'used');assert.equal(used.usage.length,1);
    assert.throws(()=>lib.recordUsage(a.id,{channel:'公众号',url:'javascript:alert(1)'}),/http/);
    assert.equal(lib.topics()[0].count,2);assert.equal(lib.topics()[0].used,1);
    // 增量拉取按修改时间升序，便于外部服务记住位置继续拉。
    const since=lib.materials({since:0});assert.deepEqual(since.map(m=>m.id),[e2.id,e1.id,a.id]);
    assert.deepEqual(lib.materials({since:used.updated_at}).map(m=>m.id),[a.id]);assert.deepEqual(lib.materials({since:used.updated_at,after:a.id}).map(m=>m.id),[]);
    lib.deleteTopic(topic.id);
    assert.equal(lib.materials({topic:'none'}).length,3);assert.equal(lib.topics().length,0);
    assert.equal(lib.removeMaterial(e2.id).deleted,true);assert.throws(()=>lib.material(e2.id),/不存在/);
  }finally{lib.close();f.cleanup();}
});

test('选题建议按标签和分类重合排序，空选题不参与，不调用模型',()=>{
  const f=fixture();const lib=createLibrary(f.home);
  try{
    const cut=lib.saveTopic({name:'剪辑'}),other=lib.saveTopic({name:'别的'});lib.saveTopic({name:'空选题'});
    lib.addMaterial({item:'1',kind:'note',topic_id:cut.id});lib.addMaterial({item:'3',kind:'note',topic_id:other.id});
    const meta={'1':{category:'视频工具',tags:['剪辑','命令行']},'3':{category:null,tags:[]}};
    const result=lib.suggest({category:'视频工具',tags:['剪辑','脚本']},id=>meta[id]);
    assert.equal(result.length,1);assert.equal(result[0].topic_id,cut.id);assert.match(result[0].reason,/剪辑/);assert.match(result[0].reason,/视频工具/);
    assert.deepEqual(lib.suggest({category:'别的',tags:['无关']},id=>meta[id]),[]);
  }finally{lib.close();f.cleanup();}
});

test('访问令牌：明文只返回一次，库里只存哈希，吊销后立即失效',()=>{
  const f=fixture();const lib=createLibrary(f.home);
  try{
    assert.throws(()=>lib.createToken({name:'写作',scope:'admin'}),/权限/);
    const t=lib.createToken({name:'写作',scope:'read'});
    assert.match(t.token,/^dsk_[A-Za-z0-9_-]{32}$/);assert.equal(t.hint,t.token.slice(-4));
    assert.equal(JSON.stringify(lib.tokens()).includes(t.token),false);
    const raw=new DatabaseSync(lib.file,{readOnly:true});assert.equal(JSON.stringify(raw.prepare('SELECT * FROM api_tokens').all()).includes(t.token),false);raw.close();
    assert.equal(lib.verifyToken(t.token).scope,'read');assert.equal(lib.verifyToken(t.token.slice(0,-1)+(t.token.endsWith('x')?'y':'x')),null);assert.equal(lib.verifyToken('Bearer x'),null);
    lib.revokeToken(t.id);assert.equal(lib.verifyToken(t.token),null);
  }finally{lib.close();f.cleanup();}
});

test('控制台：知识库索引带标签、摘要和已读状态；素材附作品摘要；建议走规则',async()=>{
  const f=fixture(),app=await serve(f.home);
  try{
    let index=await(await fetch(app.url+'/api/notes-index')).json();
    const one=index.items.find(i=>i.id==='1');
    assert.equal(one.title,'剪辑命令行入门');assert.deepEqual(one.tags,['剪辑','命令行']);assert.equal(one.gist,'用命令行批量剪辑视频。');assert.equal(one.read_at,null);
    assert.equal(index.items.find(i=>i.id==='3').has_note,false);
    assert.equal((await app.post('read',{id:'1'})).status,200);
    index=await(await fetch(app.url+'/api/notes-index')).json();assert.ok(index.items.find(i=>i.id==='1').read_at);
    assert.equal((await app.post('read',{id:'1',read:false})).status,200);
    // 写操作仍然要求控制台令牌和同源。
    assert.equal((await fetch(app.url+'/api/topic',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"x"}'})).status,403);
    const topic=await(await app.post('topic',{name:'剪辑'})).json();
    const material=await(await app.post('material',{item:'1',kind:'note',topic_id:topic.id})).json();
    assert.equal(material.source.title,'剪辑命令行入门');assert.equal(material.source.has_note,true);
    const suggestion=await(await fetch(app.url+'/api/suggest?id=2')).json();
    assert.equal(suggestion.suggestions[0].topic_id,topic.id);
    const library=await(await fetch(app.url+'/api/library')).json();assert.equal(library.materials.length,1);assert.equal(library.topics[0].count,1);
    const insights=await(await fetch(app.url+'/api/insights')).json();assert.equal(insights.output.length,14);assert.ok(insights.version);
  }finally{await app.close();f.cleanup();}
});

test('对外接口只认 Bearer 令牌：只读令牌不能回写，吊销后 401，媒体和笔记全文可取，不暴露本机路径',async()=>{
  const f=fixture(),app=await serve(f.home);
  try{
    const topic=await(await app.post('topic',{name:'剪辑'})).json();
    const m=await(await app.post('material',{item:'1',kind:'note',topic_id:topic.id,memo:'开头用'})).json();
    const read=await(await app.post('token',{name:'只读',scope:'read'})).json(),write=await(await app.post('token',{name:'回写',scope:'write'})).json();
    assert.equal((await app.v1('/materials')).status,401);
    assert.equal((await app.v1('/materials',{secret:'dsk_'+'a'.repeat(32)})).status,401);
    // 控制台自己的 CSRF 令牌不能当作对外令牌使用。
    const html=await(await fetch(app.url)).text(),csrf=html.match(/name="dustoff-token" content="([^"]+)"/)[1];
    assert.equal((await fetch(app.url+'/api/v1/materials',{headers:{'X-Dustoff-Token':csrf}})).status,401);
    const topics=await(await app.v1('/topics',{secret:read.token})).json();assert.equal(topics.topics[0].name,'剪辑');
    const list=await(await app.v1('/materials?topic='+topic.id,{secret:read.token})).json();
    assert.equal(list.materials[0].source.title,'剪辑命令行入门');assert.equal(list.next,null);
    const detail=await(await app.v1('/materials/'+m.id,{secret:read.token})).json();
    assert.match(detail.content,/批量剪辑/);assert.equal(detail.source.source_url,'https://www.douyin.com/video/1');
    assert.equal(JSON.stringify(detail).includes(f.home),false);
    assert.equal((await app.v1('/materials/'+m.id+'/media/0',{secret:read.token})).status,404);
    assert.equal((await app.v1('/materials/'+m.id+'/usage',{secret:read.token,method:'POST',body:{channel:'公众号'}})).status,403);
    const usage=await app.v1('/materials/'+m.id+'/usage',{secret:write.token,method:'POST',body:{channel:'公众号',title:'剪辑对比'}});
    assert.equal(usage.status,200);assert.equal((await usage.json()).status,'used');
    const incremental=await(await app.v1('/materials?since=0&limit=1',{secret:read.token})).json();assert.deepEqual(incremental.next,{since:incremental.materials[0].updated_at,after:m.id});
    assert.equal((await app.post('token-revoke',{id:read.id})).status,200);
    assert.equal((await app.v1('/topics',{secret:read.token})).status,401);
    const tokens=await(await fetch(app.url+'/api/tokens')).json();assert.equal(JSON.stringify(tokens).includes(write.token),false);
    const log=readFileSync(join(f.home,'console','api-access.jsonl'),'utf8');assert.ok(log.includes('"status":401'));assert.equal(log.includes(write.token),false);
  }finally{await app.close();f.cleanup();}
});

test('公网模式下对外接口绕过密码登录，但控制台页面和内部接口仍需登录',async()=>{
  const f=fixture();await setConsolePassword(f.home,'fixture-password-123');
  const app=createConsole({home:f.home,publicUrl:'https://dustoff.invalid/dustoff',serverMode:true,scheduler});
  try{
    await app.listen(0);const port=app.server.address().port;
    const secret=createLibrary(f.home).createToken({name:'外部',scope:'read'}).token;
    const call=(path,headers={})=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path,headers:{Host:'dustoff.invalid',...headers}},res=>{let body='';res.on('data',v=>body+=v);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});
    assert.equal((await call('/dustoff/api/v1/topics',{Authorization:'Bearer '+secret})).status,200);
    assert.equal((await call('/dustoff/api/v1/topics')).status,401);
    assert.equal((await call('/dustoff/api/library',{Authorization:'Bearer '+secret})).status,401);
    assert.equal((await call('/dustoff/fonts/inter-latin.woff2')).status,401);
  }finally{await new Promise(resolve=>app.server.close(resolve));f.cleanup();}
});

test('字体文件只服务 web/fonts 中的 woff2，不能借路径读取其他文件',async()=>{
  const f=fixture(),app=await serve(f.home);
  try{
    const font=await fetch(app.url+'/fonts/inter-latin.woff2');assert.equal(font.status,200);assert.equal(font.headers.get('content-type'),'font/woff2');
    assert.equal((await fetch(app.url+'/fonts/../studio.mjs')).status,200); // URL 规范化后是 /studio.mjs，本来就公开
    assert.equal((await fetch(app.url+'/fonts/%2e%2e%2fconsole.mjs')).status,404);
    assert.equal((await fetch(app.url+'/fonts/missing.woff2')).status,404);
  }finally{await app.close();f.cleanup();}
});

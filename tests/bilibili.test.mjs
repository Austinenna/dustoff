import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {mixinKey,signWbi,biliSession,cookieHeader} from '../scripts/sources/bilibili/client.mjs';
import {scanFavorites,folderPurposes,startAt} from '../scripts/sources/bilibili/favorites.mjs';
import {pickSubtitle,subtitleText} from '../scripts/sources/bilibili/content.mjs';
import {platformOfId,sourceUrl} from '../scripts/platforms.mjs';

const T0=startAt('2026-11-01');
function isolated(source,env={}) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-bili-')));
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{
      cwd:new URL('..',import.meta.url),env:{...process.env,DUST_HOME:home,DUST_NOTIFY:'0',DUST_DASHSCOPE_KEY:'',DUST_ASR_KEY:'',DUST_LLM_KEY:'',DUST_ROUTER_KEY:'',DUST_BILI_ENABLED:'1',DUST_BILI_START_DATE:'2026-11-01',DUST_BILI_INTERVAL_MS:'0',...env},encoding:'utf8',timeout:60000,
    });
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  } finally {rmSync(home,{recursive:true,force:true});}
}
// 虚构的收藏夹数据：每页按给定顺序返回，可模拟用户手动调整过排序。
export function fakeClient(folders,{mid='42'}={}) {
  const calls=[];
  return {calls,nav:async()=>({mid}),get:async(path,params)=>{
    calls.push([path,params]);
    if(path==='/x/v3/fav/folder/created/list-all')return {list:folders.map(f=>({id:Number(f.id),title:f.title,media_count:f.medias.length}))};
    if(path==='/x/v3/fav/resource/list'){const f=folders.find(f=>f.id===String(params.media_id)),start=(params.pn-1)*params.ps;return {medias:f.medias.slice(start,start+params.ps),has_more:start+params.ps<f.medias.length};}
    throw new Error('未模拟的接口 '+path);
  }};
}
const media=(n,fav,extra={})=>({type:2,attr:0,bvid:`BV1test${String(n).padStart(5,'0')}`,id:n,title:`虚构视频 ${n}`,intro:'',upper:{name:'测试作者'},pubtime:fav-100,duration:300,fav_time:fav,page:1,...extra});

test('WBI 签名与公开示例一致；平台按 ID 格式区分',()=>{
  assert.equal(mixinKey('7cd084941338484aae1ad9425b84077c','4932caff0ff746eab6f01bf08b70ac45'),'ea1db124af3c7062474693fa704f4ff8');
  assert.match(signWbi({foo:'114',bar:'514',zab:1919810},{img:'7cd084941338484aae1ad9425b84077c',sub:'4932caff0ff746eab6f01bf08b70ac45'},1702204169),/w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4$/);
  assert.equal(platformOfId('7676650803859361059'),'douyin');assert.equal(platformOfId('BV1BgFWeWEgz'),'bilibili');assert.equal(platformOfId('BV1短'),null);
  assert.equal(sourceUrl({platform:'bilibili',id:'BV1BgFWeWEgz'}),'https://www.bilibili.com/video/BV1BgFWeWEgz');
  assert.equal(sourceUrl({id:'123',media_type:'gallery'}),'https://www.douyin.com/note/123');
});

test('Cookie 只取未过期的 B站条目，登录需 SESSDATA 与账号 ID',()=>{
  const now=1_800_000_000;
  const cookies=[{name:'SESSDATA',value:'s',domain:'.bilibili.com',expires:now+86400},{name:'DedeUserID',value:'42',domain:'.bilibili.com'},{name:'sessionid',value:'x',domain:'.douyin.com'},{name:'old',value:'y',domain:'.bilibili.com',expires:now-1}];
  assert.deepEqual(biliSession(cookies,now),{loggedIn:true,expiresAt:now+86400,mid:'42'});
  assert.equal(cookieHeader(cookies,now),'SESSDATA=s; DedeUserID=42');
  assert.equal(biliSession(cookies.slice(1),now).loggedIn,false);
});

test('字幕：人工中文优先于 AI；多 P 按顺序拼接并累加时间',()=>{
  const list=[{lan:'ai-zh',subtitle_url:'//a'},{lan:'zh-CN',subtitle_url:'//b'},{lan:'en',subtitle_url:'//c'}];
  assert.equal(pickSubtitle(list).lan,'zh-CN');
  assert.equal(pickSubtitle([list[0]]).lan,'ai-zh');assert.equal(pickSubtitle([list[0]],{allowAi:false}),null);
  const r=subtitleText([{page:{part:'上',duration:10},ai:true,lines:[{from:1,to:2,content:'第一句'}]},{page:{part:'下',duration:5},ai:false,lines:[{from:0.5,to:1,content:' 第二句 '}]}]);
  assert.equal(r.text,'P1 · 上\n第一句\nP2 · 下\n第二句');assert.equal(r.source,'ai_subtitle');assert.deepEqual(r.words.map(w=>w.t),[1000,10500]);
});

test('收藏夹用途配置与起始日期解析',()=>{
  assert.deepEqual([...folderPurposes('课程=note，舞蹈=video, 123=review,坏=delete')],[['课程','note'],['舞蹈','video'],['123','review']]);
  assert.throws(()=>startAt('2026/11/01'));assert.equal(new Date(T0*1000).getHours(),0);
});

test('首次扫描只收起始时间之后的收藏，跨收藏夹去重，手动排序也不提前停止',async()=>{
  const folders=[
    {id:'1',title:'学习',medias:[media(1,T0+500),media(9,T0-10),media(2,T0+300),...Array.from({length:20},(_,i)=>media(100+i,T0-1000-i))]},
    {id:'2',title:'舞蹈',medias:[media(2,T0+400),media(3,T0-5)]},
    {id:'3',title:'失效',medias:[media(4,T0+50,{title:'已失效视频'}),media(5,T0+60,{type:12})]},
  ];
  const client=fakeClient(folders);
  const r=await scanFavorites({client,state:null,startDate:'2026-11-01'});
  assert.deepEqual(r.items.map(i=>i.aweme_id).sort(),['BV1test00001','BV1test00002']);
  const shared=r.items.find(i=>i.aweme_id==='BV1test00002');
  assert.deepEqual(shared.folders,['学习','舞蹈']);assert.equal(shared.collected_at,T0+300);
  // 第 1 页有新收藏所以读第 2 页；第 2 页全是旧收藏，到此为止。
  assert.equal(client.calls.filter(([p,q])=>p.endsWith('resource/list')&&q.media_id==='1').length,2);
  assert.equal(r.nextState.start_at,T0);assert.equal(r.nextState.folders['1'].watermark,T0+500);assert.equal(r.nextState.mid,'42');
});

test('后续扫描只取水位之后的；首次启用后新出现的收藏夹只记录位置；超过页数上限给出警告',async()=>{
  const state={version:1,mid:'42',start_at:T0,created_at:T0,folders:{'1':{title:'学习',watermark:T0+500,count:3}}};
  const folders=[{id:'1',title:'学习',medias:[media(6,T0+900),media(1,T0+500)]},{id:'7',title:'新建',medias:[media(8,T0+950)]}];
  const r=await scanFavorites({client:fakeClient(folders),state});
  // 与水位同一秒的会被重读（防止同秒的两条漏掉），入队时按账本去重。
  assert.deepEqual(r.items.map(i=>i.aweme_id),['BV1test00006','BV1test00001']);
  assert.equal(r.nextState.folders['7'].watermark,T0+950);
  const many={id:'1',title:'学习',medias:Array.from({length:45},(_,i)=>media(200+i,T0+2000-i))};
  const capped=await scanFavorites({client:fakeClient([many]),state,maxPages:2});
  assert.equal(capped.items.length,40);assert.match(capped.warnings[0],/只读前 2 页/);
  await assert.rejects(scanFavorites({client:fakeClient(folders,{mid:'99'}),state}),/账号不同/);
});

test('排除名单与白名单支持 ID 或标题；已排除收藏夹保留原位置',async()=>{
  const folders=[{id:'1',title:'学习',medias:[media(1,T0+10)]},{id:'2',title:'稍后再看',medias:[media(2,T0+10)]}];
  const r=await scanFavorites({client:fakeClient(folders),state:null,startDate:'2026-11-01',exclude:'稍后再看'});
  assert.deepEqual(r.items.map(i=>i.aweme_id),['BV1test00001']);assert.deepEqual(r.folders.map(f=>f.tracked),[true,false]);
  const only=await scanFavorites({client:fakeClient(folders),state:null,startDate:'2026-11-01',include:'2'});
  assert.deepEqual(only.items.map(i=>i.aweme_id),['BV1test00002']);
});

test('日常一轮：B站与抖音同轮运行，字幕成笔记、视频保存、存量不入账，抖音基线不变',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
  import {DUST_HOME} from './scripts/config.mjs';
  import {db} from './scripts/ledger.mjs';
  import {platformState,usage,baseline} from './scripts/daily.mjs';
  import {SAVED_MEDIA} from './scripts/policy.mjs';
  import {startAt} from './scripts/sources/bilibili/favorites.mjs';
  import {writeNote} from './notes.mjs';
  import {main} from './run.mjs';
  const T0=startAt('2026-11-01');
  // 已有抖音基线；本轮抖音扫描为空列表。
  db().exec("CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const douyinBaseline=JSON.stringify({created_at:1,scanned_at:1,anchors:[]});
  db().prepare("INSERT INTO daily_state VALUES('baseline',?)").run(douyinBaseline);
  mkdirSync(join(DUST_HOME,'bilibili'),{recursive:true});
  writeFileSync(join(DUST_HOME,'bilibili','cookies.json'),JSON.stringify([{name:'SESSDATA',value:'s',domain:'.bilibili.com',expires:4102444800},{name:'DedeUserID',value:'42',domain:'.bilibili.com'}]));
  const m=(n,fav)=>({type:2,attr:0,bvid:'BV1test0000'+n,id:n,title:'虚构视频 '+n,intro:'',upper:{name:'作者'},pubtime:fav-100,duration:300,fav_time:fav,page:1});
  let folders=[{id:'1',title:'课程',medias:[m(1,T0+100),m(2,T0+200),m(9,T0-50)]}];
  const client={nav:async()=>({mid:'42'}),get:async(path,params)=>{
    if(path.endsWith('list-all'))return {list:folders.map(f=>({id:Number(f.id),title:f.title,media_count:f.medias.length}))};
    if(path.endsWith('resource/list')){const f=folders.find(f=>f.id===String(params.media_id));return {medias:f.medias,has_more:false};}
    throw new Error(path);}};
  const meta=async(_,id)=>({aweme_id:id,platform:'bilibili',media_type:'video',is_gallery:false,desc:'虚构视频',intro:'简介',author:'作者',duration_s:300,tname:'知识',tags:['Claude Code'],pages:[{cid:1,part:'',duration:300}],meta_at:Math.floor(Date.now()/1000)});
  const note={转写排版:{paragraph_starts:[]},够写:true,缺料说明:'',标题:'虚构笔记',分类:'测试',时效:'none',标签:['测试'],引流说明:'',正文:'# 核心观点\\n虚构内容'};
  const contexts=[];
  const deps={meta,llmKey:'test',notesDir:join(DUST_HOME,'notes-out'),textDir:join(DUST_HOME,'text'),writeNote,
    classify:async item=>({purpose:item.aweme_id.endsWith('1')?'note':'video',reason:'测试',model:'fake'}),
    subtitles:async()=>({text:'第一句。\\n第二句。',words:[],source:'ai_subtitle',lan:'ai-zh'}),
    note:async row=>{contexts.push(row.extra_context);return {note,missingContent:false};},
    video:async(_,item)=>{const dir=join(SAVED_MEDIA,item.aweme_id);mkdirSync(dir,{recursive:true});const path=join(dir,'video.mp4');writeFileSync(path,'x');return {aweme_id:item.aweme_id,status:'done',path,bytes:1,has_audio:true,quality:'high'};}};
  const runScript=async()=>({ok:true,logged_in:true,items:[],truncated:false,fetched_at:1});
  const r=await main(['--limit','5'],{runScript,bilibili:{client,deps}});
  assert.deepEqual(r.failures,[]);assert.equal(r.bilibili.added,2);assert.equal(r.notes,1);assert.equal(r.saved,1);
  const rows=Object.fromEntries(db().prepare("SELECT * FROM items WHERE platform='bilibili'").all().map(r=>[r.id,r]));
  assert.deepEqual(Object.keys(rows).sort(),['BV1test00001','BV1test00002']);
  assert.equal(rows.BV1test00001.status,'extracted');assert.equal(rows.BV1test00001.text_source,'ai_subtitle');assert.equal(rows.BV1test00001.collected_at,T0+100);
  assert.equal(rows.BV1test00002.status,'saved');
  const md=readFileSync(rows.BV1test00001.note_path,'utf8');
  assert.match(md,/^来源: B站$/m);assert.match(md,/链接: "https:\\/\\/www.bilibili.com\\/video\\/BV1test00001"/);assert.match(md,/收藏夹: \\["课程"\\]/);assert.match(md,/\\[原视频\\]\\(https:\\/\\/www.bilibili.com\\/video\\/BV1test00001\\)/);
  assert.match(contexts[0],/AI 字幕/);assert.match(contexts[0],/Claude Code/);
  assert.equal(usage(undefined,'bilibili'),2);assert.equal(usage(undefined,'douyin'),0);
  assert.equal(db().prepare("SELECT value FROM daily_state WHERE name='baseline'").get().value!==undefined,true);
  assert.deepEqual(baseline().anchors,[]);assert.equal(platformState('bilibili').start_at,T0);
  // 第二轮：没有新收藏；新建的收藏夹只记录位置。
  folders=[...folders,{id:'5',title:'新建',medias:[m(3,T0+900)]}];
  const second=await main(['--limit','5'],{runScript,bilibili:{client,deps}});
  assert.equal(second.bilibili.added,0);assert.equal(platformState('bilibili').folders['5'].watermark,T0+900);
  assert.equal(db().prepare("SELECT count(*) n FROM items WHERE platform='bilibili'").get().n,2);
  process.exitCode=0;
`,{DUST_BILI_AUTO_ROUTE:'1'}));

test('B站登录失效只作扫描警告，抖音待办照常；关闭 B站时不扫描',()=>isolated(`
  import assert from 'node:assert/strict';
  import {db} from './scripts/ledger.mjs';
  import {main} from './run.mjs';
  db().exec("CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db().prepare("INSERT INTO daily_state VALUES('baseline',?)").run(JSON.stringify({created_at:1,scanned_at:1,anchors:[]}));
  const runScript=async()=>({ok:true,logged_in:true,items:[],truncated:false,fetched_at:1});
  const r=await main(['--limit','5'],{runScript,bilibili:{client:{nav:async()=>{throw new Error('不应调用');}}}});
  assert.match(r.scanWarning,/^B站：B站尚未登录/);assert.deepEqual(r.failures,[]);assert.equal(r.paused,null);
  process.exitCode=0;
`));

const pipelineSetup = `
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync} from 'node:fs';
  import {DUST_HOME} from './scripts/config.mjs';
  import {db} from './scripts/ledger.mjs';
  import {MEDIA} from './scripts/policy.mjs';
  import {startAt} from './scripts/sources/bilibili/favorites.mjs';
  import {writeNote} from './notes.mjs';
  import {main} from './run.mjs';
  const T0=startAt('2026-11-01');
  db().exec("CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db().prepare("INSERT INTO daily_state VALUES('baseline',?)").run(JSON.stringify({created_at:1,scanned_at:1,anchors:[]}));
  mkdirSync(join(DUST_HOME,'bilibili'),{recursive:true});
  writeFileSync(join(DUST_HOME,'bilibili','cookies.json'),JSON.stringify([{name:'SESSDATA',value:'s',domain:'.bilibili.com'},{name:'DedeUserID',value:'42',domain:'.bilibili.com'}]));
  const durations={BV1test00001:300,BV1test00002:2400};
  const m=(n,fav)=>({type:2,attr:0,bvid:'BV1test0000'+n,id:n,title:'虚构 '+n,upper:{name:'作者'},pubtime:fav,duration:durations['BV1test0000'+n],fav_time:fav,page:1});
  const client={nav:async()=>({mid:'42'}),get:async(path)=>path.endsWith('list-all')?{list:[{id:1,title:'课程',media_count:2}]}:{medias:[m(1,T0+10),m(2,T0+20)],has_more:false}};
  const transcribed=[];
  const deps={llmKey:'k',asrKey:'k',notesDir:join(DUST_HOME,'notes-out'),textDir:join(DUST_HOME,'text'),writeNote,
    meta:async(_,id)=>({aweme_id:id,platform:'bilibili',media_type:'video',is_gallery:false,desc:'虚构',author:'作者',duration_s:durations[id],tags:[],pages:[{cid:1,part:'',duration:durations[id]}],meta_at:Math.floor(Date.now()/1000)}),
    classify:async()=>({purpose:'note',reason:'测试'}),subtitles:async()=>null,
    audio:async(_,item)=>{const dir=join(MEDIA,item.aweme_id);mkdirSync(dir,{recursive:true});const path=join(dir,'audio.m4a');writeFileSync(path,'a');return {aweme_id:item.aweme_id,status:'done',path,bytes:1,has_audio:true,quality:'low'};},
    transcribe:async row=>{transcribed.push(row.id);const textPath=join(DUST_HOME,'text',row.id+'.txt');mkdirSync(join(DUST_HOME,'text'),{recursive:true});writeFileSync(textPath,'转写内容。');return {chars:5,textPath,seconds:row.duration_s};},
    note:async()=>({note:{转写排版:{paragraph_starts:[]},够写:true,缺料说明:'',标题:'虚构',分类:'测试',时效:'none',标签:[],引流说明:'',正文:'正文'},missingContent:false})};
  const runScript=async()=>({ok:true,logged_in:true,items:[],truncated:false,fetched_at:1});
  const row=id=>db().prepare("SELECT * FROM items WHERE platform='bilibili' AND id=?").get(id);
`;

test('没有字幕时只下载音频走转写；超过转写时长上限的跳过',()=>isolated(pipelineSetup+`
  const r=await main(['--limit','5'],{runScript,bilibili:{client,deps}});
  assert.deepEqual(r.failures,[]);assert.deepEqual(transcribed,['BV1test00001']);
  assert.equal(row('BV1test00001').status,'extracted');assert.equal(row('BV1test00001').text_source,'asr');assert.equal(row('BV1test00001').audio_seconds,300);
  assert.equal(row('BV1test00002').status,'skipped');assert.equal(row('BV1test00002').skip_reason,'too_long_for_asr');
  process.exitCode=0;
`,{DUST_BILI_AUTO_ROUTE:'1'}));

test('B站每日转写总量用尽时只暂停 B站笔记，条目保留待办',()=>isolated(pipelineSetup+`
  const r=await main(['--limit','5'],{runScript,bilibili:{client,deps}});
  assert.match(r.pausedTypes['bilibili:note'],/转写时长已达 4 分钟/);assert.equal(r.paused,null);assert.deepEqual(transcribed,[]);
  assert.equal(row('BV1test00001').status,'pending');assert.equal(row('BV1test00001').attempts,0);
  process.exitCode=0;
`,{DUST_BILI_DAILY_ASR_MIN:'4',DUST_BILI_AUTO_ROUTE:'1'}));

test('控制台按 ID 读取 B站条目，可按平台筛选，总览含 B站状态',()=>isolated(`
  import assert from 'node:assert/strict';
  import {DUST_HOME} from './scripts/config.mjs';
  import {acceptIncremental} from './scripts/daily.mjs';
  import {createStore} from './scripts/console-store.mjs';
  acceptIncremental('bilibili',[{aweme_id:'BV1test00001',platform:'bilibili',desc:'虚构',author:'作者',duration_s:60,collected_at:1,folders:['课程']}],{version:1,mid:'42',start_at:1,scanned_at:2,folders:{}});
  const store=createStore(DUST_HOME);
  const item=store.item('BV1test00001');assert.equal(item.platform,'bilibili');assert.equal(item.folders,'["课程"]');
  assert.equal(store.listItems({platform:'bilibili'}).total,1);assert.equal(store.listItems({platform:'douyin'}).total,0);
  assert.throws(()=>store.listItems({platform:'x'}),/平台无效/);assert.throws(()=>store.item('BV1短'),/作品 ID 不正确/);
  const o=store.overview();assert.equal(o.bilibili.enabled,true);assert.equal(o.bilibili.startAt,1);assert.equal(o.pending,1);assert.equal(o.platforms.bilibili,1);
  assert.equal(store.pendingItems().items[0].platform,'bilibili');
  process.exitCode=0;
`));

test('B站扫码登录只保存 bilibili.com Cookie 并在线核对；检查未登录时记录需要登录',()=>isolated(`
  import assert from 'node:assert/strict';
  import {readFileSync,existsSync,readdirSync} from 'node:fs';
  import {join} from 'node:path';
  import {DUST_HOME} from './scripts/config.mjs';
  import {manageBiliSession} from './scripts/sources/bilibili/session.mjs';
  let polls=0;const events=[];
  const browser={page:async url=>{assert.equal(url,'https://passport.bilibili.com/login');return {};},close:async()=>{},
    send:async method=>{assert.equal(method,'Storage.getCookies');return {cookies:++polls<2?[]:[{name:'SESSDATA',value:'s',domain:'.bilibili.com',expires:4102444800},{name:'DedeUserID',value:'42',domain:'.bilibili.com'},{name:'other',value:'o',domain:'.example.com'}]};}};
  await manageBiliSession({home:DUST_HOME,launch:()=>browser,makeClient:()=>({nav:async()=>({mid:'42'})}),emit:e=>events.push(e.phase),wait:async()=>{}});
  assert.equal(events.at(-1),'success');
  const saved=JSON.parse(readFileSync(join(DUST_HOME,'bilibili','cookies.json'),'utf8'));
  assert.deepEqual(saved.map(c=>c.name),['SESSDATA','DedeUserID']);
  assert.equal(JSON.parse(readFileSync(join(DUST_HOME,'state','bilibili-session.json'),'utf8')).online,'verified');
  assert.deepEqual(readdirSync(join(DUST_HOME,'console')).filter(n=>n.startsWith('bili-profile-')),[]);
  await manageBiliSession({mode:'check',home:join(DUST_HOME,'empty'),emit:()=>{},makeClient:()=>{throw new Error('无 Cookie 时不应联网');}});
  assert.equal(JSON.parse(readFileSync(join(DUST_HOME,'empty','state','bilibili-session.json'),'utf8')).logged_in,false);
  process.exitCode=0;
`));

test('画质：默认最高 1080p 不含高帧率/高码率，同档优先 H.264，没有符合的取最低档',async()=>{
  const {pickVideo}=await import('../scripts/sources/bilibili/content.mjs');
  const v=[{id:120,codecs:'avc1'},{id:116,codecs:'avc1'},{id:80,codecs:'hev1'},{id:80,codecs:'avc1.640032'},{id:64,codecs:'avc1'}];
  assert.deepEqual(pickVideo(v),{id:80,codecs:'avc1.640032'});
  assert.equal(pickVideo(v,116).id,116);assert.equal(pickVideo(v,0).id,120);assert.equal(pickVideo(v,64).id,64);
  assert.equal(pickVideo([{id:112,codecs:'avc1'},{id:116,codecs:'avc1'}],80).id,112);
});

test('B站新收藏默认进入待确认，不调用模型不占额度；收藏夹指定用途的照常处理',()=>isolated(pipelineSetup+`
  writeFileSync(join(DUST_HOME,'dustoff.conf'),'DUST_BILI_FOLDER_PURPOSES=课程=video\\n');
  const folders2={nav:client.nav,get:async path=>path.endsWith('list-all')?{list:[{id:1,title:'课程',media_count:1},{id:2,title:'其他',media_count:1}],has_more:false}:{medias:[m(1,T0+10)],has_more:false}};
  // 两个收藏夹返回同一条：只要有一个收藏夹指定了用途就按指定处理。
  let classified=0;const d2={...deps,classify:async()=>{classified++;return {purpose:'note',reason:'x'};},
    video:async(_,item)=>{const dir=join(DUST_HOME,'saved-media',item.aweme_id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'video.mp4'),'x');return {aweme_id:item.aweme_id,status:'done',path:join(dir,'video.mp4'),bytes:1,has_audio:true,quality:'high'};}};
  const r=await main(['--limit','5'],{runScript,bilibili:{client:folders2,deps:d2}});
  assert.equal(classified,0);assert.equal(row('BV1test00001').processing_mode,'video');assert.equal(row('BV1test00001').status,'saved');assert.equal(row('BV1test00001').routing_source,'folder');
  const plain={nav:client.nav,get:async path=>path.endsWith('list-all')?{list:[{id:2,title:'其他',media_count:1}],has_more:false}:{medias:[m(2,T0+20)],has_more:false}};
  const r2=await main(['--limit','5'],{runScript,bilibili:{client:plain,deps:d2}});
  assert.equal(classified,0);assert.equal(row('BV1test00002').status,'review');assert.equal(row('BV1test00002').routing_source,'default');
  assert.equal(r2.processed,0);
  process.exitCode=0;
`));

test('运行期间记下的用途、画质和放弃：运行跳过该条并在收尾执行；画质只能在视频保存前改',()=>isolated(pipelineSetup+`
  import {addIntent,intentsById} from './scripts/intent-store.mjs';
  import {setVideoQuality} from './scripts/daily.mjs';
  // 先让两条进入待确认。
  await main(['--limit','5'],{runScript,bilibili:{client,deps}});
  assert.equal(row('BV1test00001').status,'review');
  addIntent({id:'BV1test00001',action:'quality',value:'64'},DUST_HOME);
  addIntent({id:'BV1test00001',action:'purpose',value:'video'},DUST_HOME);
  addIntent({id:'BV1test00002',action:'purpose',value:'note'},DUST_HOME);
  addIntent({id:'BV1test00002',action:'discard'},DUST_HOME);
  assert.deepEqual(intentsById(DUST_HOME).get('BV1test00002').map(i=>i.action),['discard']);
  let asked;const d3={...deps,video:async(_,item,opts)=>{asked=opts.maxQuality;const dir=join(DUST_HOME,'saved-media',item.aweme_id);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'video.mp4'),'x');return {aweme_id:item.aweme_id,status:'done',path:join(dir,'video.mp4'),bytes:1,has_audio:true,quality:'high'};}};
  const r=await main(['--limit','5','--no-scan'],{runScript,bilibili:{client,deps:d3}});
  assert.equal(intentsById(DUST_HOME).size,0);assert.equal(r.intents.applied,3);
  assert.equal(row('BV1test00001').status,'saved');assert.equal(asked,64);
  assert.equal(row('BV1test00002').skip_reason,'user_discarded');
  assert.throws(()=>setVideoQuality('BV1test00001','80'),/已经保存/);
  assert.throws(()=>setVideoQuality('BV1test00001','99'),/画质选项无效/);
  process.exitCode=0;
`));

test('控制台：运行中选用途和画质先记下；空闲后自动执行',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {writeFileSync,rmSync} from 'node:fs';
  import {DUST_HOME} from './scripts/config.mjs';
  import {acceptIncremental} from './scripts/daily.mjs';
  import {markRouting} from './scripts/ledger.mjs';
  import {createConsole} from './console.mjs';
  acceptIncremental('bilibili',[{aweme_id:'BV1test00001',platform:'bilibili',desc:'虚构',author:'作者',duration_s:60,collected_at:1}],{version:1,mid:'42',start_at:1,scanned_at:2,folders:{}});
  markRouting('BV1test00001',{purpose:'review',reason:'默认',source:'default'});
  const scheduler={status:()=>({loaded:false,time:null,intervalHours:null,nextRun:null}),start(){},stop(){}};
  const app=createConsole({home:DUST_HOME,scheduler});const url=await app.listen(0);
  try{
    const token=(await(await fetch(url)).text()).match(/name="dustoff-token" content="([^"]+)"/)[1];
    const post=(p,body)=>fetch(url+'/api/'+p,{method:'POST',headers:{'Content-Type':'application/json','X-Dustoff-Token':token,Origin:new URL(url).origin},body:JSON.stringify(body)});
    writeFileSync(join(DUST_HOME,'.lock.pipeline'),String(process.pid));
    const r=await post('purpose',{id:'BV1test00001',purpose:'video',quality:'64'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{deferred:true});
    assert.equal((await post('quality',{id:'BV1test00001',quality:'99'})).status,400);
    const item=await(await fetch(url+'/api/item?id=BV1test00001')).json();
    assert.equal(item.status,'review');assert.deepEqual(item.pending_intents.map(i=>i.action),['quality','purpose']);
    rmSync(join(DUST_HOME,'.lock.pipeline'));
    await fetch(url+'/api/overview');
    for(let n=0;n<100&&app.execution().running;n++)await new Promise(r=>setTimeout(r,50));
    const after=await(await fetch(url+'/api/item?id=BV1test00001')).json();
    assert.equal(after.processing_mode,'video');assert.equal(after.status,'pending');assert.equal(after.video_quality,64);assert.equal(after.pending_intents,null);
  }finally{app.server.close();}
  process.exitCode=0;
`));

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {platformOfId,sourceUrl} from '../scripts/platforms.mjs';
import {toItem,expandText,textChars,scanBookmarks,toId} from '../scripts/sources/x/bookmarks.mjs';
import {startAuthorization,challengeOf,accessToken,saveToken,readToken,SCOPES,LoginError} from '../scripts/sources/x/auth.mjs';
import {createClient,PlatformPause} from '../scripts/sources/x/client.mjs';
import {createConsole} from '../console.mjs';

const tempHome=()=>realpathSync(mkdtempSync(join(tmpdir(),'dustoff-x-')));
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const app={clientId:'fixture-client',clientSecret:'fixture-secret'};

// 虚构的书签数据：ID 只是长数字，不对应真实推文。
const tweet=(n,extra={})=>({id:String(1900000000000000000n+BigInt(n)),text:`虚构书签 ${n}`,author_id:'7',created_at:'2026-10-01T08:00:00.000Z',...extra});
const page=(tweets,next)=>({data:tweets,includes:{users:[{id:'7',name:'测试作者',username:'fixture_author'}]},meta:{result_count:tweets.length,...(next?{next_token:next}:{})}});
function fakeClient(all,{userId='42',pageCalls=[]}={}){
  return {pageCalls,me:async()=>({id:userId,username:'fixture_me',name:'我'}),bookmarks:async(uid,{max,cursor})=>{
    const start=Number(cursor||0),slice=all.slice(start,start+max);pageCalls.push({max,cursor:cursor||null});
    return page(slice,start+max<all.length?String(start+max):null);
  }};
}

test('X 推文 ID 加前缀 x，不与抖音的长数字 ID 混淆',()=>{
  assert.equal(platformOfId('x1851234567890123456'),'x');
  assert.equal(platformOfId('1851234567890123456'),'douyin');
  assert.equal(platformOfId('xabc'),null);
  assert.equal(sourceUrl({platform:'x',id:'x1851234567890123456'}),'https://x.com/i/status/1851234567890123456');
  assert.equal(toId('123'),'x123');
});

test('解析推文：长文取全文，短链换成原地址，媒体链接去掉，视频取最高码率，带上引用推文',()=>{
  const t={id:'100',author_id:'7',created_at:'2026-10-01T08:00:00.000Z',text:'截断的正文… https://t.co/aaa',
    note_tweet:{text:'完整的长文正文，介绍一个工具 https://t.co/link 看图 https://t.co/pic',entities:{urls:[
      {url:'https://t.co/link',expanded_url:'https://example.com/tool',display_url:'example.com/tool'},
      {url:'https://t.co/pic',expanded_url:'https://x.com/a/status/100/video/1',display_url:'pic.x.com/abc'}]}},
    attachments:{media_keys:['m1','m2']},referenced_tweets:[{type:'quoted',id:'200'}]};
  const includes={users:[{id:'7',name:'测试作者',username:'fixture_author'},{id:'8',name:'被引用者',username:'quoted_one'}],
    media:[{media_key:'m1',type:'video',duration_ms:95000,preview_image_url:'https://pbs.twimg.com/p.jpg',variants:[
      {content_type:'application/x-mpegURL',url:'https://video.twimg.com/a.m3u8'},
      {content_type:'video/mp4',bit_rate:832000,url:'https://video.twimg.com/low.mp4'},
      {content_type:'video/mp4',bit_rate:2176000,url:'https://video.twimg.com/high.mp4'}]},
      {media_key:'m2',type:'photo',url:'https://pbs.twimg.com/media/b.jpg',width:1200,height:800}],
    tweets:[{id:'200',author_id:'8',text:'被引用的观点 https://t.co/q',entities:{urls:[{url:'https://t.co/q',expanded_url:'https://example.org/q',display_url:'example.org/q'}]}}]};
  const it=toItem(t,includes,1);
  assert.equal(it.aweme_id,'x100');assert.equal(it.platform,'x');assert.equal(it.media_type,'video');assert.equal(it.long_post,true);
  assert.equal(it.desc,'完整的长文正文，介绍一个工具 https://example.com/tool 看图');
  assert.deepEqual(it.links,[{url:'https://example.com/tool',title:null}]);
  assert.equal(it.media[0].url,'https://video.twimg.com/high.mp4');assert.equal(it.media[0].duration_s,95);assert.equal(it.duration_s,95);
  assert.equal(it.media[1].type,'photo');
  assert.deepEqual(it.quoted,{id:'200',author:'被引用者',username:'quoted_one',text:'被引用的观点 https://example.org/q',links:[{url:'https://example.org/q',title:null}]});
  assert.equal(it.author,'测试作者');assert.equal(it.username,'fixture_author');assert.equal(it.create_time,Date.parse('2026-10-01T08:00:00Z')/1000);
  const plain=toItem({id:'101',author_id:'7',text:'只有图 https://t.co/p',entities:{urls:[{url:'https://t.co/p',expanded_url:'https://x.com/a/status/101/photo/1',display_url:'pic.x.com/p'}]},attachments:{media_keys:['m2']}},includes);
  assert.equal(plain.media_type,'post');assert.equal(plain.desc,'只有图');assert.equal(plain.duration_s,null);
  assert.equal(textChars('中文 abc https://example.com/x 。'),6);
  // X 长文：推文本身只有长文链接，正文与标题来自 article 字段，链接不重复记录。
  const art=toItem({id:'102',author_id:'7',text:'https://t.co/art',entities:{urls:[{url:'https://t.co/art',expanded_url:'https://x.com/i/article/555',display_url:'x.com/i/article/555'}]},
    article:{title:'虚构长文标题',plain_text:'第一段内容。\n\n第二段内容。',preview_text:'第一段'}},includes);
  assert.equal(art.is_article,true);assert.equal(art.desc,'虚构长文标题');assert.equal(art.text,'第一段内容。\n\n第二段内容。');
  assert.equal(art.chars,12);assert.deepEqual(art.links,[]);assert.equal(art.media_type,'post');
  assert.equal(expandText('a https://t.co/x',[{url:'https://t.co/x',unwound_url:'https://final.example/',expanded_url:'https://bit.ly/1'}]),'a https://final.example/');
});

test('首次扫描读完全部书签；之后只读顶部，遇到已入账的就停',async()=>{
  const all=Array.from({length:230},(_,i)=>tweet(230-i));
  const first=fakeClient(all);
  const r=await scanBookmarks({client:first,state:null});
  assert.equal(r.full,true);assert.equal(r.items.length,230);assert.equal(r.total,230);
  assert.deepEqual(first.pageCalls.map(c=>c.max),[100,100,100]);
  assert.equal(r.nextState.complete,true);assert.equal(r.nextState.user_id,'42');
  // 新增 3 条在顶部；第一页就衔接上旧书签。
  const known=new Set(r.items.map(i=>i.aweme_id)),grown=[tweet(233),tweet(232),tweet(231),...all],next=fakeClient(grown);
  const r2=await scanBookmarks({client:next,state:r.nextState,known:id=>known.has(id),pageSize:20});
  assert.deepEqual(r2.items.map(i=>i.tweet_id),[tweet(233).id,tweet(232).id,tweet(231).id]);
  assert.equal(next.pageCalls.length,1);assert.equal(r2.full,false);assert.equal(r2.nextState.complete,true);
});

test('新书签超过页数上限时下轮改为完整读取；换了授权账号时停止',async()=>{
  const all=Array.from({length:60},(_,i)=>tweet(60-i));
  const r=await scanBookmarks({client:fakeClient(all),state:{complete:true,user_id:'42'},known:()=>false,pageSize:20,maxPages:2});
  assert.equal(r.items.length,40);assert.equal(r.nextState.complete,false);assert.match(r.warnings[0],/下轮重新完整读取/);
  await assert.rejects(scanBookmarks({client:fakeClient(all,{userId:'99'}),state:{complete:true,user_id:'42'}}),/账号不同/);
});

test('授权链接只申请只读权限并使用 S256 PKCE',()=>{
  const a=startAuthorization({clientId:'fixture-client',redirectUri:'http://127.0.0.1:47832/x/callback'}),u=new URL(a.url);
  assert.equal(u.origin+u.pathname,'https://x.com/i/oauth2/authorize');
  assert.equal(u.searchParams.get('scope'),SCOPES.join(' '));assert.ok(!SCOPES.some(s=>/write/.test(s)));
  assert.equal(u.searchParams.get('code_challenge'),challengeOf(a.verifier));assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.equal(u.searchParams.get('state'),a.state);assert.equal(u.searchParams.get('redirect_uri'),'http://127.0.0.1:47832/x/callback');
  assert.throws(()=>startAuthorization({clientId:'',redirectUri:'x'}),/DUST_X_CLIENT_ID/);
});

test('令牌到期前自动续期并立即保存新的一次性刷新令牌；401 只重试一次',async()=>{
  const home=tempHome();
  try{
    saveToken({access_token:'old',refresh_token:'r1',expires_at:100},home);
    const calls=[];
    const fetchImpl=async(url,opts)=>{
      calls.push({url,opts});
      if(url.endsWith('/oauth2/token')){const body=new URLSearchParams(opts.body);return json(200,{access_token:`new-${body.get('refresh_token')}`,refresh_token:`${body.get('refresh_token')}-next`,expires_in:7200});}
      return json(401,{title:'Unauthorized'});
    };
    assert.equal(await accessToken({home,app,fetchImpl,now:()=>1000}),'new-r1');
    const saved=readToken(home);assert.equal(saved.refresh_token,'r1-next');assert.ok(saved.expires_at>1000);
    assert.match(calls[0].opts.headers.Authorization,/^Basic /);assert.equal(new URLSearchParams(calls[0].opts.body).get('grant_type'),'refresh_token');
    const client=createClient({home,app,fetchImpl,interval:0});
    await assert.rejects(client.me(),LoginError);
    const apiCalls=calls.filter(c=>c.url.includes('/users/me'));assert.equal(apiCalls.length,2);
    assert.equal(readToken(home).refresh_token,'r1-next-next');
    const limited=createClient({home,app,interval:0,fetchImpl:async url=>url.endsWith('/oauth2/token')?json(200,{access_token:'a',expires_in:7200}):json(429,{})});
    await assert.rejects(limited.me(),PlatformPause);
    const broke=createClient({home,app,interval:0,fetchImpl:async()=>json(402,{title:'CreditsDepleted',detail:'Your enrolled account does not have any credits'})});
    await assert.rejects(broke.me(),e=>e instanceof PlatformPause&&/额度/.test(e.message));
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('控制台：连接 X 生成一次性授权；回调核对 state 后保存令牌，不回传令牌',async()=>{
  const home=tempHome();
  writeFileSync(join(home,'dustoff.conf'),'DUST_X_CLIENT_ID=fixture-client\nDUST_X_CLIENT_SECRET=fixture-secret\n');
  const xFetch=async(url,opts)=>{
    if(url.endsWith('/oauth2/token')){const b=new URLSearchParams(opts.body);assert.equal(b.get('code'),'fixture-code');assert.ok(b.get('code_verifier'));return json(200,{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:7200});}
    if(url.includes('/users/me'))return json(200,{data:{id:'42',username:'fixture_me',name:'我'}});
    throw new Error('未模拟 '+url);
  };
  const scheduler={status:()=>({loaded:false}),start(){},stop(){},update(){}};
  const c=createConsole({home,scheduler,xFetch});const url=await c.listen(0);
  try{
    const html=await (await fetch(url)).text(),token=html.match(/name="dustoff-token" content="([^"]+)"/)[1];
    const post=(path,data)=>fetch(url+'/api/'+path,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Dustoff-Token':token},body:JSON.stringify(data)});
    const bad=await fetch(url+'/x/callback?state=forged&code=fixture-code',{redirect:'manual',headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(bad.status,400);assert.equal(existsSync(join(home,'x','token.json')),false);
    const r=await (await post('x-authorize',{})).json(),auth=new URL(r.url);
    assert.equal(auth.searchParams.get('redirect_uri'),url+'/x/callback');
    const cb=await fetch(`${url}/x/callback?state=${auth.searchParams.get('state')}&code=fixture-code`,{redirect:'manual',headers:{'Sec-Fetch-Site':'cross-site'}});
    assert.equal(cb.status,200);const done=await cb.text();assert.match(done,/http-equiv="refresh" content="1;url=\/#account"/);assert.match(done,/@fixture_me/);
    assert.equal(readToken(home).refresh_token,'fixture-refresh');
    const again=await fetch(`${url}/x/callback?state=${auth.searchParams.get('state')}&code=fixture-code`,{redirect:'manual'});
    assert.equal(again.status,400,'state 只能用一次');
    const session=await (await fetch(url+'/api/session')).json();
    assert.equal(session.x.connected,true);assert.equal(session.x.username,'fixture_me');assert.equal(session.x.configured,true);
    assert.equal(JSON.stringify(session).includes('fixture-access'),false);assert.equal(JSON.stringify(session).includes('fixture-refresh'),false);
    assert.ok(JSON.parse(readFileSync(join(home,'state','x-session.json'),'utf8')).online_checked_at);
  }finally{await new Promise(r=>c.server.close(r));rmSync(home,{recursive:true,force:true});}
});

function isolated(source,env={}) {
  const home=tempHome();
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{
      cwd:new URL('..',import.meta.url),env:{...process.env,DUST_HOME:home,DUST_NOTIFY:'0',DUST_DASHSCOPE_KEY:'',DUST_ASR_KEY:'',DUST_LLM_KEY:'',DUST_ROUTER_KEY:'',DUST_BILI_ENABLED:'0',DUST_X_ENABLED:'1',DUST_X_INTERVAL_MS:'0',...env},encoding:'utf8',timeout:60000,
    });
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  } finally {rmSync(home,{recursive:true,force:true});}
}

test('日常一轮：首次读入全部书签；长帖出笔记附原帖，短帖只存原帖，视频由模型判断；第二轮只收新增',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
  import {DUST_HOME} from './scripts/config.mjs';
  import {db} from './scripts/ledger.mjs';
  import {platformState,usage,baseline,setPurpose} from './scripts/daily.mjs';
  import {SAVED_MEDIA,MEDIA} from './scripts/policy.mjs';
  import {saveToken} from './scripts/sources/x/auth.mjs';
  import {writeNote} from './notes.mjs';
  import {main} from './run.mjs';
  db().exec("CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db().prepare("INSERT INTO daily_state VALUES('baseline',?)").run(JSON.stringify({created_at:1,scanned_at:1,anchors:[]}));
  saveToken({access_token:'fixture',refresh_token:'r',expires_at:4102444800});
  const user={id:'7',name:'测试作者',username:'fixture_author'};
  const video=(id,text)=>({id,author_id:'7',created_at:'2026-10-01T08:00:00.000Z',text,attachments:{media_keys:['v'+id]}});
  let tweets=[
    {id:'1001',author_id:'7',created_at:'2026-10-01T08:00:00.000Z',text:'虚构长帖',note_tweet:{text:'虚构长帖开头。'+'要点'.repeat(150)}},
    {id:'1002',author_id:'7',created_at:'2026-10-02T08:00:00.000Z',text:'短帖配图 https://t.co/p',entities:{urls:[{url:'https://t.co/p',expanded_url:'https://x.com/a/status/1002/photo/1',display_url:'pic.x.com/p'}]},attachments:{media_keys:['p1002']}},
    video('1003','演示视频'),video('1004','讲解视频'),video('1005','看不出来'),
  ];
  const media=[{media_key:'p1002',type:'photo',url:'https://pbs.twimg.com/media/fixture.jpg'},...['1003','1004','1005'].map(id=>({media_key:'v'+id,type:'video',duration_ms:60000,variants:[{content_type:'video/mp4',bit_rate:1,url:'https://video.twimg.com/'+id+'.mp4'}]}))];
  const calls=[];
  const client={me:async()=>({id:'42',username:'fixture_me',name:'我'}),bookmarks:async(uid,{max,cursor})=>{calls.push(max);const s=Number(cursor||0),slice=tweets.slice(s,s+max);return {data:slice,includes:{users:[user],media},meta:{next_token:s+max<tweets.length?String(s+max):undefined}};}};
  const asked=[],contexts=[];
  const routes={x1003:'video',x1004:'note',x1005:'review'};
  const deps={notesDir:join(DUST_HOME,'notes-out'),textDir:join(DUST_HOME,'text'),writeNote,asrKey:'k',llm:{key:'k'},
    ask:async item=>{asked.push(item.aweme_id);if(item.aweme_id==='x1007')throw Object.assign(new Error('笔记模型 HTTP 400 敏感内容'),{permanent:true,refused:true});return {够写:true,缺料说明:'',标题:'虚构长帖笔记',分类:'测试',时效:'slow',标签:['虚构'],引流说明:'',正文:'# 核心观点\\n虚构要点'};},
    photos:async item=>item.aweme_id==='x1002'?[{index:0,file:'001.jpg',path:join(SAVED_MEDIA,'x1002','images','001.jpg'),url:'https://pbs.twimg.com/media/fixture.jpg?name=orig',bytes:1}]:[],
    classify:async item=>({purpose:routes[item.aweme_id],reason:'测试',model:'fake'}),
    video:async(item,{purpose})=>{const root=purpose==='note'?MEDIA:SAVED_MEDIA,dir=join(root,item.aweme_id);mkdirSync(dir,{recursive:true});const path=join(dir,'video.mp4');writeFileSync(path,'v');return {aweme_id:item.aweme_id,status:'done',path,bytes:1,has_audio:true,quality:purpose==='note'?'low':'high'};},
    transcribe:async row=>{const textPath=join(DUST_HOME,'text',row.id+'.txt');mkdirSync(join(DUST_HOME,'text'),{recursive:true});writeFileSync(textPath,'转写内容。');return {chars:5,textPath,seconds:60};},
    note:async row=>{contexts.push(row.extra_context);return {note:{转写排版:{paragraph_starts:[]},够写:true,缺料说明:'',标题:'视频笔记',分类:'测试',时效:'none',标签:[],引流说明:'',正文:'正文'},missingContent:false};}};
  const runScript=async()=>({ok:true,logged_in:true,items:[],truncated:false,fetched_at:1});
  const r=await main(['--limit','10'],{runScript,x:{client,deps}});
  assert.deepEqual(r.failures,[]);assert.equal(r.x.added,5);assert.equal(r.x.total,5);assert.deepEqual(calls,[100]);
  const rows=Object.fromEntries(db().prepare("SELECT * FROM items WHERE platform='x'").all().map(r=>[r.id,r]));
  assert.equal(rows.x1001.media_type,'post');assert.equal(rows.x1001.status,'extracted');assert.equal(rows.x1001.text_source,'post');assert.ok(rows.x1001.prompt_hash);
  const long=readFileSync(rows.x1001.note_path,'utf8');
  assert.match(long,/^来源: X$/m);assert.match(long,/^类型: "笔记"$/m);assert.match(long,/链接: "https:\\/\\/x.com\\/i\\/status\\/1001"/);assert.match(long,/## 原帖\\n\\n虚构长帖开头。/);assert.match(long,/虚构要点/);
  assert.equal(rows.x1002.status,'extracted');assert.equal(rows.x1002.prompt_hash,null);assert.equal(rows.x1002.category,null);
  const short=readFileSync(rows.x1002.note_path,'utf8');
  assert.match(short,/^类型: "原帖存档"$/m);assert.match(short,/---\\n短帖配图\\n/);assert.doesNotMatch(short,/^# /m);assert.match(short,/\\[图 1\\]\\(https:\\/\\/pbs.twimg.com\\/media\\/fixture.jpg\\?name=orig\\)/);
  assert.deepEqual(asked,['x1001']);
  assert.equal(rows.x1003.status,'saved');assert.equal(rows.x1003.processing_mode,'video');
  assert.equal(rows.x1004.status,'extracted');assert.equal(rows.x1004.text_source,'asr');assert.match(contexts[0],/推文正文：讲解视频/);
  assert.equal(rows.x1005.status,'review');
  assert.equal(usage(undefined,'x'),5);assert.deepEqual(baseline().anchors,[]);assert.equal(platformState('x').complete,true);
  assert.throws(()=>setPurpose('x1002','video'),/不在可修改用途/);
  // 第二轮：顶部新增 1 条，读一页 20 条就衔接上旧书签。
  // 第二轮：顶部新增 2 条；其中长帖被笔记模型的内容审核拒绝，退回只存原帖。
  tweets=[{id:'1007',author_id:'7',created_at:'2026-10-06T08:00:00.000Z',text:'敏感长帖',note_tweet:{text:'敏感话题。'+'内容'.repeat(150)}},{id:'1006',author_id:'7',created_at:'2026-10-05T08:00:00.000Z',text:'新的短帖'},...tweets];calls.length=0;
  const second=await main(['--limit','10'],{runScript,x:{client,deps}});
  assert.equal(second.x.added,2);assert.deepEqual(calls,[20]);assert.deepEqual(second.failures,[]);
  const refused=db().prepare("SELECT * FROM items WHERE platform='x' AND id='x1007'").get();
  assert.equal(refused.status,'extracted');assert.equal(refused.prompt_hash,null);assert.match(readFileSync(refused.note_path,'utf8'),/内容审核拒绝/);
  assert.equal(db().prepare("SELECT status FROM items WHERE platform='x' AND id='x1006'").get().status,'extracted');
  process.exitCode=0;
`));

test('X 未连接只作扫描警告，其他平台照常',()=>isolated(`
  import assert from 'node:assert/strict';
  import {db} from './scripts/ledger.mjs';
  import {main} from './run.mjs';
  db().exec("CREATE TABLE IF NOT EXISTS daily_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db().prepare("INSERT INTO daily_state VALUES('baseline',?)").run(JSON.stringify({created_at:1,scanned_at:1,anchors:[]}));
  const runScript=async()=>({ok:true,logged_in:true,items:[],truncated:false,fetched_at:1});
  const client={me:async()=>{throw new Error('不应调用');}};
  const r=await main(['--limit','5'],{runScript,x:{client}});
  assert.match(r.scanWarning,/^X：尚未连接 X/);assert.deepEqual(r.failures,[]);assert.equal(r.paused,null);
  process.exitCode=0;
`));

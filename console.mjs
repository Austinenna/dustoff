#!/usr/bin/env node
// 本机控制台：只监听 loopback，浏览器与 CLI 共用现有流水线。
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { DUST_HOME } from './scripts/config.mjs';
import { createStore, liveLock, HttpError } from './scripts/console-store.mjs';
import { createLibrary } from './scripts/library-store.mjs';
import { createKnowledge } from './scripts/knowledge-store.mjs';
import { createScheduler } from './scripts/schedule.mjs';
import { localPath, atomicWrite } from './scripts/policy.mjs';
import { createMediaService, streamMedia } from './scripts/console-media.mjs';
import { validateLoginInput } from './scripts/remote-login.mjs';
import { createConsoleAccess } from './scripts/console-auth.mjs';
import { sourceUrl } from './scripts/platforms.mjs';
import { addIntent, listIntents } from './scripts/intent-store.mjs';
import { CALLBACK_PATH, appConfig, exchangeCode, recordSession as recordXSession, saveToken, startAuthorization } from './scripts/sources/x/auth.mjs';
import { createClient as createXClient } from './scripts/sources/x/client.mjs';
import { costSummary, gatewayConfig, itemCost } from './scripts/gateway.mjs';
import { demoHome, readBuildStatus, readDemoInfo } from './scripts/make-demo.mjs';
const QUALITY_VALUES=['','64','80','116','120','0'];
const ROOT=dirname(fileURLToPath(import.meta.url));
// 登录类任务：抖音沿用原名，B 站加前缀；B 站任务在 console-session.mjs 中按平台参数分派。
const LOGIN_KINDS=['login','session-check','login-window','bili-login','bili-session-check'],WINDOW_KINDS=['login','login-window','bili-login'];
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?Number(v):v);
// guest：演示站。数据目录是 make-demo.mjs 生成的演示数据，不要密码，只能看；不启动定时，不执行任何任务。
export function createConsole({home=DUST_HOME,scheduler,root=ROOT,spawnProcess=spawn,xFetch=fetch,gatewayFetch=fetch,publicUrl=process.env.DUST_PUBLIC_URL||'',serverMode=process.env.DUST_SERVER_MODE==='1',guest=process.env.DUST_GUEST==='1',openFile=(args)=>new Promise((resolve,reject)=>execFile('/usr/bin/open',args,{timeout:10000},(err)=>err?reject(err):resolve()))}={}) {
  const external=publicUrl?new URL(publicUrl):null;
  if(external&&(external.protocol!=='https:'||external.username||external.password||external.search||external.hash||!/^\/[a-zA-Z0-9/_-]*$/.test(external.pathname)))throw new Error('公网地址必须为不含凭据、查询参数的 HTTPS 地址');
  const basePath=external?external.pathname.replace(/\/+$/,''):'';
  const access=createConsoleAccess({home,enabled:!!external&&!guest});
  // 演示站的「现在」固定在演示数据生成的那一刻；demo.json 变了说明数据换过，重新读取。
  let demoInfo=null,demoKey=null;
  const clock=()=>guest&&demoInfo?.snapshot_at?demoInfo.snapshot_at:Date.now();
  const store=createStore(home,{now:clock});
  const library=createLibrary(home);
  // 知识库索引由 knowledge.mjs 生成；还没跑过时文件不存在，这里不替它新建。
  const knowledge=createKnowledge(home);
  // pageReads：用户看过哪些综述页、看的是哪一版；键是「大类｜主题名」。
  const pageKey=t=>`${t.domain}｜${t.name}`;
  const knowledgeState=()=>existsSync(knowledge.file)?{ready:true,...knowledge.catalog(),pageReads:library.pageReads()}:{ready:false};
  // 全文搜索：索引由 knowledge.mjs 维护，没建时返回 ready:false，浏览器退回按标题筛选。
  const knowledgeSearch=(q,limit)=>existsSync(knowledge.file)?knowledge.search(String(q||'').slice(0,200),{limit:Math.min(Math.max(Number(limit)||30,1),300)}):{ready:false};
  const knowledgePage=id=>{const page=existsSync(knowledge.file)&&knowledge.page(id);if(!page)throw new HttpError(404,'这个主题还没有综述页');return page;};
  const media=createMediaService({store,home});
  scheduler ||= guest?{status:()=>({loaded:false,time:null,intervalHours:null,nextRun:null})}:createScheduler({home,root});
  function freshen(){
    let text=null;try{text=readFileSync(join(home,'demo.json'),'utf8');}catch{}
    if(text===demoKey)return;
    demoKey=text;try{demoInfo=text&&JSON.parse(text);}catch{demoInfo=null;}
    knowledge.close();library.close();   // 数据目录整个换过，旧的连接还指着旧文件
  }
  // 演示站：生产控制台里选进演示站的作品，以及上次更新的结果。
  function demoState(){
    let target=null,error=null;try{target=demoHome(home,store.cfg());}catch(e){error=e.message;}
    return {configured:!!target,error,url:store.cfg()('DUST_DEMO_URL',''),picks:library.demoPicks(),queued:library.demoQueued(),status:readBuildStatus(home),info:target?readDemoInfo(target):null};
  }
  const token=randomBytes(32).toString('hex');
  let active=null,lastAction=null,origin,auth=null,scheduleStartupWarning=null;
  const actionsDir=localPath(join(home,'console'));
  let nextBrowserRequest=0;
  // 费用来自 AI 网关；一分钟内重复打开页面不再请求网关。
  let costCache=null;
  async function costs(){if(!costCache||Date.now()-costCache.at>60000){const value=costSummary({config:gatewayConfig(store.cfg()),fetchImpl:gatewayFetch});costCache={at:Date.now(),value};value.catch(()=>{if(costCache?.value===value)costCache=null;});}return costCache.value;}
  // X 授权：state 与 PKCE verifier 只留在本进程内存，10 分钟内单次有效。
  const xPending=new Map();
  const xApp=()=>appConfig(store.cfg());
  function xAuthorize(){
    if(state().running)throw new HttpError(409,'已有任务正在运行，请等本轮结束后再连接 X');
    for(const [k,v] of xPending)if(v.expires<Date.now())xPending.delete(k);
    let auth;try{auth=startAuthorization({clientId:xApp().clientId,redirectUri:origin+basePath+CALLBACK_PATH});}catch(e){throw new HttpError(400,e.message);}
    xPending.clear();xPending.set(auth.state,{verifier:auth.verifier,redirectUri:auth.redirectUri,expires:Date.now()+600000});
    return {url:auth.url};
  }
  // X 授权回调来自 x.com 的跳转，控制台的登录 Cookie（SameSite=Strict）不会带上；
  // 只凭控制台内生成的一次性 state 认可这次回调。
  async function xCallback(url,res,send){
    // 从 x.com 跳转而来的整条重定向链都算跨站，不能直接 303 回控制台；改由本页自行跳转。
    const page=(code,title,text,refresh=false)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">${refresh?`<meta http-equiv="refresh" content="1;url=${basePath}/#account">`:''}<title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p><p><a href="${basePath}/#account">返回控制台</a></p>`);};
    const key=url.searchParams.get('state')||'',pending=xPending.get(key);
    if(!pending||pending.expires<Date.now()){page(400,'连接 X 未完成','这次授权已过期或不是从本控制台发起的，请回到控制台重新点击「连接 X」。');return;}
    xPending.delete(key);
    if(url.searchParams.get('error')){page(400,'连接 X 已取消','你在 X 页面没有同意授权。需要时可回到控制台重新连接。');return;}
    const code=url.searchParams.get('code');
    if(!code||code.length>2000){page(400,'连接 X 未完成','X 没有返回授权码，请重试。');return;}
    if(state().running){page(409,'连接 X 未完成','控制台正在运行任务，请等本轮结束后重新连接。');return;}
    try{
      saveToken(await exchangeCode({code,verifier:pending.verifier,redirectUri:pending.redirectUri,app:xApp(),fetchImpl:xFetch}),home);
      const me=await createXClient({home,app:xApp(),fetchImpl:xFetch,interval:0}).me();
      recordXSession({logged_in:true,online:'verified',online_checked_at:Math.floor(Date.now()/1000),username:me.username,user_id:me.id},home);
      page(200,'已连接 X',`已授权账号 @${String(me.username).replace(/[^\w]/g,'')}，正在返回控制台…`,true);
    }catch(e){page(502,'连接 X 未完成',store.redact(String(e.message||'授权失败')).replace(/[<>&"]/g,''));}
  }
  function browserRequest(input) {
    const operation=active;
    if(!operation||operation.cancelling||!WINDOW_KINDS.includes(operation.kind)||!auth?.remote||auth.phase!=='window')throw new HttpError(409,'当前没有可操作的登录页面');
    operation.requests ||= new Map();
    if(operation.requests.size>=4)throw new HttpError(429,'操作正在处理中，请稍后重试');
    return new Promise((resolve,reject)=>{
      const requestId=++nextBrowserRequest,timer=setTimeout(()=>{operation.requests.delete(requestId);reject(new HttpError(504,'登录页面响应超时'));},12000);
      operation.requests.set(requestId,{resolve,reject,timer});
      operation.child.send({type:'browser-request',requestId,input},error=>{if(error){clearTimeout(timer);operation.requests.delete(requestId);reject(new HttpError(409,'登录任务已结束'));}});
    });
  }
  // 用途与画质的校验：立即执行和“运行中先记下”共用。
  function validateChoice(kind,body){
    const i=store.item(body.id);
    if(kind==='purpose'){if(!i.can_change_purpose)throw new HttpError(400,'这条作品不在可修改用途的处理范围内');if(!['note','video','review'].includes(body.purpose))throw new HttpError(400,'用途无效');}
    if(kind==='quality'||body.quality!==undefined){
      if(i.platform!=='bilibili')throw new HttpError(400,'只有 B站视频可以选择画质');
      if(!QUALITY_VALUES.includes(String(body.quality??'')))throw new HttpError(400,'画质选项无效');
    }
    return i;
  }
  // 运行中不能取锁：用途、画质、放弃先记下，本轮结束或控制台空闲时执行。
  function defer(kind,body){
    if(kind==='discard'){const i=store.item(body.id);if(!i.can_discard&&i.skip_reason!=='user_discarded')throw new HttpError(400,'只能放弃当前范围内尚未完成的处理任务');addIntent({id:body.id,action:'discard'},home);return {deferred:true};}
    validateChoice(kind,body);
    if(body.quality!==undefined||kind==='quality')addIntent({id:body.id,action:'quality',value:String(body.quality??'')},home);
    if(kind==='purpose')addIntent({id:body.id,action:'purpose',value:body.purpose},home);
    return {deferred:true};
  }
  function state(){const lock=liveLock(home);return {running:!!active||lock.running,pid:active?.pid||lock.pid||null,owned:!!active,kind:active?.kind||null,startedAt:active?.startedAt||null,lastAction};}
  function scheduleState(){try{const current=scheduler.status();return {...current,error:null,warning:current.loaded?null:scheduleStartupWarning};}catch(e){return {error:e.message,loaded:null,time:null,intervalHours:null,nextRun:null};}}
  function start(kind,body={}) {
    if(state().running)throw new HttpError(409,'已有任务正在运行，请等本轮结束');
    let script,args;
    if(kind==='run') {
      const n=Number(body.limit??store.policy().daily);
      if(!Number.isInteger(n)||n<1||n>store.policy().daily)throw new HttpError(400,`本轮处理数量须为 1–${store.policy().daily}`);
      if(body.noScan!==undefined&&typeof body.noScan!=='boolean')throw new HttpError(400,'只继续待办选项无效');
      script=join(root,'run.mjs');args=['--limit',String(n),...(body.noScan?['--no-scan']:[])];
    } else if(kind==='demo-build'){
      const d=demoState();
      if(!d.configured)throw new HttpError(400,d.error||'还没有设置演示数据目录（DUST_DEMO_HOME）');
      if(!d.picks.length)throw new HttpError(400,'还没有选进演示站的作品');
      script=join(root,'scripts','make-demo.mjs');args=[];
    } else if(LOGIN_KINDS.includes(kind)){
      const bili=kind.startsWith('bili-');
      script=join(root,'scripts','console-session.mjs');args=[kind.endsWith('session-check')?'check':kind==='login-window'?'window':'login',...(bili?['bilibili']:[])];
      auth={phase:'starting',platform:bili?'bilibili':'douyin',message:kind.endsWith('session-check')?'正在检查登录状态…':'正在打开 Chrome 官方登录页…'};
    } else {
      if(kind==='retry'){const i=store.item(body.id);if(i.status!=='failed')throw new HttpError(400,'只能重试已失败作品');}
      if(kind==='purpose'||kind==='quality')validateChoice(kind,body);
      if(kind==='video-delete'){if(store.item(body.id).media_type==='gallery')throw new HttpError(400,'此操作只支持视频');}
      if(kind==='video-to-note'){const i=store.item(body.id);if(!i.can_convert_to_note&&!(i.delete_after_note&&i.processing_mode==='note'&&!i.media_deleted))throw new HttpError(400,'这条作品不支持从本地视频转为笔记');}
      if(kind==='discard'){const i=store.item(body.id);if(!i.can_discard&&i.skip_reason!=='user_discarded')throw new HttpError(400,'只能放弃当前范围内尚未完成的处理任务');}
      if(kind==='delete-item'){const i=store.item(body.id);if(!i.can_delete&&i.skip_reason!=='user_deleted')throw new HttpError(400,'只能删除当前范围内没有本地产物的待确认或已放弃记录');}
      script=join(root,'scripts','console-action.mjs');args=[kind,...(['retry','purpose','video-delete','video-to-note','discard','delete-item','quality'].includes(kind)?[body.id]:[]),...(kind==='purpose'?[body.purpose,...(body.quality!==undefined?[String(body.quality)]:[])]:[]),...(kind==='quality'?[String(body.quality??'')]:[])];
    }
    mkdirSync(actionsDir,{recursive:true,mode:0o700});
    const logfile=join(actionsDir,'latest-action.log');let fd=openSync(logfile,'w',0o600),written=0;
    const log=data=>{if(fd===null)return;let bytes=Buffer.from(data);if(bytes.length>1024**2)bytes=bytes.subarray(-(1024**2));if(written+bytes.length>1024**2){closeSync(fd);fd=openSync(logfile,'w',0o600);written=0;}let i=0;while(i<bytes.length)i+=writeSync(fd,bytes,i,bytes.length-i);written+=bytes.length;};
    let child;
    try {child=spawnProcess(process.execPath,[script,...args],{cwd:root,env:{...process.env,DUST_HOME:home},detached:true,stdio:['ignore','pipe','pipe','ipc']});}
    catch(e){closeSync(fd);throw e;}
    const operation={kind,pid:child.pid||null,startedAt:Date.now(),child};active=operation;
    log(`控制台启动 ${kind}\n`);
    child.on('message',m=>{
      if(m?.type==='browser-response') {
        const pending=operation.requests?.get(m.requestId);if(!pending)return;
        clearTimeout(pending.timer);operation.requests.delete(m.requestId);
        if(active!==operation||operation.cancelling||m.error)pending.reject(new HttpError(409,'登录页面暂不可用'));
        else pending.resolve(m.data);return;
      }
      if(active===operation&&m?.type==='action-error'){operation.error=String(m.message||'操作失败').slice(0,500);return;}
      if(active!==operation||m?.type!=='session'||operation.cancelling&&m.phase!=='cancelled'&&m.phase!=='error')return;
      const {phase,message,deadline}=m;
      if(!['starting','checking','checked','saving','success','timeout','window','cancelled','error'].includes(phase))return;
      auth={phase,platform:operation.kind.startsWith('bili-')?'bilibili':'douyin',message:String(message||'').slice(0,300),deadline,remote:m.remote===true};
    });
    child.stdout.on('data',log);child.stderr.on('data',log);
    child.once('close',()=>{for(const pending of operation.requests?.values()||[]){clearTimeout(pending.timer);pending.reject(new HttpError(409,'登录任务已结束'));}operation.requests?.clear();});
    child.once('error',e=>log(`启动失败：${e.message}\n`));
    child.once('close',(code,signal)=>{lastAction={kind,pid:operation.pid,startedAt:operation.startedAt,finishedAt:Date.now(),exitCode:code??1,signal};log(`结束：退出码 ${lastAction.exitCode}\n`);if(fd!==null){closeSync(fd);fd=null;}atomicWrite(join(actionsDir,'last-action.json'),encode(lastAction));if(active===operation){active=null;if(LOGIN_KINDS.includes(kind)){if(!['checked','success','cancelled','timeout','error'].includes(auth?.phase))auth={phase:'error',platform:auth?.platform,message:'登录任务已结束，请重新开始'};}}});
    return state();
  }
  // 素材附上作品摘要；作品已从账本删除时仍保留素材，标记为缺失。
  function enrich(list){
    const items=store.summaries(list.map(m=>m.item));
    return list.map(m=>({...m,source:items.get(m.item)||{id:m.item,missing:true,title:'作品已不在账本中'}}));
  }
  function libraryState(){
    const topics=library.topics(),materials=enrich(library.materials({limit:500}));
    return {topics,materials,unsorted:materials.filter(m=>m.topic_id===null).length};
  }
  function suggestions(id){
    const meta=store.itemMeta(id);if(!meta)return [];
    const cache=new Map(),metaOf=item=>{if(!cache.has(item))cache.set(item,store.itemMeta(item));return cache.get(item);};
    return library.suggest(meta,metaOf);
  }
  // ── 对外接口 /api/v1：只用 Bearer 令牌认证，只能访问素材箱；不读取控制台登录 Cookie。 ──
  const apiHits=new Map(),apiLog=join(actionsDir,'api-access.jsonl');
  function logApi(entry){
    try{mkdirSync(actionsDir,{recursive:true,mode:0o700});appendFileSync(apiLog,JSON.stringify({at:new Date().toISOString(),...entry})+'\n',{mode:0o600});
      if(statSync(apiLog).size>2*1024**2){const lines=readFileSync(apiLog,'utf8').split('\n').filter(Boolean);writeFileSync(apiLog,lines.slice(-5000).join('\n')+'\n',{mode:0o600});}}catch{} // 日志写不进去不影响接口
  }
  function materialDetail(id){
    const m=enrich([library.material(id)])[0],src=m.source;
    let content=null,media=[];
    if(!src.missing){
      if(src.has_note){try{content=store.document(m.item,'note').content;}catch{}}
      if(src.has_media){
        if(src.media_type==='gallery'){try{media=store.gallery(m.item).images.map((_,n)=>({index:n,type:'image',url:`materials/${m.id}/media/${n}`}));}catch{}}
        else media=[{index:0,type:'video',url:`materials/${m.id}/media/0`}];
      }
      try{src.source_url=sourceUrl(store.item(m.item));}catch{}
    }
    return {...m,content,media};
  }
  async function externalApi(req,res,path,url,send){
    const started=Date.now(),secret=String(req.headers.authorization||'').match(/^Bearer\s+(\S+)$/i)?.[1]||'';
    const who=library.verifyToken(secret);
    const done=(code,value,type)=>{logApi({token:who?.id??null,method:req.method,path,status:code,ms:Date.now()-started});send(code,value,type);};
    if(!who){done(401,{error:'缺少或无效的访问令牌'});return;}
    const window=Math.floor(Date.now()/60000),hit=apiHits.get(who.id);
    if(!hit||hit.window!==window)apiHits.set(who.id,{window,count:1});else if(++hit.count>120){done(429,{error:'请求过于频繁，每个令牌每分钟最多 120 次'});return;}
    const route=path.slice('/api/v1'.length),params=Object.fromEntries(url.searchParams);
    try{
      if(req.method==='GET'&&route==='/topics'){done(200,{topics:library.topics()});return;}
      if(req.method==='GET'&&route==='/materials'){
        const limit=Math.min(200,Math.max(1,Number(params.limit)||100)),list=library.materials({topic:params.topic,status:params.status,kind:params.kind,since:params.since,after:params.after,limit});
        const last=list.at(-1),incremental=params.since!==undefined&&params.since!=='';
        done(200,{materials:enrich(list),next:incremental&&list.length===limit&&last?{since:last.updated_at,after:last.id}:null});return;
      }
      let m=route.match(/^\/materials\/(\d+)$/);
      if(req.method==='GET'&&m){done(200,JSON.parse(store.redact(materialDetail(m[1]))));return;}
      m=route.match(/^\/materials\/(\d+)\/media\/(\d+)$/);
      if(['GET','HEAD'].includes(req.method)&&m){
        const item=library.material(m[1]).item,src=store.summaries([item]).get(item);
        if(!src?.has_media)throw new HttpError(404,'这条素材没有可下载的媒体');
        const file=src.media_type==='gallery'?store.galleryFile(item,m[2]):m[2]==='0'?media.video(item,false):null;
        if(!file)throw new HttpError(404,'媒体不存在');
        logApi({token:who.id,method:req.method,path,status:200,ms:Date.now()-started});
        await streamMedia(req,res,file,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return;
      }
      m=route.match(/^\/materials\/(\d+)\/usage$/);
      if(req.method==='POST'&&m){
        if(who.scope!=='write')throw new HttpError(403,'这个令牌只有只读权限');
        if(!String(req.headers['content-type']).startsWith('application/json'))throw new HttpError(415,'需要 JSON 请求');
        done(200,enrich([library.recordUsage(m[1],await body(req))])[0]);return;
      }
      throw new HttpError(404,'接口不存在');
    }catch(e){if(res.headersSent){res.destroy();return;}done(e.status||400,{error:store.redact(e.message||'请求失败')});}
  }
  // ── 演示站接口：只读，只放行看内容用到的接口；读者自己的已读、素材箱存在游客浏览器里。 ──
  const GUEST_EMPTY={'/api/suggest':{suggestions:[]}};
  function guestOverview(){
    const o=store.overview();
    return {...o,paths:null,storage:{savedUsed:o.storage.savedUsed},session:{},login:null,needsLogin:false,lock:{running:false},lastRun:null,
      bilibili:{...o.bilibili,session:{},folders:[]},x:{...o.x,configured:false,connected:false,username:null,online:null},
      execution:{running:false,owned:false,kind:null,startedAt:null,lastAction:null},scheduler:{loaded:false,error:null,warning:null},demo:demoInfo};
  }
  async function guestApi(req,res,path,url,send,headers){
    if(['GET','HEAD'].includes(req.method)&&path==='/api/video'){await streamMedia(req,res,media.video(url.searchParams.get('id'),url.searchParams.get('compatible')==='1'),headers);return;}
    if(['GET','HEAD'].includes(req.method)&&path==='/api/gallery-image'){await streamMedia(req,res,store.galleryFile(url.searchParams.get('id'),url.searchParams.get('index')??0),headers);return;}
    if(req.method==='GET'&&path==='/api/video-poster'){await streamMedia(req,res,await media.poster(url.searchParams.get('id')),headers);return;}
    const params=Object.fromEntries(url.searchParams);let result;
    if(req.method==='POST'){
      // 浏览器放不了的视频要转一份兼容副本，只写演示目录里的缓存。
      if(path!=='/api/video-prepare')throw new HttpError(403,'演示站只能看，不能改');
      const received=Buffer.from(String(req.headers['x-dustoff-token']||''));
      if(req.headers.origin!==origin||received.length!==token.length||!timingSafeEqual(received,Buffer.from(token)))throw new HttpError(403,'操作来源无效，请刷新页面');
      result=media.prepare((await body(req)).id);
    } else if(req.method!=='GET')throw new HttpError(405,'请求方式不支持');
    else if(GUEST_EMPTY[path])result=GUEST_EMPTY[path];
    else switch(path){
      case '/api/overview':result=guestOverview();break;
      // 演示数据里的素材箱样例，游客第一次打开时复制到自己的浏览器里。
      case '/api/library':result=existsSync(library.file)?{topics:library.topics(),materials:library.materials()}:{topics:[],materials:[]};break;
      case '/api/items':{const {demo,...rest}=params;result=store.listItems(rest);break;}
      case '/api/queue':result=store.pendingItems();break;
      case '/api/item':result=store.item(params.id);break;
      case '/api/gallery':result=store.gallery(params.id);break;
      case '/api/document':result=store.document(params.id,params.kind);break;
      case '/api/video-status':result=media.status(params.id);break;
      case '/api/insights':result=store.insights({id:params.id});break;
      case '/api/notes-index':result={items:store.notesIndex().items.map(i=>({...i,read_at:null}))};break;
      case '/api/knowledge':result=existsSync(knowledge.file)?{ready:true,...knowledge.catalog(),pageReads:{}}:{ready:false};break;
      case '/api/knowledge-page':result=knowledgePage(params.id);break;
      case '/api/search':result=knowledgeSearch(params.q,params.limit);break;
      // 游客在浏览器里收的素材，要靠这个补上作品标题和封面。
      case '/api/summaries':result={items:[...store.summaries(String(params.ids||'').split(',').slice(0,500)).values()]};break;
      default:throw new HttpError(404,'演示站没有这个接口');
    }
    // 服务器上的目录不给游客看。
    send(200,JSON.parse(store.redact(result).split(JSON.stringify(home).slice(1,-1)).join('')));
  }
  async function body(req){let size=0,parts=[];for await(const data of req){size+=data.length;if(size>32*1024)throw new HttpError(413,'请求内容过大');parts.push(data);}try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new HttpError(400,'请求不是有效 JSON');}}
  const server=createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
    const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(type.startsWith('application/json')?encode(value):value);};
    try {
      if(req.headers.host!==new URL(origin).host)throw new HttpError(403,'请使用配置的控制台地址');
      if(!guest){const u=new URL(req.url,origin);if(req.method==='GET'&&u.pathname===basePath+CALLBACK_PATH){await xCallback(u,res,send);return;}}
      if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'不接受跨站请求');
      const url=new URL(req.url,origin);let path=url.pathname;
      if(basePath){if(path===basePath){res.setHeader('Location',basePath+'/');send(308,'','text/plain');return;}if(!path.startsWith(basePath+'/'))throw new HttpError(404,'页面不存在');path=path.slice(basePath.length);}
      if(guest)freshen();
      if(path.startsWith('/api/v1/')){if(guest)throw new HttpError(404,'接口不存在');await externalApi(req,res,path,url,send);return;}
      if(await access.handle(req,res,path,{origin,basePath,send}))return;
      if(req.method==='GET'&&/^\/fonts\/[a-z0-9-]+\.woff2$/.test(path)){
        const file=join(root,'web',path.slice(1));if(!existsSync(file))throw new HttpError(404,'页面不存在');
        res.writeHead(200,{...headers,'Content-Type':'font/woff2','Cache-Control':'public, max-age=604800'});res.end(readFileSync(file));return;
      }
      if(req.method==='GET'&&['/','/studio.mjs','/studio.css','/studio-view.mjs','/guest.mjs','/schedule-plan.mjs','/markdown.mjs','/login-ui.mjs','/remote-login.mjs','/remote-login.css'].includes(path)) {
        const name=path==='/'?'studio.html':path.slice(1),types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
        let content=readFileSync(join(root,name==='schedule-plan.mjs'?'scripts':'web',name),'utf8');if(path==='/')content=content.replace('__CSRF_TOKEN__',token).replace('__SERVER_MODE__',serverMode?'1':'0').replace('__ACCESS_CONTROL__',external&&!guest?'1':'0').replace('__GUEST__',guest?'1':'0').replace('__NOW__',String(guest?clock():''));
        send(200,content,types[name.split('.').pop()]);return;
      }
      if(!path.startsWith('/api/'))throw new HttpError(404,'页面不存在');
      if(guest){await guestApi(req,res,path,url,send,headers);return;}
      if(req.method==='GET'&&path==='/api/login-frame'){
        const frame=await browserRequest({action:'frame'});send(200,Buffer.from(frame.image,'base64'),'image/jpeg');return;
      }
      if(['GET','HEAD'].includes(req.method)&&path==='/api/video'){
        const file=media.video(url.searchParams.get('id'),url.searchParams.get('compatible')==='1');
        await streamMedia(req,res,file,headers);return;
      }
      if(['GET','HEAD'].includes(req.method)&&path==='/api/gallery-image'){
        await streamMedia(req,res,store.galleryFile(url.searchParams.get('id'),url.searchParams.get('index')??0),headers);return;
      }
      if(req.method==='GET'&&path==='/api/video-poster'){
        await streamMedia(req,res,await media.poster(url.searchParams.get('id')),headers);return;
      }
      if(!['GET','POST'].includes(req.method))throw new HttpError(405,'请求方式不支持');
      let data={};
      if(req.method==='POST') {
        const received=Buffer.from(String(req.headers['x-dustoff-token']||''));
        if(req.headers.origin!==origin||received.length!==token.length||!timingSafeEqual(received,Buffer.from(token)))throw new HttpError(403,'操作来源无效，请刷新控制台');
        if(!String(req.headers['content-type']).startsWith('application/json'))throw new HttpError(415,'需要 JSON 请求');
        data=await body(req);
      }
      const params=Object.fromEntries(url.searchParams);
      let result;
      if(req.method==='GET')switch(path){
        case '/api/session':{const o=store.overview();result={session:o.session,bilibili:o.bilibili,x:o.x,auth,active:!!active&&LOGIN_KINDS.includes(active.kind),kind:active?.kind};break;}
        case '/api/health':result={app:'dustoff',home,root,pid:process.pid};break;
        case '/api/overview':{
          // 被中断的运行可能留下未执行的操作；空闲时由控制台补执行。
          if(!state().running&&listIntents(home).length)try{start('apply-intents');}catch{}
          result={...store.overview(),execution:state(),scheduler:scheduleState()};break;
        }
        case '/api/items':result=store.listItems(params.demo==='1'?{...params,ids:library.demoPicks()}:params);break;
        case '/api/gallery':result=store.gallery(params.id);break;
        case '/api/video-status':result=media.status(params.id);break;
        case '/api/queue':result=store.pendingItems();break;
        case '/api/item':result=store.item(params.id);break;
        case '/api/document':result=store.document(params.id,params.kind);break;
        case '/api/settings':result=store.settings();break;
        case '/api/notes-index':{const reads=library.readIds();result={items:store.notesIndex().items.map(i=>({...i,read_at:reads.get(i.id)||null}))};break;}
        case '/api/library':result=libraryState();break;
        case '/api/knowledge':result=knowledgeState();break;
        case '/api/knowledge-page':result=knowledgePage(params.id);break;
        case '/api/search':result=knowledgeSearch(params.q,params.limit);break;
        case '/api/suggest':result={suggestions:suggestions(params.id)};break;
        case '/api/insights':result=store.insights({id:params.id});break;
        case '/api/tokens':result={tokens:library.tokens()};break;
        case '/api/demo':result=demoState();break;
        case '/api/runs':result={runs:store.runs()};break;
        case '/api/costs':try{result=await costs();}catch(e){throw new HttpError(502,e.message);}break;
        case '/api/item-cost':try{result=await itemCost(params.id,{config:gatewayConfig(store.cfg()),fetchImpl:gatewayFetch});}catch(e){throw new HttpError(502,e.message);}break;
        case '/api/log':result=params.kind==='scheduler'?{log:store.tail(join(home,'scheduler','latest-run.log'))}:params.kind==='console'?{log:store.tail(join(home,'console','latest-action.log'))}:store.runDetail(params.id);break;
        default:throw new HttpError(404,'接口不存在');
      } else switch(path){
        case '/api/settings':result=store.saveSettings(data);break;
        case '/api/video-prepare':result=media.prepare(data.id);break;
        case '/api/video-to-note': {
          start('video-to-note',data);const operation=active;
          const code=await new Promise(resolve=>operation.child.once('close',resolve));
          if(code!==0)throw new HttpError(code===3?409:400,operation.error||'未能加入待办，请查看控制台操作日志');
          result={queued:true};break;
        }
        case '/api/video-delete': {
          if(data.confirm!==true)throw new HttpError(400,'请先确认将视频移入废纸篓');
          start('video-delete',data);const operation=active;
          const code=await new Promise(resolve=>operation.child.once('close',resolve));
          if(code!==0)throw new HttpError(code===3?409:400,operation.error||'删除未完成，请在运行记录的控制台操作日志中查看原因');
          result={deleted:true};break;
        }
        case '/api/schedule':
          if(data.action==='save'){if(typeof data.time!=='string'||typeof data.autoStartAfterReboot!=='boolean'||typeof data.intervalHours!=='number')throw new HttpError(400,'定时参数无效');scheduler.update({time:data.time,intervalHours:data.intervalHours,autoStartAfterReboot:data.autoStartAfterReboot});}
          else if(data.action==='start')scheduler.start();else if(data.action==='stop')scheduler.stop();else throw new HttpError(400,'定时操作无效');
          scheduleStartupWarning=null;result=scheduleState();break;
        case '/api/run':result=start('run',data);break;
        case '/api/purpose':result=state().running?defer('purpose',data):start('purpose',data);break;
        case '/api/quality':result=state().running?defer('quality',data):start('quality',data);break;
        case '/api/retry':result=start('retry',data);break;
        case '/api/discard':case '/api/delete-item': {
          const kind=path.slice('/api/'.length);
          if(kind==='discard'&&state().running){result=defer('discard',data);break;}
          start(kind,data);const operation=active;
          const code=await new Promise(resolve=>operation.child.once('close',resolve));
          if(code!==0)throw new HttpError(code===3?409:400,operation.error||'操作未完成，请查看控制台操作日志');
          result=kind==='discard'?{discarded:true}:{deleted:true};break;
        }
        case '/api/knowledge-domain':if(!existsSync(knowledge.file))throw new HttpError(400,'知识库索引还没有建');try{result=knowledge.setDomain(String(data.id||''),data.domain||null);}catch(e){throw new HttpError(400,e.message);}break;
        case '/api/read':result=library.setRead(data.id,data.read!==false);break;
        case '/api/page-read':{const page=knowledgePage(data.id);result=library.setPageRead(pageKey(page),page.hash,data.read!==false);break;}
        case '/api/topic':result=library.saveTopic(data);break;
        case '/api/topic-delete':result=library.deleteTopic(data.id);break;
        case '/api/material':result=enrich([library.addMaterial(data)])[0];break;
        case '/api/material-update':result=enrich([library.updateMaterial(data.id,data)])[0];break;
        case '/api/material-delete':result=library.removeMaterial(data.id);break;
        case '/api/demo-pick':store.item(data.id);result=library.setDemoPick(data.id,data.picked!==false,data.queued===true);break;
        case '/api/demo-build':result=start('demo-build');break;
        case '/api/token':result=library.createToken(data);break;
        case '/api/token-revoke':result=library.revokeToken(data.id);break;
        case '/api/x-authorize':result=xAuthorize();break;
        case '/api/login':result=start(data.platform==='bilibili'?'bili-login':'login');break;
        case '/api/login-input':{
          let input;try{input=validateLoginInput(data);}catch(e){throw new HttpError(400,e.message);}
          result=await browserRequest(input);break;
        }
        case '/api/session-check':result=start(data.platform==='bilibili'?'bili-session-check':'session-check');break;
        case '/api/login-control':{
          if(data.action!=='cancel')throw new HttpError(400,'登录操作无效');
          if(!active||!LOGIN_KINDS.includes(active.kind))throw new HttpError(409,'当前没有登录任务');
          if(data.action==='cancel')active.cancelling=true;auth={phase:'starting',message:'正在处理…'};active.child.send({action:data.action});result={accepted:true};break;
        }
        case '/api/stop':
          if(!active?.pid)throw new HttpError(409,'只能停止本控制台启动的任务');
          if(LOGIN_KINDS.includes(active.kind)){active.cancelling=true;}
          try{process.kill(-active.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
          result={stopping:true};break;
        case '/api/open': {
          if(serverMode)throw new HttpError(409,'请直接在网页中阅读或播放');
          if(!['note','text','video','gallery-folder','folder','source','notes-folder','runs-folder'].includes(data.kind))throw new HttpError(400,'打开目标无效');
          let args;
          if(data.kind==='source'){args=[sourceUrl(store.item(data.id))];}
          else if(data.kind==='gallery-folder'){args=[dirname(store.galleryFile(data.id,0))];}
          else if(data.kind==='notes-folder'||data.kind==='runs-folder'){const p=data.kind==='notes-folder'?store.overview().paths.notes:join(home,'runs');if(!existsSync(localPath(p)))throw new HttpError(404,'文件夹尚不存在');args=[p];}
          else {const kind=data.kind==='folder'?(data.fileKind||'note'):data.kind;const p=store.fileFor(data.id,kind);args=data.kind==='folder'?['-R',p]:data.kind==='note'?['-a','Obsidian',p]:[p];}
          await openFile(args);result={opened:true};break;
        }
        default:throw new HttpError(404,'接口不存在');
      }
      send(200,JSON.parse(store.redact(result)));
    }catch(e){if(res.headersSent){res.destroy();return;}send(e.status||400,{error:store.redact(e.message||'操作失败')});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,listen(port=47831){return new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>{
      origin=external?.origin||`http://127.0.0.1:${server.address().port}`;
      // 仅后台服务成功启动时恢复定时；页面请求和重复打开启动器均不会执行这里。
      try {if(!guest&&store.cfg()('DUST_AUTO_SCHEDULE','1')!=='0'&&!scheduler.status().loaded)scheduler.start();}
      catch(error){scheduleStartupWarning=`自动开启定时失败：${error.message}。可在此重新开启。`;console.error(scheduleStartupWarning);}
      resolve(origin+basePath);
    });
  });},execution:state};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const portArg=process.argv.indexOf('--port'),port=Number(portArg>=0?process.argv[portArg+1]:47831);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口须为 1024–65535');
  const app=createConsole();
  app.listen(port).then(url=>console.log(`dustoff 控制台：${url}\n关闭页面不会停止每日定时；Ctrl+C 关闭控制台服务。`)).catch(error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用，控制台可能已经启动。`:error.message);process.exitCode=1;});
}

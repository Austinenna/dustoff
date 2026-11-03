#!/usr/bin/env node
// 本机控制台：只监听 loopback，浏览器与 CLI 共用现有流水线。
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { DUST_HOME } from './scripts/config.mjs';
import { createStore, liveLock, HttpError } from './scripts/console-store.mjs';
import { createScheduler } from './scripts/schedule.mjs';
import { localPath, atomicWrite } from './scripts/policy.mjs';
import { createMediaService, streamMedia } from './scripts/console-media.mjs';
import { validateLoginInput } from './scripts/remote-login.mjs';
import { createConsoleAccess } from './scripts/console-auth.mjs';
import { sourceUrl } from './scripts/platforms.mjs';
import { addIntent, listIntents } from './scripts/intent-store.mjs';
import { CALLBACK_PATH, appConfig, exchangeCode, recordSession as recordXSession, saveToken, startAuthorization } from './scripts/sources/x/auth.mjs';
import { createClient as createXClient } from './scripts/sources/x/client.mjs';
const QUALITY_VALUES=['','64','80','116','120','0'];
const ROOT=dirname(fileURLToPath(import.meta.url));
// 登录类任务：抖音沿用原名，B 站加前缀；B 站任务在 console-session.mjs 中按平台参数分派。
const LOGIN_KINDS=['login','session-check','login-window','bili-login','bili-session-check'],WINDOW_KINDS=['login','login-window','bili-login'];
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?Number(v):v);
export function createConsole({home=DUST_HOME,scheduler,root=ROOT,spawnProcess=spawn,xFetch=fetch,publicUrl=process.env.DUST_PUBLIC_URL||'',serverMode=process.env.DUST_SERVER_MODE==='1',openFile=(args)=>new Promise((resolve,reject)=>execFile('/usr/bin/open',args,{timeout:10000},(err)=>err?reject(err):resolve()))}={}) {
  const external=publicUrl?new URL(publicUrl):null;
  if(external&&(external.protocol!=='https:'||external.username||external.password||external.search||external.hash||!/^\/[a-zA-Z0-9/_-]*$/.test(external.pathname)))throw new Error('公网地址必须为不含凭据、查询参数的 HTTPS 地址');
  const basePath=external?external.pathname.replace(/\/+$/,''):'';
  const access=createConsoleAccess({home,enabled:!!external});
  const store=createStore(home);
  const media=createMediaService({store,home});
  scheduler ||= createScheduler({home,root});
  const token=randomBytes(32).toString('hex');
  let active=null,lastAction=null,origin,auth=null,scheduleStartupWarning=null;
  const actionsDir=localPath(join(home,'console'));
  let nextBrowserRequest=0;
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
  async function body(req){let size=0,parts=[];for await(const data of req){size+=data.length;if(size>32*1024)throw new HttpError(413,'请求内容过大');parts.push(data);}try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new HttpError(400,'请求不是有效 JSON');}}
  const server=createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
    const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(type.startsWith('application/json')?encode(value):value);};
    try {
      if(req.headers.host!==new URL(origin).host)throw new HttpError(403,'请使用配置的控制台地址');
      {const u=new URL(req.url,origin);if(req.method==='GET'&&u.pathname===basePath+CALLBACK_PATH){await xCallback(u,res,send);return;}}
      if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'不接受跨站请求');
      const url=new URL(req.url,origin);let path=url.pathname;
      if(basePath){if(path===basePath){res.setHeader('Location',basePath+'/');send(308,'','text/plain');return;}if(!path.startsWith(basePath+'/'))throw new HttpError(404,'页面不存在');path=path.slice(basePath.length);}
      if(await access.handle(req,res,path,{origin,basePath,send}))return;
      if(req.method==='GET'&&['/','/studio.mjs','/studio.css','/studio-view.mjs','/schedule-plan.mjs','/markdown.mjs','/login-ui.mjs','/remote-login.mjs','/remote-login.css'].includes(path)) {
        const name=path==='/'?'studio.html':path.slice(1),types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
        let content=readFileSync(join(root,name==='schedule-plan.mjs'?'scripts':'web',name),'utf8');if(path==='/')content=content.replace('__CSRF_TOKEN__',token).replace('__SERVER_MODE__',serverMode?'1':'0').replace('__ACCESS_CONTROL__',external?'1':'0');
        send(200,content,types[name.split('.').pop()]);return;
      }
      if(!path.startsWith('/api/'))throw new HttpError(404,'页面不存在');
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
        case '/api/items':result=store.listItems(params);break;
        case '/api/gallery':result=store.gallery(params.id);break;
        case '/api/video-status':result=media.status(params.id);break;
        case '/api/queue':result=store.pendingItems();break;
        case '/api/item':result=store.item(params.id);break;
        case '/api/document':result=store.document(params.id,params.kind);break;
        case '/api/settings':result=store.settings();break;
        case '/api/runs':result={runs:store.runs()};break;
        case '/api/log':result=params.kind==='scheduler'?{log:store.tail(join(home,'scheduler','latest-run.log'))}:params.kind==='console'?{log:store.tail(join(home,'console','latest-action.log'))}:store.runDetail(params.id);break;
        default:throw new HttpError(404,'接口不存在');
      } else switch(path){
        case '/api/settings':result=store.saveSettings(data);break;
        case '/api/video-prepare':result=media.prepare(data.id);break;
        case '/api/video-to-note': {
          if(serverMode)throw new HttpError(409,'服务器模式暂不提供本地视频文件操作');
          start('video-to-note',data);const operation=active;
          const code=await new Promise(resolve=>operation.child.once('close',resolve));
          if(code!==0)throw new HttpError(code===3?409:400,operation.error||'未能加入待办，请查看控制台操作日志');
          result={queued:true};break;
        }
        case '/api/video-delete': {
          if(serverMode)throw new HttpError(409,'服务器模式暂不提供本地视频文件操作');
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
      try {if(store.cfg()('DUST_AUTO_SCHEDULE','1')!=='0'&&!scheduler.status().loaded)scheduler.start();}
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

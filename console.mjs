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
const ROOT=dirname(fileURLToPath(import.meta.url));
const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?Number(v):v);
export function createConsole({home=DUST_HOME,scheduler,root=ROOT,spawnProcess=spawn,openFile=(args)=>new Promise((resolve,reject)=>execFile('/usr/bin/open',args,{timeout:10000},(err)=>err?reject(err):resolve()))}={}) {
  const store=createStore(home);
  scheduler ||= createScheduler({home,root});
  const token=randomBytes(32).toString('hex');
  let active=null,lastAction=null,origin,auth=null;
  const actionsDir=localPath(join(home,'console'));
  function state(){const lock=liveLock(home);return {running:!!active||lock.running,pid:active?.pid||lock.pid||null,owned:!!active,kind:active?.kind||null,startedAt:active?.startedAt||null,lastAction};}
  function scheduleState(){try{return {...scheduler.status(),error:null};}catch(e){return {error:e.message,loaded:null,time:null,intervalHours:null,nextRun:null};}}
  function start(kind,body={}) {
    if(state().running)throw new HttpError(409,'已有任务正在运行，请等本轮结束');
    let script,args;
    if(kind==='run') {
      const n=Number(body.limit??store.policy().daily);
      if(!Number.isInteger(n)||n<1||n>store.policy().daily)throw new HttpError(400,`本轮处理数量须为 1–${store.policy().daily}`);
      if(body.noScan!==undefined&&typeof body.noScan!=='boolean')throw new HttpError(400,'只继续待办选项无效');
      script=join(root,'run.mjs');args=['--limit',String(n),...(body.noScan?['--no-scan']:[])];
    } else if(['login','session-check','login-window'].includes(kind)){
      script=join(root,'scripts','console-session.mjs');args=[kind==='session-check'?'check':kind==='login-window'?'window':'login'];
      auth={phase:'starting',message:kind==='session-check'?'正在检查登录状态…':'正在打开 Chrome 官方登录页…'};
    } else {
      if(kind==='retry'){const i=store.item(body.id);if(i.status!=='failed')throw new HttpError(400,'只能重试已失败作品');}
      if(kind==='purpose'){if(!store.item(body.id).can_change_purpose)throw new HttpError(400,'这条作品不在可修改用途的处理范围内');if(!['video','speech','visual','both','review'].includes(body.purpose))throw new HttpError(400,'用途无效');}
      script=join(root,'scripts','console-action.mjs');args=[kind,...(['retry','purpose'].includes(kind)?[body.id]:[]),...(kind==='purpose'?[body.purpose]:[])];
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
      if(active!==operation||m?.type!=='session'||operation.cancelling&&m.phase!=='cancelled'&&m.phase!=='error')return;
      const {phase,message,deadline}=m;
      if(!['starting','checking','checked','saving','success','timeout','window','cancelled','error'].includes(phase))return;
      auth={phase,message:String(message||'').slice(0,300),deadline};
    });
    child.stdout.on('data',log);child.stderr.on('data',log);
    child.once('error',e=>log(`启动失败：${e.message}\n`));
    child.once('close',(code,signal)=>{lastAction={kind,pid:operation.pid,startedAt:operation.startedAt,finishedAt:Date.now(),exitCode:code??1,signal};log(`结束：退出码 ${lastAction.exitCode}\n`);if(fd!==null){closeSync(fd);fd=null;}atomicWrite(join(actionsDir,'last-action.json'),encode(lastAction));if(active===operation){active=null;if(['login','session-check','login-window'].includes(kind)){if(!['checked','success','cancelled','timeout','error'].includes(auth?.phase))auth={phase:'error',message:'登录任务已结束，请重新开始'};}}});
    return state();
  }
  async function body(req){let size=0,parts=[];for await(const data of req){size+=data.length;if(size>32*1024)throw new HttpError(413,'请求内容过大');parts.push(data);}try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new HttpError(400,'请求不是有效 JSON');}}
  const server=createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
    const send=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(type.startsWith('application/json')?encode(value):value);};
    try {
      if(req.headers.host!==new URL(origin).host)throw new HttpError(403,'请使用控制台的本机地址');
      if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'不接受跨站请求');
      const url=new URL(req.url,origin),path=url.pathname;
      if(req.method==='GET'&&['/','/studio.mjs','/studio.css','/studio-view.mjs','/schedule-plan.mjs','/markdown.mjs','/login-ui.mjs'].includes(path)) {
        const name=path==='/'?'studio.html':path.slice(1),types={html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'};
        let content=readFileSync(join(root,name==='schedule-plan.mjs'?'scripts':'web',name),'utf8');if(path==='/')content=content.replace('__CSRF_TOKEN__',token);
        send(200,content,types[name.split('.').pop()]);return;
      }
      if(!path.startsWith('/api/'))throw new HttpError(404,'页面不存在');
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
        case '/api/session':result={session:store.overview().session,auth,active:!!active&&['login','session-check','login-window'].includes(active.kind),kind:active?.kind};break;
        case '/api/health':result={app:'dustoff',home,root,pid:process.pid};break;
        case '/api/overview':result={...store.overview(),execution:state(),scheduler:scheduleState()};break;
        case '/api/items':result=store.listItems(params);break;
        case '/api/queue':result=store.pendingItems();break;
        case '/api/item':result=store.item(params.id);break;
        case '/api/document':result=store.document(params.id,params.kind);break;
        case '/api/settings':result=store.settings();break;
        case '/api/runs':result={runs:store.runs()};break;
        case '/api/log':result=params.kind==='scheduler'?{log:store.tail(join(home,'scheduler','latest-run.log'))}:params.kind==='console'?{log:store.tail(join(home,'console','latest-action.log'))}:store.runDetail(params.id);break;
        default:throw new HttpError(404,'接口不存在');
      } else switch(path){
        case '/api/settings':result=store.saveSettings(data);break;
        case '/api/schedule':
          if(data.action==='save'){if(typeof data.time!=='string'||typeof data.autoStartAfterReboot!=='boolean'||typeof data.intervalHours!=='number')throw new HttpError(400,'定时参数无效');scheduler.update({time:data.time,intervalHours:data.intervalHours,autoStartAfterReboot:data.autoStartAfterReboot});}
          else if(data.action==='start')scheduler.start();else if(data.action==='stop')scheduler.stop();else throw new HttpError(400,'定时操作无效');
          result=scheduleState();break;
        case '/api/run':result=start('run',data);break;
        case '/api/purpose':result=start('purpose',data);break;
        case '/api/retry':result=start('retry',data);break;
        case '/api/login':result=start('login');break;
        case '/api/session-check':result=start('session-check');break;
        case '/api/login-control':{
          if(data.action!=='cancel')throw new HttpError(400,'登录操作无效');
          if(!active||!['login','login-window','session-check'].includes(active.kind))throw new HttpError(409,'当前没有登录任务');
          if(data.action==='cancel')active.cancelling=true;auth={phase:'starting',message:'正在处理…'};active.child.send({action:data.action});result={accepted:true};break;
        }
        case '/api/stop':
          if(!active?.pid)throw new HttpError(409,'只能停止本控制台启动的任务');
          if(['login','session-check','login-window'].includes(active.kind)){active.cancelling=true;}
          try{process.kill(-active.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
          result={stopping:true};break;
        case '/api/open': {
          if(!['note','text','video','folder','source','notes-folder','runs-folder'].includes(data.kind))throw new HttpError(400,'打开目标无效');
          let args;
          if(data.kind==='source'){store.item(data.id);args=[`https://www.douyin.com/video/${data.id}`];}
          else if(data.kind==='notes-folder'||data.kind==='runs-folder'){const p=data.kind==='notes-folder'?store.overview().paths.notes:join(home,'runs');if(!existsSync(localPath(p)))throw new HttpError(404,'文件夹尚不存在');args=[p];}
          else {const kind=data.kind==='folder'?(data.fileKind||'note'):data.kind;const p=store.fileFor(data.id,kind);args=data.kind==='folder'?['-R',p]:data.kind==='note'?['-a','Obsidian',p]:[p];}
          await openFile(args);result={opened:true};break;
        }
        default:throw new HttpError(404,'接口不存在');
      }
      send(200,JSON.parse(store.redact(result)));
    }catch(e){send(e.status||400,{error:store.redact(e.message||'操作失败')});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,store,listen(port=47831){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;resolve(origin);});});},execution:state};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const portArg=process.argv.indexOf('--port'),port=Number(portArg>=0?process.argv[portArg+1]:47831);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口须为 1024–65535');
  const app=createConsole();
  app.listen(port).then(url=>console.log(`dustoff 控制台：${url}\n关闭页面不会停止每日定时；Ctrl+C 关闭控制台服务。`)).catch(error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用，控制台可能已经启动。`:error.message);process.exitCode=1;});
}

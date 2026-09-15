import test from 'node:test';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { cookieSession, sessionSummary, cookieParameters } from '../scripts/session-status.mjs';
import { manageSession } from '../scripts/console-session.mjs';
import { launchLoginBrowser, ONLINE_STATUS, OPEN_LOGIN, LOGIN_DIAGNOSTICS } from '../scripts/login-browser.mjs';
import { statusCard, loginFlow } from '../web/login-ui.mjs';
const cookie=(value='fixture-session',domain='.douyin.com',expires=2000000000)=>({name:'sessionid',value,domain,path:'/',expires,secure:true,httpOnly:true});

test('Cookie 状态只识别抖音凭据，过滤过期项；界面不把过期记录当成可用',()=>{
  assert.deepEqual(cookieSession([cookie('else','evil-douyin.com')]),{loggedIn:false,expiresAt:null});
  assert.equal(cookieSession([cookie('old','.douyin.com',1)]).loggedIn,false);
  assert.equal(cookieSession([cookie('temporary','.douyin.com',-1)]).expiresAt,null);
  assert.equal(cookieParameters([cookie(),cookie('else','other.invalid')]).length,1);
  const status=sessionSummary({logged_in:true,expires_at:100,last_check_at:1},110);
  assert.equal(status.level,'expired');assert.equal(status.remainingSeconds,0);
  assert.equal(sessionSummary({logged_in:true,expires_at:90000},100).level,'warn');
  assert.equal(sessionSummary({logged_in:true,expires_at:null},100).remainingSeconds,null);
  assert.equal(sessionSummary(null).stale,true);
  assert.ok(statusCard(status).includes('需要重新登录'));
  assert.ok(!loginFlow({active:false,auth:{phase:'error',message:'<script>'}}).includes('<script>'));
  assert.ok(!loginFlow({active:false,auth:{phase:'qr'},qrAt:1}).includes('id="official-qr"'));
});

test('同一天失效后重新登录会重新评估并清除旧告警，未知有效期不会沿用旧到期时间',()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-session-state-'));
  try{
    const code=`import {guardSession,sessionState} from ${JSON.stringify(new URL('../scripts/session_guard.mjs',import.meta.url).href)};guardSession({loggedIn:true,expiresAt:2000000000,force:true});guardSession({loggedIn:false});if(sessionState().level!=='expired'||sessionState().expires_at!==null)process.exit(2);guardSession({loggedIn:true,expiresAt:null});console.log(JSON.stringify(sessionState()));`;
    const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DUST_HOME:home,DUST_NOTIFY:'0'},encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);const s=JSON.parse(r.stdout);assert.equal(s.logged_in,true);assert.equal(s.level,'unknown');assert.equal(s.flag_present,false);assert.equal(s.expires_at,null);
  }finally{rmSync(home,{recursive:true,force:true});}
});

function harness({freshAfter=Infinity,online='verified',failImport=false}={}){
  const home=mkdtempSync(join(tmpdir(),'dustoff-session-flow-')),events=[],guards=[],launches=[];
  let time=10000;
  const launch=options=>{
    const temporary=options.profile!==join(home,'profile');let reads=0,jar=temporary?[]:[cookie('old')];
    const b={options,closed:false,async send(method,params){
      if(method==='Storage.getCookies'){reads++;if(temporary&&reads>=freshAfter)jar=[cookie('new')];return {cookies:jar};}
      if(method==='Storage.setCookies'){if(failImport&&params.cookies.some(c=>c.value==='new'))throw new Error('fixture import failure');jar=params.cookies;return {};}
      throw new Error('Unsupported method '+method);
    },async page(){return {evaluate:async expression=>expression===ONLINE_STATUS?online:undefined,command:async(method,params)=>{if(method==='Network.deleteCookies')jar=jar.filter(c=>c.name!==params.name||c.domain!==params.domain);assert.notEqual(method,'Page.captureScreenshot');return {};}};},async close(){b.closed=true;},jar:()=>jar};launches.push(b);return b;
  };
  return {home,events,guards,launches,options:{home,profile:join(home,'profile'),launch,emit:e=>events.push(e),guard:s=>guards.push(s),now:()=>time,wait:async ms=>{time+=ms;},timeout:5000},cleanup:()=>rmSync(home,{recursive:true,force:true})};
}

test('扫码超时只清临时会话，二维码不写入文件，不触碰原登录资料',async()=>{
  const f=harness();try{await manageSession(f.options);assert.equal(f.events.at(-1).phase,'timeout');assert.ok(f.events.some(e=>e.phase==='window'));assert.equal(f.launches.length,1);assert.equal(f.launches[0].closed,true);assert.equal(f.guards.length,0);assert.deepEqual(readdirSync(join(f.home,'console')),[]);}finally{f.cleanup();}
});

test('扫码取消关闭临时浏览器；新凭据保存成功后才更新状态',async()=>{
  const cancelled=harness(),controller=new AbortController();controller.abort();
  try{await assert.rejects(manageSession({...cancelled.options,signal:controller.signal}),/取消/);assert.equal(cancelled.guards.length,0);}finally{cancelled.cleanup();}
  const f=harness({freshAfter:2});try{await manageSession(f.options);assert.equal(f.events.at(-1).phase,'success');assert.equal(f.guards.length,1);assert.equal(f.guards[0].online,'verified');assert.equal(f.launches[1].jar()[0].value,'new');assert.ok(f.launches.every(b=>b.closed));assert.equal(JSON.parse(readFileSync(join(f.home,'console','login.json'))).success,true);assert.ok(!JSON.stringify(f.events).includes('fixture-session'));}finally{f.cleanup();}
});

test('新登录写入失败会恢复旧凭据，且不会更新成功状态',async()=>{
  const f=harness({freshAfter:1,failImport:true});try{await assert.rejects(manageSession(f.options));assert.equal(f.launches[1].jar()[0].value,'old');assert.equal(f.guards.length,0);assert.ok(f.launches.every(b=>b.closed));}finally{f.cleanup();}
});

test('立即检查不创建扫码会话，不调用模型；在线不确定不假报已验证',async()=>{
  const f=harness({online:'unknown'});try{await manageSession({...f.options,mode:'check'});assert.equal(f.events.at(-1).phase,'checked');assert.equal(f.guards[0].online,'unknown');assert.equal(f.launches.length,1);assert.equal(f.launches[0].options.profile,join(f.home,'profile'));}finally{f.cleanup();}
});

test('Chrome 使用匿名管道，正确拼接分片响应并遮蔽协议错误',async()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-cdp-pipe-'));let args,child;
  const spawnProcess=(_bin,a)=>{
    args=a;child=new EventEmitter();const out=new PassThrough();
    child.stdio=[null,null,null,new Writable({write(data,_e,done){const m=JSON.parse(data.toString().slice(0,-1));const response=Buffer.from(JSON.stringify(m.method==='bad'?{id:m.id,error:{message:'fixture secret'}}:{id:m.id,result:{ok:true}})+'\0');out.write(response.subarray(0,5));out.write(response.subarray(5));if(m.method==='Browser.close')queueMicrotask(()=>child.emit('exit',0));done();}}),out];child.kill=()=>child.emit('exit',0);return child;
  };
  try{const b=launchLoginBrowser({profile:home,spawnProcess});assert.ok(args.includes('--remote-debugging-pipe'));assert.ok(!args.some(a=>a.startsWith('--remote-debugging-port')));assert.deepEqual(await b.send('Browser.getVersion'),{ok:true});await assert.rejects(b.send('bad'),e=>!e.message.includes('fixture secret'));await b.close();}finally{rmSync(home,{recursive:true,force:true});}
});

test('登录直接打开可见 Chrome，取消后的界面不保留二维码或空白区',async()=>{
  assert.doesNotThrow(()=>runInNewContext(OPEN_LOGIN,{document:{body:null}}));
  assert.equal(loginFlow({active:false,auth:{phase:'cancelled'}}),'');
  assert.equal(loginFlow({active:false,auth:null}),'');
  const f=harness();try{await manageSession({...f.options,timeout:40000});assert.equal(f.launches.length,1);assert.equal(f.launches[0].options.visible,true);assert.ok(f.events.every(e=>!e.image));assert.equal(f.guards.length,0);}finally{f.cleanup();}
});

test('诊断只记录结构计数，不记录凭据、页面全文或 URL 参数',()=>{
  const document={readyState:'complete',body:{innerText:'访问受限'},querySelectorAll:()=>[]};
  const context={document,location:{hostname:'www.douyin.com',search:'?token=fixture-secret'}};
  assert.equal(runInNewContext(LOGIN_DIAGNOSTICS,context).textCharacters,4);
  document.body.innerText=' \n \n';assert.equal(runInNewContext(LOGIN_DIAGNOSTICS,context).textCharacters,0);
  document.body.innerText='sessionid=fixture-secret';
  const output=JSON.stringify(runInNewContext(LOGIN_DIAGNOSTICS,context));
  assert.ok(!output.includes('fixture-secret'));assert.ok(!output.includes('访问受限'));
});

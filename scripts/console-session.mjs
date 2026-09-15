// 控制台登录任务。直接打开官方 Chrome 窗口，Cookie 不回传网页、不落日志。
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DUST_HOME, makeCfg } from './config.mjs';
import { atomicWrite, localPath } from './policy.mjs';
import { createStage } from './stage.mjs';
import { guardSession } from './session_guard.mjs';
import { cookieSession, cookieParameters } from './session-status.mjs';
import { launchLoginBrowser, OPEN_LOGIN, ONLINE_STATUS, LOGIN_DIAGNOSTICS } from './login-browser.mjs';
const SELF='https://www.douyin.com/user/self';
const HOME='https://www.douyin.com/';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

export async function manageSession({mode='login',profile,home=DUST_HOME,launch=launchLoginBrowser,emit=()=>{},diagnose=()=>{},guard=guardSession,signal,wait=delay,now=Date.now,timeout=300000}={}) {
  let browser=null,temp=null;
  const check=()=>{if(signal?.aborted)throw new Error('已取消登录操作');};
  const cookies=async b=>(await b.send('Storage.getCookies')).cookies;
  const close=async()=>{if(browser){await browser.close();browser=null;}};
  async function inspect(b){
    const state=cookieSession(await cookies(b));
    if(!state.loggedIn)return {...state,online:'login_required'};
    const page=await b.page(SELF);let online='unknown';
    for(let i=0;i<15;i++){check();await wait(1000);online=await page.evaluate(ONLINE_STATUS);if(online==='verified'||i>=7&&online==='login_required')break;}
    return {...cookieSession(await cookies(b)),online};
  }
  try {
    if(mode==='check'){
      emit({phase:'checking',message:'正在读取登录资料并访问抖音核实…'});
      browser=launch({profile});const status=await inspect(browser);check();
      guard({...status,force:true});
      emit({phase:'checked',message:status.online==='verified'?'抖音已确认登录可用':status.online==='login_required'?'抖音提示需要登录':'已更新到期时间，未能确认在线状态'});return;
    }
    mkdirSync(join(home,'console'),{recursive:true,mode:0o700});
    temp=mkdtempSync(join(home,'console','qr-profile-'));
    const deadline=now()+timeout;let page,lastOpen=0,waitingSince=now(),lastDiagnostic=0;
    while(now()<deadline){
      check();
      if(!browser){emit({phase:'starting',message:'正在打开 Chrome 官方登录页…',deadline});browser=launch({profile:temp,visible:true});page=await browser.page(HOME);}
      const fresh=await cookies(browser);
      if(cookieSession(fresh).loggedIn){
        emit({phase:'saving',message:'已收到登录凭据，正在保存并核对…',deadline});
        await close();check();
        // 只把本次成功登录的抖音 Cookie 写入 dustoff 的专用资料。
        // 导入失败时恢复旧 Cookie，不删除或替换用户的整个浏览器资料目录。
        browser=launch({profile});const old=await cookies(browser);const cookiePage=await browser.page('about:blank');
        try {
          for(const c of cookieParameters(old))await cookiePage.command('Network.deleteCookies', {name:c.name,domain:c.domain,path:c.path});
          await browser.send('Storage.setCookies',{cookies:cookieParameters(fresh)});
          const saved=cookieSession(await cookies(browser));
          if(!saved.loggedIn)throw new Error('保存登录资料失败');
          const status=await inspect(browser);check();
          if(!status.loggedIn||status.online==='login_required')throw new Error('新登录未通过抖音验证，请在官方窗口重试');
          guard({...status,force:true});
          atomicWrite(join(home,'console','login.json'),JSON.stringify({completedAt:now(),success:true}));
          emit({phase:'success',message:status.online==='verified'?'登录成功，已更新到期时间':'登录凭据已保存；在线状态暂未确认',deadline});return;
        }catch(error){
          for(const c of cookieParameters(await cookies(browser)))await cookiePage.command('Network.deleteCookies',{name:c.name,domain:c.domain,path:c.path});
          await browser.send('Storage.setCookies',{cookies:cookieParameters(old)});throw error;
        }
      }
      if(now()-lastOpen>5000){await page.evaluate(OPEN_LOGIN);lastOpen=now();}
      if(now()-lastDiagnostic>=10000){diagnose(JSON.stringify({mode:'window',elapsedSeconds:Math.round((now()-waitingSince)/1000),page:await page.evaluate(LOGIN_DIAGNOSTICS),network:browser.diagnostics?.()}));lastDiagnostic=now();}
      emit({phase:'window',message:'请在 Chrome 官方页面扫码，完成后这里会自动更新登录状态',deadline});
      await wait(1500);
    }
    emit({phase:'timeout',message:'本次扫码已超时，请重新开始'});
  } finally {await close();if(temp)rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}

async function main(){
  const mode=process.argv[2]||'login';if(!['login','check','window'].includes(mode))throw new Error('登录操作无效');
  const stage=createStage({name:'console-action',dustHome:DUST_HOME,notify:false});stage.acquireLock();
  const controller=new AbortController();
  for(const sig of ['SIGTERM','SIGINT']){process.removeAllListeners(sig);process.on(sig,()=>controller.abort());}
  process.on('disconnect',()=>controller.abort());
  process.on('message',m=>{if(m?.action==='cancel')controller.abort();});
  const emit=value=>{if(process.connected)process.send({type:'session',...value});};
  try{await manageSession({mode,home:DUST_HOME,profile:localPath(makeCfg()('DUST_PROFILE',join(DUST_HOME,'chrome-profile'))),signal:controller.signal,emit,diagnose:message=>stage.log('[登录诊断]',message)});}
  catch(error){stage.log(error.message);emit({phase:controller.signal.aborted?'cancelled':'error',message:controller.signal.aborted?'本次操作已取消':'登录操作未完成，请重试或在 Chrome 官方窗口完成验证'});process.exitCode=controller.signal.aborted?0:1;}
  finally{stage.releaseLock();stage.pruneRuns();if(process.connected)process.disconnect();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('登录任务启动失败');process.exitCode=1;});

// 专用 Chrome 通过匿名管道通信：不开放调试端口，不接管用户日常浏览器。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { makeCfg } from './config.mjs';
import { localPath } from './policy.mjs';

export function launchLoginBrowser({profile,visible=false,spawnProcess=spawn}={}) {
  profile=localPath(profile);mkdirSync(profile,{recursive:true,mode:0o700});
  const chrome=spawnProcess(makeCfg()('DUST_CHROME','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),[
    ...(visible?[]:['--headless=new']),'--remote-debugging-pipe',`--user-data-dir=${profile}`,
    '--no-first-run','--no-default-browser-check','--no-startup-window','--disable-gpu','--mute-audio','--window-size=1100,850',
  ],{stdio:['ignore','ignore','ignore','pipe','pipe']});
  let next=0,buffer=Buffer.alloc(0),closed=false,exited=false;
  const pending=new Map();
  function fail(){closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('登录浏览器已关闭，或该登录资料正被其他浏览器使用'));}pending.clear();}
  chrome.once('error',()=>{exited=true;fail();});chrome.once('exit',()=>{exited=true;fail();});
  chrome.stdio[3].on('error',fail);chrome.stdio[4].on('error',fail);
  chrome.stdio[4].on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>16*1024*1024){fail();chrome.kill();return;}
    let end;
    while((end=buffer.indexOf(0))>=0){
      const raw=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
      let m;try{m=JSON.parse(raw);}catch{continue;}
      const p=pending.get(m.id);if(!p)continue;pending.delete(m.id);clearTimeout(p.timer);
      // 不传播可能包含 Cookie 或页面数据的协议错误正文。
      if(m.error)p.reject(new Error(`登录浏览器操作失败：${p.method}`));else p.resolve(m.result);
    }
  });
  function send(method,params={},sessionId){
    if(closed)return Promise.reject(new Error('登录浏览器已关闭'));
    return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`登录浏览器响应超时：${method}`));},12000);pending.set(id,{resolve,reject,timer,method});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});
  }
  async function page(url){
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const command=(method,params)=>send(method,params,sessionId);
    await command('Page.enable');await command('Network.enable');
    await command('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false});
    await command('Page.navigate',{url});
    return {targetId,command,evaluate:async expression=>{const r=await command('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw new Error('读取官方登录页面失败');return r.result.value;}};
  }
  async function close(){
    if(!closed){try{await Promise.race([send('Browser.close'),new Promise(r=>setTimeout(r,1500))]);}catch{} }
    if(!exited)await new Promise(resolve=>{const timer=setTimeout(()=>{chrome.kill('SIGKILL');},2000);chrome.once('exit',()=>{clearTimeout(timer);resolve();});});
  }
  return {send,page,close,kill:()=>chrome.kill('SIGKILL')};
}

// 官方页面当前使用 img[aria-label="二维码"]，同时兼容 alt 标注。
// 只截取该元素，绝不把整张网页或 Cookie 发送到控制台。
export const QR_SNAPSHOT = `(() => {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const img=Array.from(document.querySelectorAll('img[aria-label="二维码"],img[alt="二维码"]')).find(visible);
  if(!img||!img.complete||!img.naturalWidth)return null;
  const r=img.getBoundingClientRect(),text=img.parentElement?.parentElement?.innerText||'';
  return {clip:{x:Math.max(0,r.x-8),y:Math.max(0,r.y-8),width:r.width+16,height:r.height+16,scale:2},
    expired:/失效|过期|刷新/.test(text),scanned:/扫码成功|确认登录|已扫描/.test(text)};
})()`;
export const OPEN_LOGIN = `(() => {
  if(!document.body)return;
  if(document.querySelector('img[aria-label="二维码"],img[alt="二维码"]')||document.body.innerText.includes('扫码登录'))return;
  const e=Array.from(document.querySelectorAll('button,span,div')).find(e=>e.children.length===0&&e.textContent.trim()==='登录'&&e.getBoundingClientRect().width>0);
  if(e)e.click();
})()`;
export const ONLINE_STATUS = `(() => {
  if(location.hostname!=='www.douyin.com')return 'unknown';
  const visible=e=>e.getBoundingClientRect().width>0;
  if(Array.from(document.querySelectorAll('button,span,div,a')).some(e=>e.children.length===0&&e.textContent.trim()==='编辑资料'&&visible(e)))return 'verified';
  if(Array.from(document.querySelectorAll('img[aria-label="二维码"],img[alt="二维码"]')).some(visible))return 'login_required';
  return 'unknown';
})()`;

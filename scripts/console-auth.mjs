import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {readFileSync,existsSync,mkdirSync,chmodSync,renameSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DUST_HOME} from './config.mjs';
import {atomicWrite} from './policy.mjs';
const scrypt=promisify(scryptCallback),TTL=14*86400_000;
export function createPasswordSetup(home){
  const token=randomBytes(32).toString('hex'),file=join(home,'console-access','setup.json');
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  atomicWrite(file,JSON.stringify({hash:createHash('sha256').update(token).digest('hex'),expires:Date.now()+30*60_000})+'\n');
  return token;
}
export async function setConsolePassword(home,password){
  if(typeof password!=='string'||password.length<12||password.length>128)throw new Error('控制台密码长度须为 12–128 位');
  const salt=randomBytes(16).toString('hex'),hash=Buffer.from(await scrypt(password,salt,64)).toString('hex');
  const file=join(home,'console-access','password.json');mkdirSync(dirname(file),{recursive:true,mode:0o700});
  atomicWrite(file,JSON.stringify({version:1,salt,hash})+'\n');chmodSync(file,0o600);
}
export function createConsoleAccess({home,enabled=false,now=Date.now}={}){
  const sessions=new Map(),attempts=new Map();let verifying=0;
  const passwordFile=join(home,'console-access','password.json');
  const setupFile=join(home,'console-access','setup.json');
  if(enabled&&!existsSync(passwordFile))throw new Error('公网控制台必须先设置访问密码');
  let credentials=enabled?readFileSync(passwordFile,'utf8'):null;
  function password(){const latest=readFileSync(passwordFile,'utf8');if(latest!==credentials){credentials=latest;sessions.clear();}const p=JSON.parse(latest);if(p.version!==1||!/^[a-f0-9]{32}$/.test(p.salt)||!/^[a-f0-9]{128}$/.test(p.hash))throw new Error('控制台密码配置无效');return p;}
  if(enabled)password();
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const cookie=req=>String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('dustoff_session='))?.slice(16)||'';
  const page=(base,error='')=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · dustoff</title><style>body{margin:0;background:#f5f4ef;color:#292b26;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;max-width:420px;width:90%;padding:36px;background:white;border:1px solid #dedfd8;border-radius:14px}h1{font-size:30px}label,input,button{display:block;box-sizing:border-box;width:100%}input{padding:12px;margin:12px 0 20px;border:1px solid #bbb;border-radius:6px;font:inherit}button{background:#344c3c;color:white;border:0;padding:13px;border-radius:6px;font:inherit}p{color:#666;line-height:1.7}.error{color:#a32b2b}</style><main><h1>dustoff</h1><p>登录后查看你的笔记、视频和图集。</p>${error?`<p class="error" role="alert">${error}</p>`:''}<form method="post" action="${base}/auth/login"><label for="password">访问密码</label><input id="password" type="password" name="password" autocomplete="current-password" required maxlength="128" autofocus><button>登录</button></form></main></html>`;
  async function handle(req,res,path,{origin,basePath='',send}){
    if(!enabled)return false;
    const current=password(),key=digest(cookie(req)),expires=sessions.get(key)||0;
    for(const [id,end]of sessions)if(end<=now())sessions.delete(id);
    const authorized=expires>now();
    const cookieOptions=`Path=${basePath||'/'}; HttpOnly; Secure; SameSite=Strict`;
    function signedIn(){const token=randomBytes(32).toString('hex');sessions.set(digest(token),now()+TTL);res.setHeader('Set-Cookie',`dustoff_session=${token}; ${cookieOptions}; Max-Age=${TTL/1000}`);res.setHeader('Location',basePath+'/');send(303,'','text/plain');}
    if(path==='/auth/setup.js'&&req.method==='GET'){send(200,readFileSync(new URL('../web/auth-setup.mjs',import.meta.url),'utf8'),'text/javascript; charset=utf-8');return true;}
    if(path==='/auth/setup'&&req.method==='GET'){
      send(200,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设置访问密码 · dustoff</title><style>body{font:16px system-ui;background:#f5f4ef;color:#292b26;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:420px;width:88%;box-sizing:border-box;background:white;border:1px solid #dedfd8;border-radius:14px;padding:32px}input,button{display:block;box-sizing:border-box;width:100%;font:inherit;padding:12px;border-radius:6px;margin:10px 0 20px}input{border:1px solid #bbb}button{border:0;background:#344c3c;color:white}p{line-height:1.7;color:#666}#error{color:#a32b2b}</style><main><h1>设置访问密码</h1><p>用于从任何设备登录 Dustoff。至少 12 位；密码只保存加盐哈希。此设置链接 30 分钟内有效且只能使用一次。</p><form id="setup-form"><label for="new-password">新密码</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><label for="confirm-password">再次输入</label><input id="confirm-password" name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><p id="error" role="alert"></p><button>保存并进入控制台</button></form></main><script type="module" src="${basePath}/auth/setup.js"></script></html>`,'text/html; charset=utf-8');return true;
    }
    if(path==='/auth/setup'&&req.method==='POST'){
      if(req.headers.origin!==origin){send(403,{error:'设置来源无效'});return true;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){send(413,{error:'请求过大'});return true;}}
      let value;try{value=JSON.parse(body);}catch{send(400,{error:'请求格式无效'});return true;}
      let setup;try{setup=JSON.parse(readFileSync(setupFile,'utf8'));}catch{send(410,{error:'设置链接已使用或失效'});return true;}
      if(setup.expires<=now()||typeof value.token!=='string'||!/^[a-f0-9]{64}$/.test(value.token)||!timingSafeEqual(Buffer.from(digest(value.token),'hex'),Buffer.from(setup.hash,'hex'))){send(403,{error:'设置链接无效或已过期'});return true;}
      if(typeof value.password!=='string'||value.password.length<12||value.password.length>128){send(400,{error:'密码长度须为 12–128 位'});return true;}
      try{renameSync(setupFile,setupFile+'.in-use');}catch{send(409,{error:'设置链接正在使用'});return true;}
      try{await setConsolePassword(home,value.password);credentials=readFileSync(passwordFile,'utf8');sessions.clear();rmSync(setupFile+'.in-use',{force:true});signedIn();}
      catch(error){if(existsSync(setupFile+'.in-use'))renameSync(setupFile+'.in-use',setupFile);throw error;}
      return true;
    }
    if(path==='/auth/login'&&req.method==='POST'){
      if(req.headers.origin!==origin){send(403,{error:'登录来源无效'});return true;}
      if(!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')){send(415,{error:'登录请求无效'});return true;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){send(413,{error:'请求过大'});return true;}}
      for(const [ip,a]of attempts)if(a.until<=now())attempts.delete(ip);
      const ip=String(req.headers['x-real-ip']||req.socket.remoteAddress).slice(0,100),a=attempts.get(ip)||{count:0,until:now()+15*60_000};
      if(a.count>=8||verifying>=2||attempts.size>=1000){send(429,page(basePath,'尝试过于频繁，请稍后再试。'),'text/html; charset=utf-8');return true;}
      a.count++;attempts.set(ip,a);verifying++;
      let valid=false;
      try{const value=new URLSearchParams(body).get('password')||'';if(value.length<=128){const hash=await scrypt(value,current.salt,64);valid=timingSafeEqual(hash,Buffer.from(current.hash,'hex'));}}
      finally{verifying--;}
      if(!valid){send(401,page(basePath,'密码不正确，请重试。'),'text/html; charset=utf-8');return true;}
      attempts.delete(ip);if(sessions.size>=100)sessions.delete(sessions.keys().next().value);
      signedIn();return true;
    }
    if(path==='/auth/logout'&&req.method==='POST'){
      if(req.headers.origin!==origin){send(403,{error:'操作来源无效'});return true;}
      sessions.delete(key);res.setHeader('Set-Cookie',`dustoff_session=; ${cookieOptions}; Max-Age=0`);res.setHeader('Location',basePath+'/');send(303,'','text/plain');return true;
    }
    if(!authorized){
      if(path==='/'&&req.method==='GET')send(200,page(basePath),'text/html; charset=utf-8');else send(401,{error:'请先登录控制台'});
      return true;
    }
    return false;
  }
  return {handle};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv[2]==='create-setup')console.log(createPasswordSetup(DUST_HOME));
  else if(process.argv[2]==='set-password'){await setConsolePassword(DUST_HOME,readFileSync(0,'utf8').replace(/\r?\n$/,''));console.log('控制台访问密码已更新');}
  else throw new Error('用法：set-password 从标准输入设置密码；create-setup 创建一次性设置链接');
}

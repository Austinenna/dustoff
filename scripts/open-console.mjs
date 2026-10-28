#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, statSync, renameSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUST_HOME } from './config.mjs';
import { localPath } from './policy.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const remoteFile=join(DUST_HOME,'server.json');
if(existsSync(remoteFile)){
  const saved=JSON.parse(readFileSync(remoteFile,'utf8')),remote=new URL(saved.url);
  if(saved.version!==1||remote.protocol!=='https:'||remote.username||remote.password||remote.search||remote.hash)throw new Error('服务器入口配置无效');
  if(!process.argv.includes('--no-open'))execFileSync('/usr/bin/open',[remote.href],{timeout:10000});
  console.log(`dustoff 已迁移到服务器：${remote.href}`);process.exit(0);
}
const port=Number(process.env.DUST_CONSOLE_PORT||47831);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('DUST_CONSOLE_PORT 应为 1024–65535');
const url=`http://127.0.0.1:${port}`;
async function running(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1000)});const data=await r.json();if(data.app!=='dustoff'||data.root!==root||data.home!==DUST_HOME)throw new Error('端口已被其他服务或另一份 dustoff 占用，请设置其他 DUST_CONSOLE_PORT');return true;}catch(e){if(e.message.startsWith('端口'))throw e;return false;}}
if(!await running()){
  const dir=localPath(join(DUST_HOME,'console'));mkdirSync(dir,{recursive:true,mode:0o700});
  const log=join(dir,'service.log');if(existsSync(log)&&statSync(log).size>1024**2)renameSync(log,join(dir,'service.previous.log'));
  const fd=openSync(log,'a',0o600);
  const child=spawn(process.execPath,[join(root,'console.mjs'),'--port',String(port)],{cwd:root,detached:true,stdio:['ignore',fd,fd],env:process.env});
  child.on('error',e=>console.error(e.message));child.unref();closeSync(fd);
  let ready=false;
  for(let n=0;n<40;n++){if(await running()){ready=true;break;}await new Promise(r=>setTimeout(r,150));}
  if(!ready)throw new Error(`控制台没有启动，请查看 ${log}`);
}
if(!process.argv.includes('--no-open'))execFileSync('/usr/bin/open',[url],{timeout:10000});
console.log(`dustoff 控制台已就绪：${url}`);

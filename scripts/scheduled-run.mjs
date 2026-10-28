#!/usr/bin/env node
// launchd 的薄封装：继续调用原日常入口；只保留最新启动日志（最多 1 MiB）。
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, localPath } from './policy.mjs';
import {makePlan,dueOccurrence,scheduleKey} from './schedule-plan.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = localPath(process.argv[2]);
mkdirSync(directory, { recursive:true, mode:0o700 });
const logfile = join(directory,'latest-run.log');
const resultfile = join(directory,'last-run.json');
// launchd 只负责日历唤起；日期起点、跨日间隔和去重在这里判断。
// 未到本轮时刻时直接退出，不改业务日志、不启动流水线。
let scheduledFor=null,key=null;
if(process.env.DUST_SCHEDULE_PLAN||process.env.DUST_SCHEDULE_START_AT||process.env.DUST_SCHEDULE_INTERVAL_HOURS){
  const plan=makePlan(process.env.DUST_SCHEDULE_PLAN?JSON.parse(readFileSync(localPath(process.env.DUST_SCHEDULE_PLAN),'utf8')):{time:process.env.DUST_SCHEDULE_TIME,intervalHours:Number(process.env.DUST_SCHEDULE_INTERVAL_HOURS),startAt:process.env.DUST_SCHEDULE_START_AT});
  let previous=null;try{previous=JSON.parse(readFileSync(resultfile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  scheduledFor=dueOccurrence(plan,previous);if(!scheduledFor)process.exit(0);
  key=scheduleKey(plan);
}
const maxBytes = 1024 ** 2;
let fd = openSync(logfile,'w',0o600), written = 0;
function log(data) {
  let bytes = Buffer.from(data);
  if (bytes.length > maxBytes) bytes = bytes.subarray(bytes.length - maxBytes);
  if (written + bytes.length > maxBytes) { closeSync(fd); fd = openSync(logfile,'w',0o600); written = 0; }
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd,bytes,offset,bytes.length-offset);
  written += bytes.length;
}
const record = { ...(key?{scheduleKey:key,scheduledFor}:{}), startedAt:new Date().toISOString(), finishedAt:null, pid:process.pid, args:process.argv.slice(3), exitCode:null, signal:null };
atomicWrite(resultfile,JSON.stringify(record,null,2)+'\n');
log(`[${record.startedAt}] 定时启动 run.mjs\n`);
const child = spawn(process.execPath,[join(root,'run.mjs'),...record.args],{ cwd:root, env:process.env, stdio:['ignore','pipe','pipe'] });
child.stdout.on('data',log);
child.stderr.on('data',log);
child.on('error',error => { record.error = error.message; log(`${error.message}\n`); });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => child.kill(signal));
child.on('close',(code,signal) => {
  record.finishedAt = new Date().toISOString();
  record.exitCode = code ?? 1;
  record.signal = signal;
  atomicWrite(resultfile,JSON.stringify(record,null,2)+'\n');
  log(`[${record.finishedAt}] 结束，退出码 ${record.exitCode}${signal ? `，信号 ${signal}` : ''}\n`);
  closeSync(fd);
  process.exitCode = record.exitCode;
});

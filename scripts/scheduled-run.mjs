#!/usr/bin/env node
// launchd 的薄封装：继续调用原日常入口；只保留最新启动日志（最多 1 MiB）。
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, localPath } from './policy.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = localPath(process.argv[2]);
mkdirSync(directory, { recursive:true, mode:0o700 });
const logfile = join(directory,'latest-run.log');
const resultfile = join(directory,'last-run.json');
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
const record = { startedAt:new Date().toISOString(), finishedAt:null, pid:process.pid, args:process.argv.slice(3), exitCode:null, signal:null };
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

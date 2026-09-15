#!/usr/bin/env node
// 默认只在当前登录会话运行；可显式设置登录后自动启用。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { DUST_HOME } from './config.mjs';
import { atomicWrite, localPath } from './policy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const LABEL = 'com.dustoff.daily';
export {parseTime} from './schedule-plan.mjs';
import {parseTime,parseInterval,makePlan,nextOccurrence,calendarSlots} from './schedule-plan.mjs';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
function command(program, args, { optional = false } = {}) {
  const result = spawnSync(program, args, { encoding:'utf8', timeout:15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !optional) throw new Error(`${program} ${args[0]} 失败：${result.stderr.trim() || result.stdout.trim()}`);
  return result;
}
export function createScheduler({ home = DUST_HOME, directory = join(home, 'scheduler'), label = LABEL, root = ROOT, node = process.execPath, runArgs = [], autoDirectory = join(homedir(),'Library','LaunchAgents') } = {}) {
  directory = localPath(directory);
  const plist = join(directory, 'daily.plist');
  const autoPlist = localPath(join(autoDirectory, `${label}.plist`));
  function readAuto() {
    if (!existsSync(autoPlist)) return null;
    const data=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',autoPlist]).stdout);
    if (data.Label!==label) throw new Error('登录自动启动文件名称冲突，请先检查现有配置');
    return readFileSync(autoPlist,'utf8');
  }
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${label}`;
  const latest = join(directory, 'latest-run.log');
  const resultFile = join(directory, 'last-run.json');
  function inspect() {
    const result = command('/bin/launchctl', ['print', target], { optional:true });
    if (result.status !== 0) {
      if (/Could not find service/.test(result.stderr)) return { loaded:false, running:false, runs:0 };
      throw new Error(`无法查询当前登录会话的定时器：${result.stderr.trim()}`);
    }
    const output = result.stdout;
    return { loaded:true, running:/^\s*state = running$/m.test(output), pid:Number(output.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
      runs:Number(output.match(/^\s*runs = (\d+)$/m)?.[1]) || 0, lastExitCode:output.match(/^\s*last exit code = (.+)$/m)?.[1] ?? null };
  }
  function settings() {
    if (!existsSync(plist)) return {time:'22:00',intervalHours:24,startAt:null};
    const data=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',plist]).stdout);
    if(data.Label!==label)throw new Error('定时配置的任务名称不匹配');
    const env=data.EnvironmentVariables||{};
    if(env.DUST_SCHEDULE_START_AT){return makePlan({time:env.DUST_SCHEDULE_TIME,intervalHours:Number(env.DUST_SCHEDULE_INTERVAL_HOURS),startAt:env.DUST_SCHEDULE_START_AT});}
    const {Hour,Minute}=data.StartCalendarInterval??{};
    const time=`${String(Hour).padStart(2,'0')}:${String(Minute).padStart(2,'0')}`;parseTime(time);
    return {time,intervalHours:24,startAt:null};
  }
  function render(value) {
    const plan=typeof value==='string'?makePlan({time:value}):makePlan(value);
    const slots=calendarSlots(plan.time,plan.intervalHours);
    const calendar=slot=>`<dict><key>Hour</key><integer>${slot.Hour}</integer><key>Minute</key><integer>${slot.Minute}</integer></dict>`;
    const args = [node, join(root,'scripts/scheduled-run.mjs'), directory, ...runArgs];
    const path = [...new Set([dirname(node), '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'])].join(':');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${args.map(v => `<string>${xml(v)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>DUST_HOME</key><string>${xml(resolve(home))}</string>
    <key>PATH</key><string>${xml(path)}</string>
    <key>DUST_SCHEDULE_TIME</key><string>${xml(plan.time)}</string>
    <key>DUST_SCHEDULE_START_AT</key><string>${xml(plan.startAt)}</string>
    <key>DUST_SCHEDULE_INTERVAL_HOURS</key><string>${plan.intervalHours}</string>
  </dict>
  <key>StartCalendarInterval</key>${slots.length===1?calendar(slots[0]):`<array>${slots.map(calendar).join('')}</array>`}
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
  }
  function configure(value, shouldStart, auto = existsSync(autoPlist)) {
    if (typeof auto !== 'boolean') throw new Error('自动启用选项必须为布尔值');
    const plan=typeof value==='string'?makePlan({time:value}):makePlan(value); // 非法输入不得影响已加载的任务。
    for (const path of [node, join(root,'run.mjs'), join(root,'scripts/scheduled-run.mjs')]) {
      if (!existsSync(path)) throw new Error(`运行文件不存在：${path}`);
    }
    const state = inspect();
    const next = render(plan);
    const old = existsSync(plist) ? readFileSync(plist,'utf8') : null;
    const oldAuto=readAuto();
    if (old === next && (!shouldStart || state.loaded) && (auto ? oldAuto===next : oldAuto===null)) return status();
    if (state.running || state.pid) throw new Error('定时批次正在执行，请等本轮结束后再修改时间或重新加载；现有任务保持运行');
    mkdirSync(directory, { recursive:true, mode:0o700 });
    // 先校验候选 plist，再卸载原任务；变更失败时恢复原定义。
    const candidate = join(directory, `candidate-${process.pid}.plist`);
    try {
      atomicWrite(candidate, next);
      command('/usr/bin/plutil', ['-lint',candidate]);
    } finally { rmSync(candidate, { force:true }); }
    // 先确认自动启动目录可写，避免权限错误发生在卸载原定时之后。
    if(auto) {
      const probe=`${autoPlist}.candidate-${process.pid}`;
      try { atomicWrite(probe,next); } finally { rmSync(probe,{force:true}); }
    }
    if (state.loaded) command('/bin/launchctl', ['bootout',target]);
    try {
      atomicWrite(plist,next);
      if (auto) atomicWrite(autoPlist,next); else if(oldAuto!==null) rmSync(autoPlist);
      if (shouldStart || state.loaded) command('/bin/launchctl', ['bootstrap',domain,plist]);
    } catch (error) {
      if (old !== null) atomicWrite(plist,old); else rmSync(plist,{ force:true });
      if (oldAuto!==null) atomicWrite(autoPlist,oldAuto); else rmSync(autoPlist,{force:true});
      if (state.loaded) {
        try { command('/bin/launchctl', ['bootstrap',domain,plist]); }
        catch (rollback) { throw new Error(`${error.message}；恢复旧任务也失败：${rollback.message}`); }
      }
      throw error;
    }
    return status();
  }
  function status() {
    const state=inspect(),plan=settings();
    return { ...state,...plan,nextRun:state.loaded?nextOccurrence(plan):null, timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, autoStartAfterReboot:readAuto()!==null,
      target, plist, latestLog:latest, lastRun:existsSync(resultFile) ? JSON.parse(readFileSync(resultFile,'utf8')) : null };
  }
  function stop() {
    const state = inspect();
    const oldAuto = readAuto();
    if (state.running || state.pid) throw new Error('定时批次正在执行，请等本轮结束后再关闭定时，避免中断正在处理的作品');
    if (state.loaded) command('/bin/launchctl', ['bootout',target]);
    try { if(oldAuto!==null) rmSync(autoPlist); }
    catch(error) { if(state.loaded) command('/bin/launchctl',['bootstrap',domain,plist]); throw error; }
    return status();
  }
  function update({time,intervalHours,autoStartAfterReboot=existsSync(autoPlist)}={}) {
    const previous=settings();time??=previous.time;intervalHours??=previous.intervalHours;
    parseTime(time);parseInterval(intervalHours);
    const unchanged=time===previous.time&&intervalHours===previous.intervalHours;
    return configure(makePlan({time,intervalHours,startAt:unchanged?previous.startAt:null}),false,autoStartAfterReboot);
  }
  function start(value) {
    const previous=settings();
    const plan=makePlan({...previous,...(value!==undefined?{time:value,startAt:value===previous.time?previous.startAt:null}:{})});
    // 重新开启已过期的计划时，从下一次起始时刻重新开始，避免立即补跑停用期间任务。
    if(!inspect().loaded&&Date.parse(plan.startAt)<=Date.now())plan.startAt=makePlan({time:plan.time,intervalHours:plan.intervalHours}).startAt;
    return configure(plan,true);
  }
  return {status,start,setTime:value=>update({time:value}),update,stop,render,target,plist,autoPlist};
}

function main(args) {
  if (args.length === 0 || args[0] === '--help') {
    console.log('间隔定时（默认仅当前登录会话，可显式启用登录自动加载）\n  node scripts/schedule.mjs start [HH:MM]  开启定时，默认/保留 22:00\n  node scripts/schedule.mjs time HH:MM     改时间；已开启则立即更新，已关闭则只保存\n  node scripts/schedule.mjs interval HOURS  设置重复间隔（1–720 整数小时）\n  node scripts/schedule.mjs status         查看真实加载状态\n  node scripts/schedule.mjs stop           关闭定时及登录自动加载，保留时间\n  node scripts/schedule.mjs autostart on|off  登录后自动启用\n\n立即处理一轮：node run.mjs');
    return;
  }
  if (process.platform !== 'darwin') throw new Error('这个定时入口使用 macOS launchd');
  const [action, value, extra] = args;
  if(action==='autostart' && ['on','off'].includes(value) && !extra) { console.log(JSON.stringify(createScheduler().update({autoStartAfterReboot:value==='on'}),null,2)); return; }
  if (!['start','time','interval','status','stop'].includes(action) || extra !== undefined || (['status','stop'].includes(action) && value !== undefined)) throw new Error('参数不正确，使用 --help 查看用法');
  if(action==='interval')parseInterval(Number(value));else if (action === 'time' || value !== undefined) parseTime(value);
  const scheduler = createScheduler();
  const state = action === 'interval' ? scheduler.update({intervalHours:Number(value)}) : action === 'time' ? scheduler.setTime(value) : action === 'start' ? scheduler.start(value) : scheduler[action]();
  console.log(JSON.stringify(state,null,2));
  console.log(`起始 ${state.time}，每 ${state.intervalHours} 小时（${state.timezone}）：${state.loaded ? state.running ? '正在执行' : '已开启，等待触发' : '已关闭'}；${state.autoStartAfterReboot ? '登录后自动启用' : '重启/注销后需手动开启'}。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

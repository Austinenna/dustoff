import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler, parseTime } from '../scripts/schedule.mjs';

test('时刻严格校验，错误输入不得被截断成有效时间', () => {
  assert.deepEqual(parseTime('00:00'), { Hour:0, Minute:0 });
  assert.deepEqual(parseTime('23:59'), { Hour:23, Minute:59 });
  for (const value of ['24:00','22:60','9:00','22:00extra','',undefined]) assert.throws(() => parseTime(value));
});

test('plist 为每天一次、无立即启动、无常驻；路径转义后仍可正确解析', () => {
  const directory = mkdtempSync(join(tmpdir(),'dustoff-schedule-xml-'));
  try {
    const scheduler = createScheduler({ directory, root:'/tmp/space & 中文 "dir"', home:'/tmp/a & b' });
    const result = spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{ input:scheduler.render('22:00'), encoding:'utf8' });
    assert.equal(result.status,0,result.stderr);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.StartCalendarInterval,{ Hour:22,Minute:0 });
    assert.equal(data.RunAtLoad,false);
    assert.equal(data.KeepAlive,false);
    assert.equal(data.WorkingDirectory,'/tmp/space & 中文 "dir"');
    assert.equal(data.EnvironmentVariables.DUST_HOME,'/tmp/a & b');
    assert.ok(!scheduler.plist.includes('/Library/LaunchAgents/'));
  } finally { rmSync(directory,{ recursive:true,force:true }); }
});

// 显式运行此检查会真实加载/触发/移除一个临时 launchd 任务。
// 使用正式账本的 --dry-run，不扫描、不下载、不调用 ASR/LLM。
test('真实 launchd：启停、改时间、幂等加载与日常入口连通', { skip:process.env.DUST_SCHEDULER_INTEGRATION !== '1' }, async () => {
  const directory = mkdtempSync(join(tmpdir(),'dustoff-schedule-live-'));
  const scheduler = createScheduler({ directory, label:`com.dustoff.verify.${process.pid}`, runArgs:['--dry-run'] });
  const later = new Date(Date.now() + 6 * 3600_000);
  const time = date => `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
  const first = time(later), second = time(new Date(later.getTime()+60_000));
  try {
    assert.equal(scheduler.status().loaded,false);
    const started = scheduler.start(first);
    assert.equal(started.loaded,true);
    assert.equal(started.runs,0);
    assert.equal(scheduler.start(first).runs,0);
    assert.throws(() => scheduler.setTime('25:00'));
    assert.equal(scheduler.status().time,first);
    const changed = scheduler.setTime(second);
    assert.equal(changed.loaded,true);
    assert.equal(changed.time,second);
    assert.equal(changed.runs,0);
    const triggered = spawnSync('/bin/launchctl',['kickstart',scheduler.target],{ encoding:'utf8' });
    assert.equal(triggered.status,0,triggered.stderr);
    let status;
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve,200));
      status = scheduler.status();
      if (status.lastRun?.finishedAt && !status.running) break;
    }
    assert.ok(status.lastRun?.finishedAt,'日常入口未在 20 秒内结束');
    assert.equal(status.lastRun.exitCode,0);
    assert.equal(status.runs,1);
    assert.match(readFileSync(join(directory,'latest-run.log'),'utf8'),/已建基线；待办/);
    assert.equal(scheduler.stop().loaded,false);
    assert.equal(scheduler.setTime(first).loaded,false);
    const restarted = scheduler.start();
    assert.equal(restarted.loaded,true);
    assert.equal(restarted.time,first);
    assert.equal(restarted.runs,0);
    assert.equal(scheduler.stop().loaded,false);
  } finally {
    spawnSync('/bin/launchctl',['bootout',scheduler.target]);
    rmSync(directory,{ recursive:true,force:true });
  }
});

test('隔离 launchd：登录自动启用、时间同步、关闭清理以及写入失败保留旧任务', { skip:process.env.DUST_CONSOLE_LAUNCHD !== '1' }, async()=>{
  const {existsSync,writeFileSync}=await import('node:fs');
  const home=mkdtempSync(join(tmpdir(),'dustoff-console-launchd-'));
  const scheduler=createScheduler({home,directory:join(home,'scheduler'),autoDirectory:join(home,'login-agents'),label:`com.dustoff.console-test.${process.pid}`,runArgs:['--dry-run']});
  const first='03:17',second='03:18';
  try{
    scheduler.update({time:first,autoStartAfterReboot:true});
    assert.equal(scheduler.status().loaded,false);
    assert.equal(existsSync(scheduler.autoPlist),true);
    scheduler.start();assert.equal(scheduler.status().loaded,true);
    scheduler.setTime(second);
    const saved=JSON.parse(spawnSync('/usr/bin/plutil',['-convert','json','-o','-',scheduler.autoPlist],{encoding:'utf8'}).stdout);
    assert.deepEqual(saved.StartCalendarInterval,{Hour:3,Minute:18});
    assert.equal(scheduler.status().autoStartAfterReboot,true);
    scheduler.stop();assert.equal(existsSync(scheduler.autoPlist),false);assert.equal(scheduler.status().loaded,false);
    scheduler.start();
    const blocked=createScheduler({home,directory:join(home,'scheduler'),autoDirectory:join(home,'not-a-directory'),label:`com.dustoff.console-test.${process.pid}`,runArgs:['--dry-run']});
    writeFileSync(join(home,'not-a-directory'),'fixture');
    assert.throws(()=>blocked.update({time:first,autoStartAfterReboot:true}));
    assert.equal(scheduler.status().loaded,true);assert.equal(scheduler.status().time,second);
  }finally{spawnSync('/bin/launchctl',['bootout',scheduler.target]);rmSync(home,{recursive:true,force:true});}
});

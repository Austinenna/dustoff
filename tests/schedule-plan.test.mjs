import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {makePlan,nextOccurrence,dueOccurrence,scheduleKey,parseInterval,calendarSlots} from '../scripts/schedule-plan.mjs';
import {createScheduler} from '../scripts/schedule.mjs';
const anchor='2026-09-15T14:00:00.000Z';
const plan=makePlan({time:'22:00',intervalHours:12,startAt:anchor});
test('固定起点加间隔：跨日、非整除一天、超过一天，计算不受运行耗时影响',()=>{
  assert.equal(nextOccurrence(plan,Date.parse(anchor)), '2026-09-16T02:00:00.000Z');
  assert.equal(nextOccurrence({...plan,intervalHours:5},Date.parse('2026-09-16T12:00:00Z')), '2026-09-16T15:00:00.000Z');
  assert.equal(nextOccurrence({...plan,intervalHours:36},Date.parse(anchor)), '2026-09-17T02:00:00.000Z');
  assert.equal(nextOccurrence(plan,Date.parse(anchor)-1),anchor);
  assert.equal(dueOccurrence(plan,null,Date.parse(anchor)-1),null);
  assert.equal(dueOccurrence(plan,null,Date.parse(anchor)),anchor);
  for(const x of [0,-1,0.5,'12',721,NaN])assert.throws(()=>parseInterval(x));
});
test('错过多个时刻只补最新一轮，同一时刻去重；上一轮跨过的时刻不追赶',()=>{
  const now=Date.parse('2026-09-17T03:00:00Z'),due='2026-09-17T02:00:00.000Z';
  assert.equal(dueOccurrence(plan,null,now),due);
  assert.equal(dueOccurrence(plan,{scheduleKey:scheduleKey(plan),scheduledFor:due},now),null);
  assert.equal(dueOccurrence(plan,{scheduleKey:scheduleKey(plan),scheduledFor:anchor,finishedAt:'2026-09-17T02:30:00Z'},now),null);
  assert.equal(dueOccurrence(plan,{scheduleKey:'old',scheduledFor:due},now),due);
});
test('12 小时计划生成 22 点与 10 点的 launchd 定义，携带固定日期起点',()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-interval-plist-'));
  try{
    const scheduler=createScheduler({home});
    const parsed=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:scheduler.render(plan),encoding:'utf8'});
    assert.equal(parsed.status,0,parsed.stderr);const data=JSON.parse(parsed.stdout);
    assert.deepEqual(data.StartCalendarInterval,[{Hour:22,Minute:0},{Hour:10,Minute:0}]);
    assert.equal(data.EnvironmentVariables.DUST_SCHEDULE_START_AT,anchor);
    assert.equal(data.EnvironmentVariables.DUST_SCHEDULE_INTERVAL_HOURS,'12');
    assert.equal(data.RunAtLoad,false);assert.equal(data.KeepAlive,false);
    assert.equal(calendarSlots('22:15',5).length,24);
  }finally{rmSync(home,{recursive:true,force:true});}
});
test('真实定时入口未到起点或本轮已执行时，不启动业务、不改写现有日志',()=>{
  const home=mkdtempSync(join(tmpdir(),'dustoff-interval-gate-'));
  const future=new Date(Math.ceil(Date.now()/60000)*60000+86400000).toISOString();
  const env={...process.env,DUST_HOME:home,DUST_SCHEDULE_TIME:'22:00',DUST_SCHEDULE_INTERVAL_HOURS:'12',DUST_SCHEDULE_START_AT:future};
  try{
    let result=spawnSync(process.execPath,['scripts/scheduled-run.mjs',home],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(existsSync(join(home,'last-run.json')),false);assert.equal(existsSync(join(home,'index.sqlite')),false);
    const past=new Date(Math.floor(Date.now()/60000)*60000-3600000).toISOString();env.DUST_SCHEDULE_START_AT=past;
    const previous=JSON.stringify({scheduleKey:`${past}/12`,scheduledFor:past});
    writeFileSync(join(home,'last-run.json'),previous);writeFileSync(join(home,'latest-run.log'),'existing log');
    result=spawnSync(process.execPath,['scripts/scheduled-run.mjs',home],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(home,'last-run.json'),'utf8'),previous);assert.equal(readFileSync(join(home,'latest-run.log'),'utf8'),'existing log');
  }finally{rmSync(home,{recursive:true,force:true});}
});

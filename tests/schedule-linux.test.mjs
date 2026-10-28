import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLinuxScheduler} from '../scripts/schedule-linux.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(){
  const home=mkdtempSync(join(tmpdir(),'dustoff-systemd-')),calls=[];
  let loaded=false,enabled=false,running=false,fail=false;
  const command=args=>{
    calls.push(args);
    if(args[0]==='show')return args[1].endsWith('.timer')?`LoadState=loaded\nActiveState=${loaded?'active':'inactive'}\nUnitFileState=${enabled?'enabled':'disabled'}\n`:`LoadState=loaded\nActiveState=${running?'activating':'inactive'}\nMainPID=${running?123:0}\nExecMainStatus=0\n`;
    if(fail&&args[0]==='daemon-reload'){fail=false;throw new Error('fixture reload failure');}
    if(args[0]==='enable')enabled=true;if(args[0]==='disable')enabled=false;
    if(args[0]==='start'||args[0]==='restart')loaded=true;if(args[0]==='stop')loaded=false;
    return '';
  };
  const scheduler=createLinuxScheduler({home,root,unitDirectory:join(home,'units'),command});
  return {home,calls,scheduler,running:value=>running=value,fail:()=>fail=true,cleanup:()=>rmSync(home,{recursive:true,force:true})};
}
test('systemd 支持保存、启停、重启自动运行和幂等更新，不立即补跑',()=>{
  const f=fixture();try{
    const s=f.scheduler;
    assert.equal(s.update({time:'22:00',intervalHours:12,autoStartAfterReboot:true}).loaded,false);
    const units=s.render({time:'22:00',intervalHours:12});
    assert.match(units.timer,/OnCalendar=\*-\*-\* 22:00:00/);assert.match(units.timer,/OnCalendar=\*-\*-\* 10:00:00/);
    assert.match(units.timer,/Persistent=false/);assert.doesNotMatch(units.timer,/OnBootSec/);
    assert.match(units.service,/DUST_SCHEDULE_PLAN/);assert.match(units.service,/KillMode=control-group/);
    const started=s.start();assert.equal(started.loaded,true);assert.equal(started.autoStartAfterReboot,true);assert.ok(Date.parse(started.nextRun)>Date.now());
    const n=f.calls.filter(c=>c[0]==='restart').length;s.start();assert.equal(f.calls.filter(c=>c[0]==='restart').length,n);
    s.update({time:'21:00'});assert.equal(s.status().time,'21:00');assert.equal(s.status().loaded,true);
    s.stop();assert.equal(s.status().loaded,false);assert.equal(s.status().autoStartAfterReboot,false);
  }finally{f.cleanup();}
});
test('systemd 运行中拒绝修改，加载失败恢复之前计划与单元',()=>{
  const f=fixture();try{
    const s=f.scheduler;s.start('22:00');const before=readFileSync(s.planFile,'utf8'),timer=readFileSync(s.timerPath,'utf8');
    f.running(true);assert.throws(()=>s.stop(),/正在执行/);assert.throws(()=>s.update({time:'21:00'}),/正在执行/);f.running(false);
    f.fail();assert.throws(()=>s.update({time:'21:00'}),/reload failure/);
    assert.equal(readFileSync(s.planFile,'utf8'),before);assert.equal(readFileSync(s.timerPath,'utf8'),timer);assert.equal(s.status().loaded,true);
    assert.throws(()=>s.update({intervalHours:0}));assert.equal(readFileSync(s.planFile,'utf8'),before);
  }finally{f.cleanup();}
});

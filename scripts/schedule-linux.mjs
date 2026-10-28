import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {DUST_HOME} from './config.mjs';
import {atomicWrite,localPath} from './policy.mjs';
import {makePlan,parseTime,parseInterval,nextOccurrence,calendarSlots} from './schedule-plan.mjs';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const quote=value=>'"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%').replace(/\$/g,'$$$&')+'"';
function systemctl(args,{optional=false}={}) {
  const r=spawnSync('/usr/bin/systemctl',['--user',...args],{encoding:'utf8',timeout:15000,env:{...process.env,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||`/run/user/${process.getuid()}`}});
  if(r.error)throw r.error;
  if(r.status!==0&&!(optional&&r.stdout?.includes('LoadState=not-found')))throw new Error(`systemd ${args[0]} 失败：${r.stderr.trim()||r.stdout.trim()}`);
  return r.stdout;
}
export function createLinuxScheduler({home=DUST_HOME,directory=join(home,'scheduler'),label='dustoff-daily',root=ROOT,node=process.execPath,runArgs=[],unitDirectory=join(homedir(),'.config/systemd/user'),command=systemctl}={}) {
  if(!/^[a-zA-Z0-9_.-]+$/.test(label))throw new Error('定时器名称无效');
  directory=localPath(directory);unitDirectory=localPath(unitDirectory);
  const timerName=label+'.timer',serviceName=label+'.service',timerPath=join(unitDirectory,timerName),servicePath=join(unitDirectory,serviceName),planFile=join(directory,'plan.json'),resultFile=join(directory,'last-run.json');
  const read=file=>existsSync(file)?readFileSync(file,'utf8'):null;
  const settings=()=>{const text=read(planFile);return text?JSON.parse(text):{time:'22:00',intervalHours:24,startAt:null,autoStartAfterReboot:true};};
  function inspect(unit) {
    const output=command(['show',unit,'--property=LoadState,ActiveState,UnitFileState,MainPID,ExecMainStatus'],{optional:true});
    return Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  }
  function status(){
    const timer=inspect(timerName),service=inspect(serviceName),saved=settings();
    const loaded=timer.ActiveState==='active',running=['active','activating','deactivating'].includes(service.ActiveState);
    return {...saved,backend:'systemd',loaded,running,pid:Number(service.MainPID)||null,autoStartAfterReboot:timer.UnitFileState==='enabled',nextRun:loaded?nextOccurrence(saved):null,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,lastExitCode:Number(service.ExecMainStatus)||0,target:timerName,latestLog:join(directory,'latest-run.log'),lastRun:read(resultFile)?JSON.parse(read(resultFile)):null};
  }
  function render(value){
    const plan=makePlan(typeof value==='string'?{time:value}:value);
    const calendar=calendarSlots(plan.time,plan.intervalHours).map(s=>`OnCalendar=*-*-* ${String(s.Hour).padStart(2,'0')}:${String(s.Minute).padStart(2,'0')}:00`).join('\n');
    return {
      service:`[Unit]\nDescription=Dustoff scheduled collection\n\n[Service]\nType=oneshot\nWorkingDirectory=${quote(root)}\nExecStart=${[node,join(root,'scripts/scheduled-run.mjs'),directory,...runArgs].map(quote).join(' ')}\nEnvironment=${quote('DUST_HOME='+resolve(home))}\nEnvironment=${quote('DUST_SCHEDULE_PLAN='+planFile)}\nEnvironment=${quote('DUST_CHROME=/usr/bin/google-chrome')}\nEnvironment=${quote('PATH='+dirname(node)+':/usr/local/bin:/usr/bin:/bin')}\nEnvironment=TZ=Asia/Shanghai\nUMask=0077\nKillMode=control-group\nTimeoutStartSec=infinity\nTimeoutStopSec=30\nNice=10\n\n`,
      timer:`[Unit]\nDescription=Dustoff collection schedule\n\n[Timer]\n${calendar}\nUnit=${serviceName}\nPersistent=false\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n`,
    };
  }
  function configure(plan,wantLoaded,auto){
    if(typeof auto!=='boolean')throw new Error('自动启用选项必须为布尔值');
    plan=makePlan(plan);const before=status();
    if(before.running)throw new Error('定时批次正在执行，请等本轮结束后修改安排');
    for(const file of [node,join(root,'run.mjs'),join(root,'scripts/scheduled-run.mjs')])if(!existsSync(file))throw new Error('定时运行文件不存在');
    const units=render(plan),next=new Map([[planFile,JSON.stringify({...plan,autoStartAfterReboot:auto},null,2)+'\n'],[servicePath,units.service],[timerPath,units.timer]]);
    const old=new Map([...next].map(([file])=>[file,read(file)]));
    if([...next].every(([file,text])=>old.get(file)===text)&&before.loaded===wantLoaded&&before.autoStartAfterReboot===auto)return before;
    try {
      for(const [file,text] of next)atomicWrite(file,text);
      command(['daemon-reload']);command([auto?'enable':'disable',timerName]);
      command([wantLoaded?(before.loaded?'restart':'start'):'stop',timerName]);
    } catch(error){
      try {
        for(const [file,text] of old)if(text===null)rmSync(file,{force:true});else atomicWrite(file,text);
        command(['daemon-reload']);
        if(old.get(timerPath)!==null){command([before.autoStartAfterReboot?'enable':'disable',timerName]);command([before.loaded?'restart':'stop',timerName]);}
      }catch(rollback){throw new Error(`${error.message}；恢复旧安排失败：${rollback.message}`);}
      throw error;
    }
    return status();
  }
  function update({time,intervalHours,autoStartAfterReboot}={}){
    const previous=settings(),state=status();time??=previous.time;intervalHours??=previous.intervalHours;autoStartAfterReboot??=previous.autoStartAfterReboot;
    parseTime(time);parseInterval(intervalHours);
    return configure(makePlan({time,intervalHours,startAt:time===previous.time&&intervalHours===previous.intervalHours?previous.startAt:null}),state.loaded,autoStartAfterReboot);
  }
  function start(time){
    const previous=settings(),state=status();
    const plan=makePlan({...previous,...(time!==undefined?{time,startAt:time===previous.time?previous.startAt:null}:{})});
    if(!state.loaded&&Date.parse(plan.startAt)<=Date.now())plan.startAt=makePlan({time:plan.time,intervalHours:plan.intervalHours}).startAt;
    return configure(plan,true,previous.autoStartAfterReboot);
  }
  function stop(){const previous=settings();return configure(makePlan(previous),false,false);}
  return {status,start,stop,update,setTime:time=>update({time}),render,target:timerName,timerPath,servicePath,planFile};
}

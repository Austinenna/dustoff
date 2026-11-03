import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
function isolated(source){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-scan-recovery-')));
  try{
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),env:{...process.env,DUST_HOME:home,DUST_NOTIFY:'0'},encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  }finally{rmSync(home,{recursive:true,force:true});}
}

test('正常运行遇到扫描缺页、边界不匹配或扫描进程错误，仍保存手动确认的视频',()=>isolated(`
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import {spawnSync} from 'node:child_process';
  import {readFileSync,existsSync} from 'node:fs';
  import {join} from 'node:path';
  const file=join(process.env.DUST_HOME,'fixture.mp4');
  const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-preset','ultrafast','-c:a','aac',file]);assert.equal(made.status,0,String(made.stderr));
  const bytes=readFileSync(file);let downloads=0;
  const server=createServer((req,res)=>{downloads++;res.setHeader('Content-Type','video/mp4');res.end(bytes);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port+'/video';
  const {acceptScan,baseline,setPurpose,pendingQueue}=await import('./scripts/daily.mjs');
  const {db,markRouting}=await import('./scripts/ledger.mjs');
  const {main}=await import('./run.mjs');
  const seed={aweme_id:'100',duration_s:1};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  const ids=['1','2','3'];
  acceptScan({ok:true,logged_in:true,truncated:false,items:[...ids.map(aweme_id=>({aweme_id,desc:'用途不明确',duration_s:1})),seed]});
  for(const id of ids)markRouting(id,{purpose:'review',reason:'待用户确认',model:'fixture'});
  const before=baseline();
  const cases=[
    ()=>({ok:false,logged_in:true,scan_error:'收藏分页缺失或尚未读完',items:[{aweme_id:'999',duration_s:1}]}),
    ()=>({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'999',duration_s:1}]}),
    ()=>{throw new Error('浏览器读取超时');},
  ];
  try{
    for(let n=0;n<cases.length;n++){
      const id=ids[n];setPurpose(id,'video');let refreshed=0;
      const result=await main([], {runScript:async(name,args)=>{
        if(name==='get_collection.mjs')return cases[n]();
        assert.equal(name,'get_meta.mjs');assert.ok(args[0].endsWith('/'+id));refreshed++;
        return {ok:true,aweme_id:id,desc:'手动保存的视频',duration_s:1,play_urls:[url],video_options:{high:{gear:'high',urls:[url]},standard:{gear:'default',urls:[url]}}};
      }});
      assert.ok(result.scanWarning);assert.equal(result.paused,null);assert.deepEqual(result.failures,[]);assert.equal(result.saved,1);assert.equal(result.processed,1);assert.equal(refreshed,1);
      const row=db().prepare('SELECT * FROM items WHERE id=?').get(id);assert.equal(row.status,'saved');assert.equal(row.routing_source,'manual');assert.ok(existsSync(row.media_path));
      assert.deepEqual(baseline(),before);assert.equal(db().prepare("SELECT id FROM items WHERE id='999'").get(),undefined);assert.equal(pendingQueue().length,0);
      assert.equal(process.exitCode,2);process.exitCode=0; // 扫描受阻记 2（运行记录里提醒），下载成果已经成功，不算服务失败。
    }
    assert.equal(downloads,3);
  }finally{await new Promise(r=>server.close(r));}
`));

test('首次基线扫描失败仍停止，不把不可靠扫描结果当作下载待办',()=>isolated(`
  import assert from 'node:assert/strict';
  const {main}=await import('./run.mjs');const {baseline,pendingQueue}=await import('./scripts/daily.mjs');const {db}=await import('./scripts/ledger.mjs');
  const result=await main([],{runScript:async()=>({ok:false,logged_in:true,scan_error:'分页缺失',items:[{aweme_id:'1'}]})});
  assert.equal(result.processed,0);assert.ok(result.paused);assert.equal(result.scanWarning,null);assert.equal(baseline(),null);assert.equal(pendingQueue().length,0);assert.equal(db().prepare('SELECT count(*) n FROM items').get().n,0);process.exitCode=0;
`));

test('扫描失败且没有待办时明确提示，下一轮扫描成功可继续发现新增',()=>isolated(`
  import assert from 'node:assert/strict';
  const {main}=await import('./run.mjs');const {acceptScan,baseline,pendingQueue}=await import('./scripts/daily.mjs');
  const seed={aweme_id:'100',duration_s:2};acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});const before=baseline();
  const result=await main([],{runScript:async()=>{throw Object.assign(new Error('登录失效'),{code:4});}});
  assert.equal(result.scanWarning,'收藏扫描需要重新登录');assert.equal(result.processed,0);assert.equal(result.paused,null);assert.deepEqual(baseline(),before);process.exitCode=0;
  const recovered=acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',desc:'新增',duration_s:2},seed]});assert.equal(recovered.added,1);assert.equal(pendingQueue().length,1);
`));

test('耗尽整轮时限不降级继续，仍保留待办',()=>isolated(`
  import assert from 'node:assert/strict';
  const {main}=await import('./run.mjs');const {acceptScan,setPurpose,pendingQueue}=await import('./scripts/daily.mjs');const {PauseError}=await import('./scripts/policy.mjs');
  const seed={aweme_id:'100',duration_s:2};acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',duration_s:2},seed]});setPurpose('1','video');
  const result=await main([],{runScript:async()=>{throw new PauseError('本轮达到执行时间上限');}});
  assert.equal(result.scanWarning,null);assert.equal(result.processed,0);assert.equal(result.paused,'本轮达到执行时间上限');assert.equal(pendingQueue().length,1);process.exitCode=0;
`));

test('刷新元数据：作品已失效直接跳过不算失败；被风控拦截只暂停抖音、不计失败次数；运行历史记下原因',()=>isolated(`
  import assert from 'node:assert/strict';
  import {execFileSync} from 'node:child_process';
  const {acceptScan,setPurpose}=await import('./scripts/daily.mjs');
  const {db}=await import('./scripts/ledger.mjs');
  const {main,childError}=await import('./run.mjs');
  const {readHistory,codeVersion}=await import('./scripts/run-history.mjs');
  const {PauseError}=await import('./scripts/policy.mjs');
  const seed={aweme_id:'100',duration_s:1};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',desc:'已删除',duration_s:1},{aweme_id:'2',desc:'被拦截',duration_s:1},{aweme_id:'3',desc:'其他错误',duration_s:1},seed]});
  for(const id of ['1','3'])setPurpose(id,'video');
  setPurpose('2','review');
  const empty=()=>({ok:true,logged_in:true,truncated:false,items:[seed]});
  // 子脚本退出码映射：7 → 只暂停抖音；其他带上 ERROR 行里的原因。
  const blocked=childError('get_meta.mjs',7,'详情接口返回空内容（HTTP 200）');
  assert.ok(blocked instanceof PauseError);assert.equal(blocked.scope,'platform');assert.equal(blocked.platform,'douyin');
  assert.equal(childError('get_meta.mjs',1,'页面结构变化').message,'get_meta.mjs 失败（退出码 1）：页面结构变化');
  const result=await main([],{runScript:async(name,args)=>{
    if(name==='get_collection.mjs')return empty();
    const id=args[0].split('/').pop();
    if(id==='1')return {ok:false,unavailable:true,message:'作品已删除'};
    if(id==='3')throw childError('get_meta.mjs',1,'页面结构变化');
    throw childError('get_meta.mjs',7,'详情接口返回空内容（HTTP 200）');
  }});
  const row=id=>db().prepare('SELECT * FROM items WHERE id=?').get(id);
  assert.equal(row('1').status,'skipped');assert.equal(row('1').skip_reason,'unavailable');assert.equal(row('1').attempts,0);
  assert.equal(result.failures.length,1);assert.equal(result.failures[0].id,'3');assert.equal(result.failures[0].platform,'douyin');assert.match(result.failures[0].error,/页面结构变化/);
  assert.equal(row('3').attempts,1);assert.equal(process.exitCode,2);process.exitCode=0;
  // 第二轮：被风控拦截 → 抖音本轮暂停，这条仍是待办且失败次数为 0。
  setPurpose('2','video');
  const second=await main([],{runScript:async(name)=>{if(name==='get_collection.mjs')return empty();throw childError('get_meta.mjs',7,'详情接口返回空内容（HTTP 200）');}});
  assert.match(second.pausedPlatforms.douyin,/风控拦截/);assert.deepEqual(second.failures,[]);assert.equal(row('2').status,'pending');assert.equal(row('2').attempts,0);
  assert.equal(process.exitCode,5);process.exitCode=0;
  const h=readHistory();assert.equal(h.length,2);assert.equal(h[0].exit,2);assert.equal(h[0].version,codeVersion());
  assert.equal(h[0].failures[0].id,'3');assert.equal(h[1].exit,5);assert.match(h[1].pausedPlatforms.douyin,/风控/);
  const out=execFileSync(process.execPath,['scripts/run-history.mjs','--id','3'],{encoding:'utf8',env:process.env});
  assert.match(out,/失败 3（douyin\\/video）：get_meta.mjs 失败（退出码 1）：页面结构变化/);
`));

test('定时服务把退出码 2、5 视为正常结束',async()=>{
  const {createLinuxScheduler}=await import('../scripts/schedule-linux.mjs');
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-unit-')));
  try{assert.match(createLinuxScheduler({home,command:()=>''}).render({time:'10:00',intervalHours:12}).service,/^SuccessExitStatus=2 5$/m);}
  finally{rmSync(home,{recursive:true,force:true});}
});

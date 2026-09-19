import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {classifyItem,parseRouting,PURPOSES} from '../scripts/routing.mjs';

function isolated(source) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-types-')));
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',source],{
      cwd:new URL('..',import.meta.url),env:{...process.env,DUST_HOME:home,DUST_NOTIFY:'0',DUST_DASHSCOPE_KEY:'',DUST_LLM_KEY:'',DUST_ROUTER_KEY:''},encoding:'utf8',timeout:60000,
    });
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  } finally {rmSync(home,{recursive:true,force:true});}
}

test('仅三种处理类型和待确认；图集不调用模型，拒绝旧混合类型',async()=>{
  assert.deepEqual(Object.keys(PURPOSES),['note','video','gallery','review']);
  for(const purpose of ['note','video','review'])assert.equal(parseRouting(JSON.stringify({purpose,reason:'测试'})).purpose,purpose);
  for(const purpose of ['speech','visual','both','gallery'])assert.throws(()=>parseRouting(JSON.stringify({purpose,reason:'测试'})));
  const result=await classifyItem({is_gallery:true},{config:{},fetchImpl:()=>{throw new Error('图集不应调用模型');}});
  assert.equal(result.purpose,'gallery');
});

test('旧分类迁移保留文件、成果、基线与额度，仅恢复未完成混合类型且可重复执行',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {writeFileSync,readFileSync} from 'node:fs';
  const {db}=await import('./scripts/ledger.mjs');
  const {acceptScan,baseline,reserveDaily,usage,migratePurposes}=await import('./scripts/daily.mjs');
  const seed={aweme_id:'100',duration_s:2};acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  const items=['1','2','3','4','5','6'].map(aweme_id=>({aweme_id,duration_s:2,is_gallery:aweme_id==='5'}));
  acceptScan({ok:true,logged_in:true,truncated:false,items:[...items,seed]});
  const file=join(process.env.DUST_HOME,'existing.mp4');writeFileSync(file,'keep existing video');
  const change=db().prepare('UPDATE items SET processing_mode=?,status=?,media_path=?,attempts=3,last_error=? WHERE id=?');
  change.run('visual','failed',file,'视频不在本地媒体目录','1');
  change.run('both','downloaded',file,'old error','2');
  change.run('speech','extracted',file,null,'3');
  change.run('review','review',null,null,'4');
  change.run('both','extracted',file,null,'6');
  db().exec("UPDATE items SET note_path='/existing-note.md' WHERE id IN ('3','6')");
  reserveDaily('1');const used=usage(),before=baseline();
  const result=migratePurposes();assert.equal(result.requeued,2);
  for(const id of ['1','2']){const row=db().prepare('SELECT * FROM items WHERE id=?').get(id);assert.equal(row.status,'pending');assert.equal(row.processing_mode,null);assert.equal(row.attempts,0);assert.equal(row.media_path,file);}
  for(const id of ['3','6']){const row=db().prepare('SELECT * FROM items WHERE id=?').get(id);assert.equal(row.status,'extracted');assert.equal(row.processing_mode,'note');assert.equal(row.note_path,'/existing-note.md');}
  assert.equal(db().prepare("SELECT status FROM items WHERE id='4'").get().status,'review');
  assert.equal(db().prepare("SELECT skip_reason FROM items WHERE id='100'").get().skip_reason,'baseline');
  assert.equal(usage(),used);assert.deepEqual(baseline(),before);assert.equal(readFileSync(file,'utf8'),'keep existing video');
  assert.deepEqual(migratePurposes(),{requeued:0,renamed:0});
`));

test('知识笔记可复用收藏目录中的旧素材；视频和图集不能进入转写、笔记或清理',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {spawnSync} from 'node:child_process';
  import {mkdirSync,existsSync} from 'node:fs';
  process.env.DUST_DASHSCOPE_KEY='fixture';
  const {SAVED_MEDIA,TEMP}=await import('./scripts/policy.mjs');
  mkdirSync(SAVED_MEDIA,{recursive:true});const file=join(SAVED_MEDIA,'fixture.mp4');
  const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=80x120','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-c:a','aac',file]);assert.equal(made.status,0,String(made.stderr));
  const {transcribeOne,cleanMedia}=await import('./extract.mjs');
  const {noteOne}=await import('./notes.mjs');
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({output:{text:'语音测试'},usage:{duration:1}});};
  const item={id:'1',media_path:file,media_type:'video',processing_mode:'note',duration_s:1,has_audio:1};
  const result=await transcribeOne(item,join(TEMP,'run-fixture'));assert.equal(result.chars,4);assert.equal(calls,1);
  const skipped=await noteOne({...item,text_path:result.textPath});assert.equal(skipped.reason,'insufficient_text');assert.equal(calls,1);
  for(const processing_mode of ['video','gallery','review']){
    await assert.rejects(()=>transcribeOne({...item,processing_mode},TEMP),/只有知识笔记/);
    await assert.rejects(()=>noteOne({...item,processing_mode,text_path:result.textPath}),/只有知识笔记/);
  }
  const {db,markTranscribed,markExtracted}=await import('./scripts/ledger.mjs');
  const {acceptScan}=await import('./scripts/daily.mjs');
  const seed={aweme_id:'100',duration_s:1};acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',duration_s:1},seed]});
  db().prepare("UPDATE items SET processing_mode='note',media_path=?,media_deleted=0 WHERE id='1'").run(file);
  markTranscribed('1',{text_source:'asr',text_chars:4,text_path:result.textPath});
  markExtracted('1',{text_source:'asr',text_chars:4,note_path:'/fixture-note.md'});
  assert.equal(cleanMedia().n,0);assert.ok(existsSync(file)); // 旧收藏目录不自动清理。
`));

test('三条笔记连续失败只暂停笔记；视频和图集继续成功，待确认不下载',()=>isolated(`
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
  import {spawnSync} from 'node:child_process';
  const image=join(process.env.DUST_HOME,'fixture.png');
  assert.equal(spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=80x120','-frames:v','1',image]).status,0);
  const {acceptScan,setPurpose}=await import('./scripts/daily.mjs');const {db}=await import('./scripts/ledger.mjs');
  const {main}=await import('./run.mjs');const {SAVED_MEDIA,MEDIA}=await import('./scripts/policy.mjs');
  const seed={aweme_id:'100',duration_s:1};acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  const items=['1','2','3','4','5','6','7'].map(aweme_id=>({aweme_id,duration_s:1,is_gallery:aweme_id==='6',images:[{urls:['https://fixture.invalid/image']}]}));
  acceptScan({ok:true,logged_in:true,truncated:false,items:[...items,seed],fetched_at:Date.now()/1000});
  db().exec('UPDATE daily_queue SET enqueued=CAST(id AS INTEGER)');
  for(const id of ['1','2','3','4','5']){
    setPurpose(id,id==='5'?'video':'note');const dir=join(id==='5'?SAVED_MEDIA:MEDIA,id);mkdirSync(dir,{recursive:true});
    const file=join(dir,'video.mp4');writeFileSync(file,'fixture');
    db().prepare("UPDATE items SET status='downloaded',media_path=?,media_quality='high',has_audio=1 WHERE id=?").run(file,id);
  }
  setPurpose('7','review');let calls=0;
  globalThis.fetch=async(url)=>{assert.equal(url,'https://fixture.invalid/image');calls++;return new Response(readFileSync(image));};
  const result=await main(['--no-scan']);
  assert.equal(result.failures.length,3);assert.ok(result.pausedTypes.note);assert.equal(result.paused,null);
  assert.equal(result.saved,1);assert.equal(result.galleries,1);assert.equal(result.notes,0);assert.equal(calls,1);
  assert.equal(db().prepare("SELECT attempts FROM items WHERE id='4'").get().attempts,0);
  assert.equal(db().prepare("SELECT status FROM items WHERE id='7'").get().status,'review');
  for(const id of ['5','6']){const row=db().prepare('SELECT * FROM items WHERE id=?').get(id);assert.equal(row.status,'saved');assert.equal(row.text_path,null);assert.equal(row.note_path,null);}
  process.exitCode=0;
`));

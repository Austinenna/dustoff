import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const setup = `
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,readFileSync,existsSync,renameSync,rmSync,symlinkSync} from 'node:fs';
  import {spawnSync} from 'node:child_process';
  const {db,markTranscribed,markExtracted}=await import('./scripts/ledger.mjs');
  const {acceptScan,pendingQueue,usage,setPurpose,retryItem}=await import('./scripts/daily.mjs');
  const {queueVideoToNote,cleanConvertedVideos}=await import('./scripts/video-to-note.mjs');
  const {SAVED_MEDIA}=await import('./scripts/policy.mjs');
  const {createStore}=await import('./scripts/console-store.mjs');
  const {main}=await import('./run.mjs');
  const seed={aweme_id:'100',duration_s:1};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',desc:'本地视频测试',duration_s:1},seed]});
  mkdirSync(join(SAVED_MEDIA,'1'),{recursive:true});
  const file=join(SAVED_MEDIA,'1','video.mp4');writeFileSync(file,'original video');
  db().prepare("UPDATE items SET status='saved',processing_mode='video',media_path=?,media_quality='high',has_audio=1 WHERE id='1'").run(file);
  const row=()=>db().prepare("SELECT * FROM items WHERE id='1'").get();
  const store=createStore(process.env.DUST_HOME);
  const original='这是本地视频的完整转写稿。'.repeat(8);
  const text=join(process.env.DUST_HOME,'text','1.txt'),note=join(process.env.DUST_HOME,'notes','1.md');
  const recordText=()=>{mkdirSync(join(process.env.DUST_HOME,'text'),{recursive:true});writeFileSync(text,original);markTranscribed('1',{text_source:'asr',text_chars:original.length,text_path:text});};
  const recordNote=()=>{mkdirSync(join(process.env.DUST_HOME,'notes'),{recursive:true});writeFileSync(note,'# 笔记\\n'+original);markExtracted('1',{text_source:'asr',text_chars:original.length,note_path:note});};
  const audio=()=>{rmSync(file);const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=80x120','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-c:a','aac',file]);assert.equal(made.status,0,String(made.stderr));};
  const modelNote={'够写':true,'缺料说明':'','标题':'本地视频笔记','分类':'测试','时效':'none','标签':[],'引流说明':'','正文':'# 本地视频笔记\\n已经整理完成。'};
`;
function isolated(source) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-video-note-')));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('DUST_')));
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',setup+source],{
      cwd:new URL('..',import.meta.url),env:{...env,DUST_HOME:home,DUST_NOTIFY:'0',DUST_NOTES:join(home,'notes'),DUST_TEXT:join(home,'text'),DUST_ASR_KEY:'fixture',DUST_LLM_KEY:'fixture'},encoding:'utf8',timeout:60000,
    });
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  } finally {rmSync(home,{recursive:true,force:true});}
}

test('转换只入队，复用本地文件和已有转写，不调用模型或占额度；重复请求不重置进度',()=>isolated(`
  globalThis.fetch=()=>{throw new Error('入队不得请求网络');};
  const before=readFileSync(file);assert.equal(store.item('1').can_convert_to_note,true);
  assert.equal(queueVideoToNote('1').queued,true);
  assert.equal(row().status,'downloaded');assert.equal(row().processing_mode,'note');assert.equal(row().delete_after_note,1);
  assert.equal(pendingQueue().length,1);assert.equal(usage(),0);assert.deepEqual(readFileSync(file),before);
  assert.equal(store.overview().videos,1);assert.equal(store.item('1').can_convert_to_note,false);
  recordText();db().exec("UPDATE items SET attempts=2 WHERE id='1'");
  assert.equal(queueVideoToNote('1').alreadyQueued,true);assert.equal(row().status,'transcribed');assert.equal(row().attempts,2);
  setPurpose('1','video');assert.equal(row().delete_after_note,0);
  queueVideoToNote('1');assert.equal(row().status,'transcribed');assert.equal(usage(),0);
`));

test('拒绝缺失、无音轨、超长、图集、链接和范围外视频，失败不改变用途',()=>isolated(`
  for(const [column,value] of [['has_audio',0],['duration_s',601],['media_type','gallery'],['skip_reason','baseline']]){
    const old=row()[column];db().prepare('UPDATE items SET '+column+'=? WHERE id=?').run(value,'1');
    assert.throws(()=>queueVideoToNote('1'));assert.equal(row().processing_mode,'video');
    db().prepare('UPDATE items SET '+column+'=? WHERE id=?').run(old,'1');
  }
  renameSync(file,file+'.held');assert.throws(()=>queueVideoToNote('1'),/本地原视频/);
  symlinkSync(file+'.held',file);assert.throws(()=>queueVideoToNote('1'),/本地原视频/);rmSync(file);renameSync(file+'.held',file);
  db().exec("DELETE FROM daily_queue WHERE id='1'");assert.throws(()=>queueVideoToNote('1'),/不支持/);
  assert.equal(row().processing_mode,'video');assert.equal(row().delete_after_note,0);assert.ok(existsSync(file));
`));

test('下一轮直接提取本地音频生成笔记，落盘后清理原视频，不重新下载或分类',()=>isolated(`
  audio();queueVideoToNote('1');let asr=0,notes=0,trashed=0;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.input){asr++;assert.match(body.input.messages[1].content[0].audio,/^data:audio\\/mp3;base64,/);return Response.json({output:{text:original},usage:{duration:1}});}
    assert.ok(body.messages);notes++;return Response.json({choices:[{message:{content:JSON.stringify(modelNote)}}]});
  };
  const result=await main(['--no-scan'],{runScript:()=>{throw new Error('不得读取远程素材');},trashFile:async p=>{
    assert.equal(row().status,'extracted');assert.ok(readFileSync(row().note_path,'utf8').includes(original));
    assert.equal(readFileSync(row().text_path,'utf8'),original);assert.equal(p,file);renameSync(p,p+'.trashed');trashed++;
  }});
  assert.equal(asr,1);assert.equal(notes,1);assert.equal(trashed,1);assert.equal(result.notes,1);assert.deepEqual(result.failures,[]);
  assert.equal(result.convertedCleanup.n,1);assert.equal(row().media_deleted,1);assert.equal(row().status,'extracted');assert.equal(row().skip_reason,null);
  assert.equal(store.overview().videos,0);assert.equal(store.overview().notes,1);assert.equal(pendingQueue().length,0);
  const again=await main(['--no-scan']);assert.equal(again.processed,0);assert.equal(asr,1);assert.equal(notes,1);
`));

for(const failure of ['asr','note','insufficient'])test(`${failure} 未完成时保留视频，重试沿用已完成阶段`,()=>isolated(`
  audio();queueVideoToNote('1');let asr=0,notes=0;
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.input){asr++;return ${JSON.stringify(failure)}==='asr'?Response.json({error:{message:'fixture denied'}},{status:401}):Response.json({output:{text:${JSON.stringify(failure)}==='insufficient'?'太短':original},usage:{duration:1}});}
    notes++;return Response.json({error:{message:'fixture invalid'}},{status:400});
  };
  const result=await main(['--no-scan'],{trashFile:()=>{throw new Error('失败时不得清理');}});
  assert.ok(existsSync(file));assert.equal(row().media_deleted,0);assert.equal(result.convertedCleanup.n,0);
  if(${JSON.stringify(failure)}==='insufficient'){assert.equal(row().status,'skipped');assert.equal(notes,0);}
  else{retryItem('1');assert.equal(row().status,${JSON.stringify(failure)}==='asr'?'downloaded':'transcribed');}
  assert.equal(asr,1);process.exitCode=0;
`));

test('排队后源文件丢失不重新下载；恢复文件后可续跑',()=>isolated(`
  queueVideoToNote('1');renameSync(file,file+'.held');retryItem('1');
  globalThis.fetch=()=>{throw new Error('不得重新下载');};
  const result=await main(['--no-scan'],{runScript:()=>{throw new Error('不得重新读取远程素材');}});
  assert.match(result.failures[0].error,/本地原视频不可用/);assert.equal(row().delete_after_note,1);
  renameSync(file+'.held',file);retryItem('1');assert.equal(row().status,'downloaded');process.exitCode=0;
`));

test('清理校验原稿和笔记，保留缺料及未授权素材；删除失败只重试清理',()=>isolated(`
  queueVideoToNote('1');recordText();recordNote();let moves=0;
  const trashFile=async p=>{moves++;renameSync(p,p+'.trashed');};
  for(const sql of ["UPDATE items SET retain_media=1 WHERE id='1'","UPDATE items SET delete_after_note=0 WHERE id='1'"]){
    db().exec(sql);assert.equal((await cleanConvertedVideos({trashFile})).n,0);assert.ok(existsSync(file));
    db().exec("UPDATE items SET retain_media=0,delete_after_note=1 WHERE id='1'");
  }
  writeFileSync(text,'changed');assert.equal((await cleanConvertedVideos({trashFile})).held,1);writeFileSync(text,original);
  renameSync(note,note+'.held');assert.equal((await cleanConvertedVideos({trashFile})).held,1);renameSync(note+'.held',note);
  const failed=await cleanConvertedVideos({trashFile:async()=>{throw new Error('fixture trash failed');}});
  assert.equal(failed.failures.length,1);assert.equal(row().status,'extracted');assert.equal(row().media_deleted,0);assert.ok(existsSync(file));
  globalThis.fetch=()=>{throw new Error('清理重试不得调用模型');};
  const next=await main(['--no-scan'],{trashFile});assert.equal(next.processed,0);assert.equal(next.convertedCleanup.n,1);assert.equal(moves,1);
  assert.ok(existsSync(text));assert.ok(existsSync(note));assert.equal(row().media_deleted,1);
`));

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const setup = `
  import assert from 'node:assert/strict';
  import {join} from 'node:path';
  import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
  const {db,importDownload,markExtracted,markFailed,markSaved,markSkipped,markTranscribed}=await import('./scripts/ledger.mjs');
  const {acceptScan,discardItem,pendingQueue,setPurpose,retryItem,usage}=await import('./scripts/daily.mjs');
  const {settleNoteVideos}=await import('./scripts/note-video.mjs');
  const {MEDIA,SAVED_MEDIA}=await import('./scripts/policy.mjs');
  const {createStore}=await import('./scripts/console-store.mjs');
  const seed={aweme_id:'100',duration_s:1};
  acceptScan({ok:true,logged_in:true,truncated:false,items:[seed]});
  acceptScan({ok:true,logged_in:true,truncated:false,items:[{aweme_id:'1',desc:'讲解视频',duration_s:60},seed]});
  const home=process.env.DUST_HOME,note=join(home,'notes','1.md'),text=join(home,'text','1.txt'),low=join(MEDIA,'1','video.mp4'),high=join(SAVED_MEDIA,'1','video.mp4');
  for(const [path,value] of [[note,'# 笔记'],[text,'转写稿'],[low,'low']]){mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,value);}
  db().prepare("UPDATE items SET processing_mode='note',status='downloaded',media_path=?,media_quality='low',has_audio=1 WHERE id='1'").run(low);
  markTranscribed('1',{text_source:'asr',text_chars:3,text_path:text});
  markExtracted('1',{text_source:'asr',text_chars:3,note_path:note});
  const row=()=>db().prepare("SELECT * FROM items WHERE id='1'").get();
  const store=createStore(home);
  const noteIds=()=>{const ids=store.notesIndex().items.map(i=>i.id);assert.deepEqual(store.listItems({results:'1',status:'all'}).items.map(i=>i.id),ids);return ids;};
  const videoIds=()=>store.listItems({videos:'1'}).items.map(i=>i.id);
  const download=()=>{mkdirSync(join(high,'..'),{recursive:true});writeFileSync(high,'high');importDownload([{aweme_id:'1',status:'done',path:high,bytes:4,has_audio:true,quality:'high'}]);markSaved('1');};
`;
function isolated(source) {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'dustoff-note-video-')));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('DUST_')));
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',setup+source],{
      cwd:new URL('..',import.meta.url),env:{...env,DUST_HOME:home,DUST_NOTIFY:'0',DUST_NOTES:join(home,'notes'),DUST_TEXT:join(home,'text')},encoding:'utf8',timeout:60000,
    });
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  } finally {rmSync(home,{recursive:true,force:true});}
}

test('笔记下载高清视频：排队期间和完成后都留在知识库，低清素材在收尾清掉',()=>isolated(`
  assert.equal(store.item('1').can_download_video,true);
  setPurpose('1','video');
  assert.equal(row().status,'pending');assert.equal(pendingQueue().length,1);
  assert.deepEqual(noteIds(),['1']);assert.deepEqual(videoIds(),[]);assert.equal(store.overview().notes,1);
  assert.equal(store.item('1').can_download_video,false);
  settleNoteVideos();assert.ok(existsSync(low),'下载完成前不动低清素材');
  download();
  assert.deepEqual(noteIds(),['1']);assert.deepEqual(videoIds(),['1']);assert.equal(store.overview().notes,1);
  assert.equal(store.item('1').can_convert_to_note,false);assert.equal(store.item('1').can_download_video,false);
  assert.equal(settleNoteVideos().removed,1);
  assert.ok(!existsSync(low));assert.ok(existsSync(high));assert.ok(existsSync(note));
`));

test('作品已失效：收尾回到知识笔记并写明原因，可以再次下载',()=>isolated(`
  setPurpose('1','video');markSkipped('1','unavailable');
  assert.equal(settleNoteVideos().restored,1);
  assert.equal(row().status,'extracted');assert.equal(row().processing_mode,'note');assert.equal(row().skip_reason,null);
  assert.equal(row().last_error,'高清视频未下载：作品已失效');assert.ok(existsSync(low));
  assert.deepEqual(noteIds(),['1']);assert.equal(store.item('1').can_download_video,true);
  setPurpose('1','video');assert.equal(row().last_error,null);
`));

test('连续失败：笔记仍在知识库，可以重试，也可以取消下载',()=>isolated(`
  setPurpose('1','video');for(let n=0;n<3;n++)markFailed('1','下载 HTTP 403');
  assert.equal(row().status,'failed');assert.deepEqual(noteIds(),['1']);assert.equal(store.overview().notes,1);
  assert.equal(store.item('1').can_discard,true);
  discardItem('1');
  assert.equal(row().status,'extracted');assert.equal(row().processing_mode,'note');assert.equal(row().skip_reason,null);
  assert.equal(row().attempts,0);assert.equal(row().last_error,null);assert.ok(existsSync(low));
`));

test('已有高清文件时直接保存，不排队也不占额度',()=>isolated(`
  mkdirSync(join(high,'..'),{recursive:true});writeFileSync(high,'high');
  db().prepare("UPDATE items SET media_path=?,media_quality='high' WHERE id='1'").run(high);
  setPurpose('1','video');
  assert.equal(row().status,'saved');assert.equal(pendingQueue().length,0);assert.equal(usage(),0);assert.deepEqual(videoIds(),['1']);
`));

test('删除视频后还能重新下载；文章类作品没有下载入口',()=>isolated(`
  download();db().prepare("UPDATE items SET status='extracted',media_deleted=1,skip_reason='video_deleted' WHERE id='1'").run();
  assert.equal(store.item('1').can_download_video,true);
  db().prepare("UPDATE items SET text_source='article' WHERE id='1'").run();
  assert.equal(store.item('1').can_download_video,false);
`));

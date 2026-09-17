import test from 'node:test';
import assert from 'node:assert/strict';
import {FIELDS} from '../scripts/console-store.mjs';
import {SETTINGS,mediaLabel,resultLabel,runSummary} from '../web/studio-view.mjs';

test('设置重组后所有可编辑字段恰好出现一次，避免遗漏配置入口',()=>{
  const keys=Object.values(SETTINGS).flat();
  assert.equal(new Set(keys).size,keys.length);
  assert.deepEqual(keys.sort(),Object.keys(FIELDS).sort());
});
test('结果摘要区分暂停、失败和扫描警告，不将异常批次标为已完成',()=>{
  assert.equal(runSummary({result:{mode:'baseline'}}).label,'已建立历史基线');
  assert.equal(runSummary({result:null}).label,'未记录结果');
  assert.equal(runSummary({result:{failures:[{error:'失败'}]}}).tone,'danger');
  assert.equal(runSummary({result:{paused:'额度耗尽'}}).label,'已暂停');
  assert.equal(runSummary({result:{scanWarning:'未找到旧边界',notes:2}}).label,'扫描受阻，已继续待办');
  assert.equal(runSummary({result:{failures:[],notes:2}}).label,'已完成');
});
test('媒体现状与既有文字产物独立展示，不把删除的视频误报为保留',()=>{
  assert.equal(mediaLabel({media_deleted:1,media_path:'/old.mp4',processing_mode:'video'}),'视频已清理');
  assert.equal(mediaLabel({media_path:'/video.mp4',processing_mode:'video',media_quality:'high'}),'已保留 · 高清');
  assert.equal(resultLabel({note_path:'/note.md',text_path:'/text.txt',media_deleted:1,status:'extracted'}),'知识笔记 · 文字稿');
});

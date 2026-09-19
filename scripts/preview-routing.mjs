#!/usr/bin/env node
// 仅补用途建议，不修改业务状态、用途、下载队列或每日额度。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DUST_HOME } from './config.mjs';
import { atomicWrite, localPath } from './policy.mjs';
import { classifyItem, ROUTING_PROMPT } from './routing.mjs';
import { createStage } from './stage.mjs';

export function previewFingerprint(row) {
  return createHash('sha256').update(JSON.stringify([row.title,row.author,row.duration_s,ROUTING_PROMPT])).digest('hex');
}
export function readPreviews(home=DUST_HOME) {
  try { return JSON.parse(readFileSync(localPath(join(home,'routing-preview.json')),'utf8'))?.items || {}; }
  catch { return {}; }
}
export function previewFor(row, previews) {
  const p=previews[row.id];
  return !row.processing_mode && p?.fingerprint===previewFingerprint(row) ? p : null;
}
export async function previewRecent({home=DUST_HOME,classifier=classifyItem,log=()=>{}}={}) {
  const dbFile=localPath(process.env.DUST_DB || join(home,'index.sqlite'));
  if(!existsSync(dbFile))throw new Error('账本尚不存在');
  const d=new DatabaseSync(dbFile,{readOnly:true});
  let rows;
  try {
    // 日常队列涵盖这次正式启用后的新收藏，排除仅作历史参照的基线。
    rows=d.prepare(`SELECT i.id,i.title,i.author,i.duration_s,i.processing_mode FROM items i
      JOIN daily_queue q ON q.id=i.id AND i.platform='douyin'
      WHERE COALESCE(i.media_type,'video')!='gallery' AND i.processing_mode IS NULL AND i.status IN ('extracted','skipped')
        AND COALESCE(i.skip_reason,'') NOT IN ('baseline','gallery','too_long')
      ORDER BY i.first_seen DESC,i.collected_at DESC LIMIT 50`).all();
  } finally { d.close(); }
  const items=readPreviews(home), summary={total:rows.length,classified:0,cached:0,failures:[]};
  for(const row of rows) {
    if(previewFor(row,items)){summary.cached++;continue;}
    try {
      const decision=await classifier(row);
      items[row.id]={...decision,fingerprint:previewFingerprint(row),created_at:Math.floor(Date.now()/1000)};
      atomicWrite(join(home,'routing-preview.json'),JSON.stringify({version:1,items},null,2));
      summary.classified++;log(`用途预览 ${summary.classified+summary.cached}/${rows.length}：${decision.purpose}`);
    } catch(e) {summary.failures.push({id:row.id,error:e.message});log(`用途预览失败：${e.message}`);}
  }
  return summary;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href) {
  const stage=createStage({name:'console-action',dustHome:DUST_HOME,notify:false});stage.acquireLock();
  try {const result=await previewRecent({log:stage.log});stage.log(`用途预览完成：新增 ${result.classified}，已存在 ${result.cached}，失败 ${result.failures.length}；未下载或重排队`);if(result.failures.length)process.exitCode=1;}
  finally {stage.releaseLock();}
}

// 调用方须持有 pipeline 锁。只处理账本指向的单个视频，保留文字和恢复记录。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DUST_HOME, expand } from './config.mjs';
import { createStore, HttpError } from './console-store.mjs';
import { atomicWrite, localPath } from './policy.mjs';

const execute=promisify(execFile);
export async function moveVideoToTrash(path) {
  if(process.platform!=='darwin'||!existsSync('/usr/bin/trash'))throw new Error('当前系统不支持移入废纸篓，视频未删除');
  await execute('/usr/bin/trash',['-s',path],{timeout:10000,maxBuffer:64*1024});
}

export async function deleteLocalVideo({id,home=DUST_HOME,trashFile=moveVideoToTrash,afterNote=false}) {
  id=String(id);
  const store=createStore(home),item=store.item(id);
  if(item.media_type==='gallery')throw new HttpError(400,'此操作只支持视频');
  if(item.media_deleted&&item.skip_reason==='video_deleted')return {deleted:true,alreadyDeleted:true};
  // 不跟随文件本身的符号链接，避免把链接目标当作这条视频删除。
  if(item.media_path&&existsSync(expand(item.media_path))&&!lstatSync(expand(item.media_path)).isFile())throw new HttpError(400,'视频必须是普通文件');
  const source=store.fileFor(id,'video');
  const db=new DatabaseSync(store.settings().database);
  const record=join(home,'console','deleted-videos',`${id}-${Date.now()}.json`);
  let snapshot,transaction=false;
  try {
    db.exec('PRAGMA busy_timeout=1500; BEGIN IMMEDIATE');
    transaction=true;
    const row=db.prepare("SELECT * FROM items WHERE platform='douyin' AND id=?").get(id);
    if(!row||row.media_deleted||localPath(row.media_path)!==source)throw new HttpError(409,'视频状态已变化，请刷新后重试');
    const shared=db.prepare("SELECT platform,id,media_path FROM items WHERE media_path IS NOT NULL AND COALESCE(media_deleted,0)=0").all()
      .some(other=>(other.platform!=='douyin'||other.id!==id)&&localPath(other.media_path)===source);
    if(shared)throw new HttpError(409,'还有其他收藏使用同一个视频文件，暂不能删除');
    snapshot={version:1,requestedAt:new Date().toISOString(),source,item:row};
    atomicWrite(record,JSON.stringify({...snapshot,state:'prepared'},null,2)+'\n');
    // 先验证数据库写入，再移动文件；事务提交前失败可回滚。恢复记录保留原始条目。
    db.prepare("UPDATE items SET media_deleted=1,status=?,skip_reason=?,needs_ocr=0,last_error=NULL,updated_at=? WHERE platform='douyin' AND id=?")
      .run(row.status==='removed'?'removed':row.note_path?'extracted':'skipped',afterNote?null:'video_deleted',Math.floor(Date.now()/1000),id);
    await trashFile(source);
    if(existsSync(source))throw new Error('视频仍在原位置，未完成移入废纸篓');
    db.exec('COMMIT');
    transaction=false;
  } catch(error) {
    if(transaction)db.exec('ROLLBACK');
    if(snapshot&&!existsSync(source))throw new Error('视频已离开原位置，但账本更新未完成；请检查废纸篓，并根据 console/deleted-videos 中的记录恢复。',{cause:error});
    throw error;
  } finally {db.close();}
  // 账本和文件操作已完成，记录收尾失败不能把成功结果误报为未删除。
  try {atomicWrite(record,JSON.stringify({...snapshot,state:'trashed'},null,2)+'\n');} catch {}
  return {deleted:true};
}

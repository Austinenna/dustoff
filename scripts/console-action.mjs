// 短操作也持有流水线锁，避免与定时任务同时修改条目或占用登录浏览器。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { DUST_HOME, loadConf } from './config.mjs';
import { atomicWrite } from './policy.mjs';
import { createStage } from './stage.mjs';
import { retryItem, setPurpose, discardItem, deleteItem, setVideoQuality } from './daily.mjs';
import { applyIntents } from './intents.mjs';
import { deleteLocalVideo } from './delete-video.mjs';
import { queueVideoToNote } from './video-to-note.mjs';
import { validItemId } from './platforms.mjs';
const [action,id,purpose,quality]=process.argv.slice(2);
const stage=createStage({name:'console-action',dustHome:DUST_HOME,notify:false});
if(!['retry','purpose','login','video-delete','video-to-note','discard','delete-item','quality','apply-intents'].includes(action))throw new Error('不支持的控制台操作');
if(['retry','purpose','video-delete','video-to-note','discard','delete-item','quality'].includes(action)&&!validItemId(id))throw new Error('作品 ID 无效');
stage.acquireLock();
if(action==='video-to-note') {
  try {queueVideoToNote(id);stage.log(`视频 ${id} 已加入待办，下次运行使用本地视频生成笔记，成功后移入废纸篓`);}
  catch(e){stage.log(e.message);process.send?.({type:'action-error',message:e.message});process.exitCode=1;}
  finally{stage.releaseLock();stage.pruneRuns();}
} else if(action==='video-delete') {
  try {await deleteLocalVideo({id});stage.log(`视频 ${id} 已移入废纸篓，文字与收藏记录保留`);}
  catch(e){stage.log(e.message);process.send?.({type:'action-error',message:e.message});process.exitCode=1;}
  finally{stage.releaseLock();stage.pruneRuns();}
} else if(action==='apply-intents') {
  try {const r=applyIntents(DUST_HOME,{log:stage.log});if(r.failed.length)process.exitCode=1;}
  catch(e){stage.log(e.message);process.exitCode=1;}
  finally{stage.releaseLock();stage.pruneRuns();}
} else if(['retry','purpose','discard','delete-item','quality'].includes(action)) {
  try {
    if(action==='quality')stage.log(`已设置 ${id} 的画质上限为 ${setVideoQuality(id,purpose)??'默认'}`);
    else if(action==='purpose'){
      // 先记画质再改用途：用途改为视频后就会排队下载。
      if(quality!==undefined)setVideoQuality(id,quality);
      stage.log(`已更新 ${id} 用途为 ${setPurpose(id,purpose)}，下一轮处理`);
    }
    else if(action==='retry')stage.log(`已恢复 ${id} 到 ${retryItem(id)}，下一轮继续处理`);
    else if(action==='discard'){discardItem(id);stage.log(`已放弃处理 ${id}，收藏记录保留`);}
    else {deleteItem(id);stage.log(`已删除 ${id} 的收藏记录`);}
  }
  catch(e){stage.log(e.message);process.send?.({type:'action-error',message:e.message});process.exitCode=1;}
  finally{stage.releaseLock();stage.pruneRuns();}
} else {
  const env={...loadConf(),...process.env,DUST_HOME};
  env.DUST_PROFILE ||= join(DUST_HOME,'chrome-profile');
  const child=spawn(process.execPath,[fileURLToPath(new URL('./login.mjs',import.meta.url))],{env,stdio:'inherit'});
  child.on('error',error=>{stage.log(error.message);process.exitCode=1;});
  child.on('close',code=>{
    if(code===0){rmSync(join(DUST_HOME,'NEEDS_LOGIN'),{force:true});atomicWrite(join(DUST_HOME,'console','login.json'),JSON.stringify({completedAt:Date.now(),success:true}));}
    process.exitCode=code??1;stage.releaseLock();
  });
}

// 展示逻辑只接收接口数据，不访问文件或触发业务操作。
import {escapeHtml} from './markdown.mjs';
export const esc = escapeHtml;
export const PURPOSES = {video:'保存视频',speech:'提取口播知识',visual:'画面知识',both:'视频和笔记',review:'待确认用途'};
export const STATUSES = {pending:'待处理',downloaded:'已下载',transcribed:'已转写',extracted:'已整理',saved:'已保存视频',review:'待确认',failed:'失败',skipped:'已跳过',removed:'已取消收藏'};
export const REASONS = {baseline:'历史基线，不自动处理',gallery:'图集暂不处理',too_long:'超过时长限制',need_ocr:'等待画面文字提取',no_url:'缺少下载地址'};
export const SETTINGS = {
  account:['DUST_WARN_DAYS'],
  models:['DUST_ROUTER_BASE','DUST_ROUTER_MODEL','DUST_ROUTER_KEY','DUST_ASR_MODEL','DUST_DASHSCOPE_KEY','DUST_LLM_BASE','DUST_LLM_MODEL','DUST_LLM_KEY','DUST_LLM_EFFORT','DUST_LLM_MAX_TOKENS','DUST_ASR_CONTEXT','DUST_REQUEST_TIMEOUT_S'],
  storage:['DUST_NOTES','DUST_TEXT','DUST_SAVED_MEDIA','DUST_SAVED_MEDIA_MAX_GB','DUST_MEDIA_MAX_GB','DUST_MIN_FREE_GB','DUST_KEEP_RUNS'],
  rules:['DUST_DAILY_LIMIT','DUST_MAX_DURATION_MIN','DUST_NOTIFY','DUST_SCAN_COUNT','DUST_RUN_TIMEOUT_S'],
};
export const fmt = value => {
  if(value===null||value===undefined||value==='')return '暂无记录';
  const date=new Date(typeof value==='number'&&value<1e12?value*1000:value);
  return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
};
export const bytes = value => value===null||value===undefined?'未知':value>=1024**3?`${(value/1024**3).toFixed(1)} GiB`:`${(value/1024**2).toFixed(1)} MiB`;
export const duration = value => Number(value)>0?`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`:'时长未知';
export const titleOf = item => item.display_title||item.title||item.id;
export function mediaLabel(item) {
  if(item.media_deleted)return '视频已清理';
  if(item.media_path)return `${item.status==='saved'||['video','both'].includes(item.processing_mode)?'已保留':'缓存中'}${item.media_quality==='high'?' · 高清':item.media_quality==='low'?' · 低清':''}`;
  return '未保存视频';
}
export function resultLabel(item) {
  return [item.note_path&&'知识笔记',item.text_path&&'文字稿',item.needs_ocr&&'待 OCR'].filter(Boolean).join(' · ')||STATUSES[item.status]||item.status||'暂无结果';
}
export function runSummary(run) {
  const r=run?.result;
  if(!r)return {label:'未记录结果',tone:'muted',detail:'可能仍在运行，或未正常写入结果。请查看日志。'};
  if(r.error)return {label:'执行失败',tone:'danger',detail:r.error};
  if(r.paused)return {label:'已暂停',tone:'warn',detail:r.paused};
  if(r.failures?.length)return {label:'有处理失败',tone:'danger',detail:`${r.failures.length} 项失败，可展开日志查看原因。`};
  if(r.scanWarning)return {label:'扫描受阻，已继续待办',tone:'warn',detail:r.scanWarning};
  return {label:r.mode==='baseline'?'已建立历史基线':'已完成',tone:'green',detail:r.mode==='baseline'?'首次运行建立参照，历史收藏不会自动进入处理队列。':''};
}

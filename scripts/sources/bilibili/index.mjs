#!/usr/bin/env node
// B 站收藏来源：扫描新收藏入队，并在日常编排中逐条处理。
// 与抖音共用账本、额度、护栏、转写和笔记流程；扫描状态、登录与风控暂停都是独立的。
//
// 预览（只读，不写账本、不推进扫描位置）：
//   node scripts/sources/bilibili/index.mjs --dry-run
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DUST_HOME, makeCfg } from '../../config.mjs';
import { POLICY, PauseError, atomicWrite, localPath, mediaDecision } from '../../policy.mjs';
import { db, importScan, importDownload, markRouting, markSaved, markSkipped, markTranscribed, markExtracted } from '../../ledger.mjs';
import { acceptIncremental, itemRow, platformState, retryItem, updateQueued } from '../../daily.mjs';
import { classifyItem, PURPOSES } from '../../routing.mjs';
import { createClient, LoginError, PlatformPause, biliSession, readCookies, sessionFile } from './client.mjs';
import { scanFavorites, folderPurposes } from './favorites.mjs';
import { fetchMeta, fetchSubtitles, downloadAudio, downloadVideo } from './content.mjs';

export const foldersFile = (home = DUST_HOME) => localPath(join(home, 'bilibili', 'folders.json'));
const settings = () => {
  const cfg = makeCfg();
  return {
    include: cfg('DUST_BILI_FOLDERS', ''), exclude: cfg('DUST_BILI_EXCLUDE_FOLDERS', ''),
    purposes: folderPurposes(cfg('DUST_BILI_FOLDER_PURPOSES', '')),
    maxPages: Math.max(1, Math.min(20, Number(cfg('DUST_BILI_MAX_PAGES', 5)) || 5)),
    startDate: cfg('DUST_BILI_START_DATE', ''), allowAi: cfg('DUST_BILI_SUBTITLE_AI', '1') !== '0',
  };
};
function recordSession(patch, home = DUST_HOME) {
  let old = {};
  try { old = JSON.parse(readFileSync(sessionFile(home), 'utf8')); } catch {}
  atomicWrite(sessionFile(home), JSON.stringify({ ...old, ...patch, last_check_at: Math.floor(Date.now() / 1000) }) + '\n');
}

/** 扫描并入队。登录失效时记录状态后抛出，交给调用方作为扫描警告处理。 */
export async function scanBilibili({ log = () => {}, client, dryRun = false, home = DUST_HOME } = {}) {
  const cookies = readCookies(home), session = biliSession(cookies);
  if (!session.loggedIn) { if (!dryRun) recordSession({ logged_in: false, expires_at: null, online: 'login_required' }, home); throw new LoginError('B站尚未登录，请在控制台扫码登录'); }
  client ||= createClient({ cookies });
  const s = settings();
  let scan;
  try {
    scan = await scanFavorites({ client, state: platformState('bilibili'), include: s.include, exclude: s.exclude, maxPages: s.maxPages, startDate: s.startDate, log });
  } catch (e) {
    if (e instanceof LoginError && !dryRun) recordSession({ logged_in: false, online: 'login_required' }, home);
    throw e;
  }
  for (const w of scan.warnings) log(`B站：${w}`);
  if (dryRun) return { dryRun: true, items: scan.items, folders: scan.folders, warnings: scan.warnings, start_at: scan.nextState.start_at };
  const accepted = acceptIncremental('bilibili', scan.items, scan.nextState);
  mkdirSync(join(home, 'bilibili'), { recursive: true, mode: 0o700 });
  atomicWrite(foldersFile(home), JSON.stringify({ scanned_at: scan.nextState.scanned_at, start_at: scan.nextState.start_at, folders: scan.folders }, null, 2) + '\n');
  recordSession({ logged_in: true, expires_at: session.expiresAt, online: 'verified', online_checked_at: Math.floor(Date.now() / 1000) }, home);
  return { ...accepted, warnings: scan.warnings, folders: scan.folders.length };
}

const fresh = id => itemRow(id);
const folderList = row => { try { return row?.folders ? JSON.parse(row.folders) : []; } catch { return []; } };
/** 收藏夹指定了用途时直接采用；同一作品所在收藏夹的用途冲突时交给模型。 */
export function folderDecision(item, purposes) {
  const found = new Set();
  for (const [i, title] of (item.folders || []).entries()) {
    const p = purposes.get(String(item.folder_ids?.[i] ?? '')) || purposes.get(title);
    if (p) found.add(p);
  }
  return found.size === 1 ? { purpose: [...found][0], reason: '按收藏夹指定的用途', source: 'folder', model: null } : null;
}
export function noteContext(item, textSource) {
  const lines = ['平台：B站'];
  if (item.tname) lines.push(`分区：${item.tname}`);
  if (item.tags?.length) lines.push(`标签：${item.tags.join('、')}（标签往往写着专有名词的正确形式，可用来校正文字稿里认错的词）`);
  if (item.folders?.length) lines.push(`用户收藏夹：${item.folders.join('、')}`);
  if (item.intro) lines.push(`简介：${item.intro.slice(0, 500).replace(/\s+/g, ' ')}`);
  lines.push(`文字来源：${textSource === 'ai_subtitle' ? 'B站 AI 字幕，可能有同音字和断句错误' : textSource === 'subtitle' ? 'UP 主上传的字幕' : '语音转写'}`);
  return lines.join('\n');
}
/** 当天 B 站已用和已排队的转写音频秒数，用于每日转写总量上限。 */
export function asrSecondsToday(now = Date.now()) {
  const d = new Date(now), midnight = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
  const r = db().prepare(`SELECT COALESCE(SUM(CASE WHEN status='downloaded' THEN duration_s ELSE audio_seconds END),0) n FROM items
    WHERE platform='bilibili' AND ((text_source='asr' AND transcribed_at>=?) OR (status='downloaded' AND COALESCE(processing_mode,'')='note'))`).get(midnight);
  return Number(r.n) || 0;
}

/**
 * 处理一条 B 站待办。调用方已预留当天额度，失败时由调用方记账。
 * deps 便于测试替换外部调用：client、classify、transcribe、note、writeNote、textDir、notesDir。
 */
export async function processBilibili({ candidate, summary, log, tmp, downloadOnly = false, skipNotes = false, deps }) {
  const { client, classify = classifyItem, transcribe, note, writeNote, textDir, notesDir, asrKey, llmKey, hash,
    meta = fetchMeta, subtitles: getSubtitles = fetchSubtitles, audio = downloadAudio, video = downloadVideo } = deps;
  const s = settings();
  let row = fresh(candidate.id), item = JSON.parse(candidate.metadata);
  const id = row.id;
  item.folders = folderList(row).length ? folderList(row) : item.folders;
  if (!item.pages?.length || (row.status === 'pending' && Date.now() / 1000 - (item.meta_at || 0) > 86400)) {
    item = { ...item, ...(await meta(client(), id)), folders: item.folders, folder_ids: item.folder_ids, collected_at: item.collected_at, fetched_at: item.fetched_at };
    importScan([item], 'bilibili'); updateQueued(id, item); row = fresh(id);
    const reason = mediaDecision(item);
    if (row.status === 'pending' && reason === 'too_long') { markSkipped(id, 'too_long'); summary.skipped++; log(`B站 ${id} 超过时长上限，已跳过`); return; }
  }
  let subtitles;
  const loadSubtitles = async () => subtitles === undefined ? (subtitles = await getSubtitles(client(), item, { allowAi: s.allowAi })) : subtitles;
  if (!row.processing_mode) {
    let decision = folderDecision(item, s.purposes);
    if (!decision) decision = await classify({ ...item, platform: 'bilibili', has_subtitle: !!(await loadSubtitles()) });
    markRouting(id, decision); row = fresh(id);
    log(`用途 ${id}：${PURPOSES[decision.purpose].label}${decision.source === 'folder' ? '（收藏夹指定）' : ''}`);
    if (decision.purpose === 'review') { summary.review++; return; }
    retryItem(id); row = fresh(id);
  }
  if (row.processing_mode === 'video') {
    if (row.status === 'pending') { importDownload([await video(client(), item)], 'bilibili', { countFailures: false }); row = fresh(id); }
    if (row.status === 'downloaded') { markSaved(id); summary.saved++; log(`视频已保存 ${id}`); }
    return;
  }
  if (row.processing_mode !== 'note') throw new Error('只有知识笔记类型可以转写和整理');
  if (row.status === 'pending') {
    const subs = await loadSubtitles();
    if (subs) {
      const textPath = join(textDir, `${id}.txt`);
      atomicWrite(join(textDir, `${id}.words.json`), JSON.stringify(subs.words));
      atomicWrite(textPath, subs.text);
      markTranscribed(id, { text_source: subs.source, text_chars: subs.text.length, text_path: textPath, audio_seconds: null });
      row = fresh(id); summary.text++; summary.subtitles = (summary.subtitles || 0) + 1;
      log(`字幕 ${id}：${subs.source === 'ai_subtitle' ? 'AI 字幕' : '上传字幕'} ${subs.text.length} 字`);
    } else {
      const seconds = Number(row.duration_s) || 0;
      if (seconds > POLICY.bilibili.asrSeconds) { markSkipped(id, 'too_long_for_asr'); summary.skipped++; log(`B站 ${id} 没有字幕且超过转写时长上限，已跳过`); return; }
      if (asrSecondsToday() + seconds > POLICY.bilibili.dailyAsrSeconds) throw Object.assign(new PauseError(`B站当天转写时长已达 ${POLICY.bilibili.dailyAsrSeconds / 60} 分钟上限`), { scope: 'type' });
      importDownload([await audio(client(), item)], 'bilibili', { countFailures: false }); row = fresh(id);
    }
  }
  if (downloadOnly) return;
  if (row.status === 'downloaded') {
    if (!asrKey) throw new Error('未配置 ASR Key');
    const result = await transcribe(row, tmp);
    markTranscribed(id, { text_source: 'asr', text_chars: result.chars, text_path: result.textPath, audio_seconds: result.seconds });
    row = fresh(id); summary.text++;
  }
  if (!skipNotes && row.status === 'transcribed') {
    if (!llmKey) throw new Error('未配置 LLM Key');
    const result = await note({ ...row, extra_context: noteContext({ ...item, folders: folderList(row) }, row.text_source) });
    if (result.skipped) { markSkipped(id, result.reason); summary.skipped++; return; }
    const written = writeNote(row, result.note, { dir: notesDir });
    summary.transcriptLayouts.push({ id, ...written.transcript });
    markExtracted(id, { text_source: row.text_source, text_chars: row.text_chars, note_path: written.file, category: result.note.分类, decay: written.decay, retain_media: result.missingContent, prompt_hash: hash });
    summary.notes++;
  }
}

export { LoginError, PlatformPause };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!process.argv.includes('--dry-run')) { console.error('用法：node scripts/sources/bilibili/index.mjs --dry-run（日常处理由 run.mjs 统一执行）'); process.exit(2); }
  try {
    const r = await scanBilibili({ dryRun: true, log: m => console.error(m) });
    const fmt = t => t ? new Date(t * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
    console.log(`起始时间 ${fmt(r.start_at)}；收藏夹 ${r.folders.length} 个（跟踪 ${r.folders.filter(f => f.tracked).length} 个）`);
    for (const f of r.folders) console.log(`  ${f.tracked ? '✓' : '·'} ${f.id}  ${f.title}（${f.count}）`);
    console.log(`\n会进入待办的新收藏 ${r.items.length} 条：`);
    for (const it of r.items) console.log(`  ${it.aweme_id}  ${fmt(it.collected_at)}  ${Math.round((it.duration_s || 0) / 60)} 分  [${it.folders.join('、')}]  ${it.desc.slice(0, 40)}`);
  } catch (e) { console.error(e.message); process.exitCode = e.code === 4 ? 4 : 1; }
}

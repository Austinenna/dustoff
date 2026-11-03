#!/usr/bin/env node
// X 书签来源：经官方接口读取书签，与抖音、B站共用账本、额度、转写和笔记流程；
// 扫描状态、授权与限流暂停独立。
//
// 预览（只读，不写账本、不推进扫描位置；默认只读第一页以节省接口费用）：
//   node scripts/sources/x/index.mjs --dry-run [--pages N | --all]
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DUST_HOME, makeCfg } from '../../config.mjs';
import { POLICY, atomicWrite } from '../../policy.mjs';
import { importDownload, markExtracted, markRouting, markSaved, markSkipped, markTranscribed } from '../../ledger.mjs';
import { acceptIncremental, itemRow, platformState, retryItem } from '../../daily.mjs';
import { classifyItem, PURPOSES } from '../../routing.mjs';
import { createClient, PlatformPause } from './client.mjs';
import { readToken, recordSession, LoginError } from './auth.mjs';
import { scanBookmarks } from './bookmarks.mjs';
import { savePhotos, downloadVideo } from './content.mjs';
import { askNote, writePost, NOTE_HASH } from './note.mjs';

const known = id => !!itemRow(id);
const fresh = id => itemRow(id);
// 文字和图文帖子不需要模型判断用途：都存原帖，长帖和长文另外整理笔记。
export const POST_DECISION = Object.freeze({ purpose: 'note', reason: 'X 帖子：保存原帖，正文足够长时另外整理笔记', source: 'rule', model: null });

/** 扫描书签并入队。未授权或授权失效时记录状态后抛出，交给调用方作为扫描警告处理。 */
export async function scanX({ log = () => {}, client, home = DUST_HOME } = {}) {
  if (!readToken(home)) { recordSession({ logged_in: false, online: 'login_required' }, home); throw new LoginError('尚未连接 X，请在控制台点击「连接 X」'); }
  client ||= createClient({ home });
  const maxPages = Math.max(1, Math.min(20, Number(makeCfg()('DUST_X_MAX_PAGES', 5)) || 5));
  let scan;
  try { scan = await scanBookmarks({ client, state: platformState('x'), known, pageSize: 20, maxPages, log }); }
  catch (e) { if (e instanceof LoginError) recordSession({ logged_in: false, online: 'login_required' }, home); throw e; }
  for (const w of scan.warnings) log(`X：${w}`);
  const accepted = acceptIncremental('x', scan.items, scan.nextState);
  for (const item of scan.items) {
    const row = fresh(item.aweme_id);
    if (row && row.media_type === 'post' && !row.processing_mode && row.status === 'pending') markRouting(item.aweme_id, POST_DECISION);
  }
  recordSession({ logged_in: true, online: 'verified', online_checked_at: Math.floor(Date.now() / 1000), username: scan.me.username }, home);
  return { ...accepted, total: scan.total, full: scan.full };
}

export function noteContext(item) {
  const lines = ['平台：X（推特）'];
  if (item.username) lines.push(`作者账号：@${item.username}`);
  if (item.text || item.desc) lines.push(`推文正文：${String(item.text || item.desc).slice(0, 1500).replace(/\s+/g, ' ')}`);
  if (item.quoted) lines.push(`引用的推文：${String(item.quoted.text).slice(0, 500).replace(/\s+/g, ' ')}`);
  if (item.links?.length) lines.push(`推文中的链接：${item.links.map(l => l.url).join(' ')}`);
  lines.push('文字来源：视频语音转写');
  return lines.join('\n');
}

/**
 * 处理一条 X 书签。调用方已预留当天额度，失败时由调用方记账。
 * deps 便于测试替换外部调用：classify、transcribe、note、writeNote、ask、photos、video、textDir、notesDir、llm、asrKey、hash。
 */
export async function processX({ candidate, summary, log, tmp, downloadOnly = false, skipNotes = false, deps }) {
  const { classify = classifyItem, transcribe, note, writeNote, textDir, notesDir, asrKey, llm, hash,
    ask = askNote, photos: getPhotos = savePhotos, video = downloadVideo } = deps;
  let row = fresh(candidate.id);
  const item = JSON.parse(candidate.metadata), id = row.id;
  if (row.media_type === 'post') {
    if (row.processing_mode !== 'note') { markRouting(id, POST_DECISION); row = fresh(id); }
    const photos = await getPhotos(item);
    if (downloadOnly) return;
    if (row.status === 'pending') {
      const text = [item.article_title, item.text || item.desc].filter(Boolean).join('\n\n'), textPath = join(textDir, `${id}.txt`);
      atomicWrite(textPath, text);
      markTranscribed(id, { text_source: 'post', text_chars: item.chars ?? text.length, text_path: textPath, audio_seconds: null });
      row = fresh(id); summary.text++;
    }
    if (skipNotes || row.status !== 'transcribed') return;
    let written = null, refused = false;
    if ((item.chars || 0) >= POLICY.x.noteChars) {
      try { written = await ask(item, photos, llm); }
      catch (e) { if (!e.refused) throw e; written = null; refused = true; log(`X ${id}：笔记模型因内容审核拒绝整理，只保存原帖`); }
      if (written && !written.够写) { log(`X ${id}：${written.缺料说明 || '模型判断撑不起一篇笔记'}，只保存原帖`); written = null; }
    }
    const out = writePost(row, item, { dir: notesDir, photos, note: written, remark: refused ? '笔记模型因内容审核拒绝整理这篇，这里只保存原帖。' : null });
    markExtracted(id, { text_source: 'post', text_chars: row.text_chars, note_path: out.file, category: written?.分类 || null, decay: out.decay, prompt_hash: written ? NOTE_HASH : null });
    if (written) summary.notes++; else summary.archived = (summary.archived || 0) + 1;
    log(`X ${id}：${written ? '已整理笔记（含原帖）' : '已保存原帖'}${photos.length ? `，图片 ${photos.length} 张` : ''}`);
    return;
  }
  // 带视频的推文：和抖音一样由模型判断用途，判断不了的进待确认。
  if (!row.processing_mode) {
    const decision = await classify({ ...item, platform: 'x' });
    markRouting(id, decision); row = fresh(id);
    log(`用途 ${id}：${PURPOSES[decision.purpose].label}`);
    if (decision.purpose === 'review') { summary.review++; return; }
    retryItem(id); row = fresh(id);
  }
  if (row.processing_mode === 'video') {
    if (row.status === 'pending') { importDownload([await video(item, { purpose: 'video' })], 'x', { countFailures: false }); row = fresh(id); }
    if (row.status === 'downloaded') { markSaved(id); summary.saved++; log(`视频已保存 ${id}`); }
    return;
  }
  if (row.processing_mode !== 'note') throw new Error('只有知识笔记类型可以转写和整理');
  if (row.status === 'pending') {
    if ((Number(row.duration_s) || 0) > POLICY.x.asrSeconds) { markSkipped(id, 'too_long_for_asr'); summary.skipped++; log(`X ${id} 超过转写时长上限，已跳过`); return; }
    const r = await video(item, { purpose: 'note' });
    if (!r.has_audio) { importDownload([r], 'x', { countFailures: false }); markSkipped(id, 'insufficient_text'); summary.skipped++; log(`X ${id} 视频没有声音，无法整理笔记`); return; }
    importDownload([r], 'x', { countFailures: false }); row = fresh(id);
  }
  if (downloadOnly) return;
  if (row.status === 'downloaded') {
    if (!asrKey) throw new Error('未配置 ASR Key');
    const result = await transcribe(row, tmp);
    markTranscribed(id, { text_source: 'asr', text_chars: result.chars, text_path: result.textPath, audio_seconds: result.seconds });
    row = fresh(id); summary.text++;
  }
  if (!skipNotes && row.status === 'transcribed') {
    if (!llm?.key) throw new Error('未配置 LLM Key');
    const result = await note({ ...row, extra_context: noteContext(item) });
    if (result.skipped) { markSkipped(id, result.reason); summary.skipped++; return; }
    const written = writeNote(row, result.note, { dir: notesDir });
    summary.transcriptLayouts.push({ id, ...written.transcript });
    markExtracted(id, { text_source: row.text_source, text_chars: row.text_chars, note_path: written.file, category: result.note.分类, decay: written.decay, retain_media: result.missingContent, prompt_hash: hash });
    summary.notes++;
  }
}

/** 预览：按真实扫描规则读取，但不登记、不推进。pages 限制最多读取的页数。 */
export async function previewX({ client, pages = 1, all = false, home = DUST_HOME, log = () => {} } = {}) {
  if (!readToken(home)) throw new LoginError('尚未连接 X，请先在控制台点击「连接 X」');
  client ||= createClient({ home });
  const state = platformState('x');
  // 预览按每页 20 条读前几页；--all 时按首次扫描规则读到底。
  const r = await scanBookmarks({ client, state: all ? null : { ...state, complete: true }, known, pageSize: 20, maxPages: pages, log });
  recordSession({ logged_in: true, online: 'verified', online_checked_at: Math.floor(Date.now() / 1000), username: r.me.username }, home);
  return { ...r, state };
}

export { LoginError, PlatformPause };

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = process.argv.slice(2), at = args.indexOf('--pages');
  if (!args.includes('--dry-run')) { console.error('用法：node scripts/sources/x/index.mjs --dry-run [--pages N | --all]（日常处理由 run.mjs 统一执行）'); process.exit(2); }
  const pages = at >= 0 ? Math.max(1, Math.min(40, Number(args[at + 1]) || 1)) : 1;
  try {
    const r = await previewX({ pages, all: args.includes('--all'), log: m => console.error(m) });
    const fmt = t => t ? new Date(t * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
    const kind = it => it.media_type === 'video' ? `视频 ${Math.round((it.duration_s || 0) / 60)} 分` : it.is_article ? '长文' : it.media.length ? `图 ${it.media.length} 张` : '文字';
    const plan = it => it.media_type === 'video' ? '模型判断' : it.chars >= POLICY.x.noteChars ? '存档+笔记' : '存档';
    console.log(`账号 @${r.me.username}；扫描状态：${r.state ? `已于 ${fmt(r.state.scanned_at)} 扫描` : '尚未扫描（首次会读入全部书签）'}`);
    // 预览只按页数读取，不推进状态，因此不显示“下轮完整读取”之类的扫描提示。
    console.log(`本次读取 ${r.total} 条书签${r.full ? '（全部）' : `（预览只读前 ${pages} 页）`}，其中未入账 ${r.items.length} 条：`);
    for (const it of r.items) console.log(`  ${it.aweme_id}  ${fmt(it.create_time)}  @${it.username}  [${kind(it)} · ${it.chars} 字 · ${plan(it)}]${it.quoted ? ' [引用]' : ''}  ${it.desc.replace(/\s+/g, ' ').slice(0, 40)}`);
  } catch (e) { console.error(e.message); process.exitCode = e.code === 4 ? 4 : 1; }
}

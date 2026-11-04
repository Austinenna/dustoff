// B 站单条内容：详情与标签、字幕（优先）、音频流（无字幕时转写）、视频（保存用途）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA, SAVED_MEDIA, PauseError, atomicWrite, deadlineMs, localPath, storage, under, writeMedia } from '../../policy.mjs';
import { platformInfo } from '../../platforms.mjs';

export const MAX_PAGES = 30;

/** 刷新单条详情：分 P、简介、分区、标签。返回可写入队列快照的字段。 */
export async function fetchMeta(client, bvid) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('作品 ID 不合法');
  const v = await client.get('/x/web-interface/view', { bvid });
  if (v?.bvid !== bvid) throw new Error('刷新详情失败或作品不匹配');
  let tags = [];
  try { tags = ((await client.get('/x/web-interface/view/detail/tag', { bvid })) || []).map(t => t.tag_name).filter(Boolean).slice(0, 12); }
  catch (e) { if (e instanceof PauseError) throw e; } // 标签只作参考，取不到不影响处理
  const pages = (v.pages || []).slice(0, MAX_PAGES).map(p => ({ cid: p.cid, part: String(p.part || ''), duration: Number(p.duration) || 0 }));
  if (!pages.length) throw new Error('作品没有可播放的分 P');
  return {
    aweme_id: bvid, platform: 'bilibili', media_type: 'video', is_gallery: false, aid: v.aid,
    desc: v.title || '', intro: String(v.desc || '').slice(0, 2000), author: v.owner?.name || '',
    create_time: v.pubdate || null, duration_s: pages.reduce((n, p) => n + p.duration, 0) || Number(v.duration) || null,
    tname: v.tname_v2 || v.tname || '', tags, pages, page_count: (v.pages || []).length,
    meta_at: Math.floor(Date.now() / 1000),
  };
}

const HUMAN_ZH = /^zh(-|$)/i;
/** 每个分 P 都有字幕才使用字幕；人工中文字幕优先，其次 AI 中文字幕。 */
export function pickSubtitle(list, { allowAi = true } = {}) {
  const usable = (list || []).filter(s => s?.subtitle_url);
  return usable.find(s => HUMAN_ZH.test(s.lan || '') && !String(s.lan).startsWith('ai-'))
    || (allowAi ? usable.find(s => /^ai-zh/i.test(s.lan || '')) : null) || null;
}
export async function fetchSubtitles(client, meta, { allowAi = true } = {}) {
  const parts = [];
  for (const page of meta.pages) {
    const player = await client.getWbi('/x/player/wbi/v2', { bvid: meta.aweme_id, cid: page.cid });
    const chosen = pickSubtitle(player?.subtitle?.subtitles, { allowAi });
    if (!chosen) return null;
    const url = new URL(chosen.subtitle_url.startsWith('//') ? `https:${chosen.subtitle_url}` : chosen.subtitle_url);
    if (url.protocol !== 'https:' || !/(^|\.)(hdslb\.com|bilibili\.com)$/.test(url.hostname)) throw new Error('字幕地址不在 B站域名');
    const res = await client.fetchRaw(url.href);
    let body;
    try { body = await res.json(); } catch { throw new Error('字幕文件格式无效'); }
    const lines = (Array.isArray(body?.body) ? body.body : []).filter(l => typeof l?.content === 'string' && l.content.trim());
    if (!lines.length) return null;
    parts.push({ page, lan: chosen.lan, ai: String(chosen.lan).startsWith('ai-'), lines });
  }
  return subtitleText(parts);
}
/** 字幕逐行保留原文；多 P 时在各段前加一行分 P 标题。时间戳按分 P 依次累加。 */
export function subtitleText(parts) {
  const out = [], words = [];
  let offset = 0;
  for (const [i, { page, lines }] of parts.entries()) {
    if (parts.length > 1) out.push(`P${i + 1} · ${page.part || `第 ${i + 1} 集`}`);
    for (const l of lines) {
      out.push(l.content.trim());
      words.push({ t: Math.round((offset + Number(l.from || 0)) * 1000), e: Math.round((offset + Number(l.to || 0)) * 1000), w: l.content.trim() });
    }
    offset += page.duration || Number(lines.at(-1)?.to) || 0;
  }
  return { text: out.join('\n'), words, source: parts.some(p => p.ai) ? 'ai_subtitle' : 'subtitle', lan: parts[0]?.lan || null };
}

async function playurl(client, bvid, cid) {
  const data = await client.get('/x/player/playurl', { bvid, cid, fnval: 16, fourk: 1 });
  if (!data?.dash) throw new Error('没有取得 DASH 播放地址');
  return data.dash;
}
const urlsOf = s => [s.baseUrl || s.base_url, ...(s.backupUrl || s.backup_url || [])].filter(u => typeof u === 'string' && /^https:\/\//.test(u));

function probe(file, { video = false } = {}) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: deadlineMs(15000) });
  if (r.status !== 0) throw new Error('媒体校验失败');
  const data = JSON.parse(r.stdout), types = new Set((data.streams || []).map(s => s.codec_type));
  if (!types.has('audio')) throw new Error('媒体没有音轨');
  if (video && !types.has('video')) throw new Error('视频文件缺少画面');
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法验证媒体时长');
  return duration;
}
async function fetchStream(client, stream, path, { retain }) {
  let last;
  for (const url of urlsOf(stream)) {
    try {
      storage(0, { retain });
      const res = await client.fetchRaw(url);
      try { const size = Number(res.headers.get('content-length')); if (size > 0) storage(size, { retain }); }
      catch (e) { await res.body?.cancel(); throw e; }
      await writeMedia(res.body, path);
      return;
    } catch (e) { rmSync(path, { force: true }); if (e instanceof PauseError) throw e; last = e; }
  }
  throw last || new Error('没有可用的媒体地址');
}
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), deadlineMs(10 * 60_000));
    p.stderr.on('data', d => { err = (err + d).slice(-1000); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg 失败：${err.slice(-200)}`)); });
  });
}
const result = (meta, path, extra) => ({ aweme_id: meta.aweme_id, status: 'done', path, bytes: statSync(path).size, has_audio: true, ...extra });

/** 笔记用途：只下载各分 P 的最低码率音频，多 P 合并为一个 m4a，供现有转写流程使用。 */
export async function downloadAudio(client, meta) {
  const dir = localPath(join(MEDIA, meta.aweme_id)), out = join(dir, 'audio.m4a');
  if (!under(out, MEDIA)) throw new Error('音频位置不在媒体缓存目录');
  if (existsSync(out)) { try { probe(out); return result(meta, out, { gear: 'audio', quality: 'low' }); } catch { rmSync(out, { force: true }); } }
  mkdirSync(dir, { recursive: true });
  const parts = [];
  try {
    for (const [i, page] of meta.pages.entries()) {
      const dash = await playurl(client, meta.aweme_id, page.cid);
      const audio = [...(dash.audio || [])].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
      if (!audio) throw new Error(`第 ${i + 1} P 没有音频流`);
      const part = join(dir, `p${i + 1}.m4a.part`);
      await fetchStream(client, audio, part, { retain: false });
      probe(part); parts.push(part);
    }
    const temp = join(dir, 'audio.tmp.m4a');
    if (parts.length === 1) renameSync(parts[0], temp);
    else {
      storage(parts.reduce((n, p) => n + statSync(p).size, 0));
      await ffmpeg([...parts.flatMap(p => ['-f', 'mp4', '-i', p]), '-filter_complex', `concat=n=${parts.length}:v=0:a=1`, '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', temp]);
    }
    probe(temp); renameSync(temp, out);
    return result(meta, out, { gear: 'audio', quality: 'low' });
  } finally { for (const p of parts) rmSync(p, { force: true }); rmSync(join(dir, 'audio.tmp.m4a'), { force: true }); }
}

/**
 * 在不超过上限的画质里选最高的一档；同档优先 H.264（浏览器可直接播放）。
 * 上限用 B 站画质编号：80=1080p 不含 1080p 高码率(112)/高帧率(116)；0 表示不限。没有符合的就取最低一档。
 */
export function pickVideo(videos, maxQuality = 80) {
  const list = (videos || []).filter(v => Number.isFinite(v?.id));
  if (!list.length) return null;
  const allowed = maxQuality ? list.filter(v => v.id <= maxQuality) : list;
  const pool = allowed.length ? allowed : list.filter(v => v.id === Math.min(...list.map(x => x.id)));
  const top = Math.max(...pool.map(v => v.id));
  const same = pool.filter(v => v.id === top);
  return same.find(v => /^avc1/.test(v.codecs || '')) || same[0];
}

/** 视频用途：保存第 1 P 不超过画质上限的最高画质与原声，合并为 mp4。 */
export async function downloadVideo(client, meta, { maxQuality = 80, root = SAVED_MEDIA } = {}) {
  const dir = localPath(join(root, meta.aweme_id)), out = join(dir, 'video.mp4');
  if (!under(out, SAVED_MEDIA)) throw new Error('视频位置不在收藏目录');
  if (existsSync(out)) { try { probe(out, { video: true }); return result(meta, out, { gear: 'cached', quality: 'high' }); } catch { rmSync(out, { force: true }); } }
  mkdirSync(dir, { recursive: true });
  const page = meta.pages[0], dash = await playurl(client, meta.aweme_id, page.cid);
  const best = pickVideo(dash.video, maxQuality);
  const audio = [...(dash.audio || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  if (!best || !audio) throw new Error('没有取得视频或音频流');
  const v = join(dir, 'v.part'), a = join(dir, 'a.part'), temp = join(dir, 'video.tmp.mp4');
  try {
    await fetchStream(client, best, v, { retain: true });
    await fetchStream(client, audio, a, { retain: true });
    storage(statSync(v).size + statSync(a).size, { retain: true });
    await ffmpeg(['-i', v, '-i', a, '-c', 'copy', '-movflags', '+faststart', temp]);
    probe(temp, { video: true }); renameSync(temp, out);
  } finally { for (const p of [v, a, temp]) rmSync(p, { force: true }); }
  atomicWrite(join(dir, 'source.json'), JSON.stringify({ id: meta.aweme_id, title: meta.desc, author: meta.author, source: platformInfo('bilibili').url(meta.aweme_id), purpose: 'video', quality: 'high', saved_part: meta.pages.length > 1 ? 1 : null, width: best.width, height: best.height }, null, 2));
  return result(meta, out, { gear: `dash-${best.id}`, quality: 'high' });
}

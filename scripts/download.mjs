#!/usr/bin/env node
// 下载使用流式写入：每块落盘前检查容量，临时文件验证通过后才成为 video.mp4。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MEDIA, SAVED_MEDIA, POLICY, mediaDecision, storage, writeMedia, requestSignal, deadlineMs, PauseError, localPath, atomicWrite } from './policy.mjs';
import { isExpired } from './lib.mjs';
import { PURPOSES } from './routing.mjs';
const UA = 'Mozilla/5.0';
function validate(file) {
  if (!existsSync(file) || statSync(file).size <= 10000) throw new Error('视频文件过小');
  const mime = spawnSync('file', ['-b', '--mime-type', file], { encoding: 'utf8', timeout: deadlineMs(15000) });
  if (mime.status !== 0 || !mime.stdout.trim().startsWith('video/')) throw new Error('文件不是视频');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: deadlineMs(15000) });
  if (probe.status !== 0) throw new Error('视频校验失败');
  const data = JSON.parse(probe.stdout);
  if (!data.streams?.some(s => s.codec_type === 'audio')) throw new Error('视频没有音轨');
  const dur = Number(data.format?.duration);
  if (!Number.isFinite(dur) || dur <= 0) throw new Error('无法验证视频时长');
  if (dur > POLICY.seconds) { const e = new Error('视频实际时长超过上限'); e.tooLong = true; throw e; }
}
export function downloadChoices(item, quality) {
  const options = item.video_options;
  if (quality === 'high' && !options?.high) throw new Error('缺少高清档位元数据，需要刷新');
  if (options) return [options[quality],options.standard].filter(g => g?.urls?.length);
  return [{gear:item.gear,urls:item.play_urls||[]},{gear:'play_addr',urls:item.play_urls_fallback||[]}];
}
export async function downloadOne(item, { purpose = 'speech' } = {}) {
  const profile = PURPOSES[purpose];
  if (!profile?.quality) throw new Error('请先确认作品用途');
  if (!/^\d+$/.test(String(item.aweme_id))) throw new Error('作品 ID 不合法');
  const decision = mediaDecision(item);
  if (decision === 'unknown_duration') throw new Error('缺少可靠时长，等待元数据刷新');
  if (decision) return { aweme_id: item.aweme_id, status: `skipped_${decision}` };
  const dir = localPath(join(profile.retain ? SAVED_MEDIA : MEDIA, item.aweme_id)), mp4 = join(dir, 'video.mp4');
  const part = join(dir, 'video.mp4.part');
  const marker = join(dir,'download.json');
  let selected;
  const result = status => ({ aweme_id: item.aweme_id, status, path: mp4, bytes: statSync(mp4).size, has_audio: true, gear: selected?.gear || null, quality:profile.quality });
  if (existsSync(mp4)) {
    try {
      const cached = JSON.parse(readFileSync(marker,'utf8'));
      if (cached.quality !== profile.quality) throw new Error('缓存规格不同');
      validate(mp4); selected = cached; return result('cached');
    }
    catch (e) { if (e.tooLong) return { aweme_id: item.aweme_id, status: 'skipped_too_long' }; }
  }
  const choices = downloadChoices(item,profile.quality).flatMap(g => g.urls.filter(url => !isExpired([url])).map(url => ({...g,url})));
  if (!choices.length) throw new Error('下载地址缺失或过期，需要刷新');
  let last;
  for (const choice of choices) {
    const url = choice.url;
    try {
      storage(0, profile);
      if (!/^https?:\/\//.test(url)) throw new Error('下载地址协议不支持');
      const response = await fetch(url, { signal: requestSignal(), headers: { Referer: 'https://www.douyin.com/', 'User-Agent': UA } });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`下载 HTTP ${response.status}`); }
      try {
        const size = Number(response.headers.get('content-length'));
        if (size > 0) storage(size, profile);
      } catch (e) { await response.body?.cancel(); throw e; }
      await writeMedia(response.body, part);
      validate(part);
      renameSync(part, mp4);
      selected = choice;
      atomicWrite(marker, JSON.stringify({quality:profile.quality,gear:choice.gear,width:choice.width,height:choice.height}));
      atomicWrite(join(dir,'source.json'),JSON.stringify({id:item.aweme_id,title:item.desc||'',author:item.author||'',source:`https://www.douyin.com/video/${item.aweme_id}`,purpose,quality:profile.quality},null,2));
      return result('done');
    } catch (e) {
      rmSync(part, { force: true });
      if (e instanceof PauseError) throw e;
      if (e.tooLong) return { aweme_id: item.aweme_id, status: 'skipped_too_long' };
      last = e;
    }
  }
  throw last || new Error('没有可用下载地址');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  console.error('独立批量下载入口已停用。请使用 node run.mjs --download-only，以保留基线、每日额度及空间保护。');
  process.exitCode = 6;
}

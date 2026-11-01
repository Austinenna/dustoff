// B 站收藏夹增量扫描：只发现起始时间之后的新收藏，不登记存量。
//
// 收藏夹列表默认按收藏时间倒序，但用户可以手动调整收藏夹内的排序，
// 所以不能“遇到第一条旧收藏就停”。规则是：逐页读取，直到某一页没有任何新于
// 阈值的条目为止，并设页数上限。阈值 = max(起始时间, 该收藏夹上次见到的最新收藏时间)。
// 已入账的作品在入队时按 ID 去重，阈值附近的重复读取不会产生重复待办。

export const FOLDER_PAGE_SIZE = 20;

const splitList = value => String(value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
/** 收藏夹可以用 ID 或完整标题指定；含逗号的标题请用 ID。 */
export const folderMatcher = value => {
  const keys = new Set(splitList(value));
  return folder => keys.has(String(folder.id)) || keys.has(folder.title);
};
/** 解析 `收藏夹=用途` 列表，例如 `课程=note,舞蹈=video,123456=note`。 */
export function folderPurposes(value) {
  const map = new Map();
  for (const part of splitList(value)) {
    const at = part.lastIndexOf('=');
    const key = part.slice(0, at).trim(), purpose = part.slice(at + 1).trim();
    if (at > 0 && key && ['note', 'video', 'review'].includes(purpose)) map.set(key, purpose);
  }
  return map;
}
export const startOfDay = (ms = Date.now()) => { const d = new Date(ms); return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000); };
/** 起始时间：配置的日期（YYYY-MM-DD，本地 0 点），未配置时为首次启用当天 0 点。 */
export function startAt(value, now = Date.now()) {
  if (!value) return startOfDay(now);
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('DUST_BILI_START_DATE 须为 YYYY-MM-DD');
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  if (!Number.isFinite(t)) throw new Error('DUST_BILI_START_DATE 不是有效日期');
  return Math.floor(t / 1000);
}

const invalid = m => m.type !== 2 || !/^BV[0-9A-Za-z]{10}$/.test(m.bvid || '') || m.title === '已失效视频' || m.attr === 9 || m.attr === 1;
export function toItem(media, folder, fetchedAt) {
  return {
    aweme_id: media.bvid, platform: 'bilibili', media_type: 'video', is_gallery: false,
    aid: media.id, desc: media.title || '', intro: String(media.intro || '').slice(0, 2000),
    author: media.upper?.name || '', create_time: media.pubtime || media.ctime || null,
    duration_s: Number(media.duration) || null, collected_at: media.fav_time || null,
    page_count: media.page || 1, first_cid: media.ugc?.first_cid || null,
    folders: [folder.title], folder_ids: [folder.id], fetched_at: fetchedAt,
  };
}

/**
 * @param {{client, state, include?, exclude?, maxPages?, now?, startDate?, log?}} opts
 * @returns {{items, nextState, folders, warnings}}
 */
export async function scanFavorites({ client, state = null, include = '', exclude = '', maxPages = 5, now = Date.now(), startDate = '', log = () => {} }) {
  const me = await client.nav();
  if (state?.mid && state.mid !== me.mid) throw new Error('B站登录账号与此前扫描的账号不同，已停止；如需更换账号请先重置 B站扫描状态');
  const first = !state;
  const cutoff = state?.start_at ?? startAt(startDate, now);
  const fetchedAt = Math.floor(now / 1000);
  const data = await client.get('/x/v3/fav/folder/created/list-all', { up_mid: me.mid });
  const all = (data?.list || []).map(f => ({ id: String(f.id), title: String(f.title || ''), count: Number(f.media_count) || 0 }));
  const wanted = include ? folderMatcher(include) : () => true, skipped = folderMatcher(exclude);
  const folders = all.filter(f => wanted(f) && !skipped(f));
  const prev = state?.folders || {};
  const nextFolders = {}, byId = new Map(), warnings = [];
  for (const folder of folders) {
    const old = prev[folder.id];
    // 首次启用后才出现的收藏夹：只记录位置不入队，防止把移入的旧视频当成新收藏。
    const fresh = !first && !old;
    const threshold = Math.max(cutoff, old?.watermark ?? cutoff);
    let watermark = old?.watermark ?? cutoff, page = 1, more = true;
    while (more) {
      const res = await client.get('/x/v3/fav/resource/list', { media_id: folder.id, pn: page, ps: FOLDER_PAGE_SIZE, order: 'mtime', platform: 'web' });
      const medias = res?.medias || [];
      let newer = 0;
      for (const m of medias) {
        if (Number.isFinite(m.fav_time)) watermark = Math.max(watermark, m.fav_time);
        if (fresh || invalid(m) || !(m.fav_time >= threshold)) continue;
        newer++;
        const item = toItem(m, folder, fetchedAt), seen = byId.get(item.aweme_id);
        if (!seen) byId.set(item.aweme_id, item);
        else {
          seen.folders = [...new Set([...seen.folders, folder.title])];
          seen.folder_ids = [...new Set([...seen.folder_ids, folder.id])];
          seen.collected_at = Math.min(seen.collected_at || Infinity, item.collected_at || Infinity);
        }
      }
      more = !fresh && newer > 0 && !!res?.has_more;
      if (more && page >= maxPages) { warnings.push(`收藏夹「${folder.title}」新增超过 ${maxPages * FOLDER_PAGE_SIZE} 条，本轮只读前 ${maxPages} 页`); more = false; }
      page++;
    }
    nextFolders[folder.id] = { title: folder.title, watermark, count: folder.count, first_seen: old?.first_seen ?? fetchedAt };
    if (fresh) log(`发现新收藏夹「${folder.title}」，从现在开始跟踪`);
  }
  // 暂时排除的收藏夹保留原位置，重新纳入时不会把期间的收藏当成存量丢掉。
  for (const [id, value] of Object.entries(prev)) if (!nextFolders[id] && all.some(f => f.id === id)) nextFolders[id] = value;
  const nextState = { version: 1, mid: me.mid, start_at: cutoff, created_at: state?.created_at ?? fetchedAt, scanned_at: fetchedAt, folders: nextFolders };
  return { items: [...byId.values()], nextState, folders: all.map(f => ({ ...f, tracked: folders.some(x => x.id === f.id) })), warnings };
}

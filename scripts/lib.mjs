// dustoff / lib.mjs
// 三个脚本共用的小工具：挑清晰度档位、解析 CDN 地址时效。
//
// 背景（都是实测结论，改动前先读）：
//  - 抖音不提供纯音频流：aweme.video.audio 与 bit_rate_audio 均为 null，
//    也没有独立字幕轨（video_text 为空、无 cla_info）。要拿内容只能下 mp4。
//  - 一条视频通常有 12 个清晰度档位（bit_rate[]）。默认的 play_addr 是 1080p，
//    实测 2.39MB；最低档实测 0.73MB，小 3.1 倍，而两者音频轨相同、
//    画面 720x720 做字幕 OCR 也完全够。既然只要内容不要原件，就该下最低档。
//  - CDN 地址带签名且有时效：路径第二段是十六进制的 unix 过期时间戳，
//    实测有效期 3~24 小时不等（同一批里两种都有），过期后返回 403。
//    所以「扫描」和「下载」不能隔太久，且必须按地址里的实际时间戳判断，不能写死。

/** 从 CDN 地址里解析过期时间（unix 秒）。解析不出来返回 null。
 *  形如 https://v26-web.douyinvod.com/<32位hex>/<8位hex>/video/tos/...
 *  第二段就是过期时间戳。 */
export function urlExpiry(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    for (const s of segs.slice(0, 3)) {
      if (/^[0-9a-f]{8}$/i.test(s)) {
        const t = parseInt(s, 16);
        // 合理区间：2020-2035，避免把别的 8 位 hex 段误判成时间戳
        if (t > 1577836800 && t < 2051222400) return t;
      }
    }
  } catch {}
  return null;
}

/** 一组地址里最晚的过期时间；全都解析不出来返回 null。 */
export function expiryOf(urls = []) {
  const ts = urls.map(urlExpiry).filter(Boolean);
  return ts.length ? Math.max(...ts) : null;
}

/** 地址是否已过期（留 60 秒余量）。解析不出时效的一律当作「未过期」，交给下载去试。 */
export function isExpired(urls = [], now = Math.floor(Date.now() / 1000)) {
  const exp = expiryOf(urls);
  return exp === null ? false : exp <= now + 60;
}

/** 从一条 aweme 对象里挑出「码率最低」的可用档位。
 *  返回 { gear, width, height, size, urls }；没有可用 bit_rate 时回退到 play_addr。 */
export function pickLowestGear(aweme) {
  const v = (aweme && aweme.video) || {};
  const gears = (v.bit_rate || [])
    .filter(b => b && b.play_addr && Array.isArray(b.play_addr.url_list) && b.play_addr.url_list.length)
    .sort((a, b) => (a.bit_rate || 0) - (b.bit_rate || 0));

  if (gears.length) {
    const g = gears[0];
    return {
      gear: g.gear_name || null,
      width: g.play_addr.width || null,
      height: g.play_addr.height || null,
      size: g.play_addr.data_size || null,
      urls: g.play_addr.url_list.slice(),
      source: 'bit_rate',
      gear_count: gears.length,
    };
  }

  const pa = v.play_addr || {};
  return {
    gear: null,
    width: pa.width || null,
    height: pa.height || null,
    size: pa.data_size || null,
    urls: Array.isArray(pa.url_list) ? pa.url_list.slice() : [],
    source: 'play_addr',
    gear_count: 0,
  };
}

/** aweme_type：0 = 视频，68 = 图集。图集没有视频轨也没有音频轨。 */
export const isGallery = aweme =>
  (aweme && aweme.aweme_type === 68) || !!(aweme && Array.isArray(aweme.images) && aweme.images.length);

export const fmtMB = bytes => (bytes ? (bytes / 1024 / 1024).toFixed(2) + 'MB' : '?');

// 各收藏来源的身份规则。作品 ID 的格式互不重叠（抖音纯数字、B 站 BV 号、X 为 x + 推文 ID），
// 因此控制台和待办可以只凭 ID 定位条目；写入账本时仍按 (platform, id) 限定。
export const PLATFORMS = Object.freeze({
  douyin: Object.freeze({
    label:'抖音', id:/^\d{1,30}$/, referer:'https://www.douyin.com/',
    url:(id, mediaType) => `https://www.douyin.com/${mediaType === 'gallery' ? 'note' : 'video'}/${id}`,
  }),
  bilibili: Object.freeze({
    label:'B站', id:/^BV[0-9A-Za-z]{10}$/, referer:'https://www.bilibili.com/',
    url:id => `https://www.bilibili.com/video/${id}`,
  }),
  // 推文 ID 与抖音作品 ID 同为长数字，账本里加前缀 x 区分。
  x: Object.freeze({
    label:'X', id:/^x\d{1,25}$/, referer:'https://x.com/',
    url:id => `https://x.com/i/status/${String(id).slice(1)}`,
  }),
});

export function platformOfId(id) {
  const value = String(id ?? '');
  return Object.keys(PLATFORMS).find(name => PLATFORMS[name].id.test(value)) || null;
}
export const validItemId = id => !!platformOfId(id);
export function platformInfo(name) {
  const info = PLATFORMS[name];
  if (!info) throw new Error(`未知平台 ${name}`);
  return info;
}
export const sourceUrl = row => platformInfo(row.platform || platformOfId(row.id)).url(row.id, row.media_type);

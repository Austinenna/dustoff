// 各收藏来源的身份规则。作品 ID 的格式互不重叠（抖音纯数字、B 站 BV 号），
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

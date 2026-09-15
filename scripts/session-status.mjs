// 只返回登录状态与时间，绝不把 Cookie 值送到控制台。
export const isDouyinCookie = c => /(^|\.)douyin\.com$/i.test(c.domain || '');
export function cookieSession(cookies, now = Date.now()/1000) {
  const candidates=cookies.filter(c=>isDouyinCookie(c)&&/^sessionid(_ss)?$/.test(c.name)&&c.value);
  const valid=candidates.filter(c=>!c.expires||c.expires<0||c.expires>now);
  const selected=valid.find(c=>c.name==='sessionid')||valid[0];
  return {loggedIn:!!selected,expiresAt:selected?.expires>0?Math.floor(selected.expires):null};
}
export function sessionSummary(state, now=Date.now()/1000, warnDays=7) {
  const expiresAt=state?.expires_at>0?state.expires_at:null;
  const remainingSeconds=expiresAt===null?null:Math.max(0,Math.floor(expiresAt-now));
  const level=!state?'unknown':state.logged_in===false||expiresAt!==null&&expiresAt<=now?'expired':remainingSeconds===null?'unknown':remainingSeconds<warnDays*86400?'warn':'ok';
  return {logged_in:state?.logged_in??null,expires_at:expiresAt,last_check_at:state?.last_check_at??null,remainingSeconds,level,warnDays,
    stale:!state?.last_check_at||now-state.last_check_at>86400,auto_renewing:state?.auto_renewing??null,
    online:state?.online??'unknown',online_checked_at:state?.online_checked_at??null};
}
export function cookieParameters(cookies) {
  return cookies.filter(isDouyinCookie).map(c=>{
    const out={name:c.name,value:c.value,domain:c.domain,path:c.path||'/',secure:!!c.secure,httpOnly:!!c.httpOnly};
    if(c.expires>0)out.expires=c.expires;
    if(['Strict','Lax','None'].includes(c.sameSite))out.sameSite=c.sameSite;
    return out;
  });
}

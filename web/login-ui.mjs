import {escapeHtml as esc} from './markdown.mjs';
const date=seconds=>seconds?new Date(seconds*1000).toLocaleString('zh-CN',{hour12:false}):'尚未检查';
export function remainingLabel(session){
  if(session?.logged_in===false||session?.level==='expired')return '需要重新登录';
  if(session?.remainingSeconds==null)return '到期时间未知';
  const hours=Math.floor(session.remainingSeconds/3600);
  return hours>=24?`剩余约 ${Math.floor(hours/24)} 天 ${hours%24} 小时`:hours>0?`剩余约 ${hours} 小时`:'即将到期';
}
export function statusCard(session,{compact=false,busy=false}={}){
  const s=session||{},warning=['warn','expired'].includes(s.level);
  return `<div class="row between"><div><small>抖音登录</small><h2 class="session-remaining ${warning?'session-warning':''}">${esc(remainingLabel(s))}</h2></div><div class="row">${compact?'<button type="button" data-action="go-login" class="link">登录管理 ›</button>':`<button type="button" data-action="check-session" ${busy?'disabled':''}>立即检查</button><button type="button" data-action="login" class="primary" ${busy?'disabled':''}>扫码登录</button>`}</div></div>${compact?'':`<div class="session-facts"><div><small>预计到期</small><p>${s.expires_at?date(s.expires_at):'抖音未提供固定到期时间'}</p></div><div><small>最后检查</small><p>${date(s.last_check_at)}${s.stale?' · 建议更新':''}</p></div><div><small>在线验证</small><p>${s.online==='verified'?'上次已确认可用':s.online==='login_required'?'抖音要求重新登录':'尚未确认'}${s.online_checked_at?'<br><small>'+date(s.online_checked_at)+'</small>':''}</p></div></div><p class="settings-note">剩余时间按登录凭据估算，抖音可能提前使其失效。每天运行时更新到期记录，也可立即检查；剩余不足 ${s.warnDays||7} 天时提醒。</p>`}`;
}
export function loginFlow(data){
  const a=data?.auth,active=data?.active;
  if(!a||a.phase==='cancelled')return '';
  const scan=active&&data.kind!=='session-check';
  return `<div class="login-notice"><p role="status">${esc(a.message)}</p>${scan?'<p class="settings-note">使用手机抖音扫描官方页面中的二维码，并在手机上确认登录。二维码过期或需要额外验证时，直接在官方页面操作。</p>':''}${scan&&a.remote?'<div class="remote-login" data-remote-login><p class="remote-status" role="status">正在连接登录画面…</p><img class="remote-screen" alt="服务器上的抖音官方登录页面" tabindex="0" draggable="false"><div class="remote-input"><input type="text" autocomplete="off" aria-label="输入到官方页面" placeholder="先点击画面中的输入框，再在这里输入"><button type="button" data-remote-send>输入到页面</button><button type="button" data-remote-backspace>退格</button><button type="button" data-remote-reload>刷新官方页面</button></div><p class="settings-note">点击画面操作；拖动可完成滑块验证。输入内容直接发送到当前官方输入框，不保存到日志。</p></div>':''}${active?'<button type="button" data-action="cancel-login" class="link">取消本次操作</button>':''}</div>`;
}

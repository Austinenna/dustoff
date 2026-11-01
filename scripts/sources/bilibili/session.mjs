// B 站扫码登录与检查：在临时 Chrome 资料中打开官方登录页（服务器上同样转发到控制台），
// 登录成功后只把 bilibili.com 的 Cookie 存进数据目录，临时资料随即删除。Cookie 不回传网页、不写日志。
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DUST_HOME } from '../../config.mjs';
import { atomicWrite } from '../../policy.mjs';
import { launchLoginBrowser } from '../../login-browser.mjs';
import { createClient, biliSession, isBiliCookie, readCookies, saveCookies, sessionFile, LoginError } from './client.mjs';

export const LOGIN_URL = 'https://passport.bilibili.com/login';
const delay = ms => new Promise(r => setTimeout(r, ms));

function record(home, state) {
  atomicWrite(sessionFile(home), JSON.stringify({ ...state, last_check_at: Math.floor(Date.now() / 1000) }) + '\n');
}
async function verify(cookies, makeClient) {
  const session = biliSession(cookies);
  if (!session.loggedIn) return { ...session, online: 'login_required' };
  try { const me = await makeClient({ cookies }).nav(); return { ...session, online: me.mid === session.mid ? 'verified' : 'login_required' }; }
  catch (e) { return { ...session, online: e instanceof LoginError ? 'login_required' : 'unknown' }; }
}

export async function manageBiliSession({ mode = 'login', home = DUST_HOME, launch = launchLoginBrowser, makeClient = createClient, emit = () => {}, signal, wait = delay, now = Date.now, timeout = 600000, remote = false, control } = {}) {
  const check = () => { if (signal?.aborted) throw new Error('已取消登录操作'); };
  if (mode === 'check') {
    emit({ phase: 'checking', message: '正在读取 B站登录资料并在线核实…' });
    const status = await verify(readCookies(home), makeClient); check();
    record(home, { logged_in: status.loggedIn, expires_at: status.expiresAt, online: status.online, online_checked_at: Math.floor(now() / 1000) });
    emit({ phase: 'checked', message: status.online === 'verified' ? 'B站已确认登录可用' : status.online === 'login_required' ? 'B站提示需要登录' : '已更新到期时间，未能确认在线状态' });
    return;
  }
  mkdirSync(join(home, 'console'), { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(home, 'console', 'bili-profile-'));
  let browser = null;
  try {
    const deadline = now() + timeout;
    emit({ phase: 'starting', message: '正在打开 B站官方登录页…', deadline });
    browser = launch({ profile: temp, visible: true });
    const page = await browser.page(LOGIN_URL);
    if (remote) control?.setPage(page);
    while (now() < deadline) {
      check();
      const cookies = (await browser.send('Storage.getCookies')).cookies.filter(isBiliCookie);
      if (biliSession(cookies).loggedIn) {
        emit({ phase: 'saving', message: '已收到登录凭据，正在保存并核对…', deadline });
        control?.setPage(null); await browser.close(); browser = null; check();
        const status = await verify(cookies, makeClient);
        if (status.online === 'login_required') throw new Error('新登录未通过 B站验证，请重试');
        saveCookies(cookies, home);
        record(home, { logged_in: true, expires_at: status.expiresAt, online: status.online, online_checked_at: Math.floor(now() / 1000) });
        emit({ phase: 'success', message: status.online === 'verified' ? 'B站登录成功' : 'B站登录凭据已保存；在线状态暂未确认', deadline });
        return;
      }
      emit({ phase: 'window', message: remote ? '请用 B站 App 扫描下方二维码，并在手机上确认' : '请在 Chrome 中用 B站 App 扫码，完成后这里会自动更新', deadline, remote });
      await wait(1500);
    }
    emit({ phase: 'timeout', message: '本次扫码已超时，请重新开始' });
  } finally {
    control?.setPage(null);
    if (browser) await browser.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

export function nightRemoteAcceptancePlugin({ apiTarget, kind }) {
  const enabled = process.env.NIGHT_REMOTE_ACCEPTANCE === '20261107' && apiTarget === 'https://admin-test.buchuqin.com';
  const read = () => JSON.parse(fs.readFileSync('/tmp/night-remote-acceptance/state.json', 'utf8'));
  return {
    name: 'remote-night-acceptance-' + kind, apply: 'serve',
    config(_config, environment) {
      if (enabled && environment.command === 'serve') return { define: {
        'import.meta.env.VITE_NIGHT_LOCAL_PREVIEW': JSON.stringify('true'),
        'import.meta.env.VITE_WECHAT_APP_ID': JSON.stringify(kind === 'user' ? 'wx2026110700000001' : 'wx2026110700000002'),
      } };
    },
    configureServer(server) {
      if (!enabled) return;
      server.middlewares.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: ws://localhost:* ws://127.0.0.1:* https://admin-test.buchuqin.com; img-src 'self' data: blob: https://admin-test.buchuqin.com; frame-src 'none'");
        if (!req.url?.startsWith('/__night-preview/')) { next(); return; }
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const host = new URL('http://' + req.headers.host).hostname;
        if (!local || !['localhost', '127.0.0.1'].includes(host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Cache-Control', 'no-store');
        const route = new URL(req.url, 'http://' + req.headers.host);
        if (route.pathname === '/__night-preview/start') {
          if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
          try {
            const state = read(), role = route.searchParams.get('role') || (kind === 'user' ? 'buyer' : 'manager');
            const allowed = kind === 'user' ? ['candidate', 'buyer', 'foreignBuyer'] : ['manager', 'intern', 'rider', 'unbound'];
            if (!allowed.includes(role)) throw Error('role');
            const session = kind === 'user' ? state.users[role] : role === 'manager' ? state.manager : state.staffSessions?.[role];
            if (!session?.token || ![state.campusId, state.foreignCampusId].includes(session.user.campusId)) throw Error('scope');
            const nonce = randomBytes(18).toString('base64url');
            const code = kind === 'user'
              ? `localStorage.setItem('token',${JSON.stringify(session.token)});localStorage.setItem('selectedCampusId',${JSON.stringify(session.user.campusId)});localStorage.setItem(${JSON.stringify('nightBuilding:' + session.user.id + ':' + session.user.campusId)},${JSON.stringify(session.user.campusId === state.campusId ? state.buildingId : state.foreignBuildingId)});location.replace('/h5/user/m/#/pages/index/index');`
              : `localStorage.setItem('staffToken',${JSON.stringify(session.token)});localStorage.setItem('staffTokenRole',${JSON.stringify(session.user.role)});localStorage.setItem('staffRole',${JSON.stringify(session.user.role)});localStorage.removeItem('staffGuestMode');location.replace('/h5/delivery/m/#/pages/index/index');`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`);
            res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>测试服务器夜宵验收</title><body>仅测试组织 · 正在进入…<script nonce="${nonce}">${code}</script></body></html>`);
          } catch { res.statusCode = 503; res.end('测试会话或资格未准备完成'); }
          return;
        }
        const deposit = route.pathname === '/__night-preview/deposit-pay';
        const day = route.pathname === '/__night-preview/day-pay';
        if (!(deposit && kind === 'delivery') && !(['/__night-preview/pay', '/__night-preview/day-pay'].includes(route.pathname) && kind === 'user')) { res.statusCode = 404; res.end(); return; }
        if (req.method !== 'POST' || !req.headers['content-type']?.includes('application/json')) { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
        req.on('end', () => {
          try {
            const state = read(), id = JSON.parse(body)[deposit ? 'depositOrderId' : 'orderId'];
            const owner = deposit ? state.mainStaffId : state.users.buyer.user.id;
            if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(owner || '')) throw Error('id');
            execFile('ssh', ['-o', 'BatchMode=yes', '139.199.3.190-buchuqin-test', 'docker', 'exec', '-w', '/app', 'buchuqin-api', 'node', '/acceptance/confirm.mjs', deposit ? 'deposit' : day ? 'day' : 'user', id, owner], { timeout: 25000 }, error => {
              res.setHeader('Content-Type', 'application/json'); res.statusCode = error ? 400 : 200;
              res.end(JSON.stringify(error ? { message: '测试组织模拟确认失败，请核对单据归属与状态' } : { externalSimulation: true, confirmed: true }));
            });
          } catch { res.statusCode = 400; res.end(); }
        });
      });
    },
  };
}

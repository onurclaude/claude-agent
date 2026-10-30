'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const config = require('../src/config');
const { StateStore } = require('../src/state');
const { IsolationError } = require('../src/claude');
const { Supervisor } = require('../src/supervisor');
const { RemoteControl } = require('../src/rc');
const { LoginFlow } = require('../src/login');

const SECRET = 'S3CRETCODE9876';
const flush = () => new Promise((r) => setTimeout(r, 30));

function harness({ allowed = ['onur'], github = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-sup-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ github: { repo: 'o/r', issue: 1, allowedUsers: allowed }, logoutConfirmations: 2 }));
  const cfg = config.load(home);
  const h = {
    cfg, posts: [], logs: [], comments: [], deleted: [], flows: [], nextId: 100,
    auth: { loggedIn: true }, authErr: null, online: true, isPrivate: true, deleteFails: false, rcLog: [],
  };
  h.state = new StateStore(cfg.paths.stateFile);
  h.claude = { authStatus: async () => { if (h.authErr) throw h.authErr; return h.auth; } };
  h.github = {
    listComments: async () => h.comments.slice(),
    // Ajanin kendi yorumlari da listede gorunur (gercek GitHub gibi); komut sayilmamalidir.
    comment: async (t) => { h.posts.push(t); const id = h.nextId++; h.comments.push({ id, user: { login: 'onur' }, body: t, created_at: new Date().toISOString() }); return { id }; },
    deleteComment: async (id) => { if (h.deleteFails) throw new Error('GitHub DELETE -> 403'); h.deleted.push(id); },
    assertPrivate: async () => { if (!h.isPrivate) throw new Error('depo ozel degil'); },
  };
  h.rc = {
    running: false,
    async ensure() { this.running = true; h.rcLog.push('ensure'); },
    async stop() { this.running = false; h.rcLog.push('stop'); },
    async cleanupOrphan() {},
  };
  h.loginFactory = ({ onUrl }) => {
    const n = h.flows.length + 1;
    const f = {
      id: `f${n}`, state: `ST${n}`, urlCommentId: null, submitted: [], codeSent: false, cancelled: false,
      run() { return new Promise((res) => { f.finish = res; onUrl(`https://claude.com/cai/oauth/authorize?code=true&state=ST${n}`, f); }); },
      submitCode(c) { if (f.codeSent) return false; f.codeSent = true; f.submitted.push(c); return true; },
      async cancel() { f.cancelled = true; f.finish({ ok: false, reason: 'iptal edildi', rejected: false }); },
    };
    h.flows.push(f);
    return f;
  };
  const log = { info: (...a) => h.logs.push(a.join(' ')), warn: (...a) => h.logs.push(a.join(' ')), error: (...a) => h.logs.push(a.join(' ')) };
  h.sup = new Supervisor({
    cfg, log, state: h.state, claude: h.claude, github: github ? h.github : null,
    net: { online: async () => h.online }, rc: h.rc, loginFactory: (a) => h.loginFactory(a), sleep: async () => {},
  });
  h.say = (user, body, id) => { h.comments.push({ id: id ?? h.nextId++, user: { login: user }, body, created_at: new Date().toISOString(), html_url: 'https://github.com/o/r/issues/1#c' }); };
  return h;
}

// Oturum acik -> kapali; ajan girisi KENDILIGINDEN baslatir ve baglantiyi yazar.
async function loggedOut(h) {
  await h.sup.tick();
  h.auth = { loggedIn: false };
  await h.sup.tick();
  await h.sup.tick();
  await flush();
  assert.equal(h.sup.mode, 'LOGIN_PENDING');
}

test('oturum aciksa remote-control baslatilir ve durum RUNNING olur', async () => {
  const h = harness();
  await h.sup.tick();
  assert.equal(h.sup.mode, 'RUNNING');
  assert.deepEqual(h.rcLog, ['ensure']);
});

test('tek basarisiz kontrol logout sayilmaz; ardisik ikinci sayilir, rc durur', async () => {
  const h = harness();
  await h.sup.tick();
  h.auth = { loggedIn: false };
  await h.sup.tick();
  assert.equal(h.sup.mode, 'RUNNING');
  assert.equal(h.flows.length, 0);
  await h.sup.tick();
  assert.ok(h.rcLog.includes('stop'));
  assert.ok(h.state.data.lastLogoutAt);
});

test('internet yokken logout karari verilmez, giris baslamaz', async () => {
  const h = harness();
  await h.sup.tick();
  h.auth = { loggedIn: false };
  h.online = false;
  for (let i = 0; i < 5; i++) await h.sup.tick();
  assert.equal(h.sup.mode, 'OFFLINE');
  assert.equal(h.flows.length, 0);
  assert.ok(!h.rcLog.includes('stop'));
});

test('auth status calismazsa (belirsiz hata) logout sayilmaz', async () => {
  const h = harness();
  await h.sup.tick();
  h.authErr = new Error('zaman asimi');
  for (let i = 0; i < 4; i++) await h.sup.tick();
  assert.equal(h.sup.mode, 'RUNNING');
});

test('logout algilaninca /login beklemeden giris baslar ve baglanti issue\'ya yazilir', async () => {
  const h = harness();
  await loggedOut(h);
  assert.equal(h.flows.length, 1);
  const urlPost = h.posts.find((p) => p.includes('https://claude.com/cai/oauth/authorize'));
  assert.ok(urlPost && urlPost.includes('/code KOD'));
  assert.ok(h.flows[0].urlCommentId > 0);
});

test('/code KOD: ayni giris surecine iletilir, yorum silinir, girisin dogrulanmasiyla RC yeniden baslar', async () => {
  const h = harness();
  await loggedOut(h);
  const f = h.flows[0];
  h.rcLog.length = 0;
  h.say('onur', `/code ${SECRET}#${f.state}`, 500);
  await h.sup.tick();
  await flush();
  assert.deepEqual(f.submitted, [`${SECRET}#ST1`]);
  assert.ok(h.deleted.includes(500), 'kod yorumu silinmeli');

  h.auth = { loggedIn: true };
  f.finish({ ok: true, reason: null, rejected: false });
  await flush();
  assert.equal(h.sup.mode, 'RUNNING');
  assert.deepEqual(h.rcLog, ['stop', 'ensure']);
  assert.ok(h.deleted.includes(f.urlCommentId), 'baglanti yorumu silinmeli');
  assert.ok(h.posts.some((p) => p.includes('Giris basarili')));
  // kod hicbir yere sizmamali
  assert.ok(!fs.readFileSync(h.cfg.paths.stateFile, 'utf8').includes(SECRET));
  assert.ok(!h.logs.join('\n').includes(SECRET));
  assert.ok(!h.posts.join('\n').includes(SECRET));
});

test('CLI cikis kodu 0 olsa bile auth status dogrulamazsa basari sayilmaz', async () => {
  const h = harness();
  await loggedOut(h);
  h.flows[0].finish({ ok: true, reason: null, rejected: false });
  await flush();
  assert.notEqual(h.sup.mode, 'RUNNING');
  assert.ok(!h.posts.some((p) => p.includes('Giris basarili')));
});

test('yetkisiz kullanicinin /code yorumu iletilmez ve dokunulmaz', async () => {
  const h = harness();
  await loggedOut(h);
  h.say('baskasi', `/code ${SECRET}`, 501);
  await h.sup.tick();
  assert.deepEqual(h.flows[0].submitted, []);
  assert.ok(!h.deleted.includes(501));
});

test('baska giris isleminin kodu (state uyusmuyor) iletilmez, yorum silinir', async () => {
  const h = harness();
  await loggedOut(h);
  h.say('onur', `/code ${SECRET}#ESKI_STATE`, 502);
  await h.sup.tick();
  assert.deepEqual(h.flows[0].submitted, []);
  assert.ok(h.deleted.includes(502));
});

test('baglanti yorumundan ONCE yazilmis (eski) kod iletilmez', async () => {
  const h = harness();
  await loggedOut(h);
  h.say('onur', `/code ${SECRET}`, h.flows[0].urlCommentId - 0.5);
  await h.sup.tick();
  assert.deepEqual(h.flows[0].submitted, []);
  assert.ok(h.deleted.includes(h.flows[0].urlCommentId - 0.5));
});

test('bicimi bozuk /code silinir, iletilmez', async () => {
  const h = harness();
  await loggedOut(h);
  h.say('onur', '/code', 503);
  h.say('onur', '/code abc; calc.exe', 504);
  await h.sup.tick();
  assert.deepEqual(h.flows[0].submitted, []);
  assert.ok(h.deleted.includes(503) && h.deleted.includes(504));
});

test('yorum silinemezse uyari yorumu olusur, kod yine de iletilir', async () => {
  const h = harness();
  await loggedOut(h);
  h.deleteFails = true;
  h.say('onur', `/code ${SECRET}#ST1`, 505);
  await h.sup.tick();
  assert.equal(h.flows[0].submitted.length, 1);
  assert.ok(h.posts.some((p) => p.includes('silinemedi') && p.startsWith('⚠️')));
  assert.ok(h.logs.some((l) => l.includes('SILINEMEDI')));
});

test('kod reddedilirse yeni giris sureci ve yeni baglanti uretilir', async () => {
  const h = harness();
  await loggedOut(h);
  const f1 = h.flows[0];
  h.say('onur', `/code ${SECRET}#ST1`, 506);
  await h.sup.tick();
  f1.finish({ ok: false, reason: 'kod kabul edilmedi', rejected: true });
  await flush();
  assert.equal(h.flows.length, 2);
  assert.ok(h.deleted.includes(f1.urlCommentId));
  assert.equal(h.sup.mode, 'LOGIN_PENDING');
  assert.ok(h.posts.some((p) => p.includes('(#f2)')));
  // eski sureci hedefleyen kod artik yeni surece gitmez
  h.say('onur', `/code ${SECRET}#ST1`, 507);
  await h.sup.tick();
  assert.deepEqual(h.flows[1].submitted, []);
});

test('zaman asimi: geri cekilmeden sonra yeni giris sureci baslar', async () => {
  const h = harness();
  await loggedOut(h);
  h.flows[0].finish({ ok: false, reason: 'giris sureci kod 1 ile cikti (zaman asimi/iptal)', rejected: false });
  await flush();
  assert.equal(h.sup.mode, 'LOGGED_OUT');
  await h.sup.tick();
  assert.equal(h.flows.length, 1, 'geri cekilme suresi dolmadan yeniden baslamaz');
  h.sup.nextLoginAt = 0;
  await h.sup.tick();
  await flush();
  assert.equal(h.flows.length, 2);
});

test('/cancel-login otomatik girisi durdurur, /login surdurur', async () => {
  const h = harness();
  await loggedOut(h);
  h.say('onur', '/cancel-login');
  await h.sup.tick();
  await flush();
  assert.equal(h.flows[0].cancelled, true);
  assert.equal(h.sup.mode, 'LOGGED_OUT');
  await h.sup.tick();
  assert.equal(h.flows.length, 1);
  h.say('onur', '/login');
  await h.sup.tick();
  await flush();
  assert.equal(h.flows.length, 2);
});

test('giris PC\'de tarayicidan tamamlanirsa bekleyen surec ve baglanti yorumu temizlenir', async () => {
  const h = harness();
  await loggedOut(h);
  h.auth = { loggedIn: true };
  await h.sup.tick();
  await flush();
  assert.equal(h.sup.mode, 'RUNNING');
  assert.equal(h.flows[0].cancelled, true);
  assert.ok(h.deleted.includes(h.flows[0].urlCommentId));
});

test('depo ozel degilse giris baslatilmaz ve baglanti yazilmaz', async () => {
  const h = harness();
  h.isPrivate = false;
  await h.sup.tick();
  h.auth = { loggedIn: false };
  await h.sup.tick();
  await h.sup.tick();
  await flush();
  assert.equal(h.flows.length, 0);
  assert.ok(!h.posts.some((p) => p.includes('oauth')));
  assert.ok(h.logs.some((l) => l.includes('ozel degil')));
});

test('GitHub ayarsizsa otomatik giris baslamaz (baglantiyi iletecek kanal yok)', async () => {
  const h = harness({ github: false });
  await h.sup.tick();
  h.auth = { loggedIn: false };
  await h.sup.tick();
  await h.sup.tick();
  assert.equal(h.flows.length, 0);
});

test('logout aninda var olan eski /code ve /login yorumlari yeniden calistirilmaz', async () => {
  const h = harness();
  h.say('onur', '/login');
  h.say('onur', `/code ${SECRET}`);
  await loggedOut(h);
  await h.sup.tick();
  assert.equal(h.flows.length, 1);
  assert.deepEqual(h.flows[0].submitted, []);
});

test('izolasyon hatasinda ajan durur (kod 3), bekleyen giris iptal edilir', async () => {
  const h = harness();
  await loggedOut(h);
  h.authErr = new IsolationError('beklenmeyen dizin');
  await h.sup.tick();
  assert.equal(h.sup.mode, 'HALTED_ISOLATION');
  assert.equal(h.sup.exitCode, 3);
  assert.equal(h.flows[0].cancelled, true);
});

test('yerel giris istegi dosyasi mevcut sureci yenisiyle degistirir', async () => {
  const h = harness();
  await loggedOut(h);
  fs.writeFileSync(h.cfg.paths.loginRequestFile, 'x');
  await h.sup.tick();
  await flush();
  assert.equal(h.flows.length, 2);
  assert.ok(!fs.existsSync(h.cfg.paths.loginRequestFile));
});

// ---- RemoteControl: sahte surec ile ----
function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.written = [];
  c.stdin = { writable: true, write: (s) => c.written.push(s) };
  return c;
}

test('remote-control: dogru bayraklarla baslar, URL yakalar, cokunce backoff ile yeniden baslar', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-rc-'));
  const cfg = config.load(home);
  fs.mkdirSync(cfg.paths.logDir, { recursive: true });
  const state = new StateStore(cfg.paths.stateFile);
  const spawned = [];
  let t = 1000000;
  const claude = { spawn: (args, o) => { const c = fakeChild(); spawned.push({ args, o, c }); return c; }, ensureWorkspaceTrusted: () => false };
  const quiet = { info() {}, warn() {}, error() {} };
  const rc = new RemoteControl({ cfg, claude, state, log: quiet, now: () => t });

  await rc.ensure();
  const a = spawned[0].args;
  assert.equal(a[0], 'remote-control');
  assert.ok(a.includes('--name') && a.includes('--permission-mode'));
  assert.ok(!a.includes('--continue'));
  assert.equal(spawned[0].o.cwd, cfg.paths.workspace);

  spawned[0].c.stdout.emit('data', 'Session: https://claude.ai/code/session_ABC\n');
  assert.equal(state.data.rc.url, 'https://claude.ai/code/session_ABC');

  t += 2000;
  spawned[0].c.emit('exit', 1);
  await rc.ensure();
  assert.equal(spawned.length, 1);
  t += 11000;
  await rc.ensure();
  assert.equal(spawned.length, 2);
});

test('remote-control: --continue basarisizsa bir sonraki denemede kullanilmaz', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-rc2-'));
  const cfg = config.load(home);
  fs.mkdirSync(cfg.paths.logDir, { recursive: true });
  const state = new StateStore(cfg.paths.stateFile);
  state.update((s) => { s.rc.hadSession = true; });
  const spawned = [];
  let t = 1;
  const claude = { spawn: (args) => { const c = fakeChild(); spawned.push({ args, c }); return c; }, ensureWorkspaceTrusted: () => false };
  const rc = new RemoteControl({ cfg, claude, state, log: { info() {}, warn() {}, error() {} }, now: () => t });
  await rc.ensure();
  assert.ok(spawned[0].args.includes('--continue'));
  t += 3000;
  spawned[0].c.emit('exit', 1);
  t += 600000;
  await rc.ensure();
  assert.ok(!spawned[1].args.includes('--continue'));
});

test('remote-control: ilk kullanim onayina "y" verir, URL OSC/ANSI icinden ayiklanir, tekrar eden ekran loglanmaz', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-rc3-'));
  const cfg = config.load(home);
  fs.mkdirSync(cfg.paths.logDir, { recursive: true });
  const state = new StateStore(cfg.paths.stateFile);
  const spawned = [];
  const claude = { spawn: () => { const c = fakeChild(); spawned.push(c); return c; }, ensureWorkspaceTrusted: () => false };
  const rc = new RemoteControl({ cfg, claude, state, log: { info() {}, warn() {}, error() {} } });
  await rc.ensure();
  const c = spawned[0];
  c.stdout.emit('data', 'Enable Remote Control? (y/n) ');
  const NL = String.fromCharCode(10), ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
  assert.deepEqual(c.written, ['y' + NL]);
  const link = ESC + ']8;;https://claude.ai/code/session_01ABC-def?from=cli' + BEL + 'Attached' + ESC + ']8;;' + BEL;
  const screen = ESC + '[8A' + ESC + '[J' + 'Connected ws' + NL + '    ' + link + NL;
  for (let i = 0; i < 5; i++) c.stdout.emit('data', screen);
  assert.equal(state.data.rc.url, 'https://claude.ai/code/session_01ABC-def');
  const logged = fs.readFileSync(path.join(cfg.paths.logDir, 'remote-control.log'), 'utf8');
  assert.equal(logged.split('Connected').length - 1, 1);
});

// ---- LoginFlow ----
function flowWithFakeChild() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-login-'));
  const cfg = config.load(home);
  const child = new EventEmitter();
  child.pid = 1;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const written = [];
  child.stdin = { writable: true, write: (s) => written.push(s) };
  const urls = [];
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const flow = new LoginFlow({ cfg, claude: { spawn: () => child }, log, onUrl: (u, f) => urls.push([u, f]) });
  return { flow, child, written, urls, logs, cfg };
}

test('LoginFlow: URL ve state yakalanir, kod bellekten stdin\'e gider, loglanmaz; yalnizca bir kez', async () => {
  const { flow, child, written, urls, logs } = flowWithFakeChild();
  const p = flow.run();
  child.stdout.emit('data', 'visit: https://claude.com/cai/oauth/authorize?code=true&state=XYZ123\nPaste code here > ');
  assert.equal(urls.length, 1);
  assert.equal(flow.state, 'XYZ123');
  assert.equal(urls[0][1], flow);
  assert.equal(flow.submitCode(`${SECRET}#XYZ123`), true);
  assert.equal(flow.submitCode('ikinci'), false);
  assert.deepEqual(written, [`${SECRET}#XYZ123\n`]);
  assert.ok(!logs.join('\n').includes(SECRET));
  child.stderr.emit('data', 'Login failed: That code wasn\'t accepted.');
  child.emit('exit', 1);
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.rejected, true);
});

test('LoginFlow: kod gonderilmeden cikis = reddedilmis sayilmaz; basarili cikis ok', async () => {
  const a = flowWithFakeChild();
  const pa = a.flow.run();
  a.child.emit('exit', 1);
  assert.deepEqual({ ok: (await pa).ok, rejected: (await pa).rejected }, { ok: false, rejected: false });
  const b = flowWithFakeChild();
  const pb = b.flow.run();
  b.flow.submitCode('ABCDEFGH1234');
  b.child.emit('exit', 0);
  const rb = await pb;
  assert.equal(rb.ok, true);
  assert.equal(rb.rejected, false);
});

test('LoginFlow: yerel yedek yol (submit-code dosyasi) calisir ve dosya silinir', async () => {
  const { flow, child, written, cfg } = flowWithFakeChild();
  const p = flow.run();
  fs.writeFileSync(cfg.paths.loginCodeFile, 'LOCALCODE123\n');
  await new Promise((r) => setTimeout(r, 2300));
  assert.deepEqual(written, ['LOCALCODE123\n']);
  assert.ok(!fs.existsSync(cfg.paths.loginCodeFile));
  child.emit('exit', 0);
  assert.equal((await p).ok, true);
});

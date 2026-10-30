'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCommand } = require('../src/commands');
const { redact } = require('../src/logger');
const { extractUrl } = require('../src/login');
const config = require('../src/config');
const { ClaudeCli, IsolationError, assertSafeConfigDir, BLOCKED_ENV } = require('../src/claude');
const { StateStore } = require('../src/state');
const lock = require('../src/lock');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-'));

test('komut ayristirma: yalnizca ilk satirdaki /komut', () => {
  assert.equal(parseCommand('/login'), 'login');
  assert.equal(parseCommand('\n  /LOGIN  lutfen'), 'login');
  assert.equal(parseCommand('/cancel-login'), 'cancel-login');
  assert.equal(parseCommand('merhaba\n/login'), null);
  assert.equal(parseCommand('🤖 /login'), null);
  assert.equal(parseCommand('/rm -rf'), null);
  assert.equal(parseCommand(''), null);
});

test('log maskeleme: token, kod ve state', () => {
  const s = redact('Bearer abc.def-123 sk-ant-oat01-XYZ_9 ghp_' + 'a'.repeat(30) + ' https://x/cb?code=SECRET&state=ST&ok=1');
  for (const leak of ['abc.def-123', 'XYZ_9', 'SECRET', 'ST&', 'aaaaaaaaaaaa']) assert.ok(!s.includes(leak), leak);
  assert.ok(s.includes('ok=1'));
});

test('giris URL ayiklama', () => {
  const out = 'Opening browser...\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code here > ';
  assert.equal(extractUrl(out), 'https://claude.com/cai/oauth/authorize?code=true&x=1');
  assert.equal(extractUrl('hic url yok'), null);
});

test('config: varsayilanlar, dogrulama, yollar', () => {
  const home = tmp();
  const c = config.load(home);
  assert.equal(c.paths.claudeConfigDir, path.join(home, 'claude-config'));
  assert.equal(c.authCheckIntervalSec, 60);
  assert.equal(c.githubPollIntervalSec, 60);
  fs.writeFileSync(path.join(home, 'config.json'), '\uFEFF' + JSON.stringify({ github: { repo: 'a/b', issue: 3, allowedUsers: ['Onur'] }, remoteControl: { permissionMode: 'plan' } }));
  const c2 = config.load(home);
  assert.deepEqual(c2.github.allowedUsers, ['onur']);
  assert.equal(c2.remoteControl.permissionMode, 'plan');
  assert.equal(c2.remoteControl.enabled, true);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ remoteControl: { name: 'x"; calc' } }));
  assert.throws(() => config.load(home), /remoteControl\.name/);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ remoteControl: { permissionMode: 'yolo' } }));
  assert.throws(() => config.load(home), /permissionMode/);
});

test('izolasyon: global ve yabanci dizinlerle cakisma reddedilir', () => {
  const home = os.homedir();
  assert.throws(() => assertSafeConfigDir(path.join(home, '.claude')), IsolationError);
  assert.throws(() => assertSafeConfigDir(path.join(home, '.claude', 'alt')), IsolationError);
  assert.throws(() => assertSafeConfigDir(home), IsolationError);
  assert.throws(() => assertSafeConfigDir('goreli\\yol'), IsolationError);
  assert.throws(() => assertSafeConfigDir('C:\\Hesaplar\\B\\sub', { foreignDirs: ['C:\\Hesaplar\\B'] }), IsolationError);
  assert.doesNotThrow(() => assertSafeConfigDir(path.join(tmp(), 'claude-config')));
});

function fakeCli(statusJson, { code = 0 } = {}) {
  const cfg = config.load(tmp());
  const calls = [];
  const runner = async (exe, args, opts) => { calls.push({ args, env: opts.env }); return { code, stdout: typeof statusJson === 'string' ? statusJson : JSON.stringify(statusJson), stderr: '' }; };
  const cli = new ClaudeCli(cfg, { runner, foreignDirs: [] });
  cli._exe = 'claude.exe';
  return { cli, cfg, calls };
}

test('authStatus: CLAUDE_CONFIG_DIR zorlanir, API anahtari ortamdan silinir', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const { cli, cfg, calls } = fakeCli(null);
  cli.runner = async (exe, args, opts) => {
    calls.push(opts.env);
    return { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: cfg.paths.claudeConfigDir }), stderr: '' };
  };
  const st = await cli.authStatus();
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(st.loggedIn, false);
  assert.equal(calls[0].CLAUDE_CONFIG_DIR, cfg.paths.claudeConfigDir);
  for (const k of BLOCKED_ENV) assert.equal(calls[0][k], undefined);
});

test('authStatus: baska dizin bildirilirse IsolationError', async () => {
  const { cli } = fakeCli({ loggedIn: true, authMethod: 'claude.ai', configDirectory: 'C:\\Users\\x\\.claude' });
  await assert.rejects(cli.authStatus(), IsolationError);
});

test('authStatus: abonelik disi yontem reddedilir; bozuk cikti cikis sayilmaz', async () => {
  const a = fakeCli(null);
  a.cli.runner = async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'apiKey', configDirectory: a.cfg.paths.claudeConfigDir }), stderr: '' });
  await assert.rejects(a.cli.authStatus(), IsolationError);
  const b = fakeCli('<<bozuk>>');
  await assert.rejects(b.cli.authStatus(), (e) => !(e instanceof IsolationError) && /okunamadi/.test(e.message));
});

test('ensureWorkspaceTrusted yalnizca izole dizindeki .claude.json dosyasini degistirir', () => {
  const { cli, cfg } = fakeCli({});
  fs.mkdirSync(cfg.paths.claudeConfigDir, { recursive: true });
  assert.equal(cli.ensureWorkspaceTrusted(cfg.paths.workspace), false);
  fs.writeFileSync(path.join(cfg.paths.claudeConfigDir, '.claude.json'), '{"a":1}');
  assert.equal(cli.ensureWorkspaceTrusted(cfg.paths.workspace), true);
  const j = JSON.parse(fs.readFileSync(path.join(cfg.paths.claudeConfigDir, '.claude.json'), 'utf8'));
  assert.equal(j.a, 1);
  assert.equal(j.projects[cfg.paths.workspace].hasTrustDialogAccepted, true);
});

test('state: atomik yazma, bozuk dosyada sifirdan baslama', () => {
  const f = path.join(tmp(), 'state.json');
  const s = new StateStore(f);
  s.update((d) => { d.mode = 'RUNNING'; });
  assert.equal(new StateStore(f).data.mode, 'RUNNING');
  fs.writeFileSync(f, '{bozuk');
  assert.equal(new StateStore(f).data.mode, 'STARTING');
  assert.ok(fs.readdirSync(path.dirname(f)).some((n) => n.includes('corrupt')));
});

test('kilit: ikinci ornek reddedilir, olu PID devralinir', async () => {
  const f = path.join(tmp(), 'agent.lock');
  const alive = { isAlive: () => true, commandLine: async () => 'node cli.js run' };
  const rel = await lock.acquire(f);
  assert.ok(rel);
  fs.writeFileSync(f, '999999');
  assert.equal(await lock.acquire(f, alive), null);
  assert.ok(await lock.acquire(f, { isAlive: () => false, commandLine: async () => null }));
});

const { parseCode } = require('../src/commands');
const { GitHub, NotPrivateError } = require('../src/github');

test('/code ayristirma: gecerli, bozuk ve kod-olmayan yorumlar', () => {
  assert.equal(parseCode('/code ABCD1234efgh#state-1'), 'ABCD1234efgh#state-1');
  assert.equal(parseCode('\n /CODE   ABCD1234efgh  '), 'ABCD1234efgh');
  assert.equal(parseCode('/code'), null);
  assert.equal(parseCode('/code kisa'), null);
  assert.equal(parseCode('/code abcdefgh; calc'), null);
  assert.equal(parseCode('/login'), undefined);
  assert.equal(parseCode('merhaba /code ABCD1234'), undefined);
  assert.equal(parseCommand('/code ABCD1234'), null);
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts.method });
    const key = `${opts.method} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, headers: new Map() };
    return { ok: true, status: r.status || 200, headers: new Map(), json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

test('github: ozel olmayan depo reddedilir, ozel depo onbelleklenir; yorum silme DELETE kullanir', async () => {
  const pub = new GitHub({ repo: 'o/r', issue: 1, token: 't', fetchFn: fakeFetch({ 'GET /repos/o/r': { body: { private: false } } }) });
  await assert.rejects(pub.assertPrivate(), NotPrivateError);
  const f = fakeFetch({ 'GET /repos/o/r': { body: { private: true } }, 'DELETE /repos/o/r/issues/comments/77': { status: 204 } });
  const priv = new GitHub({ repo: 'o/r', issue: 1, token: 't', fetchFn: f });
  await priv.assertPrivate();
  await priv.assertPrivate();
  assert.equal(f.calls.filter((c) => c.method === 'GET').length, 1);
  await priv.deleteComment(77);
  assert.ok(f.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/issues/comments/77')));
});

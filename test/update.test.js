'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const config = require('../src/config');
const { StateStore } = require('../src/state');
const { RemoteControl } = require('../src/rc');
const update = require('../src/update');

const PROJECT = path.join(__dirname, '..');
const SHA = 'a'.repeat(40);
const quiet = { info() {}, warn() {}, error() {} };

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.exitCode = null;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = { writable: true, write() {} };
  return c;
}

function rcWith(child) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-upd-'));
  const cfg = config.load(home);
  fs.mkdirSync(cfg.paths.logDir, { recursive: true });
  const state = new StateStore(cfg.paths.stateFile);
  const claude = { spawn: () => child, ensureWorkspaceTrusted: () => false };
  const rc = new RemoteControl({ cfg, claude, state, log: quiet });
  return { cfg, state, rc, claude };
}

test('rc.detach/adopt: surec oldurulmeden yeni nesneye devredilir, dinleyiciler yeniden baglanir', async () => {
  const child = fakeChild();
  const { cfg, state, rc, claude } = rcWith(child);
  await rc.ensure();
  assert.equal(rc.running, true);

  const handoff = rc.detach();
  assert.equal(rc.running, false);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0);

  const rc2 = new RemoteControl({ cfg, claude, state, log: quiet });
  rc2.adopt(handoff);
  assert.equal(rc2.running, true);
  assert.equal(child.listenerCount('exit'), 1);

  child.stdout.emit('data', 'Session: https://claude.ai/code/session_NEW1\n');
  assert.equal(state.data.rc.url, 'https://claude.ai/code/session_NEW1');
  assert.equal(rc.running, false); // eski nesne artik sahip degil

  child.emit('exit', 1);
  assert.equal(rc2.running, false);
  assert.equal(state.data.rc.restarts, 1);
});

test('rc.adopt: devir sirasinda cikmis surec hemen cikis olarak islenir', async () => {
  const child = fakeChild();
  const { cfg, state, rc, claude } = rcWith(child);
  await rc.ensure();
  const handoff = rc.detach();
  child.exitCode = 1;
  const rc2 = new RemoteControl({ cfg, claude, state, log: quiet });
  rc2.adopt(handoff);
  assert.equal(rc2.running, false);
  assert.equal(state.data.rc.restarts, 1);
});

// Gercek proje dosyalarindan bir "GitHub arsivi" (zip) uretir.
function makeZip(dir) {
  const top = path.join(dir, 'claude-agent-main');
  fs.mkdirSync(top, { recursive: true });
  for (const n of ['src', 'scripts', 'package.json', 'config.example.json']) fs.cpSync(path.join(PROJECT, n), path.join(top, n), { recursive: true });
  fs.appendFileSync(path.join(top, 'src', 'update.js'), '\n// guncelleme testi isareti\n');
  const zip = path.join(dir, 'main.zip');
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', dir, 'claude-agent-main'], { windowsHide: true });
  return fs.readFileSync(zip);
}

function fetchFor(zipBuf, { sha = SHA, counter } = {}) {
  return async (url) => {
    if (counter) counter.n += 1;
    if (url.includes('/commits/main')) return new Response(sha);
    if (url.includes('codeload.github.com')) return new Response(zipBuf);
    return new Response('?', { status: 404 });
  };
}

test('update.apply: indirir, dogrular, yazar, remote-control baglantisini koruyarak Supervisor devreder', async () => {
  const child = fakeChild();
  const { cfg, state, rc } = rcWith(child);
  await rc.ensure();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-updzip-'));
  const zipBuf = makeZip(work);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-updroot-'));
  fs.cpSync(path.join(PROJECT, 'src'), path.join(root, 'src'), { recursive: true });

  const sup = { d: { cfg, log: quiet, state, rc }, login: null };
  const r = await update.apply(sup, { fetchFn: fetchFor(zipBuf), root });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /aaaaaaa/);
  assert.ok(sup.successor, 'yeni Supervisor uretilmeli');
  assert.equal(sup.stopping, true);
  assert.equal(sup.successor.resumed, true);
  assert.equal(sup.successor.d.rc.running, true, 'remote-control yeni nesneye gecmeli');
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(child.exitCode, null);
  assert.equal(fs.readFileSync(path.join(root, '.version'), 'utf8'), SHA);
  assert.ok(fs.readFileSync(path.join(root, 'src', 'update.js'), 'utf8').includes('guncelleme testi isareti'));
  assert.ok(!fs.existsSync(path.join(cfg.paths.home, 'update-tmp')));

  // Ayni surum tekrar istenirse indirme yapilmaz.
  const counter = { n: 0 };
  const sup2 = { d: { cfg, log: quiet, state, rc: sup.successor.d.rc }, login: null };
  const r2 = await update.apply(sup2, { fetchFn: fetchFor(zipBuf, { counter }), root });
  assert.equal(r2.ok, true);
  assert.match(r2.message, /Zaten guncel/);
  assert.equal(counter.n, 1);
  assert.equal(sup2.successor, undefined);
});

test('update.apply: bozuk arsivde eski surum ve calisan remote-control korunur', async () => {
  const child = fakeChild();
  const { cfg, state, rc } = rcWith(child);
  await rc.ensure();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-updroot-'));
  fs.cpSync(path.join(PROJECT, 'src'), path.join(root, 'src'), { recursive: true });
  const before = fs.readFileSync(path.join(root, 'src', 'rc.js'), 'utf8');

  const sup = { d: { cfg, log: quiet, state, rc }, login: null };
  const r = await update.apply(sup, { fetchFn: fetchFor(Buffer.alloc(5000, 1)), root });
  assert.equal(r.ok, false);
  assert.match(r.message, /eski surum korundu/);
  assert.equal(sup.successor, undefined);
  assert.equal(rc.running, true);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'rc.js'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(root, '.version')));
});

test('update.apply: giris suruyorsa ya da git deposuysa guncellemez', async () => {
  const { cfg, state, rc } = rcWith(fakeChild());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cagent-updroot-'));
  const noFetch = async () => { throw new Error('ag kullanilmamali'); };
  const r1 = await update.apply({ d: { cfg, log: quiet, state, rc }, login: { id: 'x' } }, { fetchFn: noFetch, root });
  assert.equal(r1.ok, false);
  fs.mkdirSync(path.join(root, '.git'));
  const r2 = await update.apply({ d: { cfg, log: quiet, state, rc }, login: null }, { fetchFn: noFetch, root });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /git deposu/);
});

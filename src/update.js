'use strict';
// /update: yeni kodu GitHub'dan indirir, dogrular, diske yazar ve calisan ajani SURECI KAPATMADAN yeni koda gecirir.
// Remote Control sureci oldurulmez; yeni RemoteControl nesnesine devredilir (baglanti kopmaz).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPO = 'onurclaude/claude-agent';
const COPY = ['src', 'scripts', 'package.json', 'config.example.json', 'README.md', 'LICENSE', 'Kur.cmd', 'Kaldir.cmd', '.gitattributes'];
const KEEP_LOADED = new Set(['lock.js', 'logger.js', 'state.js', 'cli.js']); // durumu olan ya da calisan moduller yeniden yuklenmez
const MAX_ZIP = 20 * 1024 * 1024;

const fail = (message) => ({ ok: false, message });

function currentVersion(root = ROOT) {
  try { return fs.readFileSync(path.join(root, '.version'), 'utf8').trim(); } catch { return null; }
}

async function latestSha(fetchFn, repo = REPO) {
  const res = await fetchFn(`https://api.github.com/repos/${repo}/commits/main`, {
    headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'claude-persistent-agent' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`surum sorgusu -> ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('surum bilgisi gecersiz');
  return sha;
}

async function download(fetchFn, zipFile, repo = REPO) {
  const res = await fetchFn(`https://codeload.github.com/${repo}/zip/refs/heads/main`, {
    headers: { 'User-Agent': 'claude-persistent-agent' }, signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`indirme -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP || buf.length < 1000) throw new Error(`arsiv boyutu beklenmedik (${buf.length})`);
  fs.writeFileSync(zipFile, buf);
}

function extract(zipFile, dir) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(fs.existsSync(tar) ? tar : 'tar', ['-xf', zipFile, '-C', dir], { windowsHide: true, timeout: 120000 });
  const top = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!top) throw new Error('arsiv bos');
  return path.join(dir, top.name);
}

// Yeni kodu diske yazmadan once: sozdizimi + tum moduller yuklenebiliyor mu.
function validate(newRoot) {
  const srcDir = path.join(newRoot, 'src');
  if (!fs.existsSync(path.join(srcDir, 'cli.js')) || !fs.existsSync(path.join(srcDir, 'app.js'))) throw new Error('arsiv beklenen projeyi icermiyor');
  for (const f of fs.readdirSync(srcDir).filter((n) => n.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', path.join(srcDir, f)], { windowsHide: true, timeout: 30000 });
  }
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(srcDir, 'app.js'))})`], { windowsHide: true, timeout: 30000 });
}

function copyIn(fromRoot, toRoot) {
  for (const name of COPY) {
    const from = path.join(fromRoot, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(toRoot, name), { recursive: true, force: true });
  }
}

function reloadModules(srcDir = __dirname) {
  for (const k of Object.keys(require.cache)) {
    if (path.dirname(k) === srcDir && !KEEP_LOADED.has(path.basename(k))) delete require.cache[k];
  }
}

async function apply(sup, { fetchFn = fetch, root = ROOT, repo = REPO } = {}) {
  const { cfg, log, state } = sup.d;
  if (fs.existsSync(path.join(root, '.git'))) return fail('Bu kurulum bir git deposu; /update yalnizca indirilmis kurulumlarda calisir.');
  if (sup.login) return fail('Giris islemi suruyor; once bitirin ya da `/cancel-login` yazin.');

  let sha;
  try { sha = await latestSha(fetchFn, repo); } catch (e) { return fail(`Surum sorgulanamadi: ${e.message}`); }
  if (currentVersion(root) === sha) return { ok: true, message: `Zaten guncel (${sha.slice(0, 7)}).` };

  const tmp = path.join(cfg.paths.home, 'update-tmp');
  const backup = path.join(cfg.paths.home, 'update-backup');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, 'src.zip');
    await download(fetchFn, zip, repo);
    const dir = path.join(tmp, 'x');
    fs.mkdirSync(dir);
    const newRoot = extract(zip, dir);
    validate(newRoot);

    fs.rmSync(backup, { recursive: true, force: true });
    fs.mkdirSync(backup, { recursive: true });
    for (const name of COPY) if (fs.existsSync(path.join(root, name))) fs.cpSync(path.join(root, name), path.join(backup, name), { recursive: true });
    copyIn(newRoot, root);

    let handoff = null;
    try {
      reloadModules();
      const next = require('./app').build({ cfg, log, state });
      handoff = sup.d.rc.detach();
      next.d.rc.adopt(handoff);
      next.resumed = true;
      sup.successor = next;
      sup.stopping = true; // eski dongu temiz sekilde biter; yerine yeni Supervisor gecer
    } catch (e) {
      if (handoff && !sup.successor) { try { sup.d.rc.adopt(handoff); } catch { /* yok */ } }
      copyIn(backup, root);
      reloadModules();
      throw e;
    }
    fs.writeFileSync(path.join(root, '.version'), sha);
    log.info(`kod guncellendi: ${sha.slice(0, 7)} (remote-control baglantisi korundu)`);
    return { ok: true, message: `Guncellendi: ${sha.slice(0, 7)}. Remote Control baglantisi korundu. (\`cli.js\`/betik degisiklikleri bir sonraki yeniden baslatmada devreye girer.)` };
  } catch (e) {
    log.warn('guncelleme basarisiz', e);
    return fail(`Guncelleme basarisiz, eski surum korundu: ${e.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { apply, currentVersion, latestSha, validate, copyIn, reloadModules };

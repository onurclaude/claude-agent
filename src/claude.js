'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

class IsolationError extends Error {}

// Aboneligin disina cikabilecek veya hesabi degistirebilecek ortam degiskenleri.
const BLOCKED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_API_KEY_HELPER',
];

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

function overlaps(a, b) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

function assertSafeConfigDir(dir, { userHome = os.homedir(), foreignDirs = [] } = {}) {
  if (!dir || !path.isAbsolute(dir)) throw new IsolationError('CLAUDE_CONFIG_DIR mutlak yol olmali');
  const d = norm(dir);
  if (d === norm(userHome)) throw new IsolationError('CLAUDE_CONFIG_DIR kullanici ana dizini olamaz');
  for (const f of [path.join(userHome, '.claude'), ...foreignDirs]) {
    if (f && overlaps(d, norm(f))) throw new IsolationError(`CLAUDE_CONFIG_DIR mevcut bir Claude dizini ile cakisiyor: ${f}`);
  }
}

function findClaude(override) {
  if (override) return override;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const exe = path.join(d, 'claude.exe');
    if (fs.existsSync(exe)) return exe;
    if (fs.existsSync(path.join(d, 'claude.cmd'))) {
      const npmExe = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(npmExe)) return npmExe;
    }
  }
  throw new Error('claude.exe bulunamadi (npm i -g @anthropic-ai/claude-code veya config.claudePath)');
}

function defaultRunner(exe, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(exe, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: !!(err && err.killed) });
    });
  });
}

class ClaudeCli {
  constructor(cfg, { runner = defaultRunner, spawnFn = spawn, foreignDirs } = {}) {
    this.cfg = cfg;
    this.runner = runner;
    this.spawnFn = spawnFn;
    this.dir = cfg.paths.claudeConfigDir;
    // Ajan baslatilirken kabukta tanimli baska bir CLAUDE_CONFIG_DIR de "yabanci" sayilir.
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    this.foreignDirs = foreignDirs || (inherited && norm(inherited) !== norm(this.dir) ? [inherited] : []);
  }

  exe() {
    return (this._exe ||= findClaude(this.cfg.claudePath));
  }

  env() {
    assertSafeConfigDir(this.dir, { foreignDirs: this.foreignDirs });
    const env = { ...process.env };
    for (const k of BLOCKED_ENV) delete env[k];
    env.CLAUDE_CONFIG_DIR = this.dir;
    return env;
  }

  async run(args, { timeoutMs = 30000 } = {}) {
    return this.runner(this.exe(), args, { env: this.env(), timeoutMs });
  }

  spawn(args, opts = {}) {
    return this.spawnFn(this.exe(), args, { env: this.env(), windowsHide: true, ...opts });
  }

  // loggedIn=false yalnizca kimlik durumu okunmus VE izolasyon kanitlanmis ise dondurulur.
  async authStatus() {
    const r = await this.run(['auth', 'status', '--json'], { timeoutMs: 30000 });
    let j;
    try { j = JSON.parse(r.stdout); } catch { throw new Error(`auth status ciktisi okunamadi (kod ${r.code}${r.timedOut ? ', zaman asimi' : ''})`); }
    if (!j.configDirectory || norm(j.configDirectory) !== norm(this.dir)) {
      throw new IsolationError(`izolasyon dogrulanamadi: beklenen ${this.dir}, bildirilen ${j.configDirectory}`);
    }
    if (j.loggedIn && j.authMethod !== 'claude.ai') {
      throw new IsolationError(`abonelik disi kimlik dogrulama (${j.authMethod}); yalnizca claude.ai aboneligi kullanilir`);
    }
    return { loggedIn: !!j.loggedIn, authMethod: j.authMethod, subscriptionType: j.subscriptionType || null, email: j.email || null };
  }

  // Calisma dizinini YALNIZCA izole yapilandirmada guvenilir isaretler (bos, ajana ait dizin).
  ensureWorkspaceTrusted(workspace) {
    const file = path.join(this.dir, '.claude.json');
    if (!fs.existsSync(file)) return false;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
    j.projects ||= {};
    for (const key of new Set([workspace, workspace.replace(/\\/g, '/')])) {
      j.projects[key] = { ...(j.projects[key] || {}), hasTrustDialogAccepted: true };
    }
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    return true;
  }
}

module.exports = { ClaudeCli, IsolationError, assertSafeConfigDir, findClaude, BLOCKED_ENV, norm };

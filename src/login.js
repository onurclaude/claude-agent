'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { killTree } = require('./procs');

const URL_RE = /https:\/\/[^\s"'<>]+/;

function extractUrl(text) {
  const m = URL_RE.exec(text);
  return m ? m[0] : null;
}

function extractState(url) {
  try { return new URL(url).searchParams.get('state'); } catch { return null; }
}

// Claude Code'un resmi `claude auth login --claudeai` akisini calistirir (stdin borulu, TTY gerekmez;
// gercek CLI ile dogrulandi). Bir giris sureci YALNIZCA BIR kod denemesi yapar: yanlis/suresi dolmus kodda
// CLI "Login failed" ile cikar ve yeni bir surec (yeni URL) gerekir.
//
// Her surecin kimligi (id) ve URL'deki OAuth `state` degeri vardir; kod yalnizca ayni sureca iletilir.
// Kod yalnizca bellekten stdin'e gecer; loglanmaz, state.json'a yazilmaz.
class LoginFlow {
  constructor({ cfg, claude, log, onUrl }) {
    Object.assign(this, { cfg, claude, log, onUrl });
    this.id = crypto.randomBytes(3).toString('hex');
    this.url = null;
    this.state = null;
    this.urlCommentId = null;
    this.codeSent = false;
    this.child = null;
    this.cancelled = false;
  }

  async cancel() {
    this.cancelled = true;
    if (this.child) await killTree(this.child.pid);
  }

  // Kodu bekleyen CLI'nin stdin'ine yazar. Surec yoksa/ kod daha once gonderildiyse false.
  submitCode(code) {
    const stdin = this.child?.stdin;
    if (!stdin?.writable || this.codeSent) return false;
    this.codeSent = true;
    stdin.write(`${code}\n`);
    this.log.info(`giris #${this.id}: kod CLI'ya iletildi (icerik loglanmaz)`);
    return true;
  }

  run() {
    const { loginCodeFile } = this.cfg.paths;
    try { fs.unlinkSync(loginCodeFile); } catch { /* yok */ }
    const args = ['auth', 'login', '--claudeai'];
    if (this.cfg.email) args.push('--email', this.cfg.email);

    return new Promise((resolve) => {
      let child;
      try {
        child = this.claude.spawn(args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ ok: false, reason: `baslatilamadi: ${e.message}`, rejected: false });
      }
      this.child = child;
      this.log.info(`giris #${this.id} baslatildi (pid ${child.pid})`);
      let buf = '';
      const onData = (d) => {
        buf = (buf + String(d)).slice(-8000);
        if (!this.url) {
          const url = extractUrl(buf);
          if (url) { this.url = url; this.state = extractState(url); this.onUrl(url, this); }
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      // Yerel yedek yol: scripts\submit-code.ps1 (AnyDesk vb.)
      const poll = setInterval(() => {
        if (!fs.existsSync(loginCodeFile)) return;
        try {
          const code = fs.readFileSync(loginCodeFile, 'utf8').trim();
          fs.unlinkSync(loginCodeFile);
          if (code) this.submitCode(code);
        } catch { /* sonraki turda */ }
      }, 2000);
      const timer = setTimeout(() => { this.log.warn(`giris #${this.id} zaman asimina ugradi`); killTree(child.pid); }, this.cfg.loginTimeoutSec * 1000);

      const done = (result) => {
        clearInterval(poll);
        clearTimeout(timer);
        try { fs.unlinkSync(loginCodeFile); } catch { /* yok */ }
        this.child = null;
        resolve(result);
      };
      child.once('error', (e) => done({ ok: false, reason: e.message, rejected: false }));
      child.once('exit', (code) => {
        const ok = code === 0 && !this.cancelled;
        done({
          ok,
          rejected: !ok && !this.cancelled && this.codeSent,
          reason: this.cancelled ? 'iptal edildi' : ok ? null : this.codeSent ? 'kod kabul edilmedi' : `giris sureci kod ${code} ile cikti (zaman asimi/iptal)`,
        });
      });
    });
  }
}

module.exports = { LoginFlow, extractUrl, extractState };

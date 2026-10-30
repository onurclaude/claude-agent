'use strict';
const fs = require('fs');
const { killTree, killIfOurs } = require('./procs');
const { Logger } = require('./logger');

const URL_RE = /https:\/\/claude\.ai\/code\/session_[\w-]+/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

// `claude remote-control` sunucusunu (telefondan kontrol) izole hesapla calistirir ve ayakta tutar.
class RemoteControl {
  constructor({ cfg, claude, state, log, now = Date.now }) {
    this.cfg = cfg;
    this.claude = claude;
    this.state = state;
    this.log = log;
    this.now = now;
    this.out = new Logger(cfg.paths.logDir, 'remote-control');
    this.child = null;
    this.backoffSec = 5;
    this.nextStartAt = 0;
  }

  get running() { return !!this.child; }
  get marker() { return this.cfg.remoteControl.name; }

  // Onceki ajan calismasindan kalan, YALNIZCA bu ajanin isimli sureci varsa temizler.
  async cleanupOrphan() {
    const { pid } = this.state.data.rc;
    if (pid && await killIfOurs(pid, this.marker)) this.log.warn(`onceki calismadan kalan remote-control sureci sonlandirildi (pid ${pid})`);
    this.state.update((s) => { s.rc.pid = null; });
  }

  async ensure() {
    if (!this.cfg.remoteControl.enabled || this.child || this.now() < this.nextStartAt) return;
    await this.start();
  }

  async start() {
    const rc = this.cfg.remoteControl;
    const s = this.state.data.rc;
    const useContinue = s.hadSession && !s.continueFailed;
    const args = ['remote-control', '--name', rc.name, '--spawn', rc.spawn, '--capacity', String(rc.capacity),
      '--permission-mode', rc.permissionMode];
    if (useContinue) args.push('--continue');
    fs.mkdirSync(this.cfg.paths.workspace, { recursive: true });
    this.claude.ensureWorkspaceTrusted(this.cfg.paths.workspace);

    const startedAt = this.now();
    let child;
    try {
      child = this.claude.spawn(args, { cwd: this.cfg.paths.workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.log.error('remote-control baslatilamadi', e);
      this._scheduleRestart(0);
      return;
    }
    this.child = child;
    this.log.info(`remote-control basladi (pid ${child.pid}${useContinue ? ', --continue' : ''})`);
    this.state.update((st) => { st.rc.pid = child.pid; st.rc.marker = this.marker; st.rc.url = null; });

    let tail = '';
    const seen = new Set(); // CLI durum ekranini saniyede bir yeniden cizer; tekrar eden satirlar loglanmaz
    const onData = (buf) => {
      const text = String(buf);
      for (const raw of text.replace(ANSI_RE, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || seen.has(line)) continue;
        if (seen.size > 200) seen.clear();
        seen.add(line);
        this.out.info(line);
      }
      tail = (tail + text.replace(ANSI_RE, '')).slice(-600);
      const m = URL_RE.exec(text);
      if (m) this.state.update((st) => { st.rc.url = m[0]; });
      // Hesapta ilk kullanimda sorulan tek seferlik onay (gercek CLI ile dogrulandi).
      if (/Enable Remote Control\? \(y\/n\)/.test(text) && child.stdin?.writable) {
        child.stdin.write('y\n');
        this.log.info('Remote Control ilk kullanim onayi verildi');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const mark = setTimeout(() => {
      if (this.child === child) this.state.update((st) => { st.rc.hadSession = true; st.rc.continueFailed = false; });
    }, 20000);
    mark.unref?.();

    const finish = (code) => {
      clearTimeout(mark);
      if (this.child !== child) return;
      this.child = null;
      const runtimeSec = Math.round((this.now() - startedAt) / 1000);
      this.log.warn(`remote-control cikti (kod ${code}, ${runtimeSec}s)`);
      this.state.update((st) => {
        st.rc.pid = null;
        st.rc.restarts += 1;
        st.rc.lastExit = { code, at: new Date().toISOString(), runtimeSec, tail: tail.slice(-300) };
        if (useContinue && runtimeSec < 15 && code !== 0) st.rc.continueFailed = true;
      });
      this._scheduleRestart(runtimeSec);
    };
    child.once('exit', finish);
    child.once('error', (e) => { this.log.error('remote-control surec hatasi', e); finish(-1); });
  }

  _scheduleRestart(runtimeSec) {
    this.backoffSec = runtimeSec > 300 ? 5 : Math.min(this.backoffSec * 2, 300);
    this.nextStartAt = this.now() + this.backoffSec * 1000;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null; // beklenen cikis: yeniden baslatma zamanlanmasin
    await killTree(child.pid);
    this.state.update((st) => { st.rc.pid = null; });
    this.backoffSec = 5;
    this.nextStartAt = 0;
    this.log.info('remote-control durduruldu');
  }
}

module.exports = { RemoteControl };

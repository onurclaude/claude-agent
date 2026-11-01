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
    const { pid, marker } = this.state.data.rc;
    if (pid && await killIfOurs(pid, marker || this.marker)) this.log.warn(`onceki calismadan kalan remote-control sureci sonlandirildi (pid ${pid})`);
    this.state.update((s) => { s.rc.pid = null; });
  }

  async ensure() {
    if (!this.cfg.remoteControl.enabled || this.child || this.now() < this.nextStartAt) return;
    await this.start();
  }

  async start() {
    const rc = this.cfg.remoteControl;
    const s = this.state.data.rc;
    // Tek oturum: yeniden baslatmada kayitli oturuma --session-id ile baglanilir (ayni sohbet, ~3 sn kesinti).
    // --session-id, --spawn/--capacity ile birlikte kullanilamaz. Oturum bitmis/gecersizse yeni oturum acilir.
    const sid = s.sessionId;
    const useContinue = !!sid && !s.sessionFailed;
    const args = useContinue
      ? ['remote-control', '--session-id', sid, '--permission-mode', rc.permissionMode]
      : ['remote-control', '--name', rc.name, '--spawn', rc.spawn, '--capacity', '1', '--permission-mode', rc.permissionMode];
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
    this.log.info(`remote-control basladi (pid ${child.pid}${useContinue ? `, oturum ${sid}` : ', yeni oturum'})`);
    this.state.update((st) => { st.rc.pid = child.pid; st.rc.marker = useContinue ? sid : this.marker; st.rc.url = null; });
    this._attach(child, useContinue, startedAt);
  }

  // Calisan surece dinleyicileri baglar. Guncelleme sirasinda surec yeni koda devredilirken de kullanilir.
  _attach(child, useContinue, startedAt) {
    this.child = child;
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
      if (m) this.state.update((st) => { st.rc.url = m[0]; st.rc.sessionId = m[0].split('/').pop(); });
      // Hesapta ilk kullanimda sorulan tek seferlik onay (gercek CLI ile dogrulandi).
      if (/Enable Remote Control\? \(y\/n\)/.test(text) && child.stdin?.writable) {
        child.stdin.write('y\n');
        this.log.info('Remote Control ilk kullanim onayi verildi');
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const mark = setTimeout(() => {
      if (this.child === child) this.state.update((st) => { st.rc.hadSession = true; st.rc.sessionFailed = false; });
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
        if (useContinue && (runtimeSec < 15 || code === 0)) st.rc.sessionFailed = true;
      });
      if (useContinue && (runtimeSec < 15 || code === 0)) {
        this.backoffSec = 5;
        this.nextStartAt = 0; // oturum gecersiz/bitti: beklemeden yeni oturum ac
      } else {
        this._scheduleRestart(runtimeSec);
      }
    };
    this._att = { child, useContinue, startedAt, mark };
    child.once('exit', finish);
    child.once('error', (e) => { this.log.error('remote-control surec hatasi', e); finish(-1); });
    if (child.exitCode !== null && child.exitCode !== undefined) finish(child.exitCode); // devir sirasinda cikmis olabilir
  }

  // Sureci OLDURMEDEN bu nesneden ayirir (kod guncellemesi: yeni RemoteControl nesnesi adopt() ile alir).
  detach() {
    const att = this._att;
    if (!this.child || !att) return null;
    const { child } = att;
    clearTimeout(att.mark);
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    child.stdout?.removeAllListeners('data');
    child.stderr?.removeAllListeners('data');
    this.child = null;
    this._att = null;
    return { child, useContinue: att.useContinue, startedAt: att.startedAt };
  }

  adopt(handoff) {
    if (!handoff) return;
    this.log.info(`remote-control sureci yeni koda devredildi (pid ${handoff.child.pid})`);
    this._attach(handoff.child, handoff.useContinue, handoff.startedAt);
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

'use strict';
const fs = require('fs');
const { parseCommand, parseCode } = require('./commands');
const { IsolationError } = require('./claude');
const { RateLimitError } = require('./github');

const EXIT_ISOLATION = 3;
const LOGIN_BACKOFF_MIN = 30000;
const LOGIN_BACKOFF_MAX = 300000;

// Durumlar: STARTING, RUNNING, OFFLINE, LOGGED_OUT, LOGIN_PENDING, HALTED_ISOLATION, STOPPED
class Supervisor {
  constructor(d) {
    this.d = d; // { cfg, log, state, claude, github, net, rc, loginFactory, sleep }
    this.failCount = 0;
    this.login = null;
    this.loginPaused = false; // /cancel-login sonrasi otomatik giris durur; /login surdurur
    this.nextLoginAt = 0;
    this.loginBackoff = LOGIN_BACKOFF_MIN;
    this.ghBackoffUntil = 0;
    this.stopping = false;
    this.exitCode = 0;
  }

  get mode() { return this.d.state.data.mode; }
  get loggedOutMode() { return this.mode === 'LOGGED_OUT' || this.mode === 'LOGIN_PENDING'; }

  setMode(mode) {
    if (this.mode === mode) return;
    this.d.log.info(`durum: ${this.mode} -> ${mode}`);
    this.d.state.update((s) => { s.mode = mode; s.modeSince = new Date().toISOString(); });
  }

  async say(text) {
    if (!this.d.github) return null;
    try { return await this.d.github.comment(text); } catch (e) { this.d.log.warn('GitHub yorumu gonderilemedi', e); return null; }
  }

  // Silinemezse uyari uretir: kod/baglanti yorumu GitHub'da kalmamali.
  async deleteComment(id, what, htmlUrl) {
    if (!id || !this.d.github) return true;
    try {
      await this.d.github.deleteComment(id);
      return true;
    } catch (e) {
      this.d.log.warn(`${what} yorumu SILINEMEDI (id ${id})`, e);
      await this.say(`⚠️ **${what} yorumu silinemedi** (${e.message}). Lutfen elle silin${htmlUrl ? `: ${htmlUrl}` : ''}. Token'in Issues yazma izni ve (baska hesabin yorumu icin) depoda yazma yetkisi olmali.`);
      return false;
    }
  }

  async halt(err) {
    this.d.log.error(`ISOLATION: ${err.message}. Ajan guvenli sekilde durduruluyor.`);
    this.setMode('HALTED_ISOLATION');
    await this.d.rc.stop();
    if (this.login) await this.abandon(this.login);
    await this.say(`🤖 **Ajan durduruldu: hesap izolasyonu dogrulanamadi.**\n\n${err.message}\n\nHicbir Claude islemi calistirilmiyor. Duzeltip \`scripts\\start.ps1\` ile yeniden baslatin.`);
    this.stopping = true;
    this.exitCode = EXIT_ISOLATION;
  }

  async tick() {
    let st;
    try {
      st = await this.d.claude.authStatus();
    } catch (e) {
      if (e instanceof IsolationError) return this.halt(e);
      this.d.log.warn('auth status kontrolu basarisiz (cikis sayilmaz)', e);
      return;
    }

    if (st.loggedIn) {
      this.failCount = 0;
      await this.onLoggedIn();
    } else if (!(await this.d.net.online())) {
      // Internet yokken "logout" karari verilmez; oturum dosyalari duruyor olabilir.
      if (this.mode !== 'OFFLINE') this.d.log.warn('internet yok; logout karari ertelendi');
      if (!this.loggedOutMode) this.setMode('OFFLINE');
      return;
    } else {
      this.failCount += 1;
      if (this.failCount >= this.d.cfg.logoutConfirmations) await this.onLoggedOut();
    }

    if (this.loggedOutMode || (this.d.cfg.pollGithubWhileLoggedIn && this.mode === 'RUNNING')) {
      await this.pollGithub();
      if (this.loggedOutMode && fs.existsSync(this.d.cfg.paths.loginRequestFile)) {
        try { fs.unlinkSync(this.d.cfg.paths.loginRequestFile); } catch { /* yok */ }
        this.loginPaused = false;
        await this.startLogin('yerel istek');
      }
    }
    // Logout suruyor, bekleyen giris yok (ilk kez, kod reddi, zaman asimi): yeni giris sureci baslat.
    if (this.loggedOutMode && !this.login && !this.loginPaused && Date.now() >= this.nextLoginAt) {
      await this.startLogin('otomatik');
    }
  }

  async onLoggedIn() {
    const was = this.mode;
    if (this.login) await this.abandon(this.login); // giris baska yoldan tamamlandi: bekleyen surec/baglanti artik gecersiz
    if (was === 'LOGGED_OUT' || was === 'LOGIN_PENDING') {
      const it = this.d.state.data.interrupted;
      this.loginBackoff = LOGIN_BACKOFF_MIN;
      this.nextLoginAt = 0;
      this.loginPaused = false;
      this.d.state.update((s) => { s.lastLoginAt = new Date().toISOString(); });
      this.setMode('RUNNING');
      await this.d.rc.stop();
      await this.d.rc.ensure();
      await this.say(`🤖 ✅ **Giris basarili, auth status dogrulandi.** Remote Control yeniden baslatildi; ajan kaldigi yerden devam ediyor.${it?.hadSession ? '\n\nYarim kalan oturum, mumkunse `--continue` ile yeniden baglanir.' : ''}`);
    } else {
      if (was !== 'RUNNING') this.setMode('RUNNING');
      await this.d.rc.ensure();
    }
    this.d.state.update((s) => { s.lastAuthOkAt = new Date().toISOString(); });
  }

  async onLoggedOut() {
    if (this.loggedOutMode) return;
    this.d.log.warn('LOGOUT tespit edildi');
    const url = this.d.state.data.rc.url;
    await this.d.rc.stop();
    this.d.state.update((s) => {
      s.lastLogoutAt = new Date().toISOString();
      s.interrupted = { at: s.lastLogoutAt, sessionUrl: url || null, hadSession: s.rc.hadSession };
    });
    this.setMode('LOGGED_OUT');
    this.nextLoginAt = 0;
    await this.baselineGithub();
    await this.say('🤖 **Claude oturumu kapali (logout tespit edildi).** Is akisi kaydedildi; giris baglantisi hazirlaniyor...');
  }

  // Logout aninda mevcut yorumlar "okunmus" sayilir; eski komutlar/kodlar yeniden calistirilmaz.
  async baselineGithub() {
    if (!this.d.github) return;
    try {
      const all = await this.d.github.listComments(null);
      const max = all.reduce((m, c) => Math.max(m, c.id), this.d.state.data.gh.cursorId);
      this.d.state.update((s) => { s.gh.cursorId = max; s.gh.since = new Date().toISOString(); });
    } catch (e) { this.d.log.warn('GitHub baslangic okumasi basarisiz', e); }
  }

  async pollGithub() {
    const { github, cfg, state, log } = this.d;
    if (!github || Date.now() < this.ghBackoffUntil) return;
    let comments;
    try {
      comments = await github.listComments(state.data.gh.since);
    } catch (e) {
      this.ghBackoffUntil = Date.now() + (e instanceof RateLimitError ? e.retryAfterSec * 1000 : 120000);
      log.warn('GitHub kontrol alani okunamadi', e);
      return;
    }
    const fresh = comments.filter((c) => c.id > state.data.gh.cursorId).sort((a, b) => a.id - b.id);
    for (const c of fresh) {
      state.update((s) => { s.gh.cursorId = c.id; s.gh.since = c.created_at; });
      const user = String(c.user?.login || '').toLowerCase();
      const code = parseCode(c.body);
      if (code !== undefined) {
        if (!cfg.github.allowedUsers.includes(user)) { log.warn(`yetkisiz /code yoksayildi (kullanici ${user})`); continue; }
        await this.handleCode(c, code);
        continue;
      }
      const cmd = parseCommand(c.body);
      if (!cmd) continue;
      if (!cfg.github.allowedUsers.includes(user)) { log.warn(`yetkisiz komut yoksayildi: /${cmd} (kullanici ${user})`); continue; }
      log.info(`GitHub komutu: /${cmd} (${user})`);
      await this.handle(cmd);
    }
  }

  // "/code KOD": yalnizca bekleyen, ayni giris surecine ait kod kabul edilir. Yorum her durumda silinir.
  async handleCode(c, code) {
    const flow = this.login;
    let reply;
    let accepted = false;
    if (!flow || !flow.urlCommentId || c.id < flow.urlCommentId) {
      reply = '🤖 Bekleyen bir giris yok ya da bu kod eski bir giris baglantisina ait; yoksayildi. Guncel baglanti icin son giris yorumuna bakin veya `/login` yazin.';
    } else if (code === null) {
      reply = '🤖 Kod bicimi gecersiz. Kullanim: `/code KOD` (yorum silindi).';
    } else if (code.includes('#') && flow.state && code.slice(code.indexOf('#') + 1) !== flow.state) {
      reply = `🤖 Bu kod giris #${flow.id} islemine ait degil (state uyusmuyor); iletilmedi. Guncel baglantiyi kullanin.`;
    } else {
      accepted = flow.submitCode(code);
      reply = accepted ? `🤖 Kod giris #${flow.id} icin Claude CLI'ya iletildi; dogrulaniyor...` : '🤖 Kod iletilemedi (surec kapanmis ya da bu surece zaten kod gonderilmis).';
    }
    await this.deleteComment(c.id, 'Kod', c.html_url);
    await this.say(reply);
  }

  async handle(cmd) {
    if (cmd === 'login') {
      if (!this.loggedOutMode) return this.say('🤖 Oturum zaten acik; giris gerekmiyor.');
      this.loginPaused = false;
      return this.startLogin('GitHub /login');
    }
    if (cmd === 'cancel-login') {
      this.loginPaused = true;
      if (this.login) await this.abandon(this.login);
      if (this.mode === 'LOGIN_PENDING') this.setMode('LOGGED_OUT');
      return this.say('🤖 Giris iptal edildi; otomatik giris durdu. Tekrar baslatmak icin `/login` yazin.');
    }
    if (cmd === 'restart') {
      if (this.mode !== 'RUNNING') return this.say(`🤖 Su an ${this.mode}; yeniden baslatma yalnizca RUNNING durumunda.`);
      await this.d.rc.stop();
      await this.d.rc.ensure();
      return this.say('🤖 Remote Control yeniden baslatildi.');
    }
    if (cmd === 'status') return this.say(this.statusText());
    return this.say('🤖 Komutlar: `/login` (yeni giris baglantisi) `/code KOD` `/cancel-login` `/status` `/restart` `/help`');
  }

  statusText() {
    const s = this.d.state.data;
    return [
      `🤖 **Durum:** ${s.mode} (${s.modeSince})`,
      `Son basarili kimlik kontrolu: ${s.lastAuthOkAt || '-'}`,
      `Son logout: ${s.lastLogoutAt || '-'} · Son giris: ${s.lastLoginAt || '-'}`,
      `Giris: ${this.login ? `#${this.login.id} kod bekliyor` : this.loginPaused ? 'durduruldu (/login ile surdurun)' : '-'}`,
      `Remote Control: ${this.d.rc.running ? 'calisiyor' : 'kapali'} · yeniden baslatma: ${s.rc.restarts}`,
    ].join('\n');
  }

  // Bekleyen giris surecini iptal eder ve baglanti yorumunu siler.
  async abandon(flow) {
    if (this.login === flow) this.login = null;
    await flow.cancel();
    await this.deleteComment(flow.urlCommentId, 'Giris baglantisi');
  }

  async startLogin(source) {
    const { github, log, cfg } = this.d;
    if (this.login) await this.abandon(this.login);
    if (github) {
      try {
        await github.assertPrivate();
      } catch (e) {
        log.error('GitHub deposu dogrulanamadi/ozel degil; giris baslatilmadi', e);
        this.nextLoginAt = Date.now() + LOGIN_BACKOFF_MAX;
        return;
      }
    } else if (source === 'otomatik') {
      return; // baglantiyi iletecek kanal yok
    }

    const flow = this.d.loginFactory({
      onUrl: (url, f) => this.postLoginUrl(f || flow, url),
    });
    this.login = flow;
    this.setMode('LOGIN_PENDING');
    log.info(`giris #${flow.id} baslatiliyor (${source})`);

    flow.run().then((res) => this.finishLogin(flow, res)).catch((e) => log.error('giris akisi hatasi', e));
  }

  async postLoginUrl(flow, url) {
    if (!this.d.github) return;
    const r = await this.say([
      `🤖 **Giris baglantisi (#${flow.id}):**`,
      url,
      '',
      '1. Baglantiyi telefonda acip Claude hesabinizla onaylayin.',
      '2. Ekranda gorunen kodu bu konuya su sekilde yazin: `/code KOD`',
      `Kod yalnizca bu baglanti icindir; kullanilinca yorum silinir. Sure: ${Math.round(this.d.cfg.loginTimeoutSec / 60)} dk (dolarsa yeni baglanti uretilir). Iptal: \`/cancel-login\``,
    ].join('\n'));
    if (r?.id) flow.urlCommentId = r.id;
    else { this.d.log.warn(`giris #${flow.id}: baglanti GitHub'a yazilamadi; surec iptal ediliyor`); await flow.cancel(); }
  }

  async finishLogin(flow, res) {
    if (this.login !== flow) return; // baska bir surec bunun yerini aldi / iptal edildi
    this.login = null;
    await this.deleteComment(flow.urlCommentId, 'Giris baglantisi');

    // Basari yalnizca auth status dogrularsa sayilir; CLI'nin cikis kodu tek basina yetmez.
    let verified = false;
    if (res.ok) {
      try { verified = (await this.d.claude.authStatus()).loggedIn; } catch (e) { this.d.log.warn('giris sonrasi dogrulama', e); }
    }
    if (verified) {
      this.failCount = 0;
      await this.onLoggedIn();
      return;
    }
    this.setMode('LOGGED_OUT');
    if (res.reason === 'iptal edildi' && this.loginPaused) return;
    if (res.rejected) {
      await this.say(`🤖 ❌ Kod kabul edilmedi (yanlis, suresi dolmus veya baska bir giris denemesine ait). Yeni giris baglantisi uretiliyor...`);
      this.nextLoginAt = 0;
      await this.startLogin('otomatik');
      return;
    }
    const wait = this.loginBackoff;
    this.loginBackoff = Math.min(this.loginBackoff * 2, LOGIN_BACKOFF_MAX);
    this.nextLoginAt = Date.now() + wait;
    await this.say(`🤖 Giris tamamlanamadi (${res.reason || 'dogrulanamadi'}). ~${Math.round(wait / 1000)} sn icinde yeni baglanti uretilecek.`);
  }

  async run() {
    const { cfg, log, rc, state } = this.d;
    state.update((s) => { s.supervisorPid = process.pid; });
    await rc.cleanupOrphan();
    log.info(`ajan basladi (pid ${process.pid}), izole dizin: ${cfg.paths.claudeConfigDir}`);
    while (!this.stopping) {
      const t0 = Date.now();
      try { await this.tick(); } catch (e) { log.error('tick hatasi', e); }
      if (this.stopping) break;
      await this.d.sleep(Math.max(1000, cfg.authCheckIntervalSec * 1000 - (Date.now() - t0)));
    }
    return this.exitCode;
  }

  async shutdown(reason) {
    this.d.log.info(`kapatiliyor: ${reason}`);
    this.stopping = true;
    if (this.login) await this.abandon(this.login);
    await this.d.rc.stop();
    if (this.mode !== 'HALTED_ISOLATION') this.setMode('STOPPED');
    this.d.state.update((s) => { s.supervisorPid = null; });
  }
}

module.exports = { Supervisor, EXIT_ISOLATION };

#!/usr/bin/env node
'use strict';
const fs = require('fs');
const readline = require('readline');
const config = require('./config');
const { Logger } = require('./logger');
const { StateStore } = require('./state');
const { ClaudeCli, IsolationError } = require('./claude');
const { GitHub, readToken } = require('./github');
const { RemoteControl } = require('./rc');
const { LoginFlow } = require('./login');
const { Supervisor } = require('./supervisor');
const lock = require('./lock');
const net = require('./net');
const procs = require('./procs');

function prepare(cfg) {
  for (const d of [cfg.paths.home, cfg.paths.claudeConfigDir, cfg.paths.logDir, cfg.paths.workspace]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function makeGithub(cfg, log) {
  const { repo, issue } = cfg.github;
  if (!repo || !issue) { log.warn('GitHub ayarli degil (github.repo / github.issue); uzaktan giris kontrolu KAPALI'); return null; }
  let token;
  try { token = readToken(cfg.paths.githubTokenFile); } catch (e) { log.error('GitHub tokeni okunamadi (scripts\\set-github-token.ps1 ile yeniden kaydedin); uzaktan giris kontrolu KAPALI'); return null; }
  if (!token) { log.warn('GitHub tokeni yok (scripts\\set-github-token.ps1); uzaktan giris kontrolu KAPALI'); return null; }
  return new GitHub({ repo, issue, token });
}

async function cmdRun(cfg) {
  prepare(cfg);
  const log = new Logger(cfg.paths.logDir, 'agent', { echo: process.stdout.isTTY });
  const release = await lock.acquire(cfg.paths.lockFile);
  if (!release) { log.warn('baska bir ajan ornegi zaten calisiyor'); return 4; }

  const state = new StateStore(cfg.paths.stateFile);
  const claude = new ClaudeCli(cfg);
  const github = makeGithub(cfg, log);
  const rc = new RemoteControl({ cfg, claude, state, log });
  const sup = new Supervisor({
    cfg, log, state, claude, github, net, rc,
    loginFactory: ({ onUrl }) => new LoginFlow({ cfg, claude, log, onUrl }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });

  let closing = false;
  const close = async (sig) => {
    if (closing) return;
    closing = true;
    await sup.shutdown(sig);
    release();
    process.exit(sup.exitCode);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => close(sig));
  process.on('uncaughtException', (e) => { log.error('beklenmeyen hata', e); close('uncaughtException'); });
  process.on('unhandledRejection', (e) => log.error('islenmeyen reddedilme', e));

  const code = await sup.run();
  await sup.shutdown('dongu bitti');
  release();
  return code;
}

async function cmdVerify(cfg) {
  prepare(cfg);
  const claude = new ClaudeCli(cfg);
  console.log(`Izole yapilandirma dizini : ${cfg.paths.claudeConfigDir}`);
  console.log(`Global dizin (dokunulmaz) : ${require('path').join(require('os').homedir(), '.claude')}`);
  try {
    const st = await claude.authStatus();
    console.log(`Izolasyon DOGRULANDI. Oturum: ${st.loggedIn ? `acik (${st.subscriptionType || 'abonelik'})` : 'kapali (beklenen: ilk kurulumda /login ile giris yapilir)'}`);
    return 0;
  } catch (e) {
    console.error(`${e instanceof IsolationError ? 'IZOLASYON HATASI' : 'HATA'}: ${e.message}`);
    return e instanceof IsolationError ? 3 : 1;
  }
}

async function cmdStatus(cfg) {
  const state = new StateStore(cfg.paths.stateFile);
  console.log(JSON.stringify({ ...state.data, rc: { ...state.data.rc, marker: undefined } }, null, 2));
  try { console.log('canli auth:', JSON.stringify(await new ClaudeCli(cfg).authStatus())); } catch (e) { console.log('canli auth hatasi:', e.message); }
  return 0;
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()); });
  });
}

async function cmdSubmitCode(cfg) {
  const code = await askHidden('Claude giris kodunu yapistirin (gorunmez): ');
  if (!code) { console.error('Kod bos.'); return 1; }
  fs.writeFileSync(cfg.paths.loginCodeFile, code, { mode: 0o600 });
  console.log('Kod yerel olarak iletildi; ajan birkac saniye icinde kullanacak.');
  return 0;
}

function cmdRequestLogin(cfg) {
  fs.writeFileSync(cfg.paths.loginRequestFile, new Date().toISOString());
  console.log('Giris istegi birakildi; ajan oturum kapaliysa sonraki kontrolde (<=60 sn) girisi baslatir.');
  return 0;
}

async function cmdInitGithub(cfg) {
  const token = readToken(cfg.paths.githubTokenFile);
  if (!token || !cfg.github.repo) { console.error('Once github.repo ayarlayin ve set-github-token.ps1 calistirin.'); return 1; }
  const gh = new GitHub({ repo: cfg.github.repo, issue: 0, token });
  const issue = await gh.createIssue(`Claude Agent Kontrol - ${require('os').hostname()}`, [
    'Bu konu, Claude Persistent Agent icin kontrol alanidir. Yalnizca yetkili kullanici yorum komutlari ajanı yonetir.',
    '', 'Komutlar: `/login` `/cancel-login` `/status` `/restart` `/help`',
    '', '**Buraya asla OAuth kodu, token veya parola yazmayin.** Depo ozel (private) olmalidir.',
  ].join('\n'));
  const file = require('path').join(cfg.paths.home, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  raw.github = { ...raw.github, issue: issue.number };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  console.log(`Konu olusturuldu: #${issue.number} (config.json guncellendi): ${issue.html_url}`);
  return 0;
}

// Yalnizca bu ajanin kayitli PID'lerini, komut satiri dogrulanarak durdurur. Once bekci (yoksa node'u yeniden baslatir).
async function cmdStop(cfg) {
  const targets = [[cfg.paths.watchdogPidFile, 'run.ps1', 'bekci'], [cfg.paths.lockFile, 'cli.js', 'ajan']];
  let stopped = 0;
  for (const [file, needle, label] of targets) {
    const pid = parseInt(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', 10);
    const cl = pid && procs.isAlive(pid) ? await procs.commandLine(pid) : null;
    if (!cl || !cl.includes(needle)) continue;
    await procs.killTree(pid);
    console.log(`${label} (pid ${pid}) durduruldu.`);
    stopped += 1;
  }
  if (!stopped) console.log('Calisan ajan bulunamadi.');
  else console.log('Not: baska Claude sureclerine dokunulmadi.');
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const homeArg = rest.indexOf('--home');
  const cfg = config.load(homeArg >= 0 ? require('path').resolve(rest[homeArg + 1]) : undefined);
  const table = {
    run: cmdRun, verify: cmdVerify, status: cmdStatus, stop: cmdStop,
    'submit-code': cmdSubmitCode, 'request-login': cmdRequestLogin, 'init-github': cmdInitGithub,
  };
  if (!table[cmd]) {
    console.log('Kullanim: node src/cli.js <run|verify|status|stop|submit-code|request-login|init-github> [--home DIZIN]');
    return 2;
  }
  return table[cmd](cfg);
}

main().then((c) => process.exit(c || 0), (e) => {
  console.error(e.message);
  try { new Logger(config.pathsFor(config.defaultHome()).logDir, 'agent').error('kritik hata', e); } catch { /* yok */ }
  process.exit(1);
});

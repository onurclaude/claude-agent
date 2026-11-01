'use strict';
// Servislerin kurulumu. Kod guncellemesinde (src/update.js) bu modul yeniden yuklenip yeni Supervisor uretilir.
const { ClaudeCli } = require('./claude');
const { GitHub, readToken } = require('./github');
const { RemoteControl } = require('./rc');
const { LoginFlow } = require('./login');
const { Supervisor } = require('./supervisor');
const net = require('./net');

function makeGithub(cfg, log) {
  const { repo, issue } = cfg.github;
  if (!repo || !issue) { log.warn('GitHub ayarli degil (github.repo / github.issue); uzaktan giris kontrolu KAPALI'); return null; }
  let token;
  try { token = readToken(cfg.paths.githubTokenFile); } catch (e) { log.error('GitHub tokeni okunamadi (scripts\\set-github-token.ps1 ile yeniden kaydedin); uzaktan giris kontrolu KAPALI'); return null; }
  if (!token) { log.warn('GitHub tokeni yok (scripts\\set-github-token.ps1); uzaktan giris kontrolu KAPALI'); return null; }
  return new GitHub({ repo, issue, token });
}

function build({ cfg, log, state }) {
  const claude = new ClaudeCli(cfg);
  const github = makeGithub(cfg, log);
  const rc = new RemoteControl({ cfg, claude, state, log });
  return new Supervisor({
    cfg, log, state, claude, github, net, rc,
    loginFactory: ({ onUrl }) => new LoginFlow({ cfg, claude, log, onUrl }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    update: (sup) => require('./update').apply(sup),
  });
}

module.exports = { build, makeGithub };

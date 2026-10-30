'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  github: { repo: null, issue: null, allowedUsers: [] },
  email: null,
  authCheckIntervalSec: 60,
  githubPollIntervalSec: 60,
  logoutConfirmations: 2,
  pollGithubWhileLoggedIn: false,
  loginTimeoutSec: 600,
  claudePath: null,
  remoteControl: {
    enabled: true,
    name: null,
    permissionMode: 'default',
    spawn: 'same-dir',
    capacity: 4,
  },
};

const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
const SAFE_ARG = /^[\w .()\-]+$/;

function defaultHome() {
  if (process.env.CLAUDE_AGENT_HOME) return path.resolve(process.env.CLAUDE_AGENT_HOME);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'ClaudeAgent');
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? merge(base[k], v)
      : v;
  }
  return out;
}

function pathsFor(home) {
  return {
    home,
    claudeConfigDir: path.join(home, 'claude-config'),
    logDir: path.join(home, 'logs'),
    workspace: path.join(home, 'workspace'),
    stateFile: path.join(home, 'state.json'),
    lockFile: path.join(home, 'agent.lock'),
    watchdogPidFile: path.join(home, 'watchdog.pid'),
    loginCodeFile: path.join(home, 'login-code.txt'),
    loginRequestFile: path.join(home, 'login-request.flag'),
    githubTokenFile: path.join(home, 'github-token.dpapi'),
  };
}

function validate(c) {
  const rc = c.remoteControl;
  if (!PERMISSION_MODES.includes(rc.permissionMode)) throw new Error(`gecersiz permissionMode: ${rc.permissionMode}`);
  if (!['same-dir', 'worktree', 'session'].includes(rc.spawn)) throw new Error(`gecersiz spawn: ${rc.spawn}`);
  if (!SAFE_ARG.test(rc.name)) throw new Error('remoteControl.name yalnizca harf, rakam, bosluk ve ()-._ icerebilir');
  if (!Number.isInteger(rc.capacity) || rc.capacity < 1) throw new Error('remoteControl.capacity >= 1 olmali');
  for (const k of ['authCheckIntervalSec', 'githubPollIntervalSec', 'loginTimeoutSec']) {
    if (!(c[k] >= 5)) throw new Error(`${k} >= 5 olmali`);
  }
  if (c.github.repo && !/^[\w.-]+\/[\w.-]+$/.test(c.github.repo)) throw new Error('github.repo "sahip/depo" bicimde olmali');
}

function load(home = defaultHome()) {
  let user = {};
  const file = path.join(home, 'config.json');
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const c = merge(DEFAULTS, user);
  if (!c.remoteControl.name) c.remoteControl.name = `Claude Agent (${os.hostname()})`;
  c.github.allowedUsers = (c.github.allowedUsers || []).map((u) => String(u).toLowerCase());
  c.paths = pathsFor(home);
  validate(c);
  return c;
}

module.exports = { load, defaultHome, pathsFor, merge, DEFAULTS };

'use strict';
const fs = require('fs');
const path = require('path');

const RULES = [
  [/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED-GH]'],
  [/github_pat_[A-Za-z0-9_]+/g, '[REDACTED-GH]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/([?&"'](?:code|state|access_token|refresh_token|code_verifier)["']?[=:]\s*["']?)[^&\s"']+/gi, '$1[REDACTED]'],
];

function redact(text) {
  let out = String(text);
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

class Logger {
  constructor(dir, name, { maxBytes = 5 * 1024 * 1024, keep = 5, echo = false } = {}) {
    this.file = path.join(dir, `${name}.log`);
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.echo = echo;
    fs.mkdirSync(dir, { recursive: true });
  }

  _rotate() {
    try {
      if (fs.statSync(this.file).size < this.maxBytes) return;
    } catch { return; }
    for (let i = this.keep - 1; i >= 1; i--) {
      try { fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch { /* yok */ }
    }
    try { fs.renameSync(this.file, `${this.file}.1`); } catch { /* yok */ }
  }

  write(level, msg, ...rest) {
    const extra = rest.length ? ' ' + rest.map((r) => (r instanceof Error ? r.message : typeof r === 'string' ? r : JSON.stringify(r))).join(' ') : '';
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(msg + extra)}\n`;
    try {
      this._rotate();
      fs.appendFileSync(this.file, line);
    } catch { /* log yazilamazsa ajan durmamali */ }
    if (this.echo) process.stdout.write(line);
  }

  info(...a) { this.write('INFO', ...a); }
  warn(...a) { this.write('WARN', ...a); }
  error(...a) { this.write('ERROR', ...a); }
}

module.exports = { Logger, redact };

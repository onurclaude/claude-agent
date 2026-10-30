'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');

class RateLimitError extends Error {
  constructor(retryAfterSec) { super(`GitHub hiz siniri (${retryAfterSec}s)`); this.retryAfterSec = retryAfterSec; }
}

class NotPrivateError extends Error {
  constructor(repo) { super(`${repo} ozel (private) bir depo degil`); }
}

// DPAPI ile (yalnizca bu Windows kullanicisi cozebilir) saklanan GitHub kontrol tokeni.
function readToken(file) {
  if (process.env.CLAUDE_AGENT_GH_TOKEN) return process.env.CLAUDE_AGENT_GH_TOKEN.trim();
  if (!fs.existsSync(file)) return null;
  const ps = `$s = ConvertTo-SecureString ((Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw).Trim()); ` +
    '[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' }).trim();
}

class GitHub {
  constructor({ repo, issue, token, fetchFn = fetch }) {
    this.repo = repo;
    this.issue = issue;
    this.token = token;
    this.fetch = fetchFn;
  }

  async _req(method, path, body) {
    const res = await this.fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'claude-persistent-agent',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      throw new RateLimitError(Number(res.headers.get('retry-after')) || Math.max(60, Math.ceil(reset / 1000)));
    }
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async listComments(sinceIso) {
    const q = `per_page=100${sinceIso ? `&since=${encodeURIComponent(sinceIso)}` : ''}`;
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this._req('GET', `/repos/${this.repo}/issues/${this.issue}/comments?${q}&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  // Kod yorumlari GitHub'a yazildigi icin yalnizca OZEL depoda calisilir. Olumlu sonuc 10 dk onbelleklenir.
  async assertPrivate() {
    if (this._privateUntil > Date.now()) return;
    const repo = await this._req('GET', `/repos/${this.repo}`);
    if (repo.private !== true) throw new NotPrivateError(this.repo);
    this._privateUntil = Date.now() + 10 * 60 * 1000;
  }

  deleteComment(id) {
    return this._req('DELETE', `/repos/${this.repo}/issues/comments/${id}`);
  }

  comment(text) {
    return this._req('POST', `/repos/${this.repo}/issues/${this.issue}/comments`, { body: String(text).slice(0, 60000) });
  }

  createIssue(title, body) {
    return this._req('POST', `/repos/${this.repo}/issues`, { title, body });
  }
}

module.exports = { GitHub, RateLimitError, NotPrivateError, readToken };

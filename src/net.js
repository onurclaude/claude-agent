'use strict';

const PROBES = ['https://api.anthropic.com', 'https://claude.ai', 'https://api.github.com'];

// Herhangi bir HTTP yaniti = internet var.
async function online(fetchFn = fetch, probes = PROBES) {
  for (const url of probes) {
    try {
      await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
      return true;
    } catch { /* sonraki */ }
  }
  return false;
}

module.exports = { online };

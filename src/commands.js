'use strict';

const COMMANDS = new Set(['login', 'cancel-login', 'status', 'restart', 'help']);

// Yalnizca yorumun ilk dolu satiri "/komut" ise komuttur. Ajanin kendi yorumlari "🤖" ile basladigi icin
// kendi mesajlarini komut sanmaz.
function parseCommand(body) {
  const first = String(body || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first || !first.startsWith('/')) return null;
  const word = first.slice(1).split(/\s+/)[0].toLowerCase();
  return COMMANDS.has(word) ? word : null;
}

const CODE_RE = /^[A-Za-z0-9_#.~-]{8,300}$/;

// "/code KOD" yorumu: undefined = kod yorumu degil, null = kod yorumu ama bicimi gecersiz, string = kod.
function parseCode(body) {
  const first = String(body || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  const m = first && /^\/code(?:\s+(.*))?$/i.exec(first);
  if (!m) return undefined;
  const arg = (m[1] || '').trim();
  return CODE_RE.test(arg) ? arg : null;
}

module.exports = { parseCommand, parseCode, COMMANDS };

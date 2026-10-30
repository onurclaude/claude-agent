'use strict';
const { execFile } = require('child_process');

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function commandLine(pid) {
  return new Promise((resolve) => {
    const cmd = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

// Yalnizca bu ajanin kendi dogruladigi PID'leri sonlandirir.
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

async function killIfOurs(pid, marker) {
  if (!pid || !marker || !isAlive(pid)) return false;
  const cl = await commandLine(pid);
  if (!cl || !cl.includes(marker)) return false;
  await killTree(pid);
  return true;
}

module.exports = { isAlive, commandLine, killTree, killIfOurs };

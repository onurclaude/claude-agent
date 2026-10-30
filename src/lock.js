'use strict';
const fs = require('fs');
const procs = require('./procs');

// Tek ornek kilidi. Eski/olu PID'li kilit devralinir.
async function acquire(file, { isAlive = procs.isAlive, commandLine = procs.commandLine } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch { /* yok */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
      if (pid && pid !== process.pid && isAlive(pid)) {
        const cl = await commandLine(pid);
        if (cl && cl.includes('cli.js')) return null;
      }
      try { fs.unlinkSync(file); } catch { /* yaris */ }
    }
  }
  return null;
}

module.exports = { acquire };

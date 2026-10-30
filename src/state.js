'use strict';
const fs = require('fs');

function fresh() {
  return {
    version: 1,
    mode: 'STARTING',
    modeSince: new Date().toISOString(),
    supervisorPid: null,
    lastAuthOkAt: null,
    lastLogoutAt: null,
    lastLoginAt: null,
    gh: { cursorId: 0, since: null },
    rc: { pid: null, marker: null, url: null, hadSession: false, continueFailed: false, restarts: 0, lastExit: null },
    interrupted: null,
  };
}

class StateStore {
  constructor(file) {
    this.file = file;
    this.data = this._read();
  }

  _read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = fresh();
      return { ...base, ...d, gh: { ...base.gh, ...d.gh }, rc: { ...base.rc, ...d.rc } };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* yok */ }
      }
      return fresh();
    }
  }

  update(fn) {
    fn(this.data);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { StateStore, fresh };

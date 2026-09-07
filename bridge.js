// bridge.js
// Wrapper Node.js buat manggil AkhtarPowerBridge.exe (proses C# terpisah
// yang isinya PowerNative.cs G-Helper apa adanya, GPL-3.0).
//
// Setiap panggilan = 1 spawn proses baru, kirim 1 baris JSON ke stdin,
// baca 1 baris JSON dari stdout, proses otomatis exit. Simpel & aman,
// gak perlu jaga proses long-running.

const { spawn } = require('child_process');
const path = require('path');

const EXE_PATH = path.join(__dirname, 'bin', 'AkhtarPowerBridge.exe');

function callBridge(cmd, extra = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(EXE_PATH, [], { windowsHide: true });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('error', (err) => {
      reject(new Error(`Gagal jalanin AkhtarPowerBridge.exe: ${err.message}`));
    });

    proc.on('close', () => {
      const line = stdout.trim().split(/\r?\n/).pop() || '';
      if (!line) {
        return reject(new Error(`AkhtarPowerBridge gak ngasih output. stderr: ${stderr.trim()}`));
      }
      try {
        const parsed = JSON.parse(line);
        if (!parsed.ok) {
          return reject(new Error(parsed.error || 'AkhtarPowerBridge gagal tanpa pesan error.'));
        }
        resolve(parsed.result);
      } catch (e) {
        reject(new Error(`Output AkhtarPowerBridge bukan JSON valid: ${line}`));
      }
    });

    proc.stdin.write(JSON.stringify({ cmd, ...extra }) + '\n');
    proc.stdin.end();
  });
}

module.exports = {
  // mode: 0 balanced, 1 turbo, 2 silent, 3 high performance
  getPowerMode: () => callBridge('getPowerMode'),
  setPowerMode: (mode) => callBridge('setPowerMode', { mode }),

  // scheme: 'silent' | 'balanced' | 'turbo' | GUID mentah
  setOverlay: (scheme, plan) => callBridge('setOverlay', { scheme, plan }),

  getCpuBoost: () => callBridge('getCpuBoost'),
  setCpuBoost: (boost) => callBridge('setCpuBoost', { boost }),

  getAspm: () => callBridge('getAspm'),
  setAspm: (status) => callBridge('setAspm', { status }),

  getLidAction: (ac) => callBridge('getLidAction', { ac }),
  setLidAction: (action, acOnly = false) => callBridge('setLidAction', { action, acOnly }),

  getHibernateAfter: () => callBridge('getHibernateAfter'),
  setHibernateAfter: (minutes) => callBridge('setHibernateAfter', { minutes }),

  getBatterySaverStatus: () => callBridge('getBatterySaverStatus'),
};

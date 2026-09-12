const { contextBridge, ipcRenderer } = require('electron');


// ==================================
// EXISTING ELECTRON API
// ==================================

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version: process.versions.electron,
});


// ==================================
// AKHTAR BROWSER API
// ==================================

contextBridge.exposeInMainWorld('akhtarBrowser', {

  // Buka browser
  show: () => {
    return ipcRenderer.invoke('browser-show');
  },

  // Sembunyikan browser
  hide: () => {
    return ipcRenderer.invoke('browser-hide');
  },

  // Toggle browser
  toggle: () => {
    return ipcRenderer.invoke('browser-toggle');
  },

  // Buka URL / search
  navigate: (input) => {
    return ipcRenderer.invoke(
      'browser-navigate',
      input
    );
  },

  // Buka tab baru (url opsional, incognito opsional)
  newTab: (url, incognito) => {
    return ipcRenderer.invoke('browser-new-tab', url, incognito);
  },

  // Tutup tab
  closeTab: (id) => {
    return ipcRenderer.invoke('browser-close-tab', id);
  },

  // Pindah ke tab lain
  switchTab: (id) => {
    return ipcRenderer.invoke('browser-switch-tab', id);
  },

  // Ambil daftar riwayat browsing
  historyList: () => {
    return ipcRenderer.invoke('browser-history-list');
  },

  // Hapus satu entri riwayat berdasarkan visitedAt
  historyDelete: (visitedAt) => {
    return ipcRenderer.invoke('browser-history-delete', visitedAt);
  },

  // Hapus semua riwayat
  historyClear: () => {
    return ipcRenderer.invoke('browser-history-clear');
  },

  // Ambil daftar bookmark
  bookmarkList: () => {
    return ipcRenderer.invoke('browser-bookmark-list');
  },

  // Tambah bookmark
  bookmarkAdd: (url, title) => {
    return ipcRenderer.invoke('browser-bookmark-add', url, title);
  },

  // Hapus bookmark
  bookmarkRemove: (id) => {
    return ipcRenderer.invoke('browser-bookmark-remove', id);
  },

  // Ambil daftar mesin pencari yang tersedia: [{ id, name, icon }]
  searchEngineList: () => {
    return ipcRenderer.invoke('browser-search-engines-list');
  },

  // Ambil id mesin pencari yang lagi dipakai sekarang
  getSearchEngine: () => {
    return ipcRenderer.invoke('browser-search-engine-get');
  },

  // Info lengkap mesin pencari aktif: { id, name, icon }
  getSearchEngineInfo: () => {
    return ipcRenderer.invoke('browser-search-engine-info');
  },

  // Bentuk URL pencarian dari query mentah pakai mesin pencari yang aktif
  // (buat Spotlight/Hot Corner Search biar konsisten sama Easy Browser)
  buildSearchUrl: (query) => {
    return ipcRenderer.invoke('browser-search-build-url', query);
  },

  // Ganti mesin pencari (id, misal 'bing', 'duckduckgo', dst). Balikin id yang aktif.
  setSearchEngine: (id) => {
    return ipcRenderer.invoke('browser-search-engine-set', id);
  },

  // Kembali
  back: () => {
    return ipcRenderer.invoke('browser-back');
  },

  // Maju
  forward: () => {
    return ipcRenderer.invoke('browser-forward');
  },

  // Reload
  reload: () => {
    return ipcRenderer.invoke('browser-reload');
  },

  // Stop loading
  stop: () => {
    return ipcRenderer.invoke('browser-stop');
  },

  // Homepage
  home: () => {
    return ipcRenderer.invoke('browser-home');
  },

  // Atur posisi dan ukuran browser
  setBounds: (bounds) => {
    return ipcRenderer.invoke(
      'browser-bounds',
      bounds
    );
  },

  // Ambil status browser
  getState: () => {
    return ipcRenderer.invoke(
      'browser-get-state'
    );
  },

  // Menerima update status browser
  onState: (callback) => {

    if (typeof callback !== 'function') {
      return;
    }

    const listener = (_, state) => {
      callback(state);
    };

    ipcRenderer.on(
      'browser-state',
      listener
    );

    // Fungsi untuk berhenti mendengarkan event
    return () => {
      ipcRenderer.removeListener(
        'browser-state',
        listener
      );
    };
  }
});


// ==================================
// STAGE 2 — REAL FILE SYSTEM API
// ==================================

contextBridge.exposeInMainWorld('akhtarFS', {

  getRoot: () => ipcRenderer.invoke('fs-get-root'),

  // Buka folder "penyimpanan os" langsung di File Explorer / Finder
  openRootFolder: () => ipcRenderer.invoke('fs-open-root'),

  list: (relPath) => ipcRenderer.invoke('fs-list', relPath),

  readFile: (relPath) => ipcRenderer.invoke('fs-read-file', relPath),

  writeFile: (relPath, content) =>
    ipcRenderer.invoke('fs-write-file', relPath, content),

  readBinary: (relPath) => ipcRenderer.invoke('fs-read-binary', relPath),

  writeBinary: (relPath, base64Data) =>
    ipcRenderer.invoke('fs-write-binary', relPath, base64Data),

  mkdir: (relPath) => ipcRenderer.invoke('fs-mkdir', relPath),

  delete: (relPath) => ipcRenderer.invoke('fs-delete', relPath),

  rename: (oldRel, newRel) =>
    ipcRenderer.invoke('fs-rename', oldRel, newRel),

  exists: (relPath) => ipcRenderer.invoke('fs-exists', relPath),

  stat: (relPath) => ipcRenderer.invoke('fs-stat', relPath),

  // Migrasi data lama dari IndexedDB (fileSystem tree) ke disk asli
  migrate: (tree) => ipcRenderer.invoke('fs-migrate', tree)
});


// ==================================
// STAGE 3 — EXE RUNNER API
// ==================================

contextBridge.exposeInMainWorld('akhtarExe', {

  upload: () => ipcRenderer.invoke('exe-upload'),

  list: () => ipcRenderer.invoke('exe-list'),

  run: (fileName) => ipcRenderer.invoke('exe-run', fileName),

  stop: (id) => ipcRenderer.invoke('exe-stop', id),

  running: () => ipcRenderer.invoke('exe-running'),

  onOutput: (callback) => {

    if (typeof callback !== 'function') {
      return;
    }

    const listener = (_, payload) => {
      callback(payload);
    };

    ipcRenderer.on('exe-output', listener);

    return () => {
      ipcRenderer.removeListener('exe-output', listener);
    };
  },

  onExit: (callback) => {

    if (typeof callback !== 'function') {
      return;
    }

    const listener = (_, payload) => {
      callback(payload);
    };

    ipcRenderer.on('exe-exit', listener);

    return () => {
      ipcRenderer.removeListener('exe-exit', listener);
    };
  }
});

// ==================================
// WIFI API
// ==================================

contextBridge.exposeInMainWorld('akhtarWifi', {

  // Scan jaringan Wi-Fi
  scan: () => {
    return ipcRenderer.invoke('wifi-scan');
  },

  // Connect ke jaringan (ssid, password opsional, authType: 'open'|'WPA2PSK'|'WPA3SSE'|'WPAPSK'|'WEP')
  connect: (ssid, password, authType) => {
    return ipcRenderer.invoke('wifi-connect', { ssid, password, authType });
  },

  // Connect cepat ke jaringan yang profile-nya udah tersimpan (gak perlu password)
  quickConnect: (ssid) => {
    return ipcRenderer.invoke('wifi-quick-connect', ssid);
  },

  // Putuskan koneksi Wi-Fi aktif
  disconnect: () => {
    return ipcRenderer.invoke('wifi-disconnect');
  },

  // Lupakan / hapus profile jaringan tersimpan
  forget: (ssid) => {
    return ipcRenderer.invoke('wifi-forget', ssid);
  },

  // Ambil daftar semua profile Wi-Fi yang tersimpan di Windows
  savedProfiles: () => {
    return ipcRenderer.invoke('wifi-saved-profiles');
  },

  // Ambil detail adapter: nama, IP, gateway, DNS, signal, dll
  adapterInfo: () => {
    return ipcRenderer.invoke('wifi-adapter-info');
  }

});

// ==================================
// DNS SHIELD API
// ==================================

contextBridge.exposeInMainWorld('akhtarDns', {

  // Ambil daftar provider DNS
  getProviders: () => {
    return ipcRenderer.invoke('dns-get-providers');
  },

  // Ambil status DNS saat ini
  getStatus: () => {
    return ipcRenderer.invoke('dns-get-status');
  },

  // Set DNS ke provider tertentu (customId opsional untuk NextDNS/Control D)
  setProvider: (providerId, customId) => {
    return ipcRenderer.invoke('dns-set-provider', providerId, customId || '');
  },

  // Reset DNS ke default (DHCP)
  reset: () => {
    return ipcRenderer.invoke('dns-reset');
  }

});

// ==================================
// PERFORMANCE MODE API
// ==================================
// Kontrol optimasi asli di level OS (prioritas proses + power plan) —
// bukan overclock chip beneran, itu di luar jangkauan software.

contextBridge.exposeInMainWorld('akhtarPerf', {

  // Ambil status Performance Mode sekarang: { enabled }
  getStatus: () => {
    return ipcRenderer.invoke('perf-get-status');
  },

  // Nyalain / matiin Performance Mode. Balikin { enabled, steps: [{ok,label}] }
  setMode: (enable) => {
    return ipcRenderer.invoke('perf-set-mode', enable);
  }

});

// ==================================
// REAL POWER / BATTERY API
// ==================================
// Beda sama navigator.getBattery() (yang udah di-drop Chromium buat web biasa),
// ini narik data baterai LANGSUNG dari OS lewat main process, plus event asli
// kapan device pindah ke/dari charger dan kapan laptop suspend/resume.

contextBridge.exposeInMainWorld('akhtarPower', {

  // Ambil status baterai sekarang: { supported, percent, charging, onBattery, source }
  getStatus: () => {
    return ipcRenderer.invoke('power-get-status');
  },

  // Ambil info kesehatan baterai: { supported, designCapacity, fullChargeCapacity, healthPercent, cycleCount }
  // healthPercent = (fullChargeCapacity / designCapacity) * 100 — makin turun makin "aus" baterainya.
  getHealth: () => {
    return ipcRenderer.invoke('power-get-health');
  },

  // Dengerin perubahan status baterai (dipanggil tiap ganti charger atau tiap ~60 detik)
  onChange: (callback) => {

    if (typeof callback !== 'function') {
      return;
    }

    const listener = (_, status) => {
      callback(status);
    };

    ipcRenderer.on('power-state', listener);

    return () => {
      ipcRenderer.removeListener('power-state', listener);
    };
  },

  // Dengerin event laptop mau suspend (tidur) — bagus buat pause kerjaan berat duluan
  onSuspend: (callback) => {

    if (typeof callback !== 'function') {
      return;
    }

    const listener = () => callback();
    ipcRenderer.on('power-suspend', listener);

    return () => {
      ipcRenderer.removeListener('power-suspend', listener);
    };
  },

  // Dengerin event laptop baru bangun dari suspend
  onResume: (callback) => {

    if (typeof callback !== 'function') {
      return;
    }

    const listener = () => callback();
    ipcRenderer.on('power-resume', listener);

    return () => {
      ipcRenderer.removeListener('power-resume', listener);
    };
  }

});

// ==================================
// AKHTAR SHARE API (P2P FILE SHARING — FASE 1)
// ==================================

contextBridge.exposeInMainWorld('akhtarShare', {

  // Status modul: { supported, enabled, device: {id,name,platform}, error }
  getStatus: () => ipcRenderer.invoke('share-get-status'),

  // Nyalain / matiin discovery + server transfer
  start: () => ipcRenderer.invoke('share-start'),
  stop: () => ipcRenderer.invoke('share-stop'),

  // Ganti nama device yang keliatan di device lain
  setName: (name) => ipcRenderer.invoke('share-set-name', name),

  // Ambil daftar device yang lagi kedeteksi di LAN
  getDevices: () => ipcRenderer.invoke('share-get-devices'),

  // Buka dialog pilih file lalu langsung kirim ke targetDeviceId
  pickAndSend: (targetDeviceId) => ipcRenderer.invoke('share-pick-and-send', targetDeviceId),

  // Kirim file yang path-nya udah diketahui (misal dari drag&drop File Manager)
  sendFiles: (targetDeviceId, filePaths) =>
    ipcRenderer.invoke('share-send-files', targetDeviceId, filePaths),

  // Terima (true) atau tolak (false) permintaan transfer masuk
  respondRequest: (transferId, accept) =>
    ipcRenderer.invoke('share-respond-request', transferId, accept),

  // Batalin transfer yang lagi jalan (sisi pengirim)
  cancelTransfer: (transferId) => ipcRenderer.invoke('share-cancel-transfer', transferId),

  // Buka folder tempat file hasil terima disimpan
  openDownloadsFolder: () => ipcRenderer.invoke('share-open-downloads-folder'),

  // Dengerin perubahan daftar device (dipanggil tiap ada device muncul/ilang)
  onDevices: (callback) => {
    if (typeof callback !== 'function') return;
    const listener = (_, devices) => callback(devices);
    ipcRenderer.on('share-devices', listener);
    return () => ipcRenderer.removeListener('share-devices', listener);
  },

  // Dengerin permintaan transfer masuk dari device lain
  onIncomingRequest: (callback) => {
    if (typeof callback !== 'function') return;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('share-incoming-request', listener);
    return () => ipcRenderer.removeListener('share-incoming-request', listener);
  },

  // Dengerin progress transfer (jalan buat pengirim maupun penerima)
  onProgress: (callback) => {
    if (typeof callback !== 'function') return;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('share-transfer-progress', listener);
    return () => ipcRenderer.removeListener('share-transfer-progress', listener);
  },

  // Dengerin transfer selesai
  onDone: (callback) => {
    if (typeof callback !== 'function') return;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('share-transfer-done', listener);
    return () => ipcRenderer.removeListener('share-transfer-done', listener);
  },

  // Dengerin error transfer (ditolak, koneksi putus, dll)
  onError: (callback) => {
    if (typeof callback !== 'function') return;
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('share-transfer-error', listener);
    return () => ipcRenderer.removeListener('share-transfer-error', listener);
  }
});

// ==================================
// TORRENT API
// ==================================

contextBridge.exposeInMainWorld('akhtarTorrent', {
    // Add torrent (magnet link, torrent file, infoHash)
    add: (source) => ipcRenderer.invoke('torrent-add', source),
    
    // Pause torrent
    pause: (id) => ipcRenderer.invoke('torrent-pause', id),
    
    // Resume torrent
    resume: (id) => ipcRenderer.invoke('torrent-resume', id),
    
    // Remove torrent
    remove: (id) => ipcRenderer.invoke('torrent-remove', id),
    
    // List all torrents
    list: () => ipcRenderer.invoke('torrent-list'),
    
    // Get detail of specific torrent
    detail: (id) => ipcRenderer.invoke('torrent-detail', id),

    // Buka folder tempat file torrent yang udah kedownload disimpan
    openFolder: () => ipcRenderer.invoke('torrent-open-folder'),
    
    // Listen to progress updates
    onProgress: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('torrent-progress', listener);
        return () => ipcRenderer.removeListener('torrent-progress', listener);
    },
    
    // Listen to done event
    onDone: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('torrent-done', listener);
        return () => ipcRenderer.removeListener('torrent-done', listener);
    },
    
    // Listen to error event
    onError: (callback) => {
        const listener = (_, data) => callback(data);
        ipcRenderer.on('torrent-error', listener);
        return () => ipcRenderer.removeListener('torrent-error', listener);
    }
});


// ==================================
// TOR CONNECTION API
// ==================================

contextBridge.exposeInMainWorld('akhtarTor', {
    // GET request lewat jaringan Tor. options = { headers, params, ... } (opsional)
    request: (url, options) => ipcRenderer.invoke('tor-request', url, options),

    // Cek apakah koneksi beneran lewat Tor exit node + tampilin IP-nya
    checkIP: () => ipcRenderer.invoke('tor-check-ip'),

    // Status daemon Tor (jalan/tidak)
    status: () => ipcRenderer.invoke('tor-status')
});


// ==================================
// HARDWARE PERFORMANCE MODE API
// ==================================

contextBridge.exposeInMainWorld('akhtarHardware', {
    // Deteksi vendor laptop (asus/msi/unknown)
    getVendor: () => ipcRenderer.invoke('hw-get-vendor'),

    // Cek apakah laptop punya hardware MUX switch (dGPU-only mode) atau enggak
    checkGPUMuxSupport: () => ipcRenderer.invoke('hw-check-gpu-mux-support'),

    // modeKey: 'silent' | 'balanced' | 'turbo' | 'fanspower'
    setCPUMode: (modeKey) => ipcRenderer.invoke('hw-set-cpu-mode', modeKey),

    // modeKey: 'eco' | 'standard' | 'ultimate' | 'optimized' (cuma ASUS)
    setGPUMode: (modeKey) => ipcRenderer.invoke('hw-set-gpu-mode', modeKey)
});

// ==================================
// DATA POISONING ENGINE API
// ==================================

// ==================================
// GEOLOCATION & TIME SPOOFER API
// ==================================

contextBridge.exposeInMainWorld('akhtarSpoof', {
  // Ambil daftar negara (27) + lokasi (100+) yang tersedia buat dipilih
  getLocations: () => ipcRenderer.invoke('spoof-get-locations'),

  // Ambil status sekarang: { enabled, countryCode, locationId, profile }
  getStatus: () => ipcRenderer.invoke('spoof-get-status'),

  // Nyalain/matiin + pilih negara & lokasi.
  // config = { enabled: bool, countryCode: 'JP', locationId: 'jp-tokyo' }
  // Balikin { ok, enabled, profile } atau { ok:false, error } kalau gak valid.
  setConfig: (config) => ipcRenderer.invoke('spoof-set', config)
});

contextBridge.exposeInMainWorld('akhtarPoison', {
    // Nyalain engine — mulai spawn ghost session secara berkala
    start: () => ipcRenderer.invoke('poison-start'),

    // Matiin engine — stop scheduler + destroy ghost window yang lagi jalan (kalau ada)
    stop: () => ipcRenderer.invoke('poison-stop'),

    // Status sekarang: { active, sessionCount, queryCount, log }
    status: () => ipcRenderer.invoke('poison-status'),

    // Live feed tiap ada aktivitas baru (sesi mulai/selesai/error, engine on/off)
    onActivity: (callback) => {
        const listener = (event, entry) => callback(entry);
        ipcRenderer.on('poison-activity', listener);
        return () => ipcRenderer.removeListener('poison-activity', listener);
    }
});

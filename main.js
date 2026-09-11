const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  WebContentsView,
  ipcMain,
  dialog,
  session,
  powerMonitor,
  shell
} = require('electron');

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const os = require('os');

// ==================================
// HARDWARE PERFORMANCE MODE (CPU / GPU)
// Layer 1 (universal, semua vendor): Windows Power Plan lewat powercfg
// Layer 2 (khusus ASUS): ATK WMI resmi (root\wmi, class AsusAtkWmi_WMNB) — divalidasi firmware sendiri
// MSI: cuma layer 1 (powercfg). Belum ada endpoint MSI yang terdokumentasi resmi & aman buat fan/GPU switch,
// jadi sengaja gak disambungin ke hardware biar gak asal tebak alamat EC.
// ==================================

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) {
          const raw = (stderr || error.message || '').toString().trim();
          // PowerShell ngedump multi-line trace (At line:x char:y, CategoryInfo, dll).
          // Buat user cukup baris pertama yang informatif; sisanya cuma noise teknis.
          const firstLine = raw.split(/\r?\n/)[0].trim();
          const cleanErr = new Error(firstLine || raw || 'PowerShell command gagal.');
          cleanErr.raw = raw; // simpan full trace kalau suatu saat butuh debug lebih dalam
          return reject(cleanErr);
        }
        resolve((stdout || '').toString().trim());
      }
    );
  });
}

// ---- Native WMI addon (opsional, C++/N-API) ----
// Jauh lebih cepet & bersih daripada spawn powershell.exe tiap panggilan,
// tapi butuh di-compile dulu di mesin Windows (lihat native/asus-wmi-addon/README.md).
// Kalau belum di-build atau gagal load karena alasan apapun, kita diem-diem
// fallback ke jalur PowerShell yang udah terbukti jalan — jadi user gak pernah
// ngerasain crash gara-gara native module.
let nativeAsusWmi = null;
let nativeAsusWmiLoadError = null;
try {
  nativeAsusWmi = require(path.join(__dirname, 'native', 'asus-wmi-addon'));
  console.log('[asus-wmi] native addon ke-load, dipakai buat panggilan WMI ASUS.');
} catch (e) {
  nativeAsusWmiLoadError = e.message;
  console.log('[asus-wmi] native addon gak ke-load (' + e.message + '), fallback ke PowerShell.');
}

let cachedVendor = null;
async function detectVendor() {
  if (cachedVendor) return cachedVendor;
  if (!IS_WIN) { cachedVendor = 'unknown'; return cachedVendor; }
  try {
    const out = await runPowerShell('(Get-CimInstance -ClassName Win32_ComputerSystem).Manufacturer');
    const m = out.toLowerCase();
    if (m.includes('asus')) cachedVendor = 'asus';
    else if (m.includes('micro-star') || m.includes('msi')) cachedVendor = 'msi';
    else cachedVendor = 'unknown';
  } catch (e) {
    cachedVendor = 'unknown';
  }
  return cachedVendor;
}

// ---- Layer 1: Windows Power Plan (universal, semua laptop Windows) ----
// ---- G-Helper Power Bridge (opsional, C#/.NET) ----
// Proses terpisah AkhtarPowerBridge.exe, isinya PowerNative.cs G-Helper
// apa adanya (GPL-3.0). Lebih akurat daripada powercfg /setactive doang,
// karena manggil PowerSetActiveOverlayScheme langsung (persis kayak
// slider "Power Mode" di Windows Settings). Kalau .exe-nya belum
// di-build atau gagal jalan, diem-diem fallback ke powercfg.
let powerBridge = null;
try {
  powerBridge = require(path.join(__dirname, 'native', 'akhtar-power-bridge', 'bridge'));
  console.log('[power-bridge] module ke-load, dipakai buat kontrol power mode.');
} catch (e) {
  console.log('[power-bridge] module gak ke-load (' + e.message + '), fallback ke powercfg.');
}

function setWindowsPowerScheme(alias) {
  // alias: 'SCHEME_MAX' (Power saver/Silent), 'SCHEME_BALANCED', 'SCHEME_MIN' (High performance/Turbo)
  return new Promise((resolve, reject) => {
    execFile('powercfg', ['/setactive', alias], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(true);
    });
  });
}

// ---- Layer 2: ASUS ATK WMI (resmi, dipakai Armoury Crate) ----
const ASUS_PERF_MODE_ID = 0x00120075; // DEVS values: 0 Balanced, 1 Turbo, 2 Silent
const ASUS_CPU_FAN_ID = 0x00110022;   // DEVS [min,max] 0-255, override fan range
const ASUS_GPU_FAN_ID = 0x00110023;
const ASUS_GPU_ECO_ID = 0x00090020;   // DEVS: 1 = iGPU only (eco/Optimus off-dGPU), 0 = dGPU nyala
const ASUS_GPU_MUX_ID = 0x00090016;   // DEVS: 0 = Ultimate (dGPU only, butuh restart), 1 = Standard/Optimus

async function asusDevsWrite(deviceId, values) {
  // Coba lewat native addon dulu (lebih cepet, gak spawn proses)
  if (nativeAsusWmi) {
    try {
      if (Array.isArray(values)) {
        return await nativeAsusWmi.devsWriteBytes(deviceId, values);
      }
      return await nativeAsusWmi.devsWrite(deviceId, values);
    } catch (e) {
      console.log('[asus-wmi] native devsWrite gagal, fallback ke PowerShell: ' + e.message);
      // lanjut ke jalur PowerShell di bawah
    }
  }

  // Fallback: values bisa single uint32, atau array 2 byte [min,max] buat fan range
  let valueExpr;
  if (Array.isArray(values)) {
    valueExpr = `[byte[]](${values.map((v) => v).join(',')})`;
  } else {
    valueExpr = `[uint32]${values}`;
  }
  const script = `
    $ErrorActionPreference = 'Stop'
    $wmi = Get-CimInstance -Namespace root\\wmi -ClassName AsusAtkWmi_WMNB
    $r = Invoke-CimMethod -InputObject $wmi -MethodName DEVS -Arguments @{Device_ID=[uint32]${deviceId}; Control_status=${valueExpr}}
    $r.result
  `;
  const out = await runPowerShell(script);
  return parseInt(out, 10);
}

async function asusDstsRead(deviceId) {
  // Coba lewat native addon dulu (lebih cepet, gak spawn proses)
  if (nativeAsusWmi) {
    try {
      return await nativeAsusWmi.dstsRead(deviceId);
    } catch (e) {
      console.log('[asus-wmi] native dstsRead gagal, fallback ke PowerShell: ' + e.message);
      // lanjut ke jalur PowerShell di bawah
    }
  }

  const script = `
    $ErrorActionPreference = 'Stop'
    $wmi = Get-CimInstance -Namespace root\\wmi -ClassName AsusAtkWmi_WMNB
    $r = Invoke-CimMethod -InputObject $wmi -MethodName DSTS -Arguments @{Device_ID=[uint32]${deviceId}}
    $r.result
  `;
  const out = await runPowerShell(script);
  return parseInt(out, 10);
}

const CPU_MODE_MAP = {
  // ghelper: index buat AkhtarPowerBridge (PowerNative.SetPowerMode(int))
  // 0=balanced, 1=turbo, 2=silent, 3=high performance plan
  silent:   { asus: 2, powercfg: 'SCHEME_MAX', ghelper: 2 },
  balanced: { asus: 0, powercfg: 'SCHEME_BALANCED', ghelper: 0 },
  turbo:    { asus: 1, powercfg: 'SCHEME_MIN', ghelper: 1 },
  fanspower:{ asus: 1, powercfg: 'SCHEME_MIN', ghelper: 1, boostFan: true }
};

const GPU_MODE_MAP = {
  eco:       { eco: 1, mux: null },
  standard:  { eco: 0, mux: 1 },
  ultimate:  { eco: 0, mux: 0 },
  optimized: { eco: 0, mux: 1 } // alias sementara ke Standard, belum ada spec resmi terpisah
};

ipcMain.handle('hw-get-vendor', async () => {
  const vendor = await detectVendor();
  return { vendor };
});

ipcMain.handle('hw-set-cpu-mode', async (event, modeKey) => {
  const mode = CPU_MODE_MAP[modeKey];
  if (!mode) return { ok: false, error: 'Mode gak dikenal.' };

  const vendor = await detectVendor();
  const steps = [];

  try {
    if (powerBridge) {
      try {
        await powerBridge.setPowerMode(mode.ghelper);
        steps.push('windows-power-plan: ok (via G-Helper PowerNative bridge)');
      } catch (e) {
        console.log('[power-bridge] setPowerMode gagal, fallback ke powercfg: ' + e.message);
        await setWindowsPowerScheme(mode.powercfg);
        steps.push('windows-power-plan: ok (fallback powercfg)');
      }
    } else {
      await setWindowsPowerScheme(mode.powercfg);
      steps.push('windows-power-plan: ok');
    }
  } catch (e) {
    steps.push('windows-power-plan: gagal (' + e.message + ')');
  }

  if (vendor === 'asus') {
    try {
      const result = await asusDevsWrite(ASUS_PERF_MODE_ID, mode.asus);
      steps.push('asus-firmware-preset: ' + (result === 1 ? 'ok' : 'ditolak firmware (' + result + ')'));
      if (mode.boostFan) {
        await asusDevsWrite(ASUS_CPU_FAN_ID, [0, 255]);
        await asusDevsWrite(ASUS_GPU_FAN_ID, [0, 255]);
        steps.push('asus-fan-boost: ok');
      }
    } catch (e) {
      steps.push('asus-firmware-preset: gagal (' + e.message + ')');
    }
  } else if (vendor === 'msi') {
    steps.push('msi-firmware-preset: dilewati (belum ada endpoint resmi yang aman buat MSI Cyborg)');
  }

  return { ok: true, vendor, steps };
});

ipcMain.handle('hw-check-gpu-mux-support', async () => {
  const vendor = await detectVendor();
  if (vendor !== 'asus') return { supported: false };
  try {
    // DSTS cuma baca status, gak ngubah apa-apa — aman dipakai buat probe kapabilitas
    await asusDstsRead(ASUS_GPU_MUX_ID);
    return { supported: true };
  } catch (e) {
    return { supported: false, reason: e.message };
  }
});

ipcMain.handle('hw-set-gpu-mode', async (event, modeKey) => {
  const mode = GPU_MODE_MAP[modeKey];
  if (!mode) return { ok: false, error: 'Mode gak dikenal.' };

  const vendor = await detectVendor();
  if (vendor !== 'asus') {
    return { ok: false, error: 'GPU mode switching cuma didukung di laptop ASUS lewat interface resmi. Belum ada endpoint aman buat MSI Cyborg.' };
  }

  const steps = [];
  let anySuccess = false;
  let needsRestart = false;

  // Eco toggle (dGPU on/off) — coba independen, jangan biarin satu gagal nge-abort semuanya
  try {
    const ecoResult = await asusDevsWrite(ASUS_GPU_ECO_ID, mode.eco);
    if (ecoResult === 1) {
      steps.push('eco-toggle: ok');
      anySuccess = true;
    } else {
      steps.push('eco-toggle: ditolak firmware (result=' + ecoResult + ')');
    }
  } catch (e) {
    steps.push('eco-toggle: gak didukung di model ini (' + e.message + ')');
  }

  // MUX switch (dGPU-only vs Optimus) — banyak TUF non-ROG gak punya hardware MUX sama sekali
  if (mode.mux !== null) {
    try {
      const muxResult = await asusDevsWrite(ASUS_GPU_MUX_ID, mode.mux);
      if (muxResult === 1) {
        steps.push('mux-switch: ok (butuh restart buat kepake)');
        anySuccess = true;
        needsRestart = true;
      } else {
        steps.push('mux-switch: ditolak firmware (result=' + muxResult + ')');
      }
    } catch (e) {
      const isUnsupportedMethod = /generic failure/i.test(e.message) || /0x80041001/i.test(e.message);
      steps.push(
        isUnsupportedMethod
          ? 'mux-switch: laptop ini gak punya hardware MUX switch fisik, jadi mode ini gak bisa diganti (firmware nolak: ' + e.message + ')'
          : 'mux-switch: gagal (' + e.message + ')'
      );
    }
  }

  return { ok: anySuccess, steps, needsRestart };
});

// ==================================
// TOR CONNECTION
// ==================================
let torAxios;
let torClient = null;
let torClientPort = null;
async function findTorPort() {
  const net = require('net');
  const candidates = [9150, 9050]; // 9150 = Tor Browser, 9050 = Tor daemon/Expert Bundle
  for (const port of candidates) {
    const open = await new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
      socket.connect(port, '127.0.0.1');
    });
    if (open) return port;
  }
  return null;
}
async function getTorClient() {
  const port = await findTorPort();
  if (!port) {
    throw new Error('Tidak ada Tor yang aktif di port 9150 (Tor Browser) atau 9050 (Tor daemon). Buka Tor Browser dulu, atau jalankan tor.exe.');
  }
  if (!torClient || torClientPort !== port) {
    const { TorAxios } = require('tor-axios');
    torClient = new TorAxios({ ip: '127.0.0.1', port });
    torClientPort = port;
  }
  return torClient;
}

let win = null;
let tray = null;

// ==================================
// TORRENT ENGINE (ESM)
// ==================================
let WebTorrent;
let torrentClient = null;
let activeTorrents = new Map();

async function loadWebTorrent() {
    if (!WebTorrent) {
        const module = await import('webtorrent');
        WebTorrent = module.default || module;
    }
    return WebTorrent;
}

async function getTorrentClient() {
    if (!torrentClient) {
        const WT = await loadWebTorrent();
        torrentClient = new WT({
            dht: true,
            tracker: true,
            webtorrent: true,
            announce: [
                'wss://tracker.btorrent.xyz',
                'wss://tracker.openwebtorrent.com',
                'wss://tracker.fastcast.nz',
                'wss://tracker.webtorrent.io'
            ]
        });

        // Event global
        torrentClient.on('error', (err) => {
            console.error('[Torrent] Error:', err);
            if (win && !win.isDestroyed()) {
                win.webContents.send('torrent-error', { error: err.message });
            }
        });
    }
    return torrentClient;
}

// Buat folder torrent
// (Path sebenarnya diisi di bawah, setelah ROOT_DIR didefinisikan —
// lihat blok STAGE 2 — REAL FILE SYSTEM. Sebelumnya ini pakai `const`
// dan langsung baca ROOT_DIR di top-level module, padahal ROOT_DIR
// baru dideklarasikan ratusan baris di bawah -> ReferenceError
// "Cannot access 'ROOT_DIR' before initialization" pas app start.)
let TORRENT_DIR = null;
let TORRENT_DOWNLOAD_DIR = null;
let TORRENT_INCOMPLETE_DIR = null;

function ensureTorrentFolders() {
    [TORRENT_DIR, TORRENT_DOWNLOAD_DIR, TORRENT_INCOMPLETE_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// ==================================
// BROWSER STATE (MULTI-TAB)
// ==================================

let browserTabs = [];
let activeTabId = null;
let browserVisible = false;
let browserBounds = null;
let tabIdCounter = 0;

const HOMEPAGE_URL = 'https://www.google.com';

const browserDataPath = path.join(
  app.getPath('userData'),
  'browser-data.json'
);

let browserHistory = [];
let browserBookmarks = [];

function loadBrowserData() {
  try {
    const raw = fs.readFileSync(browserDataPath, 'utf-8');
    const data = JSON.parse(raw);
    browserHistory = Array.isArray(data.history) ? data.history : [];
    browserBookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
  } catch (error) {
    browserHistory = [];
    browserBookmarks = [];
  }
}

function saveBrowserData() {
  try {
    fs.writeFileSync(
      browserDataPath,
      JSON.stringify({
        history: browserHistory,
        bookmarks: browserBookmarks
      }),
      'utf-8'
    );
  } catch (error) {
    console.error('Gagal nyimpen data browser:', error);
  }
}

loadBrowserData();

function addHistoryEntry(view, tab) {
  if (tab.incognito) return;

  const url = view.webContents.getURL();

  if (!url || /^(chrome-extension|devtools|about):/i.test(url)) {
    return;
  }

  browserHistory.unshift({
    url,
    title: view.webContents.getTitle() || url,
    visitedAt: Date.now()
  });

  if (browserHistory.length > 500) {
    browserHistory = browserHistory.slice(0, 500);
  }

  saveBrowserData();
}

function getActiveTab() {
  return browserTabs.find((t) => t.id === activeTabId) || null;
}

function findTab(id) {
  return browserTabs.find((t) => t.id === id) || null;
}

// ==================================
// CREATE TAB
// ==================================

function createTab(url, incognito) {
  if (!win || win.isDestroyed()) {
    return null;
  }

  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: incognito
        ? `incognito-${Date.now()}-${Math.round(Math.random() * 1e6)}`
        : undefined
    }
  });

  tabIdCounter += 1;

  const tab = {
    id: tabIdCounter,
    view,
    incognito: !!incognito
  };

  win.contentView.addChildView(view);
  view.setVisible(false);

  if (browserBounds) {
    view.setBounds(browserBounds);
  }

  view.webContents.loadURL(url || HOMEPAGE_URL);

  view.webContents.on('did-navigate', () => {
    addHistoryEntry(view, tab);
    sendBrowserState();
  });

  view.webContents.on('did-navigate-in-page', () => {
    sendBrowserState();
  });

  view.webContents.on('did-finish-load', () => {
    sendBrowserState();
  });

  view.webContents.on('page-title-updated', () => {
    sendBrowserState();
  });

  view.webContents.on('did-start-loading', () => {
    sendBrowserState();
  });

  view.webContents.on('did-stop-loading', () => {
    sendBrowserState();
  });

  view.webContents.on(
    'did-fail-load',
    (event, errorCode, errorDescription, validatedURL) => {
      console.error('=================================');
      console.error('BROWSER GAGAL MEMUAT');
      console.error('Error Code:', errorCode);
      console.error('Description:', errorDescription);
      console.error('URL:', validatedURL);
      console.error('=================================');
      sendBrowserState();
    }
  );

  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (popupUrl) {
      view.webContents.loadURL(popupUrl);
    }
    return { action: 'deny' };
  });

  view.webContents.on('destroyed', () => {
    spoofScriptIds.delete(tab.id);
    browserTabs = browserTabs.filter((t) => t.id !== tab.id);
  });

  browserTabs.push(tab);

  // Tab baru langsung ikutan spoof lokasi/timezone yang lagi aktif (kalau ada).
  spoofApplyToTab(tab).catch(() => {});

  return tab;
}

// ==================================
// SEND BROWSER STATE
// ==================================

function sendBrowserState() {
  if (!win || win.isDestroyed()) {
    return;
  }

  const active = getActiveTab();

  win.webContents.send('browser-state', {
    visible: browserVisible,
    activeTabId,
    url: active ? active.view.webContents.getURL() : '',
    title: active ? active.view.webContents.getTitle() : '',
    canGoBack: active ? active.view.webContents.canGoBack() : false,
    canGoForward: active ? active.view.webContents.canGoForward() : false,
    loading: active ? active.view.webContents.isLoading() : false,
    tabs: browserTabs.map((t) => ({
      id: t.id,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
      loading: t.view.webContents.isLoading(),
      incognito: t.incognito
    }))
  });
}

// ==================================
// BROWSER CONTROLS
// ==================================

function showBrowser() {
  if (!win || win.isDestroyed()) {
    return false;
  }

  let active = getActiveTab();

  if (!active) {
    active = createTab(HOMEPAGE_URL, false);
    if (!active) return false;
    activeTabId = active.id;
  }

  browserVisible = true;

  browserTabs.forEach((t) => {
    t.view.setVisible(t.id === activeTabId);
  });

  win.contentView.removeChildView(active.view);
  win.contentView.addChildView(active.view);

  sendBrowserState();

  return true;
}

function hideBrowser() {
  if (browserTabs.length === 0) {
    return false;
  }

  browserVisible = false;

  browserTabs.forEach((t) => t.view.setVisible(false));

  return true;
}

function toggleBrowser() {
  if (browserVisible) {
    hideBrowser();
  } else {
    showBrowser();
  }

  return browserVisible;
}

function switchTab(id) {
  const target = findTab(id);

  if (!target) {
    return false;
  }

  activeTabId = id;

  browserTabs.forEach((t) => {
    t.view.setVisible(browserVisible && t.id === activeTabId);
  });

  if (browserVisible) {
    win.contentView.removeChildView(target.view);
    win.contentView.addChildView(target.view);
  }

  sendBrowserState();

  return true;
}

function newTab(url, incognito) {
  if (!win || win.isDestroyed()) {
    return null;
  }

  const tab = createTab(url || HOMEPAGE_URL, incognito);

  if (!tab) {
    return null;
  }

  activeTabId = tab.id;
  browserVisible = true;

  browserTabs.forEach((t) => {
    t.view.setVisible(t.id === activeTabId);
  });

  win.contentView.removeChildView(tab.view);
  win.contentView.addChildView(tab.view);

  sendBrowserState();

  return tab.id;
}

function closeTab(id) {
  const target = findTab(id);

  if (!target) {
    return false;
  }

  const wasActive = target.id === activeTabId;
  const idx = browserTabs.indexOf(target);

  try {
    win.contentView.removeChildView(target.view);
  } catch (error) {}

  try {
    target.view.webContents.close();
  } catch (error) {}

  browserTabs = browserTabs.filter((t) => t.id !== id);

  if (wasActive) {
    if (browserTabs.length > 0) {
      const nextIdx = Math.min(Math.max(0, idx - 1), browserTabs.length - 1);
      const nextTab = browserTabs[nextIdx];

      activeTabId = nextTab.id;

      browserTabs.forEach((t) => {
        t.view.setVisible(browserVisible && t.id === activeTabId);
      });

      if (browserVisible) {
        win.contentView.removeChildView(nextTab.view);
        win.contentView.addChildView(nextTab.view);
      }
    } else {
      activeTabId = null;
      browserVisible = false;
    }
  }

  sendBrowserState();

  return true;
}

function navigateBrowser(input) {
  const active = getActiveTab();

  if (!active) {
    return false;
  }

  let value = String(input || '').trim();

  if (!value) {
    return false;
  }

  if (/^https?:\/\//i.test(value)) {
    active.view.webContents.loadURL(value);
    return true;
  }

  if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(value)) {
    active.view.webContents.loadURL(`http://${value}`);
    return true;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
    active.view.webContents.loadURL(`https://${value}`);
    return true;
  }

  const searchURL =
    'https://www.google.com/search?q=' + encodeURIComponent(value);

  active.view.webContents.loadURL(searchURL);

  return true;
}

function setBrowserBounds(bounds) {
  if (!bounds) {
    return false;
  }

  const x = Math.max(0, Math.round(Number(bounds.x) || 0));
  const y = Math.max(0, Math.round(Number(bounds.y) || 0));
  const width = Math.max(1, Math.round(Number(bounds.width) || 1));
  const height = Math.max(1, Math.round(Number(bounds.height) || 1));

  browserBounds = { x, y, width, height };

  browserTabs.forEach((t) => t.view.setBounds(browserBounds));

  return true;
}

function historyList() {
  return browserHistory;
}

function historyDelete(visitedAt) {
  browserHistory = browserHistory.filter((h) => h.visitedAt !== visitedAt);
  saveBrowserData();
  return browserHistory;
}

function historyClear() {
  browserHistory = [];
  saveBrowserData();
  return browserHistory;
}

function bookmarkList() {
  return browserBookmarks;
}

function bookmarkAdd(url, title) {
  if (!url) {
    return browserBookmarks;
  }

  const already = browserBookmarks.find((b) => b.url === url);

  if (already) {
    return browserBookmarks;
  }

  browserBookmarks.unshift({
    id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    url,
    title: title || url
  });

  saveBrowserData();

  return browserBookmarks;
}

function bookmarkRemove(id) {
  browserBookmarks = browserBookmarks.filter((b) => b.id !== id);
  saveBrowserData();
  return browserBookmarks;
}

// ==================================
// BROWSER IPC
// ==================================

ipcMain.handle('browser-show', () => {
  return showBrowser();
});

ipcMain.handle('browser-hide', () => {
  return hideBrowser();
});

ipcMain.handle('browser-toggle', () => {
  return toggleBrowser();
});

ipcMain.handle('browser-navigate', (event, input) => {
  return navigateBrowser(input);
});

ipcMain.handle('browser-new-tab', (event, url, incognito) => {
  return newTab(url, incognito);
});

ipcMain.handle('browser-close-tab', (event, id) => {
  return closeTab(id);
});

ipcMain.handle('browser-switch-tab', (event, id) => {
  return switchTab(id);
});

ipcMain.handle('browser-back', () => {
  const active = getActiveTab();

  if (active && active.view.webContents.canGoBack()) {
    active.view.webContents.goBack();
    return true;
  }

  return false;
});

ipcMain.handle('browser-forward', () => {
  const active = getActiveTab();

  if (active && active.view.webContents.canGoForward()) {
    active.view.webContents.goForward();
    return true;
  }

  return false;
});

ipcMain.handle('browser-reload', () => {
  const active = getActiveTab();

  if (!active) {
    return false;
  }

  active.view.webContents.reload();

  return true;
});

ipcMain.handle('browser-stop', () => {
  const active = getActiveTab();

  if (!active) {
    return false;
  }

  active.view.webContents.stop();

  return true;
});

ipcMain.handle('browser-home', () => {
  const active = getActiveTab() || createTab(HOMEPAGE_URL, false);

  if (!active) {
    return false;
  }

  if (!activeTabId) {
    activeTabId = active.id;
  }

  active.view.webContents.loadURL(HOMEPAGE_URL);

  return true;
});

ipcMain.handle('browser-bounds', (event, bounds) => {
  return setBrowserBounds(bounds);
});

ipcMain.handle('browser-get-state', () => {
  const active = getActiveTab();

  return {
    url: active ? active.view.webContents.getURL() : '',
    title: active ? active.view.webContents.getTitle() : '',
    canGoBack: active ? active.view.webContents.canGoBack() : false,
    canGoForward: active ? active.view.webContents.canGoForward() : false,
    loading: active ? active.view.webContents.isLoading() : false,
    visible: browserVisible,
    activeTabId,
    tabs: browserTabs.map((t) => ({
      id: t.id,
      url: t.view.webContents.getURL(),
      title: t.view.webContents.getTitle(),
      loading: t.view.webContents.isLoading(),
      incognito: t.incognito
    }))
  };
});

ipcMain.handle('browser-history-list', () => historyList());
ipcMain.handle('browser-history-delete', (event, visitedAt) => historyDelete(visitedAt));
ipcMain.handle('browser-history-clear', () => historyClear());

ipcMain.handle('browser-bookmark-list', () => bookmarkList());
ipcMain.handle('browser-bookmark-add', (event, url, title) => bookmarkAdd(url, title));
ipcMain.handle('browser-bookmark-remove', (event, id) => bookmarkRemove(id));

// ==================================
// POWERGUARD EXTENSION
// ==================================

ipcMain.handle('browser-extension-status', () => {
  return {
    loaded: !!loadedExtension,
    id: loadedExtension ? loadedExtension.id : null,
    name: loadedExtension ? loadedExtension.name : null,
    version: loadedExtension ? loadedExtension.version : null
  };
});

// Ambil preferensi on/off yang tersimpan + status aktual sekarang.
// "enabled" itu pilihan usernya, "loaded" itu kondisi nyatanya di session
// (biar UI bisa ngebedain "off karena user matiin" vs "harusnya on tapi gagal load").
ipcMain.handle('browser-extension-enabled-get', () => {
  const state = loadPowerGuardState();
  return {
    enabled: state.enabled,
    loaded: !!loadedExtension,
    id: loadedExtension ? loadedExtension.id : null,
    name: loadedExtension ? loadedExtension.name : null,
    version: loadedExtension ? loadedExtension.version : null
  };
});

// Toggle PowerGuard nyala/mati. `enable` true/false dari switch di UI.
ipcMain.handle('browser-extension-enabled-set', async (event, enable) => {
  return await setPowerGuardEnabled(!!enable);
});

let extensionPopupWin = null;

ipcMain.handle('browser-extension-popup', (event, anchorBounds) => {
  if (!loadedExtension) return { ok: false, reason: 'Extension belum kemuat' };

  if (extensionPopupWin && !extensionPopupWin.isDestroyed()) {
    extensionPopupWin.close();
    extensionPopupWin = null;
    return { ok: true, closed: true };
  }

  const parentWin = BrowserWindow.fromWebContents(event.sender) || win;
  const parentBounds = parentWin ? parentWin.getBounds() : { x: 100, y: 100 };

  const x = Math.round(
    parentBounds.x + (anchorBounds && anchorBounds.x ? anchorBounds.x : 100)
  );
  const y = Math.round(
    parentBounds.y + (anchorBounds && anchorBounds.y ? anchorBounds.y : 100)
  );

  extensionPopupWin = new BrowserWindow({
    width: 380,
    height: 560,
    x,
    y,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    parent: parentWin || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  extensionPopupWin.loadURL(
    `chrome-extension://${loadedExtension.id}/popup.html`
  );

  extensionPopupWin.once('ready-to-show', () => {
    extensionPopupWin.show();
  });

  extensionPopupWin.on('blur', () => {
    if (extensionPopupWin && !extensionPopupWin.isDestroyed()) {
      extensionPopupWin.close();
    }
  });

  extensionPopupWin.on('closed', () => {
    extensionPopupWin = null;
  });

  return { ok: true, closed: false };
});

// ==================================
// WIFI — WINDOWS & MACOS
// ==================================

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// ==================================
// PERFORMANCE MODE
// ==================================

const WIN_POWER_PLAN_HIGH = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const WIN_POWER_PLAN_BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';

let performanceModeOn = false;

async function setPerformanceMode(enable) {
  const steps = [];

  try {
    const prio = enable
      ? os.constants.priority.PRIORITY_HIGH
      : os.constants.priority.PRIORITY_NORMAL;
    os.setPriority(process.pid, prio);
    steps.push({
      ok: true,
      label: enable ? 'Prioritas proses OS.js dinaikin ke HIGH' : 'Prioritas proses balik ke NORMAL'
    });
  } catch (error) {
    steps.push({ ok: false, label: 'Gagal ubah prioritas proses: ' + error.message });
  }

  if (IS_WIN) {
    const r = await runCmd('powercfg', ['/setactive', enable ? WIN_POWER_PLAN_HIGH : WIN_POWER_PLAN_BALANCED]);
    steps.push({
      ok: r.success,
      label: r.success
        ? `Power plan Windows → ${enable ? 'High performance' : 'Balanced'}`
        : 'Gak bisa ganti power plan Windows (mungkin butuh admin)'
    });
  } else if (IS_LINUX) {
    const r = await runCmd('cpupower', ['frequency-set', '-g', enable ? 'performance' : 'ondemand']);
    steps.push({
      ok: r.success,
      label: r.success
        ? `CPU governor Linux → ${enable ? 'performance' : 'ondemand'}`
        : 'Gak bisa ubah CPU governor (butuh paket cpupower + akses root)'
    });
  } else if (IS_MAC) {
    steps.push({
      ok: false,
      label: 'macOS gak ngasih akses power plan ke app pihak ketiga — bagian ini di-skip'
    });
  }

  performanceModeOn = enable;
  return { enabled: performanceModeOn, steps };
}

ipcMain.handle('perf-get-status', () => ({ enabled: performanceModeOn }));

ipcMain.handle('perf-set-mode', async (event, enable) => {
  return setPerformanceMode(!!enable);
});

function runNetsh(args) {
  return new Promise((resolve) => {
    execFile(
      'netsh',
      args,
      { windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout || '',
          stderr: stderr || '',
          error: error ? error.message : null
        });
      }
    );
  });
}

function runCmd(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', ...(opts || {}) },
      (error, stdout, stderr) => {
        resolve({
          success: !error,
          stdout: stdout || '',
          stderr: stderr || '',
          error: error ? error.message : null
        });
      }
    );
  });
}

// ==================================
// REAL BATTERY & POWER MONITOR
// ==================================

let cachedBatterySupported = null;

async function getBatteryPercent() {
  try {
    if (IS_WIN) {
      const r = await runCmd('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 -ExpandProperty EstimatedChargeRemaining)'
      ], { windowsHide: true });
      if (r.success) {
        const n = parseInt(r.stdout.trim(), 10);
        if (!isNaN(n)) return n;
      }
      return null;
    }
    if (IS_MAC) {
      const r = await runCmd('pmset', ['-g', 'batt']);
      if (r.success) {
        const m = r.stdout.match(/(\d{1,3})%/);
        if (m) return parseInt(m[1], 10);
      }
      return null;
    }
    if (IS_LINUX) {
      for (const bat of ['BAT0', 'BAT1']) {
        try {
          const cap = fs.readFileSync(`/sys/class/power_supply/${bat}/capacity`, 'utf8').trim();
          const n = parseInt(cap, 10);
          if (!isNaN(n)) return n;
        } catch (error) {}
      }
      return null;
    }
  } catch (error) {
    return null;
  }
  return null;
}

async function getBatteryStatus() {
  const onBatteryPower = powerMonitor.isOnBatteryPower ? powerMonitor.isOnBatteryPower() : false;
  const percent = await getBatteryPercent();

  if (cachedBatterySupported === null) {
    cachedBatterySupported = percent !== null;
  }

  return {
    supported: percent !== null,
    percent: percent,
    charging: !onBatteryPower,
    onBattery: onBatteryPower,
    source: 'electron-native'
  };
}

function broadcastPowerState() {
  if (!win || win.isDestroyed()) return;
  getBatteryStatus().then((status) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('power-state', status);
    }
  });
}

let batteryPollInterval = null;

function startBatteryPolling() {
  if (batteryPollInterval) return;
  batteryPollInterval = setInterval(broadcastPowerState, 60000);
}

function stopBatteryPolling() {
  if (batteryPollInterval) {
    clearInterval(batteryPollInterval);
    batteryPollInterval = null;
  }
}

powerMonitor.on('on-ac', broadcastPowerState);
powerMonitor.on('on-battery', broadcastPowerState);
powerMonitor.on('suspend', () => {
  if (win && !win.isDestroyed()) win.webContents.send('power-suspend');
});
powerMonitor.on('resume', () => {
  broadcastPowerState();
  if (win && !win.isDestroyed()) win.webContents.send('power-resume');
});

ipcMain.handle('power-get-status', () => getBatteryStatus());

// ==================================
// BATTERY HEALTH (design capacity vs full-charge capacity, cycle count)
// ==================================

function computeHealthPercent(designCapacity, fullChargeCapacity) {
  if (!designCapacity || !fullChargeCapacity || designCapacity <= 0) return null;
  const pct = (fullChargeCapacity / designCapacity) * 100;
  // Clamp: some drivers/reports occasionally give fullCharge slightly > design
  // right after calibration, which isn't meaningful as "over 100% health".
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

async function getBatteryHealthWindows() {
  // Coba baca via WMI dulu (lebih cepat & gak perlu tulis file sementara).
  // BatteryStaticData.DesignedCapacity ada di root\WMI, sedangkan
  // FullChargedCapacity ada di Win32_Battery (root\cimv2) tapi field ini
  // tidak selalu terisi tergantung vendor, jadi kita coba beberapa sumber
  // sebelum fallback ke powercfg /batteryreport.
  try {
    const r = await runCmd('powershell', [
      '-NoProfile',
      '-Command',
      "$ErrorActionPreference='SilentlyContinue'; " +
      "$static = Get-CimInstance -Namespace root\\WMI -ClassName BatteryStaticData | Select-Object -First 1; " +
      "$full = Get-CimInstance -Namespace root\\WMI -ClassName BatteryFullChargedCapacity | Select-Object -First 1; " +
      "$cycle = Get-CimInstance -Namespace root\\WMI -ClassName BatteryCycleCount | Select-Object -First 1; " +
      "[PSCustomObject]@{ DesignCapacity = $static.DesignedCapacity; FullChargeCapacity = $full.FullChargedCapacity; CycleCount = $cycle.CycleCount } | ConvertTo-Json -Compress"
    ], { windowsHide: true });

    if (r.success && r.stdout.trim()) {
      let data;
      try { data = JSON.parse(r.stdout.trim()); } catch (e) { data = null; }
      if (data && data.DesignCapacity && data.FullChargeCapacity) {
        return {
          supported: true,
          designCapacity: data.DesignCapacity,
          fullChargeCapacity: data.FullChargeCapacity,
          healthPercent: computeHealthPercent(data.DesignCapacity, data.FullChargeCapacity),
          cycleCount: typeof data.CycleCount === 'number' ? data.CycleCount : null,
          source: 'wmi'
        };
      }
    }
  } catch (error) {}

  // Fallback: generate powercfg battery report as XML and parse it.
  try {
    const reportPath = path.join(os.tmpdir(), `battery-report-${Date.now()}.xml`);
    const r = await runCmd('powercfg', ['/batteryreport', '/output', reportPath, '/xml'], { windowsHide: true });
    if (r.success && fs.existsSync(reportPath)) {
      const xml = fs.readFileSync(reportPath, 'utf8');
      try { fs.unlinkSync(reportPath); } catch (e) {}

      const designMatch = xml.match(/<DesignCapacity>(\d+)<\/DesignCapacity>/i);
      const fullMatch = xml.match(/<FullChargeCapacity>(\d+)<\/FullChargeCapacity>/i);
      const cycleMatch = xml.match(/<CycleCount>(\d+)<\/CycleCount>/i);

      if (designMatch && fullMatch) {
        const designCapacity = parseInt(designMatch[1], 10);
        const fullChargeCapacity = parseInt(fullMatch[1], 10);
        return {
          supported: true,
          designCapacity,
          fullChargeCapacity,
          healthPercent: computeHealthPercent(designCapacity, fullChargeCapacity),
          cycleCount: cycleMatch ? parseInt(cycleMatch[1], 10) : null,
          source: 'powercfg'
        };
      }
    }
  } catch (error) {}

  return { supported: false, designCapacity: null, fullChargeCapacity: null, healthPercent: null, cycleCount: null };
}

async function getBatteryHealthMac() {
  try {
    const r = await runCmd('system_profiler', ['SPPowerDataType', '-json']);
    if (r.success && r.stdout.trim()) {
      let data;
      try { data = JSON.parse(r.stdout); } catch (e) { data = null; }
      const powerInfo = data && data.SPPowerDataType && data.SPPowerDataType[0];
      const battInfo = powerInfo && (powerInfo.sppower_battery_health_info || powerInfo);
      if (battInfo) {
        const cycleCount = battInfo.sppower_battery_cycle_count ?? null;
        const maxCapacityRaw = battInfo.sppower_battery_health_maximum_capacity; // e.g. "87%"
        let healthPercent = null;
        if (typeof maxCapacityRaw === 'string') {
          const m = maxCapacityRaw.match(/(\d+)/);
          if (m) healthPercent = parseInt(m[1], 10);
        } else if (typeof maxCapacityRaw === 'number') {
          healthPercent = maxCapacityRaw;
        }
        return {
          supported: healthPercent !== null,
          designCapacity: null,
          fullChargeCapacity: null,
          healthPercent: healthPercent,
          cycleCount: typeof cycleCount === 'number' ? cycleCount : null,
          condition: battInfo.sppower_battery_health || null,
          source: 'system_profiler'
        };
      }
    }
  } catch (error) {}

  // Fallback: parse plain-text output if -json isn't available/parseable.
  try {
    const r = await runCmd('system_profiler', ['SPPowerDataType']);
    if (r.success) {
      const cycleMatch = r.stdout.match(/Cycle Count:\s*(\d+)/i);
      const conditionMatch = r.stdout.match(/Condition:\s*(.+)/i);
      const maxCapMatch = r.stdout.match(/Maximum Capacity:\s*(\d+)%/i);
      if (maxCapMatch) {
        return {
          supported: true,
          designCapacity: null,
          fullChargeCapacity: null,
          healthPercent: parseInt(maxCapMatch[1], 10),
          cycleCount: cycleMatch ? parseInt(cycleMatch[1], 10) : null,
          condition: conditionMatch ? conditionMatch[1].trim() : null,
          source: 'system_profiler-text'
        };
      }
    }
  } catch (error) {}

  return { supported: false, designCapacity: null, fullChargeCapacity: null, healthPercent: null, cycleCount: null };
}

async function getBatteryHealthLinux() {
  for (const bat of ['BAT0', 'BAT1']) {
    try {
      const base = `/sys/class/power_supply/${bat}`;
      if (!fs.existsSync(base)) continue;

      const readNum = (file) => {
        try {
          const v = fs.readFileSync(`${base}/${file}`, 'utf8').trim();
          const n = parseInt(v, 10);
          return isNaN(n) ? null : n;
        } catch (e) { return null; }
      };

      // Sebagian driver expose charge_full/charge_full_design (dalam µAh),
      // sebagian lain (terutama laptop dengan baterai yang dilaporkan dalam
      // satuan energi) expose energy_full/energy_full_design (dalam µWh).
      // Keduanya proporsional buat hitung persentase wear, jadi kita coba
      // charge_* dulu baru fallback ke energy_*.
      let designCapacity = readNum('charge_full_design');
      let fullChargeCapacity = readNum('charge_full');
      if (designCapacity === null || fullChargeCapacity === null) {
        designCapacity = readNum('energy_full_design');
        fullChargeCapacity = readNum('energy_full');
      }
      const cycleCount = readNum('cycle_count');

      if (designCapacity !== null && fullChargeCapacity !== null) {
        return {
          supported: true,
          designCapacity,
          fullChargeCapacity,
          healthPercent: computeHealthPercent(designCapacity, fullChargeCapacity),
          cycleCount: cycleCount,
          source: 'sysfs'
        };
      }
    } catch (error) {}
  }
  return { supported: false, designCapacity: null, fullChargeCapacity: null, healthPercent: null, cycleCount: null };
}

async function getBatteryHealth() {
  try {
    if (IS_WIN) return await getBatteryHealthWindows();
    if (IS_MAC) return await getBatteryHealthMac();
    if (IS_LINUX) return await getBatteryHealthLinux();
  } catch (error) {}
  return { supported: false, designCapacity: null, fullChargeCapacity: null, healthPercent: null, cycleCount: null };
}

ipcMain.handle('power-get-health', () => getBatteryHealth());

// ==================================
// WIFI FUNCTIONS
// ==================================

let cachedMacWifiDevice = null;

async function getMacWifiDevice() {
  if (cachedMacWifiDevice) return cachedMacWifiDevice;

  const result = await runCmd('networksetup', ['-listallhardwareports']);

  if (result.success) {
    const blocks = result.stdout.split(/\r?\n\r?\n/);

    for (const block of blocks) {
      if (/Hardware Port:\s*Wi-?Fi/i.test(block)) {
        const match = block.match(/Device:\s*(\S+)/i);
        if (match) {
          cachedMacWifiDevice = match[1].trim();
          return cachedMacWifiDevice;
        }
      }
    }
  }

  cachedMacWifiDevice = 'en0';
  return cachedMacWifiDevice;
}

function mapMacSecurity(securityText) {
  const s = (securityText || '').toLowerCase();

  if (!s || s.includes('none') || s.includes('open')) {
    return 'Open';
  }
  if (s.includes('wpa3')) return 'WPA3 Personal';
  if (s.includes('wpa2') && s.includes('enterprise')) return 'WPA2 Enterprise';
  if (s.includes('wpa2')) return 'WPA2 Personal';
  if (s.includes('wpa')) return 'WPA Personal';
  if (s.includes('wep')) return 'WEP';

  return 'Unknown';
}

function mapSecurity(authentication) {
  const a = (authentication || '').toLowerCase();

  if (a.includes('open')) {
    return { authType: 'open', needsPassword: false, label: 'Open' };
  }
  if (a.includes('wpa3')) {
    return { authType: 'WPA3SSE', needsPassword: true, label: 'WPA3' };
  }
  if (a.includes('wpa2')) {
    return { authType: 'WPA2PSK', needsPassword: true, label: 'WPA2' };
  }
  if (a.includes('wpa')) {
    return { authType: 'WPAPSK', needsPassword: true, label: 'WPA' };
  }
  if (a.includes('wep')) {
    return { authType: 'WEP', needsPassword: true, label: 'WEP' };
  }

  return { authType: 'WPA2PSK', needsPassword: true, label: 'Unknown' };
}

function buildProfileXml(ssid, password, authType) {
  const escapedSsid = ssid.replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[c]);

  const hexSsid = Buffer.from(ssid, 'utf8').toString('hex').toUpperCase();

  let authBlock;

  if (authType === 'open') {
    authBlock = `
            <authEncryption>
                <authentication>open</authentication>
                <encryption>none</encryption>
                <useOneX>false</useOneX>
            </authEncryption>`;
  } else {
    const authentication =
      authType === 'WPA3SSE' ? 'WPA3SSE' :
      authType === 'WPAPSK' ? 'WPAPSK' :
      authType === 'WEP' ? 'open' : 'WPA2PSK';

    const encryption = authType === 'WEP' ? 'WEP' : 'AES';

    authBlock = `
            <authEncryption>
                <authentication>${authentication}</authentication>
                <encryption>${encryption}</encryption>
                <useOneX>false</useOneX>
            </authEncryption>
            <sharedKey>
                <keyType>${authType === 'WEP' ? 'networkKey' : 'passPhrase'}</keyType>
                <protected>false</protected>
                <keyMaterial>${password}</keyMaterial>
            </sharedKey>`;
  }

  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>${escapedSsid}</name>
    <SSIDConfig>
        <SSID>
            <hex>${hexSsid}</hex>
            <name>${escapedSsid}</name>
        </SSID>
    </SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>manual</connectionMode>
    <MSM>
        <security>${authBlock}
        </security>
    </MSM>
</WLANProfile>`;
}

async function connectWifi(ssid, password, authType) {
  if (IS_MAC) {
    const device = await getMacWifiDevice();

    const args = password
      ? ['-setairportnetwork', device, ssid, password]
      : ['-setairportnetwork', device, ssid];

    const result = await runCmd('networksetup', args);

    if (!result.success || /could not find network|not associated|failed to join/i.test(result.stdout + result.stderr)) {
      return {
        success: false,
        error: 'Gagal konek: ' + (result.stdout || result.stderr || result.error || 'unknown')
      };
    }

    return { success: true };
  }

  if (!IS_WIN) {
    return { success: false, error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.' };
  }

  const xml = buildProfileXml(ssid, password || '', authType || 'WPA2PSK');
  const tmpFile = path.join(os.tmpdir(), `akhtaros-wifi-${Date.now()}.xml`);

  try {
    fs.writeFileSync(tmpFile, xml, 'utf8');
  } catch (e) {
    return { success: false, error: 'Gagal membuat profile sementara: ' + e.message };
  }

  const addResult = await runNetsh([
    'wlan', 'add', 'profile', `filename=${tmpFile}`, 'user=all'
  ]);

  try { fs.unlinkSync(tmpFile); } catch (e) {}

  if (!addResult.success) {
    return {
      success: false,
      error: 'Gagal menambah profile: ' + (addResult.stderr || addResult.error || 'unknown')
    };
  }

  const connectResult = await runNetsh([
    'wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`
  ]);

  if (!connectResult.success) {
    return {
      success: false,
      error: 'Gagal konek: ' + (connectResult.stderr || connectResult.error || 'unknown')
    };
  }

  return { success: true };
}

async function quickConnectWifi(ssid) {
  if (IS_MAC) {
    return await connectWifi(ssid, null, null);
  }

  if (!IS_WIN) {
    return { success: false, error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.' };
  }

  const connectResult = await runNetsh([
    'wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`
  ]);

  return {
    success: connectResult.success,
    error: connectResult.success ? null : (connectResult.stderr || connectResult.error)
  };
}

async function disconnectWifi() {
  if (IS_MAC) {
    const device = await getMacWifiDevice();
    await runCmd('networksetup', ['-setairportpower', device, 'off']);
    const result = await runCmd('networksetup', ['-setairportpower', device, 'on']);

    return {
      success: result.success,
      error: result.success ? null : (result.stderr || result.error)
    };
  }

  if (!IS_WIN) {
    return { success: false, error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.' };
  }

  const result = await runNetsh(['wlan', 'disconnect']);

  return {
    success: result.success,
    error: result.success ? null : (result.stderr || result.error)
  };
}

async function forgetWifiProfile(ssid) {
  if (IS_MAC) {
    const device = await getMacWifiDevice();
    const result = await runCmd('networksetup', ['-removepreferredwirelessnetwork', device, ssid]);

    return {
      success: result.success,
      error: result.success ? null : (result.stderr || result.error)
    };
  }

  if (!IS_WIN) {
    return { success: false, error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.' };
  }

  const result = await runNetsh(['wlan', 'delete', 'profile', `name=${ssid}`]);

  return {
    success: result.success,
    error: result.success ? null : (result.stderr || result.error)
  };
}

async function getSavedWifiProfiles() {
  if (IS_MAC) {
    const device = await getMacWifiDevice();
    const result = await runCmd('networksetup', ['-listpreferredwirelessnetworks', device]);

    if (!result.success) {
      return { success: false, profiles: [], error: result.stderr || result.error };
    }

    const profiles = result.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);

    return { success: true, profiles };
  }

  if (!IS_WIN) {
    return { success: false, profiles: [], error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.' };
  }

  const result = await runNetsh(['wlan', 'show', 'profiles']);

  if (!result.success) {
    return { success: false, profiles: [], error: result.stderr || result.error };
  }

  const profiles = [];
  const lines = result.stdout.split(/\r?\n/);

  for (const rawLine of lines) {
    const match = rawLine.match(/All User Profile\s*:\s*(.+)$/i);
    if (match) {
      profiles.push(match[1].trim());
    }
  }

  return { success: true, profiles };
}

async function getMacWifiAdapterInfo() {
  const device = await getMacWifiDevice();

  const info = {
    name: device,
    description: null,
    guid: null,
    physicalAddress: null,
    state: null,
    ssid: null,
    bssid: null,
    radioType: null,
    authentication: null,
    cipher: null,
    channel: null,
    receiveRate: null,
    transmitRate: null,
    signal: null,
    profile: null,
    ipv4: null,
    subnetMask: null,
    gateway: null,
    dns: []
  };

  const ssidResult = await runCmd('networksetup', ['-getairportnetwork', device]);
  if (ssidResult.success) {
    const match = ssidResult.stdout.match(/Current Wi-Fi Network:\s*(.+)$/i);
    if (match) {
      info.ssid = match[1].trim();
      info.state = 'Connected';
    } else {
      info.state = 'Disconnected';
    }
  }

  const spResult = await runCmd('system_profiler', ['SPAirPortDataType', '-detailLevel', 'basic'], { maxBuffer: 1024 * 1024 * 10 });
  if (spResult.success && info.ssid) {
    const ssidBlockRegex = new RegExp(
      escapeRegExp(info.ssid) + ':[\\s\\S]*?(?=\\n\\s{0,10}\\S.*:\\n|$)',
      'i'
    );
    const block = spResult.stdout.match(ssidBlockRegex);
    if (block) {
      const text = block[0];
      const chMatch = text.match(/Channel:\s*(.+)$/im);
      const secMatch = text.match(/Security:\s*(.+)$/im);
      const rssiMatch = text.match(/Signal \/ Noise:\s*(-?\d+)/i);
      const phyMatch = text.match(/PHY Mode:\s*(.+)$/im);

      if (chMatch) info.channel = chMatch[1].trim();
      if (secMatch) info.authentication = secMatch[1].trim();
      if (phyMatch) info.radioType = phyMatch[1].trim();
      if (rssiMatch) {
        const dbm = Number(rssiMatch[1]);
        info.signal = Math.max(0, Math.min(100, 2 * (dbm + 100)));
      }
    }
  }

  const macResult = await runCmd('networksetup', ['-getmacaddress', device]);
  if (macResult.success) {
    const match = macResult.stdout.match(/([0-9a-f]{2}(:[0-9a-f]{2}){5})/i);
    if (match) info.physicalAddress = match[1];
  }

  const ipResult = await runCmd('ipconfig', ['getifaddr', device]);
  if (ipResult.success && ipResult.stdout.trim()) {
    info.ipv4 = ipResult.stdout.trim();
  }

  const infoResult = await runCmd('networksetup', ['-getinfo', 'Wi-Fi']);
  if (infoResult.success) {
    const maskMatch = infoResult.stdout.match(/Subnet mask:\s*(.+)$/im);
    const gwMatch = infoResult.stdout.match(/Router:\s*(.+)$/im);
    if (maskMatch) info.subnetMask = maskMatch[1].trim();
    if (gwMatch) info.gateway = gwMatch[1].trim();
  }

  const dnsResult = await runCmd('networksetup', ['-getdnsservers', 'Wi-Fi']);
  if (dnsResult.success && !/aren't any dns servers/i.test(dnsResult.stdout)) {
    info.dns = dnsResult.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  return { success: true, info };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getWifiAdapterInfo() {
  if (IS_MAC) {
    return await getMacWifiAdapterInfo();
  }

  if (!IS_WIN) {
    return { success: false, error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.' };
  }

  const ifaceResult = await runNetsh(['wlan', 'show', 'interfaces']);

  const info = {
    name: null,
    description: null,
    guid: null,
    physicalAddress: null,
    state: null,
    ssid: null,
    bssid: null,
    radioType: null,
    authentication: null,
    cipher: null,
    channel: null,
    receiveRate: null,
    transmitRate: null,
    signal: null,
    profile: null,
    ipv4: null,
    subnetMask: null,
    gateway: null,
    dns: []
  };

  if (ifaceResult.success) {
    const lines = ifaceResult.stdout.split(/\r?\n/);
    const fieldMap = {
      'Name': 'name',
      'Description': 'description',
      'GUID': 'guid',
      'Physical address': 'physicalAddress',
      'State': 'state',
      'SSID': 'ssid',
      'BSSID': 'bssid',
      'Radio type': 'radioType',
      'Authentication': 'authentication',
      'Cipher': 'cipher',
      'Channel': 'channel',
      'Receive rate (Mbps)': 'receiveRate',
      'Transmit rate (Mbps)': 'transmitRate',
      'Signal': 'signal',
      'Profile': 'profile'
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();

      for (const [key, prop] of Object.entries(fieldMap)) {
        const regex = new RegExp('^' + key.replace(/[()]/g, '\\$&') + '\\s*:\\s*(.*)$', 'i');
        const match = line.match(regex);

        if (match && info[prop] === null) {
          info[prop] = match[1].trim();
          break;
        }
      }
    }
  }

  const netIfaces = os.networkInterfaces();

  for (const [ifaceName, addrs] of Object.entries(netIfaces)) {
    if (/wi-?fi|wireless|wlan/i.test(ifaceName)) {
      const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
      if (ipv4) {
        info.ipv4 = ipv4.address;
        info.subnetMask = ipv4.netmask;
      }
      break;
    }
  }

  const ipconfigResult = await new Promise((resolve) => {
    execFile('ipconfig', ['/all'], { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      resolve({ success: !error, stdout: stdout || '' });
    });
  });

  if (ipconfigResult.success) {
    const blocks = ipconfigResult.stdout.split(/\r?\n\r?\n/);
    const wifiBlockIndex = ipconfigResult.stdout.search(/Wireless LAN adapter\s+Wi-?Fi/i);

    if (wifiBlockIndex !== -1) {
      const relevantText = ipconfigResult.stdout.slice(wifiBlockIndex);
      const nextAdapterIndex = relevantText.slice(1).search(/\r?\n\r?\n[A-Za-z].*adapter/i);
      const wifiSection = nextAdapterIndex !== -1
        ? relevantText.slice(0, nextAdapterIndex + 1)
        : relevantText;

      const ipv4Match = wifiSection.match(/IPv4 Address[.\s]*:\s*([\d.]+)/i);
      const maskMatch = wifiSection.match(/Subnet Mask[.\s]*:\s*([\d.]+)/i);
      const gwMatch = wifiSection.match(/Default Gateway[.\s]*:\s*([\d.]+)/i);
      const dnsMatches = [...wifiSection.matchAll(/DNS Servers[.\s]*:\s*([\d.]+)|^\s*([\d.]{7,15})\s*$/gim)];

      if (ipv4Match) info.ipv4 = ipv4Match[1];
      if (maskMatch) info.subnetMask = maskMatch[1];
      if (gwMatch) info.gateway = gwMatch[1];

      if (dnsMatches.length) {
        info.dns = dnsMatches
          .map(m => m[1] || m[2])
          .filter(Boolean);
      }
    }
  }

  return { success: true, info };
}

const MAC_AIRPORT_BIN =
  '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';

async function scanWifiMac() {
  if (fs.existsSync(MAC_AIRPORT_BIN)) {
    const result = await runCmd(MAC_AIRPORT_BIN, ['-s']);

    if (result.success && result.stdout.trim()) {
      const lines = result.stdout.split(/\r?\n/).slice(1);
      const networks = [];

      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;

        const match = rawLine.match(
          /^(.{1,32}?)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(-?\d+)\s+(\S+)\s+\S+\s+\S+\s+(.+)$/i
        );

        if (!match) continue;

        const [, ssid, , rssi, channel, security] = match;
        const dbm = Number(rssi);

        networks.push({
          ssid: ssid.trim(),
          authentication: mapMacSecurity(security),
          encryption: mapMacSecurity(security),
          signal: Math.max(0, Math.min(100, 2 * (dbm + 100))),
          radioType: null,
          bssidCount: 1
        });
      }

      if (networks.length) {
        const withSecurity = networks.map((n) => ({
          ...n,
          security: mapSecurity(n.authentication)
        }));

        return { success: true, networks: withSecurity };
      }
    }
  }

  const spResult = await runCmd('system_profiler', ['SPAirPortDataType', '-detailLevel', 'basic'], { maxBuffer: 1024 * 1024 * 10 });

  if (!spResult.success) {
    return {
      success: false,
      networks: [],
      error: spResult.error || 'Gagal scan Wi-Fi. Pastikan Location Services aktif untuk Terminal/App ini di System Settings.'
    };
  }

  const otherIndex = spResult.stdout.search(/Other Local Wi-Fi Networks:/i);
  const section = otherIndex !== -1 ? spResult.stdout.slice(otherIndex) : spResult.stdout;

  const entryRegex = /^\s{12}(\S.*):\s*$/gm;
  const networks = [];
  let match;
  const matches = [...section.matchAll(entryRegex)];

  for (let i = 0; i < matches.length; i++) {
    const ssid = matches[i][1].trim();
    if (!ssid || /PHY Mode|Channel|Network Type|Security|Signal/i.test(ssid)) continue;

    const blockStart = matches[i].index;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].index : section.length;
    const block = section.slice(blockStart, blockEnd);

    const secMatch = block.match(/Security:\s*(.+)$/im);

    networks.push({
      ssid,
      authentication: mapMacSecurity(secMatch ? secMatch[1] : ''),
      encryption: mapMacSecurity(secMatch ? secMatch[1] : ''),
      signal: null,
      radioType: null,
      bssidCount: 1
    });
  }

  const withSecurity = networks.map((n) => ({
    ...n,
    security: mapSecurity(n.authentication)
  }));

  return { success: true, networks: withSecurity };
}

function scanWifi() {
  return new Promise((resolve) => {
    if (IS_MAC) {
      scanWifiMac().then(resolve);
      return;
    }

    if (!IS_WIN) {
      resolve({
        success: false,
        networks: [],
        error: 'Wi-Fi saat ini hanya didukung di Windows & macOS.'
      });
      return;
    }

    execFile(
      'netsh',
      ['wlan', 'show', 'networks', 'mode=bssid'],
      {
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error('Wi-Fi scan gagal:', error);
          console.error(stderr);

          resolve({
            success: false,
            networks: [],
            error: error.message
          });

          return;
        }

        const networks = [];
        const lines = stdout.split(/\r?\n/);

        let current = null;

        for (const rawLine of lines) {
          const line = rawLine.trim();

          const ssidMatch = line.match(
            /^SSID\s+\d+\s*:\s*(.*)$/i
          );

          if (ssidMatch) {
            if (current && current.ssid) {
              networks.push(current);
            }

            current = {
              ssid: ssidMatch[1].trim(),
              authentication: 'Unknown',
              encryption: 'Unknown',
              signal: null,
              radioType: null,
              bssidCount: 0
            };

            continue;
          }

          if (!current) continue;

          const authMatch = line.match(
            /^Authentication\s*:\s*(.*)$/i
          );

          if (authMatch) {
            current.authentication =
              authMatch[1].trim();
            continue;
          }

          const encryptionMatch = line.match(
            /^Encryption\s*:\s*(.*)$/i
          );

          if (encryptionMatch) {
            current.encryption =
              encryptionMatch[1].trim();
            continue;
          }

          const signalMatch = line.match(
            /^Signal\s*:\s*(\d+)%/i
          );

          if (signalMatch) {
            current.signal =
              Number(signalMatch[1]);
            continue;
          }

          const radioMatch = line.match(
            /^Radio type\s*:\s*(.*)$/i
          );

          if (radioMatch) {
            current.radioType =
              radioMatch[1].trim();
          }
        }

        if (current && current.ssid) {
          networks.push(current);
        }

        const unique = [];

        for (const network of networks) {
          if (
            !unique.some(
              item => item.ssid === network.ssid
            )
          ) {
            unique.push(network);
          }
        }

        unique.sort(
          (a, b) =>
            (b.signal || 0) -
            (a.signal || 0)
        );

        const withSecurity = unique.map((n) => ({
          ...n,
          security: mapSecurity(n.authentication)
        }));

        resolve({
          success: true,
          networks: withSecurity
        });
      }
    );
  });
}

// ==================================
// WIFI IPC
// ==================================

ipcMain.handle('wifi-scan', async () => {
  return await scanWifi();
});

ipcMain.handle('wifi-connect', async (_event, { ssid, password, authType }) => {
  return await connectWifi(ssid, password, authType);
});

ipcMain.handle('wifi-quick-connect', async (_event, ssid) => {
  return await quickConnectWifi(ssid);
});

ipcMain.handle('wifi-disconnect', async () => {
  return await disconnectWifi();
});

ipcMain.handle('wifi-forget', async (_event, ssid) => {
  return await forgetWifiProfile(ssid);
});

ipcMain.handle('wifi-saved-profiles', async () => {
  return await getSavedWifiProfiles();
});

ipcMain.handle('wifi-adapter-info', async () => {
  return await getWifiAdapterInfo();
});

// ==================================
// STAGE 2 — REAL FILE SYSTEM
// ==================================

const ROOT_DIR = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'penyimpanan os')
  : path.join(__dirname, 'penyimpanan os');

// Sekarang ROOT_DIR udah ada, baru aman isi path folder torrent.
TORRENT_DIR = path.join(ROOT_DIR, 'torrents');
TORRENT_DOWNLOAD_DIR = path.join(TORRENT_DIR, 'downloads');
TORRENT_INCOMPLETE_DIR = path.join(TORRENT_DIR, 'incomplete');

const FS_SUBDIRS = [
  'wallpaper biasa',
  'live wallpaper animation',
  'dll',
  'dll/users',
  'dll/system',
  'dll/music',
  'dll/files',
  'dll/files/apps',
  'dll/backups',
  'torrents',
  'torrents/downloads',
  'torrents/incomplete',
  'torrents/metadata'
];

function ensureFsFolders() {
  FS_SUBDIRS.forEach((sub) => {
    const p = path.join(ROOT_DIR, sub);

    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  });
}

// ==================================
// STAGE 4 — POWERGUARD BROWSER EXTENSION
// ==================================

let loadedExtension = null;

function findPowerGuardZip() {
  const candidates = app.isPackaged
    ? [
        path.join(path.dirname(app.getPath('exe')), 'powerguard.zip'),
        path.join(process.resourcesPath, 'powerguard.zip')
      ]
    : [path.join(__dirname, 'powerguard.zip')];

  return candidates.find((p) => fs.existsSync(p)) || null;
}

const POWERGUARD_EXTRACT_DIR = path.join(
  ROOT_DIR,
  'dll/system/powerguard-extension'
);

function extractZipSync(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);

  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) {
    throw new Error('File zip rusak / bukan format zip yang valid (EOCD tidak ketemu)');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset = buf.readUInt32LE(eocdOffset + 16);

  fs.mkdirSync(destDir, { recursive: true });

  for (let i = 0; i < totalEntries; i++) {
    const sig = buf.readUInt32LE(cdOffset);
    if (sig !== 0x02014b50) {
      throw new Error('File zip rusak / bukan format zip yang valid (central directory entry tidak valid)');
    }

    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(cdOffset + 42);

    const nameStart = cdOffset + 46;
    const rawName = buf.toString('utf8', nameStart, nameStart + nameLen);

    const safeName = rawName.replace(/\\/g, '/');
    if (safeName.includes('../') || path.isAbsolute(safeName)) {
      cdOffset = nameStart + nameLen + extraLen + commentLen;
      continue;
    }

    const destPath = path.join(destDir, safeName);
    const isDir = safeName.endsWith('/');

    if (isDir) {
      fs.mkdirSync(destPath, { recursive: true });
    } else {
      const lfNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lfExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
      const compData = buf.subarray(dataStart, dataStart + compSize);

      let outData;
      if (method === 0) {
        outData = compData;
      } else if (method === 8) {
        outData = zlib.inflateRawSync(compData);
      } else {
        cdOffset = nameStart + nameLen + extraLen + commentLen;
        continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, outData);
    }

    cdOffset = nameStart + nameLen + extraLen + commentLen;
  }
}

// ==================================
// POWERGUARD — TOGGLE ON/OFF STATE
// ==================================
// State on/off disimpan terpisah dari data extension-nya sendiri, biar
// pilihan user (nyala/mati) keinget terus walau OS di-restart.

const POWERGUARD_STATE_PATH = path.join(
  ROOT_DIR,
  'dll/system/powerguard-state.json'
);

function loadPowerGuardState() {
  try {
    const raw = fs.readFileSync(POWERGUARD_STATE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Default nyala kalau belum pernah di-set sama sekali
    return { enabled: data.enabled !== false };
  } catch (error) {
    return { enabled: true };
  }
}

function savePowerGuardState(enabled) {
  try {
    fs.mkdirSync(path.dirname(POWERGUARD_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      POWERGUARD_STATE_PATH,
      JSON.stringify({ enabled: !!enabled }),
      'utf-8'
    );
  } catch (error) {
    console.error('[PowerGuard] Gagal nyimpen state on/off:', error.message);
  }
}

// Ekstrak powerguard.zip ke disk kalau perlu (belum pernah / zip-nya lebih baru).
// Dipisah dari proses load ke session, biar toggle on/off gak perlu extract ulang.
async function extractPowerGuardIfNeeded() {
  const zipPath = findPowerGuardZip();
  if (!zipPath) {
    console.log('[PowerGuard] powerguard.zip gak ketemu, skip loading extension.');
    return false;
  }

  const manifestPath = path.join(POWERGUARD_EXTRACT_DIR, 'manifest.json');
  const needsExtract =
    !fs.existsSync(manifestPath) ||
    fs.statSync(zipPath).mtimeMs > fs.statSync(manifestPath).mtimeMs;

  if (needsExtract) {
    console.log('[PowerGuard] Extracting powerguard.zip...');
    fs.rmSync(POWERGUARD_EXTRACT_DIR, { recursive: true, force: true });
    extractZipSync(zipPath, POWERGUARD_EXTRACT_DIR);
  }

  return fs.existsSync(manifestPath);
}

async function loadPowerGuardExtension() {
  try {
    const extracted = await extractPowerGuardIfNeeded();
    if (!extracted) {
      loadedExtension = null;
      return;
    }

    const ext = await session.defaultSession.loadExtension(
      POWERGUARD_EXTRACT_DIR,
      { allowFileAccess: true }
    );

    loadedExtension = {
      id: ext.id,
      name: ext.manifest && ext.manifest.name,
      version: ext.manifest && ext.manifest.version
    };
    console.log('[PowerGuard] Loaded:', loadedExtension.name, loadedExtension.version, ext.id);
  } catch (err) {
    console.error('[PowerGuard] Gagal load extension:', err);
    loadedExtension = null;
  }
}

// Copot extension dari session — ini yang bikin toggle "off" beneran ngefek,
// bukan cuma nyembunyiin ikon doang. Begitu di-remove, PowerGuard berhenti
// jalan total di semua tab (browser bawaan Akhtar OS pakai defaultSession).
async function unloadPowerGuardExtension() {
  try {
    if (loadedExtension) {
      session.defaultSession.removeExtension(loadedExtension.id);
      console.log('[PowerGuard] Extension di-unload:', loadedExtension.id);
    }
  } catch (err) {
    console.error('[PowerGuard] Gagal unload extension:', err);
  } finally {
    loadedExtension = null;
    // Kalau popup PowerGuard lagi kebuka pas dimatiin, tutup juga biar gak nyangkut
    if (extensionPopupWin && !extensionPopupWin.isDestroyed()) {
      extensionPopupWin.close();
      extensionPopupWin = null;
    }
  }
}

// Fungsi utama buat toggle on/off dari UI. Nyimpen state dulu baru eksekusi,
// biar kalau proses load/unload gagal di tengah jalan, preferensi user tetap
// yang paling baru (gak nyangkut di state lama).
async function setPowerGuardEnabled(enable) {
  savePowerGuardState(enable);

  if (enable) {
    if (!loadedExtension) {
      await loadPowerGuardExtension();
    }
  } else if (loadedExtension) {
    await unloadPowerGuardExtension();
  }

  return {
    enabled: !!enable,
    loaded: !!loadedExtension,
    id: loadedExtension ? loadedExtension.id : null,
    name: loadedExtension ? loadedExtension.name : null,
    version: loadedExtension ? loadedExtension.version : null
  };
}

function migrateOldAppDataStorage() {
  try {
    if (fs.existsSync(ROOT_DIR)) return;

    const oldRoot = path.join(app.getPath('appData'), 'akhtar-os');
    if (!fs.existsSync(oldRoot)) return;

    fs.mkdirSync(ROOT_DIR, { recursive: true });

    const moveIfExists = (fromRel, toRel) => {
      const from = path.join(oldRoot, fromRel);
      const to = path.join(ROOT_DIR, toRel);
      if (!fs.existsSync(from)) return;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    };

    moveIfExists('wallpapers', 'wallpaper biasa');
    moveIfExists('users', 'dll/users');
    moveIfExists('system', 'dll/system');
    moveIfExists('music', 'dll/music');
    moveIfExists('files', 'dll/files');
    moveIfExists('backups', 'dll/backups');
    moveIfExists('dns-shield-state.json', 'dll/system/dns-shield-state.json');

    console.log('[Akhtar OS] Data lama dari AppData berhasil dipindah ke folder "penyimpanan os".');
  } catch (e) {
    console.error('[Akhtar OS] Gagal migrasi data lama:', e.message);
  }
}

function safeResolve(relPath) {
  const clean = String(relPath || '/')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');

  const resolved = path.normalize(
    path.join(ROOT_DIR, clean)
  );

  const rootNormalized = path.normalize(ROOT_DIR);

  if (
    resolved !== rootNormalized &&
    !resolved.startsWith(rootNormalized + path.sep)
  ) {
    throw new Error('Akses di luar folder Akhtar OS ditolak.');
  }

  return resolved;
}

ipcMain.handle('fs-get-root', () => ROOT_DIR);

ipcMain.handle('fs-open-root', () => {
  try {
    shell.openPath(ROOT_DIR);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('fs-list', (event, relPath) => {
  try {
    const dirPath = safeResolve(relPath || '/');

    if (!fs.existsSync(dirPath)) {
      return [];
    }

    return fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
      const full = path.join(dirPath, entry.name);
      const stat = fs.statSync(full);

      return {
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'file',
        size: stat.size,
        mtime: stat.mtimeMs
      };
    });
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('fs-read-file', (event, relPath) => {
  try {
    return fs.readFileSync(safeResolve(relPath), 'utf8');
  } catch (error) {
    return null;
  }
});

ipcMain.handle('fs-write-file', (event, relPath, content) => {
  try {
    const p = safeResolve(relPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content ?? '', 'utf8');
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('fs-read-binary', (event, relPath) => {
  try {
    return fs.readFileSync(safeResolve(relPath)).toString('base64');
  } catch (error) {
    return null;
  }
});

ipcMain.handle('fs-write-binary', (event, relPath, base64Data) => {
  try {
    const p = safeResolve(relPath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(base64Data || '', 'base64'));
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('fs-mkdir', (event, relPath) => {
  try {
    fs.mkdirSync(safeResolve(relPath), { recursive: true });
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('fs-delete', (event, relPath) => {
  try {
    fs.rmSync(safeResolve(relPath), { recursive: true, force: true });
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('fs-rename', (event, oldRel, newRel) => {
  try {
    fs.renameSync(safeResolve(oldRel), safeResolve(newRel));
    return true;
  } catch (error) {
    return false;
  }
});

ipcMain.handle('fs-exists', (event, relPath) => {
  try {
    return fs.existsSync(safeResolve(relPath));
  } catch (error) {
    return false;
  }
});

ipcMain.handle('fs-stat', (event, relPath) => {
  try {
    const stat = fs.statSync(safeResolve(relPath));

    return {
      size: stat.size,
      mtime: stat.mtimeMs,
      isDirectory: stat.isDirectory()
    };
  } catch (error) {
    return null;
  }
});

ipcMain.handle('fs-migrate', (event, tree) => {
  try {
    function walk(node, relPath) {
      if (!node || !node.children) {
        return;
      }

      Object.keys(node.children).forEach((name) => {
        const child = node.children[name];
        const childRel = relPath === '/' ? '/' + name : relPath + '/' + name;

        if (child.type === 'folder') {
          fs.mkdirSync(
            safeResolve(path.posix.join('files', childRel)),
            { recursive: true }
          );
          walk(child, childRel);
        } else if (child.type === 'file') {
          const target = safeResolve(path.posix.join('files', childRel));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, child.content || '', 'utf8');
        }
      });
    }

    fs.mkdirSync(safeResolve('files'), { recursive: true });

    if (tree && tree['/']) {
      walk(tree['/'], '/');
    }

    return true;
  } catch (error) {
    return { error: error.message };
  }
});

// ==================================
// STAGE 3 — EXE RUNNER
// ==================================

let runningProcesses = {};
let exeCounter = 0;

ipcMain.handle('exe-upload', async () => {
  if (!win || win.isDestroyed()) {
    return null;
  }

  const dialogOptions = IS_MAC
    ? {
        title: 'Pilih aplikasi',
        properties: ['openFile'],
        filters: [
          { name: 'Aplikasi macOS', extensions: ['app', 'command', 'sh'] },
          { name: 'Semua File', extensions: ['*'] }
        ]
      }
    : {
        title: 'Pilih file EXE',
        properties: ['openFile'],
        filters: [
          { name: 'Executable', extensions: ['exe'] },
          { name: 'Semua File', extensions: ['*'] }
        ]
      };

  const result = await dialog.showOpenDialog(win, dialogOptions);

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const srcPath = result.filePaths[0];
  const fileName = path.basename(srcPath);
  const destDir = path.join(ROOT_DIR, 'dll', 'files', 'apps');

  fs.mkdirSync(destDir, { recursive: true });

  const destPath = path.join(destDir, fileName);
  const srcStat = fs.statSync(srcPath);

  if (srcStat.isDirectory()) {
    fs.cpSync(srcPath, destPath, { recursive: true });
    return { name: fileName, size: 0 };
  }

  fs.copyFileSync(srcPath, destPath);

  if (!IS_WIN) {
    try {
      fs.chmodSync(destPath, srcStat.mode | 0o111);
    } catch (e) {}
  }

  return { name: fileName, size: fs.statSync(destPath).size };
});

function isRunnableAppFile(dir, fileName) {
  const lower = fileName.toLowerCase();

  if (IS_WIN) {
    return lower.endsWith('.exe');
  }

  if (IS_MAC) {
    if (lower.endsWith('.app') || lower.endsWith('.command') || lower.endsWith('.sh')) {
      return true;
    }

    try {
      const full = path.join(dir, fileName);
      const stat = fs.statSync(full);
      if (stat.isFile() && (stat.mode & 0o111)) {
        return true;
      }
    } catch (e) {}

    return false;
  }

  return false;
}

// Nama-nama .exe "peluncur utama" yang biasa dicari kalau app-nya nested
// di dalam beberapa lapis subfolder (kayak Tor Browser: apps/Browser/Browser/firefox.exe,
// atau .../Tor Browser/Browser/firefox.exe tergantung versi installer).
const PRIORITY_LAUNCHER_NAMES = [
  'tor browser.exe',
  'firefox.exe',
  'start tor browser.exe'
];

// Scan rekursif ke dalam folder apps (sampai kedalaman terbatas), biar app yang
// di-extract sebagai folder (kayak Tor Browser Bundle) tetep kedetect walau
// .exe utamanya nyempil beberapa folder di dalam.
function scanAppsRecursive(baseDir, currentDir, depth, results) {
  if (depth > 6) return; // guard biar gak muter kebablasan di folder yang aneh-aneh

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    const relName = path.relative(baseDir, full);

    if (entry.isDirectory()) {
      // folder di level teratas apps/ juga tetep dianggap "1 entri app" kalau
      // dia sendiri gak punya exe langsung tapi anak-anaknya punya (ditangani di bawah)
      scanAppsRecursive(baseDir, full, depth + 1, results);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!isRunnableAppFile(currentDir, entry.name)) continue;

    let stat;
    try { stat = fs.statSync(full); } catch (e) { continue; }

    const lowerName = entry.name.toLowerCase();
    const isPriority = PRIORITY_LAUNCHER_NAMES.includes(lowerName);
    const isTor = relName.toLowerCase().includes('tor');

    results.push({
      // name = path relatif dari apps/, dipakai sebagai identifier unik pas nge-run
      name: relName.split(path.sep).join('/'),
      // label = nama yang enak dibaca di UI
      label: isTor ? 'Tor Browser' : entry.name,
      size: stat.size,
      depth,
      isPriority,
      isTor
    });
  }
}

ipcMain.handle('exe-list', () => {
  const dir = path.join(ROOT_DIR, 'dll', 'files', 'apps');

  if (!fs.existsSync(dir)) {
    return [];
  }

  const results = [];
  scanAppsRecursive(dir, dir, 0, results);

  // Kalau ada beberapa .exe dalam satu folder app yang sama (misal Tor Browser
  // punya "Tor Browser.exe" DAN beberapa helper .exe lain di folder yang sama),
  // kita cuma mau nampilin satu entry yang paling masuk akal buat di-klik user:
  // prioritaskan nama peluncur resmi (Tor Browser.exe / firefox.exe) per folder.
  const byFolder = new Map();
  for (const r of results) {
    const folderKey = path.dirname(r.name);
    const existing = byFolder.get(folderKey);
    if (!existing) {
      byFolder.set(folderKey, r);
      continue;
    }
    if (r.isPriority && !existing.isPriority) {
      byFolder.set(folderKey, r);
    }
  }

  return Array.from(byFolder.values())
    .sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label))
    .map((r) => ({ name: r.name, label: r.label, size: r.size, isTor: r.isTor }));
});

ipcMain.handle('exe-run', (event, fileName) => {
  if (!IS_WIN && !IS_MAC) {
    return { error: 'Menjalankan app cuma didukung di Windows & macOS.' };
  }

  // fileName sekarang bisa berupa path relatif (misal "Browser/Browser/firefox.exe"),
  // jadi kita normalize slash & tetep jaga biar gak bisa keluar dari folder apps (path traversal guard).
  const rawName = String(fileName || '').replace(/\\/g, '/');
  const appsDir = path.join(ROOT_DIR, 'dll', 'files', 'apps');
  const filePath = path.resolve(appsDir, rawName);

  if (!filePath.startsWith(path.resolve(appsDir) + path.sep) && filePath !== path.resolve(appsDir)) {
    return { error: 'Path tidak valid.' };
  }

  if (!fs.existsSync(filePath)) {
    return { error: 'File tidak ditemukan.' };
  }

  const safeName = path.basename(filePath);

  if (IS_MAC && safeName.toLowerCase().endsWith('.exe')) {
    return { error: 'File .exe adalah binari Windows dan gak bisa dijalankan native di macOS (butuh Wine).' };
  }

  const id = 'exe_' + (++exeCounter);

  let child;

  try {
    if (IS_MAC && safeName.toLowerCase().endsWith('.app')) {
      child = spawn('open', ['-W', filePath], { cwd: path.dirname(filePath) });
    } else if (IS_MAC && (safeName.toLowerCase().endsWith('.command') || safeName.toLowerCase().endsWith('.sh'))) {
      child = spawn('/bin/bash', [filePath], { cwd: path.dirname(filePath) });
    } else {
      // Tor Browser WAJIB dijalankan dengan cwd = folder dia sendiri, karena dia
      // nyari profile & komponen Tor relatif terhadap lokasi exe-nya sendiri.
      // Kalau cwd salah, biasanya muncul error "gagal memulai Tor" pas dibuka.
      child = spawn(filePath, [], { cwd: path.dirname(filePath) });
    }
  } catch (error) {
    return { error: error.message };
  }

  runningProcesses[id] = { child, name: safeName, pid: child.pid };

  child.stdout.on('data', (data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('exe-output', {
        id,
        stream: 'stdout',
        data: data.toString()
      });
    }
  });

  child.stderr.on('data', (data) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('exe-output', {
        id,
        stream: 'stderr',
        data: data.toString()
      });
    }
  });

  child.on('exit', (code) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('exe-exit', { id, code });
    }

    delete runningProcesses[id];
  });

  child.on('error', (error) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('exe-output', {
        id,
        stream: 'stderr',
        data: 'ERROR: ' + error.message
      });
    }

    delete runningProcesses[id];
  });

  return { id, pid: child.pid, name: safeName };
});

ipcMain.handle('exe-stop', (event, id) => {
  const proc = runningProcesses[id];

  if (!proc) {
    return false;
  }

  try {
    proc.child.kill();
  } catch (error) {}

  delete runningProcesses[id];

  return true;
});

ipcMain.handle('exe-running', () => {
  return Object.keys(runningProcesses).map((id) => ({
    id,
    name: runningProcesses[id].name,
    pid: runningProcesses[id].pid
  }));
});

// ==================================
// TORRENT IPC HANDLERS
// ==================================

ipcMain.handle('torrent-add', async (event, source) => {
  try {
    const client = await getTorrentClient();

    // File .torrent yang diupload dari renderer datang sebagai Uint8Array
    // biasa (renderer gak punya akses ke class Buffer Node). WebTorrent /
    // parse-torrent butuh Buffer asli, jadi convert dulu di sini.
    if (source && typeof source === 'object' && !Buffer.isBuffer(source) &&
        (source instanceof Uint8Array || ArrayBuffer.isView(source) || Array.isArray(source))) {
      source = Buffer.from(source);
    }

    console.log('[Torrent] Menambah torrent, tipe source:', typeof source, Buffer.isBuffer(source) ? '(buffer, ' + source.length + ' bytes)' : source);

    return await new Promise((resolve) => {
      let settled = false;

      // PENTING: sebelumnya kalau parse-torrent gagal (file .torrent korup,
      // magnet gak valid, dll), WebTorrent cuma emit 'error' di level CLIENT
      // dan gak pernah manggil callback add() -> Promise ini nggantung
      // selamanya dan UI keliatan diem/gak ngapa-ngapain tanpa error apapun.
      // Sekarang error itu ditangkep dan promise-nya tetep di-resolve.
      const onClientError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        console.error('[Torrent] Gagal menambah torrent (client error):', err);
        resolve({ error: 'Gagal baca torrent: ' + (err && err.message ? err.message : String(err)) });
      };

      // Jaga-jaga kalau gak ada error maupun metadata yang nyampe sama sekali
      // (misal DHT/tracker gak reachable) -> tetep kasih feedback ke user
      // setelah 20 detik, daripada nge-hang selamanya.
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        console.error('[Torrent] Timeout: gak dapet metadata dalam 20 detik untuk source:', Buffer.isBuffer(source) ? '(file buffer)' : source);
        resolve({ error: 'Timeout: gak berhasil dapet metadata torrent dalam 20 detik. Cek koneksi internet, atau kemungkinan file .torrent-nya rusak / gak ada peer yang nyambung.' });
      }, 20000);

      function cleanup() {
        clearTimeout(timeoutId);
        client.removeListener('error', onClientError);
      }

      client.once('error', onClientError);

      try {
        client.add(source, { path: TORRENT_DOWNLOAD_DIR }, (torrent) => {
          if (settled) return;
          settled = true;
          cleanup();

          const id = torrent.infoHash;
          console.log('[Torrent] Berhasil ditambah:', torrent.name, '(' + id + ')');
          activeTorrents.set(id, {
            torrent: torrent,
            name: torrent.name,
            progress: 0,
            downloadSpeed: 0,
            uploadSpeed: 0,
            peers: 0,
            seeds: 0,
            totalSize: torrent.length,
            downloaded: 0,
            state: 'downloading'
          });

          torrent.on('download', () => {
            const stats = activeTorrents.get(id);
            if (stats) {
              stats.downloaded = torrent.downloaded;
              stats.progress = (torrent.downloaded / torrent.length) * 100;
              stats.downloadSpeed = torrent.downloadSpeed;
              stats.uploadSpeed = torrent.uploadSpeed;
              stats.peers = torrent.numPeers;

              if (win && !win.isDestroyed()) {
                win.webContents.send('torrent-progress', {
                  id: id,
                  name: torrent.name,
                  progress: stats.progress,
                  downloaded: stats.downloaded,
                  downloadSpeed: stats.downloadSpeed,
                  uploadSpeed: stats.uploadSpeed,
                  peers: stats.peers
                });
              }
            }
          });

          torrent.on('done', () => {
            const stats = activeTorrents.get(id);
            if (stats) {
              stats.state = 'complete';
              stats.progress = 100;
            }
            console.log('[Torrent] Selesai download:', torrent.name);
            if (win && !win.isDestroyed()) {
              win.webContents.send('torrent-done', {
                id: id,
                name: torrent.name,
                path: torrent.path
              });
            }
          });

          torrent.on('error', (err) => {
            console.error('[Torrent] Error pas jalan (' + torrent.name + '):', err);
            if (win && !win.isDestroyed()) {
              win.webContents.send('torrent-error', {
                id: id,
                error: err.message
              });
            }
          });

          // Berguna buat debug kenapa gak dapet peer: tracker mati, diblokir, dll.
          torrent.on('warning', (err) => {
            console.warn('[Torrent] Warning (' + torrent.name + '):', err && err.message ? err.message : err);
          });

          resolve({
            id: id,
            name: torrent.name,
            files: torrent.files.map(f => f.name),
            size: torrent.length
          });
        });
      } catch (syncErr) {
        if (!settled) {
          settled = true;
          cleanup();
          console.error('[Torrent] Exception sinkron pas client.add:', syncErr);
          resolve({ error: syncErr.message || String(syncErr) });
        }
      }
    });
  } catch (error) {
    console.error('[Torrent] Exception torrent-add:', error);
    return { error: error.message };
  }
});

ipcMain.handle('torrent-pause', async (event, id) => {
  const data = activeTorrents.get(id);
  if (!data) return { success: false, error: 'Torrent gak ketemu (mungkin udah dihapus / ID salah).' };
  try {
    data.torrent.pause();
    data.state = 'paused';
    return { success: true };
  } catch (error) {
    console.error('[Torrent] Gagal pause:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('torrent-resume', async (event, id) => {
  const data = activeTorrents.get(id);
  if (!data) return { success: false, error: 'Torrent gak ketemu (mungkin udah dihapus / ID salah).' };
  try {
    data.torrent.resume();
    data.state = 'downloading';
    return { success: true };
  } catch (error) {
    console.error('[Torrent] Gagal resume:', error);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('torrent-remove', async (event, id) => {
  const data = activeTorrents.get(id);
  if (!data) return { success: false, error: 'Torrent gak ketemu (mungkin udah dihapus / ID salah).' };
  try {
    // Cegah 'error' event yang mungkin nyusul pas destroy (misal DHT lookup
    // yang masih jalan) ikut ke-broadcast sebagai error ke renderer padahal
    // torrent-nya emang lagi sengaja dihapus.
    data.torrent.removeAllListeners('error');
    data.torrent.on('error', () => {});
    activeTorrents.delete(id);
    data.torrent.destroy((err) => {
      if (err) console.error('[Torrent] Warning pas destroy (' + id + '):', err.message || err);
    });
    return { success: true };
  } catch (error) {
    console.error('[Torrent] Gagal hapus torrent:', error);
    activeTorrents.delete(id);
    return { success: false, error: error.message || String(error) };
  }
});

ipcMain.handle('torrent-list', async () => {
  const list = [];
  for (const [id, data] of activeTorrents) {
    list.push({
      id: id,
      name: data.name,
      progress: data.progress,
      downloadSpeed: data.downloadSpeed,
      uploadSpeed: data.uploadSpeed,
      peers: data.peers,
      seeds: data.seeds,
      totalSize: data.totalSize,
      downloaded: data.downloaded,
      state: data.state
    });
  }
  return list;
});

ipcMain.handle('torrent-detail', async (event, id) => {
  const data = activeTorrents.get(id);
  if (data) {
    return {
      name: data.name,
      infoHash: id,
      files: data.torrent.files.map(f => ({
        name: f.name,
        path: f.path,
        size: f.length,
        downloaded: f.downloaded || 0
      })),
      peers: data.torrent.numPeers,
      seeds: data.torrent.numPeers - 1,
      downloaded: data.torrent.downloaded,
      uploaded: data.torrent.uploaded,
      progress: data.progress,
      state: data.state
    };
  }
  return null;
});

ipcMain.handle('torrent-open-folder', () => {
  try {
    ensureTorrentFolders();
    shell.openPath(TORRENT_DOWNLOAD_DIR);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('tor-request', async (event, url, options = {}) => {
  try {
    const tor = await getTorClient();
    const res = await tor.get(url, options);
    return { ok: true, status: res.status, data: res.data, headers: res.headers };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('tor-check-ip', async () => {
  try {
    const tor = await getTorClient();
    const res = await tor.get('https://check.torproject.org/api/ip');
    let data = res.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { /* biarin string apa adanya */ }
    }
    return { ok: true, raw: data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('tor-status', async () => {
  try {
    const tor = await getTorClient();
    await tor.get('https://check.torproject.org/api/ip', { timeout: 6000 });
    return { running: true, port: torClientPort };
  } catch (error) {
    return { running: false, hint: 'Tor belum aktif. Buka Tor Browser dulu (port 9150), atau jalankan tor.exe (port 9050).', error: error.message };
  }
});

// ==================================
// CREATE MAIN WINDOW
// ==================================

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 768,

    minWidth: 800,
    minHeight: 600,

    icon: path.join(
      __dirname,
      'icon.ico'
    ),

    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(
        __dirname,
        'preload.js'
      )
    },

    backgroundColor: '#000000',

    frame: true,

    titleBarStyle: 'hidden'
  });

  const htmlPath = path.join(
    __dirname,
    'my-os-1.html'
  );

  console.log('=================================');
  console.log('Akhtar OS');
  console.log('HTML:', htmlPath);
  console.log('Exists:', fs.existsSync(htmlPath));
  console.log('=================================');

  if (fs.existsSync(htmlPath)) {
    win.loadFile(htmlPath)
      .catch((error) => {
        console.error('Gagal membuka HTML:', error);
      });
  } else {
    console.error('FILE HTML TIDAK DITEMUKAN!');
    console.error(htmlPath);
  }

  Menu.setApplicationMenu(null);

  win.maximize();

  win.on('resize', () => {});

  win.on('closed', () => {
    browserTabs.forEach((t) => {
      try {
        t.view.webContents.destroy();
      } catch (error) {
        console.error('Browser cleanup error:', error);
      }
    });

    browserTabs = [];
    activeTabId = null;

    win = null;
  });

  win.webContents.on(
    'before-input-event',
    (event, input) => {
      if (input.key === 'F12') {
        win.webContents.openDevTools();
      }

      if (input.key === 'F11') {
        win.setFullScreen(
          !win.isFullScreen()
        );
      }

      if (
        input.key === 'Escape' &&
        win.isFullScreen()
      ) {
        win.setFullScreen(false);
      }
    }
  );

  win.webContents.on(
    'did-fail-load',
    (
      event,
      errorCode,
      errorDescription,
      validatedURL
    ) => {
      console.error('=================================');
      console.error('HTML GAGAL DIMUAT');
      console.error('Error Code:', errorCode);
      console.error('Description:', errorDescription);
      console.error('URL:', validatedURL);
      console.error('=================================');
    }
  );

  win.webContents.on(
    'did-finish-load',
    () => {
      console.log('=================================');
      console.log('Akhtar OS berhasil dimuat!');
      console.log('=================================');
    }
  );

  win.webContents.on(
    'render-process-gone',
    (event, details) => {
      console.error('Akhtar OS renderer berhenti:', details.reason);
    }
  );

  // Cegah window utama di-navigate keluar dari file OS-nya sendiri
  win.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const target = new URL(navUrl);
      const current = new URL('file://' + htmlPath.replace(/\\/g, '/'));
      if (target.protocol !== 'file:' || target.pathname !== current.pathname) {
        event.preventDefault();
      }
    } catch (e) {
      event.preventDefault();
    }
  });

  // Cegah window utama buka BrowserWindow baru sembarangan (popup jahat, target=_blank, dsb)
  win.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
}

// ==================================
// TRAY ICON
// ==================================

function createTray() {
  const iconPath = path.join(
    __dirname,
    'icon.ico'
  );

  if (!fs.existsSync(iconPath)) {
    console.log('icon.ico tidak ditemukan, tray dilewati.');
    return;
  }

  tray = new Tray(iconPath);

  const contextMenu =
    Menu.buildFromTemplate([

      {
        label: 'Show Akhtar OS',
        click: () => {
          if (win) {
            win.show();
            win.focus();
          }
        }
      },

      {
        label: 'Open Browser',
        click: () => {
          showBrowser();
        }
      },

      {
        label: 'Reload',
        click: () => {
          if (win) {
            win.reload();
          }
        }
      },

      {
        type: 'separator'
      },

      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }

    ]);

  tray.setToolTip(
    'Akhtar OS v3.0'
  );

  tray.setContextMenu(
    contextMenu
  );

  tray.on('click', () => {
    if (!win) {
      return;
    }

    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

// ==================================
// APP READY
// ==================================

app.whenReady().then(async () => {
  migrateOldAppDataStorage();
  ensureFsFolders();
  ensureTorrentFolders();

  // Cuma auto-load PowerGuard pas startup kalau user emang belum matiin-nya
  // sebelumnya. Kalau state tersimpannya "off", biarin off — jangan dipaksa nyala.
  const powerGuardState = loadPowerGuardState();
  if (powerGuardState.enabled) {
    await loadPowerGuardExtension();
  } else {
    console.log('[PowerGuard] Dimatiin oleh user sebelumnya, skip auto-load.');
  }

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      // Cuma izinin permission yang bener-bener dipakai fitur OS (mic buat voice command, kamera/screen buat cast)
      if (permission === 'media') {
        callback(true);
        return;
      }
      callback(false);
    }
  );

  // Muat ulang pilihan Geolocation & Time Spoofer dari sesi sebelumnya (kalau
  // ada), lalu pasang header Accept-Language + timezone override-nya.
  spoofState = loadSpoofState();
  spoofRegisterSessionHooks();
  spoofApplySessionTimezone();

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      return permission === 'media';
    }
  );

  createWindow();

  broadcastPowerState();
  startBatteryPolling();

  // Inisialisasi torrent client (preload)
  try {
    await getTorrentClient();
    console.log('[Torrent] Client siap!');
  } catch (err) {
    console.error('[Torrent] Gagal init client:', err);
  }
});

// ==================================
// CLOSE ALL WINDOWS
// ==================================

app.on(
  'window-all-closed',
  () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  }
);

// ==================================
// MACOS ACTIVATE
// ==================================

app.on(
  'activate',
  () => {
    if (
      BrowserWindow.getAllWindows()
        .length === 0
    ) {
      createWindow();
    }
  }
);

// ==================================
// BEFORE QUIT
// ==================================

app.on(
  'before-quit',
  () => {
    stopBatteryPolling();

    // Bersihkan torrent
    for (const [id, data] of activeTorrents) {
      try {
        data.torrent.destroy();
      } catch (error) {}
    }
    activeTorrents.clear();

    Object.values(runningProcesses).forEach((proc) => {
      try {
        proc.child.kill();
      } catch (error) {}
    });

    runningProcesses = {};

    browserTabs.forEach((t) => {
      try {
        t.view.webContents.destroy();
      } catch (error) {
        console.error('Browser cleanup error:', error);
      }
    });

    browserTabs = [];
    activeTabId = null;
    browserVisible = false;
  }
);

// ==================================
// DNS SHIELD — DNS-over-HTTPS
// ==================================

async function getMacActiveServiceName() {
  const order = await runCmd('networksetup', ['-listnetworkserviceorder']);
  if (!order.success) return 'Wi-Fi';

  const blocks = order.stdout.split(/\r?\n(?=\(\d+\))/);
  const netIfaces = os.networkInterfaces();

  for (const block of blocks) {
    const nameMatch = block.match(/^\(\d+\)\s*(.+)$/m);
    const deviceMatch = block.match(/Device:\s*(\S+)\)/);

    if (!nameMatch || !deviceMatch) continue;

    const device = deviceMatch[1];
    const addrs = netIfaces[device];

    if (addrs && addrs.some((a) => a.family === 'IPv4' && !a.internal)) {
      return nameMatch[1].trim();
    }
  }

  return 'Wi-Fi';
}

async function getActiveInterfaceName() {
  if (IS_MAC) {
    return await getMacActiveServiceName();
  }

  const result = await runNetsh(['interface', 'show', 'interface']);
  if (!result.success) return null;

  const lines = result.stdout.split(/\r?\n/);
  const candidates = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^Admin State/i.test(line) || /^-+$/.test(line)) continue;

    const match = line.match(/^(Enabled|Disabled)\s+(\S+)\s+(\S+)\s+(.+)$/i);
    if (!match) continue;

    const [, adminState, state, , name] = match;
    if (/^Enabled$/i.test(adminState) && /^Connected$/i.test(state) && !/loopback/i.test(name)) {
      candidates.push(name.trim());
    }
  }

  const preferred = candidates.find(n => !/virtual|vpn|vethernet|loopback/i.test(n));
  return preferred || candidates[0] || null;
}

const DNS_PROVIDERS = {
  cloudflare: {
    id: 'cloudflare',
    name: 'Cloudflare',
    primary: '1.1.1.1',
    secondary: '1.0.0.1',
    doh: 'https://cloudflare-dns.com/dns-query',
    badge: 'FAST',
    desc: 'Tercepat global, privacy-first, no-log',
    supportsCustomId: false,
    requiresCustomId: false
  },
  google: {
    id: 'google',
    name: 'Google',
    primary: '8.8.8.8',
    secondary: '8.8.4.4',
    doh: 'https://dns.google/dns-query',
    badge: 'FAST',
    desc: 'Reliable & cepat, server global',
    supportsCustomId: false,
    requiresCustomId: false
  },
  quad9: {
    id: 'quad9',
    name: 'Quad9',
    primary: '9.9.9.9',
    secondary: '149.112.112.112',
    doh: 'https://dns.quad9.net/dns-query',
    badge: 'SECURE',
    desc: 'Block malware otomatis, secure',
    supportsCustomId: false,
    requiresCustomId: false
  },
  adguard: {
    id: 'adguard',
    name: 'AdGuard',
    primary: '94.140.14.14',
    secondary: '94.140.15.15',
    doh: 'https://dns.adguard-dns.com/dns-query',
    badge: 'SECURE',
    desc: 'Block iklan & tracker, cepat',
    supportsCustomId: false,
    requiresCustomId: false
  },
  nextdns: {
    id: 'nextdns',
    name: 'NextDNS',
    primary: '45.90.28.0',
    secondary: '45.90.30.0',
    doh: 'https://dns.nextdns.io/{id}',
    badge: 'NO-LOG',
    desc: 'Customizable & private, analytics',
    supportsCustomId: true,
    requiresCustomId: true
  },
  opendns: {
    id: 'opendns',
    name: 'OpenDNS',
    primary: '208.67.222.222',
    secondary: '208.67.220.220',
    doh: 'https://doh.opendns.com/dns-query',
    badge: 'SECURE',
    desc: 'Cisco · Family safe, block adult',
    supportsCustomId: false,
    requiresCustomId: false
  },
  cleanbrowsing: {
    id: 'cleanbrowsing',
    name: 'CleanBrowsing',
    primary: '185.228.168.168',
    secondary: '185.228.169.168',
    doh: 'https://doh.cleanbrowsing.org/doh/family-filter/',
    badge: 'SECURE',
    desc: 'Block adult content, family safe',
    supportsCustomId: false,
    requiresCustomId: false
  },
  mullvad: {
    id: 'mullvad',
    name: 'Mullvad',
    primary: '194.242.2.2',
    secondary: null,
    doh: 'https://dns.mullvad.net/dns-query',
    badge: 'NO-LOG',
    desc: 'No-log · Privacy first',
    supportsCustomId: false,
    requiresCustomId: false
  },
  controld: {
    id: 'controld',
    name: 'Control D',
    primary: '76.76.2.2',
    secondary: '76.76.10.2',
    doh: 'https://freedns.controld.com/p2',
    badge: 'SECURE',
    desc: 'Block ads & trackers, customizable',
    supportsCustomId: true,
    requiresCustomId: false,
    customDoh: 'https://dns.controld.com/{id}'
  }
};

ipcMain.handle('dns-get-providers', () => {
  return {
    success: true,
    providers: Object.values(DNS_PROVIDERS)
  };
});

function getDnsStatePath() {
  return path.join(ROOT_DIR, 'dll', 'system', 'dns-shield-state.json');
}

function saveDnsState(state) {
  try {
    const dir = path.join(ROOT_DIR, 'dll', 'system');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getDnsStatePath(), JSON.stringify(state), 'utf8');
  } catch (e) {}
}

function loadDnsState() {
  try {
    const p = getDnsStatePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function clearDnsState() {
  try {
    const p = getDnsStatePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
}

async function getCurrentDnsStatusMac() {
  const interfaceName = await getActiveInterfaceName();
  const savedState = loadDnsState();

  let currentDns = [];
  if (interfaceName) {
    const dnsResult = await runCmd('networksetup', ['-getdnsservers', interfaceName]);
    if (dnsResult.success && !/aren't any dns servers/i.test(dnsResult.stdout)) {
      currentDns = dnsResult.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
  }

  let activeProviderId = null;
  let activeCustomId = null;

  if (savedState && savedState.interface === interfaceName && currentDns.includes(savedState.primaryUsed)) {
    activeProviderId = savedState.providerId;
    activeCustomId = savedState.customId || null;
  } else if (savedState) {
    clearDnsState();
  }

  return {
    success: true,
    activeProviderId,
    customId: activeCustomId,
    dohVerified: false,
    dohNote: 'Di macOS, DNS Shield mengganti server DNS ke provider pilihan (bukan DoH penuh — DoH beneran butuh configuration profile yang disetujui manual).',
    interface: interfaceName,
    entries: currentDns
  };
}

async function getCurrentDnsStatus() {
  if (IS_MAC) {
    return await getCurrentDnsStatusMac();
  }

  if (!IS_WIN) {
    return {
      success: false,
      error: 'DNS Shield saat ini hanya didukung di Windows & macOS.'
    };
  }

  const interfaceName = await getActiveInterfaceName();
  const savedState = loadDnsState();

  let currentDns = [];
  if (interfaceName) {
    const dnsResult = await runNetsh(['interface', 'ip', 'show', 'dns', `name=${interfaceName}`]);
    if (dnsResult.success) {
      const dnsLines = dnsResult.stdout.split(/\r?\n/);
      for (const rawLine of dnsLines) {
        const match = rawLine.match(/([\d]{1,3}\.[\d]{1,3}\.[\d]{1,3}\.[\d]{1,3})/);
        if (match) currentDns.push(match[1]);
      }
    }
  }

  let activeProviderId = null;
  let activeCustomId = null;
  let dohVerified = false;

  if (savedState && savedState.interface === interfaceName && currentDns.includes(savedState.primaryUsed)) {
    activeProviderId = savedState.providerId;
    activeCustomId = savedState.customId || null;

    const encCheck = await runNetsh(['dns', 'show', 'encryption', `server=${savedState.primaryUsed}`]);
    if (encCheck.success && /dohtemplate/i.test(encCheck.stdout)) {
      dohVerified = true;
    }
  } else if (savedState) {
    clearDnsState();
  }

  return {
    success: true,
    activeProviderId,
    customId: activeCustomId,
    dohVerified,
    interface: interfaceName,
    entries: currentDns
  };
}

ipcMain.handle('dns-get-status', async () => {
  return await getCurrentDnsStatus();
});

async function setDnsProviderMac(providerId, customId) {
  const provider = DNS_PROVIDERS[providerId];
  if (!provider) {
    return { success: false, error: 'Provider DNS tidak ditemukan.' };
  }

  const trimmedCustomId = (customId || '').trim();

  if (provider.requiresCustomId && !trimmedCustomId) {
    return {
      success: false,
      error: `${provider.name} butuh Config ID biar bisa dipakai. Masukin ID kamu dulu ya.`
    };
  }

  let template = provider.doh;
  if (trimmedCustomId) {
    if (provider.id === 'nextdns') {
      template = provider.doh.replace('{id}', trimmedCustomId);
    } else if (provider.id === 'controld' && provider.customDoh) {
      template = provider.customDoh.replace('{id}', trimmedCustomId);
    }
  }

  const interfaceName = await getActiveInterfaceName();
  if (!interfaceName) {
    return { success: false, error: 'Gak nemu network service yang lagi aktif & konek (Wi-Fi atau Ethernet).' };
  }

  const servers = [provider.primary];
  if (provider.secondary) servers.push(provider.secondary);

  const setResult = await runCmd('networksetup', ['-setdnsservers', interfaceName, ...servers]);

  if (!setResult.success) {
    return {
      success: false,
      error: 'Gagal set DNS server: ' + (setResult.stderr || setResult.error || 'unknown')
    };
  }

  await runCmd('dscacheutil', ['-flushcache']);
  await runCmd('killall', ['-HUP', 'mDNSResponder']);

  saveDnsState({
    providerId,
    customId: trimmedCustomId || null,
    template,
    interface: interfaceName,
    primaryUsed: provider.primary,
    enabledAt: Date.now()
  });

  return {
    success: true,
    interface: interfaceName,
    provider: providerId,
    template,
    dohNote: 'DNS server diganti ke ' + provider.name + '. Untuk DoH penuh di macOS, install configuration profile resmi dari provider tersebut lewat System Settings.'
  };
}

async function setDnsProvider(providerId, customId) {
  if (IS_MAC) {
    return await setDnsProviderMac(providerId, customId);
  }

  if (!IS_WIN) {
    return {
      success: false,
      error: 'DNS Shield saat ini hanya didukung di Windows 10 versi 2004+ / Windows 11 & macOS.'
    };
  }

  const provider = DNS_PROVIDERS[providerId];
  if (!provider) {
    return { success: false, error: 'Provider DNS tidak ditemukan.' };
  }

  const trimmedCustomId = (customId || '').trim();

  if (provider.requiresCustomId && !trimmedCustomId) {
    return {
      success: false,
      error: `${provider.name} butuh Config ID biar bisa dipakai. Masukin ID kamu dulu ya.`
    };
  }

  let template = provider.doh;
  if (trimmedCustomId) {
    if (provider.id === 'nextdns') {
      template = provider.doh.replace('{id}', trimmedCustomId);
    } else if (provider.id === 'controld' && provider.customDoh) {
      template = provider.customDoh.replace('{id}', trimmedCustomId);
    }
  }

  const interfaceName = await getActiveInterfaceName();
  if (!interfaceName) {
    return { success: false, error: 'Gak nemu adapter jaringan yang lagi aktif & konek (Wi-Fi atau Ethernet).' };
  }

  const encPrimary = await runNetsh([
    'dns', 'add', 'encryption',
    `server=${provider.primary}`,
    `dohtemplate=${template}`,
    'autoupgrade=yes',
    'udpfallback=no'
  ]);

  if (!encPrimary.success) {
    return {
      success: false,
      error: 'Gagal daftarin enkripsi DoH: ' + (encPrimary.stderr || encPrimary.error || 'unknown') +
        '\n\nPastikan kamu jalanin Akhtar OS sebagai Administrator dan pakai Windows 10 2004+/Windows 11.'
    };
  }

  if (provider.secondary) {
    await runNetsh([
      'dns', 'add', 'encryption',
      `server=${provider.secondary}`,
      `dohtemplate=${template}`,
      'autoupgrade=yes',
      'udpfallback=no'
    ]);
  }

  const setDns = await runNetsh([
    'interface', 'ip', 'set', 'dns',
    `name=${interfaceName}`,
    'static', provider.primary, 'primary'
  ]);

  if (!setDns.success) {
    return {
      success: false,
      error: 'Gagal set DNS server: ' + (setDns.stderr || setDns.error || 'unknown')
    };
  }

  if (provider.secondary) {
    await runNetsh([
      'interface', 'ip', 'add', 'dns',
      `name=${interfaceName}`,
      provider.secondary, 'index=2'
    ]);
  }

  await new Promise((resolve) => {
    execFile('ipconfig', ['/flushdns'], { windowsHide: true }, () => resolve());
  });

  saveDnsState({
    providerId,
    customId: trimmedCustomId || null,
    template,
    interface: interfaceName,
    primaryUsed: provider.primary,
    enabledAt: Date.now()
  });

  return {
    success: true,
    interface: interfaceName,
    provider: providerId,
    template
  };
}

ipcMain.handle('dns-set-provider', async (event, providerId, customId) => {
  return await setDnsProvider(providerId, customId);
});

async function resetDnsToDefaultMac() {
  const interfaceName = await getActiveInterfaceName();
  if (!interfaceName) {
    return { success: false, error: 'Gak nemu network service yang lagi aktif & konek.' };
  }

  const setResult = await runCmd('networksetup', ['-setdnsservers', interfaceName, 'Empty']);

  await runCmd('dscacheutil', ['-flushcache']);
  await runCmd('killall', ['-HUP', 'mDNSResponder']);

  clearDnsState();

  return {
    success: setResult.success,
    interface: interfaceName,
    error: setResult.success ? null : (setResult.stderr || setResult.error)
  };
}

async function resetDnsToDefault() {
  if (IS_MAC) {
    return await resetDnsToDefaultMac();
  }

  if (!IS_WIN) {
    return { success: false, error: 'DNS Shield saat ini hanya didukung di Windows & macOS.' };
  }

  const interfaceName = await getActiveInterfaceName();
  if (!interfaceName) {
    return { success: false, error: 'Gak nemu adapter jaringan yang lagi aktif & konek.' };
  }

  const savedState = loadDnsState();
  if (savedState && savedState.primaryUsed) {
    const provider = DNS_PROVIDERS[savedState.providerId];
    await runNetsh(['dns', 'delete', 'encryption', `server=${savedState.primaryUsed}`]);
    if (provider && provider.secondary) {
      await runNetsh(['dns', 'delete', 'encryption', `server=${provider.secondary}`]);
    }
  }

  const setResult = await runNetsh([
    'interface', 'ip', 'set', 'dns',
    `name=${interfaceName}`,
    'dhcp'
  ]);

  await new Promise((resolve) => {
    execFile('ipconfig', ['/flushdns'], { windowsHide: true }, () => resolve());
  });

  clearDnsState();

  return {
    success: setResult.success,
    interface: interfaceName,
    error: setResult.success ? null : (setResult.stderr || setResult.error)
  };
}

ipcMain.handle('dns-reset', async () => {
  return await resetDnsToDefault();
});

// ==================================
// AKHTAR SHARE — P2P FILE SHARING (FASE 1)
// ==================================
// Fase 1 fokus di fondasi: discovery device di LAN (mDNS) + transfer file
// langsung device-ke-device lewat WebSocket (gak butuh internet/server luar,
// karena semua di jaringan lokal jadi gak perlu STUN/TURN kayak WebRTC asli).
// Enkripsi (AES-256), PIN auth, block list dll nyusul di Fase 2.
//
// Dependency yang wajib di-install dulu di project:
//   npm install bonjour-service ws
//
// Kalau belum ke-install, fitur ini bakal auto nonaktif (getStatus() balikin
// supported:false) daripada bikin seluruh app crash pas boot.

const crypto = require('crypto');

let Bonjour = null;
let WebSocketServer = null;
let WebSocketClient = null;
let shareDepsError = null;

try {
  Bonjour = require('bonjour-service').Bonjour;
  const wsLib = require('ws');
  WebSocketServer = wsLib.WebSocketServer;
  WebSocketClient = wsLib.WebSocket;
} catch (e) {
  shareDepsError = e.message;
}

const SHARE_SERVICE_TYPE = 'akhtarshare';
const SHARE_PORT = 4433;
const SHARE_DOWNLOAD_DIR = path.join(ROOT_DIR, 'akhtar share', 'diterima');
const SHARE_ID_FILE = path.join(ROOT_DIR, 'akhtar share', 'device.json');

let shareBonjour = null;
let shareBonjourBrowser = null;
let shareBonjourService = null;
let shareWss = null;
let shareEnabled = false;

let shareLocalDevice = null; // { id, name, platform }
const shareDevices = new Map();   // id -> { id, name, platform, host, port, lastSeen }
const shareIncoming = new Map();  // transferId -> { ws, files, fromDevice, fileHandles, receivedBytes, totalBytes }
const shareOutgoing = new Map();  // transferId -> { ws, cancelled }

function shareBroadcastState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('share-devices', Array.from(shareDevices.values()));
}

function shareSendEvent(channel, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function ensureShareDirs() {
  try {
    fs.mkdirSync(SHARE_DOWNLOAD_DIR, { recursive: true });
  } catch (e) {
    console.error('[Share] Gagal bikin folder download:', e.message);
  }
}

function getLocalDevice() {
  if (shareLocalDevice) return shareLocalDevice;

  ensureShareDirs();

  try {
    if (fs.existsSync(SHARE_ID_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SHARE_ID_FILE, 'utf8'));
      if (saved && saved.id) {
        shareLocalDevice = {
          id: saved.id,
          name: saved.name || os.hostname() || 'Akhtar OS Device',
          platform: process.platform
        };
        return shareLocalDevice;
      }
    }
  } catch (e) {
    // File korup / gak kebaca, generate baru di bawah
  }

  shareLocalDevice = {
    id: crypto.randomUUID(),
    name: os.hostname() || 'Akhtar OS Device',
    platform: process.platform
  };

  try {
    fs.writeFileSync(SHARE_ID_FILE, JSON.stringify(shareLocalDevice, null, 2));
  } catch (e) {
    console.error('[Share] Gagal simpan identitas device:', e.message);
  }

  return shareLocalDevice;
}

function setLocalDeviceName(name) {
  const device = getLocalDevice();
  device.name = String(name || '').trim().slice(0, 40) || device.name;

  try {
    fs.writeFileSync(SHARE_ID_FILE, JSON.stringify(device, null, 2));
  } catch (e) {
    console.error('[Share] Gagal update nama device:', e.message);
  }

  // Republish mDNS biar device lain langsung liat nama baru
  if (shareEnabled) {
    stopShareDiscovery();
    startShareDiscovery();
  }

  return device;
}

// ---- WEBSOCKET SERVER (nerima koneksi masuk buat discovery/transfer) ----

function startShareServer() {
  if (shareWss || !WebSocketServer) return;

  shareWss = new WebSocketServer({ port: SHARE_PORT });

  shareWss.on('error', (err) => {
    console.error('[Share] WS server error:', err.message);
  });

  shareWss.on('connection', (ws) => {
    let peerInfo = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        handleIncomingBinaryChunk(ws, data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }

      if (msg.type === 'hello') {
        peerInfo = msg.device;
        return;
      }

      if (msg.type === 'offer') {
        handleIncomingOffer(ws, peerInfo, msg);
        return;
      }

      if (msg.type === 'file-start') {
        handleIncomingFileStart(msg);
        return;
      }

      if (msg.type === 'file-end') {
        handleIncomingFileEnd(msg);
        return;
      }

      if (msg.type === 'transfer-done') {
        handleIncomingTransferDone(msg);
        return;
      }

      if (msg.type === 'transfer-cancel') {
        const incoming = shareIncoming.get(msg.transferId);
        if (incoming) {
          closeIncomingTransfer(msg.transferId, true);
          shareSendEvent('share-transfer-error', { transferId: msg.transferId, error: 'Dibatalin sama pengirim', incoming: true });
        }
        return;
      }
    });

    ws.on('close', () => {
      // Kalau device yang lagi ngirim tiba-tiba disconnect di tengah jalan,
      // bersihin transfer yang nyangkut biar UI gak keliatan diem selamanya.
      for (const [id, incoming] of shareIncoming.entries()) {
        if (incoming.ws === ws) {
          closeIncomingTransfer(id, true);
          shareSendEvent('share-transfer-error', { transferId: id, error: 'Koneksi terputus', incoming: true });
        }
      }
    });
  });
}

function stopShareServer() {
  if (shareWss) {
    try { shareWss.close(); } catch (e) {}
    shareWss = null;
  }
}

// ---- DISCOVERY (mDNS via bonjour-service) ----

function startShareDiscovery() {
  if (!Bonjour) return;

  const device = getLocalDevice();
  shareBonjour = new Bonjour();

  shareBonjourService = shareBonjour.publish({
    name: `AkhtarShare-${device.id.slice(0, 8)}`,
    type: SHARE_SERVICE_TYPE,
    port: SHARE_PORT,
    txt: {
      id: device.id,
      name: device.name,
      platform: device.platform
    }
  });

  shareBonjourBrowser = shareBonjour.find({ type: SHARE_SERVICE_TYPE }, (service) => {
    const txt = service.txt || {};
    if (!txt.id || txt.id === device.id) return; // skip diri sendiri

    const host = (service.referer && service.referer.address) ||
      (service.addresses && service.addresses[0]) || null;
    if (!host) return;

    shareDevices.set(txt.id, {
      id: txt.id,
      name: txt.name || 'Device Tanpa Nama',
      platform: txt.platform || 'unknown',
      host,
      port: service.port || SHARE_PORT,
      lastSeen: Date.now()
    });

    shareBroadcastState();
  });

  if (shareBonjourBrowser) {
    shareBonjourBrowser.on('down', (service) => {
      const txt = service.txt || {};
      if (txt.id) {
        shareDevices.delete(txt.id);
        shareBroadcastState();
      }
    });
  }

  // Bersihin device yang udah gak keliatan lebih dari 20 detik (jaga-jaga
  // event 'down' gak kepanggil, misal device mati mendadak)
  shareStaleInterval = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, dev] of shareDevices.entries()) {
      if (now - dev.lastSeen > 20000) {
        shareDevices.delete(id);
        changed = true;
      }
    }
    if (changed) shareBroadcastState();
  }, 5000);
}

let shareStaleInterval = null;

function stopShareDiscovery() {
  if (shareStaleInterval) {
    clearInterval(shareStaleInterval);
    shareStaleInterval = null;
  }
  if (shareBonjour) {
    try {
      shareBonjour.unpublishAll(() => {});
      shareBonjour.destroy();
    } catch (e) {}
    shareBonjour = null;
    shareBonjourBrowser = null;
    shareBonjourService = null;
  }
  shareDevices.clear();
}

// ---- KIRIM FILE (jadi PENGIRIM) ----

function shareSendFiles(targetDeviceId, filePaths) {
  return new Promise((resolve) => {
    if (!WebSocketClient) {
      resolve({ error: 'Modul Akhtar Share belum siap (dependency belum ke-install)' });
      return;
    }

    const target = shareDevices.get(targetDeviceId);
    if (!target) {
      resolve({ error: 'Device tujuan gak ketemu / udah offline' });
      return;
    }

    const validFiles = filePaths.filter((p) => {
      try { return fs.existsSync(p) && fs.statSync(p).isFile(); }
      catch (e) { return false; }
    });

    if (validFiles.length === 0) {
      resolve({ error: 'Gak ada file valid buat dikirim' });
      return;
    }

    const transferId = crypto.randomUUID();
    const fileMeta = validFiles.map((p) => ({
      name: path.basename(p),
      size: fs.statSync(p).size,
      fullPath: p
    }));

    const ws = new WebSocketClient(`ws://${target.host}:${target.port}`);
    shareOutgoing.set(transferId, { ws, cancelled: false });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', device: getLocalDevice() }));
      ws.send(JSON.stringify({
        type: 'offer',
        transferId,
        files: fileMeta.map((f) => ({ name: f.name, size: f.size }))
      }));
      resolve({ transferId });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }

      if (msg.type === 'accept' && msg.transferId === transferId) {
        streamFilesToPeer(ws, transferId, fileMeta);
      } else if (msg.type === 'reject' && msg.transferId === transferId) {
        shareSendEvent('share-transfer-error', { transferId, error: 'Ditolak sama penerima' });
        shareOutgoing.delete(transferId);
        ws.close();
      }
    });

    ws.on('error', (err) => {
      shareSendEvent('share-transfer-error', { transferId, error: 'Gagal konek: ' + err.message });
      shareOutgoing.delete(transferId);
    });

    // Kalau 15 detik ws gak kebuka sama sekali (device mati / port ketutup firewall)
    setTimeout(() => {
      if (shareOutgoing.has(transferId) && ws.readyState !== WebSocketClient.OPEN) {
        resolve({ error: 'Timeout, device gak merespon' });
        try { ws.terminate(); } catch (e) {}
        shareOutgoing.delete(transferId);
      }
    }, 15000);
  });
}

function streamFilesToPeer(ws, transferId, fileMeta) {
  const CHUNK_SIZE = 256 * 1024; // 256KB per chunk
  const totalBytes = fileMeta.reduce((a, f) => a + f.size, 0);
  let sentBytes = 0;
  let fileIndex = 0;

  function sendNextFile() {
    const outgoing = shareOutgoing.get(transferId);
    if (!outgoing || outgoing.cancelled) return;

    if (fileIndex >= fileMeta.length) {
      ws.send(JSON.stringify({ type: 'transfer-done', transferId }));
      shareSendEvent('share-transfer-done', { transferId });
      shareOutgoing.delete(transferId);
      ws.close();
      return;
    }

    const file = fileMeta[fileIndex];
    ws.send(JSON.stringify({
      type: 'file-start', transferId, fileIndex, name: file.name, size: file.size
    }));

    const stream = fs.createReadStream(file.fullPath, { highWaterMark: CHUNK_SIZE });

    stream.on('data', (chunk) => {
      if (outgoing.cancelled) { stream.destroy(); return; }
      ws.send(chunk, { binary: true });
      sentBytes += chunk.length;
      shareSendEvent('share-transfer-progress', {
        transferId,
        fileIndex,
        fileName: file.name,
        percent: totalBytes ? Math.min(100, (sentBytes / totalBytes) * 100) : 100
      });
    });

    stream.on('end', () => {
      ws.send(JSON.stringify({ type: 'file-end', transferId, fileIndex }));
      fileIndex += 1;
      sendNextFile();
    });

    stream.on('error', (err) => {
      shareSendEvent('share-transfer-error', { transferId, error: 'Gagal baca file: ' + err.message });
      shareOutgoing.delete(transferId);
      try { ws.close(); } catch (e) {}
    });
  }

  sendNextFile();
}

function shareCancelOutgoing(transferId) {
  const outgoing = shareOutgoing.get(transferId);
  if (!outgoing) return false;
  outgoing.cancelled = true;
  try {
    outgoing.ws.send(JSON.stringify({ type: 'transfer-cancel', transferId }));
    outgoing.ws.close();
  } catch (e) {}
  shareOutgoing.delete(transferId);
  return true;
}

// ---- TERIMA FILE (jadi PENERIMA) ----

function handleIncomingOffer(ws, fromDevice, msg) {
  ensureShareDirs();

  const transferId = msg.transferId;
  const totalBytes = (msg.files || []).reduce((a, f) => a + (f.size || 0), 0);

  shareIncoming.set(transferId, {
    ws,
    files: msg.files || [],
    fromDevice: fromDevice || { id: 'unknown', name: 'Device Gak Dikenal' },
    fileHandles: {},
    receivedBytes: 0,
    totalBytes,
    currentFileIndex: -1
  });

  shareSendEvent('share-incoming-request', {
    transferId,
    from: fromDevice || { id: 'unknown', name: 'Device Gak Dikenal' },
    files: msg.files || []
  });
}

function shareRespondToRequest(transferId, accept) {
  const incoming = shareIncoming.get(transferId);
  if (!incoming) return { error: 'Transfer gak ketemu (mungkin udah expired)' };

  if (!accept) {
    try { incoming.ws.send(JSON.stringify({ type: 'reject', transferId })); } catch (e) {}
    shareIncoming.delete(transferId);
    return { ok: true };
  }

  try { incoming.ws.send(JSON.stringify({ type: 'accept', transferId })); } catch (e) {}
  return { ok: true };
}

function handleIncomingFileStart(msg) {
  const incoming = shareIncoming.get(msg.transferId);
  if (!incoming) return;

  const safeName = path.basename(msg.name).replace(/[<>:"/\\|?*]/g, '_');
  let destPath = path.join(SHARE_DOWNLOAD_DIR, safeName);

  // Kalau nama file udah ada, tambahin suffix biar gak ketimpa
  let counter = 1;
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  while (fs.existsSync(destPath)) {
    destPath = path.join(SHARE_DOWNLOAD_DIR, `${base} (${counter})${ext}`);
    counter += 1;
  }

  incoming.currentFileIndex = msg.fileIndex;
  incoming.currentFileName = msg.name;
  incoming.fileHandles[msg.fileIndex] = {
    stream: fs.createWriteStream(destPath),
    destPath
  };
}

function handleIncomingBinaryChunk(ws, chunk) {
  for (const [transferId, incoming] of shareIncoming.entries()) {
    if (incoming.ws !== ws) continue;

    const handle = incoming.fileHandles[incoming.currentFileIndex];
    if (!handle) return;

    handle.stream.write(chunk);
    incoming.receivedBytes += chunk.length;

    shareSendEvent('share-transfer-progress', {
      transferId,
      incoming: true,
      fileIndex: incoming.currentFileIndex,
      fileName: incoming.currentFileName,
      percent: incoming.totalBytes ? Math.min(100, (incoming.receivedBytes / incoming.totalBytes) * 100) : 100
    });
    return;
  }
}

function handleIncomingFileEnd(msg) {
  const incoming = shareIncoming.get(msg.transferId);
  if (!incoming) return;

  const handle = incoming.fileHandles[msg.fileIndex];
  if (handle) {
    handle.stream.end();
  }
}

function handleIncomingTransferDone(msg) {
  const incoming = shareIncoming.get(msg.transferId);
  if (!incoming) return;

  shareSendEvent('share-transfer-done', { transferId: msg.transferId, incoming: true, saveDir: SHARE_DOWNLOAD_DIR });
  shareIncoming.delete(msg.transferId);
}

function closeIncomingTransfer(transferId, destroyPartial) {
  const incoming = shareIncoming.get(transferId);
  if (!incoming) return;

  for (const idx in incoming.fileHandles) {
    const handle = incoming.fileHandles[idx];
    try {
      handle.stream.end();
      if (destroyPartial) fs.unlink(handle.destPath, () => {});
    } catch (e) {}
  }

  shareIncoming.delete(transferId);
}

// ---- ON/OFF UTAMA ----

function shareStart() {
  if (!Bonjour || !WebSocketServer) {
    return { supported: false, error: shareDepsError || 'Dependency bonjour-service / ws belum ke-install' };
  }
  if (shareEnabled) return { supported: true, enabled: true, device: getLocalDevice() };

  ensureShareDirs();
  startShareServer();
  startShareDiscovery();
  shareEnabled = true;

  return { supported: true, enabled: true, device: getLocalDevice() };
}

function shareStop() {
  stopShareDiscovery();
  stopShareServer();
  shareEnabled = false;
  return { enabled: false };
}

// ---- IPC HANDLERS ----

ipcMain.handle('share-get-status', () => ({
  supported: !!(Bonjour && WebSocketServer),
  enabled: shareEnabled,
  device: getLocalDevice(),
  error: shareDepsError
}));

ipcMain.handle('share-start', () => shareStart());
ipcMain.handle('share-stop', () => shareStop());

ipcMain.handle('share-set-name', (event, name) => setLocalDeviceName(name));

ipcMain.handle('share-get-devices', () => Array.from(shareDevices.values()));

ipcMain.handle('share-pick-and-send', async (event, targetDeviceId) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Pilih file buat dikirim',
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return await shareSendFiles(targetDeviceId, result.filePaths);
});

ipcMain.handle('share-send-files', async (event, targetDeviceId, filePaths) => {
  return await shareSendFiles(targetDeviceId, filePaths);
});

ipcMain.handle('share-respond-request', (event, transferId, accept) => {
  return shareRespondToRequest(transferId, accept);
});

ipcMain.handle('share-cancel-transfer', (event, transferId) => {
  return shareCancelOutgoing(transferId);
});

ipcMain.handle('share-open-downloads-folder', () => {
  try {
    ensureShareDirs();
    shell.openPath(SHARE_DOWNLOAD_DIR);
    return true;
  } catch (e) {
    return false;
  }
});

// ==================================
// DATA POISONING ENGINE (Racun Data)
// ==================================
// Konsep: obfuscation over blocking. Selama aktif, engine ini secara berkala
// spawn "ghost session" — window hidden dengan fingerprint acak (UA, viewport,
// bahasa, partition session terpisah) yang jalanin pencarian/browsing random
// (Google search, Wikipedia random, Reddit random) plus simulasi perilaku
// manusia (scroll bertahap + klik link acak). Tujuannya bikin noise di profil
// tracker/data broker, bukan cuma blokir mereka doang.
//
// PENTING soal batas fitur ini:
// - Ini generate traffic browsing biasa (search query + baca halaman publik),
//   BUKAN request otomatis ke ratusan situs sekaligus / spam / DoS apapun.
// - Ada rate limiter (jeda antar sesi) supaya traffic-nya tetap masuk akal
//   dan gak membebani situs target atau jaringan user.
// - Cuma jalan kalau user nyalain manual (atau auto-follow Incognito kalau
//   diaktifkan dari UI) — gak pernah jalan diam-diam di background tanpa toggle.

const POISON_QUERY_POOLS = {
  kuliner: {
    lang: 'id',
    items: [
      'resep kue kering lebaran', 'cara bikin mie ayam rumahan', 'resep sambal matah',
      'rekomendasi kopi enak dekat sini', 'cara masak rendang empuk', 'resep bolu kukus mekar',
      'menu buka puasa praktis', 'cara bikin cireng renyah', 'resep ayam geprek sambal bawang',
      'kedai kopi estetik buat nongkrong'
    ]
  },
  belanja: {
    lang: 'id',
    items: [
      'sepatu lari terbaik 2026', 'jaket winter murah', 'promo skincare hari ini',
      'tas ransel kantor pria', 'review sepatu lari trail', 'jam tangan otomatis budget',
      'baju kondangan simple', 'headset gaming murah bagus', 'kursi kerja ergonomis harga terjangkau'
    ]
  },
  otomotif: {
    lang: 'id',
    items: [
      'harga motor matic bekas', 'perbandingan mobil city car', 'cara ganti oli sendiri',
      'servis rutin motor berapa km', 'mobil listrik murah 2026', 'ban motor awet buat harian'
    ]
  },
  kesehatan: {
    lang: 'id',
    items: [
      'cara tidur nyenyak', 'manfaat jalan pagi', 'menu diet sehat mingguan',
      'vitamin buat daya tahan tubuh', 'cara mengurangi stres kerja', 'olahraga ringan di rumah'
    ]
  },
  properti: {
    lang: 'id',
    items: [
      'rumah dijual dekat stasiun', 'tips kredit rumah pertama', 'kos murah dekat kampus',
      'renovasi dapur minimalis budget kecil', 'apartemen sewa bulanan'
    ]
  },
  hiburan_id: {
    lang: 'id',
    items: [
      'rekomendasi film weekend ini', 'lagu galau enak didengar', 'drakor terbaru worth it',
      'buku fiksi ringan buat pemula', 'podcast santai buat perjalanan'
    ]
  },
  longtail_id: {
    lang: 'id',
    items: [
      'kenapa kucing muntah setelah makan', 'kenapa laptop cepat panas',
      'apa itu asuransi jiwa unit link', 'berapa lama air rebus mendidih',
      'kenapa tanaman cabai daunnya kuning', 'cara mengatasi insomnia ringan',
      'apa bedanya yoga dan pilates', 'kenapa mata cepat lelah di depan layar'
    ]
  },
  shopping_en: {
    lang: 'en',
    items: [
      'best running shoes 2026', 'cheap winter jacket deals', 'ergonomic office chair budget',
      'wireless headphones under 100', 'weekend outfit ideas', 'best backpack for commuting',
      'affordable smartwatch reviews'
    ]
  },
  lifestyle_en: {
    lang: 'en',
    items: [
      'how to sleep better at night', 'easy meal prep ideas', 'benefits of morning walk',
      'how to reduce work stress', 'best budget travel destinations', 'simple home workout routine'
    ]
  },
  longtail_en: {
    lang: 'en',
    items: [
      'why does my cat throw up after eating', 'why is my laptop overheating',
      'how long does it take to boil an egg', 'why do plant leaves turn yellow',
      'difference between yoga and pilates', 'how to fix dry skin in winter'
    ]
  },
  culinaria_es: {
    lang: 'es',
    items: [
      'receta de tacos faciles', 'mejores cafeterias cerca de mi', 'como hacer pan casero',
      'menu saludable para la semana', 'receta de paella rapida'
    ]
  },
  compras_es: {
    lang: 'es',
    items: [
      'zapatillas para correr baratas', 'chaqueta de invierno oferta', 'silla de oficina ergonomica'
    ]
  },
  vida_pt: {
    lang: 'pt',
    items: [
      'receita de bolo simples', 'como dormir melhor a noite', 'tenis para corrida barato',
      'dicas para reduzir o estresse', 'melhores destinos de viagem economicos'
    ]
  },
  leben_de: {
    lang: 'de',
    items: [
      'gunstige laufschuhe test', 'einfaches rezept fur abendessen', 'wie schlaft man besser',
      'buro stuhl ergonomisch gunstig'
    ]
  },
  vie_fr: {
    lang: 'fr',
    items: [
      'recette facile pour ce soir', 'meilleures chaussures de course pas cher',
      'comment mieux dormir la nuit', 'chaise de bureau ergonomique pas cher'
    ]
  },
  seikatsu_ja: {
    lang: 'ja',
    items: [
      'おすすめ ランニングシューズ 安い', '簡単 夕食 レシピ', 'よく眠る方法',
      '在宅ワーク 椅子 おすすめ'
    ]
  },
  saeng_ko: {
    lang: 'ko',
    items: [
      '저렴한 러닝화 추천', '간단한 저녁 레시피', '잠 잘 자는 방법', '재택근무 의자 추천'
    ]
  }
};

// ---- QUERY GENERATOR: prefix + topik + suffix, dikombinasikan otomatis ----
// Puluhan template di bawah ini menghasilkan RIBUAN kombinasi query berbeda
// (bukan cuma ~150 string statis), jadi engine gak keulang-ulang query yang
// sama persis kalau dijalanin berhari-hari. Hasilnya digabung ke POISON_QUERY_POOLS
// di bawah dengan key 'generated_<lang>'.
const POISON_QUERY_TEMPLATES = {
  id: [
    { prefixes: ['cara bikin', 'resep', 'tips bikin', 'cara masak', 'resep simpel'],
      topics: ['nasi goreng', 'ayam bakar', 'mie goreng', 'kue coklat', 'roti tawar', 'sup ayam', 'pizza rumahan', 'martabak manis', 'telur dadar', 'sate ayam'],
      suffixes: ['yang enak', 'yang mudah', 'ala restoran', 'buat pemula', 'anti gagal', ''] },
    { prefixes: ['review', 'harga', 'perbandingan', 'rekomendasi', 'spek'],
      topics: ['laptop gaming', 'hp murah', 'sepeda lipat', 'kamera mirrorless', 'powerbank', 'earphone bluetooth', 'kipas angin', 'rice cooker', 'router wifi', 'monitor gaming'],
      suffixes: ['2026', 'terbaik', 'budget pelajar', 'worth it', 'murah', ''] },
    { prefixes: ['kenapa', 'apa penyebab', 'cara mengatasi', 'kapan harus periksa'],
      topics: ['badan gampang capek', 'susah tidur', 'sakit kepala terus', 'nafsu makan turun', 'jerawat gak hilang', 'rambut rontok'],
      suffixes: ['padahal udah istirahat', 'secara alami', 'tanpa obat', ''] },
    { prefixes: ['itinerary', 'rekomendasi wisata', 'tempat healing', 'liburan murah'],
      topics: ['Bandung', 'Yogyakarta', 'Bali', 'Malang', 'Lombok', 'Bromo'],
      suffixes: ['3 hari 2 malam', 'buat keluarga', 'anti mainstream', 'budget pas-pasan', ''] }
  ],
  en: [
    { prefixes: ['how to make', 'best recipe for', 'quick recipe', 'easy way to cook'],
      topics: ['banana bread', 'grilled chicken', 'pasta sauce', 'pancakes', 'stir fry', 'homemade pizza', 'chicken soup', 'fried rice'],
      suffixes: ['for beginners', 'that actually works', 'in under 30 minutes', 'from scratch', ''] },
    { prefixes: ['best', 'cheap', 'review of', 'comparison of'],
      topics: ['noise cancelling headphones', 'gaming laptop', 'budget smartphone', 'office chair', 'electric kettle', 'fitness tracker', 'coffee maker', 'wireless mouse'],
      suffixes: ['2026', 'under 100 dollars', 'for students', 'worth buying', ''] },
    { prefixes: ['why do i', 'how to stop', 'what causes', 'when should i see a doctor for'],
      topics: ['feel tired all the time', 'get headaches so often', 'have trouble sleeping', 'lose motivation at work', 'crave sugar so much'],
      suffixes: ['naturally', 'without medication', 'quickly', ''] },
    { prefixes: ['best itinerary for', 'weekend trip to', 'cheap travel guide to', 'things to do in'],
      topics: ['Bali', 'Tokyo', 'Lisbon', 'Bangkok', 'New York', 'Seoul'],
      suffixes: ['3 days', 'on a budget', 'for couples', 'with kids', ''] }
  ]
};

function poisonExpandTemplates(lang) {
  const groups = POISON_QUERY_TEMPLATES[lang] || [];
  const out = [];
  groups.forEach((g) => {
    g.prefixes.forEach((p) => {
      g.topics.forEach((t) => {
        g.suffixes.forEach((s) => {
          out.push([p, t, s].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim());
        });
      });
    });
  });
  return out;
}

// Gabungin hasil generator ke pool utama sekali aja pas module di-load.
Object.keys(POISON_QUERY_TEMPLATES).forEach((lang) => {
  const generated = poisonExpandTemplates(lang);
  if (generated.length) {
    POISON_QUERY_POOLS['generated_' + lang] = { lang, items: generated };
  }
});

// ---- TARGET SITES DILUAR SEARCH ENGINE: e-commerce & berita lokal ----
// Bukan 400 domain hardcoded (itu berat dimaintain — tiap situs punya popup
// consent/layout beda yang gampang bikin sesi "gagal" bukan "poisoning").
// Ini set yang solid per bahasa/region dan gampang ditambahin baris baru.
const POISON_ECOMMERCE_SITES = {
  id: [
    { domain: 'tokopedia.com', build: (q) => 'https://www.tokopedia.com/search?q=' + encodeURIComponent(q) },
    { domain: 'shopee.co.id', build: (q) => 'https://shopee.co.id/search?keyword=' + encodeURIComponent(q) },
    { domain: 'bukalapak.com', build: (q) => 'https://www.bukalapak.com/products?search%5Bkeywords%5D=' + encodeURIComponent(q) },
    { domain: 'blibli.com', build: (q) => 'https://www.blibli.com/cari/' + encodeURIComponent(q) },
    { domain: 'lazada.co.id', build: (q) => 'https://www.lazada.co.id/catalog/?q=' + encodeURIComponent(q) },
    { domain: 'zalora.co.id', build: (q) => 'https://www.zalora.co.id/search/?q=' + encodeURIComponent(q) }
  ],
  en: [
    { domain: 'amazon.com', build: (q) => 'https://www.amazon.com/s?k=' + encodeURIComponent(q) },
    { domain: 'ebay.com', build: (q) => 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(q) },
    { domain: 'etsy.com', build: (q) => 'https://www.etsy.com/search?q=' + encodeURIComponent(q) },
    { domain: 'walmart.com', build: (q) => 'https://www.walmart.com/search?q=' + encodeURIComponent(q) },
    { domain: 'target.com', build: (q) => 'https://www.target.com/s?searchTerm=' + encodeURIComponent(q) },
    { domain: 'bestbuy.com', build: (q) => 'https://www.bestbuy.com/site/searchpage.jsp?st=' + encodeURIComponent(q) },
    { domain: 'aliexpress.com', build: (q) => 'https://www.aliexpress.com/wholesale?SearchText=' + encodeURIComponent(q) }
  ],
  es: [
    { domain: 'amazon.com.mx', build: (q) => 'https://www.amazon.com.mx/s?k=' + encodeURIComponent(q) },
    { domain: 'mercadolibre.com.mx', build: (q) => 'https://listado.mercadolibre.com.mx/' + encodeURIComponent(q) },
    { domain: 'elcorteingles.es', build: (q) => 'https://www.elcorteingles.es/search/?s=' + encodeURIComponent(q) }
  ],
  pt: [
    { domain: 'amazon.com.br', build: (q) => 'https://www.amazon.com.br/s?k=' + encodeURIComponent(q) },
    { domain: 'mercadolivre.com.br', build: (q) => 'https://lista.mercadolivre.com.br/' + encodeURIComponent(q) },
    { domain: 'magazineluiza.com.br', build: (q) => 'https://www.magazineluiza.com.br/busca/' + encodeURIComponent(q) }
  ],
  de: [
    { domain: 'amazon.de', build: (q) => 'https://www.amazon.de/s?k=' + encodeURIComponent(q) },
    { domain: 'otto.de', build: (q) => 'https://www.otto.de/suche/' + encodeURIComponent(q) },
    { domain: 'mediamarkt.de', build: (q) => 'https://www.mediamarkt.de/de/search.html?query=' + encodeURIComponent(q) }
  ],
  fr: [
    { domain: 'amazon.fr', build: (q) => 'https://www.amazon.fr/s?k=' + encodeURIComponent(q) },
    { domain: 'cdiscount.com', build: (q) => 'https://www.cdiscount.com/search/10/' + encodeURIComponent(q) + '.html' },
    { domain: 'fnac.com', build: (q) => 'https://www.fnac.com/SearchResult/ResultList.aspx?Search=' + encodeURIComponent(q) }
  ],
  ja: [
    { domain: 'amazon.co.jp', build: (q) => 'https://www.amazon.co.jp/s?k=' + encodeURIComponent(q) },
    { domain: 'rakuten.co.jp', build: (q) => 'https://search.rakuten.co.jp/search/mall/' + encodeURIComponent(q) + '/' }
  ],
  ko: [
    { domain: 'coupang.com', build: (q) => 'https://www.coupang.com/np/search?component=&q=' + encodeURIComponent(q) },
    { domain: '11st.co.kr', build: (q) => 'https://search.11st.co.kr/Search.tmall?kwd=' + encodeURIComponent(q) }
  ]
};

const POISON_NEWS_SITES = {
  id: [
    { domain: 'detik.com', url: 'https://www.detik.com/' },
    { domain: 'kompas.com', url: 'https://www.kompas.com/' },
    { domain: 'cnnindonesia.com', url: 'https://www.cnnindonesia.com/' },
    { domain: 'tempo.co', url: 'https://www.tempo.co/' },
    { domain: 'tribunnews.com', url: 'https://www.tribunnews.com/' },
    { domain: 'liputan6.com', url: 'https://www.liputan6.com/' },
    { domain: 'republika.co.id', url: 'https://www.republika.co.id/' },
    { domain: 'antaranews.com', url: 'https://www.antaranews.com/' }
  ],
  en: [
    { domain: 'bbc.com', url: 'https://www.bbc.com/news' },
    { domain: 'reuters.com', url: 'https://www.reuters.com/' },
    { domain: 'apnews.com', url: 'https://apnews.com/' },
    { domain: 'npr.org', url: 'https://www.npr.org/sections/news/' },
    { domain: 'theguardian.com', url: 'https://www.theguardian.com/international' },
    { domain: 'cnbc.com', url: 'https://www.cnbc.com/world/' },
    { domain: 'aljazeera.com', url: 'https://www.aljazeera.com/' }
  ],
  es: [
    { domain: 'elpais.com', url: 'https://elpais.com/' },
    { domain: 'elmundo.es', url: 'https://www.elmundo.es/' },
    { domain: 'clarin.com', url: 'https://www.clarin.com/' }
  ],
  pt: [
    { domain: 'g1.globo.com', url: 'https://g1.globo.com/' },
    { domain: 'uol.com.br', url: 'https://www.uol.com.br/' },
    { domain: 'estadao.com.br', url: 'https://www.estadao.com.br/' }
  ],
  de: [
    { domain: 'tagesschau.de', url: 'https://www.tagesschau.de/' },
    { domain: 'spiegel.de', url: 'https://www.spiegel.de/' },
    { domain: 'zeit.de', url: 'https://www.zeit.de/index' }
  ],
  fr: [
    { domain: 'lemonde.fr', url: 'https://www.lemonde.fr/' },
    { domain: 'lefigaro.fr', url: 'https://www.lefigaro.fr/' },
    { domain: 'france24.com', url: 'https://www.france24.com/fr/' }
  ],
  ja: [
    { domain: 'nhk.or.jp', url: 'https://www3.nhk.or.jp/news/' },
    { domain: 'asahi.com', url: 'https://www.asahi.com/' },
    { domain: 'yomiuri.co.jp', url: 'https://www.yomiuri.co.jp/' }
  ],
  ko: [
    { domain: 'news.naver.com', url: 'https://news.naver.com/' },
    { domain: 'chosun.com', url: 'https://www.chosun.com/' },
    { domain: 'hani.co.kr', url: 'https://www.hani.co.kr/' }
  ]
};

// File persistence di userData — sessionCount, learned weights, & blocklist
// domain SELAMAT dari restart OS, gak balik ke nol tiap kali dibuka ulang.
const POISON_STATE_FILE = path.join(app.getPath('userData'), 'poison-engine-state.json');

// Setiap fingerprint = kombinasi UA (browser+OS) + negara/timezone + bahasa Accept-Language + device class.
// Dikelompokkin biar realistis: UA Windows gak bakal ketiban timezone/locale yang gak nyambung,
// device mobile dapet viewport & UA mobile beneran, dst — bukan campur random asal jadi.
const POISON_FINGERPRINTS = [
  // ---- Desktop, Indonesia ----
  { country: 'ID', tz: 'Asia/Jakarta', lang: 'id',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    acceptLang: 'id-ID,id;q=0.9,en-US;q=0.8', device: 'desktop', viewport: { width: 1366, height: 768 } },
  { country: 'ID', tz: 'Asia/Jakarta', lang: 'id',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
    acceptLang: 'id-ID,id;q=0.9,en-US;q=0.7', device: 'desktop', viewport: { width: 1536, height: 864 } },
  { country: 'ID', tz: 'Asia/Jakarta', lang: 'id',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    acceptLang: 'id-ID,id;q=0.9', device: 'desktop', viewport: { width: 1280, height: 800 } },
  // ---- Desktop, US ----
  { country: 'US', tz: 'America/New_York', lang: 'en',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    acceptLang: 'en-US,en;q=0.9', device: 'desktop', viewport: { width: 1440, height: 900 } },
  { country: 'US', tz: 'America/Los_Angeles', lang: 'en',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    acceptLang: 'en-US,en;q=0.9', device: 'desktop', viewport: { width: 1920, height: 1080 } },
  { country: 'US', tz: 'America/Chicago', lang: 'en',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    acceptLang: 'en-US,en;q=0.9', device: 'desktop', viewport: { width: 1600, height: 900 } },
  // ---- Desktop, Spanyol/Meksiko ----
  { country: 'ES', tz: 'Europe/Madrid', lang: 'es',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    acceptLang: 'es-ES,es;q=0.9,en;q=0.6', device: 'desktop', viewport: { width: 1366, height: 768 } },
  { country: 'MX', tz: 'America/Mexico_City', lang: 'es',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    acceptLang: 'es-MX,es;q=0.9,en;q=0.5', device: 'desktop', viewport: { width: 1440, height: 900 } },
  // ---- Desktop, Brasil ----
  { country: 'BR', tz: 'America/Sao_Paulo', lang: 'pt',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    acceptLang: 'pt-BR,pt;q=0.9,en;q=0.5', device: 'desktop', viewport: { width: 1366, height: 768 } },
  // ---- Desktop, Jerman ----
  { country: 'DE', tz: 'Europe/Berlin', lang: 'de',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
    acceptLang: 'de-DE,de;q=0.9,en;q=0.6', device: 'desktop', viewport: { width: 1536, height: 864 } },
  // ---- Desktop, Prancis ----
  { country: 'FR', tz: 'Europe/Paris', lang: 'fr',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    acceptLang: 'fr-FR,fr;q=0.9,en;q=0.5', device: 'desktop', viewport: { width: 1440, height: 900 } },
  // ---- Desktop, Jepang ----
  { country: 'JP', tz: 'Asia/Tokyo', lang: 'ja',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    acceptLang: 'ja-JP,ja;q=0.9,en;q=0.4', device: 'desktop', viewport: { width: 1920, height: 1080 } },
  // ---- Desktop, Korea Selatan ----
  { country: 'KR', tz: 'Asia/Seoul', lang: 'ko',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    acceptLang: 'ko-KR,ko;q=0.9,en;q=0.4', device: 'desktop', viewport: { width: 1600, height: 900 } },
  // ---- Mobile, Indonesia (Android) ----
  { country: 'ID', tz: 'Asia/Jakarta', lang: 'id',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
    acceptLang: 'id-ID,id;q=0.9,en-US;q=0.7', device: 'mobile', viewport: { width: 412, height: 915 } },
  { country: 'ID', tz: 'Asia/Jakarta', lang: 'id',
    ua: 'Mozilla/5.0 (Linux; Android 13; Redmi Note 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    acceptLang: 'id-ID,id;q=0.9', device: 'mobile', viewport: { width: 393, height: 851 } },
  // ---- Mobile, US (iPhone) ----
  { country: 'US', tz: 'America/New_York', lang: 'en',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    acceptLang: 'en-US,en;q=0.9', device: 'mobile', viewport: { width: 390, height: 844 } },
  // ---- Mobile, Jepang (iPhone) ----
  { country: 'JP', tz: 'Asia/Tokyo', lang: 'ja',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    acceptLang: 'ja-JP,ja;q=0.9', device: 'mobile', viewport: { width: 390, height: 844 } },
  // ---- Tablet, Jerman (iPad) ----
  { country: 'DE', tz: 'Europe/Berlin', lang: 'de',
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    acceptLang: 'de-DE,de;q=0.9,en;q=0.5', device: 'tablet', viewport: { width: 820, height: 1180 } }
];

function poisonQueryPoolsForLang(lang) {
  return Object.values(POISON_QUERY_POOLS).filter((pool) => pool.lang === lang);
}

const POISON_MIN_GAP_MS = 3 * 60 * 1000;   // jeda antar sesi minimal 3 menit
const POISON_MAX_GAP_MS = 8 * 60 * 1000;   // maksimal 8 menit (rate limiter, biar gak nyurigain/ngeflood)
const POISON_MIN_DWELL_MS = 8 * 1000;      // minimal 8 detik "baca" halaman
const POISON_MAX_DWELL_MS = 25 * 1000;     // maksimal 25 detik

const poisonState = {
  active: false,
  sessionCount: 0,
  queryCount: 0,
  log: [],              // { time, type, query, url }
  timer: null,
  currentGhost: null,   // BrowserWindow yang lagi jalan, kalau ada
  typeWeights: {},       // { [targetType]: multiplier 0.2–2.0 } — "belajar" dari sukses/gagal
  domainBlocklist: {}    // { [domain]: expiresAtTimestampMs } — skip sementara abis kena captcha/block
};

// Muat sessionCount/queryCount/weights/blocklist dari disk pas engine di-load,
// biar gak reset ke nol tiap kali OS di-restart.
function poisonLoadPersisted() {
  try {
    const raw = fs.readFileSync(POISON_STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    poisonState.sessionCount = data.sessionCount || 0;
    poisonState.queryCount = data.queryCount || 0;
    poisonState.typeWeights = data.typeWeights || {};
    poisonState.domainBlocklist = data.domainBlocklist || {};
  } catch (e) { /* belum ada file atau rusak — mulai dari default, aman diabaikan */ }
}

let poisonSaveTimer = null;
function poisonSavePersisted() {
  // Debounce dikit biar gak nulis file berkali-kali pas beberapa event numpuk beruntun.
  if (poisonSaveTimer) clearTimeout(poisonSaveTimer);
  poisonSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(POISON_STATE_FILE, JSON.stringify({
        sessionCount: poisonState.sessionCount,
        queryCount: poisonState.queryCount,
        typeWeights: poisonState.typeWeights,
        domainBlocklist: poisonState.domainBlocklist
      }, null, 2));
    } catch (e) { /* disk penuh / permission error, aman diabaikan — gak fatal buat engine */ }
  }, 400);
}

// Naikin/turunin bobot satu tipe target berdasarkan hasil sesi (sukses = naik dikit,
// kena block/error = turun) supaya lama-lama engine lebih sering milih tipe yang aman
// dan lebih jarang milih yang sering kena captcha.
function poisonAdjustWeight(type, delta) {
  const cur = typeof poisonState.typeWeights[type] === 'number' ? poisonState.typeWeights[type] : 1;
  poisonState.typeWeights[type] = Math.min(2, Math.max(0.2, cur + delta));
}

function poisonDomainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function poisonIsDomainBlocked(domain) {
  const until = poisonState.domainBlocklist[domain];
  return !!(until && until > Date.now());
}

function poisonBlockDomain(domain, ms) {
  if (!domain) return;
  poisonState.domainBlocklist[domain] = Date.now() + ms;
}

poisonLoadPersisted();

function poisonRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function poisonRandomRange(min, max) {
  return min + Math.random() * (max - min);
}

function poisonSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function poisonPushLog(entry) {
  poisonState.log.unshift({ time: Date.now(), ...entry });
  if (poisonState.log.length > 100) {
    poisonState.log = poisonState.log.slice(0, 100);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('poison-activity', poisonState.log[0]);
  }
}

// Domain Wikipedia lokal per bahasa — biar "orang Jepang" beneran baca Wikipedia Jepang,
// bukan tiba-tiba nyasar ke domain bahasa lain yang gak nyambung sama fingerprint-nya.
const POISON_WIKI_DOMAIN = {
  id: 'id.wikipedia.org', en: 'en.wikipedia.org', es: 'es.wikipedia.org',
  pt: 'pt.wikipedia.org', de: 'de.wikipedia.org', fr: 'fr.wikipedia.org',
  ja: 'ja.wikipedia.org', ko: 'ko.wikipedia.org'
};

function poisonPickFingerprint() {
  return poisonRandom(POISON_FINGERPRINTS);
}

// Bobot dasar per tipe target — di-scale lagi sama poisonState.typeWeights
// (belajar dari histori sukses/gagal) sebelum weighted-random dipilih.
const POISON_BASE_TYPE_WEIGHTS = {
  'google-search': 26,
  'youtube-search': 16,
  'ecommerce-search': 16,
  'news-browse': 14,
  'wikipedia': 18,
  'reddit-random': 10
};

function poisonEffectiveWeight(type) {
  const base = POISON_BASE_TYPE_WEIGHTS[type] || 10;
  const learned = poisonState.typeWeights[type];
  const factor = typeof learned === 'number' ? Math.min(2, Math.max(0.2, learned)) : 1;
  return base * factor;
}

function poisonWeightedPick(candidates) {
  const usable = candidates.filter((c) => c.weight > 0);
  const total = usable.reduce((s, c) => s + c.weight, 0);
  if (!total) return candidates[0];
  let r = Math.random() * total;
  for (const c of usable) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return usable[usable.length - 1];
}

function poisonPickTarget(fingerprint) {
  const lang = fingerprint.lang;
  const wikiDomain = POISON_WIKI_DOMAIN[lang] || 'en.wikipedia.org';
  // Query dicari HANYA dari pool bahasa yang sama sama fingerprint —
  // orang "Jerman" gak bakal tiba-tiba search "resep sambal matah".
  const pools = poisonQueryPoolsForLang(lang);
  const pickQuery = () => {
    const pool = pools.length ? poisonRandom(pools) : poisonRandom(Object.values(POISON_QUERY_POOLS));
    return poisonRandom(pool.items);
  };

  const candidates = [];

  candidates.push({
    key: 'google-search', domain: 'google.com', weight: poisonEffectiveWeight('google-search'),
    build: () => {
      const query = pickQuery();
      return {
        type: 'google-search', query,
        url: 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&hl=' + lang,
        useTyping: Math.random() < 0.4, homeUrl: 'https://www.google.com/?hl=' + lang,
        inputSelector: 'textarea[name="q"], input[name="q"]'
      };
    }
  });

  candidates.push({
    key: 'youtube-search', domain: 'youtube.com', weight: poisonEffectiveWeight('youtube-search'),
    build: () => {
      const query = pickQuery();
      return {
        type: 'youtube-search', query,
        url: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query),
        useTyping: Math.random() < 0.3, homeUrl: 'https://www.youtube.com/',
        inputSelector: 'input#search, input[name="search_query"]'
      };
    }
  });

  const ecomSites = POISON_ECOMMERCE_SITES[lang] || POISON_ECOMMERCE_SITES.en;
  if (ecomSites && ecomSites.length) {
    candidates.push({
      key: 'ecommerce-search', domain: null, weight: poisonEffectiveWeight('ecommerce-search'),
      build: () => {
        const site = poisonRandom(ecomSites);
        const query = pickQuery();
        return { type: 'ecommerce-search', query, url: site.build(query), useTyping: false };
      }
    });
  }

  const newsSites = POISON_NEWS_SITES[lang] || POISON_NEWS_SITES.en;
  if (newsSites && newsSites.length) {
    candidates.push({
      key: 'news-browse', domain: null, weight: poisonEffectiveWeight('news-browse'),
      build: () => {
        const site = poisonRandom(newsSites);
        return { type: 'news-browse', query: null, url: site.url, useTyping: false };
      }
    });
  }

  candidates.push({
    key: 'wikipedia', domain: wikiDomain, weight: poisonEffectiveWeight('wikipedia'),
    build: () => {
      // 45% artikel beneran random, 55% search topik yang nyambung sama pool bahasa
      // ini sendiri — biar gak monoton "Special:Random" mulu, lebih mirip pola orang beneran.
      if (Math.random() < 0.45 || !pools.length) {
        return { type: 'wikipedia-random', query: null, url: 'https://' + wikiDomain + '/wiki/Special:Random', useTyping: false };
      }
      const query = pickQuery();
      return {
        type: 'wikipedia-search', query,
        url: 'https://' + wikiDomain + '/w/index.php?search=' + encodeURIComponent(query) + '&fulltext=1',
        useTyping: false
      };
    }
  });

  candidates.push({
    key: 'reddit-random', domain: 'reddit.com', weight: poisonEffectiveWeight('reddit-random'),
    build: () => ({ type: 'reddit-random', query: null, url: 'https://www.reddit.com/r/random/', useTyping: false })
  });

  // Buang kandidat yang domainnya lagi di-blocklist sementara (abis kena captcha/blocked
  // barusan). Kalau semua ke-block (jarang banget), tetep pakai daftar penuh biar gak macet.
  const filtered = candidates.filter((c) => !c.domain || !poisonIsDomainBlocked(c.domain));
  const pool = filtered.length ? filtered : candidates;
  const chosen = poisonWeightedPick(pool);
  return chosen.build();
}

function poisonBezierPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
    y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
  };
}

// Gerakin mouse pakai sendInputEvent (native input, event.isTrusted === true),
// bukan dispatchEvent dari JS (yang gampang kebaca sebagai bukan gerakan asli).
// Lintasannya lewat kurva bezier acak, bukan garis lurus antar dua titik.
async function poisonSimulateMouseMove(webContents, viewport) {
  if (webContents.isDestroyed()) return;
  const start = { x: poisonRandomRange(20, viewport.width - 20), y: poisonRandomRange(20, viewport.height - 20) };
  const end = { x: poisonRandomRange(20, viewport.width - 20), y: poisonRandomRange(20, viewport.height - 20) };
  const ctrl1 = { x: poisonRandomRange(0, viewport.width), y: poisonRandomRange(0, viewport.height) };
  const ctrl2 = { x: poisonRandomRange(0, viewport.width), y: poisonRandomRange(0, viewport.height) };
  const steps = 14 + Math.floor(Math.random() * 10);
  for (let i = 0; i <= steps; i++) {
    if (webContents.isDestroyed()) return;
    const pt = poisonBezierPoint(start, ctrl1, ctrl2, end, i / steps);
    try { webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(pt.x), y: Math.round(pt.y) }); } catch (e) {}
    await poisonSleep(12 + Math.random() * 28);
  }
}

// Kadang orang beneran cuma diem mikir 10-60 detik di tengah baca. ~18% chance per sesi.
async function poisonMaybeIdle() {
  if (Math.random() < 0.18) {
    await poisonSleep(poisonRandomRange(10000, 60000));
  }
}

async function poisonClickAt(webContents, x, y) {
  try {
    webContents.sendInputEvent({ type: 'mouseMove', x, y });
    webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await poisonSleep(40 + Math.random() * 80);
    webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  } catch (e) {}
}

// Ngetik karakter demi karakter lewat keyboard event trusted, sesekali ada "typo"
// kecil yang langsung dibenerin (backspace) — bukan value yang di-set langsung
// lewat JS, yang ritmenya gak natural dan gampang kedeteksi.
async function poisonSimulateTyping(webContents, text) {
  for (const ch of text) {
    if (webContents.isDestroyed()) return;
    if (Math.random() < 0.04 && /[a-z]/i.test(ch)) {
      const typo = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
      try {
        webContents.sendInputEvent({ type: 'keyDown', keyCode: typo });
        webContents.sendInputEvent({ type: 'char', keyCode: typo });
        webContents.sendInputEvent({ type: 'keyUp', keyCode: typo });
      } catch (e) {}
      await poisonSleep(60 + Math.random() * 120);
      try {
        webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
      } catch (e) {}
      await poisonSleep(80 + Math.random() * 140);
    }
    try {
      webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      webContents.sendInputEvent({ type: 'char', keyCode: ch });
      webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    } catch (e) {}
    await poisonSleep(55 + Math.random() * 160);
  }
}

// Buat sebagian sesi search (useTyping), buka homepage dulu, klik kolom
// search-nya beneran (bukan .value = ... lewat JS), baru ngetik pelan-pelan
// dan pencet Enter — trajektorinya lebih mirip manusia dibanding langsung
// loadURL ke URL hasil pencarian.
async function poisonTrySearchByTyping(webContents, target) {
  if (!target.useTyping || !target.homeUrl || !target.inputSelector) return false;
  try {
    await webContents.loadURL(target.homeUrl);
    await poisonSleep(1200 + Math.random() * 800);
    const rect = await webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector(${JSON.stringify(target.inputSelector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })();
    `).catch(() => null);
    if (!rect || rect.w <= 0) return false;
    await poisonClickAt(webContents, Math.round(rect.x), Math.round(rect.y));
    await poisonSleep(300 + Math.random() * 400);
    await poisonSimulateTyping(webContents, target.query);
    await poisonSleep(250 + Math.random() * 350);
    try {
      webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    } catch (e) {}
    await poisonSleep(1500 + Math.random() * 1200);
    return true;
  } catch (e) {
    return false;
  }
}

// Tanda-tanda halaman lagi nampilin captcha / "unusual traffic" / blokir bot.
// Dicek dari title + potongan teks body, bukan cuma status code (yang sering 200
// meski isinya captcha).
const POISON_BLOCK_SIGNALS = [
  'unusual traffic', 'captcha', 'verify you are human', 'are you a robot',
  'access denied', 'enable javascript and cookies', 'automated queries',
  'terlalu banyak permintaan', 'akses ditolak', 'robot check', 'pardon our interruption'
];

async function poisonCheckBlocked(webContents) {
  try {
    const text = await webContents.executeJavaScript(`
      (function() {
        const t = (document.title || '') + ' ' + (document.body ? document.body.innerText.slice(0, 2000) : '');
        return t.toLowerCase();
      })();
    `);
    return POISON_BLOCK_SIGNALS.some((s) => text.includes(s));
  } catch (e) {
    return false;
  }
}

async function poisonSimulateBehavior(webContents, deviceClass, viewport) {
  const isMobile = deviceClass === 'mobile' || deviceClass === 'tablet';

  // Mouse trajectory cuma masuk akal buat desktop (mobile gak punya cursor).
  if (!isMobile && viewport) {
    await poisonSimulateMouseMove(webContents, viewport);
  }

  await poisonMaybeIdle();

  // Mobile/tablet: scroll lebih pendek-pendek & lebih sering (kebiasaan swipe jempol),
  // desktop: scroll lebih jarang tapi jarak per scroll lebih jauh (kebiasaan mouse wheel).
  const scrollSteps = isMobile ? 4 + Math.floor(Math.random() * 5) : 3 + Math.floor(Math.random() * 4);
  const deltaRange = isMobile ? [80, 260] : [120, 420];
  const pauseRange = isMobile ? [500, 1800] : [700, 2400];

  for (let i = 0; i < scrollSteps; i++) {
    if (webContents.isDestroyed()) return;
    const delta = deltaRange[0] + Math.floor(Math.random() * (deltaRange[1] - deltaRange[0]));
    try {
      await webContents.executeJavaScript(`window.scrollBy({ top: ${delta}, behavior: 'smooth' });`);
    } catch (e) { /* halaman mungkin belum siap / navigasi lain, aman diabaikan */ }
    await poisonSleep(poisonRandomRange(pauseRange[0], pauseRange[1]));
  }

  if (webContents.isDestroyed()) return;

  // 20% chance balik scroll ke atas 1-2 kali, kayak orang mau baca ulang sesuatu.
  if (Math.random() < 0.2) {
    const upTimes = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < upTimes; i++) {
      if (webContents.isDestroyed()) return;
      const delta = 150 + Math.floor(Math.random() * 300);
      try {
        await webContents.executeJavaScript(`window.scrollBy({ top: -${delta}, behavior: 'smooth' });`);
      } catch (e) { /* aman diabaikan */ }
      await poisonSleep(poisonRandomRange(500, 1600));
    }
  }

  if (webContents.isDestroyed()) return;

  // Mobile lebih jarang "klik nyasar" ke link kecil (elemen sentuh perlu presisi lebih),
  // jadi peluang klik link dikecilin dikit dibanding desktop.
  const clickChance = isMobile ? 0.6 : 0.85;
  if (Math.random() > clickChance) return;

  try {
    await webContents.executeJavaScript(`
      (function() {
        const links = Array.from(document.querySelectorAll('a[href]')).filter(function(a) {
          const r = a.getBoundingClientRect();
          const minSize = ${isMobile ? 20 : 10};
          return r.top > 40 && r.top < window.innerHeight - 40 && r.width > minSize && r.height > minSize / 2;
        });
        if (links.length) {
          const el = links[Math.floor(Math.random() * links.length)];
          el.click();
        }
        true;
      })();
    `);
  } catch (e) { /* gak masalah kalau gagal klik, sesi tetap dianggap valid */ }
}

async function poisonRunSession() {
  if (!poisonState.active) return;

  const fingerprint = poisonPickFingerprint();
  const target = poisonPickTarget(fingerprint);
  const partition = `poison-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const viewport = fingerprint.viewport;

  const ghost = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      images: true
    }
  });

  poisonState.currentGhost = ghost;

  try {
    ghost.webContents.setUserAgent(fingerprint.ua);

    const ghostSession = session.fromPartition(partition);
    ghostSession.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['Accept-Language'] = fingerprint.acceptLang;
      // Paksa Electron nembak timezone sesuai fingerprint biar Date/Intl API
      // konsisten sama negara yang lagi "dipakai" — bukan ke-leak timezone asli lu.
      callback({ requestHeaders: details.requestHeaders });
    });

    try {
      // Electron 22+: override timezone per-session biar Intl.DateTimeFormat()
      // dan new Date() di halaman yang dibuka ikut fingerprint, bukan timezone OS asli.
      if (typeof ghostSession.setTimezoneOverride === 'function') {
        ghostSession.setTimezoneOverride(fingerprint.tz);
      }
    } catch (e) { /* versi Electron lama gak punya API ini, aman diabaikan */ }

    poisonState.sessionCount += 1;
    if (target.query) poisonState.queryCount += 1;

    // typeKey = kategori buat weight-learning (beberapa target.type mengarah ke kategori sama,
    // misal wikipedia-random & wikipedia-search sama-sama 'wikipedia').
    const typeKey = target.type.indexOf('wikipedia') === 0 ? 'wikipedia' : target.type;

    poisonPushLog({
      type: target.type,
      query: target.query,
      url: target.url,
      status: 'started',
      fingerprint: {
        country: fingerprint.country,
        lang: fingerprint.lang,
        device: fingerprint.device
      }
    });

    // Sebagian sesi search "ngetik beneran" di kolom search (lebih mahal tapi lebih
    // natural); sisanya langsung loadURL ke hasil pencarian kayak sebelumnya.
    let typedIn = false;
    if (target.useTyping) {
      typedIn = await poisonTrySearchByTyping(ghost.webContents, target);
    }
    if (!typedIn) {
      await ghost.loadURL(target.url).catch(() => {});
      await poisonSleep(1500 + Math.random() * 1500); // kasih waktu halaman render dulu
    }

    const blocked = !ghost.isDestroyed() && poisonState.active && await poisonCheckBlocked(ghost.webContents);

    if (blocked) {
      // Ketauan captcha/unusual-traffic — jangan lanjut simulasi perilaku di halaman ini,
      // skip domainnya buat beberapa jam, dan turunin bobot tipe target ini dikit.
      const domain = poisonDomainFromUrl(target.url);
      poisonBlockDomain(domain, 4 * 60 * 60 * 1000 + Math.random() * 2 * 60 * 60 * 1000); // 4-6 jam
      poisonAdjustWeight(typeKey, -0.3);

      poisonPushLog({
        type: target.type, query: target.query, url: target.url, status: 'blocked', domain,
        fingerprint: { country: fingerprint.country, lang: fingerprint.lang, device: fingerprint.device }
      });
    } else {
      if (!ghost.isDestroyed() && poisonState.active) {
        await poisonSimulateBehavior(ghost.webContents, fingerprint.device, viewport);
      }

      const dwell = poisonRandomRange(POISON_MIN_DWELL_MS, POISON_MAX_DWELL_MS);
      await poisonSleep(dwell);
      poisonAdjustWeight(typeKey, 0.05);

      poisonPushLog({
        type: target.type,
        query: target.query,
        url: target.url,
        status: 'done',
        fingerprint: { country: fingerprint.country, lang: fingerprint.lang, device: fingerprint.device }
      });
    }

    poisonSavePersisted();
  } catch (e) {
    const typeKey = target.type.indexOf('wikipedia') === 0 ? 'wikipedia' : target.type;
    poisonAdjustWeight(typeKey, -0.15);
    poisonPushLog({
      type: target.type, query: target.query, url: target.url, status: 'error', error: e.message,
      fingerprint: { country: fingerprint.country, lang: fingerprint.lang, device: fingerprint.device }
    });
    poisonSavePersisted();
  } finally {
    try {
      if (!ghost.isDestroyed()) ghost.destroy();
    } catch (e) {}
    if (poisonState.currentGhost === ghost) poisonState.currentGhost = null;
  }

  if (poisonState.active) {
    const gap = poisonRandomRange(POISON_MIN_GAP_MS, POISON_MAX_GAP_MS);
    poisonState.timer = setTimeout(poisonRunSession, gap);
  }
}

function poisonStart() {
  if (poisonState.active) return poisonGetStatus();

  poisonState.active = true;
  poisonPushLog({ type: 'engine', query: null, url: null, status: 'engine-started' });

  // Sesi pertama jalan cepat (dalam beberapa detik) biar berasa responsif pas ditoggle,
  // sesi berikutnya baru ngikutin rate limiter normal.
  poisonState.timer = setTimeout(poisonRunSession, 2000 + Math.random() * 3000);

  return poisonGetStatus();
}

function poisonStop() {
  poisonState.active = false;

  if (poisonState.timer) {
    clearTimeout(poisonState.timer);
    poisonState.timer = null;
  }

  if (poisonState.currentGhost && !poisonState.currentGhost.isDestroyed()) {
    try { poisonState.currentGhost.destroy(); } catch (e) {}
  }
  poisonState.currentGhost = null;

  poisonPushLog({ type: 'engine', query: null, url: null, status: 'engine-stopped' });

  return poisonGetStatus();
}

function poisonGetStatus() {
  const now = Date.now();
  const blockedDomains = Object.keys(poisonState.domainBlocklist).filter((d) => poisonState.domainBlocklist[d] > now);
  return {
    active: poisonState.active,
    sessionCount: poisonState.sessionCount,
    queryCount: poisonState.queryCount,
    blockedDomains,
    typeWeights: poisonState.typeWeights,
    log: poisonState.log.slice(0, 30)
  };
}

app.on('before-quit', () => {
  try { poisonStop(); } catch (e) {}
});

// ---- IPC HANDLERS: DATA POISONING ENGINE ----

ipcMain.handle('poison-start', () => poisonStart());
ipcMain.handle('poison-stop', () => poisonStop());
ipcMain.handle('poison-status', () => poisonGetStatus());

// ==================================
// GEOLOCATION & TIME SPOOFER
// ==================================
// Override navigator.geolocation, navigator.language/languages, header
// Accept-Language, dan timezone Date/Intl di SEMUA tab browser (bawaan
// akhtarBrowser, pakai session.defaultSession) supaya web ngeliat lu
// seolah-olah lagi browsing dari negara/kota lain. Timezone di-paksa di
// level native Electron (session.setTimezoneOverride) biar Date/Intl API
// beneran konsisten; geolocation & bahasa gak punya API native-nya jadi
// disuntik lewat CDP (Page.addScriptToEvaluateOnNewDocument) biar kepasang
// SEBELUM script apapun di halaman sempat jalan — bukan cuma dom-ready
// yang gampang kedahuluan script deteksi fingerprint.
//
// 27 negara x beberapa kota (100+ lokasi total).

const SPOOF_COUNTRIES = [
  { code: 'ID', name: 'Indonesia', flag: '🇮🇩', locale: 'id-ID' },
  { code: 'US', name: 'Amerika Serikat', flag: '🇺🇸', locale: 'en-US' },
  { code: 'GB', name: 'Inggris', flag: '🇬🇧', locale: 'en-GB' },
  { code: 'JP', name: 'Jepang', flag: '🇯🇵', locale: 'ja-JP' },
  { code: 'KR', name: 'Korea Selatan', flag: '🇰🇷', locale: 'ko-KR' },
  { code: 'CN', name: 'China', flag: '🇨🇳', locale: 'zh-CN' },
  { code: 'SG', name: 'Singapura', flag: '🇸🇬', locale: 'en-SG' },
  { code: 'MY', name: 'Malaysia', flag: '🇲🇾', locale: 'ms-MY' },
  { code: 'TH', name: 'Thailand', flag: '🇹🇭', locale: 'th-TH' },
  { code: 'VN', name: 'Vietnam', flag: '🇻🇳', locale: 'vi-VN' },
  { code: 'PH', name: 'Filipina', flag: '🇵🇭', locale: 'fil-PH' },
  { code: 'IN', name: 'India', flag: '🇮🇳', locale: 'en-IN' },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', locale: 'en-AU' },
  { code: 'DE', name: 'Jerman', flag: '🇩🇪', locale: 'de-DE' },
  { code: 'FR', name: 'Prancis', flag: '🇫🇷', locale: 'fr-FR' },
  { code: 'ES', name: 'Spanyol', flag: '🇪🇸', locale: 'es-ES' },
  { code: 'IT', name: 'Italia', flag: '🇮🇹', locale: 'it-IT' },
  { code: 'NL', name: 'Belanda', flag: '🇳🇱', locale: 'nl-NL' },
  { code: 'RU', name: 'Rusia', flag: '🇷🇺', locale: 'ru-RU' },
  { code: 'BR', name: 'Brasil', flag: '🇧🇷', locale: 'pt-BR' },
  { code: 'MX', name: 'Meksiko', flag: '🇲🇽', locale: 'es-MX' },
  { code: 'CA', name: 'Kanada', flag: '🇨🇦', locale: 'en-CA' },
  { code: 'AE', name: 'Uni Emirat Arab', flag: '🇦🇪', locale: 'ar-AE' },
  { code: 'SA', name: 'Arab Saudi', flag: '🇸🇦', locale: 'ar-SA' },
  { code: 'TR', name: 'Turki', flag: '🇹🇷', locale: 'tr-TR' },
  { code: 'EG', name: 'Mesir', flag: '🇪🇬', locale: 'ar-EG' },
  { code: 'ZA', name: 'Afrika Selatan', flag: '🇿🇦', locale: 'en-ZA' }
];

// locale di tiap lokasi cuma diisi kalau BEDA dari default negaranya
// (contoh: Montreal pakai fr-CA, sementara kota Kanada lain en-CA).
const SPOOF_LOCATIONS = [
  // ---- Indonesia ----
  { id: 'id-jakarta', country: 'ID', city: 'Jakarta', lat: -6.2088, lng: 106.8456, tz: 'Asia/Jakarta' },
  { id: 'id-surabaya', country: 'ID', city: 'Surabaya', lat: -7.2575, lng: 112.7521, tz: 'Asia/Jakarta' },
  { id: 'id-bandung', country: 'ID', city: 'Bandung', lat: -6.9175, lng: 107.6191, tz: 'Asia/Jakarta' },
  { id: 'id-medan', country: 'ID', city: 'Medan', lat: 3.5952, lng: 98.6722, tz: 'Asia/Jakarta' },
  { id: 'id-denpasar', country: 'ID', city: 'Denpasar (Bali)', lat: -8.6705, lng: 115.2126, tz: 'Asia/Makassar' },
  { id: 'id-yogyakarta', country: 'ID', city: 'Yogyakarta', lat: -7.7956, lng: 110.3695, tz: 'Asia/Jakarta' },
  { id: 'id-makassar', country: 'ID', city: 'Makassar', lat: -5.1477, lng: 119.4327, tz: 'Asia/Makassar' },
  { id: 'id-semarang', country: 'ID', city: 'Semarang', lat: -6.9932, lng: 110.4203, tz: 'Asia/Jakarta' },

  // ---- Amerika Serikat ----
  { id: 'us-newyork', country: 'US', city: 'New York', lat: 40.7128, lng: -74.0060, tz: 'America/New_York' },
  { id: 'us-losangeles', country: 'US', city: 'Los Angeles', lat: 34.0522, lng: -118.2437, tz: 'America/Los_Angeles' },
  { id: 'us-chicago', country: 'US', city: 'Chicago', lat: 41.8781, lng: -87.6298, tz: 'America/Chicago' },
  { id: 'us-miami', country: 'US', city: 'Miami', lat: 25.7617, lng: -80.1918, tz: 'America/New_York' },
  { id: 'us-seattle', country: 'US', city: 'Seattle', lat: 47.6062, lng: -122.3321, tz: 'America/Los_Angeles' },
  { id: 'us-dallas', country: 'US', city: 'Dallas', lat: 32.7767, lng: -96.7970, tz: 'America/Chicago' },
  { id: 'us-denver', country: 'US', city: 'Denver', lat: 39.7392, lng: -104.9903, tz: 'America/Denver' },
  { id: 'us-honolulu', country: 'US', city: 'Honolulu', lat: 21.3069, lng: -157.8583, tz: 'Pacific/Honolulu' },
  { id: 'us-boston', country: 'US', city: 'Boston', lat: 42.3601, lng: -71.0589, tz: 'America/New_York' },
  { id: 'us-atlanta', country: 'US', city: 'Atlanta', lat: 33.7490, lng: -84.3880, tz: 'America/New_York' },

  // ---- Inggris ----
  { id: 'gb-london', country: 'GB', city: 'London', lat: 51.5074, lng: -0.1278, tz: 'Europe/London' },
  { id: 'gb-manchester', country: 'GB', city: 'Manchester', lat: 53.4808, lng: -2.2426, tz: 'Europe/London' },
  { id: 'gb-edinburgh', country: 'GB', city: 'Edinburgh', lat: 55.9533, lng: -3.1883, tz: 'Europe/London' },
  { id: 'gb-birmingham', country: 'GB', city: 'Birmingham', lat: 52.4862, lng: -1.8904, tz: 'Europe/London' },

  // ---- Jepang ----
  { id: 'jp-tokyo', country: 'JP', city: 'Tokyo', lat: 35.6762, lng: 139.6503, tz: 'Asia/Tokyo' },
  { id: 'jp-osaka', country: 'JP', city: 'Osaka', lat: 34.6937, lng: 135.5023, tz: 'Asia/Tokyo' },
  { id: 'jp-sapporo', country: 'JP', city: 'Sapporo', lat: 43.0618, lng: 141.3545, tz: 'Asia/Tokyo' },
  { id: 'jp-kyoto', country: 'JP', city: 'Kyoto', lat: 35.0116, lng: 135.7681, tz: 'Asia/Tokyo' },
  { id: 'jp-fukuoka', country: 'JP', city: 'Fukuoka', lat: 33.5904, lng: 130.4017, tz: 'Asia/Tokyo' },
  { id: 'jp-yokohama', country: 'JP', city: 'Yokohama', lat: 35.4437, lng: 139.6380, tz: 'Asia/Tokyo' },

  // ---- Korea Selatan ----
  { id: 'kr-seoul', country: 'KR', city: 'Seoul', lat: 37.5665, lng: 126.9780, tz: 'Asia/Seoul' },
  { id: 'kr-busan', country: 'KR', city: 'Busan', lat: 35.1796, lng: 129.0756, tz: 'Asia/Seoul' },
  { id: 'kr-incheon', country: 'KR', city: 'Incheon', lat: 37.4563, lng: 126.7052, tz: 'Asia/Seoul' },

  // ---- China ----
  { id: 'cn-beijing', country: 'CN', city: 'Beijing', lat: 39.9042, lng: 116.4074, tz: 'Asia/Shanghai' },
  { id: 'cn-shanghai', country: 'CN', city: 'Shanghai', lat: 31.2304, lng: 121.4737, tz: 'Asia/Shanghai' },
  { id: 'cn-shenzhen', country: 'CN', city: 'Shenzhen', lat: 22.5431, lng: 114.0579, tz: 'Asia/Shanghai' },
  { id: 'cn-chengdu', country: 'CN', city: 'Chengdu', lat: 30.5728, lng: 104.0668, tz: 'Asia/Shanghai' },
  { id: 'cn-guangzhou', country: 'CN', city: 'Guangzhou', lat: 23.1291, lng: 113.2644, tz: 'Asia/Shanghai' },
  { id: 'cn-xian', country: 'CN', city: "Xi'an", lat: 34.3416, lng: 108.9398, tz: 'Asia/Shanghai' },
  { id: 'cn-chongqing', country: 'CN', city: 'Chongqing', lat: 29.4316, lng: 106.9123, tz: 'Asia/Shanghai' },

  // ---- Singapura ----
  { id: 'sg-singapore', country: 'SG', city: 'Singapura', lat: 1.3521, lng: 103.8198, tz: 'Asia/Singapore' },

  // ---- Malaysia ----
  { id: 'my-kualalumpur', country: 'MY', city: 'Kuala Lumpur', lat: 3.1390, lng: 101.6869, tz: 'Asia/Kuala_Lumpur' },
  { id: 'my-penang', country: 'MY', city: 'Penang', lat: 5.4141, lng: 100.3288, tz: 'Asia/Kuala_Lumpur' },
  { id: 'my-johorbahru', country: 'MY', city: 'Johor Bahru', lat: 1.4927, lng: 103.7414, tz: 'Asia/Kuala_Lumpur' },

  // ---- Thailand ----
  { id: 'th-bangkok', country: 'TH', city: 'Bangkok', lat: 13.7563, lng: 100.5018, tz: 'Asia/Bangkok' },
  { id: 'th-chiangmai', country: 'TH', city: 'Chiang Mai', lat: 18.7883, lng: 98.9853, tz: 'Asia/Bangkok' },
  { id: 'th-phuket', country: 'TH', city: 'Phuket', lat: 7.8804, lng: 98.3923, tz: 'Asia/Bangkok' },

  // ---- Vietnam ----
  { id: 'vn-hanoi', country: 'VN', city: 'Hanoi', lat: 21.0278, lng: 105.8342, tz: 'Asia/Ho_Chi_Minh' },
  { id: 'vn-hcmc', country: 'VN', city: 'Ho Chi Minh City', lat: 10.8231, lng: 106.6297, tz: 'Asia/Ho_Chi_Minh' },
  { id: 'vn-danang', country: 'VN', city: 'Da Nang', lat: 16.0544, lng: 108.2022, tz: 'Asia/Ho_Chi_Minh' },

  // ---- Filipina ----
  { id: 'ph-manila', country: 'PH', city: 'Manila', lat: 14.5995, lng: 120.9842, tz: 'Asia/Manila' },
  { id: 'ph-cebu', country: 'PH', city: 'Cebu', lat: 10.3157, lng: 123.8854, tz: 'Asia/Manila' },
  { id: 'ph-davao', country: 'PH', city: 'Davao', lat: 7.1907, lng: 125.4553, tz: 'Asia/Manila' },

  // ---- India ----
  { id: 'in-mumbai', country: 'IN', city: 'Mumbai', lat: 19.0760, lng: 72.8777, tz: 'Asia/Kolkata' },
  { id: 'in-delhi', country: 'IN', city: 'Delhi', lat: 28.7041, lng: 77.1025, tz: 'Asia/Kolkata' },
  { id: 'in-bangalore', country: 'IN', city: 'Bangalore', lat: 12.9716, lng: 77.5946, tz: 'Asia/Kolkata' },
  { id: 'in-kolkata', country: 'IN', city: 'Kolkata', lat: 22.5726, lng: 88.3639, tz: 'Asia/Kolkata' },
  { id: 'in-chennai', country: 'IN', city: 'Chennai', lat: 13.0827, lng: 80.2707, tz: 'Asia/Kolkata' },
  { id: 'in-hyderabad', country: 'IN', city: 'Hyderabad', lat: 17.3850, lng: 78.4867, tz: 'Asia/Kolkata' },

  // ---- Australia ----
  { id: 'au-sydney', country: 'AU', city: 'Sydney', lat: -33.8688, lng: 151.2093, tz: 'Australia/Sydney' },
  { id: 'au-melbourne', country: 'AU', city: 'Melbourne', lat: -37.8136, lng: 144.9631, tz: 'Australia/Melbourne' },
  { id: 'au-perth', country: 'AU', city: 'Perth', lat: -31.9505, lng: 115.8605, tz: 'Australia/Perth' },
  { id: 'au-brisbane', country: 'AU', city: 'Brisbane', lat: -27.4698, lng: 153.0251, tz: 'Australia/Brisbane' },
  { id: 'au-adelaide', country: 'AU', city: 'Adelaide', lat: -34.9285, lng: 138.6007, tz: 'Australia/Adelaide' },

  // ---- Jerman ----
  { id: 'de-berlin', country: 'DE', city: 'Berlin', lat: 52.5200, lng: 13.4050, tz: 'Europe/Berlin' },
  { id: 'de-munich', country: 'DE', city: 'Munich', lat: 48.1351, lng: 11.5820, tz: 'Europe/Berlin' },
  { id: 'de-frankfurt', country: 'DE', city: 'Frankfurt', lat: 50.1109, lng: 8.6821, tz: 'Europe/Berlin' },
  { id: 'de-hamburg', country: 'DE', city: 'Hamburg', lat: 53.5511, lng: 9.9937, tz: 'Europe/Berlin' },
  { id: 'de-cologne', country: 'DE', city: 'Cologne', lat: 50.9375, lng: 6.9603, tz: 'Europe/Berlin' },

  // ---- Prancis ----
  { id: 'fr-paris', country: 'FR', city: 'Paris', lat: 48.8566, lng: 2.3522, tz: 'Europe/Paris' },
  { id: 'fr-marseille', country: 'FR', city: 'Marseille', lat: 43.2965, lng: 5.3698, tz: 'Europe/Paris' },
  { id: 'fr-lyon', country: 'FR', city: 'Lyon', lat: 45.7640, lng: 4.8357, tz: 'Europe/Paris' },
  { id: 'fr-nice', country: 'FR', city: 'Nice', lat: 43.7102, lng: 7.2620, tz: 'Europe/Paris' },

  // ---- Spanyol ----
  { id: 'es-madrid', country: 'ES', city: 'Madrid', lat: 40.4168, lng: -3.7038, tz: 'Europe/Madrid' },
  { id: 'es-barcelona', country: 'ES', city: 'Barcelona', lat: 41.3874, lng: 2.1686, tz: 'Europe/Madrid' },
  { id: 'es-valencia', country: 'ES', city: 'Valencia', lat: 39.4699, lng: -0.3763, tz: 'Europe/Madrid' },
  { id: 'es-seville', country: 'ES', city: 'Seville', lat: 37.3891, lng: -5.9845, tz: 'Europe/Madrid' },

  // ---- Italia ----
  { id: 'it-rome', country: 'IT', city: 'Rome', lat: 41.9028, lng: 12.4964, tz: 'Europe/Rome' },
  { id: 'it-milan', country: 'IT', city: 'Milan', lat: 45.4642, lng: 9.1900, tz: 'Europe/Rome' },
  { id: 'it-naples', country: 'IT', city: 'Naples', lat: 40.8518, lng: 14.2681, tz: 'Europe/Rome' },
  { id: 'it-florence', country: 'IT', city: 'Florence', lat: 43.7696, lng: 11.2558, tz: 'Europe/Rome' },

  // ---- Belanda ----
  { id: 'nl-amsterdam', country: 'NL', city: 'Amsterdam', lat: 52.3676, lng: 4.9041, tz: 'Europe/Amsterdam' },
  { id: 'nl-rotterdam', country: 'NL', city: 'Rotterdam', lat: 51.9244, lng: 4.4777, tz: 'Europe/Amsterdam' },
  { id: 'nl-thehague', country: 'NL', city: 'The Hague', lat: 52.0705, lng: 4.3007, tz: 'Europe/Amsterdam' },

  // ---- Rusia ----
  { id: 'ru-moscow', country: 'RU', city: 'Moscow', lat: 55.7558, lng: 37.6173, tz: 'Europe/Moscow' },
  { id: 'ru-stpetersburg', country: 'RU', city: 'Saint Petersburg', lat: 59.9311, lng: 30.3609, tz: 'Europe/Moscow' },
  { id: 'ru-novosibirsk', country: 'RU', city: 'Novosibirsk', lat: 55.0084, lng: 82.9357, tz: 'Asia/Novosibirsk' },
  { id: 'ru-vladivostok', country: 'RU', city: 'Vladivostok', lat: 43.1332, lng: 131.9113, tz: 'Asia/Vladivostok' },

  // ---- Brasil ----
  { id: 'br-saopaulo', country: 'BR', city: 'Sao Paulo', lat: -23.5505, lng: -46.6333, tz: 'America/Sao_Paulo' },
  { id: 'br-riodejaneiro', country: 'BR', city: 'Rio de Janeiro', lat: -22.9068, lng: -43.1729, tz: 'America/Sao_Paulo' },
  { id: 'br-brasilia', country: 'BR', city: 'Brasilia', lat: -15.8267, lng: -47.9218, tz: 'America/Sao_Paulo' },
  { id: 'br-manaus', country: 'BR', city: 'Manaus', lat: -3.1190, lng: -60.0217, tz: 'America/Manaus' },
  { id: 'br-salvador', country: 'BR', city: 'Salvador', lat: -12.9777, lng: -38.5016, tz: 'America/Bahia' },

  // ---- Meksiko ----
  { id: 'mx-mexicocity', country: 'MX', city: 'Mexico City', lat: 19.4326, lng: -99.1332, tz: 'America/Mexico_City' },
  { id: 'mx-tijuana', country: 'MX', city: 'Tijuana', lat: 32.5149, lng: -117.0382, tz: 'America/Tijuana' },
  { id: 'mx-cancun', country: 'MX', city: 'Cancun', lat: 21.1619, lng: -86.8515, tz: 'America/Cancun' },
  { id: 'mx-guadalajara', country: 'MX', city: 'Guadalajara', lat: 20.6597, lng: -103.3496, tz: 'America/Mexico_City' },

  // ---- Kanada ----
  { id: 'ca-toronto', country: 'CA', city: 'Toronto', lat: 43.6532, lng: -79.3832, tz: 'America/Toronto' },
  { id: 'ca-vancouver', country: 'CA', city: 'Vancouver', lat: 49.2827, lng: -123.1207, tz: 'America/Vancouver' },
  { id: 'ca-calgary', country: 'CA', city: 'Calgary', lat: 51.0447, lng: -114.0719, tz: 'America/Edmonton' },
  { id: 'ca-montreal', country: 'CA', city: 'Montreal', lat: 45.5019, lng: -73.5674, tz: 'America/Toronto', locale: 'fr-CA' },
  { id: 'ca-ottawa', country: 'CA', city: 'Ottawa', lat: 45.4215, lng: -75.6972, tz: 'America/Toronto' },

  // ---- Uni Emirat Arab ----
  { id: 'ae-dubai', country: 'AE', city: 'Dubai', lat: 25.2048, lng: 55.2708, tz: 'Asia/Dubai' },
  { id: 'ae-abudhabi', country: 'AE', city: 'Abu Dhabi', lat: 24.4539, lng: 54.3773, tz: 'Asia/Dubai' },
  { id: 'ae-sharjah', country: 'AE', city: 'Sharjah', lat: 25.3463, lng: 55.4209, tz: 'Asia/Dubai' },

  // ---- Arab Saudi ----
  { id: 'sa-riyadh', country: 'SA', city: 'Riyadh', lat: 24.7136, lng: 46.6753, tz: 'Asia/Riyadh' },
  { id: 'sa-jeddah', country: 'SA', city: 'Jeddah', lat: 21.4858, lng: 39.1925, tz: 'Asia/Riyadh' },
  { id: 'sa-mecca', country: 'SA', city: 'Mecca', lat: 21.3891, lng: 39.8579, tz: 'Asia/Riyadh' },

  // ---- Turki ----
  { id: 'tr-istanbul', country: 'TR', city: 'Istanbul', lat: 41.0082, lng: 28.9784, tz: 'Europe/Istanbul' },
  { id: 'tr-ankara', country: 'TR', city: 'Ankara', lat: 39.9334, lng: 32.8597, tz: 'Europe/Istanbul' },
  { id: 'tr-izmir', country: 'TR', city: 'Izmir', lat: 38.4237, lng: 27.1428, tz: 'Europe/Istanbul' },

  // ---- Mesir ----
  { id: 'eg-cairo', country: 'EG', city: 'Cairo', lat: 30.0444, lng: 31.2357, tz: 'Africa/Cairo' },
  { id: 'eg-alexandria', country: 'EG', city: 'Alexandria', lat: 31.2001, lng: 29.9187, tz: 'Africa/Cairo' },
  { id: 'eg-giza', country: 'EG', city: 'Giza', lat: 30.0131, lng: 31.2089, tz: 'Africa/Cairo' },

  // ---- Afrika Selatan ----
  { id: 'za-johannesburg', country: 'ZA', city: 'Johannesburg', lat: -26.2041, lng: 28.0473, tz: 'Africa/Johannesburg' },
  { id: 'za-capetown', country: 'ZA', city: 'Cape Town', lat: -33.9249, lng: 18.4241, tz: 'Africa/Johannesburg' },
  { id: 'za-durban', country: 'ZA', city: 'Durban', lat: -29.8587, lng: 31.0218, tz: 'Africa/Johannesburg' }
];

const SPOOF_STATE_PATH = path.join(ROOT_DIR, 'dll/system/geo-spoof-state.json');

let spoofState = { enabled: false, countryCode: null, locationId: null };
const spoofScriptIds = new Map(); // tabId -> CDP script identifier (Page.addScriptToEvaluateOnNewDocument)

function loadSpoofState() {
  try {
    const raw = fs.readFileSync(SPOOF_STATE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return {
      enabled: !!data.enabled,
      countryCode: data.countryCode || null,
      locationId: data.locationId || null
    };
  } catch (error) {
    return { enabled: false, countryCode: null, locationId: null };
  }
}

function saveSpoofState(state) {
  try {
    fs.mkdirSync(path.dirname(SPOOF_STATE_PATH), { recursive: true });
    fs.writeFileSync(SPOOF_STATE_PATH, JSON.stringify(state), 'utf-8');
  } catch (error) {
    console.error('[GeoSpoof] Gagal nyimpen state:', error.message);
  }
}

function spoofBuildAcceptLanguage(locale) {
  const base = locale.split('-')[0];
  if (base === 'en') {
    return locale === 'en-US' ? 'en-US,en;q=0.9' : `${locale},en;q=0.9,en-US;q=0.6`;
  }
  return `${locale},${base};q=0.9,en-US;q=0.5`;
}

function spoofGetProfile(countryCode, locationId) {
  if (!countryCode || !locationId) return null;
  const loc = SPOOF_LOCATIONS.find((l) => l.id === locationId && l.country === countryCode);
  const country = SPOOF_COUNTRIES.find((c) => c.code === countryCode);
  if (!loc || !country) return null;
  const locale = loc.locale || country.locale;
  return {
    countryCode,
    countryName: country.name,
    flag: country.flag,
    locationId,
    city: loc.city,
    lat: loc.lat,
    lng: loc.lng,
    tz: loc.tz,
    locale,
    acceptLang: spoofBuildAcceptLanguage(locale)
  };
}

// Script yang disuntik ke MAIN WORLD tiap tab (lewat CDP, bukan isolated
// world preload) — geolocation & bahasa gak punya API native buat di-override
// di Electron, jadi jalan satu-satunya ya patch langsung objek `navigator`
// punya halaman itu sendiri.
function spoofBuildInjectionScript(profile) {
  const payload = {
    lat: profile.lat,
    lng: profile.lng,
    lang: profile.locale,
    langBase: profile.locale.split('-')[0]
  };

  return `(function() {
    try {
      var AKHTAR_GEO = ${JSON.stringify(payload)};

      var fakePosition = function() {
        return {
          coords: {
            latitude: AKHTAR_GEO.lat,
            longitude: AKHTAR_GEO.lng,
            accuracy: 20 + Math.random() * 15,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null
          },
          timestamp: Date.now()
        };
      };

      var fakeGeolocation = {
        getCurrentPosition: function(success, error, options) {
          setTimeout(function() {
            try { success(fakePosition()); } catch (e) {}
          }, 40 + Math.random() * 120);
        },
        watchPosition: function(success, error, options) {
          try { success(fakePosition()); } catch (e) {}
          return setInterval(function() {
            try { success(fakePosition()); } catch (e) {}
          }, 6000);
        },
        clearWatch: function(id) { clearInterval(id); }
      };

      try {
        Object.defineProperty(window.navigator, 'geolocation', {
          get: function() { return fakeGeolocation; },
          configurable: true
        });
      } catch (e) {}

      try {
        Object.defineProperty(window.navigator, 'language', {
          get: function() { return AKHTAR_GEO.lang; },
          configurable: true
        });
        Object.defineProperty(window.navigator, 'languages', {
          get: function() { return Object.freeze([AKHTAR_GEO.lang, AKHTAR_GEO.langBase]); },
          configurable: true
        });
      } catch (e) {}
    } catch (e) {}
  })();`;
}

// Header Accept-Language + timezone level session — dipasang SEKALI aja pas
// startup, isi headernya dibaca dari spoofState terkini tiap ada request.
function spoofRegisterSessionHooks() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (spoofState.enabled) {
      const profile = spoofGetProfile(spoofState.countryCode, spoofState.locationId);
      if (profile) {
        details.requestHeaders['Accept-Language'] = profile.acceptLang;
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

function spoofApplySessionTimezone() {
  const ses = session.defaultSession;
  try {
    if (typeof ses.setTimezoneOverride !== 'function') return;
    if (spoofState.enabled) {
      const profile = spoofGetProfile(spoofState.countryCode, spoofState.locationId);
      if (profile) ses.setTimezoneOverride(profile.tz);
    } else {
      ses.setTimezoneOverride(''); // kosongin string = balik ke timezone OS asli
    }
  } catch (error) {
    // Versi Electron lama gak punya API ini, aman diabaikan — geolocation &
    // bahasa tetep ke-spoof, cuma timezone yang gak ikut ke-paksa.
  }
}

async function spoofClearTab(tab) {
  const wc = tab.view.webContents;
  const scriptId = spoofScriptIds.get(tab.id);
  spoofScriptIds.delete(tab.id);
  if (!scriptId) return;
  try {
    if (wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
    }
  } catch (error) { /* tab udah navigasi/ketutup, aman diabaikan */ }
}

async function spoofApplyToTab(tab) {
  if (!tab || tab.view.webContents.isDestroyed()) return;
  const wc = tab.view.webContents;

  await spoofClearTab(tab);

  if (!spoofState.enabled) return;

  const profile = spoofGetProfile(spoofState.countryCode, spoofState.locationId);
  if (!profile) return;

  const script = spoofBuildInjectionScript(profile);

  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }
    await wc.debugger.sendCommand('Page.enable');
    const result = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: script });
    if (result && result.identifier) {
      spoofScriptIds.set(tab.id, result.identifier);
    }
  } catch (error) {
    console.error('[GeoSpoof] Gagal pasang CDP script ke tab', tab.id, error.message);
  }

  // Suntik langsung ke halaman yang LAGI kebuka juga, biar efeknya kerasa
  // instan tanpa nunggu user reload manual (CDP baru berlaku pas next-navigate).
  try {
    await wc.executeJavaScript(script);
  } catch (error) { /* halaman belum siap, gapapa udah ke-cover CDP buat navigasi berikutnya */ }
}

async function spoofApplyToAllTabs() {
  for (const tab of browserTabs) {
    await spoofApplyToTab(tab);
  }
}

// ---- IPC HANDLERS: GEOLOCATION & TIME SPOOFER ----

ipcMain.handle('spoof-get-locations', () => {
  return {
    countries: SPOOF_COUNTRIES,
    locations: SPOOF_LOCATIONS.map((l) => ({
      id: l.id,
      country: l.country,
      city: l.city,
      tz: l.tz
    }))
  };
});

ipcMain.handle('spoof-get-status', () => {
  const profile = spoofState.enabled
    ? spoofGetProfile(spoofState.countryCode, spoofState.locationId)
    : null;
  return { ...spoofState, profile };
});

ipcMain.handle('spoof-set', async (event, config) => {
  const enabled = !!(config && config.enabled);
  const countryCode = (config && config.countryCode) || null;
  const locationId = (config && config.locationId) || null;

  if (enabled && !spoofGetProfile(countryCode, locationId)) {
    return { ok: false, error: 'Negara/lokasi yang dipilih gak valid.' };
  }

  spoofState = { enabled, countryCode, locationId };
  saveSpoofState(spoofState);

  spoofApplySessionTimezone();
  await spoofApplyToAllTabs();

  const profile = enabled ? spoofGetProfile(countryCode, locationId) : null;
  return { ok: true, enabled, profile };
});

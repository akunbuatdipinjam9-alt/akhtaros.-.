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
    browserTabs = browserTabs.filter((t) => t.id !== tab.id);
  });

  browserTabs.push(tab);

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

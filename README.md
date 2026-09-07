# 🚀 AKHTAR OS — CARA INSTALL & JALANKAN (DARI SOURCE)

**BRO, GW AKAN KASIH TAU CARA NYALAIN OS KEREN INI DARI 0!**

---

## 📦 YANG LU PERLU SIAPIN DULU

| Tools | Link Download | Keterangan |
|-------|---------------|------------|
| **Node.js** | [nodejs.org](https://nodejs.org) | Pake versi LTS (18.x atau 20.x) |
| **Git** | [git-scm.com](https://git-scm.com) | Buat clone repo |
| **Visual Studio Build Tools** | [visualstudio.microsoft.com](https://visualstudio.microsoft.com/downloads/?q=build+tools) | **PENTING!** Buat compile native addon (C++) |
| **Python** | [python.org](https://python.org) | Version 3.x, buat node-gyp |

---

## 🔧 STEP 1 — CLONE REPO

```bash
# Clone repository lu
git clone https://github.com/akunbuatdipinjam9-alt/akhtaros.-
cd akhtar-os
📦 STEP 2 — INSTALL DEPENDENCIES
bash
# Install semua package yang dibutuhin
npm install
Ini yang bakal ke-install:

electron — core framework

webtorrent — torrent engine

bonjour-service — Akhtar Share (mDNS discovery)

ws — WebSocket buat Akhtar Share

tor-axios — Tor HTTP client

crypto-js — AES-256 encryption

three.js — Slime 3D render

@mediapipe/face_mesh — Face scan login

qrious — QR generator

🔥 KALAU ERROR NODE-GYP:
bash
# Windows — install build tools
npm install --global windows-build-tools

# Atau pake command ini kalo windows-build-tools gak jalan
npm install --global node-gyp
🔨 STEP 3 — COMPILE NATIVE ADDON (ASUS WMI)
Ini PENTING! Tanpa ini, fitur hardware control (CPU/GPU mode) gak jalan.

bash
# Masuk ke folder native addon
cd native/asus-wmi-addon

# Install dependency
npm install

# Compile C++ addon
node-gyp rebuild

# Balik ke root folder
cd ../../
⚠️ KALAU ERROR:
Pastikan Visual Studio Build Tools udah ke-install

Coba pake Command Prompt Run as Administrator

Kalo gagal, gak masalah — OS bakal fallback ke PowerShell otomatis!

🔨 STEP 4 — COMPILE POWER BRIDGE (G-Helper)
Ini buat kontrol power plan Windows versi akurat (pake PowerSetActiveOverlayScheme).

bash
# Masuk ke folder power bridge
cd native/akhtar-power-bridge

# Compile C# project
dotnet build -c Release

# Atau kalo gak pake dotnet, pake PowerShell
powershell -Command "& { Add-Type -Path 'PowerNative.cs' -OutputType Library -OutputAssembly 'PowerNative.dll' }"

# Balik ke root
cd ../../
⚠️ KALAU ERROR:
Install .NET SDK 6.0+ dari dotnet.microsoft.com

Kalo gagal, OS bakal fallback ke powercfg /setactive

🗜️ STEP 5 — PREPARE ASSETS
bash
# Buat folder asset (kalo belum ada)
mkdir assets

# Download icon (kalo gak ada)
# Taruh icon.ico di root folder

# Kalo pake custom wallpaper, taruh di folder
mkdir "penyimpanan os/wallpaper biasa"
mkdir "penyimpanan os/live wallpaper animation"
🚀 STEP 6 — JALANKAN OS
bash
# Jalankan dalam mode development
npm start

# Atau pake electron langsung
npx electron .
🔥 OS BAKAL NYALA!
Boot animation muncul

Login screen dengan password default: akhtar123

Desktop kaca-kaca siap dipake

📦 STEP 7 — BUILD DISTRIBUSI (EXE INSTALLER)
Ini buat bikin file .exe yang gak perlu install Node.js lagi.

bash
# Install electron-builder
npm install --save-dev electron-builder

# Build untuk Windows (64-bit)
npm run dist

# Atau pake command manual
npx electron-builder --win --x64
Hasilnya di folder dist/:

File	Keterangan
Akhtar OS Setup.exe	Installer (user tinggal next-next)
Akhtar OS-3.0.0-win.zip	Portable version (extract & jalanin)
Akhtar OS-3.0.0-win.exe	Single executable (portable)
🔥 UKURAN: ~2GB
(Karena include Tor Browser + Chromium)

⚡ STEP 8 — OPTIMASI BIAR SIZE KECIL
bash
# Prune node_modules (hapus file gak perlu)
npm install -g node-prune
node-prune node_modules

# Minify semua kode (pake terser)
npm install -g terser
terser main.js -o main.min.js
terser preload.js -o preload.min.js

# Compress pake UPX (Windows)
upx --best --ultra-brute dist/Akhtar\ OS.exe
🧪 STEP 9 — TEST FITUR-FITUR UTAMA
✅ Hardware Control (ASUS)
Buka Settings → Perangkat Keras

Coba ganti mode CPU (Silent/Balanced/Turbo)

Coba ganti mode GPU (Eco/Standard/Ultimate)

✅ Akhtar Share (P2P)
Buka Akhtar Share

Nyalain toggle service

Cari device lain di jaringan yg sama

Kirim file!

✅ DNS Shield
Buka Settings → Perangkat Keras → DNS Shield

Pilih provider (Cloudflare/Google/Quad9)

Cek status kalo enkripsi aktif

✅ Tor Browser
Buka Tor Browser dari desktop

Tunggu koneksi ke Tor network

Buka check.torproject.org buat verifikasi IP

✅ Global Incognito
Tekan Ctrl+Alt+I

Buka app apapun (browser, file manager, terminal)

Matiin mode incognito

Semua jejak ilang! 🔥

❗ TROUBLESHOOTING
🔴 Native Addon Gak Ke-Load
text
[asus-wmi] native addon gak ke-load, fallback ke PowerShell.
Solusi: Gak masalah — OS tetep jalan pake PowerShell.

🔴 PowerBridge Gak Ke-Load
text
[power-bridge] module gak ke-load, fallback ke powercfg.
Solusi: Gak masalah — OS tetep jalan pake powercfg.

🔴 Tor Gak Detect
text
Tidak ada Tor yang aktif di port 9150 atau 9050.
Solusi: Buka Tor Browser dulu, atau jalankan tor.exe manual.

🔴 Akhtar Share Gak Jalan
text
Dependency bonjour-service / ws belum ke-install
Solusi: npm install bonjour-service ws

📂 STRUKTUR FOLDER (BUAT YANG PENASARAN)
text
akhtar-os/
├── main.js                 # Backend Electron (kernel OS)
├── preload.js              # Bridge antara Electron & HTML
├── my-os-1.html            # Frontend utama (10.000+ baris!)
├── icon.ico                # Icon OS
├── package.json            # Dependency + script
│
├── native/                 # Native addons (C++ / C#)
│   ├── asus-wmi-addon/     # C++ addon buat ASUS WMI
│   └── akhtar-power-bridge/# C# .NET buat power plan
│
├── penyimpanan os/         # Data user (auto-generated)
│   ├── wallpaper biasa/
│   ├── live wallpaper animation/
│   ├── dll/
│   │   ├── files/
│   │   ├── system/
│   │   └── users/
│   └── torrents/
│
└── dist/                   # Build hasil packaging
    └── Akhtar OS.exe       # File executable!
🔧 AKHTAR POWER BRIDGE — INFO TAMBAHAN
Kredit
GHelper/PowerNative.cs diambil mentah/verbatim dari G-Helper oleh Serge (seerge), file app/Mode/PowerNative.cs, dilisensikan GNU GPL-3.0 (https://github.com/seerge/g-helper/blob/main/LICENSE).

Perubahan cuma Logger.WriteLine → Console.Error.WriteLine dan sedikit penyesuaian parameter (lihat komentar di puncak file) supaya bisa berdiri sendiri tanpa AppConfig/Logger milik G-Helper.

Karena akhtar-os memakai kode ini, akhtar-os secara keseluruhan didistribusikan di bawah GPL-3.0 — lihat LICENSE di root project.

Kenapa Proses Terpisah, Bukan Native Addon?
PowerNative.cs itu C#/.NET, sementara main.js Electron lu Node.js/V8 — dua runtime beda yang gak bisa "nempel" langsung. Daripada nulis ulang logikanya jadi C++ (rawan salah port), project ini compile kode C# G-Helper apa adanya jadi .exe berdiri sendiri, dipanggil dari Node lewat child_process.spawn + JSON di stdin/stdout.

Build
Prasyarat: .NET 8 SDK — https://dotnet.microsoft.com/download

bash
cd native\akhtar-power-bridge
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
Hasilnya ada di:

text
bin\Release\net8.0-windows\win-x64\publish\AkhtarPowerBridge.exe
Copy jadi:

bash
mkdir bin -Force
copy bin\Release\net8.0-windows\win-x64\publish\AkhtarPowerBridge.exe bin\AkhtarPowerBridge.exe
Catatan: bridge.js nyari exe-nya persis di native\akhtar-power-bridge\bin\AkhtarPowerBridge.exe

Pakai dari main.js
javascript
const powerBridge = require('./native/akhtar-power-bridge/bridge');

const mode = await powerBridge.getPowerMode(); // GUID overlay yang lagi aktif
await powerBridge.setPowerMode(1); // 1 = turbo (lihat PowerNative.GetDefaultPowerMode)
await powerBridge.setOverlay('silent'); // langsung by nama
Sama seperti native/asus-wmi-addon: bungkus pemanggilan ini di main.js dengan try/catch. Kalau .exe belum di-build atau gagal jalan, biarkan app fallback ke jalur powercfg.exe yang lama — jangan biarkan fitur ini bikin app crash total.

Menambah Command Lain dari G-Helper
Kalau nanti mau nambah lagi kode G-Helper apa adanya (misal dari ModeControl.cs/Modes.cs), taro filenya di GHelper/ (dengan komentar kredit yang sama di puncak file), tambahin case baru di Program.cs (switch expression), lalu tambahin method baru yang sesuai di bridge.js.

📄 LISENSI
Proyek ini dilisensikan di bawah GNU General Public License v3.0.

Poin-Poin Penting:
Kamu boleh pakai, modify, dan distribusi ulang software ini secara bebas

Kalau kamu distribusi versi yang udah di-modify, kamu WAJIB buka source code-nya juga di bawah GPL-3.0

Kamu GAK BISA pake kode ini di proyek proprietary/closed-source

Baca LICENSE buat syarat lengkapnya

Library yang Dipakai:
Electron (MIT)

Three.js (MIT)

WebTorrent (MIT)

Bonjour-service (MIT)

G-Helper PowerBridge (GPL-3.0)

🤔 "APAKAH INI ARTINYA..."
Q: "Apakah ini berarti orang bisa ambil kode gue dan jual?"
A: Bisa, TAPI mereka wajib buka source code-nya juga dan kasih tau kalo pake kode lu. Gak bisa dijual sebagai produk tertutup.

Q: "Kalau ada yang pake buat proyek internal perusahaan?"
A: Boleh, selama mereka gak distribusi ke luar. Tapi kalo distribusi (jual/gratis), wajib buka source.

Q: "Aman gak sih pake GPL-3.0 buat proyek gede kaya gini?"
A: AMAN BANGET! Justru ini proteksi terbaik buat kode lu. Linux kernel, Git, WordPress pake GPL juga.


btw ini juga butuh instal tor browser terpisah yah guys copy di folder akhtaros\penyimpanan os\dll\files\apps\


# AkhtarPowerBridge

## Kredit

`GHelper/PowerNative.cs` diambil **mentah/verbatim** dari
**[G-Helper](https://github.com/seerge/g-helper)** oleh Serge (seerge),
file `app/Mode/PowerNative.cs`, dilisensikan **GNU GPL-3.0**
(https://github.com/seerge/g-helper/blob/main/LICENSE). Perubahan cuma
`Logger.WriteLine` → `Console.Error.WriteLine` dan sedikit penyesuaian
parameter (lihat komentar di puncak file) supaya bisa berdiri sendiri
tanpa AppConfig/Logger milik G-Helper.

Karena akhtar-os memakai kode ini, **akhtar-os secara keseluruhan
didistribusikan di bawah GPL-3.0** — lihat `LICENSE` di root project.

## Kenapa proses terpisah, bukan native addon?

`PowerNative.cs` itu C#/.NET, sementara `main.js` Electron lu Node.js/V8 —
dua runtime beda yang gak bisa "nempel" langsung. Daripada nulis ulang
logikanya jadi C++ (rawan salah port), project ini compile kode C# G-Helper
apa adanya jadi `.exe` berdiri sendiri, dipanggil dari Node lewat
`child_process.spawn` + JSON di stdin/stdout.

## Build

Prasyarat: **.NET 8 SDK** — https://dotnet.microsoft.com/download

```powershell
cd native\akhtar-power-bridge
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

Hasilnya ada di:
```
bin\Release\net8.0-windows\win-x64\publish\AkhtarPowerBridge.exe
```

Copy jadi:
```powershell
mkdir bin -Force
copy bin\Release\net8.0-windows\win-x64\publish\AkhtarPowerBridge.exe bin\AkhtarPowerBridge.exe
```

(`bridge.js` nyari exe-nya persis di `native\akhtar-power-bridge\bin\AkhtarPowerBridge.exe`)

## Pakai dari main.js

```js
const powerBridge = require('./native/akhtar-power-bridge/bridge');

const mode = await powerBridge.getPowerMode(); // GUID overlay yang lagi aktif
await powerBridge.setPowerMode(1); // 1 = turbo (lihat PowerNative.GetDefaultPowerMode)
await powerBridge.setOverlay('silent'); // langsung by nama
```

Sama seperti `native/asus-wmi-addon`: bungkus pemanggilan ini di `main.js`
dengan `try/catch`. Kalau `.exe` belum di-build atau gagal jalan, biarkan
app fallback ke jalur `powercfg.exe` yang lama — jangan biarkan fitur ini
bikin app crash total.

## Menambah command lain dari G-Helper

Kalau nanti mau nambah lagi kode G-Helper apa adanya (misal dari
`ModeControl.cs`/`Modes.cs`), taro filenya di `GHelper/` (dengan komentar
kredit yang sama di puncak file), tambahin case baru di `Program.cs`
(switch expression), lalu tambahin method baru yang sesuai di `bridge.js`.

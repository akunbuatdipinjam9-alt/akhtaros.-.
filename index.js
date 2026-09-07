// Entry point tipis. Sengaja dipisah dari main.js Electron biar
// require() gagalnya (kalau addon belum di-build / bukan di Windows)
// bisa ditangkep bersih lewat try/catch di main.js, tanpa nge-crash app.
module.exports = require('./build/Release/asus_wmi_addon.node');

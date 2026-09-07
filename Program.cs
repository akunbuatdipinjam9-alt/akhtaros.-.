// AkhtarPowerBridge
// Proses kecil yang berdiri sendiri, isinya manggil PowerNative.cs G-Helper
// (GPL-3.0) apa adanya. main.js (Electron) spawn proses ini, kirim 1 baris
// JSON command lewat stdin, terima 1 baris JSON hasil lewat stdout, proses
// keluar (exit code 0 = sukses, 1 = error, pesan error di stderr).
//
// Protokol:
//   stdin  : {"cmd":"getPowerMode"}
//   stdout : {"ok":true,"result":"961cc777-2547-4f9d-8174-7d86181b8a7a"}
//
//   stdin  : {"cmd":"setPowerMode","mode":1}
//   stdout : {"ok":true}
//
//   stdin  : {"cmd":"setOverlay","scheme":"turbo","plan":"381b4222-f694-41f0-9685-ff5bb260df2e"}
//   stdout : {"ok":true}
//
// Kode ini menggunakan GHelper.PowerNative dari G-Helper (GPL-3.0).
// akhtar-os secara keseluruhan didistribusikan di bawah GPL-3.0 juga.

using System.Text.Json;
using AkhtarPowerBridge.GHelper;

namespace AkhtarPowerBridge
{
    internal class Program
    {
        static int Main(string[] args)
        {
            string? line = Console.In.ReadLine();
            if (string.IsNullOrWhiteSpace(line))
            {
                Console.Error.WriteLine("Gak ada command di stdin.");
                return 1;
            }

            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                string cmd = root.GetProperty("cmd").GetString() ?? "";

                object? result = cmd switch
                {
                    "getPowerMode" => PowerNative.GetPowerMode(),

                    "setPowerMode" => RunVoid(() =>
                        PowerNative.SetPowerMode(root.GetProperty("mode").GetInt32())),

                    // scheme: "silent" | "balanced" | "turbo" | GUID PLAN_HIGH_PERFORMANCE
                    // plan (opsional): GUID power plan Windows buat non-overlay mode
                    "setOverlay" => RunVoid(() =>
                    {
                        string scheme = root.GetProperty("scheme").GetString()! switch
                        {
                            "silent" => PowerNative.POWER_SILENT,
                            "balanced" => PowerNative.POWER_BALANCED,
                            "turbo" => PowerNative.POWER_TURBO,
                            var g => g // asumsikan udah berupa GUID mentah (misal PLAN_HIGH_PERFORMANCE)
                        };
                        string plan = root.TryGetProperty("plan", out var p)
                            ? p.GetString() ?? PowerNative.PLAN_BALANCED
                            : PowerNative.PLAN_BALANCED;
                        PowerNative.SetPowerMode(scheme, plan);
                    }),

                    "getCpuBoost" => PowerNative.GetCPUBoost(),
                    "setCpuBoost" => RunVoid(() =>
                        PowerNative.SetCPUBoost(root.GetProperty("boost").GetInt32())),

                    "getAspm" => PowerNative.GetASPM(),
                    "setAspm" => RunVoid(() =>
                        PowerNative.SetASPM(root.GetProperty("status").GetInt32())),

                    "getLidAction" => PowerNative.GetLidAction(root.GetProperty("ac").GetBoolean()),
                    "setLidAction" => RunVoid(() =>
                        PowerNative.SetLidAction(
                            root.GetProperty("action").GetInt32(),
                            root.TryGetProperty("acOnly", out var ao) && ao.GetBoolean())),

                    "getHibernateAfter" => PowerNative.GetHibernateAfter(),
                    "setHibernateAfter" => RunVoid(() =>
                        PowerNative.SetHibernateAfter(root.GetProperty("minutes").GetInt32())),

                    "getBatterySaverStatus" => PowerNative.GetBatterySaverStatus(),

                    _ => throw new InvalidOperationException($"Command gak dikenal: '{cmd}'")
                };

                var response = new Dictionary<string, object?> { ["ok"] = true, ["result"] = result };
                Console.Out.WriteLine(JsonSerializer.Serialize(response));
                return 0;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("AkhtarPowerBridge error: " + e.Message);
                var errResponse = new Dictionary<string, object?> { ["ok"] = false, ["error"] = e.Message };
                Console.Out.WriteLine(JsonSerializer.Serialize(errResponse));
                return 1;
            }
        }

        // Helper: fungsi G-Helper aslinya banyak yang void, sementara protokol
        // JSON kita butuh "result" (null di sini). Biar bisa dipakai di switch expression.
        static object? RunVoid(Action action)
        {
            action();
            return null;
        }
    }
}

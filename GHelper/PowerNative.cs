// ====================================================================
// KODE INI DIAMBIL MENTAH (VERBATIM) DARI G-HELPER oleh Serge (seerge)
// https://github.com/seerge/g-helper — app/Mode/PowerNative.cs
// Dilisensikan di bawah GNU GPL-3.0.
// https://github.com/seerge/g-helper/blob/main/LICENSE
//
// Karena akhtar-os menggunakan kode ini, akhtar-os secara keseluruhan
// didistribusikan di bawah GPL-3.0 juga. Lihat LICENSE di root project.
//
// Perubahan dari versi asli:
//   - Logger.WriteLine(...) diganti Console.Error.WriteLine(...)
//     (Logger.cs milik G-Helper gak diikutkan, biar berdiri sendiri)
//   - AppConfig.* dihapus dari SetPowerMode/SetPowerPlan (fungsi itu
//     butuh state app G-Helper yang gak relevan di bridge ini; parameter
//     scheme sekarang wajib diisi eksplisit oleh pemanggil)
// ====================================================================

using Microsoft.Win32;
using System.Runtime.InteropServices;

namespace AkhtarPowerBridge.GHelper
{
    internal class PowerNative
    {
        [DllImport("PowrProf.dll", CharSet = CharSet.Unicode)]
        static extern UInt32 PowerWriteDCValueIndex(IntPtr RootPowerKey,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SchemeGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SubGroupOfPowerSettingsGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid PowerSettingGuid,
            int AcValueIndex);

        [DllImport("PowrProf.dll", CharSet = CharSet.Unicode)]
        static extern UInt32 PowerWriteACValueIndex(IntPtr RootPowerKey,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SchemeGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SubGroupOfPowerSettingsGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid PowerSettingGuid,
            int AcValueIndex);

        [DllImport("PowrProf.dll", CharSet = CharSet.Unicode)]
        static extern UInt32 PowerReadACValueIndex(IntPtr RootPowerKey,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SchemeGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SubGroupOfPowerSettingsGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid PowerSettingGuid,
            out IntPtr AcValueIndex
            );

        [DllImport("PowrProf.dll", CharSet = CharSet.Unicode)]
        static extern UInt32 PowerReadDCValueIndex(IntPtr RootPowerKey,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SchemeGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SubGroupOfPowerSettingsGuid,
            [MarshalAs(UnmanagedType.LPStruct)] Guid PowerSettingGuid,
            out IntPtr AcValueIndex
            );

        [DllImport("PowrProf.dll", CharSet = CharSet.Unicode)]
        static extern UInt32 PowerSetActiveScheme(IntPtr RootPowerKey,
            [MarshalAs(UnmanagedType.LPStruct)] Guid SchemeGuid);

        [DllImport("PowrProf.dll", CharSet = CharSet.Unicode)]
        static extern UInt32 PowerGetActiveScheme(IntPtr UserPowerKey, out IntPtr ActivePolicyGuid);

        static readonly Guid GUID_CPU = new Guid("54533251-82be-4824-96c1-47b60b740d00");
        static readonly Guid GUID_BOOST = new Guid("be337238-0d82-4146-a960-4f3749d470c7");

        private static Guid GUID_SLEEP_SUBGROUP = new Guid("238c9fa8-0aad-41ed-83f4-97be242c8f20");
        private static Guid GUID_HIBERNATEIDLE = new Guid("9d7815a6-7ee4-497e-8888-515a05f02364");

        private static Guid GUID_SYSTEM_BUTTON_SUBGROUP = new Guid("4f971e89-eebd-4455-a8de-9e59040e7347");
        private static Guid GUID_LIDACTION = new Guid("5CA83367-6E45-459F-A27B-476B1D01C936");

        private static Guid GUID_SUB_PCIEXPRESS = new Guid("501a4d13-42af-4429-9fd1-a8218c268e20");
        private static Guid GUID_PCI_EXPRESS_ASPM = new Guid("ee12f906-d277-404b-b6da-e5fa1a576df5");

        private static Guid GUID_SUB_NONE = new Guid("fea3413e-7e05-4911-9a71-700331f1c294");
        private static Guid GUID_CONNECTIVITY_IN_STANDBY = new Guid("f15576e8-98b7-4186-b944-eafa664402d9");

        [DllImportAttribute("powrprof.dll", EntryPoint = "PowerGetActualOverlayScheme")]
        public static extern uint PowerGetActualOverlayScheme(out Guid ActualOverlayGuid);

        [DllImportAttribute("powrprof.dll", EntryPoint = "PowerGetEffectiveOverlayScheme")]
        public static extern uint PowerGetEffectiveOverlayScheme(out Guid EffectiveOverlayGuid);

        [DllImportAttribute("powrprof.dll", EntryPoint = "PowerSetActiveOverlayScheme")]
        public static extern uint PowerSetActiveOverlayScheme(Guid OverlaySchemeGuid);

        public const string POWER_SILENT = "961cc777-2547-4f9d-8174-7d86181b8a7a";
        public const string POWER_BALANCED = "00000000-0000-0000-0000-000000000000";
        public const string POWER_TURBO = "ded574b5-45a0-4f42-8737-46345c09c238";

        public const string PLAN_BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e";
        public const string PLAN_HIGH_PERFORMANCE = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c";

        static List<string> overlays = new() {
                POWER_BALANCED,
                POWER_TURBO,
                POWER_SILENT,
            };

        public static Dictionary<string, string> powerModes = new Dictionary<string, string>
            {
                { POWER_SILENT, "Best Power Efficiency" },
                { POWER_BALANCED, "Balanced" },
                { POWER_TURBO, "Best Performance" },
                { PLAN_HIGH_PERFORMANCE, "High Performance Plan"},
            };

        static Guid GetActiveScheme()
        {
            IntPtr pActiveSchemeGuid;
            var hr = PowerGetActiveScheme(IntPtr.Zero, out pActiveSchemeGuid);
            Guid activeSchemeGuid = (Guid)Marshal.PtrToStructure(pActiveSchemeGuid, typeof(Guid))!;
            return activeSchemeGuid;
        }

        public static int GetCPUBoost()
        {
            IntPtr AcValueIndex;
            Guid activeSchemeGuid = GetActiveScheme();

            UInt32 value = PowerReadACValueIndex(IntPtr.Zero,
                 activeSchemeGuid,
                 GUID_CPU,
                 GUID_BOOST, out AcValueIndex);

            return AcValueIndex.ToInt32();
        }

        public static void SetCPUBoost(int boost = 0)
        {
            Guid activeSchemeGuid = GetActiveScheme();

            if (boost == GetCPUBoost()) return;

            var hrAC = PowerWriteACValueIndex(
                 IntPtr.Zero,
                 activeSchemeGuid,
                 GUID_CPU,
                 GUID_BOOST,
                 boost);

            PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);

            var hrDC = PowerWriteDCValueIndex(
                 IntPtr.Zero,
                 activeSchemeGuid,
                 GUID_CPU,
                 GUID_BOOST,
                 boost);

            PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);

            Console.Error.WriteLine("Boost " + boost);
        }

        public static string GetPowerMode()
        {
            if (GetActiveScheme().ToString() == PLAN_HIGH_PERFORMANCE) return PLAN_HIGH_PERFORMANCE;
            PowerGetEffectiveOverlayScheme(out Guid activeScheme);
            return activeScheme.ToString();
        }

        // Versi disederhanakan dari G-Helper: "plan" (power plan Windows,
        // misal Balanced/High Performance) wajib dikasih eksplisit oleh
        // pemanggil, bukan diambil dari AppConfig milik G-Helper.
        public static void SetPowerMode(string scheme, string plan = PLAN_BALANCED)
        {
            if (scheme == PLAN_HIGH_PERFORMANCE)
            {
                SetPowerPlan(scheme);
                return;
            }
            else
            {
                SetPowerPlan(plan);
            }

            if (!overlays.Contains(scheme)) return;

            Guid guidScheme = new Guid(scheme);

            uint status = PowerGetEffectiveOverlayScheme(out Guid activeScheme);

            if (GetBatterySaverStatus())
            {
                Console.Error.WriteLine("Battery Saver detected");
                return;
            }

            if (status != 0 || activeScheme != guidScheme)
            {
                status = PowerSetActiveOverlayScheme(guidScheme);
                Console.Error.WriteLine("Power Mode " + activeScheme + " -> " + scheme + ":" + (status == 0 ? "OK" : status.ToString()));
            }
        }

        public static void SetPowerPlan(string scheme)
        {
            if (overlays.Contains(scheme)) return;

            if (scheme is null) scheme = PLAN_BALANCED;
            var activeScheme = GetActiveScheme().ToString();
            if (activeScheme == scheme) return;

            uint status = PowerSetActiveScheme(IntPtr.Zero, new Guid(scheme));
            Console.Error.WriteLine($"Power Plan {activeScheme} -> {scheme} :" + (status == 0 ? "OK" : status.ToString()));
        }

        public static string GetDefaultPowerMode(int mode)
        {
            switch (mode)
            {
                case 1: // turbo
                    return POWER_TURBO;
                case 2: //silent
                    return POWER_SILENT;
                case 3:
                    return PLAN_HIGH_PERFORMANCE;
                default: // balanced
                    return POWER_BALANCED;
            }
        }

        public static void SetPowerMode(int mode)
        {
            SetPowerMode(GetDefaultPowerMode(mode));
        }

        public static int GetASPM()
        {
            Guid activeSchemeGuid = GetActiveScheme();
            IntPtr activeIndex;

            PowerReadACValueIndex(IntPtr.Zero,
                    activeSchemeGuid,
                    GUID_SUB_PCIEXPRESS,
                    GUID_PCI_EXPRESS_ASPM, out activeIndex);

            return activeIndex.ToInt32();
        }

        public static void SetASPM(int status = 0)
        {
            Guid activeSchemeGuid = GetActiveScheme();
            var currentASPM = GetASPM();
            if (currentASPM == status) return;

            var hrAC = PowerWriteACValueIndex(
                IntPtr.Zero,
                activeSchemeGuid,
                GUID_SUB_PCIEXPRESS,
                GUID_PCI_EXPRESS_ASPM,
                status);

            PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);
            Console.Error.WriteLine($"Changed AC ASPM {currentASPM} -> {status}");
        }

        public static void SetBalancedASPM(int status = 0)
        {
            if (GetActiveScheme().ToString() != PLAN_BALANCED) return;
            SetASPM(status);
        }

        public static void SetConnectivityInStandby(int ac = 0, int dc = 0)
        {
            Guid activeSchemeGuid = GetActiveScheme();

            using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes\{activeSchemeGuid}\{GUID_CONNECTIVITY_IN_STANDBY}");
            if (key != null && (int?)key.GetValue("ACSettingIndex") == ac && (int?)key.GetValue("DCSettingIndex") == dc) return;

            var hrAC = PowerWriteACValueIndex(
                IntPtr.Zero,
                activeSchemeGuid,
                GUID_SUB_NONE,
                GUID_CONNECTIVITY_IN_STANDBY,
                ac);

            var hrDC = PowerWriteDCValueIndex(
                IntPtr.Zero,
                activeSchemeGuid,
                GUID_SUB_NONE,
                GUID_CONNECTIVITY_IN_STANDBY,
                dc);

            PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);
            Console.Error.WriteLine($"Connectivity in Standby {ac}/{dc}: " + (hrAC == 0 && hrDC == 0 ? "OK" : $"{hrAC}/{hrDC}"));
        }

        public static int GetLidAction(bool ac)
        {
            Guid activeSchemeGuid = GetActiveScheme();

            IntPtr activeIndex;
            if (ac)
                PowerReadACValueIndex(IntPtr.Zero,
                     activeSchemeGuid,
                     GUID_SYSTEM_BUTTON_SUBGROUP,
                     GUID_LIDACTION, out activeIndex);
            else
                PowerReadDCValueIndex(IntPtr.Zero,
                    activeSchemeGuid,
                    GUID_SYSTEM_BUTTON_SUBGROUP,
                    GUID_LIDACTION, out activeIndex);

            return activeIndex.ToInt32();
        }

        public static void SetLidAction(int action, bool acOnly = false)
        {
            Guid activeSchemeGuid = GetActiveScheme();

            var hrAC = PowerWriteACValueIndex(
                IntPtr.Zero,
                activeSchemeGuid,
                GUID_SYSTEM_BUTTON_SUBGROUP,
                GUID_LIDACTION,
                action);

            PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);

            if (!acOnly)
            {
                var hrDC = PowerWriteDCValueIndex(
                  IntPtr.Zero,
                  activeSchemeGuid,
                  GUID_SYSTEM_BUTTON_SUBGROUP,
                  GUID_LIDACTION,
                  action);

                PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);
            }

            Console.Error.WriteLine("Changed Lid Action to " + action);
        }

        public static int GetHibernateAfter()
        {
            Guid activeSchemeGuid = GetActiveScheme();
            IntPtr seconds;
            PowerReadDCValueIndex(IntPtr.Zero,
                    activeSchemeGuid,
                    GUID_SLEEP_SUBGROUP,
                    GUID_HIBERNATEIDLE, out seconds);

            Console.Error.WriteLine("Hibernate after " + seconds);
            return (seconds.ToInt32() / 60);
        }

        public static void SetHibernateAfter(int minutes)
        {
            int seconds = minutes * 60;

            Guid activeSchemeGuid = GetActiveScheme();
            var hrAC = PowerWriteDCValueIndex(
                IntPtr.Zero,
                activeSchemeGuid,
                GUID_SLEEP_SUBGROUP,
                GUID_HIBERNATEIDLE,
                seconds);

            PowerSetActiveScheme(IntPtr.Zero, activeSchemeGuid);

            Console.Error.WriteLine("Setting Hibernate after " + seconds + ": " + (hrAC == 0 ? "OK" : hrAC.ToString()));
        }

        [DllImport("Kernel32")]
        private static extern bool GetSystemPowerStatus(SystemPowerStatus sps);

        public enum ACLineStatus : byte
        {
            Offline = 0, Online = 1, Unknown = 255
        }

        public enum BatteryFlag : byte
        {
            High = 1,
            Low = 2,
            Critical = 4,
            Charging = 8,
            NoSystemBattery = 128,
            Unknown = 255
        }

        [StructLayout(LayoutKind.Sequential)]
        public class SystemPowerStatus
        {
            public ACLineStatus ACLineStatus;
            public BatteryFlag BatteryFlag;
            public Byte BatteryLifePercent;
            public Byte SystemStatusFlag;
            public Int32 BatteryLifeTime;
            public Int32 BatteryFullLifeTime;
        }

        public static bool GetBatterySaverStatus()
        {
            try
            {
                var status = Registry.GetValue(@"HKEY_LOCAL_MACHINE\System\CurrentControlSet\Control\Power", "EnergySaverState", null);
                if (status == null)
                {
                    SystemPowerStatus sps = new SystemPowerStatus();
                    GetSystemPowerStatus(sps);
                    return (sps.SystemStatusFlag > 0);
                }
                return (int)status == 1;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("Can't check EnergySaverState" + e.Message);
                return false;
            }
        }
    }
}

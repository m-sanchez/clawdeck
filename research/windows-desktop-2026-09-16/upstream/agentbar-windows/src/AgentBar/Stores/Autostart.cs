using System;
using Microsoft.Win32;

namespace AgentBar.Stores;

/// Start-at-login via the per-user Run key. No admin rights, no scheduled task.
public static class Autostart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "AgentBar";

    public static bool Enabled
    {
        get
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKey);
                return key?.GetValue(ValueName) is not null;
            }
            catch { return false; }
        }
    }

    public static void SetEnabled(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (key is null) return;
            if (on)
            {
                var exe = Environment.ProcessPath;
                if (!string.IsNullOrEmpty(exe)) key.SetValue(ValueName, $"\"{exe}\"");
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }
        }
        catch { /* best effort */ }
    }
}

param([int]$OwnerProcessId, [switch]$Once)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class OcelinProcesses {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry {
    public uint size, usage, pid; public IntPtr heap; public uint module, threads, parent;
    public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Memory {
    public uint size, faults;
    public UIntPtr peakWorking, working, peakPaged, paged, peakNonPaged, nonPaged, pagefile, peakPagefile, privateUsage, privateWorking;
    public ulong sharedCommit;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr handle, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr process, ref Memory counters, uint size);
  public class Row {
    public int pid; public string name, provider; public long started; public ulong? memoryBytes; public double? cpuSeconds;
  }
  public static List<Row> Read(int owner) {
    var entries = new Dictionary<uint, Entry>();
    var handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new Exception("Process snapshot unavailable");
    try {
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (Process32FirstW(handle, ref entry)) do { entries[entry.pid] = entry; } while (Process32NextW(handle, ref entry));
    } finally { CloseHandle(handle); }
    var result = new List<Row>();
    var starts = new Dictionary<uint, long>();
    Func<uint, long> start = id => {
      long time; if (starts.TryGetValue(id, out time)) return time;
      try { using (var p = Process.GetProcessById((int)id)) { time = p.StartTime.ToUniversalTime().Ticks; } } catch { time = 0; }
      starts[id] = time; return time;
    };
    foreach (var entry in entries.Values) {
      string provider = null; var current = entry; var seen = new HashSet<uint>();
      while (seen.Add(current.pid)) {
        var name = current.name.ToLowerInvariant();
        if (current.pid == owner || name == "ocelin.exe") { provider = "ocelin"; break; }
        if (name == "codex.exe") { provider = "codex"; break; }
        if (name == "claude.exe") { provider = "claude"; break; }
        Entry parent;
        if (!entries.TryGetValue(current.parent, out parent)) break;
        var childStart = start(current.pid); var parentStart = start(parent.pid);
        if (childStart == 0 || parentStart == 0 || parentStart > childStart) break;
        current = parent;
      }
      if (provider == null) continue;
      var row = new Row { pid = (int)entry.pid, name = entry.name, provider = provider };
      try {
        using (var process = Process.GetProcessById(row.pid)) {
          row.started = process.StartTime.ToUniversalTime().Ticks;
          row.cpuSeconds = process.TotalProcessorTime.TotalSeconds;
          var memory = new Memory(); memory.size = (uint)Marshal.SizeOf(typeof(Memory));
          if (GetProcessMemoryInfo(process.Handle, ref memory, memory.size)) row.memoryBytes = memory.privateWorking.ToUInt64();
        }
      } catch (ArgumentException) { continue; } catch { }
      result.Add(row);
    }
    return result;
  }
}
'@
try { [Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch {}
do {
  $sampleTimer = [Diagnostics.Stopwatch]::StartNew()
  $rows = [OcelinProcesses]::Read($OwnerProcessId)
  @{ sampledAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); durationMs = $sampleTimer.ElapsedMilliseconds; processes = @($rows) } | ConvertTo-Json -Depth 4 -Compress | ForEach-Object { [Console]::WriteLine($_) }
  if ($Once) { break }
  Start-Sleep -Seconds 12
} while (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue)

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Threading;
using AgentBar.Models;

namespace AgentBar.Stores;

/// Watches ~/.agentbar/state.d/ and publishes the current set of live sessions.
/// The folder is the whole protocol: hooks write one JSON per session, remove it on end.
public sealed class SessionStore : IDisposable
{
    /// Raised on the UI thread with sessions sorted by (priority, recency), most urgent first.
    public event Action<IReadOnlyList<Session>>? Changed;

    private FileSystemWatcher? _watcher;
    private DispatcherTimer? _timer;
    private List<string> _lastSnapshot = new();

    public void Start()
    {
        Directory.CreateDirectory(Paths.StateDir);

        _watcher = new FileSystemWatcher(Paths.StateDir, "*.json")
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
            EnableRaisingEvents = true,
        };
        _watcher.Created += OnFsEvent;
        _watcher.Changed += OnFsEvent;
        _watcher.Deleted += OnFsEvent;
        _watcher.Renamed += (s, e) => OnFsEvent(s, e); // RenamedEventArgs : FileSystemEventArgs

        // Fallback poll: dead-pid pruning and 24h staleness are time-based and fire no fs event.
        _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromSeconds(2) };
        _timer.Tick += (_, _) => Refresh();
        _timer.Start();

        Refresh();
    }

    // FileSystemWatcher events arrive on a thread-pool thread; marshal to the UI thread.
    private void OnFsEvent(object sender, FileSystemEventArgs e) =>
        Application.Current?.Dispatcher.BeginInvoke((Action)Refresh);

    public void Refresh()
    {
        string[] files;
        try { files = Directory.GetFiles(Paths.StateDir, "*.json"); }
        catch { return; }

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var sessions = new List<Session>();
        foreach (var file in files)
        {
            var s = Session.FromFile(file);
            if (s is null) continue;
            // Prune: the owning agent process is gone, or the file is ancient (24h).
            var dead = s.Pid > 0 && !ProcessUtil.IsAlive(s.Pid);
            var stale = s.Ts > 0 && now - s.Ts > 86_400;
            if (dead || stale) { TryDelete(file); continue; }
            if (!s.Started) continue; // opened but never used: stays out of the popover
            sessions.Add(s);
        }

        sessions = sessions
            .OrderByDescending(s => s.Priority)
            .ThenByDescending(s => s.Ts)
            .ToList();

        // Only notify on a visible change (branch included, so a checkout counts).
        var snapshot = sessions
            .Select(s => $"{s.Id}:{s.State}:{s.Label}:{s.Project}:{s.GitBranch ?? ""}")
            .ToList();
        if (snapshot.SequenceEqual(_lastSnapshot)) return;
        _lastSnapshot = snapshot;
        Changed?.Invoke(sessions);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); } catch { /* another writer/poller raced us */ }
    }

    public void Dispose()
    {
        _timer?.Stop();
        if (_watcher is not null)
        {
            _watcher.EnableRaisingEvents = false;
            _watcher.Dispose();
        }
    }
}

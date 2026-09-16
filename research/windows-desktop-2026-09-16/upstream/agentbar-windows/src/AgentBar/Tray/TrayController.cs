using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using Hardcodet.Wpf.TaskbarNotification;
using AgentBar.Input;
using AgentBar.Models;
using AgentBar.Rendering;
using AgentBar.Stores;

namespace AgentBar.Tray;

/// Owns the notification-area icon and the popover: no main window, no taskbar button,
/// no alt-tab presence.
public sealed class TrayController : IDisposable
{
    private readonly TaskbarIcon _icon = new();
    private readonly SessionStore _sessionStore = new();
    private readonly RequestStore _requestStore = new();
    private readonly HotKeyCenter _hotKeys = new();
    private readonly PopoverWindow _popover = new();
    private IconAnimator _animator = null!;

    private IReadOnlyList<Session> _sessions = Array.Empty<Session>();
    private IReadOnlyList<ApprovalRequest> _approvals = Array.Empty<ApprovalRequest>();
    private DateTime _lastHotkey = DateTime.MinValue;

    private MenuItem _checkItem = null!;
    private MenuItem _updateItem = null!;

    public void Start()
    {
        _icon.ToolTipText = "AgentBar";
        _animator = new IconAnimator(img => _icon.IconSource = img);
        _animator.Update(_sessions);
        _icon.TrayLeftMouseUp += (_, _) => TogglePopover();
        _icon.ContextMenu = BuildMenu();

        _sessionStore.Changed += OnSessionsChanged;
        _requestStore.Changed += OnRequestsChanged;
        _sessionStore.Start();
        _requestStore.Start();
        ApplyHotKeyState();

        UpdateChecker.Shared.Changed += OnUpdateChanged;
        UpdateChecker.Shared.StartPeriodicChecks();
    }

    private void OnSessionsChanged(IReadOnlyList<Session> sessions)
    {
        _sessions = sessions;
        _animator.Update(sessions);
        _icon.ToolTipText = sessions.Count == 0
            ? "AgentBar — idle"
            : $"AgentBar — {sessions.Count} active";
        RefreshPopoverIfVisible();
    }

    private void OnRequestsChanged(IReadOnlyList<ApprovalRequest> approvals)
    {
        _approvals = approvals;
        RefreshPopoverIfVisible();
    }

    // MARK: - Approvals

    /// Called by an approval button: record the decision the blocking hook is waiting for.
    private void Answer(ApprovalRequest req, string behavior)
    {
        var rule = behavior == "always" ? req.RuleSuggestionRaw : null;
        AnswerWriter.Write(behavior, rule, req);

        // Drop the card immediately; the hook removes the request file on pickup and the
        // store's next refresh will confirm it's gone.
        _approvals = _approvals.Where(a => a.FileName != req.FileName).ToList();
        RefreshPopoverIfVisible();
    }

    /// Called by a session row's "Approve in terminal" button (keystroke agents).
    private void KeystrokeApprove(Session session)
    {
        var keys = session.Agent.ApproveKeys;
        if (keys is not null) KeystrokeApprover.Approve(session, keys);
    }

    // MARK: - Global Allow/Deny shortcut (opt-in)

    private void ApplyHotKeyState() =>
        _hotKeys.SetEnabled(Settings.GlobalApprovalShortcut,
            allow: () => HotkeyAnswer("allow"),
            deny: () => HotkeyAnswer("deny"));

    /// Answer the newest pending request. Debounced so a held chord can't double-fire.
    private void HotkeyAnswer(string behavior)
    {
        var now = DateTime.UtcNow;
        if (now - _lastHotkey < TimeSpan.FromSeconds(1)) return;
        _lastHotkey = now;

        var req = _approvals.FirstOrDefault(); // sorted newest-first; no-op when empty
        if (req is null) return;
        Answer(req, behavior);
    }

    // MARK: - Popover

    private void TogglePopover()
    {
        if (_popover.IsVisible)
        {
            _popover.Hide();
            return;
        }
        // A click on the tray icon while the popover is open first fires the window's
        // Deactivated (which hides it), so by now IsVisible is already false. Treat a
        // click that lands right after that auto-hide as "close", not "reopen".
        if (DateTime.UtcNow - _popover.LastHidden < TimeSpan.FromMilliseconds(250)) return;

        _popover.Update(_sessions, _approvals, Answer, KeystrokeApprove);
        _popover.ShowNearTray();
    }

    private void RefreshPopoverIfVisible()
    {
        if (_popover.IsVisible) _popover.Update(_sessions, _approvals, Answer, KeystrokeApprove);
    }

    private ContextMenu BuildMenu()
    {
        var menu = new ContextMenu();

        _updateItem = new MenuItem { Header = "Update available", Visibility = Visibility.Collapsed };
        _updateItem.Click += (_, _) => _ = UpdateChecker.Shared.InstallAvailable();
        menu.Items.Add(_updateItem);

        _checkItem = new MenuItem { Header = "Check for Updates…" };
        _checkItem.Click += (_, _) => _ = UpdateChecker.Shared.Check(manual: true);
        menu.Items.Add(_checkItem);

        menu.Items.Add(new Separator());

        var shortcut = new MenuItem
        {
            Header = "Global Allow / Deny shortcut (Ctrl+Alt+A / Ctrl+Alt+D)",
            IsCheckable = true,
            IsChecked = Settings.GlobalApprovalShortcut,
            ToolTip = "Allow / deny the newest pending request without opening the popover",
        };
        shortcut.Click += (_, _) =>
        {
            Settings.GlobalApprovalShortcut = shortcut.IsChecked;
            ApplyHotKeyState();
        };
        menu.Items.Add(shortcut);

        var autostart = new MenuItem
        {
            Header = "Start at login",
            IsCheckable = true,
            IsChecked = Autostart.Enabled,
        };
        autostart.Click += (_, _) =>
        {
            Autostart.SetEnabled(autostart.IsChecked);
            autostart.IsChecked = Autostart.Enabled; // reflect the actual result
        };
        menu.Items.Add(autostart);

        menu.Items.Add(new Separator());

        var quit = new MenuItem { Header = "Quit AgentBar" };
        quit.Click += (_, _) => Application.Current.Shutdown();
        menu.Items.Add(quit);
        return menu;
    }

    private void OnUpdateChanged()
    {
        var uc = UpdateChecker.Shared;
        _checkItem.Header = uc.Status switch
        {
            UpdateChecker.State.Checking => "Checking for updates…",
            UpdateChecker.State.UpToDate => "Up to date",
            UpdateChecker.State.Failed => "Update check failed — Retry",
            _ => "Check for Updates…",
        };
        var showUpdate = uc.Status is UpdateChecker.State.Available or UpdateChecker.State.Downloading;
        _updateItem.Visibility = showUpdate ? Visibility.Visible : Visibility.Collapsed;
        _updateItem.IsEnabled = uc.Status == UpdateChecker.State.Available;
        _updateItem.Header = uc.Status == UpdateChecker.State.Downloading
            ? $"Downloading {uc.LatestVersion}…"
            : $"Update to {uc.LatestVersion} — Install & Relaunch";
    }

    public void Dispose()
    {
        _sessionStore.Dispose();
        _requestStore.Dispose();
        _hotKeys.Dispose();
        _animator.Dispose();
        _icon.Dispose();
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using AgentBar.Models;
using AgentBar.Rendering;

namespace AgentBar.Tray;

/// Borderless panel anchored to the bottom-right, near the notification area —
/// a custom-rendered surface, not a system context menu.
public partial class PopoverWindow : Window
{
    public PopoverWindow() => InitializeComponent();

    /// When the window last auto-hid on losing focus. TrayController uses this to tell
    /// a "click to open" apart from the click that just dismissed the popover.
    public DateTime LastHidden { get; private set; } = DateTime.MinValue;

    public void Update(IReadOnlyList<Session> sessions,
                       IReadOnlyList<ApprovalRequest> approvals,
                       Action<ApprovalRequest, string> onChoose,
                       Action<Session> onKeystroke)
    {
        var approvalRows = approvals.Select(a => ApprovalRow.From(a, onChoose)).ToList();
        Approvals.ItemsSource = approvalRows;

        // Don't show a plain session row for a session that has an actionable approval card.
        var pending = approvals.Select(a => a.SessionId).ToHashSet();
        var sessionRows = sessions.Where(s => !pending.Contains(s.Id))
                                  .Select(s => SessionRow.From(s, onKeystroke)).ToList();
        List.ItemsSource = sessionRows;

        EmptyLabel.Visibility = approvalRows.Count == 0 && sessionRows.Count == 0
            ? Visibility.Visible : Visibility.Collapsed;
    }

    public void ShowNearTray()
    {
        // Realize off-screen first so ActualHeight is known before we place it.
        Opacity = 0;
        Left = -10000;
        Top = -10000;
        Show();
        Dispatcher.BeginInvoke(new Action(PositionNearTray), System.Windows.Threading.DispatcherPriority.Loaded);
    }

    /// Anchor to the bottom-right of the monitor under the cursor, DPI-correct.
    private void PositionNearTray()
    {
        var work = TrayInterop.WorkAreaUnderCursor(); // device pixels, cursor's monitor
        var source = PresentationSource.FromVisual(this);
        if (work is { } wr && source?.CompositionTarget is { } target)
        {
            // Map the monitor's bottom-right corner from device pixels to WPF DIPs.
            var corner = target.TransformFromDevice.Transform(new Point(wr.Right, wr.Bottom));
            Left = corner.X - Width - 12;
            Top = corner.Y - ActualHeight - 12;
        }
        else
        {
            var wa = SystemParameters.WorkArea; // fallback: primary screen
            Left = wa.Right - Width - 12;
            Top = wa.Bottom - ActualHeight - 12;
        }
        Opacity = 1;
        Activate();
    }

    private void OnDeactivated(object? sender, EventArgs e)
    {
        LastHidden = DateTime.UtcNow;
        Hide();
    }

    // MARK: - Row view models

    /// One live session row.
    public sealed class SessionRow
    {
        public string AgentName { get; init; } = "";
        public string StateText { get; init; } = "";
        public string SubText { get; init; } = "";
        public Brush DotBrush { get; init; } = Brushes.Gray;

        /// A permission-state session for a keystroke agent (Codex/Copilot) has no request
        /// file, so it gets a best-effort "Approve in terminal" button instead of a card.
        public bool CanKeystroke { get; init; }
        public ICommand? Keystroke { get; init; }

        public static SessionRow From(Session s, Action<Session> onKeystroke)
        {
            var branch = s.GitBranch;
            var place = s.Project;
            if (!string.IsNullOrEmpty(branch))
                place = string.IsNullOrEmpty(place) ? branch : $"{place} · {branch}";

            var sub = string.IsNullOrEmpty(s.Label)
                ? place
                : string.IsNullOrEmpty(place) ? s.Label : $"{s.Label} — {place}";

            var dot = new SolidColorBrush(StatusColors.For(s.State));
            dot.Freeze();

            var canKeystroke = s.State == SessionState.Permission && s.Agent.ApproveKeys is not null;

            return new SessionRow
            {
                AgentName = s.Agent.Name,
                StateText = StateLabel(s.State),
                SubText = sub,
                DotBrush = dot,
                CanKeystroke = canKeystroke,
                Keystroke = canKeystroke ? new RelayCommand(_ => onKeystroke(s)) : null,
            };
        }

        private static string StateLabel(SessionState state) => state switch
        {
            SessionState.Permission => "needs approval",
            SessionState.Question => "waiting",
            SessionState.Thinking => "thinking",
            SessionState.Tool => "working",
            SessionState.Done => "done",
            _ => "idle",
        };
    }

    /// One pending approval card, with inline context and decision buttons.
    public sealed class ApprovalRow
    {
        public string Display { get; init; } = "";
        public IReadOnlyList<ContextLine> ContextLines { get; init; } = Array.Empty<ContextLine>();
        public bool HasContext => ContextLines.Count > 0;
        public bool HasRule { get; init; }
        public string? RuleTooltip { get; init; }
        public ICommand Choose { get; init; } = null!;

        public static ApprovalRow From(ApprovalRequest req, Action<ApprovalRequest, string> onChoose)
        {
            var rule = req.RuleMenuTitle;
            return new ApprovalRow
            {
                Display = req.Display,
                ContextLines = ContextLine.Build(req.Context),
                HasRule = rule is not null,
                RuleTooltip = rule is null ? null : $"Always allow: {req.RuleDescription}",
                Choose = new RelayCommand(p => onChoose(req, (string)p!)),
            };
        }
    }

    /// One rendered line of approval context (a command line, or a diff +/− line).
    public sealed class ContextLine
    {
        public string Gutter { get; init; } = " ";
        public Brush GutterBrush { get; init; } = Brushes.Transparent;
        public string Text { get; init; } = "";
        public Brush TextBrush { get; init; } = Dim;

        private enum Kind { Plain, Add, Del }

        private static readonly Brush AddBrush = Frozen(0x30, 0xD1, 0x58);
        private static readonly Brush DelBrush = Frozen(0xFF, 0x6B, 0x6B);
        private static readonly Brush Bright = Frozen(0xDD, 0xDD, 0xDD);
        private static readonly Brush Dim = Frozen(0x9A, 0x9A, 0x9A);

        public static IReadOnlyList<ContextLine> Build(ApprovalContext? context)
        {
            switch (context)
            {
                case ApprovalContext.Bash b:
                    return Take(Split(b.Command), 5, Kind.Plain);
                case ApprovalContext.Write w:
                    return Take(Split(w.Preview), 5, Kind.Plain);
                case ApprovalContext.Diff d:
                    var lines = new List<ContextLine>();
                    lines.AddRange(Take(Split(d.Old), 3, Kind.Del));
                    lines.AddRange(Take(Split(d.New), 3, Kind.Add));
                    if (d.More > 0)
                        lines.Add(Make(Kind.Plain, $"+{d.More} more edit{(d.More == 1 ? "" : "s")}"));
                    return lines.Count == 0 ? new[] { Make(Kind.Plain, "(no change)") } : lines;
                default:
                    return Array.Empty<ContextLine>();
            }
        }

        private static string[] Split(string s) => s.Replace("\r", "").Split('\n');

        /// First `max` lines; if truncated, the last becomes an ellipsis marker.
        private static List<ContextLine> Take(string[] all, int max, Kind kind)
        {
            if (all.Length <= max)
                return all.Select(t => Make(kind, t)).ToList();

            var outp = all.Take(max - 1).Select(t => Make(kind, t)).ToList();
            outp.Add(Make(Kind.Plain, $"… (+{all.Length - (max - 1)} more lines)"));
            return outp;
        }

        private static ContextLine Make(Kind kind, string text) => kind switch
        {
            Kind.Add => new ContextLine { Gutter = "+", GutterBrush = AddBrush, Text = text, TextBrush = Bright },
            Kind.Del => new ContextLine { Gutter = "−", GutterBrush = DelBrush, Text = text, TextBrush = Dim },
            _ => new ContextLine { Gutter = " ", GutterBrush = Brushes.Transparent, Text = text, TextBrush = Dim },
        };

        private static Brush Frozen(byte r, byte g, byte b)
        {
            var brush = new SolidColorBrush(Color.FromRgb(r, g, b));
            brush.Freeze();
            return brush;
        }
    }
}

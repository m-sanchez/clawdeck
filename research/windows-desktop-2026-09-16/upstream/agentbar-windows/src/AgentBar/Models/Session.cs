using System.IO;
using System.Text.Json;
using AgentBar.Agents;

namespace AgentBar.Models;

/// One live agent session, decoded from a ~/.agentbar/state.d/*.json file
/// written by the hook scripts in scripts/hooks/. Parsing is deliberately tolerant
/// (missing/mistyped fields fall back to defaults).
public sealed class Session
{
    public string Id { get; init; } = "";
    public string AgentId { get; init; } = "claude";
    public SessionState State { get; init; }
    public string Label { get; init; } = "";
    public string Project { get; init; } = "";
    public string Cwd { get; init; } = "";
    public string Entrypoint { get; init; } = "";
    public string TermProgram { get; init; } = "";
    public int Pid { get; init; }
    public bool Started { get; init; } = true;
    public double Ts { get; init; }

    public int Priority => State.Priority();
    public Agent Agent => AgentCatalog.ById(AgentId);

    public static Session? FromFile(string filePath)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(filePath));
            var o = doc.RootElement;
            return new Session
            {
                Id = Path.GetFileNameWithoutExtension(filePath),
                AgentId = Str(o, "agent", "claude"),
                State = SessionStateExtensions.Parse(Str(o, "state", "")),
                Label = Str(o, "label", ""),
                Project = Str(o, "project", ""),
                Cwd = Str(o, "cwd", ""),
                Entrypoint = Str(o, "entrypoint", ""),
                TermProgram = Str(o, "term_program", ""),
                Pid = Int(o, "pid", 0),
                Started = Bool(o, "started", true),
                Ts = Dbl(o, "ts", 0),
            };
        }
        catch { return null; }
    }

    /// Current git branch of the session's project, read straight from .git/HEAD
    /// (no `git` invocation; handles worktrees via the `gitdir:` indirection).
    public string? GitBranch
    {
        get
        {
            if (string.IsNullOrEmpty(Cwd)) return null;
            var gitPath = Path.Combine(Cwd, ".git");
            var isFile = File.Exists(gitPath);
            if (!isFile && !Directory.Exists(gitPath)) return null;
            if (isFile) // worktree: .git is a file containing "gitdir: <path>"
            {
                try
                {
                    var s = File.ReadAllText(gitPath);
                    var idx = s.IndexOf(':');
                    if (idx < 0) return null;
                    gitPath = s[(idx + 1)..].Trim();
                }
                catch { return null; }
            }
            try
            {
                var head = File.ReadAllText(Path.Combine(gitPath, "HEAD")).Trim();
                const string prefix = "ref: refs/heads/";
                if (head.StartsWith(prefix)) return head[prefix.Length..];
                return head.Length >= 7 ? head[..7] : head; // detached HEAD: short SHA
            }
            catch { return null; }
        }
    }

    private static string Str(JsonElement o, string k, string def) =>
        o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? def) : def;

    private static int Int(JsonElement o, string k, int def) =>
        o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : def;

    private static bool Bool(JsonElement o, string k, bool def) =>
        o.TryGetProperty(k, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : def;

    private static double Dbl(JsonElement o, string k, double def) =>
        o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var n) ? n : def;
}

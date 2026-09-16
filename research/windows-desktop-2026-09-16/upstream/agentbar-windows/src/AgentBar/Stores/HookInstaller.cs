using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace AgentBar.Stores;

/// Idempotent hook installation, re-run on every launch (scripts refresh with the app;
/// configs are only rewritten when the content actually changes). Copies the bundled
/// hook scripts to ~/.agentbar/hooks/ and wires them into each agent's own hook
/// mechanism. Never blocks the UI; failures are swallowed and retried next launch.
/// Resolves the node binary from Program Files or PATH before wiring the Node-based hooks.
public static class HookInstaller
{
    private static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    private static string HooksDir => Path.Combine(Home, ".agentbar", "hooks");
    private static string BundledHooks => Path.Combine(AppContext.BaseDirectory, "hooks");

    private static readonly string? NodePath = FindNode();

    public static void InstallIfNeeded()
    {
        Task.Run(() =>
        {
            try
            {
                CopyScripts();
                foreach (var dir in ClaudeConfigDirs()) InstallClaude(dir);
                InstallCodex();
                InstallCursor();
                InstallGemini();
            }
            catch (Exception e)
            {
                Debug.WriteLine($"AgentBar hook install failed: {e}");
            }
        });
    }

    // MARK: - Node discovery (GUI apps often launch with a lean PATH)

    private static string? FindNode()
    {
        var candidates = new List<string>();
        var pf = Environment.GetEnvironmentVariable("ProgramFiles");
        if (!string.IsNullOrEmpty(pf)) candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
        candidates.Add(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "nodejs", "node.exe"));
        var hit = candidates.FirstOrDefault(File.Exists);
        if (hit is not null) return hit;

        // Ask the shell: `where node` resolves version-manager / custom installs.
        try
        {
            var psi = new ProcessStartInfo("where.exe", "node")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = Process.Start(psi);
            if (p is not null)
            {
                var first = p.StandardOutput.ReadLine()?.Trim();
                p.WaitForExit(2000);
                if (!string.IsNullOrEmpty(first) && File.Exists(first)) return first;
            }
        }
        catch { /* fall through */ }
        return null;
    }

    // MARK: - Script copy (always refreshed — versioned with the app)

    private static void CopyScripts()
    {
        if (!Directory.Exists(BundledHooks)) return;
        Directory.CreateDirectory(HooksDir);
        foreach (var src in Directory.GetFiles(BundledHooks, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(BundledHooks, src);
            var dest = Path.Combine(HooksDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(src, dest, overwrite: true);
        }
    }

    // MARK: - Claude Code (<configDir>/settings.json)

    /// Default ~/.claude plus a custom CLAUDE_CONFIG_DIR (env or the hint file the
    /// installer may drop), deduped — so a user who runs Claude both ways stays covered.
    private static IEnumerable<string> ClaudeConfigDirs()
    {
        var dirs = new List<string> { Path.Combine(Home, ".claude") };

        var env = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
        if (!string.IsNullOrEmpty(env)) dirs.Add(Expand(env));

        var hint = Path.Combine(Home, ".agentbar", "claude-config-dir");
        try
        {
            var raw = File.ReadAllText(hint).Trim();
            if (!string.IsNullOrEmpty(raw)) dirs.Add(Expand(raw));
        }
        catch { /* no hint file */ }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return dirs.Where(d => seen.Add(Path.GetFullPath(d)));
    }

    private static void InstallClaude(string configDir)
    {
        if (NodePath is null) return;
        var settingsPath = Path.Combine(configDir, "settings.json");
        Directory.CreateDirectory(configDir);

        var root = ReadConfig(settingsPath);
        if (root is null) return; // present but unparseable → never clobber
        if (root["hooks"] is not JsonObject hooks) { hooks = new JsonObject(); root["hooks"] = hooks; }

        var dir = Path.Combine(HooksDir, "claude");
        var events = new (string Event, string Cmd, bool Matcher, int? Timeout)[]
        {
            ("SessionStart",     Node($"\"{Path.Combine(dir, "lifecycle.js")}\" start"), false, null),
            ("SessionEnd",       Node($"\"{Path.Combine(dir, "lifecycle.js")}\" end"),   false, null),
            ("UserPromptSubmit", Node($"\"{Path.Combine(dir, "update.js")}\" prompt"),   false, null),
            ("PreToolUse",       Node($"\"{Path.Combine(dir, "update.js")}\" pre"),      true,  null),
            ("PostToolUse",      Node($"\"{Path.Combine(dir, "update.js")}\" post"),     true,  null),
            // Blocking approval hook: its own wait is 600s, so give Claude Code slack.
            ("PermissionRequest", Node($"\"{Path.Combine(dir, "permission.js")}\""),     true,  630),
            ("Stop",             Node($"\"{Path.Combine(dir, "update.js")}\" stop"),     false, null),
        };

        // Drop earlier AgentBar entries from EVERY event, so events we no longer
        // register don't linger from old installs.
        foreach (var key in hooks.Select(kv => kv.Key).ToList())
        {
            if (hooks[key] is not JsonArray rules) continue;
            for (var i = rules.Count - 1; i >= 0; i--)
            {
                if (rules[i] is not JsonObject rule) continue;
                var inner = rule["hooks"] as JsonArray;
                var ours = inner is not null && inner.Any(h => IsOurs(AsString((h as JsonObject)?["command"]), "claude"));
                if (ours) rules.RemoveAt(i);
            }
            if (rules.Count == 0) hooks.Remove(key);
        }

        foreach (var e in events)
        {
            if (hooks[e.Event] is not JsonArray rules) { rules = new JsonArray(); hooks[e.Event] = rules; }
            var hookEntry = new JsonObject { ["type"] = "command", ["command"] = e.Cmd };
            if (e.Timeout is int t) hookEntry["timeout"] = t;
            var rule = new JsonObject { ["hooks"] = new JsonArray(hookEntry) };
            if (e.Matcher) rule["matcher"] = "*";
            rules.Add(rule);
        }

        WriteIfChanged(root, settingsPath);
    }

    // MARK: - Codex (~/.codex/config.toml, notify hook)

    private static void InstallCodex()
    {
        if (NodePath is null) return;
        var codexDir = Path.Combine(Home, ".codex");
        if (!Directory.Exists(codexDir)) return; // not a Codex user

        var configPath = Path.Combine(codexDir, "config.toml");
        var config = File.Exists(configPath) ? File.ReadAllText(configPath) : "";
        if (Normalize(config).Contains("/.agentbar/hooks/codex/")) return; // already ours
        if (Regex.IsMatch(config, @"(?m)^\s*notify\s*=")) return; // user's own notify — don't touch

        var script = Path.Combine(HooksDir, "codex", "notify.js");
        if (config.Length > 0 && !config.EndsWith("\n")) config += "\n";
        // TOML literal (single-quoted) strings don't process backslash escapes — ideal for Windows paths.
        config += $"notify = ['{NodePath}', '{script}']\n";
        File.WriteAllText(configPath, config);
    }

    // MARK: - Cursor CLI (~/.cursor/hooks.json)

    private static void InstallCursor()
    {
        if (NodePath is null) return; // Windows has no shebang; the command must invoke node
        var cursorDir = Path.Combine(Home, ".cursor");
        if (!Directory.Exists(cursorDir)) return; // not a Cursor user

        var cfgPath = Path.Combine(cursorDir, "hooks.json");
        var command = Node($"\"{Path.Combine(HooksDir, "cursor", "cursor.js")}\"");

        var root = ReadConfig(cfgPath);
        if (root is null) return;
        root["version"] ??= 1;
        if (root["hooks"] is not JsonObject hooks) { hooks = new JsonObject(); root["hooks"] = hooks; }

        // Observational events only; the before* hooks gate permissions and belong to the user.
        foreach (var e in new[] { "sessionStart", "sessionEnd", "preToolUse", "postToolUse", "afterAgentResponse", "stop" })
        {
            var rules = new JsonArray();
            if (hooks[e] is JsonArray existing)
                foreach (var r in existing.ToList())
                    if (!IsOurs(AsString((r as JsonObject)?["command"]), "cursor"))
                        rules.Add(r!.DeepClone());
            rules.Add(new JsonObject { ["command"] = command });
            hooks[e] = rules;
        }

        WriteIfChanged(root, cfgPath);
    }

    // MARK: - Gemini CLI (~/.gemini/settings.json)

    private static void InstallGemini()
    {
        if (NodePath is null) return;
        var geminiDir = Path.Combine(Home, ".gemini");
        if (!Directory.Exists(geminiDir)) return; // not a Gemini user

        var cfgPath = Path.Combine(geminiDir, "settings.json");
        var command = Node($"\"{Path.Combine(HooksDir, "gemini", "gemini.js")}\"");

        var root = ReadConfig(cfgPath);
        if (root is null) return;
        if (root["hooks"] is not JsonObject hooks) { hooks = new JsonObject(); root["hooks"] = hooks; }

        // Gemini groups hooks as [{ hooks: [{type:"command", command, timeout}] }]. timeout in ms.
        foreach (var e in new[] { "SessionStart", "SessionEnd", "BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent" })
        {
            var groups = new JsonArray();
            if (hooks[e] is JsonArray existing)
                foreach (var g in existing.ToList())
                {
                    var inner = (g as JsonObject)?["hooks"] as JsonArray;
                    var ours = inner is not null && inner.Any(h => IsOurs(AsString((h as JsonObject)?["command"]), "gemini"));
                    if (!ours) groups.Add(g!.DeepClone());
                }
            groups.Add(new JsonObject
            {
                ["hooks"] = new JsonArray(new JsonObject { ["type"] = "command", ["command"] = command, ["timeout"] = 5000 }),
            });
            hooks[e] = groups;
        }

        WriteIfChanged(root, cfgPath);
    }

    // MARK: - Helpers

    /// A node-invoking command string: "<node>" <args...>.
    private static string Node(string args) => $"\"{NodePath}\" {args}";

    private static bool IsOurs(string? command, string agent) =>
        command is not null && Normalize(command).Contains($"/.agentbar/hooks/{agent}/");

    private static string Normalize(string s) => s.Replace('\\', '/').ToLowerInvariant();

    private static string? AsString(JsonNode? node) =>
        node is JsonValue v && v.TryGetValue(out string? s) ? s : null;

    private static string Expand(string path) =>
        Environment.ExpandEnvironmentVariables(path.Replace("~", Home));

    /// Missing file → empty object (fresh install). Present-but-unparseable → null:
    /// the caller must SKIP, never overwrite, or it would destroy the user's config.
    private static JsonObject? ReadConfig(string path)
    {
        if (!File.Exists(path)) return new JsonObject();
        try { return JsonNode.Parse(File.ReadAllText(path)) as JsonObject; }
        catch { return null; }
    }

    /// Atomic write, skipped when the file already has exactly this content — avoids
    /// mtime churn (tools watch these configs) and shrinks the racing window.
    private static void WriteIfChanged(JsonObject root, string path)
    {
        var json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        try { if (File.Exists(path) && File.ReadAllText(path) == json) return; } catch { /* re-write */ }

        var tmp = path + "." + Environment.ProcessId + ".tmp";
        try
        {
            File.WriteAllText(tmp, json);
            File.Move(tmp, path, overwrite: true);
        }
        catch
        {
            try { File.Delete(tmp); } catch { /* ignore */ }
        }
    }
}

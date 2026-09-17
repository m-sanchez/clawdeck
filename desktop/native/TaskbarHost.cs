using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Web.Script.Serialization;
using Windows.UI.Shell.Tasks;

namespace Ocelin {
    public class Entry {
        public string key { get; set; }
        public string title { get; set; }
        public string subtitle { get; set; }
        public string text { get; set; }
        public string uri { get; set; }
        public int state { get; set; }
    }
    public class Snapshot {
        public long sampledAt { get; set; }
        public bool enabled { get; set; }
        public Entry[] tasks { get; set; }
    }
    internal class TaskbarHost {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072 };
        static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ocelin");
        static readonly string Input = Path.Combine(Dir, "native-tasks.json");
        static readonly string Status = Path.Combine(Dir, "native-status.json");
        static readonly Dictionary<string, AppTaskInfo> Tasks = new Dictionary<string, AppTaskInfo>();
        static string Short(string value, int max) { return (value ?? "").Substring(0, Math.Min((value ?? "").Length, max)); }
        static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
        static void Report(bool supported, string error) {
            Directory.CreateDirectory(Dir);
            string temp = Status + ".tmp";
            File.WriteAllText(temp, Json.Serialize(new { sampledAt = Now(), supported, error, tasks = Tasks.Count, pid = System.Diagnostics.Process.GetCurrentProcess().Id }));
            if (File.Exists(Status)) File.Replace(temp, Status, null); else File.Move(temp, Status);
        }
        static bool Valid(Entry e) {
            Uri u;
            return e != null && !String.IsNullOrEmpty(e.key) && e.key.Length <= 160 &&
                Uri.TryCreate(e.uri, UriKind.Absolute, out u) && u.Scheme == "ocelin" &&
                (u.Host == "session" || u.Host == "dashboard") && e.state >= 0 && e.state <= 4;
        }
        static void Sync(Snapshot value) {
            var entries = value.enabled && Now() - value.sampledAt < 45000 && value.sampledAt <= Now() + 5000
                ? (value.tasks ?? new Entry[0]).Where(Valid).Take(13).ToArray() : new Entry[0];
            var keep = new HashSet<string>(entries.Select(e => e.uri));
            foreach (var pair in Tasks.ToArray()) {
                if (keep.Contains(pair.Key)) continue;
                pair.Value.Remove();
                Tasks.Remove(pair.Key);
            }
            foreach (var entry in entries) {
                var content = entry.state == 0
                    ? AppTaskContent.CreateSequenceOfSteps(new string[0], Short(entry.text, 400))
                    : AppTaskContent.CreateTextSummaryResult(Short(entry.text, 400));
                if (entry.state == 2) {
                    content.SetQuestion("Continue in the owning app");
                    content.AddButton("Open conversation", new Uri(entry.uri));
                }
                AppTaskInfo task;
                if (!Tasks.TryGetValue(entry.uri, out task)) {
                    task = AppTaskInfo.Create(Short(entry.title, 120), Short(entry.subtitle, 160), new Uri(entry.uri), new Uri("ms-appx:///Assets/ocelin.png"), content);
                    if (task == null) throw new InvalidOperationException("Windows did not create the task. Check package identity and App Tasks availability.");
                    Tasks[entry.uri] = task;
                } else {
                    task.UpdateTitles(Short(entry.title, 120), Short(entry.subtitle, 160));
                }
                task.Update((AppTaskState)entry.state, content);
            }
        }
        [STAThread]
        static void Main(string[] args) {
            bool created;
            using (var mutex = new Mutex(true, "Local\\Ocelin.AppTasks", out created)) {
                if (!created) return;
                try {
                    if (!AppTaskInfo.IsSupported()) { Report(false, "App Tasks is not available on this Windows build."); return; }
                    var existing = AppTaskInfo.FindAll();
                    foreach (var task in existing ?? new AppTaskInfo[0]) if (task.DeepLink != null) Tasks[task.DeepLink.ToString()] = task;
                    string previous = null;
                    long heartbeat = 0;
                    do {
                        try {
                            string raw = File.Exists(Input) ? File.ReadAllText(Input) : "{}";
                            var value = Json.Deserialize<Snapshot>(raw);
                            if (raw != previous || Now() - heartbeat > 15000) {
                                Sync(value);
                                Report(true, null);
                                previous = raw;
                                heartbeat = Now();
                            }
                            if (!value.enabled || Now() - value.sampledAt > 45000) break;
                        } catch (IOException) { }
                        if (args.Contains("--once")) break;
                        Thread.Sleep(2000);
                    } while (true);
                } catch (Exception error) { Report(false, error.Message); }
            }
        }
    }
}

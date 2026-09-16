namespace AgentBar.Models;

/// Lifecycle state of one agent session. Raw string values match the hook JSON.
public enum SessionState { Idle, Thinking, Tool, Permission, Question, Done }

public static class SessionStateExtensions
{
    public static SessionState Parse(string? raw) => raw switch
    {
        "idle" => SessionState.Idle,
        "thinking" => SessionState.Thinking,
        "tool" => SessionState.Tool,
        "permission" => SessionState.Permission,
        "question" => SessionState.Question,
        "done" => SessionState.Done,
        _ => SessionState.Idle,
    };

    public static bool IsWorking(this SessionState s) => s is SessionState.Thinking or SessionState.Tool;

    /// Sort/priority weight: what the tray should surface first.
    public static int Priority(this SessionState s) => s switch
    {
        SessionState.Permission => 3,
        SessionState.Question => 2,
        SessionState.Thinking or SessionState.Tool => 1,
        _ => 0,
    };
}

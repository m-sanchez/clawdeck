export type ClawdState =
  | "sleeping"
  | "thinking"
  | "idle"
  | "reading"
  | "coding"
  | "inspecting"
  | "reviewing"
  | "waiting"
  | "attention"
  | "blocked"
  | "success";

export type ClawdMotion = "full" | "reduced" | "none";

export interface ClawdPresentation {
  state: ClawdState;
  message?: string;
  motion: ClawdMotion;
  showBadge: boolean;
  patrol: boolean;
}

export interface WorkflowClawdFacts {
  blocked?: boolean;
  requiresInput?: boolean;
  completed?: boolean;
  phase?:
    | "investigating"
    | "planning"
    | "implementing"
    | "validating"
    | "reviewing"
    | "waiting"
    | "idle";
  hasActiveRun?: boolean;
}

export function deriveClawdState(facts: WorkflowClawdFacts): ClawdState {
  if (facts.blocked) return "blocked";
  if (facts.requiresInput) return "attention";
  if (facts.completed) return "success";

  switch (facts.phase) {
    case "investigating":
      return "reading";
    case "planning":
      return "thinking";
    case "implementing":
      return "coding";
    case "validating":
      return "inspecting";
    case "reviewing":
      return "reviewing";
    case "waiting":
      return "waiting";
    case "idle":
      return facts.hasActiveRun ? "idle" : "sleeping";
    default:
      return facts.hasActiveRun ? "idle" : "sleeping";
  }
}

# Clawd production specification

## Canonical reference

`reference/clawd-playground-v16.html` is the authoritative visual and behavioural reference.

The production component may use SVG, Angular templates, Web Components or framework-independent TypeScript, but it must preserve the reference result.

## Identity

Clawd is a compact blue pixel-like assistant inspired by the Claude pet silhouette.

Required characteristics:

- broad, squat blue body
- no mouth
- small dark eyes
- four short legs
- short side arms
- flat, simple shapes
- restrained shading
- crisp, game-like pose changes
- expressive through eyes and limbs rather than facial detail

## State contract

| State | Meaning | Main behaviour |
|---|---|---|
| sleeping | Nothing active | planted, closed eyes, subtle breathing, Zs |
| thinking | Planning/considering | planted, eyes up, hand-to-chin pose, thought bubble |
| idle | Quiet supervision | footer patrol, blink/look variation, grounded turnaround |
| reading | Gathering context | planted, compact open book, eye scan/page motion |
| coding | Implementing | planted, laptop, typing bursts, live screen detail |
| inspecting | Validation/investigation | planted, magnifying glass, connected hand/lens sweep |
| reviewing | Final review | planted, clipboard, checklist scan/check pulse |
| waiting | External operation | planted, calm dots and slow weight shift |
| attention | User input required | planted, raised-arm call, persistent message |
| blocked | Cannot continue | planted, slumped pose, warning sign, persistent message |
| success | Completed | one brief celebration, then calm happy settle |

## Priority rules

- Blocked outranks all other states.
- Attention outranks active phases.
- Success is brief and should settle.
- Idle is the only state that patrols.
- Sleeping is appropriate when there is no meaningful activity.

## Message rules

- Attention and blocked messages remain visible.
- Other messages appear briefly after state changes.
- Messages reappear on hover or focus.
- Message bubbles must not overlap Clawd, props, thought bubbles or badges.
- Production copy should be specific to the selected run when possible.

## Badge rules

Default production recommendation:

- attention: visible
- blocked: visible
- success: optionally visible briefly
- all other states: hidden unless product testing proves value

## Animation rules

- Prefer `steps()` timing for sprite-like loops.
- Keep body vertical movement to roughly 1–2 logical pixels.
- Let limbs carry most of the walk motion.
- Keep static-state props planted and readable.
- Use occasional gestures, not constant frantic loops.
- State-entry transitions should be short and truthful.
- Pause expensive or decorative animation when the document is hidden.
- Respect `prefers-reduced-motion` and the user's explicit motion setting.

## Geometry and anchoring

Define explicit anchor points for:

- left/right shoulder
- left/right hand
- four foot contacts
- eye centers
- prop origin
- message anchor
- badge anchor

Props should be attached to hand anchors rather than independently eyeballed absolute positions.

## Collision constraints

At every supported size:

- message vs body: no overlap
- message vs prop: no overlap
- message vs thought bubble: no overlap
- tooltip vs thought bubble: no overlap
- badge vs message: no overlap
- prop vs footer clipping: no accidental clipping
- assistant vs drawers/toasts/mobile nav: no interaction obstruction

## Demo mode

The playground may cycle states and expose controls. Production mode must not cycle fake states.

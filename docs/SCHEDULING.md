# Scheduling — agent-facing inference rules

This document is for agents (Claude / opencode / etc.) deciding **which session policy** to pick when a user asks to schedule a job. Humans reading the README only need the [Session policies](../README.md#session-policies) table; this file goes deeper into when to escalate.

## Default

Always start with `sessionPolicy='current'` unless a user cue clearly suggests otherwise. Most users want their scheduled run to land in the chat they're in — that's the principle of least surprise.

## Inference table

| User says (paraphrased) | Pick |
|--|--|
| "Schedule X every day" / "Set up a daily job" / "Run X tomorrow morning" | `current` |
| "Independent job" / "Separate chat" / "Don't mess up this thread" / "независимая джоба" | `new-per-job` |
| "New session each run" / "Fresh chat every time" / "Каждый запуск отдельно" | `new-per-run` |
| "Use my session abc-123" / explicit session id given | `existing` (require `sessionId`) |
| "Run on the server at http://X:4096" / explicit attachUrl | keep current `sessionPolicy`; set `attachUrl` |

### sessionId precedence with `current`

If both `sessionPolicy='current'` and an explicit `sessionId` are passed, the explicit `sessionId` wins over `toolCtx.sessionID`. This is intentional: it lets an agent call `schedule_job` on behalf of a session it isn't currently inside (e.g. "schedule into the chat I had open ten minutes ago", or scripted bulk-scheduling). When you have no override, `current` resolves from the calling session — the principle of least surprise.

If you want strict "always the current chat, ignore any sessionId arg" behavior, prefer leaving `sessionId` undefined.

## Permission caveat

The scheduler **does not** mutate an existing session's permission ruleset (`current` / `existing`) — there is no public route to do so. Only sessions created by the scheduler itself (`new-per-job`, `new-per-run`) are guaranteed to have `question` / `plan_enter` / `plan_exit` denied. Headless fallback still gets `OPENCODE_PERMISSION={"question":"deny"}` via supervisor env, so even into a question-asking session the headless path won't block.

If a user explicitly says "no questions, no prompts" and they want strict guarantees, suggest `new-per-job` rather than dropping the request into `current`.

## When to ask vs. just decide

Ask the user only when:

1. The request is **destructive** (e.g. "schedule X to delete all stale branches") AND the policy choice changes which session bears the side effects.
2. The phrasing is genuinely ambiguous AND defaulting to `current` would interfere with the user's current chat.

Otherwise, decide and move on. A wrong session-policy guess is cheap to fix (`update_job ... sessionPolicy=...`).

## Execution + delivery axes

These are orthogonal to session policy and almost always default-fine:

- **executionPolicy** — leave at `prefer-live-server` unless the user says "always run as a separate process" / "no shared server". `headless-only` is mostly useful when the user doesn't want the scheduler talking to a long-lived server.
- **deliveryPolicy** — leave at `execute` unless the user says "queue the message" / "don't wait" / "leave it in the chat for me". `leave-message` posts with `noReply: true` so the message lands in the session for the user/agent to pick up later.

## Examples

```
User: "schedule a daily 9am job to summarize my GitHub notifs"
  → sessionPolicy='current'  executionPolicy='prefer-live-server'  deliveryPolicy='execute'

User: "set up a separate background job to run every 6 hours"
  → sessionPolicy='new-per-job'  (rest defaults)

User: "every fire should be a fresh session, don't share state"
  → sessionPolicy='new-per-run'  (rest defaults)

User: "leave a status report message in my chat every morning, I'll read it when I get in"
  → sessionPolicy='current'  deliveryPolicy='leave-message'

User: "schedule on the server at http://192.168.1.42:4096"
  → sessionPolicy='current'  attachUrl='http://192.168.1.42:4096'
    (or 'new-per-job' if user also wants a separate session)
```

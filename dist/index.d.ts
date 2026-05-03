/**
 * OpenCode Scheduler Plugin
 *
 * Schedule recurring jobs using launchd (Mac), systemd (Linux), schtasks (Windows), or cron fallback.
 * Jobs are stored under ~/.config/opencode/scheduler/ (scoped by workdir).
 *
 * Features:
 * - Survives reboots
 * - Catches up on missed runs (if computer was asleep)
 * - Cross-platform (Mac + Linux + Windows)
 * - Working directory support for MCP configs
 * - Environment variable injection (PATH for node/npx)
 */
import type { Plugin } from "@opencode-ai/plugin";
import type { BadRequestError } from "@opencode-ai/sdk";
type OpencodeRunFormat = "default" | "json";
type SchedulerEnvMode = "snapshot" | "minimal" | "login-shell";
/**
 * Scheduler-level env config (read from
 * `~/.config/opencode/opencode-scheduler.json`).
 *
 * `mode`     — default 'snapshot' (capture full process.env minus denylist).
 *              'minimal' = only PATH/HOME/USER/SHELL.
 *              'login-shell' = wrap invocation in `$SHELL -lic ...` (S3).
 * `exclude`  — extends the scheduler-internal denylist for additional keys
 *              the user does not want baked into job env.
 * `set`      — explicit overrides applied after the snapshot.
 *
 * Legacy keys `preserve` / `preserveOpencodeEnv` are accepted for
 * back-compat but ignored with a one-shot warn-log on first read.
 */
type SchedulerEnvConfig = {
    mode?: SchedulerEnvMode;
    exclude?: string[];
    set?: Record<string, string>;
    /** @deprecated legacy v1.3 allowlist; ignored as of v1.4 */
    preserve?: string[];
    /** @deprecated legacy v1.3 toggle; ignored as of v1.4 */
    preserveOpencodeEnv?: boolean;
};
/**
 * Per-job env snapshot persisted alongside the job. Captured at
 * schedule-time so the OS scheduler runs with the same env as the
 * terminal where it was scheduled (PATH, MCP tokens, plugin secrets,
 * locale, OPENCODE_*).
 *
 * Trust boundary: snapshot may contain secrets (API keys, MCP tokens).
 * Files are user-only — see README "Env behavior".
 */
type JobEnv = {
    mode: SchedulerEnvMode;
    snapshot?: Record<string, string>;
};
/**
 * Capture the current process env as a job-level snapshot.
 *
 * `mode='snapshot'` — copy of process.env minus the denylist; final overrides
 *                     applied from `set`.
 * `mode='minimal'`  — only PATH/HOME/USER/SHELL plus `set` overrides.
 * `mode='login-shell'` — same snapshot as 'snapshot'; the wrapping is applied
 *                        at invocation time (S3), not here.
 */
export declare function captureJobEnv(config?: SchedulerEnvConfig): JobEnv;
interface JobRunSpec {
    prompt?: string;
    command?: string;
    arguments?: string;
    files?: string[];
    agent?: string;
    model?: string;
    variant?: string;
    title?: string;
    share?: boolean;
    continue?: boolean;
    session?: string;
    runFormat?: OpencodeRunFormat;
    attachUrl?: string;
    port?: number;
}
/**
 * How the scheduler chooses the target opencode session for a job.
 *
 * - `current`     — write into the session that called `schedule_job`.
 *                   Default when run from inside an opencode session.
 * - `existing`    — write into a session id the user supplies explicitly.
 * - `new-per-job` — create one dedicated session at schedule-time,
 *                   reuse it for every run.
 * - `new-per-run` — create a fresh session every time the job fires.
 */
type SessionPolicy = "current" | "existing" | "new-per-job" | "new-per-run";
/**
 * Where the scheduler tries to deliver the prompt at fire-time.
 *
 * - `prefer-live-server` — try live HTTP delivery first, fall back to
 *                          headless `opencode run` if no server reachable.
 * - `headless-only`      — never attempt live HTTP; always spawn a CLI.
 */
type ExecutionPolicy = "prefer-live-server" | "headless-only";
/**
 * What the scheduler does when the target session is busy at fire-time.
 *
 * - `execute`        — wait up to job.timeoutSeconds, then deliver. If
 *                      still busy, fail the run (next scheduled fire
 *                      tries again).
 * - `leave-message`  — deliver immediately with `noReply: true` so the
 *                      message lands in the session for the user/agent
 *                      to pick up later.
 */
type DeliveryPolicy = "execute" | "leave-message";
/**
 * Permission ruleset applied to sessions created by the scheduler.
 * Mirrors `opencode-fork/packages/opencode/src/cli/cmd/run.ts:353-369`
 * so scheduled sessions behave like `opencode run` sessions: no
 * questions, no plan toggling.
 *
 * NOT applied to sessions chosen via `current` or `existing` — there
 * is no public PATCH route to mutate an existing session's permission.
 * Users who want strict no-questions pick `new-per-job` / `new-per-run`.
 */
export type ScheduledPermissionRule = {
    permission: string;
    action: "deny";
    pattern: string;
};
type JobInvocation = {
    command: string;
    args: string[];
};
interface Job {
    scopeId?: string;
    slug: string;
    name: string;
    schedule: string;
    prompt?: string;
    attachUrl?: string;
    run?: JobRunSpec;
    invocation?: JobInvocation;
    /**
     * Per-job env snapshot persisted at schedule-time. Supervisor merges
     * `env.snapshot` into the run env before scheduler-only keys
     * (OPENCODE_PERMISSION, OPENCODE_SCHEDULER_RUN_ID).
     *
     * Legacy jobs without this field fall back to mode='minimal' at
     * supervisor time with a one-line warning to recreate the job.
     */
    env?: JobEnv;
    /**
     * Headless-mode invocation snapshot, built at schedule-time without
     * `--attach`. Used by the runner as the fallback path when live HTTP
     * delivery fails (S5).
     */
    headlessInvocation?: JobInvocation;
    /**
     * Persisted session policy chosen at schedule-time. The runner uses
     * this at fire-time to decide whether to create a new session
     * (`new-per-run`) or use the persisted `run.session`.
     */
    sessionPolicy?: SessionPolicy;
    executionPolicy?: ExecutionPolicy;
    deliveryPolicy?: DeliveryPolicy;
    timeoutSeconds?: number;
    source?: string;
    workdir?: string;
    createdAt: string;
    updatedAt?: string;
    lastRunAt?: string;
    lastRunExitCode?: number;
    lastRunError?: string;
    lastRunSource?: "manual" | "scheduled";
    lastRunStatus?: "running" | "success" | "failed";
}
/**
 * Idempotently ensure the scheduled-job-best-practices skill exists in
 * `workdir/.opencode/skill/`. Called by `schedule_job` so a freshly-cloned
 * project (or one that never installed the skill) gets a copy on first
 * job creation, without making the user run install_skill manually.
 *
 * - 'present'   → SKILL.md already exists; do not overwrite (user may
 *                 have local edits; updates flow via explicit install_skill
 *                 with overwrite=true).
 * - 'installed' → wrote it now.
 * - 'failed'    → could not write (logged as a non-fatal note; job creation
 *                 still proceeds because the skill is a soft dependency).
 */
export declare function ensureBestPracticesSkill(workdir: string): {
    status: "present" | "installed" | "failed";
    path: string;
    reason?: string;
};
export declare function getEnhancedPath(options?: {
    withTerminalPath?: boolean;
}): string;
/**
 * Pick the bootstrap-env subset from a job's snapshot, with PATH
 * overridden by the caller-supplied terminal-first PATH. Falls back to
 * `process.env` for missing keys (covers legacy jobs without snapshot).
 */
export declare function pickBootstrapEnv(job: Job, terminalPath: string): Record<string, string>;
export declare function parseSessionPolicy(raw: unknown): SessionPolicy;
export declare function parseExecutionPolicy(raw: unknown): ExecutionPolicy;
export declare function parseDeliveryPolicy(raw: unknown): DeliveryPolicy;
/**
 * Schedule-time validation matrix (S6). Returns an error message string
 * if validation fails, or undefined on success.
 *
 * The session.create call for new-per-job is performed by the caller
 * (it needs the resolved id) — this function only checks the
 * preconditions that are local to the args themselves.
 */
export declare function validateSessionPolicyArgs(input: {
    sessionPolicy: SessionPolicy;
    executionPolicy: ExecutionPolicy;
    deliveryPolicy: DeliveryPolicy;
    sessionId?: string;
    attachUrl?: string;
    toolSessionID?: string;
}): string | undefined;
/**
 * Narrow shape of the OpenCode SDK client we need for session creation.
 * Structurally compatible with `OpencodeClient` so `client` can be passed
 * directly without a cast. `body.permission` is supported by the server
 * route even though older SDK versions omit it from the body type — we
 * include it here to make that contract explicit.
 */
export type SchedulerSessionClient = {
    session: {
        create(options: {
            body?: {
                parentID?: string;
                title?: string;
                permission?: readonly ScheduledPermissionRule[];
            };
        }): Promise<{
            data?: {
                id?: string;
            };
            error?: BadRequestError | {
                message?: string;
            };
        }>;
    };
};
/**
 * Create a local scheduler session through the plugin-provided client.
 * OpenCode wires that client to Server.App().fetch in-process; unlike
 * serverUrl, it does not require an externally listening HTTP port.
 */
export declare function createSchedulerSessionWithClient(input: {
    client: SchedulerSessionClient;
    title: string;
    permission: readonly ScheduledPermissionRule[];
}): Promise<string>;
export declare const SchedulerPlugin: Plugin;
export default SchedulerPlugin;

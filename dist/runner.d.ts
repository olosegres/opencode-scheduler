/**
 * opencode-scheduler runner — fire-time helper for live HTTP delivery.
 *
 * Invoked by `supervisor.pl` (or any backend) like:
 *
 *   runner --job <path/to/job.json> [--timeout-seconds N]
 *
 * The runner only attempts live HTTP delivery. The supervisor decides
 * whether to invoke the runner at all (it skips when
 * executionPolicy='headless-only' or attachUrl is missing) and falls
 * back to the headless `opencode run` invocation on exit 10.
 *
 * Exit codes:
 *   0  — live delivery succeeded
 *  10  — live delivery failed (no server / timeout / non-2xx). Supervisor
 *        should fall back to the headless invocation.
 *  11  — validation/contract error (e.g. session 404). Do NOT retry.
 *  64  — usage error (bad CLI args / unreadable job).
 *
 * Each attempt appends a JSONL record to:
 *   ~/.config/opencode/scheduler/scopes/<scope>/runs/<slug>.jsonl
 */
interface RunnerArgs {
    jobPath: string;
    timeoutSeconds?: number;
}
interface JobInvocation {
    command: string;
    args: string[];
}
interface JobRunSpec {
    prompt?: string;
    command?: string;
    arguments?: string;
    files?: string[];
    agent?: string;
    attachUrl?: string;
    session?: string;
}
interface Job {
    scopeId?: string;
    slug: string;
    name: string;
    workdir?: string;
    run?: JobRunSpec;
    prompt?: string;
    attachUrl?: string;
    sessionPolicy?: "current" | "existing" | "new-per-job" | "new-per-run";
    executionPolicy?: "prefer-live-server" | "headless-only";
    deliveryPolicy?: "execute" | "leave-message";
    invocation?: JobInvocation;
    headlessInvocation?: JobInvocation;
    timeoutSeconds?: number;
}
interface RunRecord {
    runId: string;
    timestamp: string;
    delivery: "live" | "headless";
    attachUrl?: string;
    sessionId?: string;
    httpStatus?: number;
    error?: string;
    durationMs: number;
    exitCode: number;
}
declare const SCHEDULED_PERMS: ReadonlyArray<{
    permission: string;
    action: "deny";
    pattern: string;
}>;
declare function parseArgs(argv: string[]): RunnerArgs;
declare function newRunId(): string;
declare function trimBaseUrl(url: string): string;
declare function getSessionBusy(baseUrl: string, sessionId: string): Promise<boolean>;
declare function pollUntilIdle(input: {
    baseUrl: string;
    sessionId: string;
    timeoutSeconds: number;
    intervalMs: number;
}): Promise<boolean>;
declare function ensureLiveSession(input: {
    baseUrl: string;
    job: Job;
    existingSessionId?: string;
}): Promise<{
    sessionId: string;
    created: boolean;
}>;
declare function deliverLive(input: {
    baseUrl: string;
    sessionId: string;
    prompt: string;
    files: string[];
    noReply: boolean;
}): Promise<{
    httpStatus: number;
}>;
declare function preflight(input: {
    baseUrl: string;
    sessionId?: string;
}): Promise<"ok" | "no-server" | "no-session">;
declare function runLive(input: {
    job: Job;
    attachUrl: string;
    sessionId?: string;
    prompt: string;
    files: string[];
    deliveryPolicy: "execute" | "leave-message";
    timeoutSeconds: number;
}): Promise<{
    exitCode: number;
    record: RunRecord;
}>;
export { parseArgs, preflight, pollUntilIdle, getSessionBusy, deliverLive, ensureLiveSession, runLive, trimBaseUrl, newRunId, SCHEDULED_PERMS, };
export type { Job, JobInvocation, JobRunSpec, RunRecord, RunnerArgs };

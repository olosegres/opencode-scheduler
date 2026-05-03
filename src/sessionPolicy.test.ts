import { describe, expect, test } from "bun:test"
import {
  createSchedulerSessionWithClient,
  parseDeliveryPolicy,
  parseExecutionPolicy,
  parseSessionPolicy,
  validateSessionPolicyArgs,
} from "./index"
import type { ScheduledPermissionRule, SchedulerSessionClient } from "./index"

describe("parseSessionPolicy", () => {
  test("defaults to 'current' when undefined or empty", () => {
    expect(parseSessionPolicy(undefined)).toBe("current")
    expect(parseSessionPolicy("")).toBe("current")
    expect(parseSessionPolicy("  ")).toBe("current")
  })

  test("accepts all four valid values", () => {
    expect(parseSessionPolicy("current")).toBe("current")
    expect(parseSessionPolicy("existing")).toBe("existing")
    expect(parseSessionPolicy("new-per-job")).toBe("new-per-job")
    expect(parseSessionPolicy("new-per-run")).toBe("new-per-run")
  })

  test("rejects unknown values", () => {
    expect(() => parseSessionPolicy("nonsense")).toThrow(/Invalid sessionPolicy/)
    expect(() => parseSessionPolicy("Current")).toThrow(/Invalid sessionPolicy/)
  })

  test("rejects non-string types", () => {
    expect(() => parseSessionPolicy(42)).toThrow(/sessionPolicy must be a string/)
    expect(() => parseSessionPolicy({})).toThrow(/sessionPolicy must be a string/)
  })
})

describe("parseExecutionPolicy", () => {
  test("defaults to 'prefer-live-server'", () => {
    expect(parseExecutionPolicy(undefined)).toBe("prefer-live-server")
    expect(parseExecutionPolicy("")).toBe("prefer-live-server")
  })

  test("accepts both valid values", () => {
    expect(parseExecutionPolicy("prefer-live-server")).toBe("prefer-live-server")
    expect(parseExecutionPolicy("headless-only")).toBe("headless-only")
  })

  test("rejects unknown values", () => {
    expect(() => parseExecutionPolicy("live-only")).toThrow(/Invalid executionPolicy/)
  })
})

describe("parseDeliveryPolicy", () => {
  test("defaults to 'execute'", () => {
    expect(parseDeliveryPolicy(undefined)).toBe("execute")
    expect(parseDeliveryPolicy("")).toBe("execute")
  })

  test("accepts both valid values", () => {
    expect(parseDeliveryPolicy("execute")).toBe("execute")
    expect(parseDeliveryPolicy("leave-message")).toBe("leave-message")
  })

  test("rejects unknown values", () => {
    expect(() => parseDeliveryPolicy("queue")).toThrow(/Invalid deliveryPolicy/)
  })
})

describe("validateSessionPolicyArgs", () => {
  const baseArgs = {
    sessionPolicy: "current" as const,
    executionPolicy: "prefer-live-server" as const,
    deliveryPolicy: "execute" as const,
  }

  test("current: ok when toolSessionID present", () => {
    const err = validateSessionPolicyArgs({ ...baseArgs, toolSessionID: "ses_abc" })
    expect(err).toBeUndefined()
  })

  test("current: ok when sessionId arg present", () => {
    const err = validateSessionPolicyArgs({ ...baseArgs, sessionId: "ses_xyz" })
    expect(err).toBeUndefined()
  })

  test("current: error when both missing", () => {
    const err = validateSessionPolicyArgs({ ...baseArgs })
    expect(err).toMatch(/'current' requires a session context/)
  })

  test("existing: requires sessionId", () => {
    const err = validateSessionPolicyArgs({
      ...baseArgs,
      sessionPolicy: "existing",
      toolSessionID: "ses_abc", // ignored for existing
    })
    expect(err).toMatch(/'existing' requires sessionId/)
  })

  test("existing: ok with sessionId", () => {
    const err = validateSessionPolicyArgs({
      ...baseArgs,
      sessionPolicy: "existing",
      sessionId: "ses_xyz",
    })
    expect(err).toBeUndefined()
  })

  test("new-per-job: no sessionId required at args level", () => {
    const err = validateSessionPolicyArgs({ ...baseArgs, sessionPolicy: "new-per-job" })
    expect(err).toBeUndefined()
  })

  test("new-per-run: no sessionId required at args level", () => {
    const err = validateSessionPolicyArgs({ ...baseArgs, sessionPolicy: "new-per-run" })
    expect(err).toBeUndefined()
  })

  test("headless-only forbids attachUrl", () => {
    const err = validateSessionPolicyArgs({
      ...baseArgs,
      executionPolicy: "headless-only",
      sessionId: "ses_abc",
      attachUrl: "http://localhost:4096",
    })
    expect(err).toMatch(/'headless-only' is incompatible with attachUrl/)
  })

  test("headless-only without attachUrl is fine", () => {
    const err = validateSessionPolicyArgs({
      ...baseArgs,
      executionPolicy: "headless-only",
      toolSessionID: "ses_abc",
    })
    expect(err).toBeUndefined()
  })

  test("leave-message + headless-only: not a hard error (warning case)", () => {
    const err = validateSessionPolicyArgs({
      ...baseArgs,
      executionPolicy: "headless-only",
      deliveryPolicy: "leave-message",
      toolSessionID: "ses_abc",
    })
    expect(err).toBeUndefined()
  })
})

describe("createSchedulerSessionWithClient", () => {
  const scheduledPermissions: readonly ScheduledPermissionRule[] = [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" },
  ]

  test("creates the session through the plugin client with permissions", async () => {
    let capturedBody = ""
    const client: SchedulerSessionClient = {
      session: {
        async create(options) {
          capturedBody = JSON.stringify(options.body)
          return { data: { id: "ses_scheduler" } }
        },
      },
    }

    const sessionId = await createSchedulerSessionWithClient({
      client,
      title: "verify-v0",
      permission: scheduledPermissions,
    })

    expect(sessionId).toBe("ses_scheduler")
    expect(capturedBody).toContain('"title":"verify-v0"')
    expect(capturedBody).toContain('"permission"')
    expect(capturedBody).toContain('"plan_enter"')
  })

  test("reports client creation failures", async () => {
    const client: SchedulerSessionClient = {
      session: {
        async create() {
          return { error: { message: "boom" } }
        },
      },
    }

    await expect(
      createSchedulerSessionWithClient({
        client,
        title: "verify-v0",
        permission: scheduledPermissions,
      })
    ).rejects.toThrow(/client\.session\.create failed: boom/)
  })

  test("throws when the client returns data without an id", async () => {
    const client: SchedulerSessionClient = {
      session: {
        async create() {
          return { data: {} }
        },
      },
    }

    await expect(
      createSchedulerSessionWithClient({
        client,
        title: "verify-v0",
        permission: scheduledPermissions,
      })
    ).rejects.toThrow(/no id/)
  })
})

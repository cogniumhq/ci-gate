import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControlDeckClient,
  RepoRef,
  RunDetail,
  RunRef,
  WorkflowRef,
} from "../src/controldeck.js";
import { run } from "../src/main.js";

// Minimal fake to satisfy the ControlDeckClient shape without pulling in
// the real fetch client.
interface FakeClient {
  resolveRepo: (name: string) => Promise<RepoRef>;
  resolveWorkflow: (name: string) => Promise<WorkflowRef>;
  startRun: (input: unknown) => Promise<RunRef>;
  getRun: (runId: string) => Promise<RunDetail>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    resolveRepo: async () => ({ id: "repo_1", defaultBranch: "main" }),
    resolveWorkflow: async () => ({ id: "wfl_1", name: "secrets-scan" }),
    startRun: async () => ({ runId: "run_1" }),
    getRun: async () => ({
      id: "run_1",
      status: "done",
      branch: "main",
      currentStep: null,
      prUrl: null,
      error: null,
      startedAt: "2026-07-03T00:00:00Z",
      completedAt: "2026-07-03T00:01:00Z",
    }),
    ...overrides,
  };
}

function setInputs(inputs: Record<string, string>): void {
  for (const [k, v] of Object.entries(inputs)) {
    process.env[`INPUT_${k.replace(/-/g, "_").toUpperCase()}`] = v;
  }
}

function clearInputs(keys: string[]): void {
  for (const k of keys) {
    delete process.env[`INPUT_${k.replace(/-/g, "_").toUpperCase()}`];
  }
}

const INPUT_KEYS = ["workflow", "token", "branch", "api-url", "comment", "timeout-minutes", "github-token"];

describe("run", () => {
  const origRepo = process.env.GITHUB_REPOSITORY;

  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = "o/r";
    setInputs({
      workflow: "secrets-scan",
      token: "cdk_test",
      branch: "main",
      "api-url": "https://api.controldeck.dev",
      comment: "false",
      "timeout-minutes": "10",
    });
  });

  afterEach(() => {
    clearInputs(INPUT_KEYS);
    if (origRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = origRepo;
  });

  it("returns done and exit-zero outputs when workflow completes", async () => {
    const client = fakeClient() as unknown as ControlDeckClient;
    const result = await run({
      client,
      now: () => 0,
      sleep: async () => {},
      prNumber: () => null,
    });
    expect(result.outcome).toBe("done");
    expect(result.runId).toBe("run_1");
    expect(result.runUrl).toBe(
      "https://app.controldeck.dev/workflows/wfl_1/runs/run_1",
    );
  });

  it("returns failed on terminal failed status", async () => {
    const client = fakeClient({
      getRun: async () => ({
        id: "run_1",
        status: "failed",
        branch: "main",
        currentStep: null,
        prUrl: null,
        error: "policy floor breach",
        startedAt: null,
        completedAt: null,
      }),
    }) as unknown as ControlDeckClient;

    const result = await run({
      client,
      now: () => 0,
      sleep: async () => {},
      prNumber: () => null,
    });
    expect(result.outcome).toBe("failed");
  });

  it("polls until terminal, tolerating one transient error", async () => {
    let calls = 0;
    const client = fakeClient({
      getRun: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        if (calls === 2) {
          return {
            id: "run_1",
            status: "running",
            branch: null,
            currentStep: "gitleaks",
            prUrl: null,
            error: null,
            startedAt: null,
            completedAt: null,
          };
        }
        return {
          id: "run_1",
          status: "done",
          branch: "main",
          currentStep: null,
          prUrl: null,
          error: null,
          startedAt: null,
          completedAt: null,
        };
      },
    }) as unknown as ControlDeckClient;

    let clock = 0;
    const result = await run({
      client,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      prNumber: () => null,
    });
    expect(result.outcome).toBe("done");
    expect(calls).toBe(3);
  });

  it("times out when deadline passes without terminal status", async () => {
    setInputs({ "timeout-minutes": "1" });
    const client = fakeClient({
      getRun: async () => ({
        id: "run_1",
        status: "running",
        branch: null,
        currentStep: null,
        prUrl: null,
        error: null,
        startedAt: null,
        completedAt: null,
      }),
    }) as unknown as ControlDeckClient;

    let clock = 0;
    const result = await run({
      client,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      prNumber: () => null,
    });
    expect(result.outcome).toBe("timeout");
  });

  it("fails fast if repo not connected", async () => {
    const err = Object.assign(new Error("Repo not connected"), {
      status: 404,
      code: "NOT_FOUND",
    });
    const client = fakeClient({
      resolveRepo: async () => {
        throw err;
      },
    }) as unknown as ControlDeckClient;

    const result = await run({
      client,
      now: () => 0,
      sleep: async () => {},
      prNumber: () => null,
    });
    expect(result.outcome).toBe("failed");
    expect(result.runId).toBeNull();
  });

  it("posts PR comment when comment=true and PR context present", async () => {
    setInputs({ comment: "true" });
    process.env.GITHUB_TOKEN = "ghs_stub";
    const client = fakeClient() as unknown as ControlDeckClient;
    const postComment = vi.fn(
      async (_opts: import("../src/pr-comment.js").PostCommentOptions) => {},
    );

    await run({
      client,
      now: () => 0,
      sleep: async () => {},
      prNumber: () => 24,
      postComment,
    });

    expect(postComment).toHaveBeenCalledTimes(1);
    const args = postComment.mock.calls[0]![0]!;
    expect(args.prNumber).toBe(24);
    expect(args.body.workflowName).toBe("secrets-scan");
    delete process.env.GITHUB_TOKEN;
  });

  it("does not post PR comment when not in PR context", async () => {
    setInputs({ comment: "true" });
    process.env.GITHUB_TOKEN = "ghs_stub";
    const client = fakeClient() as unknown as ControlDeckClient;
    const postComment = vi.fn(
      async (_opts: import("../src/pr-comment.js").PostCommentOptions) => {},
    );

    await run({
      client,
      now: () => 0,
      sleep: async () => {},
      prNumber: () => null,
      postComment,
    });

    expect(postComment).not.toHaveBeenCalled();
    delete process.env.GITHUB_TOKEN;
  });
});

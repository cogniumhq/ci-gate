import { describe, expect, it, vi } from "vitest";
import { ControlDeckClient } from "../src/controldeck.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("ControlDeckClient.query", () => {
  it("encodes input into query-param, sends bearer, unwraps envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        result: { data: { id: "repo_1", defaultBranch: "main" } },
      });
    }) as unknown as typeof fetch;

    const client = new ControlDeckClient({
      apiUrl: "https://api.example.com/",
      token: "cdk_test",
      fetchImpl,
    });
    const out = await client.resolveRepo("o/r");
    expect(out).toEqual({ id: "repo_1", defaultBranch: "main" });

    const [call] = calls;
    expect(call.url).toBe(
      `https://api.example.com/trpc/repo.getByGithubFullName?input=${encodeURIComponent('{"githubFullName":"o/r"}')}`,
    );
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer cdk_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(call.init.method).toBe("GET");
  });

  it("throws ControlDeckError with status + reason on 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            message: "Repo not connected",
            code: "NOT_FOUND",
            data: { code: "NOT_FOUND", reason: "disconnected" },
          },
        },
        { status: 404 },
      ),
    ) as unknown as typeof fetch;

    const client = new ControlDeckClient({
      apiUrl: "https://api.example.com",
      token: "cdk_test",
      fetchImpl,
    });
    await expect(client.resolveRepo("o/r")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      reason: "disconnected",
      message: "Repo not connected",
    });
  });
});

describe("ControlDeckClient.mutate", () => {
  it("POSTs body {input} and returns unwrapped data", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ result: { data: { runId: "run_1" } } });
    }) as unknown as typeof fetch;

    const client = new ControlDeckClient({
      apiUrl: "https://api.example.com",
      token: "cdk_test",
      fetchImpl,
    });
    const out = await client.startRun({
      workflowId: "wfl_1",
      repoId: "repo_1",
      branch: "main",
    });
    expect(out).toEqual({ runId: "run_1" });

    const [call] = calls;
    expect(call.url).toBe(
      "https://api.example.com/trpc/workflow.startFromAction",
    );
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(call.init.body as string)).toEqual({
      input: { workflowId: "wfl_1", repoId: "repo_1", branch: "main" },
    });
  });

  it("throws when body has no data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const client = new ControlDeckClient({
      apiUrl: "https://api.example.com",
      token: "cdk_test",
      fetchImpl,
    });
    await expect(
      client.startRun({ workflowId: "w", repoId: "r" }),
    ).rejects.toThrow(/empty response/i);
  });
});

describe("getRun", () => {
  it("calls workflow.getRunFromAction", async () => {
    const calls: Array<{ url: string }> = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push({ url });
      return jsonResponse({
        result: {
          data: {
            id: "run_1",
            status: "done",
            branch: "main",
            currentStep: null,
            prUrl: null,
            error: null,
            startedAt: "2026-07-03T00:00:00Z",
            completedAt: "2026-07-03T00:01:00Z",
          },
        },
      });
    }) as unknown as typeof fetch;

    const client = new ControlDeckClient({
      apiUrl: "https://api.example.com",
      token: "cdk_test",
      fetchImpl,
    });
    const out = await client.getRun("run_1");
    expect(out.status).toBe("done");
    expect(calls[0].url).toContain("/trpc/workflow.getRunFromAction");
  });
});

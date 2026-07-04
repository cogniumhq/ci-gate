import { describe, expect, it } from "vitest";
import {
  commentBody,
  commentMarker,
  outcomeLabel,
  runUrl,
  statusLine,
  toOutcome,
} from "../src/format.js";

describe("outcomeLabel", () => {
  it.each([
    ["done", "PASSED"],
    ["failed", "FAILED"],
    ["cancelled", "CANCELLED"],
    ["timeout", "TIMED OUT"],
    ["running", "RUNNING"],
  ] as const)("maps %s → %s", (outcome, label) => {
    expect(outcomeLabel(outcome)).toBe(label);
  });
});

describe("statusLine", () => {
  it("includes workflow, label, and url", () => {
    expect(
      statusLine("secrets-scan", "done", "https://app/wfl_1/run_1"),
    ).toBe("ControlDeck — secrets-scan — PASSED — https://app/wfl_1/run_1");
  });
});

describe("runUrl", () => {
  it("swaps api. → app. and joins", () => {
    expect(runUrl("https://api.controldeck.dev", "wfl_1", "run_1")).toBe(
      "https://app.controldeck.dev/workflows/wfl_1/runs/run_1",
    );
  });
  it("handles staging api-dev", () => {
    expect(runUrl("https://api-dev.controldeck.dev/", "wfl_1", "run_1")).toBe(
      // api-dev doesn't match /api\./ so we fall through — swap is a
      // best-effort; test pins the current behavior so it's a conscious
      // change if we later care about staging.
      "https://api-dev.controldeck.dev/workflows/wfl_1/runs/run_1",
    );
  });
});

describe("commentMarker", () => {
  it("wraps the runId in an HTML comment", () => {
    expect(commentMarker("run_abc")).toBe("<!-- ci-gate:run_abc -->");
  });
});

describe("commentBody", () => {
  it("passing run includes run link and no error block", () => {
    const body = commentBody({
      workflowName: "secrets-scan",
      runId: "run_abc",
      runUrl: "https://app/wfl_1/run_abc",
      outcome: "done",
      prUrl: "https://github.com/o/r/pull/24",
      error: null,
    });
    expect(body).toContain("### ControlDeck — `secrets-scan` — PASSED");
    expect(body).toContain("[run_abc](https://app/wfl_1/run_abc)");
    expect(body).toContain("**Findings PR:** https://github.com/o/r/pull/24");
    expect(body).not.toContain("**Error:**");
    expect(body.endsWith("<!-- ci-gate:run_abc -->")).toBe(true);
  });

  it("failing run includes error block", () => {
    const body = commentBody({
      workflowName: "secrets-scan",
      runId: "run_x",
      runUrl: "https://app/w/run_x",
      outcome: "failed",
      prUrl: null,
      error: "gitleaks step exited 2",
    });
    expect(body).toContain("### ControlDeck — `secrets-scan` — FAILED");
    expect(body).toContain("**Error:**");
    expect(body).toContain("gitleaks step exited 2");
    expect(body).not.toContain("**Findings PR:**");
  });
});

describe("toOutcome", () => {
  it("passes wire statuses through", () => {
    expect(toOutcome("done")).toBe("done");
    expect(toOutcome("failed")).toBe("failed");
  });
});

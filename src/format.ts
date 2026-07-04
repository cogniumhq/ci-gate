// Pure formatters for the action's user-facing surfaces: the one-line
// status the workflow log shows, and the markdown body posted to the PR
// when `comment: true`. Kept dep-free so the tests are trivial and the
// bundle stays small.

import type { RunDetail, WorkflowStatus } from "./controldeck.js";

export type GateOutcome = WorkflowStatus | "timeout";

export interface CommentInput {
  workflowName: string;
  runId: string;
  runUrl: string;
  outcome: GateOutcome;
  prUrl: string | null;
  error: string | null;
}

const OUTCOME_LABEL: Record<GateOutcome, string> = {
  done: "PASSED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  timeout: "TIMED OUT",
  running: "RUNNING",
};

export function outcomeLabel(outcome: GateOutcome): string {
  return OUTCOME_LABEL[outcome];
}

// Short line printed to the Action log summary. Deliberately plain text —
// GitHub's UI already colors the check based on exit code, and emojis
// don't render consistently across log viewers.
export function statusLine(
  workflowName: string,
  outcome: GateOutcome,
  runUrl: string,
): string {
  return `ControlDeck — ${workflowName} — ${outcomeLabel(outcome)} — ${runUrl}`;
}

// PR comment body. The hidden marker on the last line lets `pr-comment.ts`
// find and skip a pre-existing comment for the same runId, so a re-run of
// the workflow_dispatch (which produces the same runId only if you replay
// the exact same run — not the common case, but cheap insurance) doesn't
// double-post.
export function commentBody(input: CommentInput): string {
  const heading = `### ControlDeck — \`${input.workflowName}\` — ${outcomeLabel(input.outcome)}`;
  const lines: string[] = [heading, ""];
  lines.push(`**Run:** [${input.runId}](${input.runUrl})`);
  if (input.prUrl) {
    lines.push(`**Findings PR:** ${input.prUrl}`);
  }
  if (input.outcome !== "done" && input.error) {
    lines.push("");
    lines.push("**Error:**");
    lines.push("```");
    lines.push(input.error);
    lines.push("```");
  }
  lines.push("");
  lines.push("<sub>via [ControlDeck](https://controldeck.dev)</sub>");
  lines.push("");
  lines.push(commentMarker(input.runId));
  return lines.join("\n");
}

export function commentMarker(runId: string): string {
  return `<!-- ci-gate:${runId} -->`;
}

export function runUrl(apiBase: string, workflowId: string, runId: string): string {
  // The API base is `<app-origin>/api` in production. Strip the `/api`
  // suffix (if present) and any trailing slash to get the app origin the
  // human UI runs on. If a caller overrides `api-url` to a bare origin
  // for staging, we leave it alone.
  const trimmed = apiBase.replace(/\/+$/, "");
  const appOrigin = trimmed.endsWith("/api") ? trimmed.slice(0, -"/api".length) : trimmed;
  return `${appOrigin}/workflows/${workflowId}/runs/${runId}`;
}

// Runtime terminal-state coercion. `RunDetail.status` is the wire type
// from ControlDeck; adding "timeout" here keeps the outcome type honest
// for the timeout branch in main.ts.
export function toOutcome(status: RunDetail["status"]): GateOutcome {
  return status;
}

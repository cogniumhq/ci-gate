// State machine for cogniumhq/ci-gate.
//   resolve repo → resolve workflow → start run → poll → outputs → comment → exit
//
// Exits 0 iff the workflow reported `done`. Any of {failed, cancelled,
// timeout, network/resolve failures} → exit 1 so the caller's CI marks
// the check red.

import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  ControlDeckClient,
  type ControlDeckError,
  type RunDetail,
} from "./controldeck.js";
import {
  runUrl as buildRunUrl,
  statusLine,
  toOutcome,
  type GateOutcome,
} from "./format.js";
import { currentPrNumber, postPrComment } from "./pr-comment.js";

export interface RunInputs {
  workflow: string;
  token: string;
  branch: string;
  apiUrl: string;
  comment: boolean;
  timeoutMs: number;
}

export interface RunDeps {
  client?: ControlDeckClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  postComment?: typeof postPrComment;
  prNumber?: () => number | null;
  githubRepository?: string; // for tests; defaults to GITHUB_REPOSITORY env
  githubToken?: string; // for tests; defaults to INPUT_GITHUB_TOKEN / GITHUB_TOKEN
}

export interface RunResult {
  outcome: GateOutcome;
  runId: string | null;
  runUrl: string | null;
  prUrl: string | null;
}

const DEFAULT_SLEEP = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

// Exponential backoff sequence, capped at 15s. First poll fires
// immediately so short workflows return within a second or two.
const POLL_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

function nextPollDelay(attempt: number): number {
  return POLL_STEPS_MS[Math.min(attempt, POLL_STEPS_MS.length - 1)];
}

function readInputs(): RunInputs {
  const workflow = core.getInput("workflow", { required: true });
  const token = core.getInput("token", { required: true });
  const branchInput = core.getInput("branch");
  const apiUrl =
    core.getInput("api-url") || "https://app.controldeck.dev/api";
  const commentInput = core.getInput("comment");
  const timeoutInput = core.getInput("timeout-minutes");

  const branch = branchInput || github.context.ref.replace(/^refs\/heads\//, "");
  const comment = commentInput.toLowerCase() === "true";
  const timeoutMinutes = Number.parseInt(timeoutInput || "10", 10);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error(`Invalid timeout-minutes: ${timeoutInput}`);
  }

  return {
    workflow,
    token,
    branch,
    apiUrl,
    comment,
    timeoutMs: timeoutMinutes * 60_000,
  };
}

function isTerminal(status: RunDetail["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function isControlDeckError(err: unknown): err is ControlDeckError {
  return err instanceof Error && typeof (err as ControlDeckError).status === "number";
}

function reportError(context: string, err: unknown): void {
  if (isControlDeckError(err)) {
    const suffix = err.reason ? ` (${err.reason})` : "";
    core.setFailed(`${context}: ${err.message}${suffix}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(`${context}: ${message}`);
}

export async function run(deps: RunDeps = {}): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? DEFAULT_SLEEP;
  const postComment = deps.postComment ?? postPrComment;
  const prNumber = deps.prNumber ?? currentPrNumber;

  let inputs: RunInputs;
  try {
    inputs = readInputs();
  } catch (err) {
    reportError("Invalid input", err);
    return { outcome: "failed", runId: null, runUrl: null, prUrl: null };
  }

  const client =
    deps.client ??
    new ControlDeckClient({ apiUrl: inputs.apiUrl, token: inputs.token });

  const githubRepository =
    deps.githubRepository ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!githubRepository) {
    reportError("Missing context", new Error("GITHUB_REPOSITORY is not set"));
    return { outcome: "failed", runId: null, runUrl: null, prUrl: null };
  }

  let repoId: string;
  try {
    const repo = await client.resolveRepo(githubRepository);
    repoId = repo.id;
  } catch (err) {
    reportError(
      `Repo '${githubRepository}' is not connected to ControlDeck. Connect at app.controldeck.dev/connect-github`,
      err,
    );
    return { outcome: "failed", runId: null, runUrl: null, prUrl: null };
  }

  let workflowId: string;
  try {
    const workflow = await client.resolveWorkflow(inputs.workflow);
    workflowId = workflow.id;
  } catch (err) {
    reportError(`Workflow '${inputs.workflow}' lookup failed`, err);
    return { outcome: "failed", runId: null, runUrl: null, prUrl: null };
  }

  let runId: string;
  try {
    const started = await client.startRun({
      workflowId,
      repoId,
      branch: inputs.branch,
    });
    runId = started.runId;
  } catch (err) {
    reportError(`Could not start workflow '${inputs.workflow}'`, err);
    return { outcome: "failed", runId: null, runUrl: null, prUrl: null };
  }

  const runUrl = buildRunUrl(inputs.apiUrl, workflowId, runId);
  core.info(`Started run ${runId} — ${runUrl}`);

  const deadline = now() + inputs.timeoutMs;
  let attempt = 0;
  let last: RunDetail | null = null;
  let outcome: GateOutcome = "running";

  while (true) {
    await sleep(nextPollDelay(attempt));
    attempt += 1;

    try {
      last = await client.getRun(runId);
    } catch (err) {
      // Transient network blips shouldn't fail the gate on the first
      // hiccup; keep polling until the wall-clock deadline. But surface
      // the last error so the log tells you what went wrong.
      core.warning(
        `Poll ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (last && isTerminal(last.status)) {
      outcome = toOutcome(last.status);
      break;
    }

    if (now() >= deadline) {
      outcome = "timeout";
      break;
    }
  }

  const prUrl = last?.prUrl ?? null;

  core.setOutput("status", outcome);
  core.setOutput("run-id", runId);
  core.setOutput("run-url", runUrl);
  core.setOutput("pr-url", prUrl ?? "");

  core.info(statusLine(inputs.workflow, outcome, runUrl));

  if (inputs.comment) {
    const pr = prNumber();
    // `core.getInput` returns "" when unset, so use `||` (not `??`) to
    // fall through to the env var.
    const ghToken =
      deps.githubToken ||
      core.getInput("github-token") ||
      process.env.GITHUB_TOKEN ||
      "";
    if (pr !== null && ghToken) {
      await postComment({
        token: ghToken,
        prNumber: pr,
        body: {
          workflowName: inputs.workflow,
          runId,
          runUrl,
          outcome,
          prUrl,
          error: last?.error ?? null,
        },
      });
    } else if (pr === null) {
      core.info("Not running in a PR context — skipping comment.");
    } else {
      core.warning("comment=true but no GITHUB_TOKEN available — skipping.");
    }
  }

  if (outcome !== "done") {
    const reason =
      outcome === "timeout"
        ? `Timed out after ${inputs.timeoutMs / 60_000} minute(s).`
        : (last?.error ?? `Workflow ${outcome}.`);
    core.setFailed(`ControlDeck run ${outcome}: ${reason}`);
  }

  return { outcome, runId, runUrl, prUrl };
}

// Small helper the thin `index.ts` entry uses to surface unhandled
// rejections through the same setFailed path as the resolved branches.
export function reportUnhandled(err: unknown): void {
  reportError("Unhandled error", err);
}

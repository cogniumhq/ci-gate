// Opt-in PR summary comment. Requires `pull-requests: write` in the
// caller's job permissions; if that's missing GitHub returns 403 and we
// swallow it with a warning rather than failing the whole gate. The gate
// exit code is the merge signal — the comment is UX polish.

import * as core from "@actions/core";
import * as github from "@actions/github";
import { commentBody, commentMarker, type CommentInput } from "./format.js";

export interface PostCommentOptions {
  token: string; // GITHUB_TOKEN — already scoped to the workflow's repo
  prNumber: number;
  body: CommentInput;
}

export async function postPrComment(opts: PostCommentOptions): Promise<void> {
  const octokit = github.getOctokit(opts.token);
  const { owner, repo } = github.context.repo;
  const marker = commentMarker(opts.body.runId);

  // Idempotency: paginate comments and skip if the marker already exists.
  // Paging (per_page=100) is a courtesy — most PRs have < 10 comments —
  // but pinning avoids surprises on discussion-heavy PRs.
  try {
    const existing = await octokit.paginate(
      octokit.rest.issues.listComments,
      { owner, repo, issue_number: opts.prNumber, per_page: 100 },
    );
    if (existing.some((c) => c.body?.includes(marker))) {
      core.info(`Skipping PR comment — ${marker} already present.`);
      return;
    }
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: opts.prNumber,
      body: commentBody(opts.body),
    });
    core.info(`Posted PR comment for run ${opts.body.runId}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `Could not post PR comment (need pull-requests:write). ${message}`,
    );
  }
}

// Returns the current PR number if the action is running in a PR context,
// else null. Supports both `pull_request` and `pull_request_target`.
export function currentPrNumber(): number | null {
  const pr = github.context.payload.pull_request;
  if (!pr || typeof pr.number !== "number") return null;
  return pr.number;
}

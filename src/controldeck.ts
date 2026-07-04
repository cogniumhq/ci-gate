// Thin tRPC 11 HTTP client for the three ControlDeck procedures ci-gate
// depends on: repo.getByGithubFullName, workflow.getByName,
// workflow.startFromAction. Written by hand (no @trpc/client) to keep the
// bundled action small — @vercel/ncc pulls in enough on its own, and the
// wire shape is stable enough that a hand-written adapter is a smaller
// diff than a vendored client with matching types.

export type WorkflowStatus =
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface RepoRef {
  id: string;
  defaultBranch: string;
}

export interface WorkflowRef {
  id: string;
  name: string;
}

export interface RunRef {
  runId: string;
}

export interface RunDetail {
  id: string;
  status: WorkflowStatus;
  branch: string | null;
  currentStep: string | null;
  prUrl: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ControlDeckError extends Error {
  status: number;
  code?: string;
  reason?: string;
}

function toError(
  message: string,
  status: number,
  code?: string,
  reason?: string,
): ControlDeckError {
  const err = new Error(message) as ControlDeckError;
  err.status = status;
  err.code = code;
  err.reason = reason;
  return err;
}

interface TrpcErrorEnvelope {
  error?: {
    message?: string;
    code?: string;
    data?: {
      code?: string;
      reason?: string | null;
    };
  };
}

interface TrpcResultEnvelope<T> {
  result?: { data?: T };
}

async function readError(res: Response): Promise<ControlDeckError> {
  let body: TrpcErrorEnvelope = {};
  try {
    body = (await res.json()) as TrpcErrorEnvelope;
  } catch {
    // fallthrough — will use status text
  }
  const message =
    body.error?.message ?? res.statusText ?? `HTTP ${res.status}`;
  const code = body.error?.data?.code ?? body.error?.code;
  const reason = body.error?.data?.reason ?? undefined;
  return toError(message, res.status, code, reason ?? undefined);
}

export interface ClientOptions {
  apiUrl: string;
  token: string;
  // Injectable for tests. Defaults to global fetch (Node 20+).
  fetchImpl?: typeof fetch;
}

export class ControlDeckClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    // Strip trailing slash so `${base}/trpc/foo` always joins cleanly.
    this.base = opts.apiUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      "user-agent": "cogniumhq-ci-gate/1.0",
    };
  }

  async query<T>(proc: string, input: unknown): Promise<T> {
    const encoded = encodeURIComponent(JSON.stringify(input));
    const url = `${this.base}/trpc/${proc}?input=${encoded}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw await readError(res);
    const body = (await res.json()) as TrpcResultEnvelope<T>;
    if (body.result?.data === undefined) {
      throw toError("ControlDeck returned an empty response", 502);
    }
    return body.result.data;
  }

  async mutate<T>(proc: string, input: unknown): Promise<T> {
    const url = `${this.base}/trpc/${proc}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ input }),
    });
    if (!res.ok) throw await readError(res);
    const body = (await res.json()) as TrpcResultEnvelope<T>;
    if (body.result?.data === undefined) {
      throw toError("ControlDeck returned an empty response", 502);
    }
    return body.result.data;
  }

  // Typed convenience wrappers ------------------------------------------------

  resolveRepo(githubFullName: string): Promise<RepoRef> {
    return this.query<RepoRef>("repo.getByGithubFullName", { githubFullName });
  }

  resolveWorkflow(name: string): Promise<WorkflowRef> {
    return this.query<WorkflowRef>("workflow.getByName", { name });
  }

  startRun(input: {
    workflowId: string;
    repoId: string;
    branch?: string;
  }): Promise<RunRef> {
    return this.mutate<RunRef>("workflow.startFromAction", input);
  }

  getRun(runId: string): Promise<RunDetail> {
    return this.query<RunDetail>("workflow.getRunFromAction", { runId });
  }
}

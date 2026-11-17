// mcp.ts — the Model Context Protocol endpoint at POST /mcp (JSON-RPC 2.0, legacy era).
//
// The handshake is the legacy one: `initialize` (echoing a revision the client offered),
// then `notifications/initialized`, then `tools/list` and `tools/call`. `server/discover`
// is a modern-era method this server does not have, so it answers -32601, which the suite
// treats as a pre-discover pass. Every tool result carries both a text block and
// structuredContent, so the suite reads the same object either way. tools/list is a constant,
// byte-identical on every call.

import { mergeableOf, squashMerge } from './git.ts';
import { isPlainObject, json, type ApiRequest, type ApiResponse } from './http.ts';
import { VIEWER, type Repo, type Store } from './store.ts';

const REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: readonly string[];
  };
}

/** The tool catalogue, frozen so tools/list is byte-identical across calls. */
const TOOLS: readonly McpToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; defaults to the viewer.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function asNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function findRepoForTool(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = asStringArg(args, 'owner') ?? VIEWER.login;
  const repoName = asStringArg(args, 'repo');
  if (repoName === undefined) return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

/** Run one tool; returns the tool result object (or an isError result). */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asStringArg(args, 'name');
      if (repoName === undefined || repoName === '') return toolError('name is required');
      const owner = asStringArg(args, 'owner') ?? VIEWER.login;
      if (owner !== VIEWER.login) return toolError('repositories can only be created for the viewer');
      if (store.getRepo(owner, repoName) !== undefined) return toolError('name already exists on this account');
      const description = asStringArg(args, 'description') ?? '';
      const isPrivate = args['private'] === true;
      const repo = store.createRepo(owner, repoName, description, isPrivate);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'get_repo': {
      const repo = findRepoForTool(store, args);
      if (!repo) return toolError('repository not found');
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    case 'create_issue': {
      const repo = findRepoForTool(store, args);
      if (!repo) return toolError('repository not found');
      const title = asStringArg(args, 'title');
      if (title === undefined || title === '') return toolError('title is required');
      const body = asStringArg(args, 'body') ?? '';
      const issue = store.createIssue(repo, title, body, []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
        user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      });
    }
    case 'list_issues': {
      const repo = findRepoForTool(store, args);
      if (!repo) return toolError('repository not found');
      const state = asStringArg(args, 'state') ?? 'open';
      const issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return toolResult(
        issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
          user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        })),
      );
    }
    case 'create_pull_request': {
      const repo = findRepoForTool(store, args);
      if (!repo) return toolError('repository not found');
      const title = asStringArg(args, 'title');
      const head = asStringArg(args, 'head');
      const base = asStringArg(args, 'base');
      if (title === undefined || title === '') return toolError('title is required');
      if (head === undefined || head === '') return toolError('head is required');
      if (base === undefined || base === '') return toolError('base is required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) return toolError(`head branch ${head} does not exist`);
      if (baseSha === undefined) return toolError(`base branch ${base} does not exist`);
      if (store.openPullForHead(repo, head) !== undefined) return toolError('a pull request is already open for this head branch');
      const body = asStringArg(args, 'body') ?? '';
      const pull = store.createPull(repo, title, body, head, headSha, base, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head.ref, sha: pull.head.sha },
        base: { ref: pull.base.ref, sha: pull.base.sha },
        merged: pull.merged,
        mergeable: mergeableOf(repo, pull),
      });
    }
    case 'merge_pull_request': {
      const repo = findRepoForTool(store, args);
      if (!repo) return toolError('repository not found');
      const number = asNumberArg(args, 'pull_number');
      if (number === undefined) return toolError('pull_number is required');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return toolError('pull request not found');
      if (pull.state !== 'open' || pull.merged) return toolError('pull request is already merged or closed');
      const { seq, at } = store.stamp();
      const mergeSha = squashMerge(repo, pull, pull.title, Math.floor(Date.UTC(2026, 10, 17) / 1000) + seq);
      if (mergeSha === null) return toolError('merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.merge_commit_sha = mergeSha;
      pull.merged_at = at;
      pull.updatedAt = at;
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head.ref, sha: pull.head.sha },
        base: { ref: pull.base.ref, sha: pull.base.sha },
        merged: pull.merged,
        merged_at: pull.merged_at,
        merge_commit_sha: pull.merge_commit_sha,
      });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

function rpcError(id: unknown, code: number, message: string): ApiResponse {
  return json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function rpcResult(id: unknown, result: unknown): ApiResponse {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

/** Handle one POST /mcp request. */
export function handleMcp(req: ApiRequest, store: Store): ApiResponse {
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!isPlainObject(body)) {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const id = body['id'];
  const method = body['method'];
  const params = isPlainObject(body['params']) ? (body['params'] as Record<string, unknown>) : {};
  // A notification carries no id and gets no JSON-RPC answer, only a 2xx status.
  if (id === undefined || id === null) {
    return { status: 202, body: Buffer.alloc(0) };
  }
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request');
  }
  switch (method) {
    case 'initialize': {
      const offered = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
      const negotiated = (REVISIONS as readonly string[]).includes(offered) ? offered : '2025-06-18';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      });
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params['name'];
      if (typeof name !== 'string' || name === '') {
        return rpcError(id, -32602, 'Invalid params: name is required');
      }
      const known = TOOLS.some((tool) => tool.name === name);
      if (!known) {
        return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
      const args = isPlainObject(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
      const result = callTool(store, name, args);
      return rpcResult(id, result);
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

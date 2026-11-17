// app.ts — the HTTP server: routing, authentication, and the response envelope.
//
// One process, one Store. The routes:
//   GET  /healthz                                  the env's boot probe, no auth
//   GET  /api/v3, /api/v3/                         the API root, no auth
//   *    /api/v3/...                              REST v3 (rest.ts)
//   POST /api/graphql                             GraphQL v4 (graphql.ts)
//   POST /mcp                                     MCP tools (mcp.ts)
//   GET  /<owner>/<repo>.git/info/refs           git smart-HTTP advertisement
//   POST /<owner>/<repo>.git/git-upload-pack      git fetch / clone (protocol v2)
//   POST /<owner>/<repo>.git/git-receive-pack    git push (protocol v0)
//   *    anything else                           404 {"message":"Not Found"}
//
// Every JSON reply carries a non-empty X-GitHub-Request-Id. Everything except /healthz and
// the API root needs a Bearer token: the MAKEFUN_SHOP_TOKEN when the trial sets one, else any
// non-empty token. A malformed request body is a 400, never a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { bearerToken, json, type ApiRequest, type ApiResponse } from './http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store, VIEWER } from './store.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

/** The bearer token this trial accepts, or null when any non-empty token will do. */
function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token !== undefined && token !== '' ? token : null;
}

function isAuthorized(req: ApiRequest): boolean {
  const presented = bearerToken(req);
  if (presented === null || presented === '') return false;
  const expected = expectedToken();
  if (expected !== null && presented !== expected) return false;
  return true;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sendResponse(res: ServerResponse, response: ApiResponse): void {
  const requestId = nextRequestId();
  if (Buffer.isBuffer(response.body)) {
    const headers: Record<string, string> = {
      'content-type': response.contentType ?? 'application/octet-stream',
      'content-length': String(response.body.length),
      'x-github-request-id': requestId,
      ...(response.headers ?? {}),
    };
    res.writeHead(response.status, headers);
    res.end(response.body);
    return;
  }
  const text = `${JSON.stringify(response.body ?? null)}\n`;
  const headers: Record<string, string> = {
    'content-type': response.contentType ?? 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId,
    ...(response.headers ?? {}),
  };
  res.writeHead(response.status, headers);
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const segments = path.split('/').filter((part) => part !== '').map(decodeSegment);
      let body = Buffer.alloc(0);
      try {
        body = await readBody(req);
      } catch {
        sendResponse(res, json(400, { message: 'request body could not be read' }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://entry');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value;
      }
      const apiReq: ApiRequest = { method, segments, query: url.searchParams, headers, body };

      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendResponse(res, json(200, { ok: true }));
          return;
        }

        // The GitHub API root: a 200 with the token's scopes. No auth.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendResponse(
            res,
            json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }),
          );
          return;
        }

        // Everything else needs a token.
        if (!isAuthorized(apiReq)) {
          sendResponse(res, json(401, { message: 'Requires authentication' }));
          return;
        }

        // GraphQL.
        if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          sendResponse(res, handleGraphql(apiReq, store));
          return;
        }

        // MCP.
        if (method === 'POST' && segments.length === 1 && segments[0] === 'mcp') {
          sendResponse(res, handleMcp(apiReq, store));
          return;
        }

        // Git smart HTTP under /<owner>/<repo>.git/.
        if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
          const owner = segments[0]!;
          const repoName = segments[1].slice(0, -'.git'.length);
          if (owner !== VIEWER.login) {
            sendResponse(res, json(404, { message: 'Not Found' }));
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendResponse(res, json(404, { message: 'Not Found' }));
            return;
          }
          // GET /<owner>/<repo>.git/info/refs?service=git-upload-pack (or git-receive-pack).
          if (method === 'GET' && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
            const service = url.searchParams.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendResponse(res, json(400, { message: 'service is required' }));
              return;
            }
            const result = handleInfoRefs(repo, service);
            sendResponse(res, { status: result.status, body: result.body, contentType: result.contentType });
            return;
          }
          // POST /<owner>/<repo>.git/git-upload-pack and .../git-receive-pack.
          if (method === 'POST' && segments.length === 3 && segments[2] === 'git-upload-pack') {
            const result = handleUploadPack(repo, body);
            sendResponse(res, { status: result.status, body: result.body, contentType: result.contentType });
            return;
          }
          if (method === 'POST' && segments.length === 3 && segments[2] === 'git-receive-pack') {
            const result = handleReceivePack(repo, body);
            sendResponse(res, { status: result.status, body: result.body, contentType: result.contentType });
            return;
          }
          sendResponse(res, json(404, { message: 'Not Found' }));
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const response = handleRest(apiReq, store);
          if (response !== null) {
            sendResponse(res, response);
            return;
          }
        }

        // Everything else, every method: GitHub's 404 body.
        sendResponse(res, json(404, { message: 'Not Found' }));
      } catch (err) {
        process.stderr.write(`[forge] request ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendResponse(res, json(500, { message: 'Internal Server Error' }));
        } else {
          res.end();
        }
      }
    })();
  });
}

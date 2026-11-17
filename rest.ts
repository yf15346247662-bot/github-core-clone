// rest.ts — the REST v3 API under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id. The routes follow
// GitHub's v3 surface for repositories, git refs, branches, commits, contents, labels, issues
// and pull requests. A repo name under any owner other than the viewer is a 404, never a 403.

import {
  buildTree,
  commitFileChange,
  diffFlat,
  findMergeBase,
  flattenTree,
  isObjectId,
  mergeableOf,
  parseCommit,
  putObject,
  squashMerge,
  treeFlatOf,
  ZERO_OID,
} from './git.ts';
import { asBoolean, asString, isPlainObject, json, notFound, parseJsonBody, type ApiRequest, type ApiResponse } from './http.ts';
import { VIEWER, type Comment, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';

const SHA = /^[0-9a-f]{40}$/;

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: mergeableOf(repo, pull),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

/** The commits on a branch, newest first, following first parents only. */
function commitsOnBranch(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') break;
    out.push(current);
    current = parseCommit(object.data).parents[0];
  }
  return out;
}

/** A line diff's added/removed counts, by longest common subsequence (small files only). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 1_000_000) {
    const oldSet = new Map<string, number>();
    for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
    const newSet = new Map<string, number>();
    for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newSet) additions += Math.max(0, count - (oldSet.get(line) ?? 0));
    for (const [line, count] of oldSet) deletions += Math.max(0, count - (newSet.get(line) ?? 0));
    return { additions, deletions };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * cols + (j + 1)]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + (j + 1)]!);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + (j + 1)]!) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += oldLines.length - i;
  additions += newLines.length - j;
  return { additions, deletions };
}

function badRequest(message: string): ApiResponse {
  return json(400, { message });
}

function unprocessable(message: string): ApiResponse {
  return json(422, { message });
}

function conflict(message: string): ApiResponse {
  return json(409, { message });
}

function messageOnly(status: number, message: string): ApiResponse {
  return json(status, { message });
}

/** Look a repository up; any owner other than the viewer is a 404, never a 403. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function parsePage(req: ApiRequest): { page: number; perPage: number } {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const pageRaw = Number(req.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { page, perPage };
}

function pageLink(req: ApiRequest, path: string, page: number, perPage: number): string {
  const host = req.headers['host'] ?? '127.0.0.1';
  return `http://${host}${path}?per_page=${perPage}&page=${page}`;
}

/** Handle one REST request; null when the path is not under /api/v3 at all. */
export function handleRest(req: ApiRequest, store: Store): ApiResponse | null {
  const seg = req.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return null;
  const rest = seg.slice(2);
  const method = req.method;

  // GET /api/v3/meta — the installed version.
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user — the viewer.
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }

  // POST /api/v3/user/repos — create a repository. GET — list the viewer's, paginated.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return badRequest('request body is not valid JSON');
      const body = isPlainObject(parsed.value) ? parsed.value : {};
      const name = asString(body.name);
      if (name === undefined || name === '' || name.length > 100) return unprocessable('name is required');
      if (store.getRepo(VIEWER.login, name) !== undefined) return unprocessable('name already exists on this account');
      const repo = store.createRepo(VIEWER.login, name, asString(body.description) ?? '', asBoolean(body.private) ?? false);
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const { page, perPage } = parsePage(req);
      const all = store.reposOf(VIEWER.login);
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers['link'] = `<${pageLink(req, '/api/v3/user/repos', page + 1, perPage)}>; rel="next"`;
      }
      return json(200, items.map(repoJson), headers);
    }
    return notFound();
  }

  // Everything below is /api/v3/repos/{owner}/{name}/...
  if (rest.length < 3 || rest[0] !== 'repos') return notFound();
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const repo = findRepo(store, owner, repoName);
  const tail = rest.slice(3);
  if (repo === null) return notFound();

  // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return badRequest('request body is not valid JSON');
      const body = isPlainObject(parsed.value) ? parsed.value : {};
      const description = asString(body.description);
      if (description !== undefined) repo.description = description;
      const name = asString(body.name);
      if (name !== undefined && name !== '' && name !== repo.name) {
        if (store.getRepo(owner, name) !== undefined) return unprocessable('name already exists on this account');
        store.repos.delete(store.repoKey(owner, repo.name));
        repo.name = name;
        store.repos.set(store.repoKey(owner, repo.name), repo);
      }
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: Buffer.alloc(0) };
    }
    return notFound();
  }

  // POST /api/v3/repos/{o}/{r}/git/refs — create a ref.
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return badRequest('request body is not valid JSON');
    const body = isPlainObject(parsed.value) ? parsed.value : {};
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (ref === undefined || !ref.startsWith('refs/')) return unprocessable('ref is required');
    if (sha === undefined || !SHA.test(sha)) return unprocessable('sha is required');
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    if (!repo.objects.has(sha)) return unprocessable('Object does not exist');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha } });
  }

  // GET /api/v3/repos/{o}/{r}/git/refs/heads/{branch} — one branch ref (names may hold '/').
  if (tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
    const branch = tail.slice(3).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound();
    return json(200, { ref: `refs/heads/${branch}`, object: { sha } });
  }

  // GET /api/v3/repos/{o}/{r}/branches — every branch. GET .../branches/{branch} — one.
  if (tail[0] === 'branches' && method === 'GET') {
    if (tail.length === 1) {
      const branches: Record<string, unknown>[] = [];
      for (const [refName, sha] of repo.refs) {
        if (refName.startsWith('refs/heads/')) branches.push(branchJson(repo, refName.slice('refs/heads/'.length), sha));
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json(200, branches);
    }
    const branch = tail.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) return notFound();
    return json(200, branchJson(repo, branch, sha));
  }

  // GET /api/v3/repos/{o}/{r}/commits[?sha=<ref>] — the branch's commits, newest first.
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isObjectId(ref) ? ref : undefined);
    if (tip === undefined || !repo.objects.has(tip)) return notFound();
    const commits = commitsOnBranch(repo, tip).map((sha) => {
      const commit = parseCommit(repo.objects.get(sha)!.data);
      // The stored message ends with a newline; the API returns it without the trailing blank.
      return { sha, commit: { message: commit.message.replace(/\n+$/, '') } };
    });
    return json(200, commits);
  }

  // Contents: /api/v3/repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (path === '') return notFound();
    const refParam = req.query.get('ref');
    const resolveTip = (): string | undefined => {
      if (refParam === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return repo.refs.get(`refs/heads/${refParam}`) ?? (isObjectId(refParam) ? refParam : undefined);
    };
    if (method === 'GET') {
      const tip = resolveTip();
      if (tip === undefined) return notFound();
      const object = repo.objects.get(tip);
      if (!object || object.type !== 'commit') return notFound();
      const flat = flattenTree(repo, parseCommit(object.data).tree);
      const exact = flat.get(path);
      if (exact) {
        const blob = repo.objects.get(exact.oid);
        if (!blob) return notFound();
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: exact.oid,
          size: blob.data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      const prefix = `${path}/`;
      const entries: Record<string, unknown>[] = [];
      const seenDirs = new Set<string>();
      for (const [entryPath, entry] of flat) {
        if (!entryPath.startsWith(prefix)) continue;
        const restPath = entryPath.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash === -1) {
          entries.push({ type: 'file', name: restPath, path: entryPath, sha: entry.oid });
        } else {
          const dirName = restPath.slice(0, slash);
          if (!seenDirs.has(dirName)) {
            seenDirs.add(dirName);
            const dirPath = `${path}/${dirName}`;
            const dirTree = findDirTree(repo, flat, dirPath);
            entries.push({ type: 'dir', name: dirName, path: dirPath, sha: dirTree ?? ZERO_OID });
          }
        }
      }
      if (entries.length === 0) return notFound();
      entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json(200, entries);
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return badRequest('request body is not valid JSON');
      const body = isPlainObject(parsed.value) ? parsed.value : {};
      const message = asString(body.message);
      const content = asString(body.content);
      if (message === undefined || content === undefined) return unprocessable('message and content are required');
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(content, 'base64');
      } catch {
        return unprocessable('content is not valid base64');
      }
      const branch = asString(body.branch);
      const expectedSha = asString(body.sha);
      const { seq } = store.stamp();
      const changed = commitFileChange(repo, {
        path,
        content: contentBytes,
        message,
        branch,
        expectedSha,
        timestamp: Math.floor(Date.UTC(2026, 10, 17) / 1000) + seq,
      });
      if (changed === null) return conflict('sha does not match the current file');
      return json(changed.isNew ? 201 : 200, {
        content: { sha: changed.contentSha, encoding: 'base64' },
        commit: { sha: changed.commitSha },
      });
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return badRequest('request body is not valid JSON');
      const body = isPlainObject(parsed.value) ? parsed.value : {};
      const message = asString(body.message);
      const sha = asString(body.sha);
      if (message === undefined) return unprocessable('message is required');
      const branch = asString(body.branch);
      const { seq } = store.stamp();
      const changed = commitFileChange(repo, {
        path,
        content: Buffer.alloc(0),
        message,
        branch,
        expectedSha: sha,
        timestamp: Math.floor(Date.UTC(2026, 10, 17) / 1000) + seq,
        deleteFile: true,
      });
      if (changed === null) return notFound();
      return json(200, { commit: { sha: changed.commitSha } });
    }
    return notFound();
  }

  // POST /api/v3/repos/{o}/{r}/labels — create a label.
  if (tail.length === 1 && tail[0] === 'labels' && method === 'POST') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return badRequest('request body is not valid JSON');
    const body = isPlainObject(parsed.value) ? parsed.value : {};
    const name = asString(body.name);
    if (name === undefined || name === '') return unprocessable('name is required');
    const color = asString(body.color) ?? 'ededed';
    const label = store.createLabel(repo, name, color);
    return json(201, labelJson(label));
  }

  // Issues: /api/v3/repos/{o}/{r}/issues[/{n}[/comments]]
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return badRequest('request body is not valid JSON');
        const body = isPlainObject(parsed.value) ? parsed.value : {};
        const title = asString(body.title);
        if (title === undefined || title === '') return unprocessable('title is required');
        const bodyText = asString(body.body) ?? '';
        const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (!label) return unprocessable(`label ${labelName} does not exist`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, bodyText, labels);
        return json(201, issueJson(issue));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let issues = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
        if (sort === 'created') {
          issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        return json(200, issues.map(issueJson));
      }
      return notFound();
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) return notFound();
    if (tail.length === 2) {
      if (method === 'GET') return json(200, issueJson(issue));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return badRequest('request body is not valid JSON');
        const body = isPlainObject(parsed.value) ? parsed.value : {};
        const state = asString(body.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(body.title);
        if (title !== undefined) issue.title = title;
        const bodyText = asString(body.body);
        if (bodyText !== undefined) issue.body = bodyText;
        const { at } = store.stamp();
        issue.updatedAt = at;
        return json(200, issueJson(issue));
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return badRequest('request body is not valid JSON');
        const body = isPlainObject(parsed.value) ? parsed.value : {};
        const commentBody = asString(body.body);
        if (commentBody === undefined || commentBody === '') return unprocessable('body is required');
        const comment = store.createComment(issue, commentBody);
        return json(201, commentJson(comment));
      }
      if (method === 'GET') return json(200, issue.comments.map(commentJson));
      return notFound();
    }
    return notFound();
  }

  // Pull requests: /api/v3/repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return badRequest('request body is not valid JSON');
        const body = isPlainObject(parsed.value) ? parsed.value : {};
        const title = asString(body.title);
        const head = asString(body.head);
        const base = asString(body.base);
        if (title === undefined || title === '') return unprocessable('title is required');
        if (head === undefined || head === '') return unprocessable('head is required');
        if (base === undefined || base === '') return unprocessable('base is required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined) return unprocessable(`head branch ${head} does not exist`);
        if (baseSha === undefined) return unprocessable(`base branch ${base} does not exist`);
        if (store.openPullForHead(repo, head) !== undefined) {
          return unprocessable('a pull request is already open for this head branch');
        }
        const pull = store.createPull(repo, title, asString(body.body) ?? '', head, headSha, base, baseSha);
        return json(201, pullJson(repo, pull));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const pulls = repo.pulls.filter((pull) => (state === 'all' ? true : pull.state === state));
        return json(200, pulls.map((pull) => pullJson(repo, pull)));
      }
      return notFound();
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return notFound();
    if (tail.length === 2) {
      if (method === 'GET') return json(200, pullJson(repo, pull));
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const headFlat = treeFlatOf(repo, pull.head.sha);
      const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
      const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
      const mergeBase = findMergeBase(repo, headTip, baseTip);
      const baseFlat = mergeBase !== null ? treeFlatOf(repo, mergeBase) : new Map();
      if (!headFlat || !baseFlat) return notFound();
      const diff = diffFlat(baseFlat, headFlat);
      const files: Record<string, unknown>[] = [];
      for (const [filename, change] of diff) {
        const oldContent = change.a === null ? '' : (repo.objects.get(change.a.oid)?.data.toString('utf8') ?? '');
        const newContent = change.b === null ? '' : (repo.objects.get(change.b.oid)?.data.toString('utf8') ?? '');
        const { additions, deletions } = lineDiff(oldContent, newContent);
        const status = change.a === null ? 'added' : change.b === null ? 'removed' : 'modified';
        files.push({ filename, status, additions, deletions, changes: additions + deletions });
      }
      files.sort((a, b) => String(a.filename).localeCompare(String(b.filename)));
      return json(200, files);
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull.state !== 'open' || pull.merged) {
        return messageOnly(405, 'Pull request is already merged or closed');
      }
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return badRequest('request body is not valid JSON');
      const body = isPlainObject(parsed.value) ? parsed.value : {};
      const mergeMethod = asString(body.merge_method) ?? 'squash';
      if (mergeMethod !== 'squash') return unprocessable('only the squash merge method is supported');
      const { seq, at } = store.stamp();
      const mergeSha = squashMerge(repo, pull, pull.title, Math.floor(Date.UTC(2026, 10, 17) / 1000) + seq);
      if (mergeSha === null) return messageOnly(405, 'Merge conflict');
      pull.merged = true;
      pull.state = 'closed';
      pull.merge_commit_sha = mergeSha;
      pull.merged_at = at;
      pull.updatedAt = at;
      // The head and base shas stay as opened; the base ref now points at the merge commit.
      return json(200, { merged: true, sha: mergeSha, message: pull.title });
    }
    return notFound();
  }

  return notFound();
}

/** The tree id of a directory inside a flattened tree, by rebuilding its subtree. */
function findDirTree(
  repo: Repo,
  flat: ReadonlyMap<string, { mode: string; oid: string }>,
  dirPath: string,
): string | null {
  const prefix = `${dirPath}/`;
  const sub = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of flat) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), entry);
  }
  if (sub.size === 0) return null;
  // Rebuild just this directory's tree from its direct children.
  const children = new Map<string, { mode: string; oid: string } | 'dir'>();
  for (const [path, entry] of sub) {
    const slash = path.indexOf('/');
    if (slash === -1) children.set(path, entry);
    else children.set(path.slice(0, slash), 'dir');
  }
  const entries: { mode: string; name: string; oid: string }[] = [];
  for (const [name, child] of children) {
    if (child === 'dir') {
      const nested = findDirTree(repo, flat, `${dirPath}/${name}`);
      if (nested === null) continue;
      entries.push({ mode: '40000', name, oid: nested });
    } else {
      entries.push({ mode: child.mode, name, oid: child.oid });
    }
  }
  return putObject(repo, 'tree', buildTree(entries));
}

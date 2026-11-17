// store.ts — the forge's whole state, in memory.
//
// One Store holds every repository, and each repository holds its own git objects, refs,
// issues, pull requests and labels. Nothing is persisted: a trial runs one process, and the
// suite is its only client, so an in-memory store is the whole database. Timestamps are
// deterministic (a fixed epoch plus a global creation sequence) so two runs of the same
// requests leave the same visible state.
//
// The viewer is the scenario's fixed identity (the trial seed never changes it): the user
// adaiversen, id 1000. The bearer token is opaque, so the forge knows the viewer from the
// seed, not from the token.

export interface User {
  login: string;
  id: number;
  name: string;
  email: string;
  type: string;
}

/** The one user the suite ever acts as. */
export const VIEWER: User = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
};

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  user: User;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  user: User;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
  user: User;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  issueSeq: number;
  pulls: Pull[];
  pullSeq: number;
  labels: Map<string, Label>;
}

/** A fixed epoch; every timestamp is the epoch plus the global sequence, in seconds. */
const EPOCH_MS = Date.UTC(2026, 10, 17, 0, 0, 0);

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private seq = 0;

  /** The next creation-sequence number (1-based), and the timestamp that goes with it. */
  stamp(): { seq: number; at: string } {
    this.seq += 1;
    return { seq: this.seq, at: new Date(EPOCH_MS + this.seq * 1000).toISOString() };
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const { seq, at } = this.stamp();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      issueSeq: 1,
      pulls: [],
      pullSeq: 1,
      labels: new Map(),
    };
    this.nextRepoId += 1;
    void at;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const { seq, at } = this.stamp();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq,
      createdAt: at,
      updatedAt: at,
      user: VIEWER,
    };
    this.nextIssueId += 1;
    repo.issueSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  createComment(issue: Issue, body: string): Comment {
    const { seq, at } = this.stamp();
    const comment: Comment = {
      id: this.nextCommentId,
      body,
      seq,
      createdAt: at,
      updatedAt: at,
      user: VIEWER,
    };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
  ): Pull {
    const { seq, at } = this.stamp();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      merged: false,
      merge_commit_sha: null,
      merged_at: null,
      seq,
      createdAt: at,
      updatedAt: at,
      user: VIEWER,
    };
    this.nextPullId += 1;
    repo.pullSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** The open pull request on this repo whose head ref is `headRef`, if any. */
  openPullForHead(repo: Repo, headRef: string): Pull | undefined {
    return repo.pulls.find((pull) => pull.state === 'open' && pull.head.ref === headRef);
  }
}

/** A base64 global id that never leaks the database id in plain text. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id back into its kind and parts; null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const segments = text.split(':');
  if (segments.length < 2) return null;
  const kind = segments[0] ?? '';
  if (!/^[A-Za-z]+$/.test(kind)) return null;
  return { kind, parts: segments.slice(1) };
}

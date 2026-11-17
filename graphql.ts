// graphql.ts — the GraphQL v4 API at /api/graphql.
//
// A small hand-written parser and executor for the documents gh and github-mcp-server send:
// viewer, repository (with issue/issues/pullRequest/pullRequests), node(id:), __type
// introspection, and the five mutations (createIssue, closeIssue, createPullRequest,
// mergePullRequest, addComment). Global ids are opaque base64; an unknown repository is
// data.repository = null with no errors; an unknown field is HTTP 200 with an errors array
// naming it; a batched body (a JSON array) answers an array of results in order.

import { diffFlat, findMergeBase, mergeableOf, squashMerge, treeFlatOf } from './git.ts';
import { isPlainObject, json, type ApiRequest, type ApiResponse } from './http.ts';
import {
  decodeGlobalId,
  globalId,
  VIEWER,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
  type User,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// values (the parser's literal / variable nodes)
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node.fields)) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the parser (tokeniser + recursive descent over the document subset the suite sends)
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'eof' };

function tokenise(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (token: Token): void => {
    tokens.push(token);
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]='.includes(ch)) {
      push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const next = source[i + 1] ?? '';
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += next;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (/[0-9]/.test(source[j] ?? '')) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (/[0-9]/.test(source[j] ?? '')) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (/[0-9]/.test(source[j] ?? '')) j += 1;
      }
      const text = source.slice(i, j);
      push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (/[A-Za-z0-9_]/.test(source[j] ?? '')) j += 1;
      push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  push({ kind: 'eof' });
  return tokens;
}

interface Directive {
  name: string;
  args: Record<string, ValueNode>;
}

interface FieldSelection {
  kind: 'field';
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  directives: Directive[];
  selections?: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
  directives: Directive[];
}

interface InlineSelection {
  kind: 'inline';
  typeCondition?: string;
  directives: Directive[];
  selections: Selection[];
}

type Selection = FieldSelection | SpreadSelection | InlineSelection;

interface VariableDef {
  name: string;
  defaultValue?: ValueNode;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: VariableDef[];
  selections: Selection[];
}

interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenise(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseFragment(): Fragment {
    this.next();
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error(`expected "on" in a fragment, got ${JSON.stringify(on)}`);
    const typeCondition = this.expectName();
    this.parseDirectives();
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const next = this.peek();
      if (next.kind === 'name') {
        name = next.value;
        this.next();
      }
    }
    const variables = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefinitions(): VariableDef[] {
    const defs: VariableDef[] = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      const dollar = this.next();
      if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in a variable definition');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, directives, selections };
      }
      if (next.kind === 'name') {
        const name = next.value;
        this.next();
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      throw new Error('expected a fragment name or "on" after ...');
    }
    return this.parseField();
  }

  private parseField(): FieldSelection {
    let name = this.expectName();
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: Selection[] | undefined;
    const peeked = this.peek();
    if (peeked.kind === 'punct' && peeked.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseDirectives(): Directive[] {
    const directives: Directive[] = [];
    while (this.acceptPunct('@')) {
      const name = this.expectName();
      const args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked.kind === 'punct' && peeked.value === ']') break;
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      for (;;) {
        const peeked = this.peek();
        if (peeked.kind === 'punct' && peeked.value === '}') break;
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// the schema the introspection probe reads
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  SearchType: [],
};

const SCHEMA_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------------------------
// resolved values (tagged so the executor knows which fields each one carries)
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { __typename: 'Query' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; user: User }
  | { __typename: 'IssueConnection'; repo: Repo; items: Issue[]; pageInfo: PageInfo }
  | { __typename: 'PullRequestConnection'; repo: Repo; items: Pull[]; pageInfo: PageInfo }
  | { __typename: 'FileConnection'; items: Array<{ path: string; seq: number }>; pageInfo: PageInfo }
  | { __typename: 'IssueComment'; comment: Comment }
  | { __typename: 'IssueEdge'; issue: Issue; repo: Repo; cursor: string }
  | { __typename: 'PullRequestEdge'; pull: Pull; repo: Repo; cursor: string }
  | { __typename: 'FileEdge'; path: string; cursor: string }
  | { __typename: 'CommentEdge'; comment: Comment }
  | { __typename: 'PageInfo'; info: PageInfo }
  | { __typename: '__Type'; name: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: Comment }
  | { __typename: 'Label'; label: Label }
  | { __typename: 'Field'; name: string }
  | { __typename: 'EnumValue'; name: string };

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
  hasPreviousPage: boolean;
  startCursor: string | null;
}

function encodeCursor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Slice an already-ordered list by first/after, with the page's cursors. */
function paginate<T extends { seq: number }>(
  items: readonly T[],
  args: { first?: number; after?: string },
): { page: T[]; pageInfo: PageInfo } {
  let startIndex = 0;
  if (args.after !== undefined) {
    const afterSeq = decodeCursor(args.after);
    if (afterSeq !== null) {
      const index = items.findIndex((item) => item.seq === afterSeq);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const first = args.first ?? items.length;
  const page = items.slice(startIndex, startIndex + first);
  return {
    page: [...page],
    pageInfo: {
      hasNextPage: startIndex + page.length < items.length,
      endCursor: page.length ? encodeCursor(page[page.length - 1]!.seq) : null,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length ? encodeCursor(page[0]!.seq) : null,
    },
  };
}

function stateOf(state: string): 'OPEN' | 'CLOSED' {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.id, pull.number);
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository' || decoded.parts.length !== 1) return null;
  return store.getRepoById(Number(decoded.parts[0])) ?? null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue' || decoded.parts.length !== 2) return null;
  const repo = store.getRepoById(Number(decoded.parts[0]));
  if (!repo) return null;
  const issue = repo.issues.find((entry) => entry.number === Number(decoded.parts[1]));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest' || decoded.parts.length !== 2) return null;
  const repo = store.getRepoById(Number(decoded.parts[0]));
  if (!repo) return null;
  const pull = repo.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
  return pull ? { repo, pull } : null;
}

/** The files a pull request changes: the diff from its merge-base to its head. */
function pullRequestFiles(repo: Repo, pull: Pull): Array<{ path: string }> {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const mergeBase = findMergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return [];
  const baseFlat = treeFlatOf(repo, mergeBase);
  const headFlat = treeFlatOf(repo, headTip);
  if (!baseFlat || !headFlat) return [];
  const diff = diffFlat(baseFlat, headFlat);
  return [...diff.keys()].sort().map((path) => ({ path }));
}

// ---------------------------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------------------------

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: Array<{ message: string }>;
}

function argValue(field: FieldSelection, name: string, executor: Executor): unknown {
  const node = field.args[name];
  if (node === undefined) return undefined;
  return resolveValue(node, executor.variables);
}

function directivesInclude(field: FieldSelection, executor: Executor): boolean {
  for (const directive of field.directives) {
    if (directive.name === 'skip' || directive.name === 'include') {
      const condition = resolveValue(directive.args['if'] ?? { kind: 'boolean', value: false }, executor.variables);
      const truthy = condition === true;
      if (directive.name === 'skip' && truthy) return false;
      if (directive.name === 'include' && !truthy) return false;
    }
  }
  return true;
}

function executeSelections(parent: GqlValue, selections: Selection[], executor: Executor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = executor.fragments.get(selection.name);
      if (!fragment) {
        executor.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== parent.__typename && parent.__typename !== 'Query') {
        // A fragment on another type contributes nothing here; the type condition is the
        // fragment's own, so a mismatch skips it.
        if (fragment.typeCondition !== parent.__typename) continue;
      }
      Object.assign(out, executeSelections(parent, fragment.selections, executor));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parent.__typename) continue;
      Object.assign(out, executeSelections(parent, selection.selections, executor));
      continue;
    }
    if (!directivesInclude(selection, executor)) continue;
    const key = selection.alias ?? selection.name;
    out[key] = executeField(parent, selection, executor);
  }
  return out;
}

function executeField(parent: GqlValue, field: FieldSelection, executor: Executor): unknown {
  const value = resolveField(parent, field, executor);
  if (value === undefined) {
    executor.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
    return null;
  }
  if (value === null) return null;
  if (field.selections === undefined || field.selections.length === 0) {
    if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const tagged = value as { __typename: string; name?: string };
      if (tagged.__typename === 'Field' || tagged.__typename === 'EnumValue') return { name: tagged.name };
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
        return executeSelections(item as GqlValue, field.selections!, executor);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return executeSelections(value as GqlValue, field.selections, executor);
  }
  return value;
}

function resolveField(parent: GqlValue, field: FieldSelection, executor: Executor): unknown {
  const store = executor.store;
  switch (parent.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', user: VIEWER } as GqlValue;
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', executor);
        const name = argValue(field, 'name', executor);
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(owner, name);
        return repo ? ({ __typename: 'Repository', repo } as GqlValue) : null;
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', executor);
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          return repo ? ({ __typename: 'Repository', repo } as GqlValue) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(store, id);
          return found ? ({ __typename: 'Issue', repo: found.repo, issue: found.issue } as GqlValue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(store, id);
          return found ? ({ __typename: 'PullRequest', repo: found.repo, pull: found.pull } as GqlValue) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', executor);
        if (typeof name !== 'string') return null;
        if (!(name in SCHEMA_FIELDS) && !(name in SCHEMA_ENUM_VALUES)) return null;
        return { __typename: '__Type', name } as GqlValue;
      }
      return undefined;
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'owner':
          return { __typename: 'User', user: VIEWER } as GqlValue;
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.defaultBranch } as GqlValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argValue(field, 'number', executor);
          if (typeof number !== 'number') return null;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue ? ({ __typename: 'Issue', repo, issue } as GqlValue) : null;
        }
        case 'issues': {
          const states = argValue(field, 'states', executor);
          const orderBy = argValue(field, 'orderBy', executor);
          let items = [...repo.issues];
          if (Array.isArray(states) && states.length) {
            const wanted = new Set(states.map((state) => String(state).toUpperCase()));
            items = items.filter((issue) => wanted.has(stateOf(issue.state)));
          }
          const order = isPlainObject(orderBy) ? orderBy : {};
          const direction = String(order['direction'] ?? 'DESC').toUpperCase();
          items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
          const first = argValue(field, 'first', executor);
          const after = argValue(field, 'after', executor);
          const { page, pageInfo } = paginate(items, {
            first: typeof first === 'number' ? first : undefined,
            after: typeof after === 'string' ? after : undefined,
          });
          return { __typename: 'IssueConnection', repo, items: page, pageInfo } as GqlValue;
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', executor);
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull ? ({ __typename: 'PullRequest', repo, pull } as GqlValue) : null;
        }
        case 'pullRequests': {
          const states = argValue(field, 'states', executor);
          const orderBy = argValue(field, 'orderBy', executor);
          let items = [...repo.pulls];
          if (Array.isArray(states) && states.length) {
            const wanted = new Set(states.map((state) => String(state).toUpperCase()));
            items = items.filter((pull) => wanted.has(stateOf(pull.state)));
          }
          const order = isPlainObject(orderBy) ? orderBy : {};
          const direction = String(order['direction'] ?? 'DESC').toUpperCase();
          items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
          const first = argValue(field, 'first', executor);
          const after = argValue(field, 'after', executor);
          const { page, pageInfo } = paginate(items, {
            first: typeof first === 'number' ? first : undefined,
            after: typeof after === 'string' ? after : undefined,
          });
          return { __typename: 'PullRequestConnection', repo, items: page, pageInfo } as GqlValue;
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id':
          return issueGlobalId(parent.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return stateOf(issue.state);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'author':
          return { __typename: 'User', user: VIEWER } as GqlValue;
        case 'repository':
          return { __typename: 'Repository', repo: parent.repo } as GqlValue;
        case 'labels':
          return null;
        case 'comments':
          return null;
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = parent.pull;
      switch (field.name) {
        case 'id':
          return pullGlobalId(parent.repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'mergeable':
          return mergeableOf(parent.repo, pull);
        case 'state':
          return pull.merged ? 'MERGED' : stateOf(pull.state);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.merged_at;
        case 'author':
          return { __typename: 'User', user: VIEWER } as GqlValue;
        case 'repository':
          return { __typename: 'Repository', repo: parent.repo } as GqlValue;
        case 'files': {
          const first = argValue(field, 'first', executor);
          const files = pullRequestFiles(parent.repo, pull).map((entry, index) => ({ ...entry, seq: index + 1 }));
          const { page, pageInfo } = paginate(files, { first: typeof first === 'number' ? first : undefined });
          return { __typename: 'FileConnection', items: page, pageInfo } as GqlValue;
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      switch (field.name) {
        case 'login':
          return parent.user.login;
        case 'id':
          return parent.user.id;
        case 'name':
          return parent.user.name;
        case 'email':
          return parent.user.email;
        case 'avatarUrl':
          return '';
        default:
          return undefined;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return parent.items.map((item) => {
          if (parent.__typename === 'IssueConnection') {
            return { __typename: 'Issue', repo: parent.repo, issue: item as Issue } as GqlValue;
          }
          return { __typename: 'PullRequest', repo: parent.repo, pull: item as Pull } as GqlValue;
        });
      }
      if (field.name === 'edges') {
        return parent.items.map((item) => {
          if (parent.__typename === 'IssueConnection') {
            const issue = item as Issue;
            return { __typename: 'IssueEdge', issue, repo: parent.repo, cursor: encodeCursor(issue.seq) } as GqlValue;
          }
          const pull = item as Pull;
          return { __typename: 'PullRequestEdge', pull, repo: parent.repo, cursor: encodeCursor(pull.seq) } as GqlValue;
        });
      }
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', info: parent.pageInfo } as GqlValue;
      if (field.name === 'totalCount') return parent.items.length;
      return undefined;
    }
    case 'FileConnection': {
      if (field.name === 'nodes') return parent.items.map((item) => ({ __typename: 'FileEdge', path: item.path, cursor: encodeCursor(item.seq) } as GqlValue));
      if (field.name === 'edges') return parent.items.map((item) => ({ __typename: 'FileEdge', path: item.path, cursor: encodeCursor(item.seq) } as GqlValue));
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', info: parent.pageInfo } as GqlValue;
      if (field.name === 'totalCount') return parent.items.length;
      return undefined;
    }
    case 'IssueEdge': {
      if (field.name === 'node') return { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue;
      if (field.name === 'cursor') return parent.cursor;
      return undefined;
    }
    case 'PullRequestEdge': {
      if (field.name === 'node') return { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue;
      if (field.name === 'cursor') return parent.cursor;
      return undefined;
    }
    case 'FileEdge': {
      if (field.name === 'node') return parent;
      if (field.name === 'path') return parent.path;
      if (field.name === 'cursor') return parent.cursor;
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.info.hasNextPage;
      if (field.name === 'endCursor') return parent.info.endCursor;
      if (field.name === 'hasPreviousPage') return parent.info.hasPreviousPage;
      if (field.name === 'startCursor') return parent.info.startCursor;
      return undefined;
    }
    case 'IssueComment': {
      if (field.name === 'id') return globalId('IssueComment', parent.comment.id);
      if (field.name === 'body') return parent.comment.body;
      if (field.name === 'author') return { __typename: 'User', user: VIEWER } as GqlValue;
      if (field.name === 'createdAt') return parent.comment.createdAt;
      if (field.name === 'updatedAt') return parent.comment.updatedAt;
      return undefined;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return { __typename: 'IssueComment', comment: parent.comment } as GqlValue;
      if (field.name === 'cursor') return encodeCursor(parent.comment.seq);
      return undefined;
    }
    case '__Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return parent.name in SCHEMA_ENUM_VALUES && !(parent.name in SCHEMA_FIELDS) ? 'ENUM' : 'OBJECT';
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const names = SCHEMA_FIELDS[parent.name] ?? [];
        return names.map((name) => ({ __typename: 'Field', name }) as unknown as GqlValue);
      }
      if (field.name === 'enumValues') {
        const names = SCHEMA_ENUM_VALUES[parent.name] ?? [];
        return names.map((name) => ({ __typename: 'EnumValue', name }) as unknown as GqlValue);
      }
      return undefined;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue;
      return undefined;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue;
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue;
      return undefined;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull } as GqlValue;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { __typename: 'CommentEdge', comment: parent.comment } as GqlValue;
      if (field.name === 'comment') return { __typename: 'IssueComment', comment: parent.comment } as GqlValue;
      if (field.name === 'subject') return { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as GqlValue;
      return undefined;
    }
    case 'Label': {
      if (field.name === 'name') return parent.label.name;
      if (field.name === 'color') return parent.label.color;
      return undefined;
    }
    case 'Field':
    case 'EnumValue': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executeOperation(operation: Operation, document: Document, store: Store, variables: Record<string, unknown>): Record<string, unknown> {
  const executor: Executor = { store, variables, fragments: document.fragments, errors: [] };
  // Apply the operation's variable defaults for variables the caller did not send.
  for (const def of operation.variables) {
    if (executor.variables[def.name] === undefined && def.defaultValue !== undefined) {
      executor.variables[def.name] = resolveValue(def.defaultValue, executor.variables);
    }
  }
  const data = executeSelections({ __typename: 'Query' }, operation.selections, executor);
  const rendered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) rendered[key] = renderValue(value);
  const out: Record<string, unknown> = { data: rendered };
  if (executor.errors.length) out['errors'] = executor.errors;
  return out;
}

function renderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renderValue);
  if (value !== null && typeof value === 'object') {
    const tagged = value as Record<string, unknown>;
    if ('__typename' in tagged) {
      const name = tagged['__typename'];
      if (name === 'Field' || name === 'EnumValue') return { name: tagged['name'] };
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(tagged)) out[key] = renderValue(entry);
    return out;
  }
  return value;
}

/** Run one mutation's field against the store; the payload is what the selections read. */
function runMutation(field: FieldSelection, executor: Executor): GqlValue | null {
  const store = executor.store;
  const input = argValue(field, 'input', executor);
  const inputObject = isPlainObject(input) ? input : {};
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = inputObject['repositoryId'];
      if (typeof repositoryId !== 'string') return null;
      const repo = findRepoByGlobalId(store, repositoryId);
      if (!repo) return null;
      const title = typeof inputObject['title'] === 'string' ? inputObject['title'] : '';
      const body = typeof inputObject['body'] === 'string' ? inputObject['body'] : '';
      const issue = store.createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', repo, issue };
    }
    case 'closeIssue': {
      const issueId = inputObject['issueId'];
      if (typeof issueId !== 'string') return null;
      const found = findIssueByGlobalId(store, issueId);
      if (!found) return null;
      found.issue.state = 'closed';
      const { at } = store.stamp();
      found.issue.updatedAt = at;
      return { __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue };
    }
    case 'createPullRequest': {
      const repositoryId = inputObject['repositoryId'];
      if (typeof repositoryId !== 'string') return null;
      const repo = findRepoByGlobalId(store, repositoryId);
      if (!repo) return null;
      const baseRefName = typeof inputObject['baseRefName'] === 'string' ? inputObject['baseRefName'] : '';
      const headRefName = typeof inputObject['headRefName'] === 'string' ? inputObject['headRefName'] : '';
      const title = typeof inputObject['title'] === 'string' ? inputObject['title'] : '';
      const headSha = repo.refs.get(`refs/heads/${headRefName}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
      if (!headSha || !baseSha) return null;
      if (store.openPullForHead(repo, headRefName) !== undefined) return null;
      const pull = store.createPull(repo, title, '', headRefName, headSha, baseRefName, baseSha);
      return { __typename: 'CreatePullRequestPayload', repo, pull };
    }
    case 'mergePullRequest': {
      const pullRequestId = inputObject['pullRequestId'];
      if (typeof pullRequestId !== 'string') return null;
      const found = findPullByGlobalId(store, pullRequestId);
      if (!found) return null;
      if (found.pull.state !== 'open' || found.pull.merged) return null;
      const { seq, at } = store.stamp();
      const mergeSha = squashMerge(found.repo, found.pull, found.pull.title, Math.floor(Date.UTC(2026, 10, 17) / 1000) + seq);
      if (mergeSha === null) return null;
      found.pull.merged = true;
      found.pull.state = 'closed';
      found.pull.merge_commit_sha = mergeSha;
      found.pull.merged_at = at;
      found.pull.updatedAt = at;
      return { __typename: 'MergePullRequestPayload', repo: found.repo, pull: found.pull };
    }
    case 'addComment': {
      const subjectId = inputObject['subjectId'];
      if (typeof subjectId !== 'string') return null;
      const found = findIssueByGlobalId(store, subjectId);
      if (!found) return null;
      const body = typeof inputObject['body'] === 'string' ? inputObject['body'] : '';
      const comment = store.createComment(found.issue, body);
      return { __typename: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment };
    }
    default:
      return null;
  }
}

function executeMutationOperation(operation: Operation, document: Document, store: Store, variables: Record<string, unknown>): Record<string, unknown> {
  const executor: Executor = { store, variables, fragments: document.fragments, errors: [] };
  for (const def of operation.variables) {
    if (executor.variables[def.name] === undefined && def.defaultValue !== undefined) {
      executor.variables[def.name] = resolveValue(def.defaultValue, executor.variables);
    }
  }
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    const payload = runMutation(selection, executor);
    if (payload === null) {
      executor.errors.push({ message: `Mutation "${selection.name}" could not be completed.` });
      data[key] = null;
      continue;
    }
    if (selection.selections === undefined || selection.selections.length === 0) {
      data[key] = renderValue(payload);
    } else {
      data[key] = renderValue(executeSelections(payload, selection.selections, executor));
    }
  }
  const out: Record<string, unknown> = { data };
  if (executor.errors.length) out['errors'] = executor.errors;
  return out;
}

function executeOne(body: unknown, store: Store): Record<string, unknown> {
  if (!isPlainObject(body)) return { errors: [{ message: 'request body must be a JSON object' }] };
  const query = body['query'];
  if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
  const variables = isPlainObject(body['variables']) ? (body['variables'] as Record<string, unknown>) : {};
  const operationName = typeof body['operationName'] === 'string' ? body['operationName'] : undefined;
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'document has no operation' }] };
  let operation = document.operations[0]!;
  if (operationName !== undefined) {
    const named = document.operations.find((entry) => entry.name === operationName);
    if (named) operation = named;
  }
  if (operation.kind === 'mutation') return executeMutationOperation(operation, document, store, { ...variables });
  return executeOperation(operation, document, store, { ...variables });
}

/** Handle one POST /api/graphql request; a JSON array body is answered in order. */
export function handleGraphql(req: ApiRequest, store: Store): ApiResponse {
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return json(400, { errors: [{ message: 'request body is not valid JSON' }] });
  }
  if (Array.isArray(body)) {
    return json(200, body.map((entry) => executeOne(entry, store)));
  }
  return json(200, executeOne(body, store));
}

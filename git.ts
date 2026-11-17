// git.ts — the git object model, the pack protocol, pkt-lines, smart HTTP, and the
// git-aware helpers the REST and GraphQL surfaces need (contents commits, squash merges).
//
// Everything here is written from the protocol's own rules. Objects are stored raw, keyed by
// their SHA-1 over `<type> <size>\0<data>`. The server sends full objects only — the client's
// pack writer never emits deltas, and the pack-deltas check passes when the server sends none.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { VIEWER, type GitObject, type GitObjectType, type Pull, type Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
const AGENT = 'github-core-clone/1.0';

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0<data>`, the object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and return its id. Storing the same bytes twice is a no-op. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** A tree entry's sort key: a directory compares as its name with a trailing slash. */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A tree flattened to path -> {mode, oid}, recursively. Gitlinks are leaves, never followed. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
  const flat = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else flat.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return flat;
}

/** Build (and store) the tree hierarchy for a flat path map; returns the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  const build = (dir: string): string => {
    const children = new Map<string, { mode: string; oid: string } | 'dir'>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(dir)) continue;
      const rest = path.slice(dir.length);
      const slash = rest.indexOf('/');
      if (slash === -1) children.set(rest, entry);
      else children.set(rest.slice(0, slash), 'dir');
    }
    const entries: TreeEntry[] = [];
    for (const [name, child] of children) {
      if (child === 'dir') entries.push({ mode: '40000', name, oid: build(`${dir}${name}/`) });
      else entries.push({ mode: child.mode, name, oid: child.oid });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

/** Every tree and blob id reachable from a tree, not the tree itself twice over. */
export function treeClosure(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const walk = (oid: string): void => {
    if (out.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    out.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '160000') continue;
      if (isDirMode(entry.mode)) walk(entry.oid);
      else out.add(entry.oid);
    }
  };
  walk(treeOid);
  return out;
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  timestamp: number;
}

function identityTimestamp(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident.trim());
  return match ? Number(match[1]) : 0;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, timestamp: identityTimestamp(committer || author) };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${message}`,
    'utf8',
  );
}

/** The forge's own identity for commits it creates. */
export function forgeIdentity(timestamp: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
}

/** Peel a tag (or a chain of tags) to the commit it names, if the object is one. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let steps = 0; steps < 16; steps += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') current = parseTag(object.data).object;
    else return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/** The full object closure reachable from roots (commits, trees, blobs, tags). */
export function collectClosure(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++]!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot?: string[];
}

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch sends. The walk starts at the wants and stops at a have that carries a
 * full history, at the depth limit, and at a commit older than deepen-since; a shallow boundary
 * is walked through (the client has the boundary, not its parents). The send set is the walked
 * commits and their tree closure, minus everything the client already holds.
 */
export function computeFetch(repo: Repo, req: FetchRequest): FetchSelection {
  const haveSet = new Set(req.haves);
  const shallowSet = new Set(req.shallow);
  const depth = req.depth;

  // Everything the client already holds: haves with their full ancestor closure, shallow
  // boundaries on their own (their parents are not held), and deepen-not tips with theirs.
  const held = new Set<string>();
  {
    const deepenNotTips = new Set<string>();
    for (const refName of req.deepenNot ?? []) {
      const oid = repo.refs.get(refName);
      if (oid) deepenNotTips.add(oid);
    }
    const queue: string[] = [...haveSet, ...shallowSet, ...deepenNotTips];
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++]!;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        if (haveSet.has(oid) && !shallowSet.has(oid)) {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
  }
  const heldObjects = new Set<string>(held);
  for (const oid of held) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') {
      for (const entry of treeClosure(repo, parseCommit(object.data).tree)) heldObjects.add(entry);
    }
  }

  // Walk from the wants, tracking how many generations out each commit sits.
  const generations = new Map<string, number>();
  const included = new Set<string>();
  const queue: string[] = [];
  for (const want of req.wants) {
    if (!generations.has(want)) {
      generations.set(want, 0);
      queue.push(want);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++]!;
    if (included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    const gen = generations.get(oid) ?? 0;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (req.deepenSince != null && commit.timestamp < req.deepenSince) continue;
      included.add(oid);
      const atDepthLimit = depth != null && gen >= depth - 1;
      const heldFull = haveSet.has(oid) && !shallowSet.has(oid);
      if (atDepthLimit || heldFull) continue;
      for (const parent of commit.parents) {
        if (!generations.has(parent)) {
          generations.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    } else if (object.type === 'tag') {
      included.add(oid);
      const target = parseTag(object.data).object;
      if (!generations.has(target)) {
        generations.set(target, gen);
        queue.push(target);
      }
    } else {
      included.add(oid);
    }
  }

  const objects = new Map<string, GitObject>();
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    objects.set(oid, object);
    if (object.type === 'commit') {
      for (const entry of treeClosure(repo, parseCommit(object.data).tree)) {
        if (heldObjects.has(entry)) continue;
        const entryObject = repo.objects.get(entry);
        if (entryObject) objects.set(entry, entryObject);
      }
    }
  }

  // The new shallow boundary: the sent commits at the depth limit (or, when the history is
  // shorter than the depth, the deepest sent commits). A full fetch has no boundary.
  let shallow: string[] = [];
  if (depth != null) {
    const sent = [...included].filter((oid) => !held.has(oid));
    const atLimit = sent.filter((oid) => (generations.get(oid) ?? 0) === depth - 1);
    if (atLimit.length) shallow = atLimit;
    else {
      const maxGen = Math.max(-1, ...sent.map((oid) => generations.get(oid) ?? -1));
      shallow = sent.filter((oid) => (generations.get(oid) ?? -1) === maxGen);
    }
  }
  // An old boundary is no longer shallow once it was walked within the depth and is not a
  // boundary any more — its parents are being sent now.
  const unshallow = [...shallowSet].filter((oid) => included.has(oid) && !shallow.includes(oid));

  return { objects, shallow, unshallow };
}

/** The merge-base of two commits: the nearest common ancestor, or null. */
export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  let headA = 0;
  while (headA < queueA.length) {
    const oid = queueA[headA++]!;
    if (ancestorsA.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    ancestorsA.add(oid);
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  let headB = 0;
  while (headB < queueB.length) {
    const oid = queueB[headB++]!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Is `ancestor` an ancestor of `oid` (or the same commit)? */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const queue: string[] = [oid];
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------------------------

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Inflate one zlib stream at `offset`; the engine reports how many input bytes it consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = readSize();
  if (baseSize !== base.length) throw new Error('delta base size does not match the base object');
  const resultSize = readSize();
  const parts: Buffer[] = [];
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= delta[offset++]! << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= delta[offset++]! << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base object');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert runs past the delta');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (written !== resultSize) throw new Error('delta result size does not match its instructions');
  return Buffer.concat(parts);
}

export interface PackRead {
  objects: Map<string, GitObject>;
  checksumOk: boolean;
  deltaCount: number;
}

/** Read a pack (version 2 or 3), resolving any deltas it carries, and verify its trailer. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const external = resolveBase?.(wanted);
      if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
      type = external.type;
      data = applyDelta(external.data, entry.data);
    } else {
      type = CODE_TYPES[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, { type, data });
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, checksumOk, deltaCount };
}

function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) byte |= 0x80;
  bytes.push(byte);
  while (size > 0) {
    byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a pack of full objects only (no deltas), with a correct trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packEntryHeader(object.type, object.data.length));
    // Level 1: the pack is a wire format, not an archive — the fastest deflate wins, and the
    // client verifies the pack by its trailer checksum, not by its size.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = data.length + 4;
  if (total > PKT_LINE_MAX) throw new Error(`pkt-line of ${total} bytes exceeds the 65520 limit`);
  const header = Buffer.from(total.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of lines (or 'flush' / 'delim' markers) as a pkt-line stream. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream; throws on a truncated or oversized line. */
export function decodePktLines(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('pkt-line header is truncated');
    const sizeText = bytes.subarray(offset, offset + 4).toString('ascii');
    if (sizeText === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (sizeText === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 4 || size > PKT_LINE_MAX) {
      throw new Error(`pkt-line has a bad length ${JSON.stringify(sizeText)}`);
    }
    if (offset + size > bytes.length) throw new Error('pkt-line is truncated');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + size) });
    offset += size;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// smart HTTP
// ---------------------------------------------------------------------------------------------

export interface GitHttpResult {
  status: number;
  body: Buffer;
  contentType: string;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultBranchTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The v2 capability advertisement for git-upload-pack. */
function uploadPackAdvertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 ref advertisement for git-receive-pack, capabilities on the first line. */
function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const lines: Array<string | 'flush'> = ['# service=git-receive-pack\n', 'flush'];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = defaultBranchTip(repo);
    if (tip) lines.push(`${tip} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const object = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && object?.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
    if (!tip) lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

export function handleInfoRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): GitHttpResult {
  if (service === 'git-upload-pack') {
    return { status: 200, body: uploadPackAdvertisement(), contentType: 'application/x-git-upload-pack-advertisement' };
  }
  return { status: 200, body: receivePackAdvertisement(repo), contentType: 'application/x-git-receive-pack-advertisement' };
}

/** Parse a v2 request body into its command line and its argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).replace(/\n$/, '') : '';
  const args = lines.slice(1).map((line) => line.replace(/\n$/, ''));
  return { command, args };
}

/** The v2 ls-refs answer: HEAD, then every ref, peeled tags carrying their commit. */
function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const tip = defaultBranchTip(repo);
  if (prefixes.length === 0) {
    if (tip) lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    const object = repo.objects.get(oid);
    let line = `${oid} ${name}`;
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 fetch answer: acknowledgments, shallow-info, then the packfile in sideband band 1. */
function handleFetch(repo: Repo, args: string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n) && n > 0) req.depth = Math.floor(n);
    } else if (arg.startsWith('deepen-since ')) {
      const n = Number(arg.slice(13).trim());
      if (Number.isFinite(n)) req.deepenSince = Math.floor(n);
    } else if (arg.startsWith('deepen-not ')) req.deepenNot = [...(req.deepenNot ?? []), arg.slice(11).trim()];
  }
  const selection = computeFetch(repo, req);
  const parts: Buffer[] = [];
  const ackLines: string[] = ['acknowledgments\n'];
  if (req.haves.length === 0) {
    ackLines.push('NAK\n');
  } else {
    let anyAck = false;
    for (const have of req.haves) {
      if (repo.objects.has(have)) {
        ackLines.push(`ACK ${have}\n`);
        anyAck = true;
      }
    }
    if (!anyAck) ackLines.push('NAK\n');
    ackLines.push('ready\n');
  }
  parts.push(encodePktLines(ackLines));
  parts.push(pktDelim());
  if (selection.shallow.length || selection.unshallow.length) {
    const shallowLines: string[] = ['shallow-info\n'];
    for (const oid of selection.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of selection.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(shallowLines));
    parts.push(pktDelim());
  }
  if (selection.objects.size > 0) {
    const pack = writePack(selection.objects.values());
    const packLines: Array<string | Buffer | 'flush'> = ['packfile\n'];
    const maxChunk = PKT_LINE_MAX - 4 - 1;
    for (let offset = 0; offset < pack.length; offset += maxChunk) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
      packLines.push(Buffer.concat([Buffer.from([1]), chunk]));
    }
    packLines.push('flush');
    parts.push(encodePktLines(packLines));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo, body: Buffer): GitHttpResult {
  let parsed: { command: string; args: string[] };
  try {
    parsed = parseV2Request(body);
  } catch (err) {
    return { status: 400, body: Buffer.from(`bad request: ${(err as Error).message}\n`, 'utf8'), contentType: 'text/plain' };
  }
  if (parsed.command === 'ls-refs') {
    return { status: 200, body: handleLsRefs(repo, parsed.args), contentType: 'application/x-git-upload-pack-result' };
  }
  if (parsed.command === 'fetch') {
    return { status: 200, body: handleFetch(repo, parsed.args), contentType: 'application/x-git-upload-pack-result' };
  }
  return { status: 400, body: Buffer.from('unknown command\n', 'utf8'), contentType: 'text/plain' };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The v0 receive-pack exchange: command list, then the pack, then a report-status in band 1. */
export function handleReceivePack(repo: Repo, body: Buffer): GitHttpResult {
  const reportLines: string[] = [];
  const respond = (lines: string[]): GitHttpResult => {
    // Each report line is pkt-lined inside one band-1 sideband frame; encodePktLines adds the
    // outer pkt-line framing, so the frames here are the raw band payloads, not pkt-lines.
    const frames: Array<Buffer | 'flush'> = [];
    for (const line of lines) {
      frames.push(Buffer.concat([Buffer.from([1]), encodePktLine(line)]));
    }
    frames.push('flush');
    return { status: 200, body: encodePktLines(frames), contentType: 'application/x-git-receive-pack-result' };
  };
  // Parse the command list pkt-line by pkt-line until the first flush; everything after the
  // flush is the pack, which is binary and must never be read as pkt-lines.
  const commandLines: string[] = [];
  let packStart = body.length;
  let streamOk = false;
  {
    let offset = 0;
    while (offset < body.length) {
      if (offset + 4 > body.length) break;
      const sizeText = body.subarray(offset, offset + 4).toString('ascii');
      if (sizeText === '0000') {
        packStart = offset + 4;
        streamOk = true;
        break;
      }
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 4 || size > PKT_LINE_MAX) break;
      if (offset + size > body.length) break;
      commandLines.push(body.subarray(offset + 4, offset + size).toString('utf8'));
      offset += size;
    }
  }
  if (!streamOk) return respond(['unpack bad pkt-line stream\n']);
  const commands: PushCommand[] = [];
  for (let index = 0; index < commandLines.length; index += 1) {
    const raw = commandLines[index]!.replace(/\n$/, '');
    const nul = index === 0 ? raw.indexOf('\0') : -1;
    const text = nul >= 0 ? raw.slice(0, nul) : raw;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!match) return respond(['unpack bad command line\n']);
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0) return respond(['unpack no commands\n']);

  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  const pack = needsPack ? body.subarray(Math.min(packStart, body.length)) : Buffer.alloc(0);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      if (!read.checksumOk) throw new Error('pack trailer does not match its bytes');
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.slice(0, 200);
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
    return respond(reportLines);
  }
  reportLines.push('unpack ok\n');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
      reportLines.push(`ng ${command.ref} invalid old and new object ids\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create: the ref must not exist, and the new object must be present.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} ref already exists\n`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} new object is missing\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // Delete: the ref must exist at the old id.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} old object id does not match\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    // Update: the ref must be at the old id, the new object must exist, and the move must be
    // a fast-forward (the old tip is an ancestor of the new tip).
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} ref does not exist\n`);
      continue;
    }
    if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} old object id does not match\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} new object is missing\n`);
      continue;
    }
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  return respond(reportLines);
}

// ---------------------------------------------------------------------------------------------
// contents commits and squash merges (the git-aware work behind REST and GraphQL)
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  commitSha: string;
  contentSha: string;
  isNew: boolean;
}

/**
 * Commit one file change on a branch. When `branch` names a ref that does not exist yet, the
 * branch is created from the default branch's tip. `expectedSha` is the blob the caller read:
 * a mismatch (or a missing file for an update) is a conflict. Returns null on conflict.
 */
export function commitFileChange(
  repo: Repo,
  opts: {
    path: string;
    content: Buffer;
    message: string;
    branch?: string;
    expectedSha?: string;
    timestamp: number;
    deleteFile?: boolean;
  },
): FileChange | null {
  const branchName = opts.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branchName}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branchName !== repo.defaultBranch) {
    tip = defaultBranchTip(repo);
    if (tip !== undefined) repo.refs.set(refName, tip);
  }
  const baseTree = tip !== undefined ? parseCommit(repo.objects.get(tip)!.data).tree : null;
  const flat = baseTree !== null ? flattenTree(repo, baseTree) : new Map<string, { mode: string; oid: string }>();
  const current = flat.get(opts.path);
  if (opts.deleteFile === true) {
    if (current === undefined) return null;
    if (opts.expectedSha !== undefined && current.oid !== opts.expectedSha) return null;
    flat.delete(opts.path);
  } else {
    if (opts.expectedSha !== undefined) {
      if (current === undefined || current.oid !== opts.expectedSha) return null;
    }
    const isNew = current === undefined;
    const blobOid = putObject(repo, 'blob', opts.content);
    flat.set(opts.path, { mode: '100644', oid: blobOid });
    const treeOid = buildTreeFromFlat(repo, flat);
    const ident = forgeIdentity(opts.timestamp);
    const commitOid = putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents: tip !== undefined ? [tip] : [], author: ident, committer: ident, message: opts.message }),
    );
    repo.refs.set(refName, commitOid);
    return { commitSha: commitOid, contentSha: blobOid, isNew };
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const ident = forgeIdentity(opts.timestamp);
  const commitOid = putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: tip !== undefined ? [tip] : [], author: ident, committer: ident, message: opts.message }),
  );
  repo.refs.set(refName, commitOid);
  return { commitSha: commitOid, contentSha: current?.oid ?? '', isNew: false };
}

/** The flat path map of a commit's tree, or null when the commit is missing. */
export function treeFlatOf(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return flattenTree(repo, parseCommit(object.data).tree);
}

/** The paths that differ between two flat trees, with each side's entry (or null). */
export function diffFlat(
  a: ReadonlyMap<string, { mode: string; oid: string }>,
  b: ReadonlyMap<string, { mode: string; oid: string }>,
): Map<string, { a: { mode: string; oid: string } | null; b: { mode: string; oid: string } | null }> {
  const out = new Map<string, { a: { mode: string; oid: string } | null; b: { mode: string; oid: string } | null }>();
  for (const [path, entry] of a) {
    const other = b.get(path);
    if (!other || other.oid !== entry.oid || other.mode !== entry.mode) {
      out.set(path, { a: entry, b: other ?? null });
    }
  }
  for (const [path, entry] of b) {
    if (!a.has(path)) out.set(path, { a: null, b: entry });
  }
  return out;
}

/** Whether a pull request can merge cleanly, from the three-way diff. */
export function mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headFlat = treeFlatOf(repo, headTip);
  const baseFlat = treeFlatOf(repo, baseTip);
  if (!headFlat || !baseFlat) return 'UNKNOWN';
  const mergeBase = findMergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return 'UNKNOWN';
  const baseOfMerge = treeFlatOf(repo, mergeBase);
  if (!baseOfMerge) return 'UNKNOWN';
  const headDiff = diffFlat(baseOfMerge, headFlat);
  const baseDiff = diffFlat(baseOfMerge, baseFlat);
  for (const [path, headChange] of headDiff) {
    const baseChange = baseDiff.get(path);
    if (!baseChange) continue;
    const headOid = headChange.b?.oid ?? null;
    const baseOid = baseChange.b?.oid ?? null;
    if (headOid !== baseOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/**
 * Squash-merge a pull request: one merge commit on the base branch, with one parent (the base
 * tip) and the base tree plus the head's changes. Returns the merge commit id, or null when the
 * merge conflicts.
 */
export function squashMerge(repo: Repo, pull: Pull, message: string, timestamp: number): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headFlat = treeFlatOf(repo, headTip);
  const baseFlat = treeFlatOf(repo, baseTip);
  if (!headFlat || !baseFlat) return null;
  const mergeBase = findMergeBase(repo, headTip, baseTip);
  if (mergeBase === null) return null;
  const baseOfMerge = treeFlatOf(repo, mergeBase);
  if (!baseOfMerge) return null;
  const headDiff = diffFlat(baseOfMerge, headFlat);
  const baseDiff = diffFlat(baseOfMerge, baseFlat);
  for (const [path, headChange] of headDiff) {
    const baseChange = baseDiff.get(path);
    if (!baseChange) continue;
    if ((headChange.b?.oid ?? null) !== (baseChange.b?.oid ?? null)) return null;
  }
  const merged = new Map(baseFlat);
  for (const [path, change] of headDiff) {
    if (change.b === null) merged.delete(path);
    else merged.set(path, change.b);
  }
  const treeOid = buildTreeFromFlat(repo, merged);
  const ident = forgeIdentity(timestamp);
  const mergeCommit = putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, message }),
  );
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeCommit);
  return mergeCommit;
}

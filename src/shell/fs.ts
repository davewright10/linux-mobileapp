// In-memory file system used by the practice terminal.

export type NodeType = 'file' | 'dir' | 'link';

export interface FsNode {
  type: NodeType;
  mode: number; // permission bits incl. setuid/setgid/sticky, e.g. 0o755
  uid: number;
  gid: number;
  mtime: number;
  content?: string; // files
  target?: string; // symlinks
  children?: Record<string, FsNode>; // dirs
  inode: number;
}

let nextInode = 1000;
export function newInode() {
  return nextInode++;
}

export function makeDir(uid = 0, gid = 0, mode = 0o755): FsNode {
  return { type: 'dir', mode, uid, gid, mtime: Date.now(), children: {}, inode: newInode() };
}

export function makeFile(content = '', uid = 0, gid = 0, mode = 0o644): FsNode {
  return { type: 'file', mode, uid, gid, mtime: Date.now(), content, inode: newInode() };
}

export function makeLink(target: string, uid = 0, gid = 0): FsNode {
  return { type: 'link', mode: 0o777, uid, gid, mtime: Date.now(), target, inode: newInode() };
}

/** Turn any path into normalized absolute path segments. */
export function splitPath(cwd: string, path: string, home: string): string[] {
  let p = path;
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = home + p.slice(1);
  const abs = p.startsWith('/') ? p : `${cwd}/${p}`;
  const out: string[] = [];
  for (const part of abs.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

export function joinPath(parts: string[]) {
  return '/' + parts.join('/');
}

export class FsError extends Error {
  constructor(public reason: 'ENOENT' | 'ENOTDIR' | 'EACCES' | 'ELOOP' | 'EEXIST' | 'EISDIR' | 'ENOTEMPTY') {
    super(reason);
  }
}

export const errorText: Record<FsError['reason'], string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EACCES: 'Permission denied',
  ELOOP: 'Too many levels of symbolic links',
  EEXIST: 'File exists',
  EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty',
};

export type Perm = 'r' | 'w' | 'x';

export function canAccess(node: FsNode, perm: Perm, uid: number, gids: number[]): boolean {
  const bit = perm === 'r' ? 4 : perm === 'w' ? 2 : 1;
  if (uid === 0) {
    // root bypasses everything except execute on files with no x bit at all
    if (perm === 'x' && node.type === 'file') return (node.mode & 0o111) !== 0;
    return true;
  }
  let bits: number;
  if (node.uid === uid) bits = (node.mode >> 6) & 7;
  else if (gids.includes(node.gid)) bits = (node.mode >> 3) & 7;
  else bits = node.mode & 7;
  return (bits & bit) !== 0;
}

export function modeString(node: FsNode): string {
  const t = node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : '-';
  const m = node.mode;
  const trip = (shift: number, special: boolean, ch: string) => {
    const r = m & (4 << shift) ? 'r' : '-';
    const w = m & (2 << shift) ? 'w' : '-';
    const xOn = (m & (1 << shift)) !== 0;
    const x = special ? (xOn ? ch : ch.toUpperCase()) : xOn ? 'x' : '-';
    return r + w + x;
  };
  return (
    t +
    trip(6, (m & 0o4000) !== 0, 's') +
    trip(3, (m & 0o2000) !== 0, 's') +
    trip(0, (m & 0o1000) !== 0, 't')
  );
}

export function cloneNode(node: FsNode): FsNode {
  const copy: FsNode = { ...node, inode: newInode(), mtime: Date.now() };
  if (node.children) {
    copy.children = {};
    for (const [k, v] of Object.entries(node.children)) copy.children[k] = cloneNode(v);
  }
  return copy;
}

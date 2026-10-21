import { COMMANDS, CommandResult } from './commands';
import {
  FsError,
  FsNode,
  canAccess,
  errorText,
  joinPath,
  makeFile,
  splitPath,
} from './fs';
import { ParseError, Pipeline, Word, parse } from './parser';
import { KERNEL_FILES } from './kernel-state';
import { SystemState, User, createInitialState } from './state';
import { STORAGE_FILES } from './storage-state';

export interface Resolved {
  node: FsNode;
  parent: FsNode;
  name: string;
  parts: string[]; // canonical path segments
}

interface Session {
  user: User;
  cwd: string;
  umask?: number; // set by the umask command; otherwise the RHEL default for the user
}

export interface RunOutput {
  output: string;
  clear?: boolean;
}

export class Shell {
  state: SystemState;
  sessions: Session[];
  env: Record<string, string> = {};
  history: string[] = [];
  lastCode = 0;

  constructor(state?: SystemState) {
    this.state = state ?? createInitialState();
    const student = this.state.users.find((u) => u.name === 'student')!;
    this.sessions = [{ user: student, cwd: student.home }];
  }

  get session() {
    return this.sessions[this.sessions.length - 1];
  }
  get user() {
    return this.session.user;
  }
  get cwd() {
    return this.session.cwd;
  }
  set cwd(v: string) {
    this.session.cwd = v;
  }
  // RHEL defaults: 0022 for root, 0002 for normal users (who have their own private group)
  get umask() {
    return this.session.umask ?? (this.user.uid === 0 ? 0o022 : 0o002);
  }
  set umask(v: number) {
    this.session.umask = v;
  }
  get uid() {
    return this.user.uid;
  }
  get gids(): number[] {
    return groupIdsFor(this.state, this.user);
  }
  get shortHost() {
    return this.state.hostname.split('.')[0];
  }

  prompt(): string {
    const home = this.user.home;
    let dir = this.cwd === home ? '~' : this.cwd === '/' ? '/' : this.cwd.split('/').pop()!;
    return `[${this.user.name}@${this.shortHost} ${dir}]${this.uid === 0 ? '#' : '$'} `;
  }

  getVar = (name: string): string => {
    switch (name) {
      case '?':
        return String(this.lastCode);
      case 'HOME':
        return this.user.home;
      case 'USER':
      case 'LOGNAME':
        return this.user.name;
      case 'PWD':
        return this.cwd;
      case 'HOSTNAME':
        return this.state.hostname;
      case 'SHELL':
        return this.user.shell;
      case 'PATH':
        return this.env.PATH ?? '/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin';
      case 'UID':
        return String(this.uid);
      default:
        return this.env[name] ?? '';
    }
  };

  // ---------- file system helpers ----------

  /** Walk to a path. With follow=false the final symlink itself is returned. */
  resolve(path: string, follow = true, depth = 0): Resolved {
    if (depth > 20) throw new FsError('ELOOP');
    const parts = splitPath(this.cwd, path, this.user.home);
    let node = this.state.root;
    let parent = this.state.root;
    const walked: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (node.type !== 'dir') throw new FsError('ENOTDIR');
      if (!canAccess(node, 'x', this.uid, this.gids)) throw new FsError('EACCES');
      const child = node.children![parts[i]];
      if (!child) throw new FsError('ENOENT');
      const last = i === parts.length - 1;
      if (child.type === 'link' && (!last || follow)) {
        const base = child.target!.startsWith('/') ? child.target! : joinPath(walked) + '/' + child.target!;
        const rest = parts.slice(i + 1).join('/');
        return this.resolve(rest ? `${base}/${rest}` : base, follow, depth + 1);
      }
      parent = node;
      node = child;
      walked.push(parts[i]);
    }
    return { node, parent, name: parts[parts.length - 1] ?? '/', parts: walked };
  }

  exists(path: string, follow = true): boolean {
    try {
      this.resolve(path, follow);
      return true;
    } catch {
      return false;
    }
  }

  /** Find the parent dir for creating/removing an entry, checking w+x on it. */
  parentFor(path: string): { dir: FsNode; name: string; dirPath: string } {
    const parts = splitPath(this.cwd, path, this.user.home);
    if (!parts.length) throw new FsError('EEXIST');
    const name = parts.pop()!;
    const dirRes = this.resolve(joinPath(parts));
    if (dirRes.node.type !== 'dir') throw new FsError('ENOTDIR');
    if (!canAccess(dirRes.node, 'w', this.uid, this.gids) || !canAccess(dirRes.node, 'x', this.uid, this.gids)) {
      throw new FsError('EACCES');
    }
    return { dir: dirRes.node, name, dirPath: joinPath(dirRes.parts) };
  }

  readFile(path: string): string {
    const r = this.resolve(path);
    if (r.node.type === 'dir') throw new FsError('EISDIR');
    if (!canAccess(r.node, 'r', this.uid, this.gids)) throw new FsError('EACCES');
    const p = joinPath(r.parts);
    const dynamic = dynamicFile(this.state, p);
    return dynamic ?? r.node.content ?? '';
  }

  writeFile(path: string, content: string, append = false): void {
    let r: Resolved | null = null;
    try {
      r = this.resolve(path);
    } catch (e) {
      if (!(e instanceof FsError) || e.reason !== 'ENOENT') throw e;
    }
    if (r) {
      if (r.node.type === 'dir') throw new FsError('EISDIR');
      if (!canAccess(r.node, 'w', this.uid, this.gids)) throw new FsError('EACCES');
      r.node.content = append ? (r.node.content ?? '') + content : content;
      r.node.mtime = Date.now();
      syncDynamicFile(this.state, '/' + r.parts.join('/'), r.node.content);
      return;
    }
    const { dir, name } = this.parentFor(path);
    dir.children![name] = makeFile(content, this.uid, this.user.gid, 0o666 & ~this.umask);
  }

  // ---------- execution ----------

  expandGlob(word: Word): string[] {
    if (!word.glob) return [word.text];
    const slash = word.text.lastIndexOf('/');
    const dirPart = slash >= 0 ? word.text.slice(0, slash + 1) : '';
    const pattern = word.text.slice(slash + 1);
    const re = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
    try {
      const dir = this.resolve(dirPart || '.');
      if (dir.node.type !== 'dir') return [word.text];
      const matches = Object.keys(dir.node.children!)
        .filter((n) => re.test(n) && (pattern.startsWith('.') || !n.startsWith('.')))
        .sort()
        .map((n) => dirPart + n);
      return matches.length ? matches : [word.text];
    } catch {
      return [word.text];
    }
  }

  run(line: string): RunOutput {
    const trimmed = line.trim();
    if (!trimmed) return { output: '' };
    this.history.push(trimmed);
    let pipelines: Pipeline[];
    try {
      pipelines = parse(trimmed, this.getVar);
    } catch (e) {
      this.lastCode = 2;
      return { output: `-bash: ${(e as ParseError).message}\n` };
    }
    let out = '';
    let clear = false;
    for (const pl of pipelines) {
      if (pl.op === '&&' && this.lastCode !== 0) continue;
      if (pl.op === '||' && this.lastCode === 0) continue;
      const r = this.runPipeline(pl);
      if (r.clear) {
        clear = true;
        out = '';
      }
      out += r.output;
    }
    return { output: out, clear };
  }

  private runPipeline(pl: Pipeline): RunOutput & { code: number } {
    let stdin = '';
    let screen = '';
    let code = 0;
    let clear = false;
    pl.commands.forEach((cmd, idx) => {
      const isLast = idx === pl.commands.length - 1;
      const argv = cmd.words.flatMap((w) => this.expandGlob(w));
      let input = stdin;
      for (const r of cmd.redirects) {
        if (r.op === '<') {
          try {
            input = this.readFile(r.target);
          } catch (e) {
            screen += `-bash: ${r.target}: ${errorText[(e as FsError).reason] ?? e}\n`;
            code = 1;
            return;
          }
        }
      }
      const res = this.exec(argv, input);
      if (res.clear) clear = true;
      code = res.code;
      let stdout = res.stdout;
      let stderr = res.stderr;
      for (const r of cmd.redirects) {
        if (r.op === '<') continue;
        if (r.op === '>&1') {
          stdout += stderr;
          stderr = '';
          continue;
        }
        const data = r.fd === 2 ? stderr : r.fd === 'both' ? stdout + stderr : stdout;
        if (r.fd === 2) stderr = '';
        else if (r.fd === 'both') {
          stdout = '';
          stderr = '';
        } else stdout = '';
        if (r.target === '/dev/null') continue;
        try {
          this.writeFile(r.target, data, r.op === '>>');
        } catch (e) {
          screen += `-bash: ${r.target}: ${errorText[(e as FsError).reason] ?? e}\n`;
          code = 1;
        }
      }
      screen += stderr;
      if (isLast) screen += stdout;
      else stdin = stdout;
    });
    this.lastCode = code;
    return { output: screen, code, clear };
  }

  /** Run one command with already-expanded argv. */
  exec(argv: string[], stdin = ''): CommandResult {
    if (!argv.length) return { stdout: '', stderr: '', code: 0 };
    // VAR=value assignment
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[0]);
    if (assign && argv.length === 1) {
      this.env[assign[1]] = assign[2];
      return { stdout: '', stderr: '', code: 0 };
    }
    let name = argv[0];
    if (name.includes('/')) name = name.split('/').pop()!;
    const fn = COMMANDS[name];
    if (!fn) {
      return { stdout: '', stderr: `bash: ${argv[0]}: command not found\n`, code: 127 };
    }
    try {
      return fn({ sh: this, args: argv.slice(1), stdin, name });
    } catch (e) {
      if (e instanceof FsError) {
        return { stdout: '', stderr: `${name}: ${errorText[e.reason]}\n`, code: 1 };
      }
      return { stdout: '', stderr: `${name}: ${(e as Error).message}\n`, code: 1 };
    }
  }

  /** Run something as another user (used by sudo). */
  asUser<T>(user: User, fn: () => T): T {
    this.sessions.push({ user, cwd: this.cwd });
    try {
      return fn();
    } finally {
      const s = this.sessions.pop()!;
      this.cwd = s.cwd;
    }
  }
}

export function groupIdsFor(state: SystemState, user: User): number[] {
  const ids = [user.gid];
  for (const g of state.groups) if (g.members.includes(user.name)) ids.push(g.gid);
  return ids;
}

/** Edits to generated files that map to simple settings update the system state. */
function syncDynamicFile(state: SystemState, path: string, content: string) {
  if (path === '/etc/hostname') {
    const name = content.trim().split('\n')[0];
    if (name) state.hostname = name;
  }
  if (path === '/etc/selinux/config') {
    const mode = /^SELINUX=(enforcing|permissive|disabled)\s*$/m.exec(content)?.[1];
    if (mode) state.selinuxConfigMode = mode as SystemState['selinuxConfigMode'];
  }
}

function dynamicFile(state: SystemState, path: string): string | null {
  switch (path) {
    case '/etc/passwd':
      return state.users.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.comment}:${u.home}:${u.shell}`).join('\n') + '\n';
    case '/etc/group':
      return state.groups.map((g) => `${g.name}:x:${g.gid}:${g.members.join(',')}`).join('\n') + '\n';
    case '/etc/shadow':
      return (
        state.users
          .map((u) => {
            const pw = u.password ? (u.locked ? '!' : '') + u.password : '!!';
            return `${u.name}:${pw}:20380:${u.minDays}:${u.maxDays}:${u.warnDays}:::`;
          })
          .join('\n') + '\n'
      );
    case '/etc/hostname':
      return state.hostname + '\n';
    case '/etc/selinux/config':
      return `SELINUX=${state.selinuxConfigMode}\nSELINUXTYPE=targeted\n`;
    default:
      return (STORAGE_FILES[path] ?? KERNEL_FILES[path])?.(state) ?? null;
  }
}

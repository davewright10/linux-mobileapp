import { COMMANDS, CommandContext, CommandResult } from './commands';
import { binaryTest, unaryTest } from './commands-script';
import {
  FsError,
  FsNode,
  canAccess,
  errorText,
  joinPath,
  makeFile,
  splitPath,
} from './fs';
import {
  AndOr,
  ArithError,
  ArithVars,
  Command,
  CompleteCommand,
  CondItem,
  Incomplete,
  List,
  ParseError,
  ParseResult,
  Pipeline,
  Redirect,
  SimpleCommand,
  Word,
  WordNode,
  WordPart,
  evalArith,
  isName,
  parseHereDoc,
  parseProgram,
  parseWordText,
  splitAssign,
} from './parser';
import { KERNEL_FILES } from './kernel-state';
import { DEFAULT_ALIASES, SystemState, User, createInitialState, runningHostname } from './state';
import { STORAGE_FILES } from './storage-state';

type FuncDef = Extract<Command, { type: 'func' }>;

/** The practice command with this name; own keys only, so "toString" is not a command. */
function commandFor(name: string): ((ctx: CommandContext) => CommandResult) | undefined {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined;
}

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

/** Options for running a script file or a -c string (bash -x, -e, -u, -n). */
export interface ScriptOptions {
  xtrace?: boolean;
  errexit?: boolean;
  nounset?: boolean;
  noexec?: boolean; // only check the syntax
}

// Limits that keep a runaway script from freezing the phone.
const MAX_LOOP = 10000; // iterations of one loop
const MAX_ITERATIONS = 100000; // iterations of all loops in one command line
const MAX_STEPS = 200000; // simple commands in one command line
const MAX_WORDS = 100000; // words from one brace expansion
const MAX_FUNC_DEPTH = 100; // like FUNCNEST=100
const MAX_SCRIPT_DEPTH = 40; // scripts and $( ) inside each other
const MAX_SINK = 1_000_000; // characters one stream keeps
const MAX_SCREEN = 50_000; // characters one command line shows on the phone

/** Standard input of a command: read takes one line at a time, other commands take all of it. */
export class InputStream {
  pos = 0;
  constructor(
    public data: string,
    public tty = false, // the terminal: there is nothing to read, and nothing can be typed ahead
  ) {}
  get rest(): string {
    return this.pos ? this.data.slice(this.pos) : this.data;
  }
  /** The next line without its newline, or null at the end. `eol` is false for a last line without newline. */
  readLine(): { text: string; eol: boolean } | null {
    if (this.pos >= this.data.length) return null;
    const nl = this.data.indexOf('\n', this.pos);
    const end = nl < 0 ? this.data.length : nl;
    const text = this.data.slice(this.pos, end);
    this.pos = nl < 0 ? end : nl + 1;
    return { text, eol: nl >= 0 };
  }
  readAll(): string {
    const r = this.rest;
    this.pos = this.data.length;
    return r;
  }
}

type Chunk = [1 | 2, string];

/** Collects what a command writes to stdout or stderr. A shared log keeps both in order. */
class Sink {
  text = '';
  cleared = false;
  tty = false; // the terminal screen: ls prints columns there, one name per line elsewhere
  constructor(
    private log?: Chunk[],
    private fd: 1 | 2 = 1,
  ) {}
  write(s: string) {
    if (this.text.length + s.length > MAX_SINK) s = s.slice(0, Math.max(0, MAX_SINK - this.text.length));
    if (!s) return;
    this.text += s;
    this.log?.push([this.fd, s]);
  }
  clear() {
    this.text = '';
    this.cleared = true;
    if (this.log) this.log.length = 0;
  }
}

interface IO {
  in: InputStream;
  out: Sink;
  err: Sink;
}

interface Frame {
  kind: 'top' | 'script' | 'source' | 'func';
  name0: string; // $0
  args: string[]; // $1 ... (a sourced file without arguments shares its caller's array)
  file?: string; // shown in error messages: "./x.sh: line 3: ..."
  locals?: Map<string, string | undefined>; // a function's local variables: their outer values
  pid: number;
  trap?: string; // trap '...' EXIT
}

interface Opts {
  errexit: boolean;
  nounset: boolean;
  xtrace: boolean;
  pipefail: boolean;
  noglob: boolean;
}
const DEFAULT_OPTS: Opts = { errexit: false, nounset: false, xtrace: false, pipefail: false, noglob: false };
const SHORT_OPTS: Record<string, keyof Opts | null> = { e: 'errexit', u: 'nounset', x: 'xtrace', f: 'noglob', v: null, h: null, B: null, m: null, b: null, C: null, H: null, P: null, T: null, E: null, a: null, k: null, n: null, p: null, t: null };
const LONG_OPTS: Record<string, keyof Opts | null> = { errexit: 'errexit', nounset: 'nounset', xtrace: 'xtrace', pipefail: 'pipefail', noglob: 'noglob', verbose: null, vi: null, emacs: null, noclobber: null, allexport: null, braceexpand: null, hashall: null, histexpand: null, history: null, monitor: null, posix: null };

// Control flow travels as exceptions. They are not Errors, so no command turns them into messages.
class Signal {}
class LoopSignal extends Signal {
  constructor(
    public n: number,
    public cont: boolean,
  ) {
    super();
  }
}
class ReturnSignal extends Signal {
  constructor(public code: number) {
    super();
  }
}
class ExitSignal extends Signal {
  constructor(public code: number) {
    super();
  }
}
class AbortSignal extends Signal {}
/** A failed expansion (bad substitution, unbound variable, arithmetic error): the command line stops. */
class ExpansionError extends Signal {
  constructor(
    public message: string,
    public fatal = false, // a script exits (${x:?}, set -u)
  ) {
    super();
  }
}

const DECL_BUILTINS = new Set(['export', 'local', 'declare', 'typeset', 'readonly']);
const SHELL_BUILTINS = new Set(['alias', 'unalias', 'break', 'continue', 'return', 'exit', 'shift', 'local', 'declare', 'typeset', 'readonly', 'unset', 'set', 'eval', 'command', 'trap', 'wait', 'getopts']);
// Bash builtins that are practice commands in commands.ts or commands-script.ts (for type and command -v).
const COMMAND_BUILTINS = new Set(['cd', 'echo', 'pwd', 'read', 'printf', 'source', '.', 'test', '[', 'export', 'let', 'true', 'false', ':', 'umask', 'type', 'history', 'alias', 'unalias', 'kill', 'jobs', 'fg', 'bg', 'help', 'hash', 'ulimit', 'logout', 'pushd', 'popd', 'dirs', 'shopt', 'exec', 'times', 'disown', 'suspend', 'builtin', 'enable', 'mapfile', 'readarray', 'fc', 'bind', 'compgen', 'complete', 'caller']);
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'time', '{', '}', '!', '[[', ']]']);
const SHELL_PATHS = new Set(['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh']);
// Commands that read all of the stdin they inherit when given no file (cat inside "while read" eats the rest).
const STDIN_READERS = new Set(['cat', 'sort', 'uniq', 'wc', 'tac', 'tr', 'tee', 'xargs']);

/**
 * grep -q (print nothing, only the exit status, as in "if grep -q anna /etc/passwd") and -s (no
 * errors about missing files): take the letters out for the practice grep and drop its output.
 */
function grepQuiet(args: string[]): { args: string[]; quiet: boolean; silent: boolean } {
  let quiet = false;
  let silent = false;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i));
      break;
    }
    if (a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '--no-messages') silent = true;
    else if (/^-[A-Za-z]+$/.test(a) && /[qs]/.test(a) && !/e./.test(a)) {
      quiet ||= a.includes('q');
      silent ||= a.includes('s');
      if (a.replace(/[qs]/g, '') !== '-') out.push(a.replace(/[qs]/g, ''));
    } else {
      out.push(a);
      if (a === '-e' || a === '-f') out.push(...args.slice(i + 1, ++i + 1));
    }
  }
  return { args: out, quiet, silent };
}

export class Shell {
  state: SystemState;
  sessions: Session[];
  env: Record<string, string> = {};
  history: string[] = [];
  lastCode = 0;
  /** Shell functions by name. */
  functions = new Map<string, FuncDef>();
  aliases = new Map<string, string>(DEFAULT_ALIASES);
  private aliasBusy = new Set<string>(); // an alias is not expanded again inside its own value

  private frames: Frame[] = [{ kind: 'top', name0: '-bash', args: [], pid: 1602 }];
  private opts: Opts = { ...DEFAULT_OPTS };
  private shellOnly = new Set<string>(); // variables created in the shell and not exported
  private exportAttr = new Set<string>();
  private readonlyVars = new Set<string>();
  private pending: { text: string; hist: string; reason: Incomplete; last: string } | null = null;
  private cur: IO | null = null; // streams of the command now running
  private curStdin = '';
  private loopDepth = 0;
  private funcDepth = 0;
  private scriptDepth = 0;
  private subshells = 0;
  private nestedShells = new WeakSet<Session>();
  private rematch: string[] = []; // BASH_REMATCH after [[ s =~ re ]]
  private traceLevel = 0; // set -x prints one more + per command substitution or eval
  private condDepth = 0; // inside an if/while test or before && ||: set -e does not apply
  private lineno = 0;
  private steps = 0;
  private iterations = 0;
  private runDepth = 0;
  private abortMsg: string | null = null; // set: stop the whole command line ('' after a reboot: silently)
  private lastSubst: number | null = null;
  private lastBg = '';
  private nextPid = 3100;
  private notes = new Set<string>();
  private optState = { ind: 1, pos: 1 }; // getopts position inside grouped flags like -ab
  private started = Date.now();
  private chunks = new WeakMap<CommandResult, Chunk[]>();

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
    return runningHostname(this.state).split('.')[0];
  }
  private get frame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  /** "bash" typed at the prompt: a new interactive shell that "exit" leaves again. */
  startNestedShell(): void {
    const s: Session = { user: this.user, cwd: this.cwd, umask: this.session.umask };
    this.nestedShells.add(s);
    this.sessions.push(s);
  }

  /** The prompt to show: PS1, or "> " while a multi-line command (if, for, quote, here-document) is unfinished. */
  prompt(): string {
    if (this.pending) return '> ';
    const home = this.user.home;
    let dir = this.cwd === home ? '~' : this.cwd === '/' ? '/' : this.cwd.split('/').pop()!;
    return `[${this.user.name}@${this.shortHost} ${dir}]${this.uid === 0 ? '#' : '$'} `;
  }

  /** True while typed lines are being collected for an unfinished command. */
  get continuing(): boolean {
    return this.pending !== null;
  }

  /** Ctrl+C at the prompt: throw away an unfinished multi-line command. $? becomes 130, as in bash. */
  cancelInput(): string {
    const had = this.pending !== null;
    this.pending = null;
    this.lastCode = 130;
    return had ? '^C\n' : '';
  }

  getVar = (name: string): string => {
    if (/^[0-9]+$/.test(name)) {
      const n = Number(name);
      return n === 0 ? this.frame.name0 : (this.frame.args[n - 1] ?? '');
    }
    switch (name) {
      case '?':
        return String(this.lastCode);
      case '#':
        return String(this.frame.args.length);
      case '@':
      case '*':
        return this.frame.args.join(' ');
      case '$':
      case 'BASHPID':
        return String([...this.frames].reverse().find((f) => f.kind === 'script' || f.kind === 'top')!.pid);
      case 'BASH_REMATCH':
        return this.rematch[0] ?? '';
      case '!':
        return this.lastBg;
      case '-':
        return this.flags();
      case 'HOME':
        return this.user.home;
      case 'USER':
      case 'LOGNAME':
        return this.user.name;
      case 'PWD':
        return this.cwd;
      case 'HOSTNAME':
        return runningHostname(this.state);
      case 'SHELL':
        return this.user.shell;
      case 'PATH': {
        if (this.env.PATH !== undefined) return this.env.PATH;
        const h = this.user.home;
        return this.uid === 0 ? `${h}/.local/bin:${h}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` : `${h}/.local/bin:${h}/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin`;
      }
      case 'UID':
      case 'EUID':
        return String(this.uid);
      case 'RANDOM':
        return String(Math.floor(Math.random() * 32768));
      case 'LINENO':
        return String(this.lineno);
      case 'SECONDS':
        return String(Math.floor((Date.now() - this.started) / 1000));
      case 'BASH_VERSION':
        return '5.2.26(1)-release';
      case 'BASH':
        return '/usr/bin/bash';
      case 'PPID':
        return '1601';
      case 'IFS':
        return this.env.IFS ?? ' \t\n';
      default:
        return this.env[name] ?? '';
    }
  };

  /** True if a variable or parameter is set (for ${x-default}, set -u and [[ -v x ]]). */
  isVarSet(name: string): boolean {
    if (/^[0-9]+$/.test(name)) return Number(name) <= this.frame.args.length;
    if (name.length === 1 && '?#@*$-'.includes(name)) return true;
    if (name === '!') return this.lastBg !== '';
    if (name === 'BASH_REMATCH') return this.rematch.length > 0;
    if (name in this.env) return true;
    return ['HOME', 'USER', 'LOGNAME', 'PWD', 'HOSTNAME', 'SHELL', 'PATH', 'UID', 'EUID', 'BASHPID', 'RANDOM', 'LINENO', 'SECONDS', 'BASH_VERSION', 'BASH', 'PPID', 'IFS'].includes(name);
  }

  /** Assign a variable as a script would. Returns false (and changes nothing) for a readonly variable. */
  setVar(name: string, value: string): boolean {
    if (this.readonlyVars.has(name)) return false;
    if (!(name in this.env) && !this.exportAttr.has(name)) this.shellOnly.add(name);
    this.env[name] = value;
    return true;
  }

  /** export NAME (on) or export -n NAME (off). Child scripts only see exported variables. */
  markExported(name: string, on = true) {
    if (on) {
      this.exportAttr.add(name);
      this.shellOnly.delete(name);
    } else {
      this.exportAttr.delete(name);
      if (name in this.env) this.shellOnly.add(name);
    }
  }

  isExported(name: string): boolean {
    return name in this.env && !this.shellOnly.has(name);
  }

  isReadonly(name: string): boolean {
    return this.readonlyVars.has(name);
  }

  /** Is a set -o option on (for [[ -o name ]])? */
  optionOn(name: string): boolean {
    const key = LONG_OPTS[name];
    return !!key && this.opts[key];
  }

  /** Evaluate an arithmetic expression (let, expr-like use). Throws ArithError with bash's message. */
  arith(expr: string): number {
    try {
      return evalArith(expr, this.arithVars);
    } catch (e) {
      if (e instanceof ExpansionError) throw new ArithError(e.message);
      throw e;
    }
  }

  /** True the first time in one command line; used to show a practice hint only once. */
  noteOnce(key: string): boolean {
    if (this.notes.has(key)) return false;
    this.notes.add(key);
    return true;
  }

  /** True while a script file or a bash -c string runs (functions and sourced files run in the shell itself). */
  get inScript(): boolean {
    return this.frames.some((f) => f.kind === 'script');
  }

  /** The stdin of the command now running, so read can take one line and leave the rest for the next read. */
  stdinStream(stdin: string): InputStream {
    if (this.cur && this.curStdin === stdin) return this.cur.in;
    return new InputStream(stdin);
  }

  private flags(): string {
    const o = this.opts;
    return (this.inScript ? 'hB' : 'himBHs') + (o.errexit ? 'e' : '') + (o.nounset ? 'u' : '') + (o.xtrace ? 'x' : '') + (o.noglob ? 'f' : '');
  }

  private arithVars: ArithVars = {
    get: (n) => this.getVar(n),
    set: (n, v) => {
      if (!this.setVar(n, String(v))) throw new ExpansionError(`${n}: readonly variable`);
    },
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

  // ---------- expansion ----------

  /** Expand a glob pattern against the file system; without matches the word stays as it is. */
  expandGlob(word: Word): string[] {
    if (!word.glob) return [word.text];
    const pattern = word.pattern ?? word.text;
    const dirsOnly = pattern.endsWith('/');
    const segs = pattern.split('/').filter((s) => s !== '');
    let paths = [pattern.startsWith('/') ? '/' : ''];
    const join = (base: string, n: string) => (base === '' ? n : base === '/' ? `/${n}` : `${base}/${n}`);
    const isDir = (p: string) => {
      try {
        return this.resolve(p).node.type === 'dir';
      } catch {
        return false;
      }
    };
    segs.forEach((seg, k) => {
      const last = k === segs.length - 1;
      const next: string[] = [];
      for (const base of paths) {
        if (!hasGlob(seg)) {
          const p = join(base, seg.replace(/\\(.)/g, '$1'));
          if (last && !dirsOnly ? this.exists(p, false) : isDir(p)) next.push(p);
          continue;
        }
        let re: RegExp;
        try {
          re = globRegex(seg);
        } catch {
          continue;
        }
        let dir: FsNode;
        try {
          dir = this.resolve(base || '.').node;
        } catch {
          continue;
        }
        if (dir.type !== 'dir' || !canAccess(dir, 'r', this.uid, this.gids)) continue;
        const dot = seg.startsWith('.') || seg.startsWith('\\.');
        for (const n of Object.keys(dir.children!).sort()) {
          if (!re.test(n) || (!dot && n.startsWith('.'))) continue;
          const p = join(base, n);
          if ((!last || dirsOnly) && !isDir(p)) continue;
          next.push(p);
        }
      }
      paths = next;
    });
    if (!paths.length || paths[0] === '' || paths[0] === '/') return [word.text];
    return paths.map((p) => (dirsOnly ? p + '/' : p));
  }

  /** Expand one word into fields: braces, parameters, $( ), $(( )), word splitting and globbing. */
  private expandWord(w: WordNode, io: IO): string[] {
    const out: string[] = [];
    for (const parts of this.braces(w.parts)) {
      for (const f of this.fields(parts, io, true)) {
        const text = f.map((s) => s.text).join('');
        const glob = !this.opts.noglob && f.some((s) => !s.quoted && /[*?[]/.test(s.text));
        if (!glob) out.push(text);
        else out.push(...this.expandGlob({ text, glob, pattern: f.map((s) => (s.quoted ? escapeGlob(s.text) : s.text)).join('') }));
      }
    }
    return out;
  }

  private expandArgs(words: WordNode[], io: IO): string[] {
    const decl = words.length > 1 && DECL_BUILTINS.has(words[0].raw);
    const out: string[] = [];
    words.forEach((w, k) => {
      const a = decl && k > 0 ? splitAssign(w) : null;
      if (a) out.push(`${a.name}${a.append ? '+=' : '='}${this.expandValue(a.value, io)}`);
      else out.push(...this.expandWord(w, io));
    });
    return out;
  }

  /** Expand without word splitting or globbing (assignments, case words, [[ ]], here-strings). */
  private expandValue(parts: WordPart[], io: IO): string {
    return this.segments(parts, io)
      .map((s) => s.text)
      .join('');
  }

  /** One word without splitting (assignments, here-documents, [[ ]], case): the words of "$@" are joined with spaces. */
  private segments(parts: WordPart[], io: IO): Seg[] {
    const out: Seg[] = [];
    this.fields(parts, io, false).forEach((f, i) => {
      if (i > 0) out.push({ text: ' ', quoted: true });
      out.push(...f);
    });
    return out;
  }

  /** Expand to a glob pattern in which quoted characters are escaped (case, [[ == ]], ${x#pattern}). */
  private expandPattern(parts: WordPart[], io: IO): string {
    return this.segments(parts, io)
      .map((s) => (s.quoted ? escapeGlob(s.text) : s.text))
      .join('');
  }

  private expandText(src: string, io: IO): string {
    let parts: WordPart[];
    try {
      parts = parseWordText(src);
    } catch (e) {
      if (e instanceof ParseError) throw new ExpansionError(`${src}: bad substitution`);
      throw e;
    }
    return this.expandValue(parts, io);
  }

  private fields(parts: WordPart[], io: IO, split: boolean): Seg[][] {
    const out: Seg[][] = [];
    let cur: Seg[] | null = null;
    const add = (text: string, quoted: boolean, force = false) => {
      if (!cur) {
        if (!text && !force) return;
        cur = [];
        out.push(cur);
      }
      cur.push({ text, quoted });
    };
    const brk = () => {
      cur = null;
    };
    const addSplit = (value: string) => {
      if (!split) return add(value, false);
      const r = splitIFS(value, this.getVar('IFS'));
      if (r.lead) brk();
      r.fields.forEach((f, i) => {
        if (i > 0) brk();
        add(f, false, true);
      });
      if (r.trail) brk();
    };
    parts.forEach((p, idx) => {
      if (p.type === 'lit') {
        let text = p.text;
        if (idx === 0 && !p.quoted && text.startsWith('~')) {
          const t = this.tilde(text);
          if (t) {
            add(t.home, true, true);
            text = t.rest;
          }
        }
        add(text, p.quoted, p.quoted);
        return;
      }
      if (p.type === 'param' && (p.name === '@' || p.name === '*') && (p.op === '' || p.op === ':')) {
        const list = p.op === ':' ? this.sliceArgs(p.arg, io) : this.frame.args;
        if (p.quoted && p.name === '@') {
          list.forEach((v, i) => {
            if (i > 0) brk();
            add(v, true, true);
          });
        } else if (p.quoted) add(list.join(this.getVar('IFS').slice(0, 1)), true, true);
        else
          list.forEach((v, i) => {
            if (i > 0) brk();
            addSplit(v);
          });
        return;
      }
      const v = p.type === 'param' ? this.paramValue(p, io) : p.type === 'cmd' ? this.commandSubst(p.body, io) : this.arithExpand(p.src, io);
      if (p.quoted) add(v, true, true);
      else addSplit(v);
    });
    return out;
  }

  private tilde(text: string): { home: string; rest: string } | null {
    const slash = text.indexOf('/');
    const name = text.slice(1, slash < 0 ? text.length : slash);
    const rest = slash < 0 ? '' : text.slice(slash);
    let home: string | undefined;
    if (name === '') home = this.getVar('HOME');
    else if (name === '+') home = this.cwd;
    else if (name === '-') home = this.env.OLDPWD;
    else home = this.state.users.find((u) => u.name === name)?.home;
    return home === undefined ? null : { home, rest };
  }

  private braces(parts: WordPart[]): WordPart[][] {
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (p.type !== 'lit' || p.quoted || !p.text.includes('{')) continue;
      const b = findBrace(p.text);
      if (!b) continue;
      const res: WordPart[][] = [];
      for (const alt of b.alts) {
        const text = p.text.slice(0, b.start) + alt + p.text.slice(b.end + 1);
        res.push(...this.braces([...parts.slice(0, k), { type: 'lit', text, quoted: false }, ...parts.slice(k + 1)]));
        if (res.length > MAX_WORDS) throw new ExpansionError(`brace expansion: more than ${MAX_WORDS} words (practice terminal limit)`);
      }
      return res;
    }
    return [parts];
  }

  private sliceArgs(arg: string, io: IO): string[] {
    const all = [this.frame.name0, ...this.frame.args];
    const [offText, lenText] = splitOnce(arg, ':');
    let off = this.arithEval(this.expandText(offText, io));
    if (off < 0) off = Math.max(0, all.length + off);
    const len = lenText === undefined ? all.length : this.arithEval(this.expandText(lenText, io));
    return all.slice(off, len < 0 ? all.length + len : off + len);
  }

  private paramValue(p: Extract<WordPart, { type: 'param' }>, io: IO): string {
    const { name, op } = p;
    if (op === 'bad') throw new ExpansionError(`\${${name}}: bad substitution`);
    if (op === 'idx') {
      // No arrays here: BASH_REMATCH[n] and a plain variable as element 0, like bash
      const all = name === 'BASH_REMATCH' ? this.rematch : this.isVarSet(name) ? [this.getVar(name)] : [];
      if (p.arg === '@' || p.arg === '*') return all.join(' ');
      return all[this.arithEval(this.expandText(p.arg, io))] ?? '';
    }
    if (op === 'len') return String(name === '@' || name === '*' ? this.frame.args.length : [...this.getVar(name)].length);
    if (op === 'ind') {
      const ref = this.getVar(name);
      if (!/^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])$/.test(ref)) throw new ExpansionError(`${ref || `!${name}`}: invalid indirect expansion`);
      return this.getVar(ref);
    }
    const set = this.isVarSet(name);
    const val = set ? this.getVar(name) : '';
    const empty = !set || (op.length === 2 && op[0] === ':' && val === '');
    const arg = () => this.argText(p.arg, io);
    switch (op) {
      case '':
        if (!set && this.opts.nounset) throw new ExpansionError(`${name}: unbound variable`, true);
        return val;
      case '-':
      case ':-':
        return empty ? arg() : val;
      case '=':
      case ':=': {
        if (!empty) return val;
        if (!isName(name)) throw new ExpansionError(`$${name}: cannot assign in this way`);
        const v = arg();
        if (!this.setVar(name, v)) throw new ExpansionError(`${name}: readonly variable`);
        return v;
      }
      case '+':
      case ':+':
        return empty ? '' : arg();
      case '?':
      case ':?':
        if (empty) throw new ExpansionError(`${name}: ${p.arg ? arg() : 'parameter null or not set'}`, true);
        return val;
    }
    if (!set && this.opts.nounset) throw new ExpansionError(`${name}: unbound variable`, true);
    switch (op) {
      case '#':
      case '##':
        return removeAffix(val, this.argPattern(p.arg, io), true, op === '##');
      case '%':
      case '%%':
        return removeAffix(val, this.argPattern(p.arg, io), false, op === '%%');
      case '/':
      case '//':
      case '/#':
      case '/%': {
        const [pat, rep] = splitOnce(p.arg, '/');
        return replacePattern(val, this.argPattern(pat, io), rep === undefined ? '' : this.argText(rep, io), op);
      }
      case '^':
        return val.slice(0, 1).toUpperCase() + val.slice(1);
      case '^^':
        return val.toUpperCase();
      case ',':
        return val.slice(0, 1).toLowerCase() + val.slice(1);
      case ',,':
        return val.toLowerCase();
      default: {
        // ${x:offset} and ${x:offset:length}
        const chars = [...val];
        const [offText, lenText] = splitOnce(p.arg, ':');
        let off = this.arithEval(this.expandText(offText, io));
        if (off < 0) off = Math.max(0, chars.length + off);
        if (lenText === undefined) return chars.slice(off).join('');
        const len = this.arithEval(this.expandText(lenText, io));
        if (len < 0 && chars.length + len < off) throw new ExpansionError(`${lenText.trim()}: substring expression < 0`);
        return chars.slice(off, len < 0 ? chars.length + len : off + len).join('');
      }
    }
  }

  private hereDocParts(body: string): WordPart[] {
    try {
      return parseHereDoc(body);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      if (e.message.includes('``')) throw new ExpansionError(`bad substitution: no closing "\`" in ${body.slice(body.indexOf('`')).replace(/\n$/, '')}`);
      throw new ExpansionError(`here-document: ${e.message}`);
    }
  }

  private argParts(arg: string): WordPart[] {
    try {
      return parseWordText(arg);
    } catch (e) {
      if (e instanceof ParseError) throw new ExpansionError(`${arg}: bad substitution`);
      throw e;
    }
  }
  private argText(arg: string, io: IO): string {
    return this.expandValue(this.argParts(arg), io);
  }
  private argPattern(arg: string, io: IO): string {
    return this.expandPattern(this.argParts(arg), io);
  }

  private commandSubst(body: CompleteCommand[], io: IO): string {
    if (this.scriptDepth >= MAX_SCRIPT_DEPTH) throw new ExpansionError(`command substitution: nested too deeply (practice terminal limit is ${MAX_SCRIPT_DEPTH})`);
    const out = new Sink();
    const sub: IO = { in: io.in, out, err: io.err };
    this.scriptDepth++;
    this.traceLevel++;
    try {
      this.lastSubst = this.subshell(() => this.runCommands({ commands: body, error: null }, '', sub, null));
    } finally {
      this.scriptDepth--;
      this.traceLevel--;
    }
    return out.text.replace(/\n+$/, '');
  }

  private arithExpand(src: string, io: IO): string {
    return String(this.arithEval(this.expandText(src, io)));
  }

  private arithEval(text: string, label = ''): number {
    try {
      return evalArith(text, this.arithVars);
    } catch (e) {
      if (e instanceof ArithError) throw new ExpansionError(label + e.message);
      throw e;
    }
  }

  // ---------- running command lines ----------

  /**
   * Run one typed line. An unfinished command (open if/for/while/case, quote, here-document, or a
   * trailing |, && or \) is kept and joined with the next lines; meanwhile the output is empty and
   * prompt() returns "> ". Text with newlines is run line by line, as if typed.
   * History keeps one entry per complete command, joined the way bash does ("for i in 1 2; do echo $i; done").
   */
  run(line: string): RunOutput {
    if (!line.includes('\n')) return this.runLine(line);
    let output = '';
    let clear = false;
    for (const l of line.split('\n')) {
      const r = this.runLine(l);
      if (r.clear) {
        clear = true;
        output = '';
      }
      output += r.output;
    }
    return { output, clear };
  }

  /** Never throws: a bug in the simulation must not crash the app, so it is reported like a shell error. */
  private runLine(raw: string): RunOutput {
    try {
      return this.runLineUnguarded(raw);
    } catch (e) {
      this.pending = null;
      this.lastCode = e instanceof RangeError ? 2 : 1;
      const msg =
        e instanceof RangeError
          ? 'too many nested commands or brackets (practice terminal limit)'
          : `the practice terminal could not run this command (${e instanceof Error ? e.message : String(e)})`;
      return { output: `-bash: ${msg}\n`, clear: false };
    }
  }

  private runLineUnguarded(raw: string): RunOutput {
    const line = raw.replace(/\r$/, '');
    const p = this.pending;
    if (!p && !line.trim()) return { output: '', clear: false };
    const text = p ? `${p.text}\n${line}` : line;
    const hist = p ? joinHistory(p, line) : line.trim();
    const prog = parseProgram(text);
    if (prog.error?.incomplete) {
      this.pending = { text, hist, reason: prog.error.incomplete, last: line };
      return { output: '', clear: false };
    }
    this.pending = null;
    if (hist.trim()) this.history.push(hist.trim());
    const screen = new Sink();
    screen.tty = true;
    this.top(screen, () => this.runCommands(prog, text, { in: new InputStream('', true), out: screen, err: screen }, null));
    return { output: screenText(screen.text), clear: screen.cleared };
  }

  /** Run at the outermost level: reset the runaway guards and report a stop. */
  private top(screen: Sink, fn: () => number) {
    const outer = this.runDepth === 0;
    if (outer) {
      this.steps = 0;
      this.iterations = 0;
      this.abortMsg = null;
      this.notes.clear();
    }
    this.runDepth++;
    try {
      fn();
    } catch (e) {
      if (e instanceof ExitSignal) this.lastCode = e.code;
      else if (e instanceof AbortSignal) {
        screen.write(this.abortMsg ?? '');
        this.lastCode = this.abortMsg === '' ? 0 : 130;
        this.abortMsg = null;
      } else if (e instanceof RangeError) {
        screen.write('-bash: too many nested commands (practice terminal limit). Is a function or script calling itself?\n');
        this.lastCode = 1;
      } else if (!(e instanceof Signal)) throw e;
    } finally {
      this.runDepth--;
    }
  }

  /** Run parsed complete commands one after another, as bash runs a script line by line. */
  private runCommands(prog: ParseResult, src: string, io: IO, label: string | null): number {
    const fatal = this.inScript;
    for (const c of prog.commands) {
      for (const w of c.warnings) {
        this.lineno = w.line;
        io.err.write(`${this.errPrefix()}${w.message}\n`);
      }
      try {
        this.runList(c.list, io);
      } catch (e) {
        if (!(e instanceof ExpansionError)) throw e;
        io.err.write(`${this.errPrefix()}${e.message}\n`);
        this.lastCode = 1;
        if (e.fatal && fatal) throw new ExitSignal(1);
      }
    }
    if (prog.error) {
      const e = prog.error;
      if (label === null) io.err.write(`-bash: ${e.message}\n`);
      else {
        io.err.write(`${label}: line ${e.line}: ${e.message}\n`);
        const text = src.split('\n')[e.line - 1];
        if (e.message.startsWith('syntax error near') && text !== undefined) io.err.write(`${label}: line ${e.line}: \`${text.trim()}'\n`);
      }
      this.lastCode = 2;
    }
    return this.lastCode;
  }

  private runList(list: List, io: IO): number {
    let code = this.lastCode;
    for (const ao of list) code = this.runAndOr(ao, io);
    return code;
  }

  private inCond<T>(fn: () => T): T {
    this.condDepth++;
    try {
      return fn();
    } finally {
      this.condDepth--;
    }
  }

  private runAndOr(ao: AndOr, io: IO): number {
    const n = ao.rest.length;
    let code = n ? this.inCond(() => this.runPipeline(ao.first, io)) : this.runPipeline(ao.first, io);
    let finalRan = n === 0;
    let bang = ao.first.bang;
    ao.rest.forEach(({ op, pipeline }, k) => {
      if ((op === '&&') !== (code === 0)) return;
      const last = k === n - 1;
      code = last ? this.runPipeline(pipeline, io) : this.inCond(() => this.runPipeline(pipeline, io));
      finalRan = last;
      bang = pipeline.bang;
    });
    if (ao.background) {
      this.lastBg = String(this.nextPid++);
      code = 0;
    }
    this.lastCode = code;
    const strict = this.opts.errexit && (this.inScript || this.subshells > 0);
    if (code !== 0 && finalRan && !bang && strict && this.condDepth === 0) throw new ExitSignal(code);
    return code;
  }

  private runPipeline(pl: Pipeline, io: IO): number {
    let code: number;
    if (pl.cmds.length === 1) code = pl.bang ? this.inCond(() => this.runCommand(pl.cmds[0], io)) : this.runCommand(pl.cmds[0], io);
    else {
      // every part of a pipeline runs in a subshell, so "echo x | read v" does not set v
      let input = io.in;
      const codes: number[] = [];
      pl.cmds.forEach((cmd, k) => {
        const last = k === pl.cmds.length - 1;
        const out = last ? io.out : new Sink();
        const sub: IO = { in: input, out, err: !last && pl.pipeStderr[k] ? out : io.err };
        codes.push(this.subshell(() => this.runCommand(cmd, sub)));
        if (!last) input = new InputStream(out.text);
      });
      code = this.opts.pipefail ? ([...codes].reverse().find((c) => c !== 0) ?? 0) : codes[codes.length - 1];
    }
    if (pl.bang) code = code === 0 ? 1 : 0;
    if (pl.time) io.err.write('\nreal\t0m0.002s\nuser\t0m0.001s\nsys\t0m0.001s\n');
    return (this.lastCode = code);
  }

  /** Run in a subshell: ( ), $( ) or one part of a pipeline. exit and return end only the subshell, and break cannot reach a loop outside it. */
  private subshell(fn: () => number): number {
    return this.isolate(false, () => {
      this.loopDepth = 0;
      try {
        return fn();
      } catch (e) {
        if (e instanceof ExitSignal || e instanceof ReturnSignal) return (this.lastCode = e.code);
        throw e;
      }
    });
  }

  private catchExit(fn: () => number): number {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ExitSignal) return (this.lastCode = e.code);
      throw e;
    }
  }

  private runCommand(cmd: Command, io: IO): number {
    if (cmd.type === 'simple') return this.runSimple(cmd, io);
    if (cmd.type === 'func') {
      this.functions.set(cmd.name, cmd);
      return (this.lastCode = 0);
    }
    this.lineno = cmd.line;
    const r = this.openRedirects(cmd.redirects, io);
    if (!r) return (this.lastCode = 1);
    try {
      return (this.lastCode = this.runCompound(cmd, r.io));
    } finally {
      r.close();
    }
  }

  /** Count a loop iteration. A for over a word list always ends, so only the per-line total applies to it. */
  private tick(n: number, finite = false) {
    if (n >= MAX_LOOP && !finite) this.abort(`loop stopped after ${MAX_LOOP} iterations (practice terminal limit, like pressing Ctrl+C). Check that the loop condition can become false.`);
    if (++this.iterations > MAX_ITERATIONS) this.abort(`stopped after ${MAX_ITERATIONS} loop iterations in one command (practice terminal limit).`);
  }

  private abort(msg: string): never {
    this.abortMsg = `-bash: ${msg}\n`;
    throw new AbortSignal();
  }

  /** Run a loop body, handling break and continue. Returns false when the loop must stop. */
  private loopBody(body: List, io: IO, setCode: (c: number) => void): boolean {
    try {
      setCode(this.runList(body, io));
      return true;
    } catch (e) {
      if (!(e instanceof LoopSignal)) throw e;
      if (e.n > 1) {
        e.n--;
        throw e;
      }
      setCode(0);
      return e.cont;
    }
  }

  private runCompound(cmd: Exclude<Command, SimpleCommand>, io: IO): number {
    switch (cmd.type) {
      case 'group':
        return this.runList(cmd.body, io);
      case 'subshell':
        return this.subshell(() => this.runList(cmd.body, io));
      case 'if': {
        for (const c of cmd.clauses) {
          if (this.inCond(() => this.runList(c.cond, io)) === 0) return this.runList(c.body, io);
        }
        return cmd.orElse ? this.runList(cmd.orElse, io) : 0;
      }
      case 'while': {
        let code = 0;
        this.loopDepth++;
        try {
          for (let n = 0; ; n++) {
            this.tick(n);
            const c = this.inCond(() => this.runList(cmd.cond, io));
            if ((c === 0) === cmd.until) break;
            if (!this.loopBody(cmd.body, io, (v) => (code = v))) break;
          }
        } finally {
          this.loopDepth--;
        }
        return code;
      }
      case 'for': {
        const items = cmd.words ? cmd.words.flatMap((w) => this.expandWord(w, io)) : [...this.frame.args];
        let code = 0;
        this.loopDepth++;
        try {
          for (let n = 0; n < items.length; n++) {
            this.tick(n, true);
            if (!this.setVar(cmd.name, items[n])) {
              io.err.write(`${this.errPrefix()}${cmd.name}: readonly variable\n`);
              return 1;
            }
            if (!this.loopBody(cmd.body, io, (v) => (code = v))) break;
          }
        } finally {
          this.loopDepth--;
        }
        return code;
      }
      case 'cfor': {
        let code = 0;
        const ev = (s: string) => this.arithEval(this.expandText(s, io), '((: ');
        this.loopDepth++;
        try {
          if (cmd.init.trim()) ev(cmd.init);
          for (let n = 0; ; n++) {
            this.tick(n);
            if (cmd.test.trim() && ev(cmd.test) === 0) break;
            if (!this.loopBody(cmd.body, io, (v) => (code = v))) break;
            if (cmd.step.trim()) ev(cmd.step);
          }
        } catch (e) {
          if (!(e instanceof ExpansionError)) throw e;
          io.err.write(`${this.errPrefix()}${e.message}\n`);
          return 1;
        } finally {
          this.loopDepth--;
        }
        return code;
      }
      case 'case': {
        const subject = this.expandValue(cmd.word.parts, io);
        let code = 0;
        for (let k = 0; k < cmd.items.length; k++) {
          const it = cmd.items[k];
          if (!it.patterns.some((p) => globMatch(subject, this.expandPattern(p.parts, io)))) continue;
          code = this.runList(it.body, io);
          let j = k;
          while (cmd.items[j].term === ';&' && j + 1 < cmd.items.length) code = this.runList(cmd.items[++j].body, io);
          if (cmd.items[j].term !== ';;&') return code;
          k = j;
        }
        return code;
      }
      case 'arith':
        try {
          if (this.opts.xtrace) this.trace(io, ['((', cmd.src.trim(), '))']);
          return this.arithEval(this.expandText(cmd.src, io), '((: ') !== 0 ? 0 : 1;
        } catch (e) {
          if (!(e instanceof ExpansionError)) throw e;
          io.err.write(`${this.errPrefix()}${e.message}\n`);
          return 1;
        }
      case 'cond':
        return this.condEval(cmd.items, io);
    }
    return 0;
  }

  private runSimple(cmd: SimpleCommand, io: IO): number {
    const viaAlias = this.expandAlias(cmd, io);
    if (viaAlias !== null) return viaAlias;
    this.lineno = cmd.line;
    if (++this.steps > MAX_STEPS) this.abort(`stopped after running ${MAX_STEPS} commands (practice terminal limit). Is a loop or function running forever?`);
    this.lastSubst = null;
    const argv = this.expandArgs(cmd.words, io);
    if (!argv.length) {
      let code = 0;
      for (const a of cmd.assigns) {
        const v = this.expandValue(a.value, io);
        if (this.opts.xtrace) io.err.write(`${'+'.repeat(1 + this.traceLevel)} ${a.name}${a.append ? '+=' : '='}${shQuote(v)}\n`);
        if (!this.setVar(a.name, a.append ? this.getVar(a.name) + v : v)) {
          io.err.write(`${this.errPrefix()}${a.name}: readonly variable\n`);
          code = 1;
        }
      }
      const r = this.openRedirects(cmd.redirects, io);
      if (!r) return (this.lastCode = 1);
      r.close();
      return (this.lastCode = code || (this.lastSubst ?? 0));
    }
    // VAR=value cmd: the variable is set, and exported, for this command only
    const saved: [string, string | undefined, boolean][] = [];
    for (const a of cmd.assigns) {
      const v = this.expandValue(a.value, io);
      saved.push([a.name, a.name in this.env ? this.env[a.name] : undefined, this.shellOnly.delete(a.name)]);
      this.env[a.name] = a.append ? this.getVar(a.name) + v : v;
    }
    if (this.opts.xtrace) this.trace(io, argv, cmd.assigns.map((a) => `${a.name}=${shQuote(this.env[a.name] ?? '')}`));
    const restore = () => {
      for (const [k, v, shellOnly] of saved.reverse()) {
        if (v === undefined) delete this.env[k];
        else this.env[k] = v;
        if (shellOnly) this.shellOnly.add(k);
      }
    };
    const r = this.openRedirects(cmd.redirects, io);
    if (!r) {
      restore();
      return (this.lastCode = 1);
    }
    try {
      return (this.lastCode = this.dispatch(argv, r.io));
    } finally {
      r.close();
      restore();
    }
  }

  /** Aliases work at the prompt, not in scripts: the first word is replaced by the alias text. null: no alias. */
  private expandAlias(cmd: SimpleCommand, io: IO): number | null {
    const w = cmd.words[0];
    const p = w?.parts[0];
    if (!w || this.inScript || w.parts.length !== 1 || p.type !== 'lit' || p.quoted || p.text !== w.raw) return null;
    const value = this.aliases.get(w.raw);
    if (value === undefined || this.aliasBusy.has(w.raw)) return null;
    const head = onlySimple(parseProgram(value, true));
    this.aliasBusy.add(w.raw);
    try {
      // alias ll='ls -l': the alias words go in front of the other words, and assignments and redirections stay
      if (head) return this.runSimple({ ...cmd, words: [...head.words, ...cmd.words.slice(1)] }, io);
      // alias x='cd /tmp; ls': the alias text and the other words run as a command line
      const src = [value, ...cmd.words.slice(1).map((x) => x.raw)].join(' ');
      return this.runCommands(parseProgram(src, true), src, io, null);
    } finally {
      this.aliasBusy.delete(w.raw);
    }
  }

  private trace(io: IO, argv: string[], assigns: string[] = []) {
    io.err.write(`${'+'.repeat(1 + this.traceLevel)} ${[...assigns, ...argv.map(shQuote)].join(' ')}\n`);
  }

  /** "-bash: " at the prompt, "./x.sh: line 3: " in a script. */
  private errPrefix(): string {
    for (let k = this.frames.length - 1; k >= 0; k--) {
      const f = this.frames[k].file;
      if (f) return `${f}: line ${this.lineno}: `;
    }
    return '-bash: ';
  }

  /** Apply redirections. Files are created (and > truncates them) before the command runs, like bash. */
  private openRedirects(rs: Redirect[], io: IO): { io: IO; close: () => void } | null {
    if (!rs.length) return { io, close: () => {} };
    const next: IO = { ...io };
    const files: { sink: Sink; path: string }[] = [];
    const close = () => {
      for (const f of files) {
        if (!f.sink.text) continue;
        try {
          this.writeFile(f.path, f.sink.text, true);
        } catch {
          // the file was checked when it was opened
        }
      }
    };
    const fail = (msg: string) => {
      io.err.write(`${this.errPrefix()}${msg}\n`);
      close();
      return null;
    };
    for (const r of rs) {
      if (r.op === '<<') {
        const body = r.heredoc!.expand ? this.expandValue(this.hereDocParts(r.heredoc!.body), next) : r.heredoc!.body;
        if (r.fd === 0) next.in = new InputStream(body);
        continue;
      }
      if (r.op === '<<<') {
        if (r.fd === 0) next.in = new InputStream(this.expandValue(r.target.parts, next) + '\n');
        continue;
      }
      const names = this.expandWord(r.target, next);
      if (names.length !== 1) return fail(`${r.target.raw}: ambiguous redirect`);
      const target = names[0];
      if (r.op === '>&' || r.op === '<&') {
        if (target === '-') {
          if (r.fd === 1 || r.fd === 2) next[r.fd === 1 ? 'out' : 'err'] = new Sink();
          continue;
        }
        if (!/^\d+$/.test(target)) return fail(`${target}: ambiguous redirect`);
        const from = Number(target);
        if (r.op === '<&') continue;
        if (from !== 1 && from !== 2) return fail(`${target}: Bad file descriptor`);
        const sink = from === 1 ? next.out : next.err;
        if (r.fd === 1) next.out = sink;
        else if (r.fd === 2) next.err = sink;
        continue;
      }
      if (r.op === '<') {
        if (r.fd !== 0 || target === '/dev/stdin') continue;
        try {
          next.in = new InputStream(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'].includes(target) ? '' : this.readFile(target));
        } catch (e) {
          return fail(`${target}: ${e instanceof FsError ? errorText[e.reason] : String(e)}`);
        }
        continue;
      }
      // > and >>
      let sink: Sink;
      if (target === '/dev/null') sink = new Sink();
      else if (target === '/dev/stdout') sink = io.out;
      else if (target === '/dev/stderr') sink = io.err;
      else {
        try {
          this.writeFile(target, '', r.op === '>>');
        } catch (e) {
          return fail(`${target}: ${e instanceof FsError ? errorText[e.reason] : String(e)}`);
        }
        sink = new Sink();
        files.push({ sink, path: joinPath(splitPath(this.cwd, target, this.user.home)) }); // a cd inside must not move it
      }
      if (r.fd === 1 || r.fd === -1) next.out = sink;
      if (r.fd === 2 || r.fd === -1) next.err = sink;
    }
    return { io: next, close };
  }

  private dispatch(argv: string[], io: IO): number {
    const name = argv[0];
    const fn = this.functions.get(name);
    if (fn) return this.callFunction(name, fn.body, argv.slice(1), io);
    if (SHELL_BUILTINS.has(name)) return this.builtin(name, argv.slice(1), io);
    return this.external(argv, io);
  }

  private external(argv: string[], io: IO): number {
    const t = this.lookup(argv[0]);
    if ('error' in t) {
      io.err.write(t.error);
      return t.code;
    }
    if ('path' in t) return this.runFile(t.path, t.node, argv.slice(1), io);
    return this.callCommand(t.fn, t.name, argv.slice(1), io);
  }

  /** What a command name runs, for type, which and command -v. Practice commands live in /usr/bin. */
  describe(name: string, pathOnly = false): { kind: 'function' | 'alias'; text: string } | { kind: 'keyword' | 'builtin' } | { kind: 'file'; path: string } | null {
    if (pathOnly) {
      const t = this.lookup(name);
      if ('error' in t || ('path' in t && !canAccess(t.node, 'x', this.uid, this.gids))) return null;
      return { kind: 'file', path: 'path' in t ? joinPath(splitPath(this.cwd, t.path, this.user.home)) : `/usr/bin/${t.name}` };
    }
    if (this.aliases.has(name) && !this.inScript) return { kind: 'alias', text: this.aliases.get(name)! };
    if (KEYWORDS.has(name)) return { kind: 'keyword' };
    if (this.functions.has(name)) return { kind: 'function', text: this.functionText(name) };
    if (SHELL_BUILTINS.has(name) || (COMMAND_BUILTINS.has(name) && commandFor(name))) return { kind: 'builtin' };
    const t = this.lookup(name);
    if ('error' in t) return null;
    return { kind: 'file', path: 'path' in t ? joinPath(splitPath(this.cwd, t.path, this.user.home)) : `/usr/bin/${t.name}` };
  }

  private functionText(name: string): string {
    return `${name} () \n${this.functions.get(name)?.src ?? '{ :; }'}\n`;
  }

  /** Find what a command name means: a built-in command, a script file, or an error message. */
  private lookup(cmd: string): { fn: (ctx: CommandContext) => CommandResult; name: string } | { path: string; node: FsNode } | { error: string; code: number } {
    if (cmd.includes('/')) {
      const base = cmd.split('/').pop()!;
      const fn = commandFor(base);
      const inBin = /^\/(usr\/)?(local\/)?s?bin\/[^/]+$/;
      let r: Resolved | null = null;
      let reason: FsError['reason'] = 'ENOENT';
      try {
        r = this.resolve(cmd);
      } catch (e) {
        if (!(e instanceof FsError)) throw e;
        reason = e.reason;
      }
      if (r && r.node.type === 'file') {
        const binary = fn && !(r.node.content ?? '').startsWith('#!') && inBin.test(joinPath(r.parts));
        return binary ? { fn, name: base } : { path: cmd, node: r.node };
      }
      if (r) return { error: `${this.errPrefix()}${cmd}: Is a directory\n`, code: 126 };
      // /usr/bin/ls and friends: the practice commands have no files of their own
      if (fn && reason === 'ENOENT' && inBin.test(joinPath(splitPath(this.cwd, cmd, this.user.home)))) return { fn, name: base };
      return { error: `${this.errPrefix()}${cmd}: ${errorText[reason]}\n`, code: reason === 'ENOENT' ? 127 : 126 };
    }
    const fn = commandFor(cmd);
    if (fn) return { fn, name: cmd };
    for (const dir of this.getVar('PATH').split(':')) {
      if (!dir) continue;
      try {
        const r = this.resolve(`${dir}/${cmd}`);
        if (r.node.type === 'file' && canAccess(r.node, 'x', this.uid, this.gids)) return { path: `${dir}/${cmd}`, node: r.node };
      } catch {
        // not in this directory
      }
    }
    const hint = this.exists(cmd) && !this.inScript ? `(To run a script in the current directory, type ./${cmd})\n` : '';
    return { error: `${this.inScript ? this.errPrefix() : 'bash: '}${cmd}: command not found\n${hint}`, code: 127 };
  }

  private callCommand(fn: (ctx: CommandContext) => CommandResult, name: string, args: string[], io: IO): number {
    const prev = this.cur;
    const prevStdin = this.curStdin;
    const stdin = io.in.rest;
    this.cur = io;
    this.curStdin = stdin;
    const g = /^[ef]?grep$/.test(name) ? grepQuiet(args) : null;
    const sessions = this.sessions;
    let res: CommandResult;
    try {
      res = fn({ sh: this, args: g ? g.args : args, stdin, name, tty: io.out.tty });
    } catch (e) {
      if (e instanceof Signal) throw e;
      res = errorResult(name, e);
    } finally {
      this.cur = prev;
      this.curStdin = prevStdin;
    }
    if (g?.silent) res = { ...res, stderr: res.stderr.replace(/^grep: .*: (No such file or directory|Permission denied|Is a directory)\n/gm, '') };
    if (g?.quiet) res = { ...res, stdout: '', code: res.stdout && res.code === 2 ? 0 : res.code };
    if (STDIN_READERS.has(name) && (['tr', 'tee', 'xargs'].includes(name) || args.every((a) => a.startsWith('-')))) io.in.readAll();
    // a reboot logs everyone in afresh (new sessions): nothing after it on the line or in a script runs
    if (this.sessions !== sessions && this.abortMsg === null) this.abortMsg = '';
    this.writeResult(res, io);
    if (this.abortMsg !== null) throw new AbortSignal();
    return res.code;
  }

  private writeResult(res: CommandResult, io: IO) {
    if (res.clear) io.out.clear();
    const fix = (s: string) => (this.inScript || this.frames.some((f) => f.file) ? s.replace(/^-bash: /gm, this.errPrefix()) : s);
    const log = this.chunks.get(res);
    const same = (fd: 1 | 2, text: string) => log!.filter((c) => c[0] === fd).map((c) => c[1]).join('') === text;
    if (log && same(1, res.stdout) && same(2, res.stderr)) {
      for (const [fd, s] of log) (fd === 1 ? io.out : io.err).write(fd === 2 ? fix(s) : s);
      return;
    }
    io.err.write(fix(res.stderr));
    io.out.write(res.stdout);
  }

  /** Run one command with already-expanded argv. */
  exec(argv: string[], stdin = ''): CommandResult {
    if (!argv.length) return { stdout: '', stderr: '', code: 0 };
    // VAR=value assignment
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(argv[0]);
    if (assign && argv.length === 1) {
      this.env[assign[1]] = assign[2];
      return { stdout: '', stderr: '', code: 0 };
    }
    const log: Chunk[] = [];
    const io: IO = { in: new InputStream(stdin, stdin === '' && (this.cur?.in.tty ?? true)), out: new Sink(log, 1), err: new Sink(log, 2) };
    io.out.tty = this.cur?.out.tty ?? false; // sudo ls at the prompt still writes to the terminal
    const outer = this.runDepth === 0;
    if (outer) {
      this.steps = 0;
      this.iterations = 0;
      this.abortMsg = null;
      this.notes.clear();
    }
    const prev = this.cur;
    const prevStdin = this.curStdin;
    this.runDepth++;
    this.cur = io;
    this.curStdin = stdin;
    let code: number;
    try {
      const t = this.lookup(argv[0]);
      if ('fn' in t) {
        let res: CommandResult;
        try {
          res = t.fn({ sh: this, args: argv.slice(1), stdin, name: t.name, tty: io.out.tty });
        } catch (e) {
          if (e instanceof Signal) throw e;
          res = errorResult(t.name, e);
        }
        if (!log.length) return res;
        this.writeResult(res, io);
        code = res.code;
      } else if ('path' in t) code = this.runFile(t.path, t.node, argv.slice(1), io);
      else {
        io.err.write(t.error);
        code = t.code;
      }
    } catch (e) {
      if (e instanceof AbortSignal) {
        if (outer) {
          io.err.write(this.abortMsg ?? '');
          this.abortMsg = null;
        }
        code = 130;
      } else if (outer && e instanceof ExitSignal) code = e.code;
      else if (outer && e instanceof Signal) code = this.lastCode;
      else throw e;
    } finally {
      this.cur = prev;
      this.curStdin = prevStdin;
      this.runDepth--;
    }
    const result: CommandResult = { stdout: io.out.text, stderr: io.err.text, code };
    if (io.out.cleared) result.clear = true;
    this.chunks.set(result, log);
    return result;
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

  // ---------- subshells, functions and scripts ----------

  /**
   * Run fn in a subshell (child=false) or a child bash process (child=true): variables, functions,
   * options, the directory and umask changed inside are put back afterwards. A child only gets
   * exported variables and no functions.
   */
  private isolate<T>(child: boolean, fn: () => T): T {
    const saved = {
      env: this.env,
      functions: this.functions,
      opts: this.opts,
      frames: this.frames,
      shellOnly: this.shellOnly,
      exportAttr: this.exportAttr,
      readonly: this.readonlyVars,
      sessions: this.sessions,
      count: this.sessions.length,
      session: this.session,
      cwd: this.session.cwd,
      umask: this.session.umask,
      loopDepth: this.loopDepth,
      condDepth: this.condDepth,
      lineno: this.lineno,
      traceLevel: this.traceLevel,
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) if (!child || !this.shellOnly.has(k)) env[k] = v;
    this.env = env;
    this.functions = child ? new Map() : new Map(this.functions);
    this.opts = child ? { ...DEFAULT_OPTS } : { ...this.opts };
    const top = this.frame;
    this.frames = [...this.frames.slice(0, -1), { ...top, args: [...top.args], locals: top.locals && new Map(top.locals) }];
    this.shellOnly = new Set(child ? [] : this.shellOnly);
    this.exportAttr = new Set(this.exportAttr);
    this.readonlyVars = new Set(child ? [] : this.readonlyVars);
    if (child) {
      this.loopDepth = 0;
      this.condDepth = 0;
      this.traceLevel = 0;
    }
    this.subshells++;
    try {
      return fn();
    } finally {
      this.subshells--;
      if (this.env === env) this.env = saved.env; // a reboot replaces env; keep that
      this.functions = saved.functions;
      this.opts = saved.opts;
      this.frames = saved.frames;
      this.shellOnly = saved.shellOnly;
      this.exportAttr = saved.exportAttr;
      this.readonlyVars = saved.readonly;
      this.loopDepth = saved.loopDepth;
      this.condDepth = saved.condDepth;
      this.lineno = saved.lineno;
      this.traceLevel = saved.traceLevel;
      if (this.sessions === saved.sessions) {
        if (this.sessions.length > saved.count) this.sessions.length = saved.count;
        if (this.session === saved.session) {
          saved.session.cwd = saved.cwd;
          saved.session.umask = saved.umask;
        }
      }
    }
  }

  private callFunction(name: string, body: Command, args: string[], io: IO): number {
    if (this.funcDepth >= MAX_FUNC_DEPTH) {
      io.err.write(`${this.errPrefix()}${name}: maximum function nesting level exceeded (${MAX_FUNC_DEPTH})\n`);
      return 1;
    }
    const frame: Frame = { kind: 'func', name0: this.frame.name0, args, locals: new Map(), pid: this.frame.pid };
    this.frames.push(frame);
    this.funcDepth++;
    const frames = this.frames;
    const loops = this.loopDepth;
    this.loopDepth = 0; // break in a function does not end the caller's loop
    try {
      return this.runCommand(body, io);
    } catch (e) {
      if (e instanceof ReturnSignal) return (this.lastCode = e.code);
      throw e;
    } finally {
      this.loopDepth = loops;
      this.funcDepth--;
      frames.splice(frames.lastIndexOf(frame), 1);
      for (const [k, v] of frame.locals!) {
        if (v === undefined) delete this.env[k];
        else this.env[k] = v;
      }
    }
  }

  /** Run a script given by path (./x.sh, /usr/local/bin/x): needs execute permission and a bash shebang. */
  private runFile(cmd: string, node: FsNode, args: string[], io: IO): number {
    const p = this.errPrefix();
    if (!canAccess(node, 'x', this.uid, this.gids) || !canAccess(node, 'r', this.uid, this.gids)) {
      io.err.write(`${p}${cmd}: Permission denied\n`);
      return 126;
    }
    let text: string;
    try {
      text = this.readFile(cmd);
    } catch (e) {
      io.err.write(`${p}${cmd}: ${e instanceof FsError ? errorText[e.reason] : String(e)}\n`);
      return 126;
    }
    const opts: ScriptOptions = {};
    if (text.startsWith('#!')) {
      const words = text.slice(2).split('\n')[0].trim().split(/\s+/);
      let interp = words[0] ?? '';
      let flags = words.slice(1);
      if (/\/env$/.test(interp) && words[1]) {
        interp = `/usr/bin/${words[1]}`;
        flags = words.slice(2);
      }
      if (!SHELL_PATHS.has(interp)) {
        const other = /\/(python[0-9.]*|perl|ruby|php|node)$/.test(interp);
        io.err.write(other ? `${p}${cmd}: ${interp}: the practice terminal can only run bash scripts\n` : `${p}${cmd}: ${interp}: bad interpreter: No such file or directory\n`);
        return 126;
      }
      for (const f of flags) {
        if (f.startsWith('-')) {
          if (f.includes('x')) opts.xtrace = true;
          if (f.includes('e')) opts.errexit = true;
          if (f.includes('u')) opts.nounset = true;
        }
      }
    }
    return this.runScriptText(text, { name0: cmd, args, io, opts });
  }

  private runScriptText(src: string, o: { name0: string; args: string[]; io: IO; opts?: ScriptOptions; label?: string }): number {
    if (this.scriptDepth >= MAX_SCRIPT_DEPTH) {
      o.io.err.write(`${this.errPrefix()}${o.name0}: scripts nested more than ${MAX_SCRIPT_DEPTH} deep (practice terminal limit). Is the script calling itself?\n`);
      return 126;
    }
    const prog = parseProgram(src, true);
    this.scriptDepth++;
    try {
      return this.isolate(true, () => {
        const frame: Frame = { kind: 'script', name0: o.name0, args: o.args, file: o.name0, pid: this.nextPid++ };
        this.frames.push(frame);
        this.lineno = 0;
        this.lastCode = 0; // a new bash starts with $? = 0
        const so = o.opts ?? {};
        if (so.xtrace) this.opts.xtrace = true;
        if (so.errexit) this.opts.errexit = true;
        if (so.nounset) this.opts.nounset = true;
        const label = o.label ?? o.name0;
        let code: number;
        try {
          code = so.noexec ? this.runCommands({ commands: [], error: prog.error }, src, o.io, label) : this.runCommands(prog, src, o.io, label);
        } catch (e) {
          if (!(e instanceof ExitSignal)) throw e;
          code = e.code;
        }
        if (frame.trap) {
          const trap = frame.trap;
          frame.trap = undefined;
          this.lastCode = code;
          code = this.catchExit(() => {
            this.runCommands(parseProgram(trap, true), trap, o.io, label);
            return code;
          });
        }
        return (this.lastCode = code);
      });
    } finally {
      this.scriptDepth--;
    }
  }

  /**
   * Run fn for bash, source and friends. Called from a running command, fn writes straight into that
   * command's streams (so order and redirections stay right); otherwise its output is collected and returned.
   */
  private nested(stdin: string, fn: (io: IO) => number): CommandResult {
    if (this.cur) return { stdout: '', stderr: '', code: fn(this.cur) };
    const log: Chunk[] = [];
    const io: IO = { in: new InputStream(stdin, stdin === ''), out: new Sink(log, 1), err: new Sink(log, 2) };
    this.cur = io;
    let code = 0;
    try {
      code = fn(io);
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code;
      else if (e instanceof AbortSignal) {
        io.err.write(this.abortMsg ?? '');
        this.abortMsg = null;
        code = 130;
      } else throw e;
    } finally {
      this.cur = null;
    }
    const res: CommandResult = { stdout: io.out.text, stderr: io.err.text, code };
    this.chunks.set(res, log);
    return res;
  }

  /** bash FILE ARGS: run a script file in a child shell. It needs read permission only. */
  runScript(path: string, args: string[], stdin: string, opts: ScriptOptions = {}, shell = 'bash'): CommandResult {
    return this.nested(stdin, (io) => {
      let text: string;
      try {
        text = this.readFile(path);
      } catch (e) {
        const reason = e instanceof FsError ? e.reason : 'ENOENT';
        io.err.write(`${shell}: ${path}: ${errorText[reason]}\n`);
        return reason === 'ENOENT' ? 127 : 126;
      }
      return this.runScriptText(text, { name0: path, args, io, opts });
    });
  }

  /** bash -c 'commands' [name [args]]: run a string in a child shell. */
  runString(src: string, name0: string, args: string[], stdin: string, opts: ScriptOptions = {}, label = `${name0}: -c`): CommandResult {
    return this.nested(stdin, (io) => this.runScriptText(src, { name0, args, io, opts, label }));
  }

  /** source FILE / . FILE: run a file in the current shell, so its variables and functions stay. */
  source(path: string, args: string[] | null, stdin: string): CommandResult {
    return this.nested(stdin, (io) => {
      let file = path;
      if (!path.includes('/')) {
        const dir = this.getVar('PATH')
          .split(':')
          .find((d) => d && this.exists(`${d}/${path}`) && !this.isDir(`${d}/${path}`));
        if (dir) file = `${dir}/${path}`;
      }
      let text: string;
      try {
        if (this.isDir(file)) {
          io.err.write(`${this.errPrefix()}${path}: is a directory\n`);
          return 1;
        }
        text = this.readFile(file);
      } catch (e) {
        io.err.write(`${this.errPrefix()}${path}: ${e instanceof FsError ? errorText[e.reason] : String(e)}\n`);
        return 1;
      }
      if (this.scriptDepth >= MAX_SCRIPT_DEPTH) {
        io.err.write(`${this.errPrefix()}${path}: files sourced more than ${MAX_SCRIPT_DEPTH} deep (practice terminal limit)\n`);
        return 1;
      }
      const prog = parseProgram(text, true);
      const frame: Frame = { kind: 'source', name0: this.frame.name0, args: args ?? this.frame.args, file: path, pid: this.frame.pid };
      const frames = this.frames;
      frames.push(frame);
      const line = this.lineno;
      this.scriptDepth++;
      try {
        return this.runCommands(prog, text, io, path);
      } catch (e) {
        if (e instanceof ReturnSignal) return (this.lastCode = e.code);
        throw e;
      } finally {
        this.scriptDepth--;
        frames.splice(frames.lastIndexOf(frame), 1);
        this.lineno = line;
      }
    });
  }

  private isDir(p: string): boolean {
    try {
      return this.resolve(p).node.type === 'dir';
    } catch {
      return false;
    }
  }

  // ---------- [[ ]] ----------

  private condEval(items: CondItem[], io: IO): number {
    let k = 0;
    const text = (it: CondItem | undefined) => (!it ? undefined : 'op' in it ? it.op : it.word.raw);
    const fail = (): never => {
      throw new CondSyntax();
    };
    type Node = () => boolean;
    const word = (): WordNode => {
      const it = items[k++];
      if (!it || 'op' in it) fail();
      return (it as { word: WordNode }).word;
    };
    const or = (): Node => {
      let l = and();
      while (text(items[k]) === '||') {
        k++;
        const a = l;
        const b = and();
        l = () => a() || b();
      }
      return l;
    };
    const and = (): Node => {
      let l = not();
      while (text(items[k]) === '&&') {
        k++;
        const a = l;
        const b = not();
        l = () => a() && b();
      }
      return l;
    };
    const not = (): Node => {
      if (text(items[k]) === '!' && items[k + 1]) {
        k++;
        const a = not();
        return () => !a();
      }
      return primary();
    };
    const value = (w: WordNode) => this.expandValue(w.parts, io);
    const primary = (): Node => {
      const t = text(items[k]);
      if (t === '(') {
        k++;
        const e = or();
        if (text(items[k]) !== ')') fail();
        k++;
        return e;
      }
      const left = word();
      const op = text(items[k]);
      if (op !== undefined && COND_BINARY.has(op) && items[k + 1]) {
        k++;
        const right = word();
        return () => this.condBinary(op, value(left), right, io);
      }
      if (/^-[a-zA-Z]$/.test(left.raw) && items[k] && 'word' in items[k] && !COND_BINARY.has(text(items[k + 1]) ?? '')) {
        const arg = word();
        return () => {
          const v = value(arg);
          const r = unaryTest(this, left.raw, v);
          if (r === undefined) throw new CondSyntax(`unexpected argument \`${v}' to conditional unary operator`);
          return r;
        };
      }
      return () => value(left) !== '';
    };
    try {
      const tree = or();
      if (k < items.length) fail();
      return tree() ? 0 : 1;
    } catch (e) {
      if (!(e instanceof CondSyntax)) throw e;
      io.err.write(`${this.errPrefix()}${e.message}\n`);
      return 2;
    }
  }

  private condBinary(op: string, left: string, rightWord: WordNode, io: IO): boolean {
    switch (op) {
      case '==':
      case '=':
        return globMatch(left, this.expandPattern(rightWord.parts, io));
      case '!=':
        return !globMatch(left, this.expandPattern(rightWord.parts, io));
      case '=~': {
        const src = this.segments(rightWord.parts, io)
          .map((s) => (s.quoted ? s.text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') : s.text.replace(/\[:(\w+):\]/g, (m, n: string) => POSIX_CLASSES[n] ?? m)))
          .join('');
        let re: RegExp;
        try {
          re = new RegExp(src);
        } catch {
          throw new CondSyntax(`invalid regular expression \`${src}'`);
        }
        const m = re.exec(left);
        this.rematch = m ? [...m].map((x) => x ?? '') : [];
        return m !== null;
      }
      case '<':
        return left < this.expandValue(rightWord.parts, io);
      case '>':
        return left > this.expandValue(rightWord.parts, io);
    }
    const right = this.expandValue(rightWord.parts, io);
    if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(op)) {
      const a = this.arithEval(left);
      const b = this.arithEval(right);
      return op === '-eq' ? a === b : op === '-ne' ? a !== b : op === '-lt' ? a < b : op === '-le' ? a <= b : op === '-gt' ? a > b : a >= b;
    }
    return binaryTest(this, op, left, right) ?? false;
  }

  // ---------- shell built-ins that change the shell itself ----------

  private builtin(name: string, args: string[], io: IO): number {
    const pfx = this.errPrefix();
    const err = (msg: string, code = 1) => {
      io.err.write(`${pfx}${msg}\n`);
      return code;
    };
    switch (name) {
      case 'break':
      case 'continue': {
        const n = args[0] === undefined ? 1 : Number(args[0]);
        if (!Number.isInteger(n)) return err(`${name}: ${args[0]}: numeric argument required`, 128);
        if (n < 1) return err(`${name}: ${args[0]}: loop count out of range`);
        if (this.loopDepth === 0) return err(`${name}: only meaningful in a \`for', \`while', or \`until' loop`, 0);
        throw new LoopSignal(Math.min(n, this.loopDepth), name === 'continue');
      }
      case 'return':
      case 'exit': {
        let code = this.lastCode;
        if (args.length > 1) return err(`${name}: too many arguments`);
        if (args[0] !== undefined) {
          if (!/^\s*[+-]?\d+\s*$/.test(args[0])) {
            err(`${name}: ${args[0]}: numeric argument required`);
            code = 2;
          } else code = ((Number(args[0]) % 256) + 256) % 256;
        }
        if (name === 'return') {
          const f = [...this.frames].reverse().find((fr) => fr.kind !== 'top');
          if (!f || f.kind === 'script') return err("return: can only `return' from a function or sourced script");
          throw new ReturnSignal(code);
        }
        if (this.subshells > 0 || this.inScript) throw new ExitSignal(code);
        // at the prompt: leave a sudo -i / su session, or explain that this is the login shell
        if (this.sessions.length > 1 && this.nestedShells.has(this.session)) {
          this.sessions.pop();
          io.err.write('exit\n');
        } else this.writeResult(COMMANDS.exit({ sh: this, args, stdin: '', name: 'exit' }), io);
        throw new ExitSignal(code);
      }
      case 'shift': {
        const n = args[0] === undefined ? 1 : Number(args[0]);
        if (!Number.isInteger(n) || n < 0) return err(`shift: ${args[0]}: numeric argument required`);
        const f = this.frame;
        if (n > f.args.length) return 1;
        f.args.splice(0, n);
        return 0;
      }
      case 'local': {
        const f = [...this.frames].reverse().find((fr) => fr.kind === 'func' || fr.kind === 'script' || fr.kind === 'top');
        if (!f || f.kind !== 'func') return err('local: can only be used in a function');
        return this.declare(name, args, io, f);
      }
      case 'declare':
      case 'typeset': {
        const f = [...this.frames].reverse().find((fr) => fr.kind === 'func' || fr.kind === 'script' || fr.kind === 'top');
        return this.declare(name, args, io, f?.kind === 'func' && !args.includes('-g') ? f : null);
      }
      case 'readonly':
        return this.declare(name, ['-r', ...args], io, null);
      case 'unset': {
        let mode = '';
        let code = 0;
        for (const a of args) {
          if (a === '-f' || a === '-v') {
            mode = a;
            continue;
          }
          if (!isName(a)) {
            code = err(`unset: \`${a}': not a valid identifier`);
            continue;
          }
          if (mode !== '-f' && (a in this.env || this.readonlyVars.has(a))) {
            if (this.readonlyVars.has(a)) {
              code = err(`unset: ${a}: cannot unset: readonly variable`);
              continue;
            }
            delete this.env[a];
            this.shellOnly.delete(a);
            this.exportAttr.delete(a);
          } else if (mode !== '-v') this.functions.delete(a);
        }
        return code;
      }
      case 'alias': {
        const show = (n: string) => io.out.write(`alias ${n}='${this.aliases.get(n)!.replace(/'/g, "'\\''")}'\n`);
        const names = args.filter((a) => a !== '-p');
        if (!names.length) [...this.aliases.keys()].sort().forEach(show);
        let code = 0;
        for (const a of names) {
          const eq = a.indexOf('=');
          if (eq < 0) {
            if (this.aliases.has(a)) show(a);
            else code = err(`alias: ${a}: not found`);
          } else if (eq === 0 || /[\s/$`'"\\;&|()<>]/.test(a.slice(0, eq))) code = err(`alias: \`${a.slice(0, eq)}': invalid alias name`);
          else this.aliases.set(a.slice(0, eq), a.slice(eq + 1));
        }
        return code;
      }
      case 'unalias': {
        if (!args.length) return err('unalias: usage: unalias [-a] name [name ...]', 2);
        if (args[0] === '-a') {
          this.aliases.clear();
          return 0;
        }
        let code = 0;
        for (const a of args) if (!this.aliases.delete(a)) code = err(`unalias: ${a}: not found`);
        return code;
      }
      case 'set':
        return this.setBuiltin(args, io, err);
      case 'eval': {
        const src = args.join(' ');
        if (!src.trim()) return 0;
        this.traceLevel++;
        try {
          return this.runCommands(parseProgram(src, true), src, io, `${pfx.replace(/: (line \d+: )?$/, '')}: eval`);
        } finally {
          this.traceLevel--;
        }
      }
      case 'command': {
        if (args[0] === '-v' || args[0] === '-V') {
          let code = 0;
          for (const n of args.slice(1)) {
            const verbose = args[0] === '-V';
            const d = this.describe(n);
            if (!d) {
              if (verbose) err(`command: ${n}: not found`);
              code = 1;
            } else if (d.kind === 'file') io.out.write(verbose ? `${n} is ${d.path}\n` : `${d.path}\n`);
            else if (d.kind === 'alias') io.out.write(verbose ? `${n} is aliased to \`${d.text}'\n` : `alias ${n}='${d.text}'\n`);
            else if (!verbose) io.out.write(`${n}\n`);
            else io.out.write(d.kind === 'function' ? `${n} is a function\n${d.text}` : `${n} is a shell ${d.kind}\n`);
          }
          return code;
        }
        if (!args.length) return 0;
        if (SHELL_BUILTINS.has(args[0])) return this.builtin(args[0], args.slice(1), io);
        return this.external(args, io);
      }
      case 'trap': {
        if (!args.length || args[0] === '-p') {
          for (const f of this.frames) if (f.trap !== undefined) io.out.write(`trap -- ${shQuote(f.trap)} EXIT\n`);
          return 0;
        }
        if (args[0] === '-l') {
          io.out.write(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t15) SIGTERM\n');
          return 0;
        }
        const [action, ...sigs] = args;
        const f = [...this.frames].reverse().find((fr) => fr.kind === 'script' || fr.kind === 'top')!;
        for (const s of sigs) {
          if (/^(EXIT|0)$/i.test(s)) f.trap = action === '-' || action === '' ? undefined : action;
          else if (!/^(SIG)?(INT|TERM|HUP|QUIT|ERR|DEBUG|RETURN|USR1|USR2|KILL|STOP|[0-9]+)$/i.test(s)) return err(`trap: ${s}: invalid signal specification`);
        }
        return 0;
      }
      case 'wait':
        return 0;
      case 'getopts':
        return this.getopts(args, io, err);
    }
    return 0;
  }

  private declare(name: string, args: string[], io: IO, local: Frame | null): number {
    const flags = new Set<string>();
    const names: string[] = [];
    for (const a of args) {
      if (/^[-+][a-zA-Z]+$/.test(a) && !names.length) {
        for (const c of a.slice(1)) flags.add((a[0] === '+' ? '+' : '') + c);
      } else names.push(a);
    }
    const pfx = this.errPrefix();
    if (flags.has('f') || flags.has('F')) {
      const list = names.length ? names.filter((n) => this.functions.has(n)) : [...this.functions.keys()].sort();
      for (const n of list) io.out.write(flags.has('F') ? (names.length ? `${n}\n` : `declare -f ${n}\n`) : this.functionText(n));
      return names.length && list.length < names.length ? 1 : 0;
    }
    if (!names.length || flags.has('p')) {
      const want = names.length ? names : Object.keys(this.env).filter(isName).sort();
      let code = 0;
      for (const n of want) {
        if (!(n in this.env)) {
          if (names.length) {
            io.err.write(`${pfx}${name}: ${n}: not found\n`);
            code = 1;
          }
          continue;
        }
        const r = this.readonlyVars.has(n);
        const x = this.isExported(n);
        if (flags.has('r') && !r) continue;
        if (flags.has('x') && !x) continue;
        const attrs = (r ? 'r' : '') + (x ? 'x' : '');
        io.out.write(`declare -${attrs || '-'} ${n}="${this.env[n].replace(/(["\\$`])/g, '\\$1')}"\n`);
      }
      return code;
    }
    if (flags.has('a') || flags.has('A')) {
      io.err.write(`${pfx}${name}: arrays are not supported in this practice terminal\n`);
      return 1;
    }
    let code = 0;
    for (const n of names) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(\+?=)([\s\S]*))?$/.exec(n);
      if (!m) {
        io.err.write(`${pfx}${name}: \`${n}': not a valid identifier\n`);
        code = 1;
        continue;
      }
      const [, v, op, value] = m;
      if (this.readonlyVars.has(v) && op !== undefined) {
        io.err.write(`${pfx}${v}: readonly variable\n`);
        code = 1;
        continue;
      }
      if (local && !local.locals!.has(v)) {
        local.locals!.set(v, v in this.env ? this.env[v] : undefined);
        if (op === undefined) delete this.env[v];
      }
      if (op !== undefined) this.setVar(v, op === '+=' ? this.getVar(v) + value : value);
      if (flags.has('x')) this.markExported(v);
      if (flags.has('+x')) this.markExported(v, false);
      if (flags.has('r')) this.readonlyVars.add(v);
    }
    return code;
  }

  private setBuiltin(args: string[], io: IO, err: (msg: string, code?: number) => number): number {
    if (!args.length) {
      for (const k of Object.keys(this.env).filter(isName).sort()) io.out.write(`${k}=${shQuote(this.env[k])}\n`);
      return 0;
    }
    const setArgs = (list: string[]) => this.frame.args.splice(0, this.frame.args.length, ...list);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '--' || a === '-') {
        setArgs(args.slice(k + 1));
        return 0;
      }
      if (a === '-o' || a === '+o') {
        const opt = args[k + 1];
        if (opt === undefined) {
          for (const [n, key] of Object.entries(LONG_OPTS)) io.out.write(a === '-o' ? `${n.padEnd(15)}\t${key && this.opts[key] ? 'on' : 'off'}\n` : `set ${key && this.opts[key] ? '-' : '+'}o ${n}\n`);
          return 0;
        }
        k++;
        if (!(opt in LONG_OPTS)) return err(`set: ${opt}: invalid option name`);
        const key = LONG_OPTS[opt];
        if (key) this.opts[key] = a === '-o';
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (!(c in SHORT_OPTS)) return err(`set: ${a[0]}${c}: invalid option\nset: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]`, 2);
          const key = SHORT_OPTS[c];
          if (key) this.opts[key] = a[0] === '-';
        }
        continue;
      }
      setArgs(args.slice(k));
      return 0;
    }
    return 0;
  }

  private getopts(args: string[], io: IO, err: (msg: string, code?: number) => number): number {
    const [spec, name, ...rest] = args;
    if (spec === undefined || name === undefined) return err('getopts: usage: getopts optstring name [arg ...]', 2);
    const argv = rest.length ? rest : this.frame.args;
    const silent = spec.startsWith(':');
    let ind = parseInt(this.getVar('OPTIND') || '1', 10) || 1;
    if (this.optState.ind !== ind) this.optState = { ind, pos: 1 };
    const done = () => {
      this.setVar('OPTIND', String(ind));
      this.setVar(name, '?');
      this.optState = { ind, pos: 1 };
      return 1;
    };
    const arg = argv[ind - 1];
    if (arg === undefined || !arg.startsWith('-') || arg === '-') return done();
    if (arg === '--') {
      ind++;
      return done();
    }
    let pos = this.optState.pos;
    const ch = arg[pos++];
    const advance = () => {
      if (pos >= arg.length) {
        ind++;
        pos = 1;
      }
    };
    const k = ch === ':' ? -1 : spec.indexOf(ch);
    delete this.env.OPTARG;
    if (k < 0) {
      advance();
      if (silent) this.setVar('OPTARG', ch);
      else io.err.write(`${this.frame.name0}: illegal option -- ${ch}\n`);
      this.setVar(name, '?');
    } else if (spec[k + 1] === ':') {
      if (pos < arg.length) {
        this.setVar('OPTARG', arg.slice(pos));
        ind++;
        pos = 1;
        this.setVar(name, ch);
      } else if (argv[ind] !== undefined) {
        this.setVar('OPTARG', argv[ind]);
        ind += 2;
        pos = 1;
        this.setVar(name, ch);
      } else {
        ind++;
        pos = 1;
        if (silent) {
          this.setVar('OPTARG', ch);
          this.setVar(name, ':');
        } else {
          io.err.write(`${this.frame.name0}: option requires an argument -- ${ch}\n`);
          this.setVar(name, '?');
        }
      }
    } else {
      advance();
      this.setVar(name, ch);
    }
    this.optState = { ind, pos };
    this.setVar('OPTIND', String(ind));
    return 0;
  }
}

class CondSyntax extends Signal {
  constructor(public message = 'syntax error in conditional expression') {
    super();
  }
}

const COND_BINARY = new Set(['==', '=', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

interface Seg {
  text: string;
  quoted: boolean;
}

function errorResult(name: string, e: unknown): CommandResult {
  if (e instanceof FsError) return { stdout: '', stderr: `${name}: ${errorText[e.reason]}\n`, code: 1 };
  return { stdout: '', stderr: `${name}: ${(e as Error).message}\n`, code: 1 };
}

/** The screen shows at most MAX_SCREEN characters of one command line: the end, as a terminal would. */
function screenText(text: string): string {
  if (text.length <= MAX_SCREEN) return text;
  let tail = text.slice(-MAX_SCREEN);
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < tail.length - 1) tail = tail.slice(nl + 1);
  const hidden = text.slice(0, text.length - tail.length).split('\n').length - 1;
  return `[${hidden} earlier lines not shown (practice terminal limit)]\n${tail}`;
}

/** The one plain command of a parsed text (no assignments, redirections, pipes or lists), or null. */
function onlySimple(prog: ParseResult): SimpleCommand | null {
  if (prog.error || prog.commands.length !== 1) return null;
  const list = prog.commands[0].list;
  if (list.length !== 1 || list[0].rest.length || list[0].background) return null;
  const pl = list[0].first;
  const c = pl.cmds[0];
  if (pl.cmds.length !== 1 || pl.bang || pl.time || c.type !== 'simple' || c.assigns.length || c.redirects.length) return null;
  return c;
}

/** Quote a word the way set -x shows it. */
function shQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Join the lines of a multi-line command into one history entry, as bash does with cmdhist. */
function joinHistory(p: { hist: string; reason: Incomplete; last: string }, line: string): string {
  if (p.reason === 'quote' || p.reason === 'heredoc') return `${p.hist}\n${line}`;
  const t = line.trim();
  if (p.reason === 'backslash') return p.hist.replace(/\\$/, '') + line;
  if (!t) return p.hist;
  if (t.startsWith('#') || /(^|\s)#/.test(p.last)) return `${p.hist}\n${t}`;
  const prev = p.hist.trimEnd();
  const glue = /(^|[\s;&|(){}])(do|then|else|elif|if|while|until|in|\{|!|time)$|(\|\||&&|[|;(&])$/.test(prev) ? ' ' : '; ';
  return prev + glue + t;
}

/** Split an unquoted expansion on IFS. */
export function splitIFS(s: string, ifs: string): { fields: string[]; lead: boolean; trail: boolean } {
  if (ifs === '') return { fields: s ? [s] : [], lead: false, trail: false };
  const isWs = (c: string) => (c === ' ' || c === '\t' || c === '\n') && ifs.includes(c);
  const isSep = (c: string) => ifs.includes(c);
  const fields: string[] = [];
  let i = 0;
  while (i < s.length && isWs(s[i])) i++;
  const lead = i > 0;
  let cur = '';
  let trail = lead && i >= s.length;
  while (i < s.length) {
    const c = s[i];
    if (!isSep(c)) {
      cur += c;
      i++;
      trail = false;
      continue;
    }
    fields.push(cur);
    cur = '';
    if (isWs(c)) {
      while (i < s.length && isWs(s[i])) i++;
      if (i < s.length && isSep(s[i]) && !isWs(s[i])) {
        i++;
        while (i < s.length && isWs(s[i])) i++;
      }
    } else {
      i++;
      while (i < s.length && isWs(s[i])) i++;
    }
    trail = true;
  }
  if (cur) fields.push(cur);
  return { fields, lead, trail };
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === sep) return [s.slice(0, i), s.slice(i + 1)];
    else i++;
  }
  return [s, undefined];
}

const escapeGlob = (s: string) => s.replace(/[\\*?[\]]/g, '\\$&');
const hasGlob = (s: string) => /(^|[^\\])(\\\\)*[*?[]/.test(s);
const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const POSIX_CLASSES: Record<string, string> = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w' };

/** Turn a glob pattern (backslash escapes a character) into an anchored regular expression. */
export function globRegex(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) re += escapeRe(p[++i]);
    else if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') {
      let j = i + 1;
      if (p[j] === '!' || p[j] === '^') j++;
      if (p[j] === ']') j++;
      while (j < p.length && p[j] !== ']') j += p.startsWith('[:', j) && p.indexOf(':]', j + 2) > 0 ? p.indexOf(':]', j + 2) + 2 - j : 1;
      if (j >= p.length) {
        re += '\\[';
        continue;
      }
      let body = p.slice(i + 1, j);
      let neg = '';
      if (body[0] === '!' || body[0] === '^') {
        neg = '^';
        body = body.slice(1);
      }
      let cls = '';
      for (let k = 0; k < body.length; k++) {
        const m = /^\[:(\w+):\]/.exec(body.slice(k));
        if (m) {
          cls += POSIX_CLASSES[m[1]] ?? '';
          k += m[0].length - 1;
        } else if (body[k] === '\\' && k + 1 < body.length) cls += '\\' + body[++k];
        else cls += body[k] === '-' ? '-' : body[k].replace(/[\]\\^[]/g, '\\$&');
      }
      re += `[${neg}${cls}]`;
      i = j;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(s: string, pattern: string): boolean {
  try {
    return globRegex(pattern).test(s);
  } catch {
    return s === pattern;
  }
}

function removeAffix(val: string, pattern: string, prefix: boolean, longest: boolean): string {
  let re: RegExp;
  try {
    re = globRegex(pattern);
  } catch {
    return val;
  }
  const n = val.length;
  for (let step = 0; step <= n; step++) {
    const k = longest ? n - step : step;
    if (prefix ? re.test(val.slice(0, k)) : re.test(val.slice(n - k))) return prefix ? val.slice(k) : val.slice(0, n - k);
  }
  return val;
}

function replacePattern(val: string, pattern: string, rep: string, op: string): string {
  if (pattern === '') return val;
  let re: RegExp;
  try {
    re = globRegex(pattern);
  } catch {
    return val;
  }
  const n = val.length;
  if (op === '/#') {
    for (let k = n; k >= 0; k--) if (re.test(val.slice(0, k))) return rep + val.slice(k);
    return val;
  }
  if (op === '/%') {
    for (let k = 0; k <= n; k++) if (re.test(val.slice(k))) return val.slice(0, k) + rep;
    return val;
  }
  let out = '';
  let i = 0;
  let replaced = false;
  while (i < n) {
    let hit = -1;
    if (!replaced || op === '//') for (let k = n; k > i && hit < 0; k--) if (re.test(val.slice(i, k))) hit = k;
    if (hit > 0) {
      out += rep;
      i = hit;
      replaced = true;
    } else out += val[i++];
  }
  return out;
}

/** Find the first brace expression {a,b} or {1..5} in an unquoted text. */
function findBrace(s: string): { start: number; end: number; alts: string[] } | null {
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) break;
      else if (s[j] === ',' && depth === 1) commas.push(j);
    }
    if (j >= s.length) continue;
    if (commas.length) {
      const alts: string[] = [];
      let from = i + 1;
      for (const c of [...commas, j]) {
        alts.push(s.slice(from, c));
        from = c + 1;
      }
      return { start: i, end: j, alts };
    }
    const range = braceRange(s.slice(i + 1, j));
    if (range) return { start: i, end: j, alts: range };
  }
  return null;
}

function braceRange(inner: string): string[] | null {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const step = Math.abs(Number(m[3] ?? 1)) || 1;
    const width = /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]) ? Math.max(m[1].length, m[2].length) : 0;
    if (Math.abs(b - a) / step > MAX_WORDS) throw new ExpansionError(`brace expansion: more than ${MAX_WORDS} words (practice terminal limit)`);
    const out: string[] = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(width ? (v < 0 ? '-' + String(-v).padStart(width - 1, '0') : String(v).padStart(width, '0')) : String(v));
    return out;
  }
  m = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/.exec(inner);
  if (m) {
    const [a, b] = [m[1].charCodeAt(0), m[2].charCodeAt(0)];
    const step = Math.abs(Number(m[3] ?? 1)) || 1;
    const out: string[] = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(String.fromCharCode(v));
    return out;
  }
  return null;
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

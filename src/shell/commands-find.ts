// find as GNU findutils 4.10 on RHEL 10 runs it, for what RHCSA work uses: tests on name, type,
// owner, permissions, size and age, the operators ! -a -o and ( ), -maxdepth/-mindepth, and the
// actions -print, -delete and -exec (with \; and +), as in "find / -user anna -exec cp {} /root/found \;".

import type { CommandContext, CommandResult } from './commands';
import { FsError, FsNode, canAccess, errorText } from './fs';
import type { Chunk, Shell } from './shell';

type Command = (ctx: CommandContext) => CommandResult;

const fail = (stderr: string, code = 1): CommandResult => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code });

/** One file as the expression sees it. */
interface Item {
  path: string;
  name: string;
  node: FsNode;
  depth: number;
}

/** Evaluation state shared by one find run. */
interface Run {
  sh: Shell;
  log: Chunk[]; // stdout (1) and stderr (2) in the order written
  failed: boolean;
  prune: boolean;
  quit: boolean;
  batches: { argv: string[]; at: number; paths: string[] }[];
}

type Pred = (it: Item, run: Run) => boolean;

class Usage extends Error {}

const MAX_EXEC = 5000; // -exec runs per find (practice terminal limit)
const DAY = 86_400_000;

/** fnmatch without FNM_PERIOD or FNM_PATHNAME: * matches dot files and, for -path, slashes too. */
function fnmatchRegex(pattern: string, icase: boolean): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') src += '[\\s\\S]*';
    else if (c === '?') src += '[\\s\\S]';
    else if (c === '\\' && i + 1 < pattern.length) src += escapeRe(pattern[++i]);
    else if (c === '[') {
      const end = pattern.indexOf(']', i + (pattern[i + 1] === '!' || pattern[i + 1] === '^' ? 3 : 2));
      if (end < 0) {
        src += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      body = body.replace(/\[:(alpha|digit|alnum|upper|lower|space|punct|xdigit):\]/g, (_, k: string) => CLASSES[k]).replace(/\\(?![dws\]-])/g, '\\\\');
      src += `[${neg ? '^' : ''}${body.replace(/^\]/, '\\]')}]`;
      i = end;
    } else src += escapeRe(c);
  }
  return new RegExp(`^${src}$`, icase ? 'i' : '');
}
const CLASSES: Record<string, string> = { alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', punct: '!-/:-@[-`{-~', xdigit: '0-9A-Fa-f' };
const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** +N, -N or N against a value: more than, less than, exactly. */
function numeric(arg: string, flag: string): (v: number) => boolean {
  const m = /^([+-]?)(\d+)$/.exec(arg);
  if (!m) throw new Usage(`find: invalid argument \`${arg}' to \`${flag}'`);
  const n = Number(m[2]);
  return m[1] === '+' ? (v) => v > n : m[1] === '-' ? (v) => v < n : (v) => v === n;
}

/** Octal or symbolic (u+s, g=w,o=r) permission bits, as -perm reads them. */
function permBits(text: string): number | null {
  if (/^[0-7]{1,4}$/.test(text)) return parseInt(text, 8);
  let mode = 0;
  for (const clause of text.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxst]*)$/.exec(clause);
    if (!m) return null;
    const who = m[1] || 'a';
    let bits = 0;
    for (const p of m[3]) {
      for (const w of who === 'a' ? 'ugo' : who) {
        const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
        if (p === 'r') bits |= 4 << shift;
        else if (p === 'w') bits |= 2 << shift;
        else if (p === 'x') bits |= 1 << shift;
        else if (p === 's' && w !== 'o') bits |= w === 'u' ? 0o4000 : 0o2000;
        else if (p === 't') bits |= 0o1000;
      }
    }
    if (m[2] === '-') mode &= ~bits;
    else mode |= bits;
  }
  return mode;
}

const SIZE_UNITS: Record<string, number> = { c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function nodeType(n: FsNode): string {
  return n.type === 'dir' ? 'd' : n.type === 'link' ? 'l' : 'f';
}

function nodeSize(n: FsNode): number {
  if (n.type === 'dir') return 6 + Object.keys(n.children!).length * 20;
  if (n.type === 'link') return n.target!.length;
  return (n.content ?? '').length;
}

/** Parse the expression after the start points: or-list of and-lists of (possibly negated) primaries. */
class ExprParser {
  private i = 0;
  hasAction = false;
  maxDepth = Infinity;
  minDepth = 0;
  depthFirst = false;
  warnings: string[] = [];
  private lastTest: string | null = null;

  constructor(
    private args: string[],
    private sh: Shell,
  ) {}

  parse(): Pred {
    if (this.i >= this.args.length) return () => true;
    const e = this.or();
    if (this.i < this.args.length) {
      const a = this.args[this.i];
      throw new Usage(a === ')' ? "find: invalid expression; you have too many ')'" : `find: paths must precede expression: \`${a}'`);
    }
    return e;
  }

  private peek() {
    return this.args[this.i];
  }

  private or(): Pred {
    let left = this.and();
    while (this.peek() === '-o' || this.peek() === '-or') {
      const op = this.args[this.i++];
      if (this.i >= this.args.length || this.peek() === ')') throw new Usage(`find: invalid expression; you have used a binary operator '${op}' with nothing after it.`);
      const l = left;
      const r = this.and();
      left = (it, run) => l(it, run) || r(it, run);
    }
    return left;
  }

  private and(): Pred {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t === undefined || t === ')' || t === '-o' || t === '-or') return left;
      if (t === '-a' || t === '-and') {
        this.i++;
        if (this.i >= this.args.length) throw new Usage(`find: invalid expression; you have used a binary operator '${t}' with nothing after it.`);
      }
      const l = left;
      const r = this.unary();
      left = (it, run) => l(it, run) && r(it, run);
    }
  }

  private unary(): Pred {
    const t = this.args[this.i];
    if (t === '-o' || t === '-or' || t === '-a' || t === '-and') throw new Usage(`find: invalid expression; you have used a binary operator '${t}' with nothing before it.`);
    if (t === '!' || t === '-not') {
      this.i++;
      if (this.i >= this.args.length) throw new Usage(`find: invalid expression; '${t}' with nothing after it.`);
      const p = this.unary();
      return (it, run) => !p(it, run);
    }
    if (t === '(') {
      this.i++;
      if (this.peek() === ')') throw new Usage("find: invalid expression; empty parentheses are not allowed.");
      const p = this.or();
      if (this.args[this.i] !== ')') throw new Usage("find: invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      this.i++;
      return p;
    }
    this.i++;
    return this.primary(t);
  }

  private value(flag: string): string {
    const v = this.args[this.i++];
    if (v === undefined) throw new Usage(`find: missing argument to \`${flag}'`);
    return v;
  }

  private global(flag: string) {
    if (this.lastTest) {
      this.warnings.push(
        `find: warning: you have specified the global option ${flag} after the argument ${this.lastTest}, but global options are not positional, i.e., ${flag} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.\n`,
      );
    }
  }

  private primary(flag: string): Pred {
    const sh = this.sh;
    const test = (p: Pred): Pred => {
      this.lastTest ??= flag;
      return p;
    };
    switch (flag) {
      case '-name':
      case '-iname': {
        const pat = this.value(flag);
        const re = fnmatchRegex(pat, flag === '-iname');
        if (pat.includes('/') && !pat.endsWith('/'))
          this.warnings.push(`find: warning: ${flag} matches against basenames only, but the given pattern contains a directory separator (\`/'), thus the expression will evaluate to false all the time.  Did you mean -wholename?\n`);
        return test((it) => re.test(it.name));
      }
      case '-path':
      case '-ipath':
      case '-wholename':
      case '-iwholename': {
        const re = fnmatchRegex(this.value(flag), flag.startsWith('-i'));
        return test((it) => re.test(it.path));
      }
      case '-type': {
        const v = this.value(flag);
        const kinds = v.split(',');
        for (const k of kinds) if (!/^[bcdpflsD]$/.test(k)) throw new Usage(`find: Unknown argument to -type: ${k}`);
        return test((it) => kinds.includes(nodeType(it.node)));
      }
      case '-user': {
        const v = this.value(flag);
        const u = sh.state.users.find((x) => x.name === v) ?? (/^\d+$/.test(v) ? { uid: Number(v) } : null);
        if (!u) throw new Usage(`find: ‘${v}’ is not the name of a known user`);
        return test((it) => it.node.uid === u.uid);
      }
      case '-group': {
        const v = this.value(flag);
        const g = sh.state.groups.find((x) => x.name === v) ?? (/^\d+$/.test(v) ? { gid: Number(v) } : null);
        if (!g) throw new Usage(`find: ‘${v}’ is not the name of an existing group`);
        return test((it) => it.node.gid === g.gid);
      }
      case '-uid':
      case '-gid': {
        const cmp = numeric(this.value(flag), flag);
        return test((it) => cmp(flag === '-uid' ? it.node.uid : it.node.gid));
      }
      case '-nouser':
        return test((it) => !sh.state.users.some((u) => u.uid === it.node.uid));
      case '-nogroup':
        return test((it) => !sh.state.groups.some((g) => g.gid === it.node.gid));
      case '-perm': {
        const v = this.value(flag);
        const kind = v[0] === '-' || v[0] === '/' ? v[0] : '';
        const want = permBits(kind ? v.slice(1) : v);
        if (want === null) throw new Usage(`find: invalid mode ‘${v}’`);
        return test((it) => {
          const m = it.node.mode & 0o7777;
          if (kind === '-') return (m & want) === want;
          if (kind === '/') return want === 0 || (m & want) !== 0;
          return m === want;
        });
      }
      case '-size': {
        const v = this.value(flag);
        const m = /^([+-]?)(\d+)([cwbkMG]?)$/.exec(v);
        if (!m) throw new Usage(`find: invalid -size type \`${v.replace(/^[+-]?\d*/, '') || v}'`);
        const unit = SIZE_UNITS[m[3] || 'b'];
        const cmp = numeric(m[1] + m[2], flag);
        // the size is rounded up to whole units, so -size -1M only matches empty files
        return test((it) => cmp(Math.ceil(nodeSize(it.node) / unit)));
      }
      case '-empty':
        return test((it) => (it.node.type === 'dir' ? Object.keys(it.node.children!).length === 0 : it.node.type === 'file' && !it.node.content));
      case '-mtime':
      case '-mmin':
      case '-ctime':
      case '-cmin':
      case '-atime':
      case '-amin': {
        const cmp = numeric(this.value(flag), flag);
        const per = flag.endsWith('min') ? 60_000 : DAY;
        const now = Date.now();
        return test((it) => cmp(Math.floor((now - it.node.mtime) / per)));
      }
      case '-newer': {
        const ref = this.value(flag);
        let t: number;
        try {
          t = sh.resolve(ref).node.mtime;
        } catch (e) {
          throw new Usage(`find: ‘${ref}’: ${e instanceof FsError ? errorText[e.reason] : String(e)}`);
        }
        return test((it) => it.node.mtime > t);
      }
      case '-links': {
        const cmp = numeric(this.value(flag), flag);
        return test((it) => cmp(it.node.type === 'dir' ? 2 + Object.values(it.node.children!).filter((c) => c.type === 'dir').length : 1));
      }
      case '-readable':
      case '-writable':
      case '-executable': {
        const perm = flag === '-readable' ? 'r' : flag === '-writable' ? 'w' : 'x';
        return test((it) => canAccess(it.node, perm, sh.uid, sh.gids));
      }
      case '-true':
        return () => true;
      case '-false':
        return () => false;
      case '-maxdepth':
      case '-mindepth': {
        const v = this.value(flag);
        if (!/^\d+$/.test(v)) throw new Usage(`find: Expected a positive decimal integer argument to ${flag}, but got ‘${v}’`);
        this.global(flag);
        if (flag === '-maxdepth') this.maxDepth = Number(v);
        else this.minDepth = Number(v);
        return () => true;
      }
      case '-depth':
      case '-d':
        this.depthFirst = true;
        return () => true;
      case '-xdev':
      case '-mount':
      case '-noleaf':
      case '-ignore_readdir_race':
        this.global(flag);
        return () => true;
      case '-print':
        this.hasAction = true;
        return (it, run) => {
          run.log.push([1, it.path + '\n']);
          return true;
        };
      case '-print0':
        this.hasAction = true;
        return (it, run) => {
          run.log.push([1, it.path + '\0']);
          return true;
        };
      case '-prune':
        return (_it, run) => {
          run.prune = true;
          return true;
        };
      case '-quit':
        return (_it, run) => {
          run.quit = true;
          return true;
        };
      case '-delete':
        this.hasAction = true;
        this.depthFirst = true;
        return (it, run) => {
          const r = it.node.type === 'dir' ? sh.exec(['rmdir', it.path]) : sh.exec(['rm', '-f', it.path]);
          if (r.code === 0) return true;
          const why = /: ([^:\n]+)\n?$/.exec(r.stderr)?.[1] ?? 'Operation not permitted';
          run.log.push([2, `find: cannot delete ‘${it.path}’: ${why}\n`]);
          run.failed = true;
          return false;
        };
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir':
        return this.exec(flag);
      case '-ls':
      case '-printf':
      case '-fprint':
      case '-regex':
      case '-iregex':
        throw new Usage(`find: ${flag} is not available in the practice terminal`);
      default:
        if (flag.startsWith('-')) throw new Usage(`find: unknown predicate \`${flag}'`);
        throw new Usage(`find: paths must precede expression: \`${flag}'`);
    }
  }

  /** -exec CMD ARGS ; runs once per file ({} is the path); -exec CMD ARGS {} + runs with many paths at once. */
  private exec(flag: string): Pred {
    const start = this.i;
    let end = start;
    let plus = false;
    for (; end < this.args.length; end++) {
      if (this.args[end] === ';') break;
      if (this.args[end] === '+' && this.args[end - 1] === '{}') {
        plus = true;
        break;
      }
    }
    if (end >= this.args.length || end === start) throw new Usage(`find: missing argument to \`${flag}'`);
    if (flag.startsWith('-ok')) throw new Usage(`find: ${flag} asks before each command, which the practice terminal cannot do; use -exec`);
    const argv = this.args.slice(start, end);
    this.i = end + 1;
    this.hasAction = true;
    const sh = this.sh;
    const dirMode = flag === '-execdir';
    if (plus) {
      const fixed = argv.slice(0, -1);
      if (fixed.includes('{}')) throw new Usage(`find: Only one instance of {} is supported with ${flag} ... +`);
      const batch = { argv: fixed, at: 0, paths: [] as string[] };
      let added = false;
      return (it, run) => {
        if (!added) {
          run.batches.push(batch);
          added = true;
        }
        batch.paths.push(dirMode ? `./${it.name}` : it.path);
        return true;
      };
    }
    let runs = 0;
    return (it, run) => {
      if (++runs > MAX_EXEC) {
        if (runs === MAX_EXEC + 1) run.log.push([2, `find: stopped after running ${MAX_EXEC} commands (practice terminal limit)\n`]);
        run.quit = true;
        return false;
      }
      const p = dirMode ? `./${it.name}` : it.path;
      const r = sh.exec(argv.map((a) => a.split('{}').join(p)));
      if (r.stdout) run.log.push([1, r.stdout]);
      if (r.stderr) run.log.push([2, r.stderr]);
      return r.code === 0;
    };
  }
}

export const find: Command = ({ sh, args }) => {
  let i = 0;
  while (args[i] === '-P' || args[i] === '-H' || args[i] === '-L') i++;
  const starts: string[] = [];
  while (i < args.length && !(args[i].startsWith('-') && args[i].length > 1) && args[i] !== '(' && args[i] !== '!') starts.push(args[i++]);
  if (!starts.length) starts.push('.');
  const parser = new ExprParser(args.slice(i), sh);
  let pred: Pred;
  try {
    pred = parser.parse();
  } catch (e) {
    if (e instanceof Usage) return fail(e.message);
    throw e;
  }
  const run: Run = { sh, log: parser.warnings.map((w): Chunk => [2, w]), failed: false, prune: false, quit: false, batches: [] };
  const evalItem = (it: Item) => {
    if (it.depth < parser.minDepth) return;
    if (pred(it, run) && !parser.hasAction) run.log.push([1, it.path + '\n']);
  };
  const visit = (it: Item) => {
    if (run.quit) return;
    run.prune = false;
    if (!parser.depthFirst) evalItem(it);
    const pruned = run.prune;
    const node = it.node;
    if (node.type === 'dir' && !pruned && it.depth < parser.maxDepth && !run.quit) {
      if (!canAccess(node, 'r', sh.uid, sh.gids) || !canAccess(node, 'x', sh.uid, sh.gids)) {
        run.log.push([2, `find: ‘${it.path}’: Permission denied\n`]);
        run.failed = true;
      } else {
        for (const name of Object.keys(node.children!).sort()) {
          const child = node.children![name];
          if (!child) continue; // removed by -delete or -exec rm
          visit({ path: it.path.endsWith('/') ? it.path + name : `${it.path}/${name}`, name, node: child, depth: it.depth + 1 });
          if (run.quit) return;
        }
      }
    }
    if (parser.depthFirst && !run.quit) evalItem(it);
  };
  for (const start of starts) {
    let node: FsNode;
    try {
      node = sh.resolve(start, false).node;
    } catch (e) {
      run.log.push([2, `find: ‘${start}’: ${e instanceof FsError ? errorText[e.reason] : String(e)}\n`]);
      run.failed = true;
      continue;
    }
    const name = start === '/' ? '/' : start.replace(/\/+$/, '').split('/').pop() || start;
    visit({ path: start, name, node, depth: 0 });
    if (run.quit) break;
  }
  for (const b of run.batches) {
    for (let k = 0; k < b.paths.length; k += 1000) {
      const r = sh.exec([...b.argv, ...b.paths.slice(k, k + 1000)]);
      if (r.stdout) run.log.push([1, r.stdout]);
      if (r.stderr) run.log.push([2, r.stderr]);
      if (r.code !== 0) run.failed = true;
    }
  }
  return sh.interleaved(run.log, run.failed ? 1 : 0);
};

export const FIND_COMMANDS: Record<string, Command> = { find };

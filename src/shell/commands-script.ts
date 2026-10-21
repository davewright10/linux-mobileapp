// Commands for the Bash scripting objectives: printf, read, seq, expr, basename, dirname, sleep,
// bash/sh, source/., let, :, export, type, which, env, and a fuller test/[ (with -a/-o, ! and ( ),
// bash's error messages and the file tests). The shell itself (if, for, while, case, functions,
// $(...)) is in shell.ts and parser.ts.

import type { CommandContext, CommandResult } from './commands';
import { FsNode, canAccess } from './fs';
import { ArithError, cEscape, isName } from './parser';
import type { ScriptOptions, Shell } from './shell';
import { findDevice } from './storage-state';

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1, stdout = ''): CommandResult => ({
  stdout,
  stderr: stderr.endsWith('\n') ? stderr : stderr + '\n',
  code,
});
const status = (code: number, stderr = ''): CommandResult => ({ stdout: '', stderr, code });

// ---------- test and [ ----------

class TestError extends Error {}

const CHAR_DEVICES = new Set(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/console', '/dev/full']);
const FILE_OPS = new Set(['-e', '-a', '-f', '-d', '-L', '-h', '-b', '-c', '-p', '-S', '-r', '-w', '-x', '-s', '-u', '-g', '-k', '-O', '-G', '-N']);
const TEST_BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

function nodeAt(sh: Shell, path: string, follow = true): FsNode | null {
  try {
    return sh.resolve(path, follow).node;
  } catch {
    return null;
  }
}

/** A unary test (-f FILE, -z STRING, ...) as test, [ and [[ do it; undefined if `op` is not one. */
export function unaryTest(sh: Shell, op: string, arg: string): boolean | undefined {
  switch (op) {
    case '-z':
      return arg === '';
    case '-n':
      return arg !== '';
    case '-v':
      return sh.isVarSet(arg);
    case '-o':
      return sh.optionOn(arg);
    case '-t':
      return false;
  }
  if (!FILE_OPS.has(op)) return undefined;
  const n = nodeAt(sh, arg);
  const block = arg.startsWith('/dev/') && !!findDevice(sh.state.storage, arg);
  const char = CHAR_DEVICES.has(arg);
  const device = block || char;
  const can = (p: 'r' | 'w' | 'x') => (n ? canAccess(n, p, sh.uid, sh.gids) : device && (p !== 'x' && (sh.uid === 0 || char)));
  switch (op) {
    case '-e':
    case '-a':
      return !!n || device;
    case '-f':
      return n?.type === 'file' && !device;
    case '-d':
      return n?.type === 'dir';
    case '-L':
    case '-h':
      return nodeAt(sh, arg, false)?.type === 'link';
    case '-b':
      return block;
    case '-c':
      return char;
    case '-r':
      return can('r');
    case '-w':
      return can('w');
    case '-x':
      return can('x');
    case '-s': {
      if (block) return true;
      if (!n) return false;
      if (n.type === 'dir') return true;
      try {
        return sh.readFile(arg).length > 0;
      } catch {
        return (n.content ?? '').length > 0;
      }
    }
    case '-u':
      return !!n && (n.mode & 0o4000) !== 0;
    case '-g':
      return !!n && (n.mode & 0o2000) !== 0;
    case '-k':
      return !!n && (n.mode & 0o1000) !== 0;
    case '-O':
      return !!n && n.uid === sh.uid;
    case '-G':
      return !!n && n.gid === sh.user.gid;
    case '-N':
      return !!n;
  }
  return false;
}

/** FILE1 -nt/-ot/-ef FILE2; undefined if `op` is not one of those. */
export function binaryTest(sh: Shell, op: string, a: string, b: string): boolean | undefined {
  if (op !== '-nt' && op !== '-ot' && op !== '-ef') return undefined;
  const na = nodeAt(sh, a);
  const nb = nodeAt(sh, b);
  if (op === '-ef') return !!na && !!nb && na.inode === nb.inode;
  if (op === '-nt') return !!na && (!nb || na.mtime > nb.mtime);
  return !!nb && (!na || na.mtime < nb.mtime);
}

function testInt(s: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(s)) throw new TestError(`${s}: integer expression expected`);
  return parseInt(s, 10);
}

function testBinary(sh: Shell, x: string, op: string, y: string): boolean {
  switch (op) {
    case '=':
    case '==':
      return x === y;
    case '!=':
      return x !== y;
    case '<':
      return x < y;
    case '>':
      return x > y;
    case '-eq':
      return testInt(x) === testInt(y);
    case '-ne':
      return testInt(x) !== testInt(y);
    case '-lt':
      return testInt(x) < testInt(y);
    case '-le':
      return testInt(x) <= testInt(y);
    case '-gt':
      return testInt(x) > testInt(y);
    case '-ge':
      return testInt(x) >= testInt(y);
  }
  return binaryTest(sh, op, x, y) ?? false;
}

/** The general expression grammar test uses for more than four arguments. */
class TestParser {
  private i = 0;
  constructor(
    private sh: Shell,
    private a: string[],
  ) {}

  run(): boolean {
    const v = this.or();
    if (this.i < this.a.length) throw new TestError('too many arguments');
    return v;
  }
  private or(): boolean {
    let v = this.and();
    while (this.a[this.i] === '-o') {
      this.i++;
      const r = this.and();
      v = v || r;
    }
    return v;
  }
  private and(): boolean {
    let v = this.not();
    while (this.a[this.i] === '-a') {
      this.i++;
      const r = this.not();
      v = v && r;
    }
    return v;
  }
  private not(): boolean {
    if (this.a[this.i] === '!') {
      this.i++;
      return !this.not();
    }
    return this.primary();
  }
  private primary(): boolean {
    const x = this.a[this.i];
    if (x === undefined) throw new TestError('argument expected');
    if (x === '(') {
      this.i++;
      const v = this.or();
      if (this.a[this.i] !== ')') throw new TestError("`)' expected");
      this.i++;
      return v;
    }
    const op = this.a[this.i + 1];
    if (op !== undefined && TEST_BINARY.has(op) && this.a[this.i + 2] !== undefined) {
      this.i += 3;
      return testBinary(this.sh, x, op, this.a[this.i - 1]);
    }
    if (op !== undefined && (FILE_OPS.has(x) || ['-z', '-n', '-v', '-o', '-t'].includes(x)) && x !== '-a' && x !== '-o') {
      this.i += 2;
      return unaryTest(this.sh, x, op)!;
    }
    this.i++;
    return x !== '';
  }
}

function evalTest(sh: Shell, a: string[]): boolean {
  const one = (x: string) => x !== '';
  const two = (x: string, y: string) => {
    if (x === '!') return !one(y);
    const r = unaryTest(sh, x, y);
    if (r === undefined) throw new TestError(`${x}: unary operator expected`);
    return r;
  };
  const three = (x: string, op: string, y: string) => {
    if (TEST_BINARY.has(op)) return testBinary(sh, x, op, y);
    if (op === '-a') return one(x) && one(y);
    if (op === '-o') return one(x) || one(y);
    if (x === '!') return !two(op, y);
    if (x === '(' && y === ')') return one(op);
    throw new TestError(`${op}: binary operator expected`);
  };
  switch (a.length) {
    case 0:
      return false;
    case 1:
      return one(a[0]);
    case 2:
      return two(a[0], a[1]);
    case 3:
      return three(a[0], a[1], a[2]);
    case 4:
      if (a[0] === '!') return !three(a[1], a[2], a[3]);
      if (a[0] === '(' && a[3] === ')') return two(a[1], a[2]);
  }
  return new TestParser(sh, a).run();
}

const test: Command = ({ sh, args, name }) => {
  let a = args;
  if (name === '[') {
    if (a[a.length - 1] !== ']') return fail("-bash: [: missing `]'", 2);
    a = a.slice(0, -1);
  }
  try {
    return status(evalTest(sh, a) ? 0 : 1);
  } catch (e) {
    if (e instanceof TestError) return fail(`-bash: ${name}: ${e.message}`, 2);
    throw e;
  }
};

// ---------- printf ----------

function shellQuote(s: string): string {
  if (s === '') return "''";
  return s.replace(/[^A-Za-z0-9_@%+=:,./-]/g, (c) => (c === '\n' ? "$'\\n'" : '\\' + c));
}

/** Escapes for printf's format and %b: \n \t \\ \0NNN \xHH ... `\c` stops all output. */
function escapes(s: string, octalNeedsZero: boolean): { text: string; stop: boolean } {
  let text = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      text += s[i];
      continue;
    }
    if (s[i + 1] === 'c') return { text, stop: true };
    const [ch, len] = cEscape(s, i + 1, octalNeedsZero);
    text += ch;
    i += len;
  }
  return { text, stop: false };
}

function cExp(x: number, prec: number): string {
  return x.toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2');
}

function cG(x: number, prec: number, alt: boolean): string {
  const p = prec === 0 ? 1 : prec;
  if (x === 0) return alt ? (0).toFixed(p - 1) : '0';
  const e = Number(x.toExponential(p - 1).split('e')[1]);
  let s = e < -4 || e >= p ? cExp(x, p - 1) : x.toFixed(Math.max(0, p - 1 - e));
  if (!alt && s.includes('.')) s = s.replace(/\.?0+(e|$)/, '$1');
  return s;
}

/** Format like printf(1). Returns the output, any error text, and whether \c stopped the output. */
export function formatPrintf(fmt: string, args: string[]): { out: string; err: string } {
  let out = '';
  let err = '';
  let ai = 0;
  let stop = false;
  const next = () => args[ai++];
  const num = (s: string | undefined): number => {
    if (s === undefined || s === '') return 0;
    if (/^['"]/.test(s)) return s.length > 1 ? s.codePointAt(1)! : 0;
    const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(s);
    const v = m ? (m[1] === '-' ? -1 : 1) * (m[2].startsWith('0x') || m[2].startsWith('0X') ? parseInt(m[2], 16) : m[2].startsWith('0') ? parseInt(m[2], 8) || 0 : parseInt(m[2], 10)) : 0;
    if (!m || m[0].length !== s.length) err += `-bash: printf: ${s}: invalid number\n`;
    return v;
  };
  const float = (s: string | undefined): number => {
    if (s === undefined || s === '') return 0;
    if (/^['"]/.test(s)) return s.length > 1 ? s.codePointAt(1)! : 0;
    const v = Number(s.trim());
    if (Number.isNaN(v) && !/^\s*[+-]?(nan|inf(inity)?)\s*$/i.test(s)) {
      err += `-bash: printf: ${s}: invalid number\n`;
      return parseFloat(s) || 0;
    }
    return /inf/i.test(s) ? (s.includes('-') ? -Infinity : Infinity) : v;
  };
  const pad = (s: string, width: number | undefined, left: boolean, zero = false) => {
    if (width === undefined || s.length >= width) return s;
    if (left) return s.padEnd(width);
    if (zero) {
      const sign = /^[+\- ]|^0[xX]/.exec(s)?.[0] ?? '';
      return sign + s.slice(sign.length).padStart(width - sign.length, '0');
    }
    return s.padStart(width);
  };
  do {
    const start = ai;
    for (let i = 0; i < fmt.length && !stop; i++) {
      const c = fmt[i];
      if (c === '\\' && i + 1 < fmt.length) {
        if (fmt[i + 1] === 'c') {
          stop = true;
          break;
        }
        const [ch, len] = cEscape(fmt, i + 1);
        out += ch;
        i += len;
        continue;
      }
      if (c !== '%') {
        out += c;
        continue;
      }
      const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([diouxXfFeEgGcsbq%])/.exec(fmt.slice(i));
      if (!m) {
        err += `-bash: printf: \`${fmt[i + 1] ?? '%'}': ${fmt[i + 1] === undefined ? 'missing format character' : 'invalid format character'}\n`;
        return { out, err };
      }
      i += m[0].length - 1;
      const conv = m[4];
      if (conv === '%') {
        out += '%';
        continue;
      }
      let flags = m[1];
      let width = m[2] === '*' ? num(next()) : m[2] ? Number(m[2]) : undefined;
      if (width !== undefined && width < 0) {
        flags += '-';
        width = -width;
      }
      const precRaw = m[3] === undefined ? undefined : m[3] === '*' ? num(next()) : Number(m[3] || 0);
      const prec = precRaw !== undefined && precRaw < 0 ? undefined : precRaw;
      const left = flags.includes('-');
      const zero = flags.includes('0') && !left;
      const arg = next();
      const sign = (v: number, s: string) => (v < 0 || Object.is(v, -0) ? s : flags.includes('+') ? '+' + s : flags.includes(' ') ? ' ' + s : s);
      switch (conv) {
        case 's':
          out += pad(prec === undefined ? (arg ?? '') : (arg ?? '').slice(0, prec), width, left);
          break;
        case 'q':
          out += pad(shellQuote(arg ?? ''), width, left);
          break;
        case 'b': {
          const r = escapes(arg ?? '', true);
          out += pad(prec === undefined ? r.text : r.text.slice(0, prec), width, left);
          if (r.stop) stop = true;
          break;
        }
        case 'c':
          out += pad((arg ?? '').slice(0, 1), width, left);
          break;
        case 'd':
        case 'i': {
          const v = num(arg);
          let digits = String(Math.abs(v));
          if (prec !== undefined) digits = digits.padStart(prec, '0');
          out += pad(sign(v, (v < 0 ? '-' : '') + digits), width, left, zero && prec === undefined);
          break;
        }
        case 'u':
        case 'o':
        case 'x':
        case 'X': {
          const v = num(arg);
          const base = conv === 'o' ? 8 : conv === 'u' ? 10 : 16;
          let digits = v < 0 ? BigInt.asUintN(64, BigInt(v)).toString(base) : v.toString(base);
          if (conv === 'X') digits = digits.toUpperCase();
          if (prec !== undefined) digits = digits.padStart(prec, '0');
          if (flags.includes('#') && v !== 0) digits = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + digits;
          out += pad(digits, width, left, zero && prec === undefined);
          break;
        }
        default: {
          // f F e E g G
          const v = float(arg);
          const p = prec ?? 6;
          let s: string;
          if (!Number.isFinite(v)) s = Number.isNaN(v) ? 'nan' : v < 0 ? '-inf' : 'inf';
          else if (conv === 'f' || conv === 'F') s = v.toFixed(p);
          else if (conv === 'e' || conv === 'E') s = cExp(v, p);
          else s = cG(v, p, flags.includes('#'));
          if (conv === 'E' || conv === 'G' || conv === 'F') s = s.toUpperCase();
          out += pad(sign(v, s), width, left, zero && Number.isFinite(v));
        }
      }
    }
    if (ai <= start) break;
  } while (!stop && ai < args.length);
  return { out, err };
}

const printf: Command = ({ sh, args }) => {
  let a = args;
  let target: string | undefined;
  if (a[0] === '-v') {
    target = a[1];
    a = a.slice(2);
    if (target === undefined) return fail('-bash: printf: -v: option requires an argument\nprintf: usage: printf [-v var] format [arguments]', 2);
    if (!isName(target)) return fail(`-bash: printf: \`${target}': not a valid identifier`, 2);
  }
  if (a[0] === '--') a = a.slice(1);
  if (!a.length) return fail('printf: usage: printf [-v var] format [arguments]', 2);
  if (/^-./.test(a[0]) && a[0] !== '-') return fail(`-bash: printf: ${a[0].slice(0, 2)}: invalid option\nprintf: usage: printf [-v var] format [arguments]`, 2);
  const { out, err } = formatPrintf(a[0], a.slice(1));
  if (target !== undefined) {
    if (!sh.setVar(target, out)) return fail(`-bash: ${target}: readonly variable`);
    return status(err ? 1 : 0, err);
  }
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

// ---------- read ----------

const READ_USAGE = 'read: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]';

/** Split a line for read: each name gets one field, the last name gets the rest of the line. */
export function readSplit(s: string, ifs: string, count: number): string[] {
  const isWs = (c: string) => (c === ' ' || c === '\t' || c === '\n') && ifs.includes(c);
  const isSep = (c: string) => ifs.includes(c);
  let i = 0;
  while (i < s.length && isWs(s[i])) i++;
  const out: string[] = [];
  for (let k = 0; k < count - 1; k++) {
    let cur = '';
    while (i < s.length && !isSep(s[i])) cur += s[i++];
    out.push(cur);
    while (i < s.length && isWs(s[i])) i++;
    if (i < s.length && isSep(s[i])) {
      i++;
      while (i < s.length && isWs(s[i])) i++;
    }
  }
  let last = s.slice(i);
  let e = last.length;
  while (e > 0 && isWs(last[e - 1])) e--;
  last = last.slice(0, e);
  out.push(last);
  return out;
}

const read: Command = ({ sh, args, stdin }) => {
  let raw = false;
  let prompt: string | undefined;
  let delim = '\n';
  let nchars = -1;
  let exact = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (names.length || !a.startsWith('-') || a === '-') {
      names.push(a);
      continue;
    }
    if (a === '--') {
      names.push(...args.slice(i + 1));
      break;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if ('pdnNtuai'.includes(c)) {
        const v = a.length > j + 1 ? a.slice(j + 1) : args[++i];
        if (v === undefined) return fail(`-bash: read: -${c}: option requires an argument\n${READ_USAGE}`, 2);
        if (c === 'p') prompt = v;
        else if (c === 'd') delim = v[0] ?? '\0';
        else if (c === 'n' || c === 'N') {
          if (!/^\d+$/.test(v)) return fail(`-bash: read: ${v}: invalid number`, 1);
          nchars = Number(v);
          exact = c === 'N';
        } else if (c === 'a') return fail('-bash: read: -a: arrays are not supported in this practice terminal', 2);
        break;
      }
      if (c === 'r') raw = true;
      else if (c !== 's' && c !== 'e') return fail(`-bash: read: -${c}: invalid option\n${READ_USAGE}`, 2);
    }
  }
  for (const n of names) if (!isName(n)) return fail(`-bash: read: \`${n}': not a valid identifier`);
  const input = sh.stdinStream(stdin);
  let err = prompt !== undefined && input.tty ? prompt : '';

  let text = '';
  let complete = false;
  let got = false;
  if (nchars >= 0 || delim !== '\n') {
    const rest = input.rest;
    got = rest.length > 0;
    let end = delim === '\n' && exact ? -1 : rest.indexOf(delim);
    if (nchars >= 0 && (end < 0 || end > nchars)) end = -1;
    if (end >= 0) {
      text = rest.slice(0, end);
      input.pos += end + 1;
      complete = true;
    } else {
      text = nchars >= 0 ? rest.slice(0, nchars) : rest;
      input.pos += text.length;
      complete = nchars >= 0 ? text.length === nchars : false;
    }
  } else {
    for (;;) {
      const l = input.readLine();
      if (!l) break;
      got = true;
      if (!raw && l.eol && /(^|[^\\])(\\\\)*\\$/.test(l.text)) {
        text += l.text.slice(0, -1);
        continue;
      }
      text += l.text;
      complete = l.eol;
      break;
    }
  }
  if (!raw) text = text.replace(/\\(.?)/g, '$1');
  const targets = names.length ? names : ['REPLY'];
  if (!got) {
    if (input.tty && sh.noteOnce('read-tty')) {
      err += `${prompt ? '\n' : ''}(practice terminal: read cannot wait for typing here. Send the answer in, for example: echo anna | ./script.sh   or   ./script.sh <<< anna)\n`;
    }
    for (const n of targets) sh.setVar(n, '');
    return status(1, err);
  }
  const values = names.length ? readSplit(text, sh.getVar('IFS'), names.length) : [text];
  for (let k = 0; k < targets.length; k++) {
    if (!sh.setVar(targets[k], values[k] ?? '')) return status(1, err + `-bash: ${targets[k]}: readonly variable\n`);
  }
  return status(complete ? 0 : 1, err);
};

// ---------- seq, expr, basename, dirname, sleep ----------

const SEQ_NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const SEQ_LIMIT = 100000;

const seq: Command = ({ args }) => {
  let sep = '\n';
  let fmt: string | undefined;
  let equal = false;
  const nums: string[] = [];
  const help = "Try 'seq --help' for more information.";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-' || SEQ_NUM.test(a)) nums.push(a);
    else if (a === '-s' || a === '--separator') sep = args[++i] ?? '';
    else if (a.startsWith('--separator=')) sep = a.slice(12);
    else if (a.startsWith('-s')) sep = a.slice(2);
    else if (a === '-f' || a === '--format') fmt = args[++i];
    else if (a.startsWith('--format=')) fmt = a.slice(9);
    else if (a.startsWith('-f')) fmt = a.slice(2);
    else if (a === '-w' || a === '--equal-width') equal = true;
    else if (a === '--') {
      nums.push(...args.slice(i + 1));
      break;
    } else return fail(`seq: invalid option -- '${a.replace(/^-+/, '')[0]}'\n${help}`);
  }
  if (!nums.length) return fail(`seq: missing operand\n${help}`);
  if (nums.length > 3) return fail(`seq: extra operand '${nums[3]}'\n${help}`);
  for (const n of nums) if (!SEQ_NUM.test(n)) return fail(`seq: invalid floating point argument: '${n}'\n${help}`);
  const [first, step, last] = nums.length === 1 ? ['1', '1', nums[0]] : nums.length === 2 ? [nums[0], '1', nums[1]] : nums;
  const inc = Number(step);
  if (inc === 0) return fail(`seq: invalid Zero increment value: '${step}'\n${help}`);
  const decimals = (s: string) => (/[eE]/.test(s) ? 0 : (/\.(\d*)/.exec(s)?.[1].length ?? 0));
  const prec = Math.max(decimals(first), decimals(step));
  const a = Number(first);
  const b = Number(last);
  const out: string[] = [];
  let err = '';
  for (let k = 0; ; k++) {
    const v = a + k * inc;
    if (inc > 0 ? v > b + 1e-9 : v < b - 1e-9) break;
    if (out.length >= SEQ_LIMIT) {
      err = `seq: stopped after ${SEQ_LIMIT} numbers (practice terminal limit)\n`;
      break;
    }
    out.push(fmt !== undefined ? formatPrintf(fmt, [String(v)]).out : v.toFixed(prec));
  }
  if (equal && fmt === undefined) {
    const width = Math.max(...out.map((s) => s.length), 0);
    for (let k = 0; k < out.length; k++) out[k] = out[k].startsWith('-') ? '-' + out[k].slice(1).padStart(width - 1, '0') : out[k].padStart(width, '0');
  }
  return { stdout: out.length ? out.join(sep) + '\n' : '', stderr: err, code: err ? 1 : 0 };
};

class ExprError extends Error {}

const exprNull = (v: string) => v === '' || (/^[+-]?\d+$/.test(v) && Number(v) === 0);
const exprInt = (v: string) => {
  if (!/^[+-]?\d+$/.test(v)) throw new ExprError('non-integer argument');
  return Number(v);
};

/** Turn a basic regular expression (expr, grep) into a JavaScript one. */
function breToJs(re: string): string {
  let out = '';
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\' && i + 1 < re.length) {
      const n = re[++i];
      out += '(){}|+?'.includes(n) ? n : '\\' + n;
    } else out += '(){}|+?/'.includes(c) ? '\\' + c : c;
  }
  return out;
}

class ExprParser {
  private i = 0;
  constructor(private a: string[]) {}

  run(): string {
    const v = this.or();
    if (this.i < this.a.length) throw new ExprError(`syntax error: unexpected argument '${this.a[this.i]}'`);
    return v;
  }
  private peek() {
    return this.a[this.i];
  }
  private or(): string {
    let l = this.and();
    while (this.peek() === '|') {
      this.i++;
      const r = this.and();
      l = !exprNull(l) ? l : !exprNull(r) ? r : '0';
    }
    return l;
  }
  private and(): string {
    let l = this.cmp();
    while (this.peek() === '&') {
      this.i++;
      const r = this.cmp();
      l = exprNull(l) || exprNull(r) ? '0' : l;
    }
    return l;
  }
  private cmp(): string {
    let l = this.add();
    for (;;) {
      const op = this.peek();
      if (!['<', '<=', '=', '==', '!=', '>=', '>'].includes(op)) return l;
      this.i++;
      const r = this.add();
      const numeric = /^[+-]?\d+$/.test(l) && /^[+-]?\d+$/.test(r);
      const c = numeric ? Number(l) - Number(r) : l < r ? -1 : l > r ? 1 : 0;
      const res = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '=' || op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '>=' ? c >= 0 : c > 0;
      l = res ? '1' : '0';
    }
  }
  private add(): string {
    let l = this.mul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.a[this.i++];
      const r = this.mul();
      l = String(op === '+' ? exprInt(l) + exprInt(r) : exprInt(l) - exprInt(r));
    }
    return l;
  }
  private mul(): string {
    let l = this.match();
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.a[this.i++];
      const r = this.match();
      const x = exprInt(l);
      const y = exprInt(r);
      if (op !== '*' && y === 0) throw new ExprError('division by zero');
      l = String(op === '*' ? x * y : op === '/' ? Math.trunc(x / y) : x % y);
    }
    return l;
  }
  private match(): string {
    let l = this.primary();
    while (this.peek() === ':') {
      this.i++;
      l = regexMatch(l, this.primary());
    }
    return l;
  }
  private operand(): string {
    const t = this.a[this.i];
    if (t === undefined) throw new ExprError(`syntax error: missing argument after '${this.a[this.i - 1]}'`);
    this.i++;
    return t;
  }
  private primary(): string {
    const t = this.peek();
    if (t === undefined) {
      if (this.i === 0) throw new ExprError('missing operand');
      throw new ExprError(`syntax error: missing argument after '${this.a[this.i - 1]}'`);
    }
    const hasArgs = this.i + 1 < this.a.length;
    if (t === '(') {
      this.i++;
      const v = this.or();
      if (this.peek() !== ')') throw new ExprError(this.peek() === undefined ? "syntax error: expecting ')' after " + `'${this.a[this.i - 1]}'` : `syntax error: expecting ')' instead of '${this.peek()}'`);
      this.i++;
      return v;
    }
    if (t === '+' && hasArgs) {
      this.i++;
      return this.operand();
    }
    if (hasArgs && (t === 'length' || t === 'substr' || t === 'index' || t === 'match')) {
      this.i++;
      const s = this.operand();
      if (t === 'length') return String([...s].length);
      if (t === 'match') return regexMatch(s, this.operand());
      if (t === 'index') {
        const chars = this.operand();
        const k = [...s].findIndex((c) => chars.includes(c));
        return String(k + 1);
      }
      const pos = Number(this.operand());
      const len = Number(this.operand());
      if (!Number.isInteger(pos) || !Number.isInteger(len) || pos < 1 || len < 1) return '';
      return [...s].slice(pos - 1, pos - 1 + len).join('');
    }
    this.i++;
    return t;
  }
}

function regexMatch(s: string, re: string): string {
  let r: RegExp;
  try {
    r = new RegExp('^(?:' + breToJs(re) + ')');
  } catch {
    throw new ExprError('Invalid regular expression');
  }
  const m = r.exec(s);
  if (/\\\(/.test(re)) return m?.[1] ?? '';
  return String(m ? m[0].length : 0);
}

const expr: Command = ({ args }) => {
  if (!args.length) return fail("expr: missing operand\nTry 'expr --help' for more information.", 2);
  try {
    const v = new ExprParser(args).run();
    return { stdout: v + '\n', stderr: '', code: exprNull(v) ? 1 : 0 };
  } catch (e) {
    if (e instanceof ExprError) return fail(`expr: ${e.message}`, 2);
    throw e;
  }
};

const basename: Command = ({ args }) => {
  let suffix: string | undefined;
  let multiple = false;
  let zero = false;
  const ops: string[] = [];
  const help = "Try 'basename --help' for more information.";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (ops.length && !multiple) ops.push(a);
    else if (a === '-s' || a === '--suffix') {
      suffix = args[++i];
      multiple = true;
    } else if (a.startsWith('--suffix=')) {
      suffix = a.slice(9);
      multiple = true;
    } else if (a === '-a' || a === '--multiple') multiple = true;
    else if (a === '-z' || a === '--zero') zero = true;
    else if (a === '--') {
      ops.push(...args.slice(i + 1));
      break;
    } else if (a.startsWith('-') && a.length > 1) return fail(`basename: invalid option -- '${a.replace(/^-+/, '')[0]}'\n${help}`);
    else ops.push(a);
  }
  if (!ops.length) return fail(`basename: missing operand\n${help}`);
  if (!multiple) {
    if (ops.length > 2) return fail(`basename: extra operand '${ops[2]}'\n${help}`);
    suffix = ops[1];
    ops.length = 1;
  }
  const base = (p: string) => {
    const t = p.replace(/\/+$/, '');
    if (!t) return p ? '/' : '';
    let b = t.slice(t.lastIndexOf('/') + 1);
    if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
    return b;
  };
  const end = zero ? '\0' : '\n';
  return ok(ops.map((p) => base(p) + end).join(''));
};

const dirname: Command = ({ args }) => {
  const ops = args.filter((a) => a !== '--');
  if (!ops.length) return fail("dirname: missing operand\nTry 'dirname --help' for more information.");
  const dir = (p: string) => {
    const t = p.replace(/\/+$/, '');
    if (!t) return p.startsWith('/') ? '/' : '.';
    const k = t.lastIndexOf('/');
    if (k < 0) return '.';
    return t.slice(0, k).replace(/\/+$/, '') || '/';
  };
  return ok(ops.map((p) => dir(p) + '\n').join(''));
};

const sleep: Command = ({ args }) => {
  const help = "Try 'sleep --help' for more information.";
  if (!args.length) return fail(`sleep: missing operand\n${help}`);
  for (const a of args) {
    if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[smhd]?$/.test(a) && !/^inf(inity)?$/i.test(a)) return fail(`sleep: invalid time interval '${a}'\n${help}`);
  }
  // The practice terminal does not wait.
  return ok();
};

// ---------- running scripts ----------

const BASH_VERSION = `GNU bash, version 5.2.26(1)-release (x86_64-redhat-linux-gnu)
Copyright (C) 2022 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>

This is free software; you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.
`;

const bash: Command = ({ sh, args, stdin, name }) => {
  const opts: ScriptOptions = {};
  let dashC = false;
  let fromStdin = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-') {
      i++;
      break;
    }
    if (a === '--version') return ok(BASH_VERSION);
    if (a === '--help') return ok(`Usage:\t${name} [GNU long option] [option] ...\n\t${name} [GNU long option] [option] script-file ...\nShell options:\n\t-c command, -x (trace), -e (exit on error), -u (unset variables are errors), -n (check syntax only)\n`);
    if (['--login', '--norc', '--noprofile', '--posix', '--noediting'].includes(a)) continue;
    if (a === '-o' || a === '+o') {
      const o = args[++i];
      if (o === 'errexit') opts.errexit = a === '-o';
      if (o === 'nounset') opts.nounset = a === '-o';
      if (o === 'xtrace') opts.xtrace = a === '-o';
      continue;
    }
    if (!/^[-+][a-zA-Z]+$/.test(a)) break;
    for (const c of a.slice(1)) {
      const on = a[0] === '-';
      if (c === 'c') dashC = true;
      else if (c === 'x') opts.xtrace = on;
      else if (c === 'e') opts.errexit = on;
      else if (c === 'u') opts.nounset = on;
      else if (c === 'n') opts.noexec = on;
      else if (c === 's') fromStdin = true;
      else if (!'vilp'.includes(c)) return fail(`${name}: -${c}: invalid option\nUsage:\t${name} [GNU long option] [option] ...\n\t${name} [GNU long option] [option] script-file ...`, 2);
    }
  }
  const rest = args.slice(i);
  if (dashC) {
    if (!rest.length) return fail(`${name}: -c: option requires an argument`, 2);
    return sh.runString(rest[0], rest[1] ?? name, rest.slice(2), stdin, opts);
  }
  if (rest.length && !fromStdin) return sh.runScript(rest[0], rest.slice(1), stdin, opts, name);
  const input = sh.stdinStream(stdin);
  if (!input.tty) return sh.runString(input.readAll(), name, rest, '', opts, name);
  // A new interactive shell: "exit" returns to this one.
  sh.startNestedShell();
  return ok();
};

const source: Command = ({ sh, args, stdin, name }) => {
  const a = args[0] === '--' ? args.slice(1) : args;
  if (!a.length) return fail(`-bash: ${name}: filename argument required\n${name}: usage: ${name} filename [arguments]`, 2);
  return sh.source(a[0], a.length > 1 ? a.slice(1) : null, stdin);
};

const letCmd: Command = ({ sh, args }) => {
  if (!args.length) return fail('-bash: let: expression expected');
  let v = 0;
  for (const a of args) {
    try {
      v = sh.arith(a);
    } catch (e) {
      if (e instanceof ArithError) return fail(`-bash: let: ${e.message}`);
      throw e;
    }
  }
  return status(v === 0 ? 1 : 0);
};

const ENV_VARS = ['HOME', 'HOSTNAME', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'USER'];

const exportCmd: Command = ({ sh, args }) => {
  let off = false;
  const names: string[] = [];
  for (const a of args) {
    if (!names.length && /^-[fnp]+$/.test(a)) {
      if (a.includes('n')) off = true;
      continue;
    }
    names.push(a);
  }
  if (!names.length) {
    const all = new Set([...ENV_VARS, ...Object.keys(sh.env).filter((k) => isName(k) && sh.isExported(k))]);
    const lines = [...all].sort().map((k) => `declare -x ${k}="${sh.getVar(k).replace(/(["\\$`])/g, '\\$1')}"\n`);
    return ok(lines.join(''));
  }
  let err = '';
  for (const a of names) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(\+?=)([\s\S]*))?$/.exec(a);
    if (!m) {
      err += `-bash: export: \`${a}': not a valid identifier\n`;
      continue;
    }
    const [, n, op, value] = m;
    if (op !== undefined && !sh.setVar(n, op === '+=' ? sh.getVar(n) + value : value)) {
      err += `-bash: ${n}: readonly variable\n`;
      continue;
    }
    sh.markExported(n, !off);
  }
  return err ? fail(err) : ok();
};

// ---------- type, which, env ----------

const typeCmd: Command = ({ sh, args }) => {
  let mode = '';
  const names: string[] = [];
  for (const a of args) {
    if (!names.length && /^-[aftpP]+$/.test(a)) {
      for (const c of a.slice(1)) if ('tpP'.includes(c)) mode = c;
      continue;
    }
    names.push(a);
  }
  let out = '';
  let err = '';
  let code = 0;
  for (const n of names) {
    const d = sh.describe(n, mode === 'P');
    if (!d) {
      if (!mode) err += `-bash: type: ${n}: not found\n`;
      code = 1;
    } else if (mode === 't') out += `${d.kind}\n`;
    else if (mode) out += d.kind === 'file' ? `${d.path}\n` : '';
    else if (d.kind === 'file') out += `${n} is ${d.path}\n`;
    else if (d.kind === 'function') out += `${n} is a function\n${d.text}`;
    else out += `${n} is a shell ${d.kind}\n`;
  }
  return { stdout: out, stderr: err, code };
};

const which: Command = ({ sh, args }) => {
  let out = '';
  let err = '';
  for (const a of args.filter((x) => !x.startsWith('-'))) {
    const d = sh.describe(a, true);
    if (d?.kind === 'file') out += `${d.path}\n`;
    else err += `/usr/bin/which: no ${a} in (${sh.getVar('PATH')})\n`;
  }
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

/** env lists the exported variables; env NAME=value... command runs a command with more of them. */
const env: Command = ({ sh, args, stdin }) => {
  let i = 0;
  let clean = false;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '-i' || args[i] === '-' || args[i] === '--ignore-environment') clean = true;
    else if (args[i] === '--') {
      i++;
      break;
    } else return fail(`env: invalid option -- '${args[i].replace(/^-+/, '')[0]}'\nTry 'env --help' for more information.`, 125);
  }
  const sets: [string, string][] = [];
  for (; i < args.length && /^[^=]+=/.test(args[i]); i++) {
    const k = args[i].indexOf('=');
    sets.push([args[i].slice(0, k), args[i].slice(k + 1)]);
  }
  const cmd = args.slice(i);
  if (!cmd.length) {
    const vars = new Map<string, string>();
    if (!clean) {
      for (const k of ['HOME', 'USER', 'LOGNAME', 'PWD', 'SHELL', 'HOSTNAME', 'PATH']) vars.set(k, sh.getVar(k));
      for (const [k, v] of Object.entries(sh.env)) if (k !== 'OLDPWD' && sh.isExported(k)) vars.set(k, v);
    }
    for (const [k, v] of sets) vars.set(k, v);
    return ok([...vars].map(([k, v]) => `${k}=${v}\n`).join(''));
  }
  const saved = sh.env;
  const tmp: Record<string, string> = clean ? {} : { ...saved };
  for (const [k, v] of sets) tmp[k] = v;
  sh.env = tmp;
  try {
    return sh.exec(cmd, stdin);
  } finally {
    if (sh.env === tmp) sh.env = saved; // a reboot replaces env; keep that
  }
};

export const SCRIPT_COMMANDS: Record<string, Command> = {
  test,
  '[': test,
  printf,
  read,
  seq,
  expr,
  basename,
  dirname,
  sleep,
  bash,
  sh: bash,
  source,
  '.': source,
  let: letCmd,
  ':': () => ok(),
  export: exportCmd,
  type: typeCmd,
  which,
  env,
};

export const SCRIPT_MAN: Record<string, string> = {
  bash: 'GNU Bourne-Again SHell. bash script.sh runs a script without execute permission, bash -x script.sh shows each command as it runs, bash -n script.sh only checks the syntax, bash -c "cmd" runs a command',
  sh: 'the POSIX shell. On RHEL /bin/sh is bash',
  source: 'run a file in the current shell, so the variables and functions it sets stay. ". file" is the same',
  '.': 'same as source: run a file in the current shell',
  printf: 'format and print data: printf "%s is %d years\\n" anna 30. %s string, %d integer, %5.2f number, %x hex, %% percent sign. The format repeats for extra arguments',
  read: 'read a line from standard input into variables. read -p "Name: " NAME asks, -r keeps backslashes. while read LINE; do ...; done < FILE reads a file line by line',
  seq: 'print a sequence of numbers: seq 5, seq 2 10, seq 0 5 100. -s sets the separator, -w pads with zeros',
  expr: 'evaluate an expression: expr 3 + 4, expr 3 \\* 4, expr length "$s". In bash, $(( 3 * 4 )) is easier',
  basename: 'strip the directory (and a suffix) from a file name: basename /etc/hosts, basename report.txt .txt',
  dirname: 'strip the last part of a path: dirname /etc/sysconfig/network gives /etc/sysconfig',
  sleep: 'wait a number of seconds (or 2m, 1h). In the practice terminal it returns at once',
  let: 'evaluate arithmetic: let "x = x + 1" is the same as (( x = x + 1 ))',
  test: 'check files and compare values: test -f FILE, [ -d DIR ], [ "$a" = "$b" ], [ "$n" -gt 5 ]. -e exists, -f file, -d directory, -x executable, -z empty, -n not empty. ! negates, -a and -o combine',
  '[': 'same as test, but the last argument must be ]. Put spaces around [ and ], and quote variables: [ -n "$1" ]',
  export: 'make variables visible to child processes such as scripts: export VAR=value. export -p lists them, export -n VAR stops exporting',
  ':': 'do nothing, successfully (the same as true). while :; do ...; done loops forever',
  type: 'tell what a name is: a shell keyword, builtin, function or a file. type -t prints only the kind, type -P only the path',
  which: 'show the full path of a command found in $PATH: which useradd',
  env: 'print the exported environment variables (the ones scripts see). env VAR=value command runs a command with an extra variable',
};

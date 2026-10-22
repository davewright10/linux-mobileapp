// Text tools of the practice terminal: sed, tr and awk. They follow GNU sed 4.9, tr from
// coreutils 9.5 and gawk 5.3 as RHEL 10 ships them, for what RHCSA work uses: sed addresses,
// groups, & and in-place edits; tr ranges, classes, -d, -s and -c; and the awk language with
// fields, patterns, variables, arrays and printf.

import type { CommandContext, CommandResult } from './commands';
import { formatPrintf } from './commands-script';
import { FsError, errorText } from './fs';
import { cEscape } from './parser';
import type { Shell } from './shell';

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1, stdout = ''): CommandResult => ({
  stdout,
  stderr: stderr.endsWith('\n') ? stderr : stderr + '\n',
  code,
});
const reason = (e: unknown) => (e instanceof FsError ? errorText[e.reason] : e instanceof Error ? e.message : String(e));
const splitLines = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));

// ---------- POSIX regular expressions ----------

const charRange = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => String.fromCharCode(a + k)).join('');
const ASCII = charRange(0, 127);

/** The characters of each POSIX class in the C locale, in ascending order (tr expands them so). */
const CLASS_CHARS: Record<string, string> = {
  upper: charRange(65, 90),
  lower: charRange(97, 122),
  digit: charRange(48, 57),
  alpha: charRange(65, 90) + charRange(97, 122),
  alnum: charRange(48, 57) + charRange(65, 90) + charRange(97, 122),
  space: '\t\n\v\f\r ',
  blank: '\t ',
  punct: [...ASCII].filter((c) => /[!-/:-@[-`{-~]/.test(c)).join(''),
  xdigit: charRange(48, 57) + 'ABCDEFabcdef',
  cntrl: charRange(0, 31) + '\x7f',
  print: charRange(32, 126),
  graph: charRange(33, 126),
};

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const classEscape = (s: string) => [...s].map((c) => (/[\\\]^[-]/.test(c) ? '\\' + c : c)).join('');

export class RegexSyntaxError extends Error {}

/** Translate a bracket expression starting at p[i] === '['. Null when it has no closing ]. */
function bracketExpr(p: string, i: number): { re: string; end: number } | null {
  let j = i + 1;
  let neg = '';
  if (p[j] === '^') {
    neg = '^';
    j++;
  }
  let body = '';
  for (let first = true; j < p.length; j++, first = false) {
    const c = p[j];
    if (c === ']' && !first) return { re: `[${neg}${body}]`, end: j };
    if (c === '[' && (p[j + 1] === ':' || p[j + 1] === '=' || p[j + 1] === '.')) {
      const kind = p[j + 1];
      const close = p.indexOf(kind + ']', j + 2);
      if (close < 0) throw new RegexSyntaxError('unterminated character class');
      const name = p.slice(j + 2, close);
      if (kind === ':') {
        if (!(name in CLASS_CHARS)) throw new RegexSyntaxError('Invalid character class name');
        body += classEscape(CLASS_CHARS[name]);
      } else body += classEscape(name);
      j = close + 1;
      continue;
    }
    if (c === '\\' && j + 1 < p.length && 'nt\\]/'.includes(p[j + 1])) {
      // GNU sed and awk read these escapes inside brackets too
      const n = p[++j];
      body += n === 'n' ? '\\n' : n === 't' ? '\\t' : '\\' + n;
      continue;
    }
    body += /[\\\][^]/.test(c) ? '\\' + c : c;
  }
  return null;
}

/**
 * Turn a POSIX basic (BRE, as grep and sed use) or extended (ERE: grep -E, sed -E, awk) regular
 * expression into a JavaScript one. In a BRE \( \) \{ \} \| \+ \? are operators and the bare
 * characters are literal; POSIX classes such as [[:digit:]] and \< \> word edges are translated.
 */
export function posixRegex(p: string, extended: boolean): string {
  let out = '';
  let atom = false; // there is something a following * can repeat
  let start = true; // at the start of the expression or a group: ^ anchors, * is literal
  let quant = false; // the last thing was a quantifier
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    const wasStart = start;
    const wasQuant = quant;
    start = false;
    quant = false;
    const quantifier = (q: string) => {
      if (wasQuant) return; // a** is a*
      if (!atom) {
        out += '\\' + q[0];
        atom = true;
        return;
      }
      out += q;
      quant = true;
    };
    if (c === '\\') {
      const n = p[++i];
      if (n === undefined) {
        if (!extended) throw new RegexSyntaxError('Trailing backslash');
        out += '\\\\';
        atom = true;
        continue;
      }
      if ('(){}|+?'.includes(n)) {
        if (extended) {
          out += '\\' + n;
          atom = true;
        } else if (n === '(' || n === '|') {
          out += n;
          start = true;
          atom = false;
        } else if (n === ')') {
          out += n;
          atom = true;
        } else if (n === '{') {
          const m = /^(\d+)(,(\d*))?\\\}/.exec(p.slice(i + 1));
          if (!m) throw new RegexSyntaxError('Invalid content of \\{\\}');
          if (atom && !wasQuant) {
            out += `{${m[1]}${m[2] ?? ''}}`;
            quant = true;
          } else if (!atom) out += escapeRe(`{${m[1]}${m[2] ?? ''}}`);
          i += m[0].length;
        } else if (n === '}') out += '\\}';
        else quantifier(n);
        continue;
      }
      if (n === '<' || n === '>') {
        out += '\\b';
        atom = false;
        continue;
      }
      if (n === '`') out += '^';
      else if (n === "'") out += '$';
      else if (n === 'n') out += '\\n';
      else if (n === 't') out += '\\t';
      else if (/[1-9wWsSbB]/.test(n)) out += '\\' + n;
      else out += escapeRe(n);
      atom = !/[`'bB]/.test(n);
      continue;
    }
    if (c === '[') {
      const b = bracketExpr(p, i);
      if (!b) throw new RegexSyntaxError('Unmatched [, [^, [:, [., or [=');
      out += b.re;
      i = b.end;
      atom = true;
      continue;
    }
    if (c === '^') {
      if (extended || wasStart) {
        out += '^';
        start = true;
        atom = false;
      } else {
        out += '\\^';
        atom = true;
      }
      continue;
    }
    if (c === '$') {
      const rest = p.slice(i + 1);
      const end = rest === '' || (extended ? /^[)|]/.test(rest) : /^\\[)|]/.test(rest));
      if (extended || end) {
        out += '$';
        atom = false;
      } else {
        out += '\\$';
        atom = true;
      }
      continue;
    }
    if (c === '*') {
      if (wasStart && !extended) {
        out += '\\*';
        atom = true;
      } else quantifier('*');
      continue;
    }
    if (!extended) {
      out += '(){}|+?'.includes(c) ? '\\' + c : c === '/' ? '\\/' : c;
      atom = true;
      continue;
    }
    // ERE operators
    if (c === '(' || c === '|') {
      out += c;
      start = true;
      atom = false;
    } else if (c === ')') {
      out += c;
      atom = true;
    } else if (c === '+' || c === '?') quantifier(c);
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i));
      if (m && atom && !wasQuant) {
        out += m[0];
        quant = true;
        i += m[0].length - 1;
      } else {
        out += '\\{';
        atom = true;
      }
    } else {
      out += c === '}' ? '\\}' : c === '/' ? '\\/' : c;
      atom = true;
    }
  }
  return out;
}

/** Compile a POSIX regular expression. Throws RegexSyntaxError for a bad one. */
export function compileRegex(p: string, extended: boolean, flags = ''): RegExp {
  const src = posixRegex(p, extended);
  try {
    return new RegExp(src, flags);
  } catch {
    throw new RegexSyntaxError(/\\[1-9]/.test(src) ? 'Invalid back reference' : 'Invalid regular expression');
  }
}

/** Count the capture groups of a compiled regex. */
const groupCount = (re: RegExp) => new RegExp(`${re.source}|`).exec('')!.length - 1;

// ---------- sed ----------

class SedError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

interface SedAddr {
  kind: 'line' | 'last' | 're' | 'step' | 'plus' | 'mult';
  n: number;
  step: number;
  re: RegExp | null; // null: the last regular expression used
}

type ReplPart = { t: 'lit'; s: string } | { t: 'grp'; n: number } | { t: 'case'; c: string };

interface SedCmd {
  name: string;
  a1?: SedAddr;
  a2?: SedAddr;
  neg: boolean;
  active: boolean; // inside the range a1,a2
  end: number; // last line of a range with addr2 +N or ~N
  blockEnd: number; // for {: the index of its }
  re: RegExp | null;
  repl: ReplPart[];
  global: boolean;
  nth: number;
  print: boolean;
  text: string; // a i c text; file of r w; label of : b t T
  code: number; // exit code of q Q
  map?: Map<string, string>; // y
  wfile: string; // s///w file
}

interface SedProgram {
  cmds: SedCmd[];
  labels: Map<string, number>;
  wfiles: string[];
}

function parseSed(s: string, ext: boolean): SedProgram {
  const cmds: SedCmd[] = [];
  const labels = new Map<string, number>();
  const wfiles: string[] = [];
  const jumps: { cmd: SedCmd; pos: number }[] = [];
  const blocks: number[] = [];
  let i = 0;
  const err = (msg: string): never => {
    throw new SedError(msg, i);
  };
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  const readNum = () => {
    const m = /^\d+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  /** Read up to the unescaped delimiter; \delim becomes a literal delimiter. */
  const delimited = (delim: string, what: string, regex: boolean): string => {
    let out = '';
    while (i < s.length && s[i] !== delim) {
      if (s[i] === '\n' && regex) err(what);
      if (s[i] === '\\' && i + 1 < s.length) {
        const n = s[i + 1];
        if (n === delim) out += regex && (ext ? /[.[\]*^$\\+?(){}|]/ : /[.[\]*^$\\]/).test(n) ? '\\' + n : n;
        else if (n === '\n') out += regex ? '\\n' : '\n';
        else out += '\\' + n;
        i += 2;
        continue;
      }
      out += s[i++];
    }
    if (i >= s.length) err(what);
    i++; // the delimiter
    return out;
  };
  const regex = (src: string, flags: string): RegExp | null => {
    if (src === '') return null;
    try {
      return compileRegex(src, ext, flags);
    } catch (e) {
      return err(reason(e));
    }
  };
  const address = (second: boolean): SedAddr | undefined => {
    const a: SedAddr = { kind: 'line', n: 0, step: 0, re: null };
    const c = s[i];
    if (c === undefined) return undefined;
    if (/\d/.test(c)) {
      a.n = readNum()!;
      if (s[i] === '~' && !second) {
        i++;
        a.kind = 'step';
        a.step = readNum() ?? 0;
      }
      return a;
    }
    if (second && (c === '+' || c === '~')) {
      i++;
      const n = readNum();
      if (n === null) err('expected newer version of sed');
      a.kind = c === '+' ? 'plus' : 'mult';
      a.n = n!;
      return a;
    }
    if (c === '$') {
      i++;
      a.kind = 'last';
      return a;
    }
    if (c === '/' || c === '\\') {
      i++;
      const delim = c === '/' ? '/' : s[i++];
      if (delim === undefined || delim === '\n' || delim === '\\') err('unexpected `,\'');
      const src = delimited(delim, 'unterminated address regex', true);
      let flags = '';
      while (s[i] === 'I' || s[i] === 'M') flags += s[i++] === 'I' ? 'i' : 'm';
      a.kind = 're';
      a.re = regex(src, flags);
      return a;
    }
    return undefined;
  };
  /** Text of a, i and c: "a\" and lines ending in \ continue, or GNU's one-line "a text". */
  const text = (): string => {
    ws();
    if (s[i] === '\\') {
      i++;
      if (s[i] === '\n') i++;
    } else if (i >= s.length || s[i] === '\n') err('expected \\ after `a\', `c\' or `i\'');
    let out = '';
    while (i < s.length && s[i] !== '\n') {
      if (s[i] === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
        continue;
      }
      out += s[i++];
    }
    return out;
  };
  const fileName = (): string => {
    ws();
    const start = i;
    while (i < s.length && s[i] !== '\n') i++;
    return s.slice(start, i);
  };
  const label = (jump: boolean): string => {
    ws();
    const start = i;
    while (i < s.length && !(jump ? /[\n;}]/ : /[\n;]/).test(s[i])) i++;
    return s.slice(start, i).trim();
  };

  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    const cmd: SedCmd = { name: '', neg: false, active: false, end: 0, blockEnd: 0, re: null, repl: [], global: false, nth: 1, print: false, text: '', code: 0, wfile: '' };
    cmd.a1 = address(false);
    if (cmd.a1) {
      ws();
      if (s[i] === ',') {
        i++;
        ws();
        cmd.a2 = address(true);
        if (!cmd.a2) err('unexpected `,\'');
      }
      if (cmd.a1.kind === 'line' && cmd.a1.n === 0 && (!cmd.a2 || cmd.a2.kind !== 're')) err('invalid usage of line address 0');
    }
    ws();
    while (s[i] === '!') {
      cmd.neg = true;
      i++;
      ws();
    }
    const c = s[i++];
    if (c === undefined) err('missing command');
    cmd.name = c;
    switch (c) {
      case '{':
        blocks.push(cmds.length);
        break;
      case '}':
        if (cmd.a1) err('} doesn\'t want any addresses');
        if (!blocks.length) err('unexpected `}\'');
        cmds[blocks.pop()!].blockEnd = cmds.length;
        break;
      case 's': {
        const delim = s[i++];
        if (delim === undefined || delim === '\n' || delim === '\\') err('unterminated `s\' command');
        const src = delimited(delim, 'unterminated `s\' command', true);
        const rep = delimited(delim, 'unterminated `s\' command', false);
        let flags = '';
        for (;;) {
          const f = s[i];
          if (f === 'g') cmd.global = true;
          else if (f === 'p') cmd.print = true;
          else if (f === 'i' || f === 'I') flags += 'i';
          else if (f === 'm' || f === 'M') flags += 'm';
          else if (f === 'e') {
            // run the result as a command: not in the practice terminal; ignored
          } else if (f !== undefined && /\d/.test(f)) {
            cmd.nth = readNum()!;
            if (cmd.nth === 0) err('number option to `s\' command may not be zero');
            continue;
          } else if (f === 'w') {
            i++;
            cmd.wfile = fileName();
            wfiles.push(cmd.wfile);
            break;
          } else if (f === undefined || /[\s;}#]/.test(f)) break;
          else err('unknown option to `s\'');
          i++;
        }
        cmd.re = regex(src, [...new Set('g' + flags)].join(''));
        cmd.repl = replacement(rep);
        const max = Math.max(0, ...cmd.repl.map((p) => (p.t === 'grp' ? p.n : 0)));
        if (max > 0) {
          const re = cmd.re;
          if (re && groupCount(re) < max) err(`invalid reference \\${max} on \`s' command's RHS`);
        }
        break;
      }
      case 'y': {
        const delim = s[i++];
        if (delim === undefined || delim === '\n' || delim === '\\') err('unterminated `y\' command');
        const unesc = (t: string) => t.replace(/\\(.)/g, (_, x: string) => (x === 'n' ? '\n' : x === 't' ? '\t' : x));
        const from = [...unesc(delimited(delim, 'unterminated `y\' command', false))];
        const to = [...unesc(delimited(delim, 'unterminated `y\' command', false))];
        if (from.length !== to.length) err('strings for `y\' command are different lengths');
        cmd.map = new Map(from.map((ch, k) => [ch, to[k]]));
        break;
      }
      case 'a':
      case 'i':
      case 'c':
        cmd.text = text();
        break;
      case ':':
        if (cmd.a1) err(': doesn\'t want any addresses');
        cmd.text = label(false);
        if (!cmd.text) err('":" lacks a label');
        labels.set(cmd.text, cmds.length);
        break;
      case 'b':
      case 't':
      case 'T':
        cmd.text = label(true);
        if (cmd.text) jumps.push({ cmd, pos: i });
        break;
      case 'r':
      case 'w':
        cmd.text = fileName();
        if (!cmd.text) err(`missing filename in r/R/w/W commands`);
        if (c === 'w') wfiles.push(cmd.text);
        break;
      case 'q':
      case 'Q':
        ws();
        cmd.code = readNum() ?? 0;
        break;
      case '=':
      case 'd':
      case 'D':
      case 'p':
      case 'P':
      case 'n':
      case 'N':
      case 'h':
      case 'H':
      case 'g':
      case 'G':
      case 'x':
      case 'z':
      case 'l':
        break;
      default:
        i--;
        err(`unknown command: \`${c}'`);
    }
    cmds.push(cmd);
    ws();
    if (i < s.length && !/[\n;}#]/.test(s[i]) && c !== '{') err(`extra characters after command`);
  }
  if (blocks.length) {
    i = s.length;
    err('unmatched `{\'');
  }
  for (const j of jumps) {
    if (!labels.has(j.cmd.text)) {
      i = j.pos;
      err(`can't find label for jump to \`${j.cmd.text}'`);
    }
  }
  return { cmds, labels, wfiles };
}

/** Parse the replacement of s: & is the match, \1..\9 groups, \n newline, \U \L \u \l \E change case. */
function replacement(r: string): ReplPart[] {
  const parts: ReplPart[] = [];
  const lit = (t: string) => {
    const last = parts[parts.length - 1];
    if (last?.t === 'lit') last.s += t;
    else parts.push({ t: 'lit', s: t });
  };
  for (let k = 0; k < r.length; k++) {
    const c = r[k];
    if (c === '&') parts.push({ t: 'grp', n: 0 });
    else if (c === '\\' && k + 1 < r.length) {
      const n = r[++k];
      if (/\d/.test(n)) parts.push({ t: 'grp', n: Number(n) });
      else if (n === 'n') lit('\n');
      else if (n === 't') lit('\t');
      else if ('ULulE'.includes(n)) parts.push({ t: 'case', c: n });
      else lit(n);
    } else lit(c);
  }
  return parts;
}

function expandReplacement(parts: ReplPart[], m: RegExpExecArray): string {
  let out = '';
  let mode = ''; // U or L until \E
  let one = ''; // u or l for the next character
  const add = (t: string) => {
    if (!t) return;
    let v = mode === 'U' ? t.toUpperCase() : mode === 'L' ? t.toLowerCase() : t;
    if (one) {
      v = (one === 'u' ? v[0].toUpperCase() : v[0].toLowerCase()) + v.slice(1);
      one = '';
    }
    out += v;
  };
  for (const p of parts) {
    if (p.t === 'lit') add(p.s);
    else if (p.t === 'grp') add(m[p.n] ?? '');
    else if (p.c === 'u' || p.c === 'l') one = p.c;
    else mode = p.c === 'E' ? '' : p.c;
  }
  return out;
}

/** Replace the nth (and with g every later) match of re in s, as sed's s command does. */
function substitute(s: string, re: RegExp, parts: ReplPart[], nth: number, global: boolean): string | null {
  let out = '';
  let last = 0;
  let count = 0;
  let prevEnd = -1;
  let done = false;
  if (!re.global) re = new RegExp(re.source, re.flags + 'g'); // an address regex reused with s//x/
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index;
    const end = start + m[0].length;
    // an empty match right after the previous match does not count (echo baaac | sed 's/a*/x/g' gives xbxcx)
    if (!(m[0] === '' && start === prevEnd)) {
      count++;
      if (count >= nth) {
        out += s.slice(last, start) + expandReplacement(parts, m);
        last = end;
        done = true;
        if (!global) break;
      }
      prevEnd = end;
    }
    if (m[0] === '') {
      if (start >= s.length) break;
      re.lastIndex = start + 1;
    }
  }
  return done ? out + s.slice(last) : null;
}

const testRe = (re: RegExp, s: string) => {
  re.lastIndex = 0;
  return re.test(s);
};

interface SedState {
  hold: string;
  lastRe: RegExp | null;
  writes: Map<string, string>;
  quit: boolean;
  code: number;
}

/** Run a sed program over one input stream (all files, or one file with -i and -s). */
function runSed(sh: Shell, prog: SedProgram, lines: string[], quiet: boolean, st: SedState): string {
  const { cmds, labels } = prog;
  let out = '';
  let li = 0;
  let lineNo = 0;
  let ps = '';
  let restart = false; // D: start the next cycle without reading a line
  for (const c of cmds) c.active = c.a1?.kind === 'line' && c.a1.n === 0;
  const isLast = () => li >= lines.length;
  const regexFor = (re: RegExp | null): RegExp => {
    const r = re ?? st.lastRe;
    if (!r) throw new SedError('no previous regular expression', 0);
    st.lastRe = r;
    return r;
  };
  const hit = (a: SedAddr): boolean => {
    switch (a.kind) {
      case 'line':
        return lineNo === a.n;
      case 'last':
        return isLast();
      case 're':
        return testRe(regexFor(a.re), ps);
      case 'step':
        return a.step <= 0 ? lineNo === a.n : lineNo >= a.n && (lineNo - a.n) % a.step === 0;
      default:
        return false;
    }
  };
  const selected = (c: SedCmd): boolean => {
    if (!c.a1) return !c.neg;
    let r: boolean;
    if (!c.a2) r = hit(c.a1);
    else if (c.active) {
      const a2 = c.a2;
      r = true;
      if (a2.kind === 'line' || a2.kind === 'plus' || a2.kind === 'mult') {
        const end = a2.kind === 'line' ? a2.n : c.end;
        if (lineNo >= end) c.active = false;
        if (lineNo > end) r = false;
      } else if (a2.kind === 're' ? testRe(regexFor(a2.re), ps) : isLast()) c.active = false;
    } else if (hit(c.a1)) {
      r = true;
      const a2 = c.a2;
      c.active = true;
      if (a2.kind === 'line') c.active = a2.n > lineNo;
      else if (a2.kind === 'plus') {
        c.end = lineNo + a2.n;
        c.active = a2.n > 0;
      } else if (a2.kind === 'mult') {
        c.end = a2.n > 0 ? Math.ceil(lineNo / a2.n) * a2.n : lineNo;
        c.active = c.end > lineNo;
      } else if (a2.kind === 'last') c.active = !isLast();
    } else r = false;
    return c.neg ? !r : r;
  };
  while (!st.quit && (restart || li < lines.length)) {
    if (!restart) {
      ps = lines[li++];
      lineNo++;
    }
    restart = false;
    let tflag = false;
    let append = '';
    let autoprint = !quiet;
    let pc = 0;
    while (pc < cmds.length) {
      const c = cmds[pc];
      if (!selected(c)) {
        pc = c.name === '{' ? c.blockEnd + 1 : pc + 1;
        continue;
      }
      pc++;
      const endCycle = () => {
        pc = cmds.length;
      };
      switch (c.name) {
        case '=':
          out += `${lineNo}\n`;
          break;
        case 'a':
          append += c.text + '\n';
          break;
        case 'i':
          out += c.text + '\n';
          break;
        case 'c':
          if (c.neg || !c.a2 || !c.active) out += c.text + '\n';
          autoprint = false;
          endCycle();
          break;
        case 'd':
          autoprint = false;
          endCycle();
          break;
        case 'D':
          autoprint = false;
          if (ps.includes('\n')) {
            ps = ps.slice(ps.indexOf('\n') + 1);
            restart = true;
          }
          endCycle();
          break;
        case 'p':
          out += ps + '\n';
          break;
        case 'P':
          out += ps.split('\n')[0] + '\n';
          break;
        case 'l':
          out += ps.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n') + '$\n';
          break;
        case 'h':
          st.hold = ps;
          break;
        case 'H':
          st.hold += '\n' + ps;
          break;
        case 'g':
          ps = st.hold;
          break;
        case 'G':
          ps += '\n' + st.hold;
          break;
        case 'x':
          [ps, st.hold] = [st.hold, ps];
          break;
        case 'z':
          ps = '';
          break;
        case 'n':
        case 'N':
          // GNU sed: without a next line, print the pattern space and stop
          if (isLast()) {
            st.quit = true;
            endCycle();
            break;
          }
          if (c.name === 'n' && !quiet) out += ps + '\n';
          out += append;
          append = '';
          ps = c.name === 'n' ? lines[li++] : ps + '\n' + lines[li++];
          lineNo++;
          break;
        case 'q':
          st.quit = true;
          st.code = c.code;
          endCycle();
          break;
        case 'Q':
          st.quit = true;
          st.code = c.code;
          autoprint = false;
          endCycle();
          break;
        case 's': {
          const r = substitute(ps, regexFor(c.re), c.repl, c.nth, c.global);
          if (r === null) break;
          ps = r;
          tflag = true;
          if (c.print) out += ps + '\n';
          if (c.wfile) st.writes.set(c.wfile, (st.writes.get(c.wfile) ?? '') + ps + '\n');
          break;
        }
        case 'y':
          ps = [...ps].map((ch) => c.map!.get(ch) ?? ch).join('');
          break;
        case 'b':
        case 't':
        case 'T': {
          const jump = c.name === 'b' || (c.name === 't') === tflag;
          if (c.name !== 'b') tflag = false;
          if (jump) pc = c.text ? labels.get(c.text)! + 1 : cmds.length;
          break;
        }
        case 'r':
          try {
            const t = sh.readFile(c.text);
            append += t && !t.endsWith('\n') ? t + '\n' : t;
          } catch {
            // like GNU sed: a file that cannot be read is silently ignored
          }
          break;
        case 'w':
          st.writes.set(c.text, (st.writes.get(c.text) ?? '') + ps + '\n');
          break;
      }
    }
    if (autoprint) out += ps + '\n';
    out += append;
  }
  return out;
}

const SED_USAGE = 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n  -e script, --expression=script\n                 add the script to the commands to be executed\n  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n  -s, --separate\n                 consider files as separate rather than as a single\n                 continuous long stream.';

const sed: Command = ({ sh, args, stdin }) => {
  let quiet = false;
  let ext = false;
  let separate = false;
  let inPlace: string | null = null;
  const scripts: { text: string; label: string }[] = [];
  const operands: string[] = [];
  const addFile = (f: string): string | null => {
    try {
      scripts.push({ text: sh.readFile(f).replace(/\n$/, ''), label: `file ${f}` });
      return null;
    } catch (e) {
      return `sed: couldn't open file ${f}: ${reason(e)}`;
    }
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      operands.push(...args.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const val = eq < 0 ? undefined : a.slice(eq + 1);
      if (name === 'quiet' || name === 'silent') quiet = true;
      else if (name === 'regexp-extended') ext = true;
      else if (name === 'separate') separate = true;
      else if (name === 'in-place') inPlace = val ?? '';
      else if (name === 'expression') scripts.push({ text: val ?? args[++k] ?? '', label: `-e expression #${scripts.length + 1}` });
      else if (name === 'file') {
        const e = addFile(val ?? args[++k] ?? '');
        if (e) return fail(e);
      } else if (name === 'help') return ok(SED_USAGE + '\n');
      else if (name === 'version') return ok('sed (GNU sed) 4.9\n');
      else if (!['posix', 'debug', 'sandbox', 'follow-symlinks', 'unbuffered'].includes(name)) return fail(`sed: unrecognized option '${a}'\n${SED_USAGE}`);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f === 'n') quiet = true;
        else if (f === 'E' || f === 'r') ext = true;
        else if (f === 's') separate = true;
        else if (f === 'u') continue;
        else if (f === 'i') {
          inPlace = a.slice(j + 1); // GNU: -i.bak keeps a backup; careful, -in means suffix "n"
          break;
        } else if (f === 'e' || f === 'f') {
          const v = a.slice(j + 1) || args[++k];
          if (v === undefined) return fail(`sed: option requires an argument -- '${f}'\n${SED_USAGE}`);
          if (f === 'e') scripts.push({ text: v, label: `-e expression #${scripts.length + 1}` });
          else {
            const e = addFile(v);
            if (e) return fail(e);
          }
          break;
        } else return fail(`sed: invalid option -- '${f}'\n${SED_USAGE}`);
      }
      continue;
    }
    operands.push(a);
  }
  if (!scripts.length) {
    const s = operands.shift();
    if (s === undefined) return fail(SED_USAGE);
    scripts.push({ text: s, label: '-e expression #1' });
  }
  // one program from all -e scripts; errors name the script and the character in it
  const text = scripts.map((x) => x.text).join('\n');
  let prog: SedProgram;
  try {
    prog = parseSed(text, ext);
  } catch (e) {
    if (!(e instanceof SedError)) throw e;
    let off = 0;
    for (const x of scripts) {
      if (e.pos <= off + x.text.length || x === scripts[scripts.length - 1]) return fail(`sed: ${x.label}, char ${Math.max(1, e.pos - off)}: ${e.message}`);
      off += x.text.length + 1;
    }
    return fail(`sed: -e expression #1, char ${e.pos}: ${e.message}`);
  }
  const st: SedState = { hold: '', lastRe: null, writes: new Map(), quit: false, code: 0 };
  let out = '';
  let err = '';
  let code = 0;
  const run = (lines: string[]) => {
    try {
      return runSed(sh, prog, lines, quiet, st);
    } catch (e) {
      if (!(e instanceof SedError)) throw e;
      err += `sed: ${e.message}\n`;
      code = 4;
      st.quit = true;
      return '';
    }
  };
  const read = (f: string): string | null => {
    if (f === '-') return stdin;
    try {
      return sh.readFile(f);
    } catch (e) {
      err += e instanceof FsError && e.reason === 'EISDIR' ? `sed: read error on ${f}: Is a directory\n` : `sed: can't read ${f}: ${reason(e)}\n`;
      code = 2;
      return null;
    }
  };
  for (const w of prog.wfiles) {
    if (w === '/dev/stdout' || w === '/dev/stderr') continue;
    try {
      sh.writeFile(w, '');
    } catch (e) {
      return fail(`sed: couldn't open file ${w}: ${reason(e)}`, 4);
    }
  }
  if (inPlace !== null) {
    if (!operands.length) return fail('sed: no input files', 1);
    for (const f of operands) {
      if (st.quit) break;
      const t = read(f);
      if (t === null) continue;
      const result = run(splitLines(t));
      try {
        if (inPlace) sh.writeFile(inPlace.includes('*') ? inPlace.replace(/\*/g, f.split('/').pop()!) : f + inPlace, t);
        sh.writeFile(f, result);
      } catch (e) {
        const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) || '/' : '.';
        err += `sed: couldn't open temporary file ${dir}/sedAb12Cd: ${reason(e)}\n`;
        code = 4;
      }
    }
  } else if (separate) {
    for (const f of operands.length ? operands : ['-']) {
      if (st.quit) break;
      const t = read(f);
      if (t !== null) out += run(splitLines(t));
    }
  } else {
    const all: string[] = [];
    for (const f of operands.length ? operands : ['-']) {
      const t = read(f);
      if (t !== null) all.push(...splitLines(t));
    }
    out += run(all);
  }
  for (const [w, t] of st.writes) {
    if (w === '/dev/stdout') out += t;
    else if (w === '/dev/stderr') err += t;
    else {
      try {
        sh.writeFile(w, t, true);
      } catch {
        // checked when it was opened
      }
    }
  }
  return { stdout: out, stderr: err, code: code || st.code };
};

// ---------- tr ----------

/** Expand a tr SET: ranges a-z, classes [:upper:], [=c=], escapes \n \t \\ \NNN, and [c*n] repeats (SET2). */
function trSet(spec: string, second: boolean): { chars: string[]; fill: number; classes: string[] } | string {
  const chars: string[] = [];
  const classes: string[] = [];
  let fill = -1; // position of a [c*] that fills SET2 up to the length of SET1
  let i = 0;
  const one = (): string => {
    const c = spec[i++];
    if (c !== '\\' || i >= spec.length) return c;
    const [ch, len] = cEscape(spec, i);
    if (ch.startsWith('\\') && ch.length === 2) {
      i++;
      return ch[1]; // \- \[ and other characters stand for themselves
    }
    i += len;
    return ch;
  };
  while (i < spec.length) {
    const cls = /^\[:(\w+):\]/.exec(spec.slice(i));
    if (cls) {
      if (!(cls[1] in CLASS_CHARS)) return `tr: invalid character class '${cls[1]}'`;
      chars.push(...CLASS_CHARS[cls[1]]);
      classes.push(cls[1]);
      i += cls[0].length;
      continue;
    }
    const eq = /^\[=(.)=\]/.exec(spec.slice(i));
    if (eq) {
      chars.push(eq[1]);
      i += eq[0].length;
      continue;
    }
    const rep = /^\[(\\?.)\*(\d*)\]/.exec(spec.slice(i));
    if (rep && second) {
      const c = rep[1].length === 2 ? cEscape(rep[1], 1)[0].slice(-1) : rep[1];
      const n = rep[2] === '' ? 0 : parseInt(rep[2], rep[2].startsWith('0') ? 8 : 10);
      if (n === 0) {
        fill = chars.length; // [c*] repeats c until SET2 is as long as SET1
        chars.push(c);
      } else chars.push(...Array<string>(n).fill(c));
      i += rep[0].length;
      continue;
    }
    const c = one();
    if (spec[i] === '-' && i + 1 < spec.length) {
      i++;
      const d = one();
      if (d.charCodeAt(0) < c.charCodeAt(0)) return `tr: range-endpoints of '${c}-${d}' are in reverse collating sequence order`;
      chars.push(...charRange(c.charCodeAt(0), d.charCodeAt(0)));
      continue;
    }
    chars.push(c);
  }
  return { chars, fill, classes };
}

const tr: Command = ({ args, stdin }) => {
  let del = false;
  let squeeze = false;
  let comp = false;
  let truncate = false;
  const ops: string[] = [];
  const usage = "Try 'tr --help' for more information.";
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (ops.length || !a.startsWith('-') || a === '-') {
      ops.push(a);
      continue;
    }
    if (a === '--') {
      ops.push(...args.slice(k + 1));
      break;
    }
    const long: Record<string, string> = { '--delete': 'd', '--squeeze-repeats': 's', '--complement': 'c', '--truncate-set1': 't' };
    const letters = a.startsWith('--') ? long[a] : a.slice(1);
    if (letters === undefined) return fail(`tr: unrecognized option '${a}'\n${usage}`);
    for (const f of letters) {
      if (f === 'd') del = true;
      else if (f === 's') squeeze = true;
      else if (f === 'c' || f === 'C') comp = true;
      else if (f === 't') truncate = true;
      else return fail(`tr: invalid option -- '${f}'\n${usage}`);
    }
  }
  const translating = !del && ops.length > 1;
  if (!ops.length) return fail(`tr: missing operand\n${usage}`);
  if (del && !squeeze && ops.length > 1) return fail(`tr: extra operand '${ops[1]}'\nOnly one string may be given when deleting without squeezing repeats.\n${usage}`);
  if (!del && !squeeze && ops.length === 1) return fail(`tr: missing operand after '${ops[0]}'\nTwo strings must be given when translating.\n${usage}`);
  if (del && squeeze && ops.length === 1) return fail(`tr: missing operand after '${ops[0]}'\nTwo strings must be given when both deleting and squeezing repeats.\n${usage}`);
  if (ops.length > 2) return fail(`tr: extra operand '${ops[2]}'\n${usage}`);
  const s1 = trSet(ops[0], false);
  if (typeof s1 === 'string') return fail(s1);
  const s2 = ops[1] !== undefined ? trSet(ops[1], true) : { chars: [] as string[], fill: -1, classes: [] as string[] };
  if (typeof s2 === 'string') return fail(s2);
  const set1 = new Set(s1.chars);
  const in1 = (c: string) => set1.has(c) !== comp;
  let out = [...stdin];
  if (del) out = out.filter((c) => !in1(c));
  else if (translating) {
    if (s2.classes.some((c) => c !== 'upper' && c !== 'lower')) return fail("tr: when translating, the only character classes that may appear in\nstring2 are 'upper' and 'lower'");
    const from = comp ? [...charRange(0, 255)].filter((c) => !set1.has(c)) : s1.chars;
    let to = s2.chars;
    if (s2.fill >= 0) to = [...to.slice(0, s2.fill), ...Array<string>(Math.max(0, from.length - to.length + 1)).fill(to[s2.fill]), ...to.slice(s2.fill + 1)];
    if (!to.length) return fail('tr: when not truncating set1, string2 must be non-empty');
    const map = new Map<string, string>();
    const n = truncate ? Math.min(from.length, to.length) : from.length;
    for (let k = 0; k < n; k++) map.set(from[k], to[Math.min(k, to.length - 1)]);
    const last = to[to.length - 1];
    out = out.map((c) => map.get(c) ?? (comp && !set1.has(c) && !truncate ? last : c));
  }
  if (squeeze) {
    const sq = translating || del ? new Set(s2.chars) : null;
    const squeezes = (c: string) => (sq ? sq.has(c) : in1(c));
    out = out.filter((c, k) => !(k > 0 && c === out[k - 1] && squeezes(c)));
  }
  return ok(out.join(''));
};

// ---------- awk ----------

/** Text from input (fields, split, -v): compares as a number when it looks like one. */
class StrNum {
  constructor(public s: string) {}
}
type AwkVal = string | number | StrNum | undefined; // undefined: never assigned
type AwkArray = Map<string, AwkVal>;

const NUM_RE = /^\s*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)\s*$/;
const NUM_PREFIX = /^\s*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/;

function fmtG(x: number, prec: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x < 0 ? '-inf' : 'inf';
  if (x === 0) return '0';
  const e = Number(x.toExponential(prec - 1).split('e')[1]);
  const s = e < -4 || e >= prec ? x.toExponential(prec - 1).replace(/e([+-])(\d)$/, 'e$10$2') : x.toFixed(Math.max(0, prec - 1 - e));
  return s.includes('.') ? s.replace(/\.?0+(e|$)/, '$1') : s;
}

const awkNum = (v: AwkVal): number => {
  if (typeof v === 'number') return v;
  if (v === undefined) return 0;
  const m = NUM_PREFIX.exec(v instanceof StrNum ? v.s : v);
  return m ? Number(m[0]) : 0;
};
const isNumeric = (v: AwkVal) => typeof v === 'number' || v === undefined || (v instanceof StrNum && NUM_RE.test(v.s));

interface AwkTok {
  t: 'num' | 'str' | 're' | 'name' | 'func' | 'builtin' | 'kw' | 'op' | 'nl' | 'eof';
  v: string;
  n: number;
  pos: number;
}

const AWK_KEYWORDS = new Set(['BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf']);
const AWK_BUILTINS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush']);
const AWK_OPS = ['**=', '+=', '-=', '*=', '/=', '%=', '^=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~', '**', '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$', '='];

class AwkSyntax extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}
class AwkFatal extends Error {
  constructor(
    message: string,
    public bare = false, // reported without the program location
  ) {
    super(message);
  }
}

type AwkInput = { file: string; text: string } | { assign: string; value: string } | { fatal: string };

/** Escapes in awk strings and -v values: \n \t \" \\ \/ \NNN; an unknown \c is just c (as gawk warns). */
function awkUnescape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const n = s[i + 1];
    if (n === '/' || n === '"') {
      out += n;
      i++;
      continue;
    }
    const [ch, len] = cEscape(s, i + 1);
    out += ch.length === 2 && ch[0] === '\\' && n !== '\\' ? n : ch;
    i += Math.max(1, len);
  }
  return out;
}

function awkLex(src: string): AwkTok[] {
  const toks: AwkTok[] = [];
  let i = 0;
  const push = (t: AwkTok['t'], v: string, pos: number, n = 0) => toks.push({ t, v, n, pos });
  const regexOk = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (['num', 'str', 're', 'name', 'builtin'].includes(p.t)) return false;
    return !(p.t === 'op' && [')', ']', '$', '++', '--'].includes(p.v));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      i += src[i + 1] === '\n' ? 2 : 3;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      push('nl', '\n', i++);
      continue;
    }
    const num = /^(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(src.slice(i));
    if (num && (/\d/.test(c) || c === '.')) {
      push('num', num[0], i, Number(num[0]));
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      const t = AWK_KEYWORDS.has(w) ? 'kw' : AWK_BUILTINS.has(w) ? 'builtin' : src[i + w.length] === '(' ? 'func' : 'name';
      push(t, w === 'func' ? 'function' : w, i);
      i += w.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') throw new AwkSyntax('unterminated string', j);
        if (src[j] === '\\' && j + 1 < src.length) {
          raw += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        raw += src[j++];
      }
      if (j >= src.length) throw new AwkSyntax('unterminated string', i);
      push('str', awkUnescape(raw), i);
      i = j + 1;
      continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1;
      let raw = '';
      let inBracket = false;
      while (j < src.length && (src[j] !== '/' || inBracket)) {
        if (src[j] === '\n') throw new AwkSyntax('unterminated regexp', j);
        if (src[j] === '\\' && j + 1 < src.length) {
          raw += src[j + 1] === '/' ? '/' : src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '[' && !inBracket) {
          inBracket = true;
          raw += src[j++];
          if (src[j] === '^') raw += src[j++];
          if (src[j] === ']') raw += src[j++];
          continue;
        }
        if (src[j] === ']') inBracket = false;
        raw += src[j++];
      }
      if (j >= src.length) throw new AwkSyntax('unterminated regexp', i);
      push('re', raw, i);
      i = j + 1;
      continue;
    }
    const op = AWK_OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new AwkSyntax(`invalid char '${c}' in expression`, i);
    push('op', op, i);
    i += op.length;
  }
  push('eof', '', src.length);
  return toks;
}

type AwkNode =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 're'; re: RegExp }
  | { k: 'var'; name: string }
  | { k: 'idx'; name: string; subs: AwkNode[] }
  | { k: 'field'; e: AwkNode }
  | { k: 'assign'; op: string; target: AwkNode; e: AwkNode }
  | { k: 'cond'; c: AwkNode; a: AwkNode; b: AwkNode }
  | { k: 'and' | 'or'; a: AwkNode; b: AwkNode }
  | { k: 'in'; subs: AwkNode[]; name: string }
  | { k: 'match'; neg: boolean; a: AwkNode; re: AwkNode }
  | { k: 'bin'; op: string; a: AwkNode; b: AwkNode }
  | { k: 'unary'; op: string; e: AwkNode }
  | { k: 'incdec'; op: string; prefix: boolean; target: AwkNode }
  | { k: 'call'; name: string; args: AwkNode[] }
  | { k: 'ucall'; name: string; args: AwkNode[] }
  | { k: 'group'; list: AwkNode[] };

type AwkStmt =
  | { k: 'expr'; e: AwkNode }
  | { k: 'print'; printf: boolean; args: AwkNode[]; redir?: { op: string; e: AwkNode } }
  | { k: 'block'; body: AwkStmt[] }
  | { k: 'if'; c: AwkNode; a: AwkStmt; b?: AwkStmt }
  | { k: 'while'; c: AwkNode; body: AwkStmt }
  | { k: 'do'; c: AwkNode; body: AwkStmt }
  | { k: 'for'; init?: AwkStmt; c?: AwkNode; step?: AwkStmt; body: AwkStmt }
  | { k: 'forin'; v: AwkNode; name: string; body: AwkStmt }
  | { k: 'break' | 'continue' | 'next' | 'nextfile' }
  | { k: 'exit' | 'return'; e?: AwkNode }
  | { k: 'delete'; name: string; subs?: AwkNode[] };

interface AwkItem {
  kind: 'BEGIN' | 'END' | 'main';
  pattern?: AwkNode;
  pattern2?: AwkNode; // pattern, pattern2 is a range
  action?: AwkStmt[]; // none: print $0
  inRange: boolean;
}

interface AwkFunc {
  params: string[];
  body: AwkStmt[];
}

interface AwkProgram {
  items: AwkItem[];
  funcs: Map<string, AwkFunc>;
}

const isLvalue = (n: AwkNode) => n.k === 'var' || n.k === 'idx' || n.k === 'field';
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**=']);

class AwkParser {
  private i = 0;
  private noGt = 0; // inside print arguments: > redirects output
  constructor(private toks: AwkTok[]) {}

  private get tok() {
    return this.toks[this.i];
  }
  private is(v: string, t: AwkTok['t'] = 'op') {
    const k = this.tok;
    return k.t === t && k.v === v;
  }
  private fail(msg = 'syntax error'): never {
    throw new AwkSyntax(msg, this.tok.pos);
  }
  private expect(v: string, t: AwkTok['t'] = 'op') {
    if (!this.is(v, t)) this.fail();
    this.i++;
  }
  private nls() {
    while (this.tok.t === 'nl') this.i++;
  }
  private seps() {
    while (this.tok.t === 'nl' || this.is(';')) this.i++;
  }

  program(): AwkProgram {
    const items: AwkItem[] = [];
    const funcs = new Map<string, AwkFunc>();
    for (;;) {
      this.seps();
      if (this.tok.t === 'eof') break;
      if (this.is('function', 'kw')) {
        this.i++;
        const name = this.tok;
        if (name.t !== 'name' && name.t !== 'func') this.fail();
        this.i++;
        this.expect('(');
        const params: string[] = [];
        while (!this.is(')')) {
          if (this.tok.t !== 'name') this.fail();
          params.push(this.tok.v);
          this.i++;
          if (this.is(',')) {
            this.i++;
            this.nls();
          } else if (!this.is(')')) this.fail();
        }
        this.i++;
        this.nls();
        funcs.set(name.v, { params, body: this.block() });
        continue;
      }
      if (this.is('BEGIN', 'kw') || this.is('END', 'kw')) {
        const kind = this.tok.v as 'BEGIN' | 'END';
        this.i++;
        this.nls();
        if (!this.is('{')) this.fail(`${kind} blocks must have an action part`);
        items.push({ kind, action: this.block(), inRange: false });
        continue;
      }
      const item: AwkItem = { kind: 'main', inRange: false };
      if (!this.is('{')) {
        item.pattern = this.expr();
        if (this.is(',')) {
          this.i++;
          this.nls();
          item.pattern2 = this.expr();
        }
      }
      if (this.is('{')) item.action = this.block();
      else if (!['nl', 'eof'].includes(this.tok.t) && !this.is(';')) this.fail();
      items.push(item);
    }
    return { items, funcs };
  }

  private block(): AwkStmt[] {
    this.expect('{');
    const body: AwkStmt[] = [];
    for (;;) {
      this.seps();
      if (this.is('}')) break;
      if (this.tok.t === 'eof') this.fail('unexpected newline or end of string');
      body.push(this.statement());
    }
    this.i++;
    return body;
  }

  /** The end of a simple statement: ; or a newline (taken), or } and the end (left). */
  private end() {
    if (this.is(';') || this.tok.t === 'nl') this.i++;
    else if (!this.is('}') && this.tok.t !== 'eof') this.fail();
  }

  private body(): AwkStmt {
    if (this.is(';')) {
      this.i++;
      return { k: 'block', body: [] };
    }
    this.nls();
    return this.statement();
  }

  private statement(): AwkStmt {
    const t = this.tok;
    if (this.is('{')) return { k: 'block', body: this.block() };
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': {
          this.i++;
          this.expect('(');
          const c = this.expr();
          this.expect(')');
          const a = this.body();
          let j = this.i;
          while (this.toks[j].t === 'nl' || (this.toks[j].t === 'op' && this.toks[j].v === ';')) j++;
          if (this.toks[j].t === 'kw' && this.toks[j].v === 'else') {
            this.i = j + 1;
            return { k: 'if', c, a, b: this.body() };
          }
          return { k: 'if', c, a };
        }
        case 'while': {
          this.i++;
          this.expect('(');
          const c = this.expr();
          this.expect(')');
          return { k: 'while', c, body: this.body() };
        }
        case 'do': {
          this.i++;
          const body = this.body();
          this.seps();
          this.expect('while', 'kw');
          this.expect('(');
          const c = this.expr();
          this.expect(')');
          this.end();
          return { k: 'do', c, body };
        }
        case 'for': {
          this.i++;
          this.expect('(');
          const [a, b, c] = [this.toks[this.i], this.toks[this.i + 1], this.toks[this.i + 2]];
          if (a.t === 'name' && b.t === 'kw' && b.v === 'in' && c.t === 'name' && this.toks[this.i + 3].v === ')') {
            this.i += 4;
            return { k: 'forin', v: { k: 'var', name: a.v }, name: c.v, body: this.body() };
          }
          const init = this.is(';') ? undefined : this.simple();
          this.expect(';');
          this.nls();
          const cond = this.is(';') ? undefined : this.expr();
          this.expect(';');
          this.nls();
          const step = this.is(')') ? undefined : this.simple();
          this.expect(')');
          return { k: 'for', init, c: cond, step, body: this.body() };
        }
        case 'break':
        case 'continue':
        case 'next':
        case 'nextfile':
          this.i++;
          this.end();
          return { k: t.v };
        case 'exit':
        case 'return': {
          this.i++;
          const e = this.is(';') || this.is('}') || this.tok.t === 'nl' || this.tok.t === 'eof' ? undefined : this.expr();
          this.end();
          return { k: t.v, e };
        }
        case 'delete': {
          this.i++;
          if (this.tok.t !== 'name') this.fail();
          const name = this.tok.v;
          this.i++;
          let subs: AwkNode[] | undefined;
          if (this.is('[')) {
            this.i++;
            subs = this.list();
            this.expect(']');
          }
          this.end();
          return { k: 'delete', name, subs };
        }
        case 'getline':
          this.fail('getline is not available in the practice terminal');
      }
    }
    const s = this.simple();
    this.end();
    return s;
  }

  private simple(): AwkStmt {
    if (this.is('print', 'kw') || this.is('printf', 'kw')) {
      const printf = this.tok.v === 'printf';
      this.i++;
      let args: AwkNode[] = [];
      this.noGt++;
      try {
        if (!(this.is(';') || this.is('}') || this.is('>') || this.is('>>') || this.is('|') || this.tok.t === 'nl' || this.tok.t === 'eof')) args = this.list();
      } finally {
        this.noGt--;
      }
      if (args.length === 1 && args[0].k === 'group') args = args[0].list;
      if (printf && !args.length) this.fail('printf: no format');
      let redir: { op: string; e: AwkNode } | undefined;
      if (this.is('>') || this.is('>>') || this.is('|')) {
        const op = this.tok.v;
        this.i++;
        this.noGt++;
        try {
          redir = { op, e: this.concat() };
        } finally {
          this.noGt--;
        }
      }
      return { k: 'print', printf, args, redir };
    }
    return { k: 'expr', e: this.expr() };
  }

  private list(): AwkNode[] {
    const out = [this.expr()];
    while (this.is(',')) {
      this.i++;
      this.nls();
      out.push(this.expr());
    }
    return out;
  }

  expr(): AwkNode {
    const left = this.ternary();
    if (this.tok.t === 'op' && ASSIGN_OPS.has(this.tok.v) && isLvalue(left)) {
      const op = this.tok.v;
      this.i++;
      this.nls();
      return { k: 'assign', op, target: left, e: this.expr() };
    }
    return left;
  }

  private ternary(): AwkNode {
    const c = this.or();
    if (!this.is('?')) return c;
    this.i++;
    this.nls();
    const a = this.expr();
    this.nls();
    this.expect(':');
    this.nls();
    return { k: 'cond', c, a, b: this.expr() };
  }

  private or(): AwkNode {
    let l = this.and();
    while (this.is('||')) {
      this.i++;
      this.nls();
      l = { k: 'or', a: l, b: this.and() };
    }
    return l;
  }

  private and(): AwkNode {
    let l = this.inExpr();
    while (this.is('&&')) {
      this.i++;
      this.nls();
      l = { k: 'and', a: l, b: this.inExpr() };
    }
    return l;
  }

  private inExpr(): AwkNode {
    let l = this.matchExpr();
    while (this.is('in', 'kw')) {
      this.i++;
      if (this.tok.t !== 'name') this.fail();
      l = { k: 'in', subs: l.k === 'group' ? l.list : [l], name: this.tok.v };
      this.i++;
    }
    return l;
  }

  private matchExpr(): AwkNode {
    let l = this.rel();
    while (this.is('~') || this.is('!~')) {
      const neg = this.tok.v === '!~';
      this.i++;
      l = { k: 'match', neg, a: l, re: this.rel() };
    }
    return l;
  }

  private rel(): AwkNode {
    let l = this.concat();
    while (this.tok.t === 'op' && ['<', '<=', '==', '!=', '>=', '>'].includes(this.tok.v) && !(this.noGt && this.tok.v === '>')) {
      const op = this.tok.v;
      this.i++;
      l = { k: 'bin', op, a: l, b: this.concat() };
    }
    return l;
  }

  private startsOperand(): boolean {
    const t = this.tok;
    if (['num', 'str', 're', 'name', 'func', 'builtin'].includes(t.t)) return true;
    return t.t === 'op' && ['$', '(', '++', '--'].includes(t.v);
  }

  private concat(): AwkNode {
    let l = this.additive();
    while (this.startsOperand()) l = { k: 'bin', op: ' ', a: l, b: this.additive() };
    return l;
  }

  private additive(): AwkNode {
    let l = this.mul();
    while (this.is('+') || this.is('-')) {
      const op = this.tok.v;
      this.i++;
      l = { k: 'bin', op, a: l, b: this.mul() };
    }
    return l;
  }

  private mul(): AwkNode {
    let l = this.unary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.tok.v;
      this.i++;
      l = { k: 'bin', op, a: l, b: this.unary() };
    }
    return l;
  }

  private unary(): AwkNode {
    if (this.is('!') || this.is('-') || this.is('+')) {
      const op = this.tok.v;
      this.i++;
      return { k: 'unary', op, e: this.unary() };
    }
    return this.power();
  }

  private power(): AwkNode {
    const base = this.postfix();
    if (this.is('^') || this.is('**')) {
      this.i++;
      return { k: 'bin', op: '^', a: base, b: this.unary() };
    }
    return base;
  }

  private postfix(): AwkNode {
    const e = this.primary();
    if (isLvalue(e) && (this.is('++') || this.is('--'))) {
      const op = this.tok.v;
      this.i++;
      return { k: 'incdec', op, prefix: false, target: e };
    }
    return e;
  }

  private primary(): AwkNode {
    const t = this.tok;
    switch (t.t) {
      case 'num':
        this.i++;
        return { k: 'num', v: t.n };
      case 'str':
        this.i++;
        return { k: 'str', v: t.v };
      case 're':
        this.i++;
        try {
          return { k: 're', re: compileRegex(t.v, true) };
        } catch (e) {
          throw new AwkSyntax(reason(e), t.pos);
        }
      case 'name':
        this.i++;
        if (this.is('[')) {
          this.i++;
          const subs = this.list();
          this.expect(']');
          return { k: 'idx', name: t.v, subs };
        }
        return { k: 'var', name: t.v };
      case 'func': {
        this.i++;
        this.expect('(');
        const args = this.is(')') ? [] : this.list();
        this.expect(')');
        return { k: 'ucall', name: t.v, args };
      }
      case 'builtin': {
        this.i++;
        let args: AwkNode[] = [];
        if (this.is('(')) {
          this.i++;
          const saved = this.noGt;
          this.noGt = 0;
          args = this.is(')') ? [] : this.list();
          this.noGt = saved;
          this.expect(')');
        } else if (t.v !== 'length') this.fail();
        return { k: 'call', name: t.v, args };
      }
      case 'kw':
        if (t.v === 'getline') this.fail('getline is not available in the practice terminal');
        this.fail();
    }
    if (this.is('$')) {
      this.i++;
      let e: AwkNode;
      if (this.is('++') || this.is('--')) {
        const op = this.tok.v;
        this.i++;
        e = { k: 'incdec', op, prefix: true, target: this.primary() };
      } else if (this.is('-') || this.is('!') || this.is('+')) {
        const op = this.tok.v;
        this.i++;
        e = { k: 'unary', op, e: this.primary() };
      } else e = this.primary();
      return { k: 'field', e };
    }
    if (this.is('(')) {
      this.i++;
      const saved = this.noGt;
      this.noGt = 0;
      this.nls();
      const list = this.list();
      this.nls();
      this.noGt = saved;
      this.expect(')');
      return list.length > 1 ? { k: 'group', list } : list[0];
    }
    if (this.is('++') || this.is('--')) {
      const op = this.tok.v;
      this.i++;
      const target = this.primary();
      if (!isLvalue(target)) this.fail();
      return { k: 'incdec', op, prefix: true, target };
    }
    if (this.is('-') || this.is('!') || this.is('+')) return this.unary();
    const kind: string = this.tok.t;
    return this.fail(kind === 'nl' || kind === 'eof' ? 'unexpected newline or end of string' : 'syntax error');
  }
}

// control flow of the awk interpreter
class AwkNext {}
class AwkExit {
  constructor(public code: number) {}
}
class AwkLoop {
  constructor(public brk: boolean) {}
}
class AwkReturn {
  constructor(public v: AwkVal) {}
}

const AWK_MAX_STEPS = 1000000;

class AwkRun {
  vars = new Map<string, AwkVal>();
  arrays = new Map<string, AwkArray>();
  frames: Map<string, AwkVal | AwkArray>[] = [];
  record = '';
  fields: string[] = [];
  out = '';
  err = '';
  outputs = new Map<string, { text: string; append: boolean }>();
  steps = 0;
  seed = 0;
  rng = 1;
  private reCache = new Map<string, RegExp>();

  constructor(
    private sh: Shell,
    private prog: AwkProgram,
  ) {
    for (const [k, v] of Object.entries({ FS: ' ', OFS: ' ', ORS: '\n', RS: '\n', SUBSEP: '\x1c', CONVFMT: '%.6g', OFMT: '%.6g', FILENAME: '' })) this.vars.set(k, v);
    for (const k of ['NR', 'FNR', 'RSTART', 'RLENGTH']) this.vars.set(k, 0);
    const env: AwkArray = new Map();
    for (const k of ['HOME', 'USER', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'HOSTNAME']) env.set(k, new StrNum(sh.getVar(k)));
    for (const [k, v] of Object.entries(sh.env)) if (sh.isExported(k)) env.set(k, new StrNum(v));
    this.arrays.set('ENVIRON', env);
  }

  tick() {
    if (++this.steps > AWK_MAX_STEPS) throw new AwkFatal(`stopped after ${AWK_MAX_STEPS} steps (practice terminal limit). Is a loop running forever?`);
  }

  // ----- values -----
  str(v: AwkVal, fmt = 'CONVFMT'): string {
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    if (v instanceof StrNum) return v.s;
    if (Number.isInteger(v)) return Math.abs(v) < 1e16 ? String(v) : BigInt(v).toString(); // gawk prints whole numbers in full
    const f = this.str(this.vars.get(fmt));
    return f === '%.6g' ? fmtG(v, 6) : this.sprintf(f, [v]);
  }
  bool(v: AwkVal): boolean {
    if (v === undefined) return false;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '';
    return NUM_RE.test(v.s) ? awkNum(v) !== 0 : v.s !== '';
  }
  regex(n: AwkNode): RegExp {
    if (n.k === 're') return n.re;
    const src = this.str(this.eval(n));
    let re = this.reCache.get(src);
    if (!re) {
      try {
        re = compileRegex(src, true);
      } catch (e) {
        throw new AwkFatal(`invalid regexp /${src}/: ${reason(e)}`);
      }
      this.reCache.set(src, re);
    }
    return re;
  }

  // ----- fields -----
  splitWith(s: string, fs: string | RegExp): string[] {
    if (fs === ' ') {
      const t = s.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
      return t === '' ? [] : t.split(/[ \t\n]+/);
    }
    if (s === '') return [];
    if (fs === '') return [...s];
    if (typeof fs === 'string' && fs.length === 1) return s.split(fs);
    const re = new RegExp((typeof fs === 'string' ? this.regex({ k: 'str', v: fs }) : fs).source, 'g');
    const out: string[] = [];
    let last = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      out.push(s.slice(last, m.index));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  }
  setRecord(s: string) {
    this.record = s;
    this.fields = this.splitWith(s, this.str(this.vars.get('FS')));
  }
  rebuild() {
    this.record = this.fields.join(this.str(this.vars.get('OFS')));
  }
  getField(i: number): AwkVal {
    if (i < 0) throw new AwkFatal(`attempt to access field ${i}`);
    if (i === 0) return new StrNum(this.record);
    return i <= this.fields.length ? new StrNum(this.fields[i - 1]) : undefined;
  }
  setField(i: number, v: string) {
    if (i < 0) throw new AwkFatal(`attempt to access field ${i}`);
    if (i === 0) return this.setRecord(v);
    while (this.fields.length < i) this.fields.push('');
    this.fields[i - 1] = v;
    this.rebuild();
  }

  // ----- variables -----
  private frame() {
    return this.frames[this.frames.length - 1];
  }
  getVar(name: string): AwkVal {
    const f = this.frame();
    if (f?.has(name)) {
      const v = f.get(name);
      if (v instanceof Map) throw new AwkFatal(`attempt to use array \`${name}' in a scalar context`);
      return v;
    }
    if (name === 'NF') return this.fields.length;
    if (this.arrays.has(name)) throw new AwkFatal(`attempt to use array \`${name}' in a scalar context`);
    return this.vars.get(name);
  }
  setVar(name: string, v: AwkVal) {
    const f = this.frame();
    if (f?.has(name)) {
      if (f.get(name) instanceof Map) throw new AwkFatal(`attempt to use array \`${name}' in a scalar context`);
      f.set(name, v);
      return;
    }
    if (this.arrays.has(name)) throw new AwkFatal(`attempt to use array \`${name}' in a scalar context`);
    if (name === 'NF') {
      const n = Math.max(0, Math.trunc(awkNum(v)));
      this.fields.length = Math.min(this.fields.length, n);
      while (this.fields.length < n) this.fields.push('');
      this.rebuild();
      return;
    }
    this.vars.set(name, v);
  }
  isArray(name: string): boolean {
    const f = this.frame();
    if (f?.has(name)) return f.get(name) instanceof Map;
    return this.arrays.has(name);
  }
  getArray(name: string): AwkArray {
    const f = this.frame();
    if (f?.has(name)) {
      const v = f.get(name);
      if (v instanceof Map) return v;
      if (v !== undefined) throw new AwkFatal(`attempt to use scalar \`${name}' as an array`);
      const a: AwkArray = new Map();
      f.set(name, a);
      return a;
    }
    let a = this.arrays.get(name);
    if (!a) {
      if (this.vars.get(name) !== undefined || name === 'NF') throw new AwkFatal(`attempt to use scalar \`${name}' as an array`);
      a = new Map();
      this.arrays.set(name, a);
    }
    return a;
  }
  key(subs: AwkNode[]): string {
    return subs.map((s) => this.str(this.eval(s))).join(this.str(this.vars.get('SUBSEP')));
  }

  get(n: AwkNode): AwkVal {
    if (n.k === 'var') return this.getVar(n.name);
    if (n.k === 'idx') {
      const a = this.getArray(n.name);
      const k = this.key(n.subs);
      if (!a.has(k)) a.set(k, undefined);
      return a.get(k);
    }
    if (n.k === 'field') return this.getField(Math.trunc(awkNum(this.eval(n.e))));
    throw new AwkFatal('assignment to a value that is not a variable');
  }
  set(n: AwkNode, v: AwkVal) {
    if (n.k === 'var') this.setVar(n.name, v);
    else if (n.k === 'idx') this.getArray(n.name).set(this.key(n.subs), v);
    else if (n.k === 'field') this.setField(Math.trunc(awkNum(this.eval(n.e))), this.str(v));
  }

  // ----- expressions -----
  arith(op: string, a: number, b: number): number {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0) throw new AwkFatal('division by zero attempted');
        return a / b;
      case '%':
        if (b === 0) throw new AwkFatal('division by zero attempted in `%\'');
        return a % b;
      default:
        return a ** b;
    }
  }
  compare(op: string, a: AwkVal, b: AwkVal): boolean {
    let c: number;
    if (isNumeric(a) && isNumeric(b)) {
      const x = awkNum(a);
      const y = awkNum(b);
      c = x < y ? -1 : x > y ? 1 : 0;
    } else {
      const x = this.str(a);
      const y = this.str(b);
      c = x < y ? -1 : x > y ? 1 : 0;
    }
    return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '==' ? c === 0 : c !== 0;
  }

  eval(n: AwkNode): AwkVal {
    switch (n.k) {
      case 'num':
        return n.v;
      case 'str':
        return n.v;
      case 're':
        return testRe(n.re, this.record) ? 1 : 0;
      case 'var':
      case 'idx':
      case 'field':
        return this.get(n);
      case 'group':
        throw new AwkFatal('a list in parentheses only works with "in" or print');
      case 'assign': {
        let v: AwkVal = this.eval(n.e);
        if (n.op !== '=') v = this.arith(n.op === '**=' ? '^' : n.op[0], awkNum(this.get(n.target)), awkNum(v));
        this.set(n.target, v);
        return v;
      }
      case 'cond':
        return this.bool(this.eval(n.c)) ? this.eval(n.a) : this.eval(n.b);
      case 'and':
        return this.bool(this.eval(n.a)) && this.bool(this.eval(n.b)) ? 1 : 0;
      case 'or':
        return this.bool(this.eval(n.a)) || this.bool(this.eval(n.b)) ? 1 : 0;
      case 'in':
        return this.getArray(n.name).has(this.key(n.subs)) ? 1 : 0;
      case 'match':
        return testRe(this.regex(n.re), this.str(this.eval(n.a))) !== n.neg ? 1 : 0;
      case 'bin': {
        const a = this.eval(n.a);
        const b = this.eval(n.b);
        if (n.op === ' ') return this.str(a) + this.str(b);
        if (['<', '<=', '>', '>=', '==', '!='].includes(n.op)) return this.compare(n.op, a, b) ? 1 : 0;
        return this.arith(n.op, awkNum(a), awkNum(b));
      }
      case 'unary': {
        const v = this.eval(n.e);
        return n.op === '!' ? (this.bool(v) ? 0 : 1) : n.op === '-' ? -awkNum(v) : awkNum(v);
      }
      case 'incdec': {
        const old = awkNum(this.get(n.target));
        const v = n.op === '++' ? old + 1 : old - 1;
        this.set(n.target, v);
        return n.prefix ? v : old;
      }
      case 'call':
        return this.builtin(n.name, n.args);
      case 'ucall':
        return this.callUser(n.name, n.args);
    }
  }

  callUser(name: string, args: AwkNode[]): AwkVal {
    const f = this.prog.funcs.get(name);
    if (!f) throw new AwkFatal(`function \`${name}' not defined`);
    if (args.length > f.params.length) throw new AwkFatal(`function \`${name}' called with more arguments than declared`);
    if (this.frames.length >= 200) throw new AwkFatal(`function \`${name}' calls itself too deeply (practice terminal limit)`);
    const frame = new Map<string, AwkVal | AwkArray>();
    f.params.forEach((p, k) => {
      const a = args[k];
      if (!a) frame.set(p, undefined);
      else if (a.k === 'var' && this.isArray(a.name)) frame.set(p, this.getArray(a.name)); // arrays are passed by reference
      else frame.set(p, this.eval(a));
    });
    this.frames.push(frame);
    try {
      this.execAll(f.body);
      return undefined;
    } catch (e) {
      if (e instanceof AwkReturn) return e.v;
      throw e;
    } finally {
      this.frames.pop();
    }
  }

  builtin(name: string, args: AwkNode[]): AwkVal {
    const val = (k: number) => (args[k] ? this.eval(args[k]) : undefined);
    const s = (k: number) => this.str(val(k));
    const n = (k: number) => awkNum(val(k));
    switch (name) {
      case 'length':
        if (!args.length) return [...this.record].length;
        if (args[0].k === 'var' && this.isArray(args[0].name)) return this.getArray(args[0].name).size;
        return [...s(0)].length;
      case 'substr': {
        const chars = [...s(0)];
        const start = Math.round(n(1));
        let from = start;
        let to = args.length > 2 ? start + Math.round(n(2)) : chars.length + 1;
        if (from < 1) from = 1;
        if (to > chars.length + 1) to = chars.length + 1;
        return to > from ? chars.slice(from - 1, to - 1).join('') : '';
      }
      case 'index': {
        const t = s(1);
        return s(0).indexOf(t) + 1;
      }
      case 'split': {
        const text = s(0);
        if (!args[1] || args[1].k !== 'var') throw new AwkFatal('split: second argument is not an array');
        const arr = this.getArray(args[1].name);
        const parts = this.splitWith(text, args[2]?.k === 're' ? args[2].re : args[2] ? s(2) : this.str(this.vars.get('FS')));
        arr.clear();
        parts.forEach((p, k) => arr.set(String(k + 1), new StrNum(p)));
        return parts.length;
      }
      case 'sub':
      case 'gsub': {
        const re = this.regex(args[0]);
        const target = args[2] ?? ({ k: 'field', e: { k: 'num', v: 0 } } as AwkNode);
        if (!isLvalue(target)) throw new AwkFatal(`${name} third parameter is not a changeable object`);
        const text = this.str(this.get(target));
        const rep = s(1);
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        let count = 0;
        let out = '';
        let last = 0;
        let prevEnd = -1;
        for (let m = g.exec(text); m; m = g.exec(text)) {
          const at = m.index;
          const matched = m[0];
          // like sed: an empty match right after the previous match is not replaced
          if (!(matched === '' && at === prevEnd)) {
            count++;
            out += text.slice(last, at) + rep.replace(/\\\\|\\&|&/g, (x) => (x === '&' ? matched : x === '\\&' ? '&' : '\\'));
            last = at + matched.length;
            prevEnd = last;
            if (name === 'sub') break;
          }
          if (matched === '') {
            if (at >= text.length) break;
            g.lastIndex = at + 1;
          }
        }
        if (count) this.set(target, out + text.slice(last));
        return count;
      }
      case 'match': {
        const m = this.regex(args[1]).exec(s(0));
        this.vars.set('RSTART', m ? [...s(0).slice(0, m.index)].length + 1 : 0);
        this.vars.set('RLENGTH', m ? [...m[0]].length : -1);
        return this.vars.get('RSTART');
      }
      case 'sprintf':
        if (!args.length) throw new AwkFatal('sprintf: no arguments');
        return this.sprintf(s(0), args.slice(1).map((a) => this.eval(a)));
      case 'sin':
        return Math.sin(n(0));
      case 'cos':
        return Math.cos(n(0));
      case 'atan2':
        return Math.atan2(n(0), n(1));
      case 'exp':
        return Math.exp(n(0));
      case 'log':
        return Math.log(n(0));
      case 'sqrt':
        return Math.sqrt(n(0));
      case 'int':
        return Math.trunc(n(0));
      case 'rand':
        // a fixed sequence until srand(), like awk
        this.rng = (this.rng * 1103515245 + 12345) % 2147483648;
        return this.rng / 2147483648;
      case 'srand': {
        const prev = this.seed;
        this.seed = args.length ? Math.trunc(n(0)) : Math.floor(Date.now() / 1000);
        this.rng = this.seed || 1;
        return prev;
      }
      case 'tolower':
        return s(0).toLowerCase();
      case 'toupper':
        return s(0).toUpperCase();
      case 'close':
      case 'fflush':
        return 0;
      default:
        throw new AwkFatal(`${name}() is not available in the practice terminal`);
    }
  }

  sprintf(fmt: string, vals: AwkVal[]): string {
    let out = '';
    let ai = 0;
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] !== '%') {
        out += fmt[i];
        continue;
      }
      const m = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([cdiouxXeEfFgGs%])/.exec(fmt.slice(i));
      if (!m) {
        out += '%';
        continue;
      }
      i += m[0].length - 1;
      if (m[4] === '%') {
        out += '%';
        continue;
      }
      let spec = '%' + m[1];
      if (m[2] === '*') spec += String(Math.trunc(awkNum(vals[ai++])));
      else if (m[2]) spec += m[2];
      if (m[3] !== undefined) spec += '.' + (m[3] === '*' ? String(Math.trunc(awkNum(vals[ai++]))) : m[3]);
      const v = vals[ai++];
      const conv = m[4];
      let arg: string;
      if (conv === 'c') arg = isNumeric(v) && v !== undefined ? String.fromCharCode(awkNum(v)) : this.str(v).slice(0, 1);
      else if ('diouxX'.includes(conv)) {
        const x = Math.trunc(awkNum(v));
        arg = Number.isFinite(x) ? x.toFixed(0) : '0';
      } else if ('eEfFgG'.includes(conv)) arg = String(awkNum(v));
      else arg = this.str(v);
      out += formatPrintf(spec + (conv === 'c' ? 's' : conv), [arg]).out;
    }
    return out;
  }

  // ----- statements -----
  write(text: string, redir?: { op: string; e: AwkNode }) {
    if (!redir) {
      this.out += text;
      return;
    }
    if (redir.op === '|') throw new AwkFatal('output to a command (print | "cmd") is not available in the practice terminal. Pipe the output of awk instead: awk \'...\' file | sort');
    const file = this.str(this.eval(redir.e));
    if (file === '/dev/stdout' || file === '-') this.out += text;
    else if (file === '/dev/stderr') this.err += text;
    else {
      const o = this.outputs.get(file);
      if (o) o.text += text;
      else this.outputs.set(file, { text, append: redir.op === '>>' });
    }
  }

  exec(st: AwkStmt) {
    switch (st.k) {
      case 'expr':
        this.eval(st.e);
        return;
      case 'print': {
        if (st.printf) {
          const [fmt, ...rest] = st.args.map((a) => this.eval(a));
          this.write(this.sprintf(this.str(fmt), rest), st.redir);
          return;
        }
        const vals = st.args.length ? st.args.map((a) => this.str(this.eval(a), 'OFMT')) : [this.record];
        this.write(vals.join(this.str(this.vars.get('OFS'))) + this.str(this.vars.get('ORS')), st.redir);
        return;
      }
      case 'block':
        this.execAll(st.body);
        return;
      case 'if':
        if (this.bool(this.eval(st.c))) this.exec(st.a);
        else if (st.b) this.exec(st.b);
        return;
      case 'while':
        while (this.bool(this.eval(st.c))) if (!this.loop(st.body)) break;
        return;
      case 'do':
        do if (!this.loop(st.body)) break;
        while (this.bool(this.eval(st.c)));
        return;
      case 'for':
        if (st.init) this.exec(st.init);
        while (!st.c || this.bool(this.eval(st.c))) {
          if (!this.loop(st.body)) break;
          if (st.step) this.exec(st.step);
        }
        return;
      case 'forin': {
        const arr = this.getArray(st.name);
        for (const k of [...arr.keys()]) {
          if (!arr.has(k)) continue;
          this.set(st.v, k);
          if (!this.loop(st.body)) break;
        }
        return;
      }
      case 'break':
      case 'continue':
        throw new AwkLoop(st.k === 'break');
      case 'next':
      case 'nextfile':
        throw new AwkNext();
      case 'exit':
        throw new AwkExit(st.e ? Math.trunc(awkNum(this.eval(st.e))) & 255 : 0);
      case 'return':
        throw new AwkReturn(st.e ? this.eval(st.e) : undefined);
      case 'delete': {
        const arr = this.getArray(st.name);
        if (st.subs) arr.delete(this.key(st.subs));
        else arr.clear();
      }
    }
  }
  /** Run a loop body once. False when the loop must stop (break). */
  loop(body: AwkStmt): boolean {
    this.tick();
    try {
      this.exec(body);
    } catch (e) {
      if (e instanceof AwkLoop) return !e.brk;
      throw e;
    }
    return true;
  }
  execAll(body: AwkStmt[]) {
    for (const s of body) this.exec(s);
  }

  /** Does a main rule apply to the current record? */
  selects(it: AwkItem): boolean {
    if (!it.pattern) return true;
    if (!it.pattern2) return this.bool(this.eval(it.pattern));
    if (!it.inRange) {
      if (!this.bool(this.eval(it.pattern))) return false;
      it.inRange = !this.bool(this.eval(it.pattern2));
      return true;
    }
    if (this.bool(this.eval(it.pattern2))) it.inRange = false;
    return true;
  }

  /** Run the program over the inputs (null text: the file could not be read, already reported). */
  run(inputs: AwkInput[], readsInput: boolean): number {
    const { items } = this.prog;
    const begin = items.filter((it) => it.kind === 'BEGIN');
    const main = items.filter((it) => it.kind === 'main');
    const end = items.filter((it) => it.kind === 'END');
    let code = 0;
    let exited = false;
    try {
      for (const it of begin) this.execAll(it.action!);
    } catch (e) {
      if (!(e instanceof AwkExit)) throw e;
      code = e.code;
      exited = true;
    }
    if (!exited && readsInput) {
      try {
        for (const inp of inputs) {
          if ('assign' in inp) {
            this.setVar(inp.assign, new StrNum(inp.value));
            continue;
          }
          if ('fatal' in inp) throw new AwkFatal(inp.fatal, true);
          this.vars.set('FILENAME', inp.file);
          this.vars.set('FNR', 0);
          const rs = this.str(this.vars.get('RS'));
          let records: string[];
          if (rs === '\n') records = splitLines(inp.text);
          else if (rs === '') records = inp.text.replace(/^\n+/, '').split(/\n\n+/).filter((r, k, a) => r !== '' || k < a.length - 1);
          else records = inp.text.split(rs[0]).filter((r, k, a) => !(k === a.length - 1 && (r === '' || r === '\n')));
          for (const r of records) {
            this.tick();
            this.vars.set('NR', awkNum(this.vars.get('NR')) + 1);
            this.vars.set('FNR', awkNum(this.vars.get('FNR')) + 1);
            this.setRecord(rs === '' ? r.replace(/\n$/, '') : r);
            try {
              for (const it of main) {
                if (!this.selects(it)) continue;
                if (it.action) this.execAll(it.action);
                else this.out += this.record + this.str(this.vars.get('ORS'));
              }
            } catch (e) {
              if (!(e instanceof AwkNext)) throw e;
            }
          }
        }
      } catch (e) {
        if (!(e instanceof AwkExit)) throw e;
        code = e.code;
      }
    }
    try {
      for (const it of end) this.execAll(it.action!);
    } catch (e) {
      if (!(e instanceof AwkExit)) throw e;
      code = e.code;
    }
    return code;
  }
}

const AWK_USAGE = "Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nUsage: awk [POSIX or GNU style options] [--] 'program' file ...\nPOSIX options:\t\tGNU long options: (standard)\n\t-f progfile\t\t--file=progfile\n\t-F fs\t\t\t--field-separator=fs\n\t-v var=val\t\t--assign=var=val\n\nExamples:\n\tawk '{ sum += $1 }; END { print sum }' file\n\tawk -F: '{ print $1 }' /etc/passwd";

const awk: Command = ({ sh, args, stdin }) => {
  let fs: string | undefined;
  const assigns: [string, string][] = [];
  let progText: string | undefined;
  let progLabel = 'cmd. line';
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      k++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    const long = /^--(field-separator|assign|file)(?:=(.*))?$/.exec(a);
    const opt = long ? { 'field-separator': 'F', assign: 'v', file: 'f' }[long[1]]! : a[1];
    if (!long && !'Fvf'.includes(opt)) {
      if (a === '--version' || a === '-V') return ok('GNU Awk 5.3.0, API 4.0, PMA Avon 8-g1, (GNU MPFR 4.2.1, GNU MP 6.2.1)\n');
      return fail(`awk: ${a.startsWith('--') ? `unrecognized option '${a}'` : `invalid option -- '${a[1]}'`}\n${AWK_USAGE}`, 2);
    }
    const v = long ? (long[2] ?? args[++k]) : a.slice(2) || args[++k];
    if (v === undefined) return fail(`awk: option requires an argument -- ${opt}\n${AWK_USAGE}`, 2);
    if (opt === 'F') fs = v === 't' ? '\t' : awkUnescape(v);
    else if (opt === 'v') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(v);
      if (!m) return fail(`awk: \`${v}' argument to \`-v' not in \`var=value' form\n\n${AWK_USAGE}`, 2);
      assigns.push([m[1], awkUnescape(m[2])]);
    } else {
      try {
        progText = (progText ? progText + '\n' : '') + sh.readFile(v);
        progLabel = v;
      } catch (e) {
        return fail(`awk: fatal: can't open source file \`${v}' for reading: ${reason(e)}`, 2);
      }
    }
  }
  if (progText === undefined) {
    if (k >= args.length) return fail(AWK_USAGE, 2);
    progText = args[k++];
  }
  const operands = args.slice(k);
  let prog: AwkProgram;
  try {
    prog = new AwkParser(awkLex(progText)).program();
  } catch (e) {
    if (!(e instanceof AwkSyntax)) throw e;
    const before = progText.slice(0, e.pos);
    const lineNo = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = progText.indexOf('\n', lineStart);
    const text = progText.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
    const label = `awk: ${progLabel}:${lineNo}:`;
    return fail(`${label} ${text}\n${label} ${' '.repeat(e.pos - lineStart)}^ ${e.message}`, 2);
  }
  const r = new AwkRun(sh, prog);
  if (fs !== undefined) r.vars.set('FS', fs);
  for (const [name, value] of assigns) r.vars.set(name, new StrNum(value));
  const inputs: AwkInput[] = [];
  let readErr = '';
  const fileOps = operands.filter((o) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(o));
  for (const o of operands) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(o);
    if (m) {
      inputs.push({ assign: m[1], value: awkUnescape(m[2]) });
      continue;
    }
    if (o === '-' || o === '/dev/stdin') {
      inputs.push({ file: o === '-' ? '' : o, text: stdin });
      continue;
    }
    try {
      inputs.push({ file: o, text: sh.readFile(o) });
    } catch (e) {
      if (e instanceof FsError && e.reason === 'EISDIR') readErr += `awk: warning: command line argument \`${o}' is a directory: skipped\n`;
      else {
        // gawk reads the files before it, then stops here
        inputs.push({ fatal: `cannot open file \`${o}' for reading: ${reason(e)}` });
        break;
      }
    }
  }
  if (!fileOps.length) inputs.push({ file: '', text: stdin });
  const readsInput = prog.items.some((it) => it.kind !== 'BEGIN');
  let code: number;
  try {
    code = r.run(inputs, readsInput);
  } catch (e) {
    if (!(e instanceof AwkFatal)) throw e;
    return { stdout: r.out, stderr: r.err + readErr + `awk: ${e.bare ? '' : `${progLabel}:1: `}fatal: ${e.message}\n`, code: 2 };
  }
  for (const [file, o] of r.outputs) {
    try {
      sh.writeFile(file, o.text, o.append);
    } catch (e) {
      return { stdout: r.out, stderr: r.err + readErr + `awk: ${progLabel}:1: fatal: can't redirect to \`${file}' (${reason(e)})\n`, code: 2 };
    }
  }
  return { stdout: r.out, stderr: r.err + readErr, code };
};

export const TEXT_COMMANDS: Record<string, Command> = { sed, tr, awk };

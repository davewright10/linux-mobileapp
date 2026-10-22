// Bash parser for the practice terminal. Turns a command line or a script into a syntax tree:
// lists, pipelines, ; && || &, redirections (> >> < 2> 2>&1 >&2 &> <<EOF <<- <<<), if, for, while,
// until, case, functions, { } and ( ) groups, (( )) and [[ ]]. Words are kept unexpanded; the Shell
// expands them when each command runs, so loops and later commands see updated variables.
// Also holds the arithmetic evaluator used by $(( )), (( )), let and for (( )).

/** An expanded word, ready for globbing. `pattern` is the text with quoted glob characters escaped. */
export interface Word {
  text: string;
  glob: boolean; // true if it holds an unquoted * ? or [
  pattern?: string;
}

export type WordPart =
  | { type: 'lit'; text: string; quoted: boolean }
  | { type: 'param'; name: string; op: string; arg: string; quoted: boolean } // $x ${x} ${x:-arg} ${#x}
  | { type: 'cmd'; body: CompleteCommand[]; quoted: boolean } // $(...) and `...`
  | { type: 'arith'; src: string; quoted: boolean }; // $((...))

/** A word as written in the source. `raw` is the source text, used to spot reserved words. */
export interface WordNode {
  parts: WordPart[];
  raw: string;
}

export interface HereDoc {
  body: string;
  expand: boolean; // false when the delimiter was quoted (<<'EOF')
}

export interface Redirect {
  fd: number; // the descriptor being redirected; -1 means both stdout and stderr (&>)
  op: '<' | '>' | '>>' | '>&' | '<&' | '<<' | '<<<';
  target: WordNode;
  heredoc?: HereDoc;
}

export interface Assign {
  name: string;
  value: WordPart[];
  append: boolean; // x+=value
}

interface Base {
  redirects: Redirect[];
  line: number;
}
export type SimpleCommand = Base & { type: 'simple'; assigns: Assign[]; words: WordNode[] };
export type Command =
  | SimpleCommand
  | (Base & { type: 'group'; body: List })
  | (Base & { type: 'subshell'; body: List })
  | (Base & { type: 'if'; clauses: { cond: List; body: List }[]; orElse: List | null })
  | (Base & { type: 'for'; name: string; words: WordNode[] | null; body: List })
  | (Base & { type: 'cfor'; init: string; test: string; step: string; body: List })
  | (Base & { type: 'while'; until: boolean; cond: List; body: List })
  | (Base & { type: 'case'; word: WordNode; items: CaseItem[] })
  | (Base & { type: 'arith'; src: string })
  | (Base & { type: 'cond'; items: CondItem[] })
  | (Base & { type: 'func'; name: string; body: Command; src: string }); // src: the body as typed, for declare -f

export interface CaseItem {
  patterns: WordNode[];
  body: List;
  term: ';;' | ';&' | ';;&';
}
export type CondItem = { op: string } | { word: WordNode };

export interface Pipeline {
  cmds: Command[];
  bang: boolean; // ! pipeline
  time: boolean;
  pipeStderr: boolean[]; // |& after command i
}
export interface AndOr {
  first: Pipeline;
  rest: { op: '&&' | '||'; pipeline: Pipeline }[];
  background: boolean;
}
export type List = AndOr[];

/** One newline-terminated command line. Bash parses and runs a script one of these at a time. */
export interface CompleteCommand {
  list: List;
  line: number;
  warnings: { line: number; message: string }[];
}

export interface ParseResult {
  commands: CompleteCommand[]; // everything before the first error
  error: ParseError | null;
}

/** Why the input stopped early: more lines would complete it. */
export type Incomplete = 'quote' | 'heredoc' | 'backslash' | 'construct';

export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public incomplete: Incomplete | null = null,
  ) {
    super(message);
  }
}

type Tok = { line: number; pos: number; end: number } & (
  | { t: 'word'; w: WordNode; heredoc?: HereDoc; warning?: { line: number; message: string } }
  | { t: 'op'; op: string; fd: number | null }
  | { t: 'arith'; src: string }
  | { t: 'eof' }
  | { t: 'error'; err: ParseError }
);
type WordTok = Extract<Tok, { t: 'word' }>;

const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const OPS = ['<<<', '<<-', '&>>', ';;&', '<<', '>>', '<&', '>&', '>|', '<>', '&&', '||', '|&', ';;', ';&', '&>', '<', '>', '|', '&', ';', '(', ')'];
const REDIR_OPS = new Set(['<', '>', '>>', '>|', '<>', '<&', '>&', '&>', '&>>', '<<', '<<-', '<<<']);
const PARAM_OPS = [':-', ':=', ':+', ':?', '##', '%%', '//', '/#', '/%', '^^', ',,', '-', '=', '+', '?', '#', '%', '/', '^', ',', ':'];
const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y;

export const isName = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

function addLit(parts: WordPart[], text: string, quoted: boolean, force = false) {
  const last = parts[parts.length - 1];
  if (last && last.type === 'lit' && last.quoted === quoted) last.text += text;
  else if (text || force) parts.push({ type: 'lit', text, quoted });
}

/** Read one escape of $'...', printf or echo -e starting after the backslash. Returns [text, length]. */
export function cEscape(s: string, i: number, octalNeedsZero = false): [string, number] {
  const c = s[i];
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  if (c in simple) return [simple[c], 1];
  if (/[0-7]/.test(c ?? '') && (!octalNeedsZero || c === '0')) {
    const start = octalNeedsZero ? i + 1 : i;
    const m = /^[0-7]{1,3}/.exec(s.slice(start, start + 3));
    const digits = m ? m[0] : '';
    return [String.fromCharCode(parseInt(digits || '0', 8) & 255), start - i + digits.length];
  }
  if (c === 'x' || c === 'u' || c === 'U') {
    const max = c === 'x' ? 2 : c === 'u' ? 4 : 8;
    const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(s.slice(i + 1, i + 1 + max));
    if (!m) return ['\\' + c, 1];
    return [String.fromCodePoint(parseInt(m[0], 16)), 1 + m[0].length];
  }
  if (c === 'c' && i + 1 < s.length) return [String.fromCharCode(s.charCodeAt(i + 1) & 31), 2];
  return ['\\' + (c ?? ''), c === undefined ? 0 : 1];
}

/** Skip a "..." string that starts after the opening quote. Returns the index after the closing quote. */
function skipDouble(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if (c === '$' && s[i + 1] === '(') {
      const e = scanParen(s, i + 2);
      if (e < 0) return -1;
      i = e + 1;
    } else i++;
  }
  return -1;
}

/** Find the ) that closes a $( or ( whose contents start at i. */
function scanParen(s: string, i: number): number {
  let depth = 1;
  let cases = 0; // inside case ... esac, "a)" ends a pattern, not the $( )
  const docs: { delim: string; strip: boolean }[] = []; // here-documents whose bodies start on the next line
  const cmdStart = (k: number) => /^$|[;&|({\n]$/.test(s.slice(0, k).replace(/[ \t]+$/, '').slice(-1));
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|()<>]+))/.exec(s.slice(i, i + 200));
      if (m) docs.push({ delim: m[2] ?? m[3] ?? m[4].replace(/['"\\]/g, ''), strip: m[1] === '-' });
      i += m ? m[0].length : 2;
    } else if (c === '\n' && docs.length) {
      // skip the bodies: an apostrophe or ) in a here-document does not count
      i++;
      for (const d of docs) {
        for (;;) {
          if (i >= s.length) return -1;
          const e = s.indexOf('\n', i);
          const text = s.slice(i, e < 0 ? s.length : e);
          i = e < 0 ? s.length : e + 1;
          if ((d.strip ? text.replace(/^\t+/, '') : text) === d.delim) break;
        }
      }
      docs.length = 0;
    }
    else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) return -1;
      i = e + 1;
    } else if (c === '"') {
      i = skipDouble(s, i + 1);
      if (i < 0) return -1;
    } else if (c === '`') {
      const e = s.indexOf('`', i + 1);
      if (e < 0) return -1;
      i = e + 1;
    } else if (c === '#' && (i === 0 || /[\s;(]/.test(s[i - 1]))) {
      while (i < s.length && s[i] !== '\n') i++;
    } else if ((c === 'c' || c === 'e') && /^(case|esac)(?=[\s;&|)]|$)/.test(s.slice(i, i + 5)) && (c === 'e' || cmdStart(i))) {
      if (c === 'c') cases++;
      else if (cases > 0) cases--;
      i += 4;
    } else {
      if (c === '(') depth++;
      else if (c === ')' && !(cases > 0 && depth === 1) && --depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** Find the } that closes a ${ whose contents start at i. */
function scanBrace(s: string, i: number): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      if (e < 0) return -1;
      i = e + 1;
    } else if (c === '"') {
      i = skipDouble(s, i + 1);
      if (i < 0) return -1;
    } else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** Find the )) that closes (( or $(( whose contents start at i. -1: not arithmetic, -2: input ended. */
function scanArith(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth > 0) depth--;
      else if (s[i + 1] === ')') return i;
      else return i + 1 >= s.length ? -2 : -1;
    }
  }
  return -2;
}

function paramPart(inner: string, quoted: boolean): WordPart {
  const bad: WordPart = { type: 'param', name: inner, op: 'bad', arg: '', quoted };
  if (inner.length > 1 && inner[0] === '#') {
    const m = /^#([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])$/.exec(inner);
    if (m) return { type: 'param', name: m[1], op: 'len', arg: '', quoted };
  }
  if (inner.length > 1 && inner[0] === '!') {
    const m = /^!([A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/.exec(inner);
    return m ? { type: 'param', name: m[1], op: 'ind', arg: '', quoted } : bad;
  }
  const idx = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]$/.exec(inner);
  if (idx) return { type: 'param', name: idx[1], op: 'idx', arg: idx[2], quoted };
  const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/.exec(inner);
  if (!m) return bad;
  const rest = inner.slice(m[0].length);
  if (!rest) return { type: 'param', name: m[0], op: '', arg: '', quoted };
  const op = PARAM_OPS.find((o) => rest.startsWith(o));
  return op ? { type: 'param', name: m[0], op, arg: rest.slice(op.length), quoted } : bad;
}

class Lexer {
  pos = 0;
  line: number;
  private docs: { tok: WordTok; strip: boolean }[] = [];
  private docNext: boolean | null = null; // the next word is a here-doc delimiter (value: strip tabs)

  constructor(
    private src: string,
    private script: boolean,
    firstLine = 1,
  ) {
    this.line = firstLine;
  }

  tokens(): Tok[] {
    const out: Tok[] = [];
    for (;;) {
      let tok: Tok;
      try {
        tok = this.next();
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        out.push({ t: 'error', err: e, line: e.line, pos: this.pos, end: this.pos });
        return out;
      }
      out.push(tok);
      if (tok.t === 'eof') return out;
    }
  }

  private moveTo(i: number) {
    for (let k = this.pos; k < i; k++) if (this.src[k] === '\n') this.line++;
    this.pos = i;
  }

  private next(): Tok {
    const s = this.src;
    for (;;) {
      const c = s[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') this.pos++;
      else if (c === '\\' && s[this.pos + 1] === '\n') {
        this.pos += 2;
        this.line++;
      } else if (c === '#') {
        while (this.pos < s.length && s[this.pos] !== '\n') this.pos++;
      } else break;
    }
    const start = this.pos;
    const line = this.line;
    if (this.pos >= s.length) {
      if (this.docs.length) this.readHereDocs();
      return { t: 'eof', line, pos: start, end: start };
    }
    const c = s[this.pos];
    if (c === '\n') {
      this.pos++;
      this.line++;
      this.docNext = null;
      if (this.docs.length) this.readHereDocs();
      return { t: 'op', op: '\n', fd: null, line, pos: start, end: start + 1 };
    }
    if (c === '(' && s[this.pos + 1] === '(') {
      const end = scanArith(s, this.pos + 2);
      if (end === -2) throw new ParseError("unexpected EOF while looking for matching `)'", line, 'construct');
      if (end >= 0) {
        const src = s.slice(this.pos + 2, end);
        this.moveTo(end + 2);
        this.docNext = null;
        return { t: 'arith', src, line, pos: start, end: this.pos };
      }
    }
    let p = this.pos;
    let fd: number | null = null;
    const io = /^\d+(?=[<>])/.exec(s.slice(p, p + 8));
    if (io) {
      fd = Number(io[0]);
      p += io[0].length;
    }
    for (const op of OPS) {
      if (s.startsWith(op, p) && (fd === null || op[0] === '<' || op[0] === '>')) {
        this.pos = p + op.length;
        this.docNext = op === '<<' || op === '<<-' ? op === '<<-' : null;
        return { t: 'op', op, fd, line, pos: start, end: this.pos };
      }
    }
    const w = this.readWord('word');
    const tok: WordTok = { t: 'word', w, line, pos: start, end: this.pos };
    if (this.docNext !== null) this.docs.push({ tok, strip: this.docNext });
    this.docNext = null;
    return tok;
  }

  private readHereDocs() {
    const s = this.src;
    for (const d of this.docs) {
      const raw = d.tok.w.raw;
      const delim = raw.replace(/['"]/g, '').replace(/\\(.)/g, '$1');
      let body = '';
      for (;;) {
        if (this.pos >= s.length) {
          if (!this.script) throw new ParseError('here-document', d.tok.line, 'heredoc');
          d.tok.warning = { line: this.line, message: `warning: here-document at line ${d.tok.line} delimited by end-of-file (wanted \`${delim}')` };
          break;
        }
        const nl = s.indexOf('\n', this.pos);
        let text = s.slice(this.pos, nl < 0 ? s.length : nl).replace(/\r$/, '');
        this.pos = nl < 0 ? s.length : nl + 1;
        if (nl >= 0) this.line++;
        if (d.strip) text = text.replace(/^\t+/, '');
        if (text === delim) break;
        body += text + '\n';
      }
      d.tok.heredoc = { body, expand: !/['"\\]/.test(raw) };
    }
    this.docs = [];
  }

  /** Read a word. In 'word' mode it stops at blanks and operators; in 'text' mode it takes everything. */
  readWord(mode: 'word' | 'text'): WordNode {
    const s = this.src;
    const start = this.pos;
    const parts: WordPart[] = [];
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (mode === 'word' && META.has(c)) break;
      if (c === '\\') {
        const n = s[this.pos + 1];
        if (n === '\n') {
          this.pos += 2;
          this.line++;
        } else if (n === undefined) {
          if (mode === 'word' && !this.script) throw new ParseError('unexpected end of file', this.line, 'backslash');
          if (mode === 'text') addLit(parts, '\\', false);
          this.pos++;
        } else {
          addLit(parts, n, true);
          this.pos += 2;
        }
      } else if (c === "'") {
        const end = s.indexOf("'", this.pos + 1);
        if (end < 0) throw new ParseError("unexpected EOF while looking for matching `''", this.line, 'quote');
        addLit(parts, s.slice(this.pos + 1, end), true, true);
        this.moveTo(end + 1);
      } else if (c === '"') {
        this.pos++;
        this.readSpecial(parts, '"', '$`"\\\n');
      } else if (c === '`') this.readBacktick(parts, false);
      else if (c === '$') this.readDollar(parts, false);
      else {
        if (c === '\n') this.line++;
        addLit(parts, c, false);
        this.pos++;
      }
    }
    return { parts, raw: s.slice(start, this.pos) };
  }

  /**
   * Read text where only $, ` and backslash are special: the inside of "..." (stop = '"') or a
   * here-document body (stop = null). Everything read is quoted.
   */
  readSpecial(parts: WordPart[], stop: string | null, escapes: string) {
    const s = this.src;
    const before = parts.length;
    const line = this.line;
    while (this.pos < s.length && s[this.pos] !== stop) {
      const c = s[this.pos];
      if (c === '\\' && this.pos + 1 < s.length && escapes.includes(s[this.pos + 1])) {
        if (s[this.pos + 1] === '\n') this.line++;
        else addLit(parts, s[this.pos + 1], true);
        this.pos += 2;
      } else if (c === '$') this.readDollar(parts, true);
      else if (c === '`') this.readBacktick(parts, true);
      else {
        if (c === '\n') this.line++;
        addLit(parts, c, true);
        this.pos++;
      }
    }
    if (stop === null) return;
    if (this.pos >= s.length) throw new ParseError('unexpected EOF while looking for matching `"\'', line, 'quote');
    this.pos++;
    if (parts.length === before) parts.push({ type: 'lit', text: '', quoted: true });
  }

  private readBacktick(parts: WordPart[], quoted: boolean) {
    const s = this.src;
    const line = this.line;
    let i = this.pos + 1;
    let inner = '';
    while (i < s.length && s[i] !== '`') {
      if (s[i] === '\\' && i + 1 < s.length && '`$\\'.includes(s[i + 1])) {
        inner += s[i + 1];
        i += 2;
      } else inner += s[i++];
    }
    if (i >= s.length) throw new ParseError('unexpected EOF while looking for matching ``\'', line, 'quote');
    parts.push({ type: 'cmd', body: parseSub(inner, line), quoted });
    this.moveTo(i + 1);
  }

  private readDollar(parts: WordPart[], quoted: boolean) {
    const s = this.src;
    const n = s[this.pos + 1];
    const line = this.line;
    if (n === '(') {
      if (s[this.pos + 2] === '(') {
        const end = scanArith(s, this.pos + 3);
        if (end === -2) throw new ParseError("unexpected EOF while looking for matching `)'", line, 'quote');
        if (end >= 0) {
          parts.push({ type: 'arith', src: s.slice(this.pos + 3, end), quoted });
          this.moveTo(end + 2);
          return;
        }
      }
      const end = scanParen(s, this.pos + 2);
      if (end < 0) throw new ParseError("unexpected EOF while looking for matching `)'", line, 'quote');
      parts.push({ type: 'cmd', body: parseSub(s.slice(this.pos + 2, end), line), quoted });
      this.moveTo(end + 1);
      return;
    }
    if (n === '{') {
      const end = scanBrace(s, this.pos + 2);
      if (end < 0) throw new ParseError("unexpected EOF while looking for matching `}'", line, 'quote');
      parts.push(paramPart(s.slice(this.pos + 2, end), quoted));
      this.moveTo(end + 1);
      return;
    }
    if (n === "'" && !quoted) {
      let i = this.pos + 2;
      let text = '';
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const [ch, len] = cEscape(s, i + 1);
          text += ch;
          i += 1 + len;
        } else text += s[i++];
      }
      if (i >= s.length) throw new ParseError("unexpected EOF while looking for matching `''", line, 'quote');
      addLit(parts, text, true, true);
      this.moveTo(i + 1);
      return;
    }
    if (n === '"' && !quoted) {
      this.pos += 2;
      this.readSpecial(parts, '"', '$`"\\\n');
      return;
    }
    NAME_AT.lastIndex = this.pos + 1;
    const m = NAME_AT.exec(s);
    if (m) {
      parts.push({ type: 'param', name: m[0], op: '', arg: '', quoted });
      this.pos += 1 + m[0].length;
      return;
    }
    addLit(parts, '$', quoted);
    this.pos++;
  }
}

function parseSub(src: string, line: number): CompleteCommand[] {
  const r = parseProgram(src, true, line);
  if (r.error) throw new ParseError(r.error.message, r.error.line);
  return r.commands;
}

/** Parse a string as one word (blanks are literal): used for ${x:-default} words and $(( )). */
export function parseWordText(src: string): WordPart[] {
  return new Lexer(src, true).readWord('text').parts;
}

/** Parse an unquoted here-document body: $, ` and \ are special, quotes are not. */
export function parseHereDoc(body: string): WordPart[] {
  const parts: WordPart[] = [];
  new Lexer(body, true).readSpecial(parts, null, '$`\\\n');
  return parts;
}

/** NAME=value or NAME+=value, as an assignment, or null. */
export function splitAssign(w: WordNode): Assign | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(w.raw);
  if (!m) return null;
  const first = w.parts[0];
  if (!first || first.type !== 'lit' || first.quoted || !first.text.startsWith(m[0])) return null;
  const value: WordPart[] = [];
  if (first.text.length > m[0].length) value.push({ type: 'lit', text: first.text.slice(m[0].length), quoted: false });
  value.push(...w.parts.slice(1));
  return { name: m[1], value, append: m[2] === '+' };
}

const STOP_WORDS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);

class Parser {
  private i = 0;
  private open: { word: string; line: number }[] = [];
  private warnings: { line: number; message: string }[] = [];

  constructor(
    private toks: Tok[],
    private script: boolean,
    private src: string,
  ) {}

  program(): ParseResult {
    const commands: CompleteCommand[] = [];
    try {
      for (;;) {
        while (this.isOp(this.peek(), '\n')) this.i++;
        const t = this.peek();
        if (t.t === 'eof') break;
        if (t.t === 'error') throw this.tokError(t);
        const list = this.topList();
        const end = this.peek();
        if (this.isOp(end, '\n')) this.i++;
        else if (end.t !== 'eof') throw this.unexpected(end);
        commands.push({ list, line: t.line, warnings: this.warnings });
        this.warnings = [];
      }
    } catch (e) {
      if (e instanceof ParseError) return { commands, error: e };
      throw e;
    }
    return { commands, error: null };
  }

  private peek(k = 0): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }
  private isOp(t: Tok, op: string): boolean {
    return t.t === 'op' && t.op === op;
  }
  private isWord(t: Tok, w: string): boolean {
    return t.t === 'word' && t.w.raw === w;
  }
  private linebreak() {
    while (this.isOp(this.peek(), '\n')) this.i++;
  }

  private tokError(t: Extract<Tok, { t: 'error' }>): ParseError {
    const e = t.err;
    if (e.incomplete && this.script) {
      if (e.incomplete === 'quote') return new ParseError(e.message, e.line);
      return this.eofError(e.line);
    }
    return e;
  }

  private eofError(line = this.peek().line): ParseError {
    if (!this.script) return new ParseError('syntax error: unexpected end of file', line, 'construct');
    const top = this.open[this.open.length - 1];
    const from = top ? ` from \`${top.word}' command on line ${top.line}` : '';
    return new ParseError(`syntax error: unexpected end of file${from}`, line);
  }

  private unexpected(t: Tok): ParseError {
    if (t.t === 'eof') return this.eofError();
    if (t.t === 'error') return this.tokError(t);
    const text = t.t === 'word' ? t.w.raw : t.t === 'arith' ? '((' : t.op === '\n' ? 'newline' : t.op;
    return new ParseError(`syntax error near unexpected token \`${text}'`, t.line);
  }

  private expectWord(w: string) {
    const t = this.peek();
    if (!this.isWord(t, w)) throw this.unexpected(t);
    this.i++;
  }

  private expectOp(op: string) {
    const t = this.peek();
    if (!this.isOp(t, op)) throw this.unexpected(t);
    this.i++;
  }

  private topList(): List {
    const items: AndOr[] = [];
    for (;;) {
      const ao = this.andOr();
      items.push(ao);
      const s = this.peek();
      if (this.isOp(s, ';') || this.isOp(s, '&')) {
        this.i++;
        ao.background = s.t === 'op' && s.op === '&';
        const n = this.peek();
        if (this.isOp(n, '\n') || n.t === 'eof') break;
        continue;
      }
      break;
    }
    return items;
  }

  private atStop(t: Tok, stop: string[]): boolean {
    if (t.t === 'word') return STOP_WORDS.has(t.w.raw) && stop.includes(t.w.raw);
    return t.t === 'op' && stop.includes(t.op);
  }

  /** A list inside a compound command, ended by one of the `stop` words or operators. */
  private compoundList(stop: string[], allowEmpty = false): List {
    const items: AndOr[] = [];
    this.linebreak();
    for (;;) {
      const t = this.peek();
      if (this.atStop(t, stop) || t.t === 'eof') break;
      const ao = this.andOr();
      items.push(ao);
      const s = this.peek();
      if (this.isOp(s, ';') || this.isOp(s, '&') || this.isOp(s, '\n')) {
        ao.background = this.isOp(s, '&');
        this.i++;
        this.linebreak();
        continue;
      }
      break;
    }
    if (!items.length && !allowEmpty) throw this.unexpected(this.peek());
    return items;
  }

  private andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr['rest'] = [];
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.op !== '&&' && t.op !== '||')) break;
      this.i++;
      this.linebreak();
      rest.push({ op: t.op, pipeline: this.pipeline() });
    }
    return { first, rest, background: false };
  }

  private pipeline(): Pipeline {
    let time = false;
    let bang = false;
    if (this.isWord(this.peek(), 'time')) {
      this.i++;
      time = true;
    }
    if (this.isWord(this.peek(), '!')) {
      this.i++;
      bang = true;
    }
    const cmds = [this.command()];
    const pipeStderr: boolean[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || (t.op !== '|' && t.op !== '|&')) break;
      this.i++;
      pipeStderr.push(t.op === '|&');
      this.linebreak();
      cmds.push(this.command());
    }
    return { cmds, bang, time, pipeStderr };
  }

  private command(): Command {
    const t = this.peek();
    if (t.t === 'eof') throw this.eofError();
    if (t.t === 'error') throw this.tokError(t);
    if (t.t === 'arith') {
      this.i++;
      return { type: 'arith', src: t.src, line: t.line, redirects: this.redirects() };
    }
    if (t.t === 'op') {
      if (t.op === '(') {
        this.i++;
        this.open.push({ word: '(', line: t.line });
        const body = this.compoundList([')']);
        this.expectOp(')');
        this.open.pop();
        return { type: 'subshell', body, line: t.line, redirects: this.redirects() };
      }
      if (REDIR_OPS.has(t.op)) return this.simple();
      throw this.unexpected(t);
    }
    switch (t.w.raw) {
      case 'if':
        return this.ifClause();
      case 'for':
        return this.forClause();
      case 'while':
      case 'until':
        return this.whileClause();
      case 'case':
        return this.caseClause();
      case '{': {
        this.i++;
        this.open.push({ word: '{', line: t.line });
        const body = this.compoundList(['}']);
        this.expectWord('}');
        this.open.pop();
        return { type: 'group', body, line: t.line, redirects: this.redirects() };
      }
      case '[[':
        return this.condCommand();
      case 'function':
        return this.funcDef(true);
      case 'then':
      case 'elif':
      case 'else':
      case 'fi':
      case 'do':
      case 'done':
      case 'esac':
      case '}':
        throw this.unexpected(t);
    }
    if (this.isOp(this.peek(1), '(') && this.isOp(this.peek(2), ')') && /^[^$'"`=\\]+$/.test(t.w.raw)) return this.funcDef(false);
    return this.simple();
  }

  private redirects(): Redirect[] {
    const out: Redirect[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op' || !REDIR_OPS.has(t.op)) return out;
      out.push(this.redirect());
    }
  }

  private redirect(): Redirect {
    const t = this.next();
    if (t.t !== 'op') throw this.unexpected(t);
    const target = this.peek();
    if (target.t !== 'word') throw this.unexpected(target);
    this.i++;
    const fd = t.fd;
    switch (t.op) {
      case '<':
      case '<>':
        return { fd: fd ?? 0, op: '<', target: target.w };
      case '>':
      case '>|':
        return { fd: fd ?? 1, op: '>', target: target.w };
      case '>>':
        return { fd: fd ?? 1, op: '>>', target: target.w };
      case '&>':
        return { fd: -1, op: '>', target: target.w };
      case '&>>':
        return { fd: -1, op: '>>', target: target.w };
      case '>&':
        // >&2 duplicates a descriptor; ">&file" is the old spelling of "&>file"
        if (fd === null && !/^(\d+|-)$/.test(target.w.raw)) return { fd: -1, op: '>', target: target.w };
        return { fd: fd ?? 1, op: '>&', target: target.w };
      case '<&':
        return { fd: fd ?? 0, op: '<&', target: target.w };
      case '<<<':
        return { fd: fd ?? 0, op: '<<<', target: target.w };
      default: {
        // << and <<-
        if (target.warning) this.warnings.push(target.warning);
        return { fd: fd ?? 0, op: '<<', target: target.w, heredoc: target.heredoc ?? { body: '', expand: false } };
      }
    }
  }

  private next(): Tok {
    return this.toks[this.i++] ?? this.toks[this.toks.length - 1];
  }

  private simple(): Command {
    const first = this.peek();
    const cmd: SimpleCommand = { type: 'simple', assigns: [], words: [], redirects: [], line: first.line };
    for (;;) {
      const t = this.peek();
      if (t.t === 'word') {
        const a = cmd.words.length ? null : splitAssign(t.w);
        if (a) cmd.assigns.push(a);
        else cmd.words.push(t.w);
        this.i++;
        const n = this.peek();
        if (a && !a.value.length && this.isOp(n, '(') && n.pos === t.end) throw new ParseError(`${a.name}=(...): arrays are not available in the practice terminal; use a list in a for loop instead`, t.line);
      } else if (t.t === 'op' && REDIR_OPS.has(t.op)) cmd.redirects.push(this.redirect());
      else break;
    }
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirects.length) throw this.unexpected(this.peek());
    return cmd;
  }

  private ifClause(): Command {
    const start = this.next();
    this.open.push({ word: 'if', line: start.line });
    const clauses: { cond: List; body: List }[] = [];
    let orElse: List | null = null;
    const cond = this.compoundList(['then']);
    this.expectWord('then');
    clauses.push({ cond, body: this.compoundList(['elif', 'else', 'fi']) });
    for (;;) {
      if (this.isWord(this.peek(), 'elif')) {
        this.i++;
        const c = this.compoundList(['then']);
        this.expectWord('then');
        clauses.push({ cond: c, body: this.compoundList(['elif', 'else', 'fi']) });
      } else if (this.isWord(this.peek(), 'else')) {
        this.i++;
        orElse = this.compoundList(['fi']);
        break;
      } else break;
    }
    this.expectWord('fi');
    this.open.pop();
    return { type: 'if', clauses, orElse, line: start.line, redirects: this.redirects() };
  }

  private doGroup(): List {
    this.expectWord('do');
    const body = this.compoundList(['done']);
    this.expectWord('done');
    return body;
  }

  private forClause(): Command {
    const start = this.next();
    this.open.push({ word: 'for', line: start.line });
    const t = this.peek();
    if (t.t === 'arith') {
      this.i++;
      const parts = splitTopLevel(t.src, ';');
      if (parts.length !== 3) throw new ParseError('syntax error: arithmetic expression required', t.line);
      if (this.isOp(this.peek(), ';')) this.i++;
      this.linebreak();
      const body = this.doGroup();
      this.open.pop();
      return { type: 'cfor', init: parts[0], test: parts[1], step: parts[2], body, line: start.line, redirects: this.redirects() };
    }
    if (t.t !== 'word') throw this.unexpected(t);
    if (!isName(t.w.raw)) throw new ParseError(`\`${t.w.raw}': not a valid identifier`, t.line);
    this.i++;
    let words: WordNode[] | null = null;
    let k = 0;
    while (this.isOp(this.peek(k), '\n')) k++;
    if (this.isWord(this.peek(k), 'in')) {
      this.i += k + 1;
      words = [];
      for (let w = this.peek(); w.t === 'word'; w = this.peek()) {
        words.push(w.w);
        this.i++;
      }
      const sep = this.peek();
      if (this.isOp(sep, ';') || this.isOp(sep, '\n')) this.i++;
      else throw this.unexpected(sep);
    } else if (this.isOp(this.peek(), ';')) this.i++;
    this.linebreak();
    const body = this.doGroup();
    this.open.pop();
    return { type: 'for', name: t.w.raw, words, body, line: start.line, redirects: this.redirects() };
  }

  private whileClause(): Command {
    const start = this.next();
    const until = start.t === 'word' && start.w.raw === 'until';
    this.open.push({ word: until ? 'until' : 'while', line: start.line });
    const cond = this.compoundList(['do']);
    const body = this.doGroup();
    this.open.pop();
    return { type: 'while', until, cond, body, line: start.line, redirects: this.redirects() };
  }

  private caseClause(): Command {
    const start = this.next();
    this.open.push({ word: 'case', line: start.line });
    const w = this.peek();
    if (w.t !== 'word') throw this.unexpected(w);
    this.i++;
    this.linebreak();
    this.expectWord('in');
    this.linebreak();
    const items: CaseItem[] = [];
    while (!this.isWord(this.peek(), 'esac')) {
      if (this.isOp(this.peek(), '(')) this.i++;
      const patterns: WordNode[] = [];
      for (;;) {
        const p = this.peek();
        if (p.t !== 'word') throw this.unexpected(p);
        patterns.push(p.w);
        this.i++;
        if (!this.isOp(this.peek(), '|')) break;
        this.i++;
      }
      this.expectOp(')');
      const body = this.compoundList(['esac', ';;', ';&', ';;&'], true);
      let term: CaseItem['term'] = ';;';
      const e = this.peek();
      if (e.t === 'op' && (e.op === ';;' || e.op === ';&' || e.op === ';;&')) {
        term = e.op;
        this.i++;
        this.linebreak();
      } else if (!this.isWord(e, 'esac')) throw this.unexpected(e);
      items.push({ patterns, body, term });
    }
    this.i++;
    this.open.pop();
    return { type: 'case', word: w.w, items, line: start.line, redirects: this.redirects() };
  }

  private condCommand(): Command {
    const start = this.next();
    this.open.push({ word: '[[', line: start.line });
    const items: CondItem[] = [];
    for (;;) {
      const t = this.peek();
      if (this.isWord(t, ']]')) {
        this.i++;
        break;
      }
      if (t.t === 'eof' || t.t === 'error') throw this.unexpected(t);
      if (this.isOp(t, '\n')) {
        this.i++;
        continue;
      }
      if (t.t === 'word') {
        this.i++;
        items.push({ word: t.w });
        if (t.w.raw === '=~') items.push({ word: this.regexWord() });
      } else if (t.t === 'op' && ['&&', '||', '(', ')', '<', '>'].includes(t.op)) {
        this.i++;
        items.push({ op: t.op });
      } else throw this.unexpected(t);
    }
    if (!items.length) throw this.unexpected(this.peek(-1));
    this.open.pop();
    return { type: 'cond', items, line: start.line, redirects: this.redirects() };
  }

  /** The right side of =~: glue touching tokens so ^(a|b)$ stays one regular expression. */
  private regexWord(): WordNode {
    const parts: WordPart[] = [];
    let raw = '';
    let end = -1;
    for (;;) {
      const t = this.peek();
      if (end >= 0 && t.pos !== end) break;
      if (t.t === 'word' && t.w.raw !== ']]') {
        parts.push(...t.w.parts);
        raw += t.w.raw;
      } else if (t.t === 'op' && ['(', ')', '|', '<', '>'].includes(t.op)) {
        parts.push({ type: 'lit', text: t.op, quoted: false });
        raw += t.op;
      } else break;
      end = t.end;
      this.i++;
    }
    if (!parts.length) throw this.unexpected(this.peek());
    return { parts, raw };
  }

  private funcDef(keyword: boolean): Command {
    const start = this.peek();
    if (keyword) this.i++;
    const n = this.peek();
    if (n.t !== 'word') throw this.unexpected(n);
    this.i++;
    if (this.isOp(this.peek(), '(')) {
      this.i++;
      this.expectOp(')');
    } else if (!keyword) throw this.unexpected(this.peek());
    this.linebreak();
    const b = this.peek();
    const compound = b.t === 'word' && ['{', 'if', 'for', 'while', 'until', 'case', '[['].includes(b.w.raw);
    if (!compound && !this.isOp(b, '(') && b.t !== 'arith') throw this.unexpected(b);
    this.open.push({ word: n.w.raw, line: n.line });
    const body = this.command();
    this.open.pop();
    const src = this.src.slice(b.pos, this.toks[this.i - 1].end);
    return { type: 'func', name: n.w.raw, body, src, line: start.line, redirects: [] };
  }
}

/** Split on `sep` outside parentheses (for ((init; test; step))). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parse a command line or a whole script. `script` is false for interactive input, where a missing
 * fi, quote or here-document end makes the error `incomplete` so the terminal can ask for more lines.
 */
export function parseProgram(src: string, script = false, firstLine = 1): ParseResult {
  const toks = new Lexer(src, script, firstLine).tokens();
  return new Parser(toks, script, src).program();
}

// ---------- arithmetic ----------

export class ArithError extends Error {}

export interface ArithVars {
  get(name: string): string;
  set(name: string, value: number): void;
}

type ATok = { k: 'num'; v: number; p: number } | { k: 'id'; v: string; p: number } | { k: 'op'; v: string; p: number };

const AOPS = ['<<=', '>>=', '**', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '^', '|', '?', ':', '(', ')', ','];
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);

/** Evaluate a bash arithmetic expression (integers only, like bash). */
export function evalArith(expr: string, vars: ArithVars, depth = 0): number {
  return new Arith(expr, vars, depth).run();
}

class Arith {
  private toks: ATok[] = [];
  private i = 0;
  private last = 0; // source position of the last token read, for "error token is"

  constructor(
    private src: string,
    private vars: ArithVars,
    private depth: number,
  ) {}

  run(): number {
    if (this.depth > 64) throw new ArithError(`${this.src.trim()}: expression recursion level exceeded (error token is "${this.src.trim()}")`);
    this.lex();
    if (!this.toks.length) return 0;
    const v = this.comma(false);
    if (this.i < this.toks.length) {
      this.last = this.toks[this.i].p;
      this.fail('syntax error in expression');
    }
    return v;
  }

  private fail(msg: string, token?: string): never {
    throw new ArithError(`${this.src.trimStart()}: ${msg} (error token is "${token ?? this.src.slice(this.last)}")`);
  }

  private lex() {
    const s = this.src;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) i++;
      else if (/[0-9]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9A-Za-z_#@]/.test(s[j])) j++;
        this.toks.push({ k: 'num', v: this.number(s.slice(i, j)), p: i });
        i = j;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        this.toks.push({ k: 'id', v: s.slice(i, j), p: i });
        i = j;
      } else {
        const op = AOPS.find((o) => s.startsWith(o, i));
        if (!op) {
          this.last = i;
          this.fail('syntax error: invalid arithmetic operator');
        }
        this.toks.push({ k: 'op', v: op, p: i });
        i += op.length;
      }
    }
  }

  private number(w: string): number {
    let m = /^0[xX]([0-9a-fA-F]+)$/.exec(w);
    if (m) return parseInt(m[1], 16);
    m = /^([0-9]+)#([0-9A-Za-z@_]+)$/.exec(w);
    if (m) {
      const base = Number(m[1]);
      if (base < 2 || base > 64) this.fail('invalid arithmetic base', w);
      let v = 0;
      for (const ch of m[2]) {
        const d = /[0-9]/.test(ch) ? Number(ch) : /[a-z]/.test(ch) ? ch.charCodeAt(0) - 87 : /[A-Z]/.test(ch) ? ch.charCodeAt(0) - (base <= 36 ? 55 : 29) : ch === '@' ? 62 : 63;
        if (d >= base) this.fail('value too great for base', w);
        v = v * base + d;
      }
      return v;
    }
    if (/^0[0-7]*$/.test(w)) return parseInt(w, 8) || 0;
    if (/^[1-9][0-9]*$/.test(w)) return parseInt(w, 10);
    this.fail('value too great for base', w);
  }

  private peek(k = 0): ATok | undefined {
    return this.toks[this.i + k];
  }
  private isOp(v: string, k = 0): boolean {
    const t = this.peek(k);
    return !!t && t.k === 'op' && t.v === v;
  }
  private take(): ATok {
    const t = this.toks[this.i++];
    this.last = t.p;
    return t;
  }

  private varValue(name: string): number {
    const raw = this.vars.get(name).trim();
    if (raw === '') return 0;
    if (/^-?[0-9]+$/.test(raw)) return parseInt(raw, 10);
    return evalArith(raw, this.vars, this.depth + 1);
  }

  private comma(skip: boolean): number {
    let v = this.assign(skip);
    while (this.isOp(',')) {
      this.take();
      v = this.assign(skip);
    }
    return v;
  }

  private assign(skip: boolean): number {
    const t = this.peek();
    const n = this.peek(1);
    if (t?.k === 'id' && n?.k === 'op' && ASSIGN_OPS.has(n.v)) {
      this.take();
      this.take();
      const rhs = this.assign(skip);
      if (skip) return rhs;
      const v = n.v === '=' ? rhs : this.binary(n.v.slice(0, -1), this.varValue(t.v), rhs, false);
      this.vars.set(t.v, v);
      return v;
    }
    if (t?.k !== 'id' && n?.k === 'op' && n.v === '=') {
      this.take();
      this.take();
      this.fail('attempted assignment to non-variable');
    }
    return this.ternary(skip);
  }

  private ternary(skip: boolean): number {
    const c = this.binaryLevel(0, skip);
    if (!this.isOp('?')) return c;
    this.take();
    const a = this.comma(skip || c === 0);
    if (!this.isOp(':')) this.fail("`:' expected for conditional expression");
    this.take();
    const b = this.ternary(skip || c !== 0);
    return c !== 0 ? a : b;
  }

  private static LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  private binaryLevel(level: number, skip: boolean): number {
    if (level >= Arith.LEVELS.length) return this.power(skip);
    const ops = Arith.LEVELS[level];
    let v = this.binaryLevel(level + 1, skip);
    for (;;) {
      const t = this.peek();
      if (!t || t.k !== 'op' || !ops.includes(t.v)) return v;
      this.take();
      if (t.v === '||' || t.v === '&&') {
        const shortCircuit = t.v === '||' ? v !== 0 : v === 0;
        const r = this.binaryLevel(level + 1, skip || shortCircuit);
        v = t.v === '||' ? Number(v !== 0 || r !== 0) : Number(v !== 0 && r !== 0);
      } else v = this.binary(t.v, v, this.binaryLevel(level + 1, skip), skip);
    }
  }

  private binary(op: string, a: number, b: number, skip: boolean): number {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
      case '%':
        if (b === 0) {
          if (skip) return 0;
          this.fail('division by 0');
        }
        return op === '/' ? Math.trunc(a / b) : a % b;
      case '<<':
        return a * 2 ** b;
      case '>>':
        return Math.floor(a / 2 ** b);
      case '<':
        return Number(a < b);
      case '>':
        return Number(a > b);
      case '<=':
        return Number(a <= b);
      case '>=':
        return Number(a >= b);
      case '==':
        return Number(a === b);
      case '!=':
        return Number(a !== b);
      case '&':
        return a & b;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      default:
        return 0;
    }
  }

  private power(skip: boolean): number {
    const base = this.unary(skip);
    if (!this.isOp('**')) return base;
    this.take();
    const exp = this.power(skip);
    if (exp < 0 && !skip) this.fail('exponent less than 0');
    return Math.trunc(base ** exp);
  }

  private unary(skip: boolean): number {
    const t = this.peek();
    if (t?.k === 'op') {
      if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') {
        this.take();
        const v = this.unary(skip);
        return t.v === '-' ? -v : t.v === '+' ? v : t.v === '!' ? Number(v === 0) : ~v;
      }
      if (t.v === '++' || t.v === '--') {
        this.take();
        const id = this.peek();
        if (id?.k !== 'id') this.fail('syntax error: operand expected');
        this.take();
        const v = this.varValue(id.v) + (t.v === '++' ? 1 : -1);
        if (!skip) this.vars.set(id.v, v);
        return v;
      }
    }
    return this.postfix(skip);
  }

  private postfix(skip: boolean): number {
    const t = this.peek();
    if (t?.k === 'id' && (this.isOp('++', 1) || this.isOp('--', 1))) {
      this.take();
      const op = this.take();
      const v = this.varValue(t.v);
      if (!skip) this.vars.set(t.v, v + (op.v === '++' ? 1 : -1));
      return v;
    }
    return this.primary(skip);
  }

  private primary(skip: boolean): number {
    const t = this.peek();
    if (!t) this.fail('syntax error: operand expected');
    if (t.k === 'num') {
      this.take();
      return t.v;
    }
    if (t.k === 'id') {
      this.take();
      return this.varValue(t.v);
    }
    if (t.v === '(') {
      this.take();
      const v = this.comma(skip);
      if (!this.isOp(')')) this.fail("missing `)'");
      this.take();
      return v;
    }
    this.last = t.p;
    this.fail('syntax error: operand expected');
  }
}

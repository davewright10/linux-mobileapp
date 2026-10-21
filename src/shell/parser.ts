// Turns a command line into a list of pipelines. Supports quotes, $VAR expansion,
// pipes, ; && ||, and the redirections > >> 2> 2>&1 &> <.

export interface Word {
  text: string;
  glob: boolean; // true if it holds an unquoted * or ?
}

export interface Redirect {
  fd: 1 | 2 | 0 | 'both';
  op: '>' | '>>' | '<' | '>&1';
  target: string;
}

export interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: SimpleCommand[];
  op: ';' | '&&' | '||'; // how this pipeline joins to the previous one
}

type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

export class ParseError extends Error {}

export function tokenize(line: string, getVar: (name: string) => string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let cur = '';
  let curGlob = false;
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: 'word', word: { text: cur, glob: curGlob } });
    cur = '';
    curGlob = false;
    inWord = false;
  };
  const readVar = (): string => {
    // at line[i] === '$'
    i++;
    if (line[i] === '?') {
      i++;
      return getVar('?');
    }
    if (line[i] === '{') {
      const end = line.indexOf('}', i);
      if (end < 0) throw new ParseError('bad substitution');
      const name = line.slice(i + 1, end);
      i = end + 1;
      return getVar(name);
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9#@]/.exec(line.slice(i));
    if (!m) return '$';
    i += m[0].length;
    return getVar(m[0]);
  };

  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      flush();
      i++;
      continue;
    }
    if (ch === '#' && !inWord) break;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new ParseError('unexpected EOF while looking for matching `\'\'');
      cur += line.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      inWord = true;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"$\\'.includes(line[i + 1])) {
          cur += line[i + 1];
          i += 2;
        } else if (line[i] === '$') {
          cur += readVar();
        } else {
          cur += line[i++];
        }
      }
      if (line[i] !== '"') throw new ParseError('unexpected EOF while looking for matching `"\'');
      i++;
      continue;
    }
    if (ch === '\\') {
      cur += line[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === '$') {
      cur += readVar();
      inWord = true;
      continue;
    }
    // operators
    const two = line.slice(i, i + 2);
    const four = line.slice(i, i + 4);
    if (four === '2>&1') {
      flush();
      tokens.push({ kind: 'op', op: '2>&1' });
      i += 4;
      continue;
    }
    if (two === '&&' || two === '||' || two === '>>' || two === '2>' || two === '&>') {
      // "2>" only counts as an operator at the start of a word
      if (two === '2>' && inWord) {
        cur += ch;
        i++;
        continue;
      }
      flush();
      if (two === '2>' && line[i + 2] === '>') {
        tokens.push({ kind: 'op', op: '2>>' });
        i += 3;
      } else {
        tokens.push({ kind: 'op', op: two });
        i += 2;
      }
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '>' || ch === '<') {
      flush();
      tokens.push({ kind: 'op', op: ch });
      i++;
      continue;
    }
    if (ch === '*' || ch === '?') curGlob = true;
    cur += ch;
    inWord = true;
    i++;
  }
  flush();
  return tokens;
}

export function parse(line: string, getVar: (name: string) => string): Pipeline[] {
  const tokens = tokenize(line, getVar);
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = { commands: [], op: ';' };
  let cmd: SimpleCommand = { words: [], redirects: [] };

  const endCommand = () => {
    if (cmd.words.length === 0 && cmd.redirects.length === 0) {
      throw new ParseError('syntax error near unexpected token');
    }
    pipeline.commands.push(cmd);
    cmd = { words: [], redirects: [] };
  };

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind === 'word') {
      cmd.words.push(tok.word);
      continue;
    }
    const op = tok.op;
    if (op === '>' || op === '>>' || op === '<' || op === '2>' || op === '2>>' || op === '&>') {
      const next = tokens[t + 1];
      if (!next || next.kind !== 'word') throw new ParseError("syntax error near unexpected token `newline'");
      t++;
      const fd = op === '<' ? 0 : op.startsWith('2') ? 2 : op === '&>' ? 'both' : 1;
      const rop = op === '<' ? '<' : op.endsWith('>>') ? '>>' : '>';
      cmd.redirects.push({ fd, op: rop, target: next.word.text });
    } else if (op === '2>&1') {
      cmd.redirects.push({ fd: 2, op: '>&1', target: '' });
    } else if (op === '|') {
      endCommand();
    } else {
      // ; && ||
      if (cmd.words.length || cmd.redirects.length) endCommand();
      if (pipeline.commands.length) pipelines.push(pipeline);
      else if (op !== ';') throw new ParseError(`syntax error near unexpected token \`${op}'`);
      pipeline = { commands: [], op: op as Pipeline['op'] };
    }
  }
  if (cmd.words.length || cmd.redirects.length) endCommand();
  if (pipeline.commands.length) pipelines.push(pipeline);
  return pipelines;
}

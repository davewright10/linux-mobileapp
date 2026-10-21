// Commands known to the practice terminal. Each one works on the simulated system in
// Shell.state and mirrors the RHEL 10 behaviour and output closely enough to practise with.

import {
  FsError,
  FsNode,
  canAccess,
  cloneNode,
  errorText,
  joinPath,
  makeDir,
  makeFile,
  makeLink,
  modeString,
  splitPath,
} from './fs';
import { ADMIN_COMMANDS } from './commands-admin';
import { KERNEL_COMMANDS, kernelDnf, kernelRpm, rebootSystem } from './commands-kernel';
import { SCRIPT_COMMANDS } from './commands-script';
import { STORAGE_COMMANDS } from './commands-storage';
import { MAN_PAGES } from './manpages';
import type { Shell } from './shell';
import { AVAILABLE_PACKAGES, Group, User, pkgKey, pkgName } from './state';

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  clear?: boolean;
}

export interface CommandContext {
  sh: Shell;
  args: string[];
  stdin: string;
  name: string;
}

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1, stdout = ''): CommandResult => ({
  stdout,
  stderr: stderr.endsWith('\n') ? stderr : stderr + '\n',
  code,
});

/** Split args into short/long flags and operands. `valued` flags consume the next arg. */
function getopts(args: string[], valued: string[] = []) {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const operands: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) values[k] = v;
      else if (valued.includes(k)) values[k] = args[++i] ?? '';
      else flags.add(k);
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (valued.includes(f)) {
          values[f] = a.slice(j + 1) || args[++i] || '';
          break;
        }
        flags.add(f);
      }
    } else operands.push(a);
  }
  return { flags, values, operands };
}

const errMsg = (cmd: string, path: string, e: unknown) =>
  e instanceof FsError ? `${cmd}: cannot access '${path}': ${errorText[e.reason]}` : `${cmd}: ${String(e)}`;

const needRoot = (sh: Shell, cmd: string): CommandResult | null =>
  sh.uid === 0 ? null : fail(`${cmd}: Permission denied.\n(Hint: try running it with sudo)`);

// ---------- formatting helpers ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lsDate(ms: number) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${hh}:${mm}`;
}

function userName(sh: Shell, uid: number) {
  return sh.state.users.find((u) => u.uid === uid)?.name ?? String(uid);
}
function groupName(sh: Shell, gid: number) {
  return sh.state.groups.find((g) => g.gid === gid)?.name ?? String(gid);
}

function countLinks(root: FsNode, target: FsNode): number {
  if (target.type === 'dir') return 2 + Object.values(target.children!).filter((c) => c.type === 'dir').length;
  let n = 0;
  const walk = (d: FsNode) => {
    for (const c of Object.values(d.children!)) {
      if (c === target) n++;
      if (c.type === 'dir') walk(c);
    }
  };
  walk(root);
  return Math.max(n, 1);
}

function nodeSize(n: FsNode) {
  if (n.type === 'dir') return 6 + Object.keys(n.children!).length * 20;
  if (n.type === 'link') return n.target!.length;
  return (n.content ?? '').length;
}

// ---------- navigation and files ----------

const pwd: Command = ({ sh }) => ok(sh.cwd + '\n');

const cd: Command = ({ sh, args }) => {
  const target = args[0] === '-' ? sh.env.OLDPWD ?? sh.cwd : args[0] ?? sh.user.home;
  try {
    const r = sh.resolve(target);
    if (r.node.type !== 'dir') return fail(`-bash: cd: ${target}: Not a directory`);
    if (!canAccess(r.node, 'x', sh.uid, sh.gids)) return fail(`-bash: cd: ${target}: Permission denied`);
    sh.env.OLDPWD = sh.cwd;
    sh.cwd = joinPath(r.parts);
    return ok(args[0] === '-' ? sh.cwd + '\n' : '');
  } catch (e) {
    return fail(`-bash: cd: ${target}: ${e instanceof FsError ? errorText[e.reason] : e}`);
  }
};

const ls: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const long = flags.has('l');
  const all = flags.has('a');
  const almost = flags.has('A');
  const dirOnly = flags.has('d');
  const human = flags.has('h');
  const inode = flags.has('i');
  const recursive = flags.has('R');
  const sortTime = flags.has('t');
  const reverse = flags.has('r');
  const targets = operands.length ? operands : ['.'];
  let out = '';
  let err = '';
  let code = 0;

  const fmtSize = (n: number) => {
    if (!human || n < 1024) return String(n);
    return (n / 1024).toFixed(1).replace(/\.0$/, '') + 'K';
  };
  const line = (name: string, node: FsNode) => {
    const prefix = inode ? `${node.inode} ` : '';
    if (!long) return prefix + name;
    const link = node.type === 'link' ? ` -> ${node.target}` : '';
    return `${prefix}${modeString(node)}. ${countLinks(sh.state.root, node)} ${userName(sh, node.uid)} ${groupName(sh, node.gid)} ${fmtSize(nodeSize(node)).padStart(5)} ${lsDate(node.mtime)} ${name}${link}`;
  };
  const listDir = (path: string, node: FsNode, header: boolean) => {
    if (!canAccess(node, 'r', sh.uid, sh.gids)) {
      err += `ls: cannot open directory '${path}': Permission denied\n`;
      code = 2;
      return;
    }
    let names = Object.keys(node.children!).filter((n) => all || almost || !n.startsWith('.'));
    names.sort((a, b) => a.replace(/^\./, '').localeCompare(b.replace(/^\./, '')));
    if (sortTime) names.sort((a, b) => node.children![b].mtime - node.children![a].mtime);
    if (reverse) names.reverse();
    const entries: [string, FsNode][] = names.map((n) => [n, node.children![n]]);
    if (all) entries.unshift(['.', node], ['..', node]);
    if (header) out += `${path}:\n`;
    if (long) {
      const total = entries.reduce((s, [, n]) => s + Math.ceil(nodeSize(n) / 1024) * 4, 0);
      out += `total ${total}\n`;
      out += entries.map(([n, c]) => line(n, c)).join('\n') + (entries.length ? '\n' : '');
    } else if (entries.length) {
      out += entries.map(([n, c]) => line(n, c)).join('  ') + '\n';
    }
    if (recursive) {
      for (const [n, c] of entries) {
        if (c.type === 'dir' && n !== '.' && n !== '..') {
          out += '\n';
          listDir(`${path === '/' ? '' : path}/${n}`.replace(/^\.\//, './'), c, true);
        }
      }
    }
  };

  const files: string[] = [];
  const dirs: [string, FsNode][] = [];
  for (const t of targets) {
    try {
      const r = sh.resolve(t, !long || t.endsWith('/'));
      if (r.node.type === 'dir' && !dirOnly) dirs.push([t, r.node]);
      else files.push(line(t, r.node));
    } catch (e) {
      err += errMsg('ls', t, e) + '\n';
      code = 2;
    }
  }
  if (files.length) out += files.join(long ? '\n' : '  ') + '\n';
  dirs.forEach(([p, n], i) => {
    if (i > 0 || files.length) out += '\n';
    listDir(p, n, targets.length > 1 || recursive);
  });
  return { stdout: out, stderr: err, code };
};

const mkdir: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['m']);
  if (!operands.length) return fail('mkdir: missing operand');
  let err = '';
  for (const p of operands) {
    try {
      if (flags.has('p')) {
        const parts = splitPath(sh.cwd, p, sh.user.home);
        for (let i = 1; i <= parts.length; i++) {
          const sub = joinPath(parts.slice(0, i));
          if (!sh.exists(sub)) {
            const { dir, name } = sh.parentFor(sub);
            dir.children![name] = makeDir(sh.uid, sh.user.gid, 0o777 & ~sh.umask);
          }
        }
      } else {
        if (sh.exists(p, false)) {
          err += `mkdir: cannot create directory '${p}': File exists\n`;
          continue;
        }
        const { dir, name } = sh.parentFor(p);
        dir.children![name] = makeDir(sh.uid, sh.user.gid, values.m ? parseInt(values.m, 8) : 0o777 & ~sh.umask);
      }
    } catch (e) {
      err += `mkdir: cannot create directory '${p}': ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  return err ? fail(err) : ok();
};

const rmdir: Command = ({ sh, args }) => {
  let err = '';
  for (const p of args) {
    try {
      const r = sh.resolve(p, false);
      if (r.node.type !== 'dir') throw new FsError('ENOTDIR');
      if (Object.keys(r.node.children!).length) throw new FsError('ENOTEMPTY');
      const { dir, name } = sh.parentFor(p);
      delete dir.children![name];
    } catch (e) {
      err += `rmdir: failed to remove '${p}': ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  return err ? fail(err) : ok();
};

const touch: Command = ({ sh, args }) => {
  const { operands } = getopts(args);
  if (!operands.length) return fail('touch: missing file operand');
  let err = '';
  for (const p of operands) {
    try {
      if (sh.exists(p)) sh.resolve(p).node.mtime = Date.now();
      else sh.writeFile(p, '');
    } catch (e) {
      err += `touch: cannot touch '${p}': ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  return err ? fail(err) : ok();
};

const cat: Command = ({ sh, args, stdin }) => {
  const { flags, operands } = getopts(args);
  if (!operands.length) return ok(stdin);
  let out = '';
  let err = '';
  for (const p of operands) {
    try {
      out += sh.readFile(p);
    } catch (e) {
      err += `cat: ${p}: ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  if (flags.has('n')) {
    out = out
      .replace(/\n$/, '')
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join('\n') + '\n';
  }
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

const echo: Command = ({ args }) => {
  let newline = true;
  let escapes = false;
  let rest = args;
  while (rest[0] === '-n' || rest[0] === '-e') {
    if (rest[0] === '-n') newline = false;
    else escapes = true;
    rest = rest.slice(1);
  }
  let s = rest.join(' ');
  if (escapes) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return ok(s + (newline ? '\n' : ''));
};

function copyInto(sh: Shell, src: string, dest: string, recursive: boolean, move: boolean): string | null {
  let s;
  try {
    s = sh.resolve(src, !move);
  } catch (e) {
    return `cannot stat '${src}': ${e instanceof FsError ? errorText[e.reason] : e}`;
  }
  if (s.node.type === 'dir' && !recursive && !move) return `-r not specified; omitting directory '${src}'`;
  if (!move && !canAccess(s.node, 'r', sh.uid, sh.gids)) return `cannot open '${src}' for reading: Permission denied`;
  let destPath = dest;
  if (sh.exists(dest) && sh.resolve(dest).node.type === 'dir') destPath = `${dest}/${s.name}`;
  try {
    const { dir, name } = sh.parentFor(destPath);
    if (move) {
      const from = sh.parentFor(src);
      delete from.dir.children![from.name];
      dir.children![name] = s.node;
    } else {
      const existing = dir.children![name];
      if (existing && existing.type === 'file' && s.node.type === 'file') {
        existing.content = s.node.content;
        existing.mtime = Date.now();
      } else {
        const copy = cloneNode(s.node);
        const setOwner = (n: FsNode) => {
          n.uid = sh.uid;
          n.gid = sh.user.gid;
          n.children && Object.values(n.children).forEach(setOwner);
        };
        setOwner(copy);
        dir.children![name] = copy;
      }
    }
  } catch (e) {
    return `cannot create '${destPath}': ${e instanceof FsError ? errorText[e.reason] : e}`;
  }
  return null;
}

const cp: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  if (operands.length < 2) return fail(`cp: missing destination file operand after '${operands[0] ?? ''}'`);
  const dest = operands.pop()!;
  const recursive = flags.has('r') || flags.has('R') || flags.has('a');
  if (operands.length > 1 && !(sh.exists(dest) && sh.resolve(dest).node.type === 'dir'))
    return fail(`cp: target '${dest}': Not a directory`);
  let err = '';
  for (const s of operands) {
    const e = copyInto(sh, s, dest, recursive, false);
    if (e) err += `cp: ${e}\n`;
  }
  return err ? fail(err) : ok();
};

const mv: Command = ({ sh, args }) => {
  const { operands } = getopts(args);
  if (operands.length < 2) return fail(`mv: missing destination file operand after '${operands[0] ?? ''}'`);
  const dest = operands.pop()!;
  let err = '';
  for (const s of operands) {
    const e = copyInto(sh, s, dest, true, true);
    if (e) err += `mv: ${e}\n`;
  }
  return err ? fail(err) : ok();
};

const rm: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const recursive = flags.has('r') || flags.has('R');
  const force = flags.has('f');
  if (!operands.length) return force ? ok() : fail('rm: missing operand');
  let err = '';
  for (const p of operands) {
    try {
      const r = sh.resolve(p, false);
      if (r.node.type === 'dir' && !recursive) {
        err += `rm: cannot remove '${p}': Is a directory\n`;
        continue;
      }
      if (joinPath(r.parts) === '/') {
        err += "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n";
        continue;
      }
      const { dir, name } = sh.parentFor(p);
      if ((dir.mode & 0o1000) && sh.uid !== 0 && r.node.uid !== sh.uid && dir.uid !== sh.uid) {
        throw new FsError('EACCES'); // sticky bit
      }
      delete dir.children![name];
    } catch (e) {
      if (force && e instanceof FsError && e.reason === 'ENOENT') continue;
      err += `rm: cannot remove '${p}': ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  return err ? fail(err) : ok();
};

const ln: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  if (operands.length < 1) return fail('ln: missing file operand');
  const target = operands[0];
  let linkPath = operands[1] ?? target.split('/').pop()!;
  if (sh.exists(linkPath) && sh.resolve(linkPath).node.type === 'dir') linkPath += '/' + target.split('/').pop();
  try {
    if (sh.exists(linkPath, false)) return fail(`ln: failed to create link '${linkPath}': File exists`);
    const { dir, name } = sh.parentFor(linkPath);
    if (flags.has('s')) {
      dir.children![name] = makeLink(target, sh.uid, sh.user.gid);
    } else {
      const t = sh.resolve(target);
      if (t.node.type === 'dir') return fail(`ln: ${target}: hard link not allowed for directory`);
      dir.children![name] = t.node; // same node = same inode
    }
    return ok();
  } catch (e) {
    return fail(errMsg('ln', target, e));
  }
};

const readlink: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  try {
    if (flags.has('f')) return ok(joinPath(sh.resolve(operands[0]).parts) + '\n');
    const r = sh.resolve(operands[0], false);
    return r.node.type === 'link' ? ok(r.node.target + '\n') : { stdout: '', stderr: '', code: 1 };
  } catch {
    return { stdout: '', stderr: '', code: 1 };
  }
};

const stat: Command = ({ sh, args }) => {
  let out = '';
  for (const p of args) {
    try {
      const r = sh.resolve(p, false);
      const n = r.node;
      const kind = n.type === 'dir' ? 'directory' : n.type === 'link' ? 'symbolic link' : n.content ? 'regular file' : 'regular empty file';
      out += `  File: ${p}${n.type === 'link' ? ' -> ' + n.target : ''}\n  Size: ${nodeSize(n)}\t\t${kind}\nInode: ${n.inode}\tLinks: ${countLinks(sh.state.root, n)}\nAccess: (${(n.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(n)})  Uid: (${n.uid}/${userName(sh, n.uid)})   Gid: (${n.gid}/${groupName(sh, n.gid)})\nModify: ${new Date(n.mtime).toISOString()}\n`;
    } catch (e) {
      return fail(errMsg('stat', p, e));
    }
  }
  return ok(out);
};

const file: Command = ({ sh, args }) => {
  let out = '';
  for (const p of args) {
    try {
      const r = sh.resolve(p, false);
      const t = r.node.type === 'dir' ? 'directory' : r.node.type === 'link' ? `symbolic link to ${r.node.target}` : r.node.content ? (r.node.content.startsWith('#!') ? 'Bourne-Again shell script, ASCII text executable' : 'ASCII text') : 'empty';
      out += `${p}: ${t}\n`;
    } catch {
      out += `${p}: cannot open \`${p}' (No such file or directory)\n`;
    }
  }
  return ok(out);
};

const find: Command = ({ sh, args }) => {
  let start = '.';
  let i = 0;
  if (args[0] && !args[0].startsWith('-')) {
    start = args[0];
    i = 1;
  }
  let nameRe: RegExp | null = null;
  let type: string | null = null;
  let user: string | null = null;
  let perm: string | null = null;
  for (; i < args.length; i++) {
    const a = args[i];
    const v = args[++i] ?? '';
    if (a === '-name' || a === '-iname') {
      const src = '^' + v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
      nameRe = new RegExp(src, a === '-iname' ? 'i' : '');
    } else if (a === '-type') type = v;
    else if (a === '-user') user = v;
    else if (a === '-perm') perm = v;
    else return fail(`find: unknown predicate '${a}'`);
  }
  let out = '';
  let err = '';
  const visit = (path: string, node: FsNode, name: string) => {
    const t = node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : 'f';
    let match = true;
    if (nameRe && !nameRe.test(name)) match = false;
    if (type && type !== t) match = false;
    if (user && userName(sh, node.uid) !== user) match = false;
    if (perm) {
      const want = parseInt(perm.replace(/^[-/]/, ''), 8);
      if (perm.startsWith('-') || perm.startsWith('/')) {
        if (perm.startsWith('-') ? (node.mode & want) !== want : (node.mode & want) === 0) match = false;
      } else if ((node.mode & 0o7777) !== want) match = false;
    }
    if (match) out += path + '\n';
    if (node.type === 'dir') {
      if (!canAccess(node, 'r', sh.uid, sh.gids) || !canAccess(node, 'x', sh.uid, sh.gids)) {
        err += `find: '${path}': Permission denied\n`;
        return;
      }
      for (const [n, c] of Object.entries(node.children!).sort()) visit(`${path === '/' ? '' : path}/${n}`, c, n);
    }
  };
  try {
    const r = sh.resolve(start);
    visit(start, r.node, r.name);
  } catch (e) {
    return fail(`find: '${start}': ${e instanceof FsError ? errorText[e.reason] : e}`);
  }
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

// ---------- text tools ----------

function inputText(sh: Shell, operands: string[], stdin: string, cmd: string): { text: string; err: string } {
  if (!operands.length) return { text: stdin, err: '' };
  let text = '';
  let err = '';
  for (const p of operands) {
    try {
      text += sh.readFile(p);
    } catch (e) {
      err += `${cmd}: ${p}: ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  return { text, err };
}

const lines = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
const joinLines = (l: string[]) => (l.length ? l.join('\n') + '\n' : '');

const headTail = (isHead: boolean): Command => ({ sh, args, stdin }) => {
  let n = 10;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n') n = parseInt(args[++i], 10);
    else if (/^-n\d+$/.test(args[i])) n = parseInt(args[i].slice(2), 10);
    else if (/^-\d+$/.test(args[i])) n = parseInt(args[i].slice(1), 10);
    else if (args[i] !== '-f') rest.push(args[i]);
  }
  const { text, err } = inputText(sh, rest, stdin, isHead ? 'head' : 'tail');
  const l = lines(text);
  return { stdout: joinLines(isHead ? l.slice(0, n) : l.slice(Math.max(0, l.length - n))), stderr: err, code: err ? 1 : 0 };
};

const wc: Command = ({ sh, args, stdin }) => {
  const { flags, operands } = getopts(args);
  const { text, err } = inputText(sh, operands, stdin, 'wc');
  const l = (text.match(/\n/g) ?? []).length;
  const w = text.split(/\s+/).filter(Boolean).length;
  const c = text.length;
  const parts: number[] = [];
  const any = flags.has('l') || flags.has('w') || flags.has('c');
  if (!any || flags.has('l')) parts.push(l);
  if (!any || flags.has('w')) parts.push(w);
  if (!any || flags.has('c')) parts.push(c);
  const name = operands.length === 1 ? ' ' + operands[0] : '';
  return { stdout: parts.join(' ') + name + '\n', stderr: err, code: err ? 1 : 0 };
};

function toJsRegex(pattern: string, extended: boolean): string {
  if (extended) return pattern;
  // basic regex: \| \+ \? \( \) are special, bare ones are literal
  return pattern
    .replace(/\\([|+?(){}])/g, '\u0000$1')
    .replace(/([|+?(){}])/g, '\\$1')
    .replace(/\u0000([|+?(){}])/g, '$1');
}

const grep: Command = ({ sh, args, stdin, name }) => {
  const { flags, values, operands } = getopts(args, ['e']);
  const pattern = values.e ?? operands.shift();
  if (pattern === undefined) return fail('Usage: grep [OPTION]... PATTERNS [FILE]...', 2);
  const extended = flags.has('E') || name === 'egrep';
  let re: RegExp;
  try {
    re = new RegExp(flags.has('w') ? `\\b(?:${toJsRegex(pattern, extended)})\\b` : toJsRegex(pattern, extended), flags.has('i') ? 'i' : '');
  } catch {
    return fail('grep: Invalid regular expression', 2);
  }
  const invert = flags.has('v');
  let out = '';
  let err = '';
  let matched = 0;
  const search = (text: string, label: string | null) => {
    let count = 0;
    lines(text).forEach((l, i) => {
      if (re.test(l) !== invert) {
        count++;
        if (!flags.has('c') && !flags.has('l')) out += `${label ? label + ':' : ''}${flags.has('n') ? i + 1 + ':' : ''}${l}\n`;
      }
    });
    if (flags.has('c')) out += `${label ? label + ':' : ''}${count}\n`;
    if (flags.has('l') && count) out += label + '\n';
    matched += count;
  };
  const recursive = flags.has('r') || flags.has('R');
  if (!operands.length) {
    if (recursive) operands.push('.');
    else search(stdin, null);
  }
  const files: string[] = [];
  const collect = (p: string) => {
    const r = sh.resolve(p);
    if (r.node.type === 'dir') {
      if (!recursive) {
        err += `grep: ${p}: Is a directory\n`;
        return;
      }
      for (const n of Object.keys(r.node.children!).sort()) {
        try {
          collect(`${p.replace(/\/$/, '')}/${n}`);
        } catch {
          /* skip unreadable */
        }
      }
    } else files.push(p);
  };
  for (const p of operands) {
    try {
      collect(p);
    } catch (e) {
      err += `grep: ${p}: ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  const showName = files.length > 1 || recursive;
  for (const f of files) {
    try {
      search(sh.readFile(f), showName || flags.has('l') ? f : null);
    } catch (e) {
      err += `grep: ${f}: ${e instanceof FsError ? errorText[e.reason] : e}\n`;
    }
  }
  return { stdout: out, stderr: err, code: err && !matched ? 2 : matched ? 0 : 1 };
};

const sort: Command = ({ sh, args, stdin }) => {
  const { flags, values, operands } = getopts(args, ['k', 't']);
  const { text, err } = inputText(sh, operands, stdin, 'sort');
  let l = lines(text);
  const key = values.k ? parseInt(values.k, 10) - 1 : -1;
  const sep = values.t;
  const field = (s: string) => (key < 0 ? s : (sep ? s.split(sep) : s.trim().split(/\s+/))[key] ?? '');
  if (flags.has('n')) l.sort((a, b) => parseFloat(field(a)) - parseFloat(field(b)));
  else l.sort((a, b) => (field(a) < field(b) ? -1 : field(a) > field(b) ? 1 : 0));
  if (flags.has('r')) l.reverse();
  if (flags.has('u')) l = l.filter((x, i) => l.indexOf(x) === i);
  return { stdout: joinLines(l), stderr: err, code: err ? 2 : 0 };
};

const uniq: Command = ({ sh, args, stdin }) => {
  const { flags, operands } = getopts(args);
  const { text } = inputText(sh, operands, stdin, 'uniq');
  const out: [string, number][] = [];
  for (const l of lines(text)) {
    const last = out[out.length - 1];
    if (last && last[0] === l) last[1]++;
    else out.push([l, 1]);
  }
  return ok(joinLines(out.map(([l, n]) => (flags.has('c') ? `${String(n).padStart(7)} ${l}` : l))));
};

const cut: Command = ({ sh, args, stdin }) => {
  const { values, operands } = getopts(args, ['d', 'f', 'c']);
  const { text, err } = inputText(sh, operands, stdin, 'cut');
  const ranges = (spec: string) =>
    spec.split(',').flatMap((p) => {
      const [a, b] = p.split('-');
      const start = parseInt(a || '1', 10);
      const end = p.includes('-') ? (b ? parseInt(b, 10) : 999) : start;
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    });
  if (values.c) {
    const r = ranges(values.c);
    return ok(joinLines(lines(text).map((l) => r.map((i) => l[i - 1] ?? '').join(''))));
  }
  if (!values.f) return fail('cut: you must specify a list of bytes, characters, or fields');
  const d = values.d ?? '\t';
  const r = ranges(values.f);
  const out = lines(text).map((l) => {
    const parts = l.split(d);
    if (parts.length === 1) return l;
    return r.filter((i) => i <= parts.length).map((i) => parts[i - 1]).join(d);
  });
  return { stdout: joinLines(out), stderr: err, code: err ? 1 : 0 };
};

const tr: Command = ({ args, stdin }) => {
  const { flags, operands } = getopts(args);
  const expand = (s: string) =>
    s
      .replace('[:lower:]', 'a-z')
      .replace('[:upper:]', 'A-Z')
      .replace(/(.)-(.)/g, (_, a: string, b: string) => {
        let r = '';
        for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) r += String.fromCharCode(c);
        return r;
      });
  const from = expand(operands[0] ?? '');
  if (flags.has('d')) return ok([...stdin].filter((c) => !from.includes(c)).join(''));
  const to = expand(operands[1] ?? '');
  return ok([...stdin].map((c) => (from.includes(c) ? to[Math.min(from.indexOf(c), to.length - 1)] ?? c : c)).join(''));
};

const awk: Command = ({ sh, args, stdin }) => {
  // Supports the common teaching forms: awk -F: '{ print $1, $3 }' and '/re/ { print $1 }'
  const { values, operands } = getopts(args, ['F']);
  const prog = operands.shift() ?? '';
  const { text } = inputText(sh, operands, stdin, 'awk');
  const m = /^\s*(?:\/(.*)\/)?\s*(?:\{\s*print\s*(.*?)\s*\})?\s*$/.exec(prog);
  if (!m) return fail("awk: this practice terminal supports patterns like '/text/ { print $1, $3 }'", 2);
  const re = m[1] ? new RegExp(m[1]) : null;
  const fieldsExpr = m[2] ?? '$0';
  const out: string[] = [];
  for (const l of lines(text)) {
    if (re && !re.test(l)) continue;
    const f = values.F ? l.split(values.F) : l.trim().split(/\s+/);
    const parts = fieldsExpr.split(',').map((e) => {
      const t = e.trim();
      if (t === '$0' || t === '') return l;
      if (t === 'NF') return String(f.length);
      if (t === '$NF') return f[f.length - 1] ?? '';
      const fm = /^\$(\d+)$/.exec(t);
      if (fm) return f[parseInt(fm[1], 10) - 1] ?? '';
      return t.replace(/^"|"$/g, '');
    });
    out.push(parts.join(' '));
  }
  return ok(joinLines(out));
};

const sed: Command = ({ sh, args, stdin }) => {
  const { flags, operands } = getopts(args);
  const script = operands.shift() ?? '';
  const m = /^s(.)(.*?)\1(.*?)\1(g?)$/.exec(script);
  const del = /^(?:\/(.*)\/|(\d+))d$/.exec(script);
  if (!m && !del) return fail("sed: this practice terminal supports 's/old/new/g' and '/pattern/d'");
  const transform = (text: string) =>
    joinLines(
      lines(text).flatMap((l, i) => {
        if (del) {
          const hit = del[1] !== undefined ? new RegExp(del[1]).test(l) : i + 1 === parseInt(del[2], 10);
          return hit ? [] : [l];
        }
        return [l.replace(new RegExp(m![2], m![4] ? 'g' : ''), m![3])];
      }),
    );
  if (flags.has('i')) {
    for (const p of operands) sh.writeFile(p, transform(sh.readFile(p)));
    return ok();
  }
  const { text } = inputText(sh, operands, stdin, 'sed');
  return ok(transform(text));
};

const tee: Command = ({ sh, args, stdin }) => {
  const { flags, operands } = getopts(args);
  for (const p of operands) sh.writeFile(p, stdin, flags.has('a'));
  return ok(stdin);
};

const pager: Command = ({ sh, args, stdin, name }) => {
  const { operands } = getopts(args);
  const { text, err } = inputText(sh, operands, stdin, name);
  return { stdout: text, stderr: err, code: err ? 1 : 0 };
};

const editor: Command = ({ name }) =>
  fail(
    `${name}: full-screen editors are not available on the phone terminal.\nUse echo "text" > file to create files, echo "more" >> file to append,\nand sed -i 's/old/new/' file to change them. The flashcards cover ${name} keys.`,
  );

// ---------- archives ----------

const tar: Command = ({ sh, args }) => {
  // accept "tar czf x.tgz dir" (no dash) as well as "tar -czf"
  const a = [...args];
  if (a[0] && !a[0].startsWith('-')) a[0] = '-' + a[0];
  const { flags, values, operands } = getopts(a, ['f', 'C']);
  const archive = values.f;
  if (!archive) return fail('tar: Refusing to read archive contents from terminal (missing -f option?)', 2);
  const compressed = flags.has('z') ? 'gzip' : flags.has('j') ? 'bzip2' : flags.has('J') ? 'xz' : null;
  if (flags.has('c')) {
    if (!operands.length) return fail('tar: Cowardly refusing to create an empty archive', 2);
    const entries: Record<string, FsNode> = {};
    const names: string[] = [];
    for (const p of operands) {
      const r = sh.resolve(p);
      entries[p.replace(/^\//, '')] = cloneNode(r.node);
      const walk = (path: string, n: FsNode) => {
        names.push(path + (n.type === 'dir' ? '/' : ''));
        if (n.children) for (const [k, c] of Object.entries(n.children)) walk(`${path}/${k}`, c);
      };
      walk(p.replace(/^\//, ''), r.node);
    }
    sh.writeFile(archive, `TAR:${compressed ?? 'none'}:${JSON.stringify(names)}`);
    // keep the real tree alongside so extraction works
    const node = sh.resolve(archive).node;
    (node as FsNode & { archive?: Record<string, FsNode> }).archive = entries;
    const verbose = flags.has('v') ? names.join('\n') + '\n' : '';
    const warn = operands.some((p) => p.startsWith('/')) ? "tar: Removing leading `/' from member names\n" : '';
    return { stdout: verbose, stderr: warn, code: 0 };
  }
  let node: FsNode & { archive?: Record<string, FsNode> };
  try {
    node = sh.resolve(archive).node;
  } catch {
    return fail(`tar: ${archive}: Cannot open: No such file or directory`, 2);
  }
  if (!node.archive) return fail('tar: This does not look like a tar archive', 2);
  if (flags.has('t')) return ok(JSON.parse((node.content ?? '').split(':').slice(2).join(':')).join('\n') + '\n');
  if (flags.has('x')) {
    const destDir = values.C ?? '.';
    for (const [path, n] of Object.entries(node.archive)) {
      const parts = path.split('/');
      let cur = destDir;
      for (const p of parts.slice(0, -1)) {
        cur = `${cur}/${p}`;
        if (!sh.exists(cur)) sh.exec(['mkdir', cur]);
      }
      const { dir, name } = sh.parentFor(`${destDir}/${path}`);
      dir.children![name] = cloneNode(n);
    }
    return ok();
  }
  return fail('tar: You must specify one of the -Acdtrux options', 2);
};

const compressCmd = (ext: string, decompress: boolean): Command => ({ sh, args }) => {
  const { operands } = getopts(args);
  for (const p of operands) {
    const target = decompress ? p.replace(new RegExp(`\\${ext}$`), '') : p + ext;
    if (decompress && target === p) return fail(`${p}: unknown suffix -- ignored`);
    const e = copyInto(sh, p, target, false, true);
    if (e) return fail(e);
  }
  return ok();
};

// ---------- users, groups, permissions ----------

const whoami: Command = ({ sh }) => ok(sh.user.name + '\n');

function findUser(sh: Shell, name: string): User | undefined {
  return sh.state.users.find((u) => u.name === name || String(u.uid) === name);
}
function findGroup(sh: Shell, name: string): Group | undefined {
  return sh.state.groups.find((g) => g.name === name || String(g.gid) === name);
}

const id: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const u = operands[0] ? findUser(sh, operands[0]) : sh.user;
  if (!u) return fail(`id: '${operands[0]}': no such user`);
  const primary = findGroup(sh, String(u.gid));
  const groups = [primary!, ...sh.state.groups.filter((g) => g.members.includes(u.name) && g.gid !== u.gid)];
  if (flags.has('u')) return ok(`${flags.has('n') ? u.name : u.uid}\n`);
  if (flags.has('g')) return ok(`${flags.has('n') ? primary?.name : u.gid}\n`);
  if (flags.has('G')) return ok(groups.map((g) => (flags.has('n') ? g.name : g.gid)).join(' ') + '\n');
  const ctx = operands[0] ? '' : ' context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023';
  return ok(`uid=${u.uid}(${u.name}) gid=${u.gid}(${primary?.name}) groups=${groups.map((g) => `${g.gid}(${g.name})`).join(',')}${ctx}\n`);
};

const groupsCmd: Command = ({ sh, args }) => {
  const u = args[0] ? findUser(sh, args[0]) : sh.user;
  if (!u) return fail(`groups: '${args[0]}': no such user`);
  const names = [findGroup(sh, String(u.gid))?.name, ...sh.state.groups.filter((g) => g.members.includes(u.name)).map((g) => g.name)];
  return ok(`${args[0] ? u.name + ' : ' : ''}${[...new Set(names)].join(' ')}\n`);
};

const useradd: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'useradd');
  if (denied) return denied;
  const { flags, values, operands } = getopts(args, ['u', 'g', 'G', 's', 'c', 'd', 'e']);
  const name = operands[0];
  if (!name) return fail('Usage: useradd [options] LOGIN', 2);
  if (findUser(sh, name)) return fail(`useradd: user '${name}' already exists`, 9);
  const uid = values.u ? parseInt(values.u, 10) : Math.max(999, ...sh.state.users.filter((u) => u.uid < 60000).map((u) => u.uid)) + 1;
  if (sh.state.users.some((u) => u.uid === uid)) return fail(`useradd: UID ${uid} is not unique`, 4);
  let gid: number;
  if (values.g) {
    const g = findGroup(sh, values.g);
    if (!g) return fail(`useradd: group '${values.g}' does not exist`, 6);
    gid = g.gid;
  } else {
    gid = sh.state.groups.some((g) => g.gid === uid) ? Math.max(...sh.state.groups.map((g) => g.gid)) + 1 : uid;
    sh.state.groups.push({ name, gid, members: [] });
  }
  if (values.G) {
    for (const gname of values.G.split(',')) {
      const g = findGroup(sh, gname);
      if (!g) return fail(`useradd: group '${gname}' does not exist`, 6);
      g.members.push(name);
    }
  }
  const home = values.d ?? `/home/${name}`;
  sh.state.users.push({
    name, uid, gid, home, shell: values.s ?? '/bin/bash', comment: values.c ?? '', password: null,
    locked: false, maxDays: 99999, minDays: 0, warnDays: 7,
  });
  if (!flags.has('M')) {
    const parent = sh.resolve(home.split('/').slice(0, -1).join('/') || '/').node;
    parent.children![home.split('/').pop()!] = { ...makeDir(uid, gid, 0o700), children: { '.bashrc': { ...cloneNode(sh.resolve('/etc/skel/.bashrc').node), uid, gid } } };
  }
  return ok();
};

const usermod: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'usermod');
  if (denied) return denied;
  const { flags, values, operands } = getopts(args, ['u', 'g', 'G', 's', 'c', 'd', 'l']);
  const u = findUser(sh, operands[0] ?? '');
  if (!u) return fail(`usermod: user '${operands[0]}' does not exist`, 6);
  if (values.G !== undefined) {
    const wanted = values.G.split(',').filter(Boolean);
    for (const gname of wanted) if (!findGroup(sh, gname)) return fail(`usermod: group '${gname}' does not exist`, 6);
    if (!flags.has('a')) for (const g of sh.state.groups) g.members = g.members.filter((m) => m !== u.name);
    for (const gname of wanted) {
      const g = findGroup(sh, gname)!;
      if (!g.members.includes(u.name)) g.members.push(u.name);
    }
  }
  if (values.g) {
    const g = findGroup(sh, values.g);
    if (!g) return fail(`usermod: group '${values.g}' does not exist`, 6);
    u.gid = g.gid;
  }
  if (values.u) u.uid = parseInt(values.u, 10);
  if (values.s) u.shell = values.s;
  if (values.c !== undefined) u.comment = values.c;
  if (values.d) u.home = values.d;
  if (values.l) u.name = values.l;
  if (flags.has('L')) u.locked = true;
  if (flags.has('U')) u.locked = false;
  return ok();
};

const userdel: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'userdel');
  if (denied) return denied;
  const { flags, operands } = getopts(args);
  const u = findUser(sh, operands[0] ?? '');
  if (!u) return fail(`userdel: user '${operands[0]}' does not exist`, 6);
  sh.state.users = sh.state.users.filter((x) => x !== u);
  for (const g of sh.state.groups) g.members = g.members.filter((m) => m !== u.name);
  const own = sh.state.groups.find((g) => g.name === u.name && g.gid === u.gid);
  if (own) sh.state.groups = sh.state.groups.filter((g) => g !== own);
  if (flags.has('r') && sh.exists(u.home)) sh.exec(['rm', '-rf', u.home]);
  return ok();
};

const groupadd: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'groupadd');
  if (denied) return denied;
  const { values, operands } = getopts(args, ['g']);
  const name = operands[0];
  if (!name) return fail('Usage: groupadd [options] GROUP', 2);
  if (findGroup(sh, name)) return fail(`groupadd: group '${name}' already exists`, 9);
  const gid = values.g ? parseInt(values.g, 10) : Math.max(999, ...sh.state.groups.filter((g) => g.gid < 60000).map((g) => g.gid)) + 1;
  sh.state.groups.push({ name, gid, members: [] });
  return ok();
};

const groupdel: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'groupdel');
  if (denied) return denied;
  const g = findGroup(sh, args[0] ?? '');
  if (!g) return fail(`groupdel: group '${args[0]}' does not exist`, 6);
  if (sh.state.users.some((u) => u.gid === g.gid)) return fail(`groupdel: cannot remove the primary group of user '${userName(sh, sh.state.users.find((u) => u.gid === g.gid)!.uid)}'`, 8);
  sh.state.groups = sh.state.groups.filter((x) => x !== g);
  return ok();
};

const groupmod: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'groupmod');
  if (denied) return denied;
  const { values, operands } = getopts(args, ['g', 'n']);
  const g = findGroup(sh, operands[0] ?? '');
  if (!g) return fail(`groupmod: group '${operands[0]}' does not exist`, 6);
  if (values.g) g.gid = parseInt(values.g, 10);
  if (values.n) g.name = values.n;
  return ok();
};

const gpasswd: Command = ({ sh, args }) => {
  const denied = needRoot(sh, 'gpasswd');
  if (denied) return denied;
  const { values, operands } = getopts(args, ['a', 'd']);
  const g = findGroup(sh, operands[0] ?? '');
  if (!g) return fail(`gpasswd: group '${operands[0]}' does not exist in /etc/group`, 3);
  if (values.a) {
    if (!g.members.includes(values.a)) g.members.push(values.a);
    return ok(`Adding user ${values.a} to group ${g.name}\n`);
  }
  if (values.d) {
    g.members = g.members.filter((m) => m !== values.d);
    return ok(`Removing user ${values.d} from group ${g.name}\n`);
  }
  return fail('Usage: gpasswd [option] GROUP', 2);
};

const passwd: Command = ({ sh, args, stdin }) => {
  const { flags, operands } = getopts(args);
  const target = operands[0] ? findUser(sh, operands[0]) : sh.user;
  if (!target) return fail(`passwd: user '${operands[0]}' does not exist`);
  if (target !== sh.user && sh.uid !== 0) return fail('passwd: Only root can specify a user name.');
  if (flags.has('l')) {
    target.locked = true;
    return ok(`Locking password for user ${target.name}.\npasswd: Success\n`);
  }
  if (flags.has('u')) {
    target.locked = false;
    return ok(`Unlocking password for user ${target.name}.\npasswd: Success\n`);
  }
  if (flags.has('stdin') && !stdin.trim()) return fail('passwd: no password provided on stdin');
  target.password = '$6$' + (stdin.trim() || 'set');
  return ok(
    `Changing password for user ${target.name}.\n` +
      (flags.has('stdin') ? '' : 'New password: ********\nRetype new password: ********\n') +
      'passwd: all authentication tokens updated successfully.\n',
  );
};

const chage: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['M', 'm', 'W', 'E', 'd']);
  const u = findUser(sh, operands[0] ?? '');
  if (!u) return fail(`chage: user '${operands[0]}' does not exist in /etc/passwd`);
  if (flags.has('l')) {
    return ok(
      `Last password change\t\t\t\t\t: Oct 21, 2026\nPassword expires\t\t\t\t\t: ${u.maxDays >= 99999 ? 'never' : `${u.maxDays} days after last change`}\nPassword inactive\t\t\t\t\t: never\nAccount expires\t\t\t\t\t\t: never\nMinimum number of days between password change\t\t: ${u.minDays}\nMaximum number of days between password change\t\t: ${u.maxDays}\nNumber of days of warning before password expires\t: ${u.warnDays}\n`,
    );
  }
  const denied = needRoot(sh, 'chage');
  if (denied) return denied;
  if (values.M) u.maxDays = parseInt(values.M, 10);
  if (values.m) u.minDays = parseInt(values.m, 10);
  if (values.W) u.warnDays = parseInt(values.W, 10);
  return ok();
};

function applyChmod(mode: number, spec: string, isDir: boolean): number | null {
  if (/^[0-7]{3,4}$/.test(spec)) return parseInt(spec, 8);
  let m = mode;
  for (const clause of spec.split(',')) {
    const r = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(clause);
    if (!r) return null;
    const who = r[1] || 'a';
    let bits = 0;
    for (const p of r[3]) {
      for (const w of who === 'a' ? 'ugo' : who) {
        const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
        if (p === 'r') bits |= 4 << shift;
        if (p === 'w') bits |= 2 << shift;
        if (p === 'x' || (p === 'X' && (isDir || mode & 0o111))) bits |= 1 << shift;
        if (p === 's' && w === 'u') bits |= 0o4000;
        if (p === 's' && w === 'g') bits |= 0o2000;
      }
      if (p === 't') bits |= 0o1000;
    }
    if (r[2] === '+') m |= bits;
    else if (r[2] === '-') m &= ~bits;
    else {
      let clear = 0;
      for (const w of who === 'a' ? 'ugo' : who) clear |= 7 << (w === 'u' ? 6 : w === 'g' ? 3 : 0);
      m = (m & ~clear) | bits;
    }
  }
  return m;
}

function walkTargets(sh: Shell, paths: string[], recursive: boolean, fn: (n: FsNode, p: string) => void) {
  const visit = (n: FsNode, p: string) => {
    fn(n, p);
    if (recursive && n.children) for (const [k, c] of Object.entries(n.children)) visit(c, `${p}/${k}`);
  };
  for (const p of paths) visit(sh.resolve(p).node, p);
}

const chmod: Command = ({ sh, args }) => {
  const recursive = args.includes('-R');
  const rest = args.filter((a) => a !== '-R');
  const [spec, ...paths] = rest;
  if (!spec || !paths.length) return fail(`chmod: missing operand`);
  let err = '';
  for (const p of paths) {
    try {
      walkTargets(sh, [p], recursive, (n, path) => {
        if (sh.uid !== 0 && n.uid !== sh.uid) {
          err += `chmod: changing permissions of '${path}': Operation not permitted\n`;
          return;
        }
        const m = applyChmod(n.mode, spec, n.type === 'dir');
        if (m === null) throw new Error(`invalid mode: '${spec}'`);
        n.mode = m;
      });
    } catch (e) {
      err += e instanceof FsError ? errMsg('chmod', p, e) + '\n' : `chmod: ${(e as Error).message}\n`;
    }
  }
  return err ? fail(err) : ok();
};

const chown: Command = ({ sh, args, name }) => {
  const recursive = args.includes('-R');
  const [spec, ...paths] = args.filter((a) => a !== '-R');
  if (!spec || !paths.length) return fail(`${name}: missing operand`);
  let uid: number | undefined;
  let gid: number | undefined;
  if (name === 'chgrp') {
    const g = findGroup(sh, spec);
    if (!g) return fail(`chgrp: invalid group: '${spec}'`);
    gid = g.gid;
  } else {
    const [u, g] = spec.split(/[:.]/);
    if (u) {
      const user = findUser(sh, u);
      if (!user) return fail(`chown: invalid user: '${spec}'`);
      uid = user.uid;
    }
    if (g) {
      const group = findGroup(sh, g);
      if (!group) return fail(`chown: invalid group: '${spec}'`);
      gid = group.gid;
    }
  }
  if (sh.uid !== 0 && uid !== undefined) return fail(`chown: changing ownership of '${paths[0]}': Operation not permitted`);
  let err = '';
  for (const p of paths) {
    try {
      walkTargets(sh, [p], recursive, (n) => {
        if (sh.uid !== 0 && (n.uid !== sh.uid || (gid !== undefined && !sh.gids.includes(gid)))) {
          err += `${name}: changing group of '${p}': Operation not permitted\n`;
          return;
        }
        if (uid !== undefined) n.uid = uid;
        if (gid !== undefined) n.gid = gid;
      });
    } catch (e) {
      err += errMsg(name, p, e) + '\n';
    }
  }
  return err ? fail(err) : ok();
};

const umask: Command = ({ sh, args }) => {
  if (!args.length) return ok(sh.umask.toString(8).padStart(4, '0') + '\n');
  if (!/^[0-7]{1,4}$/.test(args[0])) return fail(`-bash: umask: ${args[0]}: octal number out of range`);
  sh.umask = parseInt(args[0], 8);
  return ok();
};

const sudo: Command = ({ sh, args, stdin }) => {
  const isWheel = sh.state.groups.find((g) => g.name === 'wheel')?.members.includes(sh.user.name);
  if (sh.uid !== 0 && !isWheel) {
    return fail(`${sh.user.name} is not in the sudoers file.  This incident will be reported.`);
  }
  const root = findUser(sh, 'root')!;
  if (args[0] === '-i' || args[0] === '-s' || (args[0] === 'su' && (args[1] === '-' || !args[1]))) {
    sh.sessions.push({ user: root, cwd: args[0] === '-s' ? sh.cwd : '/root' });
    return ok();
  }
  if (!args.length) return fail('usage: sudo -i | sudo command');
  return sh.asUser(root, () => sh.exec(args, stdin));
};

const su: Command = ({ sh, args }) => {
  const login = args.includes('-') || args.includes('-l');
  const name = args.filter((a) => a !== '-' && a !== '-l')[0] ?? 'root';
  const u = findUser(sh, name);
  if (!u) return fail(`su: user ${name} does not exist or the user entry does not contain all the required fields`);
  if (u.shell.endsWith('nologin')) return ok('This account is currently not available.\n');
  if (sh.uid !== 0 && name === 'root') {
    return fail('su: Authentication failure\n(The practice root password is not set. Use sudo -i instead, which is how RHEL admins usually become root.)');
  }
  sh.sessions.push({ user: u, cwd: login ? u.home : sh.cwd });
  return ok();
};

const exit: Command = ({ sh }) => {
  if (sh.sessions.length > 1) {
    sh.sessions.pop();
    return ok('logout\n');
  }
  return ok('You are at the top-level login shell. (Closing this would log you out of the practice server.)\n');
};

// ---------- system info ----------

const hostname: Command = ({ sh, args }) => {
  if (args[0] === '-s') return ok(sh.shortHost + '\n');
  if (args[0] === '-I') return ok('192.168.4.100\n');
  if (args[0]) {
    const denied = needRoot(sh, 'hostname');
    if (denied) return fail('hostname: you must be root to change the host name');
    sh.state.hostname = args[0];
  }
  return ok(sh.state.hostname + '\n');
};

const hostnamectl: Command = ({ sh, args }) => {
  if (args[0] === 'set-hostname' || args[0] === 'hostname') {
    if (!args[1]) return ok(sh.state.hostname + '\n');
    const denied = needRoot(sh, 'hostnamectl');
    if (denied) return fail('Could not set static hostname: Access denied');
    sh.state.hostname = args[1];
    return ok();
  }
  return ok(
    ` Static hostname: ${sh.state.hostname}\n       Icon name: computer-vm\n         Chassis: vm\nOperating System: Red Hat Enterprise Linux 10.0 (Coughlan)\n          Kernel: Linux 6.12.0-55.el10.x86_64\n    Architecture: x86-64\n`,
  );
};

const uname: Command = ({ args }) => {
  if (args.includes('-r')) return ok('6.12.0-55.el10.x86_64\n');
  if (args.includes('-a')) return ok('Linux server1.example.com 6.12.0-55.el10.x86_64 #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n');
  if (args.includes('-m')) return ok('x86_64\n');
  return ok('Linux\n');
};

const date: Command = () => ok(new Date().toString() + '\n');

const uptime: Command = () => ok(' 15:42:07 up 3 days,  4:11,  1 user,  load average: 0.08, 0.03, 0.01\n');


const ping: Command = ({ args }) => {
  const host = args.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a)).pop();
  if (!host) return fail('ping: usage error: Destination address required', 2);
  const ipAddr = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : '192.168.4.10';
  let out = `PING ${host} (${ipAddr}) 56(84) bytes of data.\n`;
  for (let i = 1; i <= 3; i++) out += `64 bytes from ${ipAddr}: icmp_seq=${i} ttl=64 time=0.${300 + i * 17} ms\n`;
  out += `\n--- ${host} ping statistics ---\n3 packets transmitted, 3 received, 0% packet loss, time 2003ms\n`;
  return ok(out);
};

const df: Command = ({ args }) => {
  const h = args.some((a) => a.includes('h'));
  return ok(
    h
      ? 'Filesystem             Size  Used Avail Use% Mounted on\n/dev/mapper/rhel-root   17G  4.1G   13G  25% /\ndevtmpfs               4.0M     0  4.0M   0% /dev\ntmpfs                  1.8G     0  1.8G   0% /dev/shm\n/dev/nvme0n1p2         960M  312M  649M  33% /boot\n'
      : 'Filesystem            1K-blocks    Used Available Use% Mounted on\n/dev/mapper/rhel-root  17756160 4296820  13459340  25% /\n/dev/nvme0n1p2           983040  319488    663552  33% /boot\n',
  );
};

const free: Command = () =>
  ok('               total        used        free      shared  buff/cache   available\nMem:         3740284      912340     2105672       11284      968560     2827944\nSwap:        2097148           0     2097148\n');

const lsblk: Command = () =>
  ok(
    'NAME          MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\nnvme0n1       259:0    0   20G  0 disk\n├─nvme0n1p1   259:1    0  600M  0 part /boot/efi\n├─nvme0n1p2   259:2    0    1G  0 part /boot\n└─nvme0n1p3   259:3    0 18.4G  0 part\n  ├─rhel-root 253:0    0 16.4G  0 lvm  /\n  └─rhel-swap 253:1    0    2G  0 lvm  [SWAP]\nnvme0n2       259:4    0   10G  0 disk\n',
  );



// ---------- services, packages, security ----------

const systemctl: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const [verb, ...units] = operands;
  const svcName = (u: string) => u.replace(/\.service$/, '');
  const unit = (n: string) => (n.includes('.') ? n : `${n}.service`);
  const get = (u: string) => sh.state.services[svcName(u)];
  const changes = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'set-default', 'isolate', 'mask', 'unmask', 'daemon-reload'];
  if (changes.includes(verb ?? '') && sh.uid !== 0) {
    return fail(`Failed to ${verb} ${units[0] ?? ''}: Access denied\n(Hint: use sudo systemctl ${verb} ${units.join(' ')})`);
  }
  switch (verb) {
    case undefined:
    case 'list-units': {
      const rows = Object.values(sh.state.services)
        .filter((s) => s.active || flags.has('all'))
        .map((s) => `  ${unit(s.name).padEnd(30)} loaded ${s.active ? 'active   running' : 'inactive dead   '} ${s.description}`);
      return ok(`  UNIT                           LOAD   ACTIVE   SUB     DESCRIPTION\n${rows.join('\n')}\n\n${rows.length} loaded units listed.\n`);
    }
    case 'list-unit-files': {
      const rows = Object.values(sh.state.services).map((s) => `${unit(s.name).padEnd(32)} ${s.enabled ? 'enabled ' : 'disabled'} disabled`);
      return ok(`UNIT FILE                        STATE    PRESET\n${rows.join('\n')}\n`);
    }
    case 'list-timers': {
      const timers = Object.values(sh.state.services).filter((s) => s.name.endsWith('.timer') && (s.active || flags.has('all')));
      return ok('NEXT                        LEFT     LAST                        PASSED  UNIT                     ACTIVATES\n' + timers.map((t) => `Wed 2026-10-22 00:00:00 UTC 8h left  Tue 2026-10-21 00:00:00 UTC 15h ago ${t.name.padEnd(24)} ${t.name.replace('.timer', '.service')}`).join('\n') + `\n\n${timers.length} timers listed.\n`);
    }
    case 'cat': {
      const s = get(units[0] ?? '');
      if (!s) return fail(`No files found for ${units[0]}.`);
      if (s.name.endsWith('.timer')) return ok(`# /usr/lib/systemd/system/${s.name}\n[Unit]\nDescription=${s.description}\n\n[Timer]\nOnCalendar=weekly\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`);
      return ok(`# /usr/lib/systemd/system/${unit(s.name)}\n[Unit]\nDescription=${s.description}\n\n[Service]\nExecStart=/usr/sbin/${s.name}\n\n[Install]\nWantedBy=multi-user.target\n`);
    }
    case 'get-default':
      return ok(sh.state.defaultTarget + '\n');
    case 'set-default': {
      const t = units[0]?.endsWith('.target') ? units[0] : `${units[0]}.target`;
      if (!['multi-user.target', 'graphical.target', 'rescue.target', 'emergency.target'].includes(t)) return fail(`Failed to set default target: Unit ${t} not found.`);
      sh.state.defaultTarget = t;
      return ok(`Removed '/etc/systemd/system/default.target'.\nCreated symlink '/etc/systemd/system/default.target' → '/usr/lib/systemd/system/${t}'.\n`);
    }
    case 'isolate':
      return ok();
    case 'daemon-reload':
      return ok();
    case 'reboot':
      return rebootSystem({ sh, args: [], stdin: '', name: 'reboot' });
    case 'poweroff':
      return ok(`(Practice server: pretending to ${verb}. Your changes are kept.)\n`);
  }
  if (!units.length) return fail(`Too few arguments.`);
  let out = '';
  let err = '';
  let code = 0;
  for (const u of units) {
    const s = get(u);
    if (!s) {
      if (verb === 'status') err += `Unit ${svcName(u)}.service could not be found.\n`;
      else if (verb === 'is-active' || verb === 'is-enabled') out += verb === 'is-active' ? 'inactive\n' : 'not-found\n';
      else err += `Failed to ${verb} ${svcName(u)}.service: Unit ${svcName(u)}.service not found.\n`;
      code = verb === 'status' ? 4 : verb === 'is-active' ? 3 : 1;
      continue;
    }
    switch (verb) {
      case 'start':
      case 'restart':
      case 'reload':
        s.active = true;
        break;
      case 'stop':
        s.active = false;
        break;
      case 'enable':
        if (!s.enabled) err += `Created symlink '/etc/systemd/system/${s.name.endsWith('.timer') ? 'timers' : 'multi-user'}.target.wants/${unit(s.name)}' → '/usr/lib/systemd/system/${unit(s.name)}'.\n`;
        s.enabled = true;
        if (flags.has('now')) s.active = true;
        break;
      case 'disable':
        if (s.enabled) err += `Removed '/etc/systemd/system/${s.name.endsWith('.timer') ? 'timers' : 'multi-user'}.target.wants/${unit(s.name)}'.\n`;
        s.enabled = false;
        if (flags.has('now')) s.active = false;
        break;
      case 'is-active':
        out += s.active ? 'active\n' : 'inactive\n';
        if (!s.active) code = 3;
        break;
      case 'is-enabled':
        out += s.enabled ? 'enabled\n' : 'disabled\n';
        if (!s.enabled) code = 1;
        break;
      case 'status':
        out += `${s.active ? '●' : '○'} ${unit(s.name)} - ${s.description}\n     Loaded: loaded (/usr/lib/systemd/system/${unit(s.name)}; ${s.enabled ? 'enabled' : 'disabled'}; preset: disabled)\n     Active: ${s.active ? 'active (running) since Tue 2026-10-21 08:00:04 UTC' : 'inactive (dead)'}\n`;
        if (!s.active) code = 3;
        break;
      default:
        return fail(`Unknown command verb '${verb}'.`);
    }
  }
  return { stdout: out, stderr: err, code };
};

const dnf: Command = (ctx) => {
  const kernel = kernelDnf(ctx);
  if (kernel) return kernel;
  const { sh, args, name } = ctx;
  const { operands } = getopts(args);
  const [verb, ...pkgs] = operands;
  const known = (p: string) => AVAILABLE_PACKAGES[pkgKey(p)];
  switch (verb) {
    case 'install': {
      if (sh.uid !== 0) return fail('Error: This command has to be run with superuser privileges (under the root user on most systems).');
      let out = 'Updating and loading repositories:\nRepositories loaded.\n';
      for (const p of pkgs) {
        const info = known(p);
        if (!info) return fail(`${out}Failed to resolve the transaction:\nNo match for argument: ${p}\nYou can try to add to command line:\n  --skip-unavailable to skip unavailable packages`);
        if (sh.state.installed.includes(p)) {
          out += `Package "${p}-${info.version}.x86_64" is already installed.\n`;
          continue;
        }
        sh.state.installed.push(p);
        if (info.service && !sh.state.services[info.service]) {
          sh.state.services[info.service] = { name: info.service, description: info.summary, active: false, enabled: false, installedBy: p };
        }
        out += `Installing: ${p}-${info.version}.x86_64\n`;
      }
      return ok(out + 'Complete!\n');
    }
    case 'remove':
    case 'erase': {
      if (sh.uid !== 0) return fail('Error: This command has to be run with superuser privileges (under the root user on most systems).');
      let out = '';
      for (const p of pkgs) {
        if (!sh.state.installed.includes(p)) return fail(`No packages to remove for argument: ${p}`);
        sh.state.installed = sh.state.installed.filter((x) => x !== p);
        for (const [k, s] of Object.entries(sh.state.services)) if (s.installedBy === p) delete sh.state.services[k];
        out += `Removing: ${p}\n`;
      }
      return ok(out + 'Complete!\n');
    }
    case 'search': {
      const term = pkgs[0] ?? '';
      const hits = Object.entries(AVAILABLE_PACKAGES).filter(([k, v]) => pkgName(k).includes(term) || v.summary.toLowerCase().includes(term.toLowerCase()));
      return ok('Matched fields: name, summary\n' + hits.map(([k, v]) => ` ${pkgName(k)}.x86_64\t${v.summary}`).join('\n') + '\n');
    }
    case 'info': {
      const p = pkgs[0] ?? '';
      const info = known(p);
      if (!info) return fail(`No matching packages to list`);
      return ok(`${sh.state.installed.includes(p) ? 'Installed packages' : 'Available packages'}\nName           : ${p}\nVersion        : ${info.version.split('-')[0]}\nRelease        : ${info.version.split('-')[1]}\nArchitecture   : x86_64\nSummary        : ${info.summary}\n`);
    }
    case 'list': {
      if (pkgs[0] === 'installed') return ok('Installed packages\n' + sh.state.installed.map((p) => ` ${p}`).join('\n') + '\n');
      return ok('Available packages\n' + Object.keys(AVAILABLE_PACKAGES).map((k) => ` ${pkgName(k)}`).join('\n') + '\n');
    }
    case 'provides':
    case 'whatprovides':
      if ((pkgs[0] ?? '').includes('semanage')) return ok('policycoreutils-python-utils-3.8-1.el10.noarch : SELinux policy core python utilities\nRepo         : rhel-10-for-x86_64-appstream-rpms\n');
      return ok(`No matches found.\n`);
    case 'repolist':
      return ok('repo id                               repo name\nrhel-10-for-x86_64-appstream-rpms     Red Hat Enterprise Linux 10 for x86_64 - AppStream (RPMs)\nrhel-10-for-x86_64-baseos-rpms        Red Hat Enterprise Linux 10 for x86_64 - BaseOS (RPMs)\n');
    case 'update':
    case 'upgrade':
      if (sh.uid !== 0) return fail('Error: This command has to be run with superuser privileges (under the root user on most systems).');
      return ok('Updating and loading repositories:\nRepositories loaded.\nNothing to do.\n');
    default:
      return fail(`${name}: usage: ${name} [install|remove|search|info|list|provides|repolist|update] ...`);
  }
};

const rpm: Command = (ctx) => {
  const kernel = kernelRpm(ctx);
  if (kernel) return kernel;
  const { sh, args } = ctx;
  const { flags, operands } = getopts(args);
  if (flags.has('q') && flags.has('a')) return ok(sh.state.installed.map((p) => `${p}-1.0-1.el10.x86_64`).join('\n') + '\n');
  if (flags.has('q') && flags.has('f')) return ok('coreutils-9.5-6.el10.x86_64\n');
  if (flags.has('q')) {
    return ok(operands.map((p) => (sh.state.installed.includes(p) ? `${p}-${AVAILABLE_PACKAGES[pkgKey(p)]?.version ?? '1.0-1.el10'}.x86_64` : `package ${p} is not installed`)).join('\n') + '\n');
  }
  return fail('rpm: this practice terminal supports rpm -qa, rpm -q <pkg> and rpm -qf <file>');
};

const getenforce: Command = ({ sh }) => ok(sh.state.selinux + '\n');

const setenforce: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return fail('setenforce:  setenforce() failed');
  if (sh.state.selinux === 'Disabled') return fail('setenforce: SELinux is disabled');
  const v = (args[0] ?? '').toLowerCase();
  if (v === '1' || v === 'enforcing') sh.state.selinux = 'Enforcing';
  else if (v === '0' || v === 'permissive') sh.state.selinux = 'Permissive';
  else return fail('usage:  setenforce [ Enforcing | Permissive | 1 | 0 ]');
  return ok();
};

const sestatus: Command = ({ sh }) =>
  ok(
    `SELinux status:                 enabled\nSELinuxfs mount:                /sys/fs/selinux\nLoaded policy name:             targeted\nCurrent mode:                   ${sh.state.selinux.toLowerCase()}\nMode from config file:          ${sh.state.selinuxConfigMode}\nPolicy MLS status:              enabled\n`,
  );

const firewallCmd: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return fail('Authorization failed.\n    Make sure polkit agent is running or run the application as superuser.');
  const fw = sh.state.firewall;
  const perm = args.includes('--permanent');
  let out = '';
  for (const a of args) {
    const [k, v] = a.replace(/^--/, '').split('=');
    switch (k) {
      case 'state':
        return ok('running\n');
      case 'get-default-zone':
        return ok('public\n');
      case 'list-services':
        return ok((perm ? fw.permServices : fw.services).join(' ') + '\n');
      case 'list-ports':
        return ok((perm ? fw.permPorts : fw.ports).join(' ') + '\n');
      case 'list-all':
        return ok(`public (active)\n  target: default\n  interfaces: ens160\n  services: ${(perm ? fw.permServices : fw.services).join(' ')}\n  ports: ${(perm ? fw.permPorts : fw.ports).join(' ')}\n`);
      case 'add-service':
      case 'remove-service':
      case 'add-port':
      case 'remove-port': {
        if (!v) return fail(`usage: --${k}=<value>`);
        if (k.endsWith('port') && !/^\d+(-\d+)?\/(tcp|udp)$/.test(v)) return fail(`Error: INVALID_PORT: ${v}`);
        const list = k.endsWith('service') ? (perm ? fw.permServices : fw.services) : perm ? fw.permPorts : fw.ports;
        if (k.startsWith('add') && !list.includes(v)) list.push(v);
        if (k.startsWith('remove')) list.splice(0, list.length, ...list.filter((x) => x !== v));
        out = 'success\n';
        break;
      }
      case 'reload':
        fw.services = [...fw.permServices];
        fw.ports = [...fw.permPorts];
        return ok('success\n');
      case 'runtime-to-permanent':
        fw.permServices = [...fw.services];
        fw.permPorts = [...fw.ports];
        return ok('success\n');
    }
  }
  return out ? ok(out) : fail('usage: see man firewall-cmd');
};

// ---------- shell built-ins ----------

const history: Command = ({ sh }) => ok(sh.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n') + '\n');

const clear: Command = () => ({ stdout: '', stderr: '', code: 0, clear: true });

const which: Command = ({ args }) => {
  let out = '';
  let err = '';
  for (const a of args) {
    if (COMMANDS[a]) out += `/usr/bin/${a}\n`;
    else err += `/usr/bin/which: no ${a} in (/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin)\n`;
  }
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

const typeCmd: Command = ({ args }) => {
  const builtins = ['cd', 'echo', 'exit', 'history', 'umask', 'export', 'type', 'pwd', 'alias'];
  return ok(args.map((a) => (builtins.includes(a) ? `${a} is a shell builtin` : COMMANDS[a] ? `${a} is /usr/bin/${a}` : `-bash: type: ${a}: not found`)).join('\n') + '\n');
};

const exportCmd: Command = ({ sh, args }) => {
  for (const a of args) {
    const [k, ...v] = a.split('=');
    if (v.length) sh.env[k] = v.join('=');
  }
  return ok();
};

const env: Command = ({ sh }) =>
  ok(['HOME', 'USER', 'PWD', 'SHELL', 'HOSTNAME', 'PATH'].map((k) => `${k}=${sh.getVar(k)}`).concat(Object.entries(sh.env).filter(([k]) => k !== 'OLDPWD').map(([k, v]) => `${k}=${v}`)).join('\n') + '\n');

const man: Command = ({ args }) => {
  const topic = args.filter((a) => !/^\d$/.test(a) && a !== '-k')[0];
  if (args[0] === '-k') {
    const hits = Object.entries(MAN_PAGES).filter(([k, v]) => k.includes(topic ?? '') || v.toLowerCase().includes((topic ?? '').toLowerCase()));
    return hits.length ? ok(hits.map(([k, v]) => `${k} (1)${' '.repeat(Math.max(1, 14 - k.length))}- ${v.split('\n')[0]}`).join('\n') + '\n') : fail(`${topic}: nothing appropriate.`);
  }
  if (!topic) return fail('What manual page do you want?\nFor example, try \'man man\'.');
  const page = MAN_PAGES[topic];
  if (!page) return fail(`No manual entry for ${topic}`, 16);
  return ok(`${topic.toUpperCase()}(1)\n\nNAME\n       ${topic} - ${page}\n\n(Practice summary. On a real system, man ${topic} shows the full page. Press q to quit it.)\n`);
};

const help: Command = () => {
  const names = Object.keys(COMMANDS).sort();
  let out = 'Commands available in this practice terminal:\n\n';
  for (let i = 0; i < names.length; i += 6) out += '  ' + names.slice(i, i + 6).map((n) => n.padEnd(13)).join('') + '\n';
  out += '\nPipes (|), redirection (> >> 2> <), ; && || and $VARIABLES all work.\nUse "man <command>" for a short summary of any command.\n';
  return ok(out);
};

const trueCmd: Command = () => ok();
const falseCmd: Command = () => ({ stdout: '', stderr: '', code: 1 });

const test: Command = ({ sh, args, name }) => {
  const a = name === '[' ? args.slice(0, -1) : args;
  if (name === '[' && args[args.length - 1] !== ']') return fail("[: missing `]'", 2);
  const res = (v: boolean): CommandResult => ({ stdout: '', stderr: '', code: v ? 0 : 1 });
  let neg = false;
  if (a[0] === '!') {
    neg = true;
    a.shift();
  }
  const r = (v: boolean) => res(neg ? !v : v);
  if (a.length === 2) {
    const [op, p] = a;
    const node = (() => {
      try {
        return sh.resolve(p).node;
      } catch {
        return null;
      }
    })();
    switch (op) {
      case '-e':
        return r(!!node);
      case '-f':
        return r(node?.type === 'file');
      case '-d':
        return r(node?.type === 'dir');
      case '-r':
        return r(!!node && canAccess(node, 'r', sh.uid, sh.gids));
      case '-w':
        return r(!!node && canAccess(node, 'w', sh.uid, sh.gids));
      case '-x':
        return r(!!node && canAccess(node, 'x', sh.uid, sh.gids));
      case '-s':
        return r(!!node && nodeSize(node) > 0);
      case '-z':
        return r(p === '');
      case '-n':
        return r(p !== '');
    }
  }
  if (a.length === 3) {
    const [x, op, y] = a;
    const nx = parseInt(x, 10);
    const ny = parseInt(y, 10);
    switch (op) {
      case '=':
      case '==':
        return r(x === y);
      case '!=':
        return r(x !== y);
      case '-eq':
        return r(nx === ny);
      case '-ne':
        return r(nx !== ny);
      case '-lt':
        return r(nx < ny);
      case '-le':
        return r(nx <= ny);
      case '-gt':
        return r(nx > ny);
      case '-ge':
        return r(nx >= ny);
    }
  }
  if (a.length === 1) return r(a[0] !== '');
  return res(neg);
};

const crontab: Command = ({ sh, args, stdin }) => {
  const { flags, values } = getopts(args, ['u']);
  const user = values.u ?? sh.user.name;
  if (values.u && sh.uid !== 0) return fail('crontab: must be privileged to use -u');
  const store = sh.resolve('/var/spool/cron').node;
  if (flags.has('l')) {
    const f = store.children![user];
    return f ? ok(f.content ?? '') : fail(`no crontab for ${user}`);
  }
  if (flags.has('r')) {
    delete store.children![user];
    return ok();
  }
  if (flags.has('e')) {
    return fail('crontab -e opens an editor, which the phone terminal cannot show.\nInstead, pipe a line in:  echo "0 2 * * * /usr/local/bin/backup.sh" | crontab -');
  }
  if (args.includes('-')) {
    for (const line of lines(stdin)) {
      if (line.trim() && !line.startsWith('#') && line.trim().split(/\s+/).length < 6) return fail(`"-":1: bad minute\nerrors in crontab file, can't install.`);
    }
    store.children![user] = makeFile(stdin, findUser(sh, user)?.uid ?? 0, 0, 0o600);
    return ok();
  }
  return fail('usage: crontab [-u user] [ -l | -r | - ]');
};

const journalctl: Command = ({ sh, args }) => {
  if (sh.uid !== 0 && !sh.state.groups.find((g) => g.name === 'wheel')?.members.includes(sh.user.name)) {
    return fail('Hint: You are currently not seeing messages from other users and the system.');
  }
  let text = sh.state.root.children!.var.children!.log.children!.messages.content ?? '';
  const u = args.indexOf('-u');
  if (u >= 0 && args[u + 1]) text = joinLines(lines(text).filter((l) => l.includes(args[u + 1].replace('.service', ''))));
  if (args.includes('-p') && args[args.indexOf('-p') + 1] === 'err') text = joinLines(lines(text).filter((l) => /error|preventing|failed/i.test(l)));
  const n = args.indexOf('-n');
  if (n >= 0) text = joinLines(lines(text).slice(-parseInt(args[n + 1] ?? '10', 10)));
  return ok(text || '-- No entries --\n');
};

export const COMMANDS: Record<string, Command> = {
  pwd, cd, ls, mkdir, rmdir, touch, cat, echo, cp, mv, rm, ln, readlink, stat, file, find,
  head: headTail(true), tail: headTail(false), wc, grep, egrep: grep, sort, uniq, cut, tr, awk, sed, tee,
  less: pager, more: pager, vim: editor, vi: editor, nano: editor,
  tar, gzip: compressCmd('.gz', false), gunzip: compressCmd('.gz', true), bzip2: compressCmd('.bz2', false), bunzip2: compressCmd('.bz2', true),
  whoami, id, groups: groupsCmd, useradd, usermod, userdel, groupadd, groupdel, groupmod, gpasswd, passwd, chage,
  chmod, chown, chgrp: chown, umask, sudo, su, exit, logout: exit,
  hostname, hostnamectl, uname, date, uptime, ping, df, free, lsblk,
  systemctl, dnf, yum: dnf, rpm, getenforce, setenforce, sestatus, 'firewall-cmd': firewallCmd,
  journalctl, crontab,
  history, clear, which, type: typeCmd, export: exportCmd, env, man, help,
  true: trueCmd, false: falseCmd, test, '[': test,
  ...ADMIN_COMMANDS,
  ...STORAGE_COMMANDS,
  ...KERNEL_COMMANDS,
  ...SCRIPT_COMMANDS,
};

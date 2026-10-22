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
import { FIND_COMMANDS } from './commands-find';
import { KERNEL_COMMANDS, kernelDnf, kernelRpm, rebootSystem } from './commands-kernel';
import { SCRIPT_COMMANDS } from './commands-script';
import { STORAGE_COMMANDS } from './commands-storage';
import { RegexSyntaxError, TEXT_COMMANDS, posixRegex } from './commands-text';
import { journalctl, journaldStart, mountUnit } from './journal';
import { machineId, nodeAt } from './kernel-state';
import { MAN_PAGES } from './manpages';
import { cEscape } from './parser';
import type { Shell } from './shell';
import { AVAILABLE_PACKAGES, Group, User, pkgKey, pkgName, runningHostname } from './state';
import { fstabCheck } from './storage-state';
import { SudoCommand, checkSudoersText, readSudoers, securePath, sudoCheck, sudoList } from './sudoers';

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
  /** Standard output is the terminal (not a pipe, a file or $( )). Unset counts as the terminal. */
  tty?: boolean;
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

const ls: Command = ({ sh, args, tty }) => {
  // -1 is an option of ls (getopts reads -5 as a number, for head and tail)
  const { flags, operands } = getopts(args.filter((a) => a !== '-1'));
  if (args.includes('-1')) flags.add('1');
  const long = flags.has('l');
  // GNU ls prints columns on a terminal and one name per line into a pipe or file (-1 and -C choose)
  const sep = flags.has('1') || (tty === false && !flags.has('C')) ? '\n' : '  ';
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
    if (all) {
      let parent = node;
      try {
        parent = sh.resolve(path === '/' ? '/' : `${path.replace(/\/+$/, '')}/..`).node;
      } catch {
        // no access to the parent: show the directory itself, as before
      }
      entries.unshift(['.', node], ['..', parent]);
    }
    if (header) out += `${path}:\n`;
    if (long) {
      const total = entries.reduce((s, [, n]) => s + Math.ceil(nodeSize(n) / 1024) * 4, 0);
      out += `total ${total}\n`;
      out += entries.map(([n, c]) => line(n, c)).join('\n') + (entries.length ? '\n' : '');
    } else if (entries.length) {
      out += entries.map(([n, c]) => line(n, c)).join(sep) + '\n';
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
  if (files.length) out += files.join(long ? '\n' : sep) + '\n';
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
  let k = 0;
  // bash's echo: every leading word made of n, e and E letters is options (-n, -e, -ne, -eE)
  for (; k < args.length && /^-[neE]+$/.test(args[k]); k++) {
    for (const c of args[k].slice(1)) {
      if (c === 'n') newline = false;
      else escapes = c === 'e';
    }
  }
  const s = args.slice(k).join(' ');
  if (!escapes) return ok(s + (newline ? '\n' : ''));
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i + 1];
    if (s[i] !== '\\' || c === undefined) r += s[i];
    else if (c === 'c') return ok(r); // \c: nothing more, not even the newline
    else if (c === "'" || c === '"' || c === '?') r += '\\';
    else {
      // \n \t \\ \a \e, \0NNN octal, \xHH, \uHHHH; anything else stays as typed
      const [text, used] = cEscape(s, i + 1, true);
      r += text;
      i += used;
    }
  }
  return ok(r + (newline ? '\n' : ''));
};

/**
 * Copy (or with move, rename) src to dest, or into dest when it is a directory. Like GNU cp, a new
 * copy belongs to the user and gets the source mode minus the umask (and minus setuid/setgid on
 * files); an existing file keeps its owner and mode. preserve (-p, -a) keeps mode, times and,
 * for root, the owner.
 */
function copyInto(sh: Shell, src: string, dest: string, recursive: boolean, move: boolean, preserve = false): string | null {
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
      const attrs = (n: FsNode, from: FsNode) => {
        if (preserve) {
          n.mode = from.mode;
          n.mtime = from.mtime;
          n.uid = sh.uid === 0 ? from.uid : sh.uid;
          n.gid = sh.uid === 0 || sh.gids.includes(from.gid) ? from.gid : sh.user.gid;
        }
      };
      if (existing && existing.type === 'file' && s.node.type === 'file') {
        existing.content = s.node.content;
        existing.mtime = Date.now();
        attrs(existing, s.node);
      } else {
        const copy = cloneNode(s.node);
        const setOwner = (n: FsNode, from: FsNode) => {
          n.uid = sh.uid;
          n.gid = sh.user.gid;
          if (n.type === 'file') n.mode = from.mode & 0o777 & ~sh.umask;
          else if (n.type === 'dir') n.mode = from.mode & 0o7777 & ~sh.umask;
          attrs(n, from);
          if (n.children) for (const [k, c] of Object.entries(n.children)) setOwner(c, from.children![k]);
        };
        setOwner(copy, s.node);
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
  const preserve = flags.has('p') || flags.has('a') || flags.has('archive');
  if (operands.length > 1 && !(sh.exists(dest) && sh.resolve(dest).node.type === 'dir'))
    return fail(`cp: target '${dest}': Not a directory`);
  let err = '';
  for (const s of operands) {
    const e = copyInto(sh, s, dest, recursive, false, preserve);
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

const grep: Command = ({ sh, args, stdin, name }) => {
  const { flags, values, operands } = getopts(args, ['e']);
  const pattern = values.e ?? operands.shift();
  if (pattern === undefined) return fail('Usage: grep [OPTION]... PATTERNS [FILE]...', 2);
  const extended = flags.has('E') || name === 'egrep';
  let re: RegExp;
  try {
    const src = flags.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') : posixRegex(pattern, extended);
    re = new RegExp(flags.has('w') ? `\\b(?:${src})\\b` : src, flags.has('i') ? 'i' : '');
  } catch (e) {
    return fail(`grep: ${e instanceof RegexSyntaxError ? e.message : 'Invalid regular expression'}`, 2);
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
  const u = operands.length ? findUser(sh, operands[0]) : sh.user;
  if (!u) return fail(`id: '${operands[0]}': no such user`);
  const primary = findGroup(sh, String(u.gid));
  const groups = [primary!, ...sh.state.groups.filter((g) => g.members.includes(u.name) && g.gid !== u.gid)];
  if (flags.has('u')) return ok(`${flags.has('n') ? u.name : u.uid}\n`);
  if (flags.has('g')) return ok(`${flags.has('n') ? primary?.name : u.gid}\n`);
  if (flags.has('G')) return ok(groups.map((g) => (flags.has('n') ? g.name : g.gid)).join(' ') + '\n');
  const ctx = operands.length ? '' : ' context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023';
  return ok(`uid=${u.uid}(${u.name}) gid=${u.gid}(${primary?.name}) groups=${groups.map((g) => `${g.gid}(${g.name})`).join(',')}${ctx}\n`);
};

const groupsCmd: Command = ({ sh, args }) => {
  const u = args.length ? findUser(sh, args[0]) : sh.user;
  if (!u) return fail(`groups: '${args[0]}': no such user`);
  const names = [findGroup(sh, String(u.gid))?.name, ...sh.state.groups.filter((g) => g.members.includes(u.name)).map((g) => g.name)];
  return ok(`${args.length ? u.name + ' : ' : ''}${[...new Set(names)].join(' ')}\n`);
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

// ---------- sudo and su ----------

const SUDO_USAGE = `usage: sudo -h | -K | -k | -V
usage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]
usage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user]
            [-u user] [command [arg ...]]
usage: sudo [-ABbEHkNnPS] [-r role] [-t type] [-C num] [-D directory]
            [-g group] [-h host] [-p prompt] [-R directory] [-T timeout]
            [-u user] [VAR=value] [-i | -s] [command [arg ...]]
usage: sudo -e [-ABkNnS] [-r role] [-t type] [-C num] [-D directory]
            [-g group] [-h host] [-p prompt] [-R directory] [-T timeout]
            [-u user] file ...`;

const SUDO_HELP = `sudo - execute a command as another user

${SUDO_USAGE}

Options:
  -E, --preserve-env            preserve user environment when running command
  -i, --login                   run login shell as the target user; a command
                                may also be specified
  -k, --reset-timestamp         invalidate timestamp file
  -l, --list                    list user's privileges or check a specific
                                command; use twice for longer format
  -n, --non-interactive         non-interactive mode, no prompts are used
  -s, --shell                   run shell as the target user; a command may
                                also be specified
  -U, --other-user=user         in list mode, display privileges for user
  -u, --user=user               run command (or edit file) as specified user
                                name or ID
  -V, --version                 display version information and exit
  -v, --validate                update user's timestamp without running a
                                command
  --                            stop processing command line arguments
`;

const STD_BIN_DIRS = ['/bin', '/sbin', '/usr/bin', '/usr/sbin'];
const PRACTICE_BIN = /^\/(usr\/)?s?bin\/[^/]+$/;

/**
 * Run fn as `user` in `cwd`, the way sudo and su start a command: in a session of its own, with
 * PATH set to `path` (null: the user's login default). The caller's directory never changes.
 */
function runAs<T>(sh: Shell, user: User, cwd: string, path: string | null | undefined, vars: [string, string][], fn: () => T): T {
  const sessions = sh.sessions;
  const session = { user, cwd };
  sessions.push(session);
  const env = sh.env;
  const saved = new Map<string, string | undefined>();
  const set = (k: string, v: string | null) => {
    if (!saved.has(k)) saved.set(k, Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined);
    if (v === null) delete env[k];
    else env[k] = v;
  };
  if (path !== undefined) set('PATH', path);
  for (const [k, v] of vars) set(k, v);
  try {
    return fn();
  } finally {
    // a reboot starts new sessions and a new environment: then there is nothing to put back
    if (sh.env === env) {
      for (const [k, v] of saved) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    // "sudo bash" or "sudo su -" leave their own shell on top: only this session goes
    if (sh.sessions === sessions) {
      const i = sessions.lastIndexOf(session);
      if (i > 0) sessions.splice(i, 1);
    }
  }
}

/** Find a command the way sudo does: through secure_path, never through shell functions or aliases. */
function sudoFind(sh: Shell, name: string, path: string): { argv0: string; cmd: SudoCommand } | null {
  if (name.includes('/')) {
    const abs = joinPath(splitPath(sh.cwd, name, sh.user.home));
    const node = nodeAt(sh.state.root, abs);
    if (node) return { argv0: name, cmd: { path: abs, args: [], practice: false } };
    const base = abs.split('/').pop()!;
    if (COMMANDS[base] && PRACTICE_BIN.test(abs)) return { argv0: name, cmd: { path: abs, args: [], practice: true } };
    return null;
  }
  for (const d of path.split(':')) {
    if (!d) continue;
    const dir = d.replace(/(.)\/+$/, '$1');
    // the practice commands have no files and count as being in /usr/bin and /usr/sbin
    if (Object.prototype.hasOwnProperty.call(COMMANDS, name) && STD_BIN_DIRS.includes(dir)) {
      return { argv0: name, cmd: { path: `/usr/bin/${name}`, args: [], practice: true } };
    }
    const full = `${dir}/${name}`;
    const node = nodeAt(sh.state.root, full);
    if (node?.type === 'file' && node.mode & 0o111) return { argv0: full, cmd: { path: full, args: [], practice: false } };
  }
  return null;
}

const sudo: Command = (ctx) => {
  const { sh, args, stdin } = ctx;
  let runUser: string | null = null;
  let listUser: string | null = null;
  let mode: 'run' | 'login' | 'shell' | 'list' | 'validate' | 'edit' = 'run';
  let reset = false;
  let i = 0;
  const bad = (msg: string) => fail(`sudo: ${msg}\n${SUDO_USAGE}`);
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      let val: string | undefined;
      if (['user', 'other-user', 'group', 'prompt', 'close-from', 'role', 'type', 'chdir', 'chroot', 'command-timeout'].includes(k)) {
        val = v ?? args[++i];
        if (val === undefined) return bad(`option '--${k}' requires an argument`);
      }
      if (k === 'user') runUser = val!;
      else if (k === 'other-user') listUser = val!;
      else if (k === 'chdir' || k === 'chroot') return fail(`sudo: you are not permitted to use the --${k} option`);
      else if (k === 'login') mode = 'login';
      else if (k === 'shell') mode = 'shell';
      else if (k === 'list') mode = 'list';
      else if (k === 'validate') mode = 'validate';
      else if (k === 'edit') mode = 'edit';
      else if (k === 'help') return ok(SUDO_HELP);
      else if (k === 'version') return ok('Sudo version 1.9.15p5\n');
      else if (k === 'reset-timestamp' || k === 'remove-timestamp') reset = true;
      else if (val === undefined && !['preserve-env', 'set-home', 'non-interactive', 'background', 'stdin', 'askpass', 'bell', 'preserve-groups'].includes(k)) {
        return bad(`unrecognized option '${a}'`);
      }
      continue;
    }
    if (!a.startsWith('-') || a === '-') break;
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if ('ugUpCDrtTR'.includes(c)) {
        const v = a.slice(j + 1) || args[++i];
        if (v === undefined) return bad(`option requires an argument -- '${c}'`);
        if (c === 'u') runUser = v;
        if (c === 'U') listUser = v;
        if (c === 'D' || c === 'R') return fail(`sudo: you are not permitted to use the -${c} option`);
        break;
      }
      if (c === 'i') mode = 'login';
      else if (c === 's') mode = 'shell';
      else if (c === 'l') mode = 'list';
      else if (c === 'v') mode = 'validate';
      else if (c === 'e') mode = 'edit';
      else if (c === 'h') return ok(SUDO_HELP);
      else if (c === 'V') return ok('Sudo version 1.9.15p5\n');
      else if (c === 'k' || c === 'K') reset = true;
      else if (!'AbBEHnNPS'.includes(c)) return bad(`invalid option -- '${c}'`);
    }
  }
  const vars: [string, string][] = [];
  while (i < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i])) {
    const eq = args[i].indexOf('=');
    vars.push([args[i].slice(0, eq), args[i].slice(eq + 1)]);
    i++;
  }
  const rest = args.slice(i);
  if (mode === 'edit') return editor({ ...ctx, name: 'sudoedit' });
  if (mode === 'run' && !rest.length) return reset ? ok() : fail(SUDO_USAGE);

  const st = sh.state;
  const sud = readSudoers(st);
  const warn = sud.warnings.map((w) => w + '\n').join('');
  if (sud.errors.length) {
    return fail(
      `${warn}${sud.errors[0]}\nsudo: error initializing audit plugin sudoers_audit\n(Practice server: a broken sudoers file locks everyone out of sudo. On a real server you would repair it with "pkexec visudo" or from rescue mode. Here, tap Reset to start again. Next time, check a rule with "visudo -c -f FILE" before you install it.)`,
    );
  }
  const host = runningHostname(st);
  const short = host.split('.')[0];
  const caller = sh.user;
  const target = runUser === null ? findUser(sh, 'root')! : findUser(sh, runUser.replace(/^#/, ''));
  if (!target) return fail(`${warn}sudo: unknown user ${runUser}\nsudo: error initializing audit plugin sudoers_audit`);
  const secure = securePath(st, sud, caller) ?? sh.getVar('PATH');
  const notInSudoers = () => fail(`${warn}${caller.name} is not in the sudoers file.  This incident will be reported.`);

  if (mode === 'list') {
    let who = caller;
    if (listUser !== null) {
      const u = findUser(sh, listUser);
      if (!u) return fail(`${warn}sudo: unknown user ${listUser}`);
      const shell = { path: '/usr/bin/bash', args: [], practice: false };
      if (caller.uid !== 0 && sudoCheck(st, sud, caller, findUser(sh, 'root')!, shell, host) !== 'allowed') {
        return fail(`${warn}Sorry, user ${caller.name} is not allowed to execute 'list' as ${u.name} on ${short}.`);
      }
      who = u;
    }
    if (rest.length) {
      const found = sudoFind(sh, rest[0], securePath(st, sud, who) ?? sh.getVar('PATH'));
      if (!found) return fail(`${warn}sudo: ${rest[0]}: command not found`);
      const cmd = { ...found.cmd, args: rest.slice(1) };
      if (sudoCheck(st, sud, who, target, cmd, host) !== 'allowed') return { stdout: '', stderr: warn, code: 1 };
      return { stdout: [cmd.path, ...cmd.args].join(' ') + '\n', stderr: warn, code: 0 };
    }
    const list = sudoList(st, sud, who, host);
    if (!list) {
      return listUser !== null
        ? { stdout: `User ${who.name} is not allowed to run sudo on ${short}.\n`, stderr: warn, code: 1 }
        : fail(`${warn}Sorry, user ${who.name} may not run sudo on ${short}.`);
    }
    const defaults = list.defaults ? `Matching Defaults entries for ${who.name} on ${short}:\n    ${list.defaults}\n\n` : '';
    return { stdout: `${defaults}User ${who.name} may run the following commands on ${short}:\n${list.rules.map((r) => `    ${r}\n`).join('')}`, stderr: warn, code: 0 };
  }
  if (mode === 'validate' || (reset && !rest.length)) {
    return sudoList(st, sud, caller, host) ? { stdout: '', stderr: warn, code: 0 } : notInSudoers();
  }

  // what sudo runs: the command, or the target's shell for -i and -s
  const shellMode = mode === 'login' || mode === 'shell';
  let cmd: SudoCommand;
  let argv0 = '';
  if (shellMode) {
    cmd = { path: usrPath(target.shell), args: rest.length ? ['-c', rest.join(' ')] : [], practice: false };
  } else {
    const found = sudoFind(sh, rest[0], secure);
    if (!found) {
      if (!sudoList(st, sud, caller, host)) return notInSudoers();
      return fail(`${warn}sudo: ${rest[0]}: command not found`);
    }
    argv0 = found.argv0;
    cmd = { ...found.cmd, args: rest.slice(1) };
  }
  const verdict = sudoCheck(st, sud, caller, target, cmd, host);
  if (verdict === 'not-in-sudoers') return notInSudoers();
  if (verdict === 'denied') {
    return fail(`${warn}Sorry, user ${caller.name} is not allowed to execute '${[cmd.path, ...cmd.args].join(' ')}' as ${target.name} on ${host}.`);
  }
  const prefix = (r: CommandResult): CommandResult => (warn ? { ...r, stderr: warn + r.stderr } : r);
  if (shellMode) {
    if (target.shell.endsWith('nologin')) return prefix({ stdout: 'This account is currently not available.\n', stderr: '', code: 1 });
    const cwd = mode === 'login' ? target.home : sh.cwd;
    if (!rest.length) {
      // an interactive shell: it stays until "exit"
      sh.sessions.push({ user: target, cwd });
      return prefix(ok());
    }
    const name0 = mode === 'login' ? '-bash' : 'bash';
    return prefix(runAs(sh, target, cwd, mode === 'login' ? null : secure, vars, () => sh.runString(rest.join(' '), name0, [], stdin)));
  }
  return prefix(runAs(sh, target, sh.cwd, secure, vars, () => sh.exec([argv0, ...rest.slice(1)], stdin)));
};

/** /bin/bash is /usr/bin/bash on RHEL. */
const usrPath = (p: string) => p.replace(/^\/bin\//, '/usr/bin/').replace(/^\/sbin\//, '/usr/sbin/');

const SU_HELP = `
Usage:
 su [options] [-] [<user> [<argument>...]]

Change the effective user ID and group ID to that of <user>.
A mere - implies -l.  If <user> is not given, root is assumed.

Options:
 -m, -p, --preserve-environment      do not reset environment variables
 -c, --command <command>             pass a single command to the shell with -c
 -l, --login                         make the shell a login shell
 -s, --shell <shell>                 run <shell> if /etc/shells allows it
`;

const su: Command = ({ sh, args, stdin }) => {
  let login = false;
  let command: string | null = null;
  let shellOpt: string | null = null;
  let name: string | null = null;
  const extra: string[] = [];
  const usage = "\nTry 'su --help' for more information.";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (name !== null && !a.startsWith('-')) {
      extra.push(a);
      continue;
    }
    if (a === '-' || a === '-l' || a === '--login') login = true;
    else if (a === '-c' || a === '--command' || a === '-s' || a === '--shell') {
      const v = args[++i];
      if (v === undefined) return fail(a.startsWith('--') ? `su: option '${a}' requires an argument${usage}` : `su: option requires an argument -- '${a[1]}'${usage}`);
      if (a.includes('c')) command = v;
      else shellOpt = v;
    } else if (a.startsWith('--command=')) command = a.slice('--command='.length);
    else if (a.startsWith('--shell=')) shellOpt = a.slice('--shell='.length);
    else if (a === '-m' || a === '-p' || a === '--preserve-environment') continue;
    else if (a === '-h' || a === '--help') return ok(SU_HELP);
    else if (/^-[lmp]+$/.test(a)) login ||= a.includes('l');
    else if (/^-[lmp]*c./.test(a)) {
      login ||= a.slice(0, a.indexOf('c')).includes('l');
      command = a.slice(a.indexOf('c') + 1);
    } else if (/^-[lmp]*c$/.test(a)) {
      login ||= a.includes('l');
      command = args[++i] ?? null;
      if (command === null) return fail(`su: option requires an argument -- 'c'${usage}`);
    } else if (a.startsWith('--')) return fail(`su: unrecognized option '${a}'${usage}`);
    else if (a.startsWith('-')) return fail(`su: invalid option -- '${a[1]}'${usage}`);
    else name = a;
  }
  const target = name ?? 'root';
  const u = findUser(sh, target);
  if (!u) return fail(`su: user ${target} does not exist or the user entry does not contain all the required fields`);
  if (sh.uid !== 0 && u.uid !== sh.uid) {
    if (u.uid === 0) {
      return fail('su: Authentication failure\n(The practice root password is not set. Use sudo -i instead, which is how RHEL admins usually become root.)');
    }
    if (!u.password || u.locked) {
      return fail(`su: Authentication failure\n(${u.name} has no usable password, so su cannot log in as ${u.name}. Root needs no password: sudo su - ${u.name})`);
    }
  }
  const shell = shellOpt !== null && sh.uid === 0 ? shellOpt : u.shell;
  if (shell.endsWith('nologin') || shell.endsWith('/false')) return { stdout: 'This account is currently not available.\n', stderr: '', code: 1 };
  const cwd = login ? u.home : sh.cwd;
  if (command !== null) {
    return runAs(sh, u, cwd, login ? null : undefined, [], () => sh.runString(command!, login ? '-bash' : 'bash', extra, stdin));
  }
  sh.sessions.push({ user: u, cwd });
  return ok();
};

/** visudo: check the sudoers files (-c, or -c -f FILE for one file). The full-screen editor is not available here. */
const visudo: Command = (ctx) => {
  const { sh, args } = ctx;
  const { flags, values } = getopts(args, ['f', 'file']);
  if (!flags.has('c') && !flags.has('check')) {
    return fail(`visudo: full-screen editors are not available on the phone terminal.\nWrite a rule to a drop-in file, check it, then copy it into place:\n  echo 'anna ALL=(ALL) ALL' > anna.sudo\n  visudo -c -f anna.sudo\n  sudo cp anna.sudo /etc/sudoers.d/anna && sudo chmod 440 /etc/sudoers.d/anna`);
  }
  const file = values.f ?? values.file;
  let sud;
  if (file !== undefined) {
    let text: string;
    try {
      text = sh.readFile(file);
    } catch (e) {
      return fail(`visudo: unable to open ${file}: ${e instanceof FsError ? errorText[e.reason] : String(e)}`);
    }
    sud = checkSudoersText(sh.state, text, file);
  } else {
    if (sh.uid !== 0) return fail('visudo: /etc/sudoers: Permission denied');
    sud = readSudoers(sh.state);
  }
  const bad = sud.errors[0] ?? '';
  const out = sud.files.filter((f) => !bad.includes(` ${f}:`)).map((f) => `${f}: parsed OK\n`).join('');
  const warn = sud.warnings.map((w) => w.replace(/^sudo: /, 'visudo: ') + '\n').join('');
  if (bad) return fail(warn + bad.replace(/^sudo: /gm, '').replace(/\n.*no valid sudoers sources.*$/m, ''), 1, out);
  return { stdout: out, stderr: warn, code: 0 };
};

const exit: Command = ({ sh }) => {
  if (sh.sessions.length > 1) {
    sh.sessions.pop();
    return ok('logout\n');
  }
  // the root shell of rescue or emergency mode: leaving it continues the boot to the default target
  if (sh.uid === 0 && maintenanceTarget(sh.state.kernel.bootTarget)) return switchTarget(sh, 'default.target', null);
  return ok('You are at the top-level login shell. (Closing this would log you out of the practice server.)\n');
};

// ---------- system info ----------

const HOST_RE = /^(?=.{1,64}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const ipv4Addresses = (sh: Shell) => sh.state.connections.flatMap((c) => c.applied.ipv4.map((a) => a.split('/')[0]));

/**
 * hostname: show the running (transient) host name, or set it until the next reboot.
 * The static name in /etc/hostname, which hostnamectl set-hostname writes, comes back at boot.
 */
const hostname: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args, ['F', 'file']);
  const name = runningHostname(sh.state);
  if (flags.has('help')) return ok('Usage: hostname [-b] {hostname|-F file}         set host name (from file)\n       hostname [-a|-A|-d|-f|-i|-I|-s|-y]       display formatted name\n       hostname                                 display host name\n');
  if (operands.length) {
    if (sh.uid !== 0) return fail('hostname: you must be root to change the host name');
    if (!HOST_RE.test(operands[0])) return fail('hostname: the specified hostname is invalid');
    sh.state.transientHostname = operands[0] === sh.state.hostname ? undefined : operands[0];
    return ok();
  }
  if (flags.has('s') || flags.has('short')) return ok(name.split('.')[0] + '\n');
  if (flags.has('d') || flags.has('domain')) return ok(name.split('.').slice(1).join('.') + '\n');
  if (flags.has('I') || flags.has('all-ip-addresses')) return ok(ipv4Addresses(sh).map((a) => a + ' ').join('') + '\n');
  if (flags.has('i') || flags.has('ip-address')) return ok((ipv4Addresses(sh)[0] ?? '127.0.0.1') + '\n');
  if (flags.has('a') || flags.has('alias')) return ok('\n');
  return ok(name + '\n');
};

/** hostnamectl: the static name (/etc/hostname), the transient name and facts about the machine. */
const hostnamectl: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const st = sh.state;
  const only = flags.has('static') ? 'static' : flags.has('transient') ? 'transient' : flags.has('pretty') ? 'pretty' : null;
  const [verb = 'status', value, ...extra] = operands;
  switch (verb) {
    case 'status': {
      if (only === 'static') return ok(st.hostname + '\n');
      if (only === 'transient') return ok(runningHostname(st) + '\n');
      if (only === 'pretty') return ok('\n');
      const rows: [string, string][] = [['Static hostname', st.hostname]];
      if (st.transientHostname !== undefined) rows.push(['Transient hostname', st.transientHostname]);
      rows.push(
        ['Icon name', 'computer-vm'],
        ['Chassis', 'vm'],
        ['Machine ID', machineId(st.root)],
        ['Virtualization', 'vmware'],
        ['Operating System', 'Red Hat Enterprise Linux 10.0 (Coughlan)'],
        ['CPE OS Name', 'cpe:/o:redhat:enterprise_linux:10.0'],
        ['Kernel', `Linux ${st.kernel.running}`],
        ['Architecture', 'x86-64'],
        ['Hardware Vendor', 'VMware, Inc.'],
        ['Hardware Model', 'VMware20,1'],
        ['Firmware Version', 'VMW201.00V.24006586.B64.2406042154'],
      );
      const w = Math.max(...rows.map((r) => r[0].length));
      return ok(rows.map(([k, v]) => `${k.padStart(w)}: ${v}\n`).join(''));
    }
    case 'hostname':
    case 'set-hostname': {
      if (value === undefined) {
        if (verb === 'set-hostname') return fail('Too few arguments.');
        return ok((only === 'static' ? st.hostname : only === 'pretty' ? '' : runningHostname(st)) + '\n');
      }
      if (extra.length) return fail('Too many arguments.');
      const what = only ?? 'static';
      if (sh.uid !== 0) return fail(`Could not set ${what} hostname: Access denied`);
      if (only === 'pretty') return ok();
      if (!HOST_RE.test(value)) return fail(`Invalid ${what} hostname '${value}'`);
      if (only === 'transient') {
        st.transientHostname = value === st.hostname ? undefined : value;
        return ok();
      }
      // with --static only /etc/hostname changes; without it the running name changes too
      const running = runningHostname(st);
      st.hostname = value;
      st.transientHostname = only === 'static' && running !== value ? running : undefined;
      return ok();
    }
    case 'chassis':
    case 'icon-name':
    case 'deployment':
    case 'location':
      if (value === undefined) return ok(`${verb === 'chassis' ? 'vm' : verb === 'icon-name' ? 'computer-vm' : ''}\n`);
      return sh.uid === 0 ? ok() : fail(`Could not set property: Access denied`);
    default:
      return fail(`Unknown command verb '${verb}'.`);
  }
};

const uname: Command = ({ args }) => {
  if (args.includes('-r')) return ok('6.12.0-55.el10.x86_64\n');
  if (args.includes('-a')) return ok('Linux server1.example.com 6.12.0-55.el10.x86_64 #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n');
  if (args.includes('-m')) return ok('x86_64\n');
  return ok('Linux\n');
};

// ---------- date ----------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Wall-clock fields of a moment in a time zone, with the zone's abbreviation and UTC offset in minutes. */
function zonedTime(ms: number, tz: string) {
  let offset = 0;
  let abbr = 'UTC';
  if (tz !== 'UTC') {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', timeZoneName: 'short' }).formatToParts(new Date(ms));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      offset = Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(ms / 1000) * 1000) / 60_000);
      // en-US knows EDT and PDT, en-GB knows CEST and BST; other zones show their offset, like +0530
      const gb = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms));
      const name = [parts, gb].map((ps) => ps.find((p) => p.type === 'timeZoneName')?.value ?? '').find((n) => /^[A-Z]{3,5}$/.test(n));
      const abs = Math.abs(offset);
      abbr = name ?? `${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${abs % 60 ? String(abs % 60).padStart(2, '0') : ''}`;
    } catch {
      // no time zone data: show UTC
    }
  }
  const d = new Date(ms + offset * 60_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(), ms, offset, abbr };
}

/** strftime as GNU date formats it in the en_US.UTF-8 locale, with the - _ 0 flags. */
function strftime(fmt: string, t: ReturnType<typeof zonedTime>): string {
  const yday = Math.floor((Date.UTC(t.y, t.mo, t.d) - Date.UTC(t.y, 0, 1)) / 86_400_000) + 1;
  const h12 = t.h % 12 || 12;
  const off = (colon: boolean) => {
    const a = Math.abs(t.offset);
    return `${t.offset < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${colon ? ':' : ''}${String(a % 60).padStart(2, '0')}`;
  };
  const pad = (n: number, w: number, flag: string, space = false) => (flag === '-' ? String(n) : String(n).padStart(w, flag === '_' || (space && flag !== '0') ? ' ' : '0'));
  const one = (c: string, flag: string): string | null => {
    switch (c) {
      case 'Y': return String(t.y);
      case 'C': return pad(Math.floor(t.y / 100), 2, flag);
      case 'y': return pad(t.y % 100, 2, flag);
      case 'm': return pad(t.mo + 1, 2, flag);
      case 'd': return pad(t.d, 2, flag);
      case 'e': return pad(t.d, 2, flag, true);
      case 'H': return pad(t.h, 2, flag);
      case 'k': return pad(t.h, 2, flag, true);
      case 'I': return pad(h12, 2, flag);
      case 'l': return pad(h12, 2, flag, true);
      case 'M': return pad(t.mi, 2, flag);
      case 'S': return pad(t.s, 2, flag);
      case 'N': return String((t.ms % 1000) * 1_000_000).padStart(9, '0');
      case 'p': return t.h < 12 ? 'AM' : 'PM';
      case 'P': return t.h < 12 ? 'am' : 'pm';
      case 'a': return WEEKDAYS[t.wd].slice(0, 3);
      case 'A': return WEEKDAYS[t.wd];
      case 'b': case 'h': return MONTH_NAMES[t.mo].slice(0, 3);
      case 'B': return MONTH_NAMES[t.mo];
      case 'j': return pad(yday, 3, flag);
      case 'u': return String(t.wd || 7);
      case 'w': return String(t.wd);
      case 's': return String(Math.floor(t.ms / 1000));
      case 'Z': return t.abbr;
      case 'z': return off(false);
      case 'F': return `${t.y}-${pad(t.mo + 1, 2, '')}-${pad(t.d, 2, '')}`;
      case 'T': return `${pad(t.h, 2, '')}:${pad(t.mi, 2, '')}:${pad(t.s, 2, '')}`;
      case 'R': return `${pad(t.h, 2, '')}:${pad(t.mi, 2, '')}`;
      case 'D': case 'x': return `${pad(t.mo + 1, 2, '')}/${pad(t.d, 2, '')}/${pad(t.y % 100, 2, '')}`;
      case 'r': return `${pad(h12, 2, '')}:${pad(t.mi, 2, '')}:${pad(t.s, 2, '')} ${t.h < 12 ? 'AM' : 'PM'}`;
      case 'X': return one('r', '');
      case 'c': return `${one('a', '')} ${one('d', '')} ${one('b', '')} ${t.y} ${one('r', '')} ${t.abbr}`;
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return null;
    }
  };
  return fmt.replace(/%([-_0^]?)(:?)([A-Za-z%])/g, (all, flag: string, colon: string, c: string) => {
    if (colon) return c === 'z' ? off(true) : all;
    const v = one(c, flag === '^' ? '' : flag);
    if (v === null) return all;
    return flag === '^' ? v.toUpperCase() : v;
  });
}

/** The few -d forms scripts use: now, today, yesterday, tomorrow, N days ago, +N days, @EPOCH, YYYY-MM-DD [HH:MM[:SS]]. */
function parseDateArg(text: string, now: number, tz: string): number | null {
  const s = text.trim().toLowerCase();
  if (s === '' || s === 'now' || s === 'today') return now;
  if (s === 'yesterday') return now - 86_400_000;
  if (s === 'tomorrow') return now + 86_400_000;
  let m = /^@(-?\d+)$/.exec(s);
  if (m) return Number(m[1]) * 1000;
  const units: Record<string, number> = { sec: 1000, second: 1000, min: 60_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
  m = /^([+-]?\d+)\s*(sec|second|min|minute|hour|day|week)s?(\s+ago)?$/.exec(s);
  if (m) return now + Number(m[1]) * units[m[2]] * (m[3] ? -1 : 1);
  m = /^(next|last)\s+(day|week)$/.exec(s);
  if (m) return now + units[m[2]] * (m[1] === 'next' ? 1 : -1);
  m = /^(\d{4})-(\d\d)-(\d\d)(?:[ t](\d\d?):(\d\d)(?::(\d\d))?)?$/.exec(s);
  if (!m) return null;
  // a date and time on the server's clock (its time zone), not in UTC
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return wall - zonedTime(wall, tz).offset * 60_000;
}

const date: Command = ({ sh, args }) => {
  const utc = args.some((a) => a === '-u' || a === '--utc' || a === '--universal');
  const tz = utc ? 'UTC' : sh.state.timezone;
  let when = Date.now();
  let fmt: string | null = null;
  let iso: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u' || a === '--utc' || a === '--universal') continue;
    if (a === '-d' || a.startsWith('--date=') || (a.startsWith('-d') && a.length > 2)) {
      const v = a === '-d' ? args[++i] : a.startsWith('--date=') ? a.slice(7) : a.slice(2);
      if (v === undefined) return fail("date: option requires an argument -- 'd'\nTry 'date --help' for more information.");
      const t = parseDateArg(v, Date.now(), tz);
      if (t === null) return fail(`date: invalid date ‘${v}’`);
      when = t;
    } else if (a === '-I' || a.startsWith('--iso-8601') || (a.startsWith('-I') && a.length > 2)) iso = a.replace(/^(-I|--iso-8601=?)/, '') || 'date';
    else if (a === '-R' || a === '--rfc-email') fmt = '%a, %d %b %Y %H:%M:%S %z';
    else if (a === '-s' || a.startsWith('--set')) return sh.uid === 0 ? fail('date: setting the time is not possible in the practice terminal; use timedatectl') : fail('date: cannot set date: Operation not permitted');
    else if (a.startsWith('+')) {
      if (fmt !== null) return fail(`date: extra operand ‘${a}’\nTry 'date --help' for more information.`);
      fmt = a.slice(1);
    } else return fail(`date: invalid date ‘${a}’`);
  }
  const t = zonedTime(when, tz);
  if (iso !== null) {
    const parts: Record<string, string> = { date: '%F', hours: '%FT%H%:z', minutes: '%FT%H:%M%:z', seconds: '%FT%T%:z', ns: '%FT%T,%N%:z' };
    if (!parts[iso]) return fail(`date: invalid argument ‘${iso}’ for ‘--iso-8601’`);
    fmt = parts[iso];
  }
  return ok(strftime(fmt ?? '%a %b %e %r %Z %Y', t) + '\n');
};

/** uptime from procps-ng 4: the time since the last (simulated) boot. */
const uptime: Command = ({ sh, args }) => {
  const now = Date.now();
  const boot = sh.state.kernel.bootTime;
  const mins = Math.max(0, Math.floor((now - boot) / 60_000));
  const [days, hours, min] = [Math.floor(mins / 1440), Math.floor((mins % 1440) / 60), mins % 60];
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (args.includes('-p') || args.includes('--pretty')) {
    const parts = [days && plural(days, 'day'), hours && plural(hours, 'hour'), (min || mins === 0) && plural(min, 'minute')].filter(Boolean);
    return ok(`up ${parts.join(', ')}\n`);
  }
  if (args.includes('-s') || args.includes('--since')) return ok(strftime('%F %T', zonedTime(boot, sh.state.timezone)) + '\n');
  const up = (days ? `${plural(days, 'day')}, ` : '') + (hours ? `${String(hours).padStart(2)}:${String(min).padStart(2, '0')}` : `${min} min`);
  return ok(` ${strftime('%T', zonedTime(now, sh.state.timezone))} up ${up},  1 user,  load average: 0.08, 0.03, 0.01\n`);
};


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

// ---------- systemd targets ----------

const TARGETS: Record<string, string> = {
  'multi-user.target': 'Multi-User System',
  'graphical.target': 'Graphical Interface',
  'rescue.target': 'Rescue Mode',
  'emergency.target': 'Emergency Mode',
};
// targets that exist but cannot be isolated (no AllowIsolate=yes)
const OTHER_TARGETS: Record<string, string> = {
  'basic.target': 'Basic System',
  'sysinit.target': 'System Initialization',
  'local-fs.target': 'Local File Systems',
  'remote-fs.target': 'Remote File Systems',
  'swap.target': 'Swaps',
  'network.target': 'Network',
  'network-online.target': 'Network is Online',
  'timers.target': 'Timer Units',
  'sockets.target': 'Socket Units',
  'paths.target': 'Path Units',
  'getty.target': 'Login Prompts',
  'reboot.target': 'System Reboot',
  'poweroff.target': 'System Power Off',
  'halt.target': 'System Halt',
};
const maintenanceTarget = (t: string) => t === 'rescue.target' || t === 'emergency.target';

/** Is a target active in the running system? multi-user.target is part of graphical.target. */
function targetActive(sh: Shell, unit: string): boolean {
  const b = sh.state.kernel.bootTarget;
  const t = unit === 'default.target' ? sh.state.defaultTarget : unit;
  if (t === b) return true;
  if (TARGETS[t]) return t === 'multi-user.target' && b === 'graphical.target';
  if (['reboot.target', 'poweroff.target', 'halt.target'].includes(t) || b === 'emergency.target') return false;
  if (b === 'rescue.target') return ['sysinit.target', 'local-fs.target', 'swap.target'].includes(t);
  return !!OTHER_TARGETS[t];
}

/** data.mount -> /data, var-www.mount -> /var/www, -.mount -> / */
const mountPath = (unit: string) => {
  const p = unit.replace(/\.mount$/, '');
  return p === '-' ? '/' : '/' + p.split('-').map((x) => x.replace(/\\x([0-9a-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))).join('/');
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Wed 2026-10-21 10:00:00 EDT, as wall and systemctl print dates */
function longDate(ms: number) {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${DAY_NAMES[d.getDay()]} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} EDT`;
}

/** Append lines to the log, the way rsyslog writes what systemd logs. */
function logMessages(sh: Shell, lines: string[]): void {
  const log = nodeAt(sh.state.root, '/var/log/messages');
  if (log?.type !== 'file') return;
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  log.content = (log.content ?? '') + lines.map((l) => `${when} ${sh.shortHost} ${l}\n`).join('');
}

/**
 * systemctl isolate, rescue, emergency and default: switch the running system to another target.
 * Services the target does not want stop. Rescue and emergency mode log everyone out and leave
 * root on the console; going back to a normal target logs student in again.
 */
function switchTarget(sh: Shell, unit: string, wall: 'rescue' | 'emergency' | null): CommandResult {
  const st = sh.state;
  const k = st.kernel;
  const target = unit === 'default.target' ? st.defaultTarget : unit;
  if (target === 'reboot.target') return rebootSystem({ sh, args: [], stdin: '', name: 'reboot' });
  if (target === 'poweroff.target' || target === 'halt.target') return ok('(Practice server: pretending to power off. Your changes are kept. Use "reboot" to practise a restart.)\n');
  if (!TARGETS[target]) {
    if (OTHER_TARGETS[target] || st.services[target.replace(/\.service$/, '')]) return fail(`Failed to start ${target}: Operation refused, unit may not be isolated.`);
    return fail(`Failed to start ${target}: Unit ${target} not found.`);
  }
  const from = k.bootTarget;
  const into = maintenanceTarget(target);
  let out = '';
  if (wall) {
    out += `\nBroadcast message from root@${sh.shortHost} on pts/0 (${longDate(Date.now())}):\n\nThe system is going down to ${wall} mode NOW!\n\n`;
  }
  if (target === from) return ok(out);
  if (from === 'emergency.target' && !into) {
    // local-fs.target again: every /etc/fstab line has to mount now
    const broken = fstabCheck(st).filter((c) => c.error && !c.entry.options.includes('nofail'));
    if (broken.length) {
      logMessages(sh, [...broken.map((c) => `systemd[1]: ${c.error!.trim()}`), 'systemd[1]: Dependency failed for local-fs.target - Local File Systems.']);
      return fail(`A dependency job for ${target} failed. See 'journalctl -xe' for details.`);
    }
    sh.exec(['mount', '-a']);
    sh.exec(['swapon', '-a']);
  }
  const fw = st.services.firewalld;
  const fwWasActive = fw?.active;
  for (const s of Object.values(st.services)) s.active = into ? s.name === 'systemd-journald' : s.enabled;
  if (fw && fw.active !== fwWasActive) {
    // firewalld starts again from its permanent configuration
    st.firewall.services = [...st.firewall.permServices];
    st.firewall.ports = [...st.firewall.permPorts];
  }
  k.bootTarget = target;
  k.emergency = target === 'emergency.target';
  if (!into) k.bootErrors = [];
  logMessages(sh, [`systemd[1]: Reached target ${target} - ${TARGETS[target]}.`]);
  const root = st.users.find((u) => u.uid === 0)!;
  if (into) {
    sh.sessions = [{ user: root, cwd: root.home }];
    sh.env = {};
    const mode = target === 'rescue.target' ? 'rescue' : 'emergency';
    out += `You are in ${mode} mode. After logging in, type "journalctl -xb" to view\nsystem logs, "systemctl reboot" to reboot, or "exit"\nto continue bootup.\n`;
    out +=
      root.locked || !root.password
        ? 'Cannot open access to console, the root account is locked.\nSee sulogin(8) man page for more details.\n\nPress Enter to continue.\n(Practice server: a real server would be stuck here, because root has no usable password. This terminal gives you a root shell anyway.)\n'
        : 'Give root password for maintenance\n(or press Control-D to continue):\n';
    out += `(Practice server: ${target} stopped the other services and ended every login. You are root on the console. Type "systemctl default" or "exit" to go on to ${st.defaultTarget}.)\n`;
  } else if (maintenanceTarget(from)) {
    const student = st.users.find((u) => u.name === 'student') ?? root;
    sh.sessions = [{ user: student, cwd: student.home }];
    sh.env = {};
    out += `(Practice server: reached ${target}. The ${from === 'rescue.target' ? 'rescue' : 'emergency'} shell ended, and you are logged in as ${student.name} again.)\n`;
  }
  return ok(out);
}

/** Failed units: mount points from this boot's errors that are still not mounted. */
function failedUnits(sh: Shell): { unit: string; desc: string }[] {
  const st = sh.state;
  const out: { unit: string; desc: string }[] = [];
  for (const e of st.kernel.bootErrors) {
    const m = /^mount: (\/[^:]*):/.exec(e.trim());
    if (m && !st.storage.mounts.some((x) => x.target === m[1])) out.push({ unit: mountUnit(m[1]), desc: m[1] });
  }
  return out;
}

const systemctl: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['t', 'type', 'state']);
  const [verb, ...units] = operands;
  const quiet = flags.has('q') || flags.has('quiet');
  const svcName = (u: string) => u.replace(/\.service$/, '');
  const unit = (n: string) => (n.includes('.') ? n : `${n}.service`);
  const get = (u: string) => sh.state.services[svcName(u)];
  const changes = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'set-default', 'mask', 'unmask', 'daemon-reload'];
  if (changes.includes(verb ?? '') && sh.uid !== 0) {
    return fail(`Failed to ${verb} ${units[0] ?? ''}: Access denied\n(Hint: use sudo systemctl ${verb} ${units.join(' ')})`);
  }
  const targetVerbs: Record<string, string> = { rescue: 'rescue.target', emergency: 'emergency.target', default: 'default.target' };
  if ((verb === 'isolate' || targetVerbs[verb ?? '']) && sh.uid !== 0) {
    const t = verb === 'isolate' ? (units[0] ?? '') : targetVerbs[verb!];
    return fail(`Failed to start ${t.includes('.') || !t ? t : `${t}.target`}: Interactive authentication required.\nSee system logs and 'systemctl status ${t}' for details.\n(Hint: use sudo systemctl ${[verb, ...units].join(' ')})`);
  }
  if ((flags.has('failed') || values.state === 'failed') && (verb === undefined || verb === 'list-units')) {
    const rows = failedUnits(sh);
    const w = Math.max(4, ...rows.map((r) => r.unit.length));
    const body = rows.map((r) => `● ${r.unit.padEnd(w)} loaded failed failed ${r.desc}\n`).join('');
    return ok(`  ${'UNIT'.padEnd(w)} LOAD   ACTIVE SUB    DESCRIPTION\n${body}\nLOAD   = Reflects whether the unit definition was properly loaded.\nACTIVE = The high-level unit activation state, i.e. generalization of SUB.\nSUB    = The low-level unit activation state, values depend on unit type.\n\n${rows.length} loaded units listed.\n`);
  }
  switch (verb) {
    case undefined:
    case 'list-units': {
      if ((values.t ?? values.type) === 'target') {
        const names = [...Object.keys(TARGETS), ...Object.keys(OTHER_TARGETS)].filter((t) => targetActive(sh, t) || flags.has('all')).sort();
        const desc = (t: string) => TARGETS[t] ?? OTHER_TARGETS[t];
        const rows = names.map((t) => `  ${t.padEnd(30)} loaded ${targetActive(sh, t) ? 'active   active' : 'inactive dead  '} ${desc(t)}`);
        return ok(`  UNIT                           LOAD   ACTIVE   SUB    DESCRIPTION\n${rows.join('\n')}\n\n${rows.length} loaded units listed.\n`);
      }
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
    case 'isolate': {
      if (!units[0]) return fail('Too few arguments.');
      if (units.length > 1) return fail('Too many arguments.');
      return switchTarget(sh, units[0].includes('.') ? units[0] : `${units[0]}.target`, null);
    }
    case 'rescue':
    case 'emergency':
      return switchTarget(sh, targetVerbs[verb], verb);
    case 'default':
      return switchTarget(sh, 'default.target', null);
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
  const failed = failedUnits(sh).map((f) => f.unit);
  for (const u of units) {
    const s = get(u);
    // targets and mount units: is-active, is-failed and status know their state
    if (!s && (u.endsWith('.target') || u.endsWith('.mount')) && ['is-active', 'is-failed', 'is-enabled', 'status'].includes(verb)) {
      const isTarget = u.endsWith('.target');
      if (isTarget && !TARGETS[u] && !OTHER_TARGETS[u] && u !== 'default.target') {
        if (verb === 'status') err += `Unit ${u} could not be found.\n`;
        else out += verb === 'is-enabled' ? 'not-found\n' : 'inactive\n';
        code = verb === 'status' ? 4 : verb === 'is-active' ? 3 : 1;
        continue;
      }
      const state = failed.includes(u) ? 'failed' : isTarget ? (targetActive(sh, u) ? 'active' : 'inactive') : sh.state.storage.mounts.some((m) => mountUnit(m.target) === u) ? 'active' : 'inactive';
      if (verb === 'is-enabled') out += isTarget ? (u === sh.state.defaultTarget ? 'indirect\n' : 'static\n') : 'generated\n';
      else if (verb === 'is-active') {
        out += state + '\n';
        if (state !== 'active') code = 3;
      } else if (verb === 'is-failed') {
        out += state + '\n';
        if (state !== 'failed') code = 1;
      } else {
        const desc = isTarget ? TARGETS[u] ?? OTHER_TARGETS[u] ?? TARGETS[sh.state.defaultTarget] : mountPath(u);
        const dot = state === 'failed' ? '×' : state === 'active' ? '●' : '○';
        const loaded = isTarget ? `/usr/lib/systemd/system/${u}; static` : `/etc/fstab; generated`;
        out += `${dot} ${u} - ${desc}\n     Loaded: loaded (${loaded})\n     Active: ${state === 'active' ? 'active since Tue 2026-10-21 08:00:04 UTC' : state === 'failed' ? 'failed (Result: exit-code)' : 'inactive (dead)'}\n`;
        if (state !== 'active') code = 3;
      }
      continue;
    }
    if (!s) {
      if (verb === 'status') err += `Unit ${svcName(u)}.service could not be found.\n`;
      else if (verb === 'is-active' || verb === 'is-enabled' || verb === 'is-failed') out += verb === 'is-enabled' ? 'not-found\n' : 'inactive\n';
      else err += `Failed to ${verb} ${svcName(u)}.service: Unit ${svcName(u)}.service not found.\n`;
      code = verb === 'status' ? 4 : verb === 'is-active' ? 3 : 1;
      continue;
    }
    switch (verb) {
      case 'start':
      case 'restart':
      case 'reload':
        s.active = true;
        if (s.name === 'systemd-journald' && verb !== 'reload') journaldStart(sh.state);
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
      case 'is-failed':
        // the practice services never fail: is-failed is true only for a failed unit
        out += s.active ? 'active\n' : 'inactive\n';
        code = 1;
        break;
      case 'status':
        out += `${s.active ? '●' : '○'} ${unit(s.name)} - ${s.description}\n     Loaded: loaded (/usr/lib/systemd/system/${unit(s.name)}; ${s.enabled ? 'enabled' : 'disabled'}; preset: disabled)\n     Active: ${s.active ? 'active (running) since Tue 2026-10-21 08:00:04 UTC' : 'inactive (dead)'}\n`;
        if (!s.active) code = 3;
        break;
      default:
        return fail(`Unknown command verb '${verb}'.`);
    }
  }
  return { stdout: quiet && ['is-active', 'is-enabled', 'is-failed'].includes(verb) ? '' : out, stderr: err, code };
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
  sh.state.selinux === 'Disabled' ? ok('SELinux status:                 disabled\n') : ok(
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

export const COMMANDS: Record<string, Command> = {
  pwd, cd, ls, mkdir, rmdir, touch, cat, echo, cp, mv, rm, ln, readlink, stat, file,
  head: headTail(true), tail: headTail(false), wc, grep, egrep: grep, sort, uniq, cut, tee, ...TEXT_COMMANDS, ...FIND_COMMANDS,
  less: pager, more: pager, vim: editor, vi: editor, nano: editor,
  tar, gzip: compressCmd('.gz', false), gunzip: compressCmd('.gz', true), bzip2: compressCmd('.bz2', false), bunzip2: compressCmd('.bz2', true),
  whoami, id, groups: groupsCmd, useradd, usermod, userdel, groupadd, groupdel, groupmod, gpasswd, passwd, chage,
  chmod, chown, chgrp: chown, umask, sudo, su, visudo, exit, logout: exit,
  hostname, hostnamectl, uname, date, uptime, ping, df, free, lsblk,
  systemctl, dnf, yum: dnf, rpm, getenforce, setenforce, sestatus, 'firewall-cmd': firewallCmd,
  journalctl, crontab,
  history, clear, man, help,
  true: trueCmd, false: falseCmd,
  ...ADMIN_COMMANDS,
  ...STORAGE_COMMANDS,
  ...KERNEL_COMMANDS,
  ...SCRIPT_COMMANDS,
};

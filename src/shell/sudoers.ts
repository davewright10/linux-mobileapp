// The sudo policy: /etc/sudoers and the files it includes (#includedir /etc/sudoers.d). The practice
// sudo reads its rules, aliases and the secure_path default from these files, so a rule a student
// adds (anna ALL=(root) /usr/bin/systemctl) or a syntax error (which locks everyone out of sudo,
// as on a real server) takes effect the way it would on RHEL.

import { nodeAt } from './kernel-state';
import type { SystemState, User } from './state';

type AliasKind = 'User' | 'Runas' | 'Host' | 'Cmnd';

interface CmndSpec {
  runas: string[] | null; // null: only root
  runasGroups: string[] | null;
  tags: string[];
  cmd: string; // ALL, an alias name, or a full path with optional arguments
  negated: boolean;
}

interface UserSpec {
  who: string[];
  hosts: string[];
  cmnds: CmndSpec[];
}

interface DefaultsEntry {
  scope: string; // '' for all users, ':anna' or ':%group' for some
  settings: string[];
}

export interface Sudoers {
  specs: UserSpec[];
  defaults: DefaultsEntry[];
  aliases: Record<AliasKind, Map<string, string[]>>;
  files: string[];
  /** Messages that make sudo refuse to run (a missing /etc/sudoers or a syntax error). */
  errors: string[];
  /** Messages sudo prints and goes on (an included file it does not trust). */
  warnings: string[];
}

const TAGS = /^(NOPASSWD|PASSWD|NOEXEC|EXEC|SETENV|NOSETENV|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW|INTERCEPT|NOINTERCEPT)\s*:\s*/;
const ALIAS_NAME = /^[A-Z][A-Z0-9_]*$/;
const MAX_INCLUDE_DEPTH = 8;

/** Split on commas that are not inside parentheses or quotes. */
function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      cur += c + s[++i];
      continue;
    }
    if (c === '"') quote = !quote;
    else if (!quote && c === '(') depth++;
    else if (!quote && c === ')') depth--;
    if (c === sep && depth === 0 && !quote) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Drop a trailing comment: # starts one unless it is #include, #includedir or a #uid. */
function stripComment(line: string): string {
  return line.replace(/(^|\s)#(?![0-9]).*$/, '').trim();
}

function readSource(state: SystemState, path: string, sud: Sudoers, depth: number, required: boolean): void {
  const node = nodeAt(state.root, path);
  if (!node || node.type !== 'file') {
    if (required) sud.errors.push(`sudo: unable to stat ${path}: No such file or directory\nsudo: no valid sudoers sources found, quitting`);
    return;
  }
  if (node.mode & 0o002) {
    const msg = `sudo: ${path} is world writable`;
    if (required) sud.errors.push(`${msg}\nsudo: no valid sudoers sources found, quitting`);
    else sud.warnings.push(msg);
    return;
  }
  if (node.uid !== 0) {
    const msg = `sudo: ${path} is owned by uid ${node.uid}, should be 0`;
    if (required) sud.errors.push(`${msg}\nsudo: no valid sudoers sources found, quitting`);
    else sud.warnings.push(msg);
    return;
  }
  sud.files.push(path);
  parseText(state, node.content ?? '', path, sud, depth);
}

/** sudo reads the files in an #includedir in sorted order and skips names with a dot or ending in ~. */
function readDir(state: SystemState, dir: string, sud: Sudoers, depth: number): void {
  const node = nodeAt(state.root, dir);
  if (!node || node.type !== 'dir') return;
  for (const name of Object.keys(node.children ?? {}).sort()) {
    if (name.includes('.') || name.endsWith('~')) continue;
    const child = node.children![name];
    if (child.type !== 'file') continue;
    readSource(state, `${dir.replace(/\/$/, '')}/${name}`, sud, depth + 1, false);
  }
}

function parseText(state: SystemState, text: string, file: string, sud: Sudoers, depth: number): void {
  const raw = text.split('\n');
  const syntax = (n: number) => {
    sud.errors.push(`>>> ${file}: syntax error near line ${n} <<<\nsudo: parse error in ${file} near line ${n}\nsudo: no valid sudoers sources found, quitting`);
  };
  for (let i = 0; i < raw.length; i++) {
    const start = i + 1;
    let line = raw[i];
    while (line.endsWith('\\') && i + 1 < raw.length) line = line.slice(0, -1) + ' ' + raw[++i];
    const trimmed = line.trim();
    const inc = /^[#@](include|includedir)\s+(\S+)\s*$/.exec(trimmed);
    if (inc) {
      if (depth >= MAX_INCLUDE_DEPTH) continue;
      const target = inc[2].startsWith('/') ? inc[2] : `${file.replace(/\/[^/]*$/, '')}/${inc[2]}`;
      if (inc[1] === 'include') readSource(state, target, sud, depth + 1, false);
      else readDir(state, target, sud, depth);
      continue;
    }
    const l = stripComment(trimmed);
    if (!l) continue;
    if (sud.errors.length) return;
    const def = /^Defaults([:@>!]\S+)?(?:\s+(.*))?$/.exec(l);
    if (def) {
      if (!def[2]) {
        syntax(start);
        return;
      }
      sud.defaults.push({ scope: def[1] ?? '', settings: splitTop(def[2]).filter(Boolean) });
      continue;
    }
    const alias = /^(User|Runas|Host|Cmnd|Cmd)_Alias\s+(.*)$/.exec(l);
    if (alias) {
      const kind = (alias[1] === 'Cmd' ? 'Cmnd' : alias[1]) as AliasKind;
      for (const d of splitTop(alias[2], ':')) {
        const m = /^(\S+)\s*=\s*(.+)$/.exec(d);
        if (!m || !ALIAS_NAME.test(m[1])) {
          syntax(start);
          return;
        }
        sud.aliases[kind].set(m[1], splitTop(m[2]).filter(Boolean));
      }
      continue;
    }
    const spec = parseUserSpec(l);
    if (!spec) {
      syntax(start);
      return;
    }
    sud.specs.push(spec);
  }
}

/** who host = (runas) TAGS: command, command ... */
function parseUserSpec(line: string): UserSpec | null {
  const norm = line.replace(/\s*,\s*/g, ',');
  const m = /^(\S+)\s+([^\s=]+)\s*=\s*(.+)$/.exec(norm);
  if (!m) return null;
  const cmnds: CmndSpec[] = [];
  let runas: string[] | null = null;
  let runasGroups: string[] | null = null;
  let tags: string[] = [];
  // a second "host = commands" part after a colon is rare; only the first one is used
  const body = splitTop(m[3], ':').filter((p, i) => i === 0 || !/^\S+\s*=/.test(p)).join(':');
  for (let item of splitTop(body)) {
    const ra = /^\(([^)]*)\)\s*/.exec(item);
    if (ra) {
      const [u, g] = ra[1].split(':').map((s) => s.trim());
      runas = u ? u.split(',').map((s) => s.trim()).filter(Boolean) : g ? [] : null;
      runasGroups = g ? g.split(',').map((s) => s.trim()).filter(Boolean) : null;
      tags = [];
      item = item.slice(ra[0].length);
    }
    let t: RegExpExecArray | null;
    while ((t = TAGS.exec(item))) {
      const tag = t[1];
      tags = [...tags.filter((x) => x.replace(/^NO/, '') !== tag.replace(/^NO/, '')), tag];
      item = item.slice(t[0].length);
    }
    let negated = false;
    while (item.startsWith('!')) {
      negated = !negated;
      item = item.slice(1).trim();
    }
    if (!item) return null;
    const cmd = item.trim();
    if (cmd !== 'ALL' && !ALIAS_NAME.test(cmd) && !cmd.startsWith('/') && !/^sudoedit(\s|$)/.test(cmd)) return null;
    cmnds.push({ runas, runasGroups, tags: [...tags], cmd, negated });
  }
  if (!cmnds.length) return null;
  return { who: m[1].split(',').filter(Boolean), hosts: m[2].split(','), cmnds };
}

const emptySudoers = (): Sudoers => ({
  specs: [],
  defaults: [],
  aliases: { User: new Map(), Runas: new Map(), Host: new Map(), Cmnd: new Map() },
  files: [],
  errors: [],
  warnings: [],
});

/** Read the policy as sudo would at this moment. */
export function readSudoers(state: SystemState): Sudoers {
  const sud = emptySudoers();
  readSource(state, '/etc/sudoers', sud, 0, true);
  return sud;
}

/** visudo -c -f FILE: check one file's syntax before it is installed. */
export function checkSudoersText(state: SystemState, text: string, file: string): Sudoers {
  const sud = emptySudoers();
  sud.files.push(file);
  parseText(state, text, file, sud, 0);
  return sud;
}

// ---------- matching ----------

function groupsOf(state: SystemState, user: User): string[] {
  return state.groups.filter((g) => g.gid === user.gid || g.members.includes(user.name)).map((g) => g.name);
}

/** Does a user list (with %group, #uid, ALL, aliases and !negation) match? null: no item matched. */
function listMatch(items: string[], one: (item: string) => boolean | null, aliases: Map<string, string[]>, seen = new Set<string>()): boolean | null {
  let result: boolean | null = null;
  for (const raw of items) {
    let item = raw.trim();
    let neg = false;
    while (item.startsWith('!')) {
      neg = !neg;
      item = item.slice(1).trim();
    }
    let hit: boolean | null;
    if (item === 'ALL') hit = true;
    else if (ALIAS_NAME.test(item) && aliases.has(item) && !seen.has(item)) {
      seen.add(item);
      hit = listMatch(aliases.get(item)!, one, aliases, seen);
      seen.delete(item);
    } else hit = one(item);
    if (hit) result = !neg;
  }
  return result;
}

function userMatcher(state: SystemState, user: User) {
  const groups = groupsOf(state, user);
  return (item: string): boolean => {
    if (item.startsWith('%#')) return state.groups.some((g) => String(g.gid) === item.slice(2) && groups.includes(g.name));
    if (item.startsWith('%')) return groups.includes(item.slice(1));
    if (item.startsWith('#')) return String(user.uid) === item.slice(1);
    return item === user.name;
  };
}

function hostMatches(hosts: string[], aliases: Map<string, string[]>, hostname: string): boolean {
  const short = hostname.split('.')[0];
  return listMatch(hosts, (h) => h === hostname || h === short || h === 'localhost', aliases) === true;
}

const STD_BIN = ['/bin', '/sbin', '/usr/bin', '/usr/sbin'];
// on RHEL /bin and /sbin are links to /usr/bin and /usr/sbin
const usrMerge = (p: string) => p.replace(/^\/bin\//, '/usr/bin/').replace(/^\/sbin\//, '/usr/sbin/');
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function globRe(glob: string, slash: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '*') re += slash ? '[^/]*' : '.*';
    else if (c === '?') re += slash ? '[^/]' : '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export interface SudoCommand {
  path: string; // full path, e.g. /usr/bin/systemctl or /usr/local/bin/svccheck
  args: string[];
  /** a practice command: it has no file of its own and counts as being in every standard bin directory */
  practice: boolean;
}

function cmdMatches(spec: string, cmd: SudoCommand): boolean {
  if (spec === 'ALL') return true;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(spec.trim());
  if (!m) return false;
  const [, sp, sargs] = m;
  if (/^sudoedit$/.test(sp)) return false;
  const path = usrMerge(cmd.path);
  const want = usrMerge(sp);
  let pathOk: boolean;
  if (want.endsWith('/')) {
    pathOk = dirOf(path) + '/' === want || (cmd.practice && STD_BIN.map(usrMerge).includes(want.slice(0, -1)));
  } else if (/[*?[]/.test(want)) {
    pathOk = globRe(want, true).test(path) || (cmd.practice && STD_BIN.some((d) => globRe(want, true).test(`${usrMerge(d + '/')}${baseOf(path)}`)));
  } else {
    pathOk = path === want || (cmd.practice && baseOf(want) === baseOf(path) && STD_BIN.includes(dirOf(sp)));
  }
  if (!pathOk) return false;
  if (sargs === undefined) return true;
  if (sargs.trim() === '""') return cmd.args.length === 0;
  return globRe(sargs.trim().replace(/\s+/g, ' '), false).test(cmd.args.join(' '));
}

function cmdListMatch(sud: Sudoers, spec: string, cmd: SudoCommand, seen = new Set<string>()): boolean {
  if (ALIAS_NAME.test(spec) && spec !== 'ALL') {
    const items = sud.aliases.Cmnd.get(spec);
    if (!items || seen.has(spec)) return false;
    seen.add(spec);
    let r: boolean | null = null;
    for (const raw of items) {
      let it = raw.trim();
      let neg = false;
      while (it.startsWith('!')) {
        neg = !neg;
        it = it.slice(1).trim();
      }
      if (cmdListMatch(sud, it, cmd, seen)) r = !neg;
    }
    seen.delete(spec);
    return r === true;
  }
  return cmdMatches(spec, cmd);
}

function runasMatches(state: SystemState, sud: Sudoers, c: CmndSpec, invoker: User, target: User): boolean {
  if (c.runas === null) return target.uid === 0;
  if (!c.runas.length) return target.uid === invoker.uid; // (:group) only: the user stays the same
  return listMatch(c.runas, userMatcher(state, target), sud.aliases.Runas) === true;
}

/** The specs that name this user, on this host. */
function specsFor(state: SystemState, sud: Sudoers, user: User, hostname: string): UserSpec[] {
  const isUser = userMatcher(state, user);
  return sud.specs.filter((s) => listMatch(s.who, isUser, sud.aliases.User) === true && hostMatches(s.hosts, sud.aliases.Host, hostname));
}

export type SudoVerdict = 'allowed' | 'denied' | 'not-in-sudoers';

/** May `user` run `cmd` as `target`? The last matching rule wins, as in sudo. */
export function sudoCheck(state: SystemState, sud: Sudoers, user: User, target: User, cmd: SudoCommand, hostname: string): SudoVerdict {
  const specs = specsFor(state, sud, user, hostname);
  if (!specs.length) return 'not-in-sudoers';
  let verdict: boolean | null = null;
  for (const s of specs) {
    for (const c of s.cmnds) {
      if (!runasMatches(state, sud, c, user, target)) continue;
      if (cmdListMatch(sud, c.cmd, cmd)) verdict = !c.negated;
    }
  }
  return verdict ? 'allowed' : 'denied';
}

/** Defaults that apply to this user, in file order: "secure_path=/sbin\:/bin..." */
function defaultsFor(state: SystemState, sud: Sudoers, user: User): string[] {
  const isUser = userMatcher(state, user);
  const out: string[] = [];
  for (const d of sud.defaults) {
    if (d.scope.startsWith(':') && listMatch(d.scope.slice(1).split(','), isUser, sud.aliases.User) !== true) continue;
    if (d.scope && !d.scope.startsWith(':')) continue; // host, runas and command scoped Defaults are not used here
    out.push(...d.settings);
  }
  return out;
}

/** The secure_path sudo uses for this user, or null when none is set (sudo then keeps the caller's PATH). */
export function securePath(state: SystemState, sud: Sudoers, user: User): string | null {
  let path: string | null = null;
  for (const s of defaultsFor(state, sud, user)) {
    const m = /^(!?)\s*secure_path\s*(?:=\s*(.*))?$/.exec(s);
    if (!m) continue;
    path = m[1] || m[2] === undefined ? null : m[2].trim().replace(/^"(.*)"$/, '$1').replace(/\\:/g, ':');
  }
  return path;
}

const fmtRunas = (c: CmndSpec) => {
  const u = c.runas === null ? 'root' : c.runas.join(', ');
  return c.runasGroups ? `(${u} : ${c.runasGroups.join(', ')})` : `(${u})`;
};

/** sudo -l: what this user may run. null when there is nothing. */
export function sudoList(state: SystemState, sud: Sudoers, user: User, hostname: string): { defaults: string; rules: string[] } | null {
  const specs = specsFor(state, sud, user, hostname);
  if (!specs.length) return null;
  const defaults = defaultsFor(state, sud, user)
    .map((s) => {
      const m = /^(!?)\s*(\w+)\s*(\+=|-=|=)?\s*(.*)$/.exec(s);
      if (!m) return s;
      const value = m[2] === 'secure_path' ? m[4].replace(/(?<!\\):/g, '\\:') : m[4];
      return `${m[1]}${m[2]}${m[3] ? m[3] + value : ''}`;
    })
    .join(', ');
  const rules = specs.map((s) => {
    let line = '';
    let prev = '';
    for (const c of s.cmnds) {
      const head = `${fmtRunas(c)} ${c.tags.map((t) => `${t}: `).join('')}`;
      const item = `${c.negated ? '!' : ''}${c.cmd}`;
      line += head === prev ? `, ${item}` : `${line ? ', ' : ''}${head}${item}`;
      prev = head;
    }
    return line;
  });
  return { defaults, rules };
}

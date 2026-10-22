// The systemd journal of the practice server and journalctl. The entries come from what rsyslog
// writes out of the journal (/var/log/messages and /var/log/secure) and, for -k, from the kernel
// ring buffer. A boot starts at the kernel's "Linux version" line. Each message gets a priority
// guessed from its text, so -p err finds the errors a reboot logs (a broken /etc/fstab line, a
// module that cannot load). As on RHEL, the journal is volatile until /var/log/journal exists:
// only the current boot can be read, and -b -1 needs a persistent journal.

import type { CommandContext, CommandResult } from './commands';
import { makeDir } from './fs';
import { machineId, nodeAt, textAt } from './kernel-state';
import type { Shell } from './shell';
import type { SystemState } from './state';

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1): CommandResult => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code });

export const LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n: number) => String(n).padStart(2, '0');
const hms = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const syslogDate = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${p2(d.getDate())} ${hms(d)}`;
};
const fullDate = (ms: number) => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms(d)} EDT`;
};
const isoDate = (ms: number) => {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${hms(d)}${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
};

interface Entry {
  time: number;
  host: string;
  ident: string; // SYSLOG_IDENTIFIER, e.g. sshd or kernel
  pid: string | null;
  msg: string;
  prio: number; // 0 emerg .. 7 debug
  boot: number; // the boot it belongs to, counted like state.kernel.boots
}

// ---------- priorities ----------

/** Guess the priority of a message from its text, the way the program would have logged it. */
export function linePriority(ident: string, msg: string): number {
  if (/Kernel panic/i.test(msg)) return 0;
  if (/<error>/.test(msg)) return 3;
  if (/<warn>/.test(msg)) return 4;
  if (/<info>/.test(msg)) return 6;
  if (/, ignoring\b|\bwarning\b|\bdeprecated\b|^Dependency failed for |is deny-listed/i.test(msg)) return /is deny-listed/.test(msg) ? 6 : 4;
  if (/^Failed password|^Invalid user|^Accepted /.test(msg)) return 6; // sshd logs login attempts as info
  if (ident === 'systemd' && /^(mount|swapon|mkswap|fsck|umount)\b/.test(msg)) return 3;
  if (
    /\berror\b|SELinux is preventing|^Failed to |\bfailed\b|\bcan't\b|\bcannot\b|\bunable to\b|Permission denied|does not exist|not found|[Tt]imed out|wrong fs type|bad superblock|unknown filesystem/i.test(msg)
  ) {
    return 3;
  }
  if (ident === 'kernel' && /^(Linux version|Kernel command line|XFS \(.*\): Mounting|SGI XFS)/.test(msg)) return 5;
  if (ident === 'systemd' && /^Reached target (rescue|emergency)\.target/.test(msg)) return 5;
  return 6;
}

// ---------- persistence ----------

const JOURNAL_DIR = '/var/log/journal';

/** Storage= from journald.conf and its drop-ins (RHEL 10 ships no /etc/systemd/journald.conf). */
export function journalStorage(state: SystemState): string {
  const files: string[] = ['/usr/lib/systemd/journald.conf', '/etc/systemd/journald.conf'];
  const dropins = new Map<string, string>();
  for (const dir of ['/usr/lib/systemd/journald.conf.d', '/run/systemd/journald.conf.d', '/etc/systemd/journald.conf.d']) {
    const node = nodeAt(state.root, dir);
    if (node?.type !== 'dir') continue;
    for (const name of Object.keys(node.children ?? {})) if (name.endsWith('.conf')) dropins.set(name, `${dir}/${name}`);
  }
  files.push(...[...dropins.keys()].sort().map((n) => dropins.get(n)!));
  let mode = 'auto';
  for (const f of files) {
    const text = textAt(state.root, f);
    if (text === null) continue;
    let section = '';
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (/^\[.*\]$/.test(line)) section = line;
      const m = /^Storage\s*=\s*(\S+)/.exec(line);
      if (m && section === '[Journal]' && ['auto', 'persistent', 'volatile', 'none'].includes(m[1])) mode = m[1];
    }
  }
  return mode;
}

/**
 * systemd-journald starts (at boot, systemctl restart systemd-journald) or flushes (journalctl
 * --flush): with Storage=persistent, or Storage=auto and /var/log/journal present, the journal of
 * this boot goes to disk and later boots can still read it.
 */
export function journaldStart(state: SystemState): void {
  const mode = journalStorage(state);
  let dir = nodeAt(state.root, JOURNAL_DIR);
  if (mode === 'persistent' && !dir) {
    const log = nodeAt(state.root, '/var/log');
    if (log?.type === 'dir') dir = log.children!.journal = makeDir(0, 0, 0o2755);
  }
  if (dir?.type === 'dir' && (mode === 'persistent' || mode === 'auto')) {
    state.journalPersistFrom ??= state.kernel.boots;
    const id = machineId(state.root);
    if (!dir.children![id]) dir.children![id] = makeDir(0, 0, 0o2755);
  } else if (mode === 'volatile' || mode === 'none') state.journalPersistFrom = undefined;
}

const persistent = (state: SystemState) => state.journalPersistFrom !== undefined && nodeAt(state.root, JOURNAL_DIR)?.type === 'dir';

/** The 128-bit boot ID of a boot, the same every time it is asked for. */
export function bootId(state: SystemState, boot: number): string {
  let out = '';
  let h = 0x811c9dc5;
  const seed = `${machineId(state.root)}:${boot}`;
  for (let round = 0; out.length < 32; round++) {
    for (const ch of `${seed}:${round}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 32);
}

// ---------- reading the journal ----------

const LINE = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d) (\S+) ([^\s:[]+)(?:\[(\d+)\])?: ?(.*)$/;

function parseLines(text: string, now: number): Omit<Entry, 'boot'>[] {
  const out: Omit<Entry, 'boot'>[] = [];
  let last = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = LINE.exec(line);
    if (!m) {
      out.push({ time: last, host: '', ident: '', pid: null, msg: line, prio: 6 });
      continue;
    }
    const year = new Date(now).getFullYear();
    const d = new Date(year, Math.max(0, MONTHS.indexOf(m[1])), +m[2], +m[3], +m[4], +m[5]);
    if (d.getTime() > now + 86400000) d.setFullYear(year - 1); // syslog lines have no year
    last = d.getTime();
    out.push({ time: last, host: m[6], ident: m[7], pid: m[8] ?? null, msg: m[9], prio: linePriority(m[7], m[9]) });
  }
  return out;
}

/** Every entry the journal holds, oldest first, with the boot each belongs to. */
function readJournal(state: SystemState): Entry[] {
  const now = Date.now();
  const k = state.kernel;
  const messages = parseLines(textAt(state.root, '/var/log/messages') ?? '', now);
  const secure = parseLines(textAt(state.root, '/var/log/secure') ?? '', now);
  const starts = messages.map((e, i) => (e.ident === 'kernel' && /^Linux version /.test(e.msg) ? i : -1)).filter((i) => i >= 0);
  const segments = starts[0] === 0 ? starts.length : starts.length + 1;
  const first = k.boots - (segments - 1);
  const entries: Entry[] = [];
  let boot = starts[0] === 0 ? first - 1 : first;
  const bootStart: { boot: number; time: number }[] = [];
  messages.forEach((e, i) => {
    if (starts.includes(i)) {
      boot++;
      bootStart.push({ boot, time: e.time });
    }
    entries.push({ ...e, boot });
  });
  for (const e of secure) {
    const b = [...bootStart].reverse().find((s) => s.time <= e.time)?.boot ?? first;
    entries.push({ ...e, boot: b });
  }
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.boot - b.e.boot || a.e.time - b.e.time || a.i - b.i)
    .map((x) => x.e);
}

/** The kernel ring buffer of the current boot, as journal entries (journalctl -k). */
function kernelEntries(sh: Shell): Entry[] {
  const k = sh.state.kernel;
  const prio = { err: 3, warn: 4, notice: 5, info: 6 } as const;
  return k.dmesg.map((l) => ({ time: k.bootTime + Math.round(l.t * 1000), host: sh.shortHost, ident: 'kernel', pid: null, msg: l.msg, prio: prio[l.level], boot: k.boots }));
}

// ---------- the catalog (-x) ----------

/** systemd's name for the unit of a mount point: /data -> data.mount, /var/www -> var-www.mount. */
export function mountUnit(path: string): string {
  const p = path.replace(/^\/+|\/+$/g, '');
  if (!p) return '-.mount';
  const esc = p
    .split('/')
    .map((part) => part.replace(/[^A-Za-z0-9:_.]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))
    .join('-');
  return `${esc}.mount`;
}

function catalog(e: Entry, job: number): string[] | null {
  if (e.ident !== 'systemd') return null;
  let unit: string | null = null;
  let kind: 'begin' | 'done' | 'failed' | 'dependency' | 'stop' = 'done';
  let m: RegExpExecArray | null;
  if ((m = /^Dependency failed for (\S+)/.exec(e.msg))) [unit, kind] = [m[1], 'dependency'];
  else if ((m = /^(?:mount|umount): (\/[^:]*):/.exec(e.msg))) [unit, kind] = [mountUnit(m[1]), 'failed'];
  else if ((m = /^swapon: (\/[^:]*):/.exec(e.msg))) [unit, kind] = [`${mountUnit(m[1]).replace(/\.mount$/, '')}.swap`, 'failed'];
  else if ((m = /^Failed to start (\S+)/.exec(e.msg))) [unit, kind] = [m[1], 'failed'];
  else if ((m = /^(?:Reached target|Started|Finished|Mounted) (\S+\.\w+)\b/.exec(e.msg))) [unit, kind] = [m[1], 'done'];
  else if ((m = /^Starting (\S+\.\w+)\b/.exec(e.msg))) [unit, kind] = [m[1], 'begin'];
  else if ((m = /^Stopped (\S+\.\w+)\b/.exec(e.msg))) [unit, kind] = [m[1], 'stop'];
  if (!unit) return null;
  unit = unit.replace(/\.$/, '');
  const subject = {
    begin: `A start job for unit ${unit} has begun execution`,
    done: `A start job for unit ${unit} has finished successfully`,
    failed: `A start job for unit ${unit} has failed`,
    dependency: `A start job for unit ${unit} has failed`,
    stop: `A stop job for unit ${unit} has finished`,
  }[kind];
  const body = {
    begin: `A start job for unit ${unit} has begun execution.`,
    done: `A start job for unit ${unit} has finished successfully.`,
    failed: `A start job for unit ${unit} has finished with a failure.`,
    dependency: `A start job for unit ${unit} has finished with a failure.`,
    stop: `A stop job for unit ${unit} has finished.`,
  }[kind];
  const result = kind === 'failed' ? ' and the job result is failed' : kind === 'dependency' ? ' and the job result is dependency' : kind === 'stop' ? ' and the job result is done' : '';
  return [`Subject: ${subject}`, 'Defined-By: systemd', 'Support: https://access.redhat.com/support', '', body, '', `The job identifier is ${job}${result}.`].map((l) => `░░ ${l}`);
}

// ---------- time stamps for --since and --until ----------

const SPAN_UNITS: [RegExp, number][] = [
  [/^(us|usec)$/, 0.001],
  [/^(ms|msec)$/, 1],
  [/^(s|sec|secs|second|seconds)$/, 1000],
  [/^(m|min|mins|minute|minutes)$/, 60000],
  [/^(h|hr|hrs|hour|hours)$/, 3600000],
  [/^(d|day|days)$/, 86400000],
  [/^(w|week|weeks)$/, 604800000],
  [/^(M|month|months)$/, 2629800000],
  [/^(y|year|years)$/, 31557600000],
];

function parseSpan(s: string): number | null {
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*([A-Za-z]*)/gy;
  const t = s.trim();
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < t.length) {
    re.lastIndex = pos;
    m = re.exec(t);
    if (!m) return null;
    const unit = m[2] || 's';
    const f = SPAN_UNITS.find(([r]) => r.test(unit));
    if (!f) return null;
    total += parseFloat(m[1]) * f[1];
    pos = re.lastIndex;
    while (t[pos] === ' ') pos++;
  }
  return pos ? total : null;
}

/** systemd.time(7) time stamps: 2026-10-21 08:00, 08:00, today, yesterday, -1h, "2 hours ago", @1700000000. */
export function parseTimestamp(s: string, now = Date.now()): number | null {
  const t = s.trim();
  const day = (offset: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d.getTime();
  };
  if (t === 'now') return now;
  if (t === 'today') return day(0);
  if (t === 'yesterday') return day(-1);
  if (t === 'tomorrow') return day(1);
  if (/^@\d+(\.\d+)?$/.test(t)) return parseFloat(t.slice(1)) * 1000;
  if (/^[+-]/.test(t)) {
    const span = parseSpan(t.slice(1));
    return span === null ? null : now + (t[0] === '-' ? -span : span);
  }
  const ago = /^(.*\S)\s+ago$/.exec(t);
  if (ago) {
    const span = parseSpan(ago[1]);
    return span === null ? null : now - span;
  }
  const left = /^(.*\S)\s+left$/.exec(t);
  if (left) {
    const span = parseSpan(left[1]);
    return span === null ? null : now + span;
  }
  const m = /^(?:(\d{4})-(\d{1,2})-(\d{1,2}))?(?:[ T]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (!m || (!m[1] && !m[4])) return null;
  const base = new Date(now);
  const d = m[1] ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(base.getFullYear(), base.getMonth(), base.getDate());
  if (m[4]) d.setHours(+m[4], +m[5], m[6] ? +m[6] : 0, 0);
  if (Number.isNaN(d.getTime()) || +(m[2] ?? 1) > 12 || +(m[4] ?? 0) > 23) return null;
  return d.getTime();
}

// ---------- journalctl ----------

function parseLevel(s: string): number | null {
  if (/^[0-7]$/.test(s)) return +s;
  const i = LEVELS.indexOf(s);
  return i >= 0 ? i : null;
}

const OUTPUTS = ['short', 'short-full', 'short-iso', 'short-precise', 'cat'];
const KNOWN_OUTPUTS = [...OUTPUTS, 'short-iso-precise', 'short-monotonic', 'short-unix', 'short-delta', 'verbose', 'export', 'json', 'json-pretty', 'json-sse', 'json-seq', 'with-unit'];
const BOOT_ARG = /^([-+]?\d+|[0-9a-f]{32}([-+]\d+)?|all)$/;

const READERS = ['wheel', 'adm', 'systemd-journal'];

function canReadAll(sh: Shell): boolean {
  if (sh.uid === 0) return true;
  return sh.state.groups.some((g) => READERS.includes(g.name) && (g.members.includes(sh.user.name) || g.gid === sh.user.gid));
}

function unitMatches(e: Entry, unit: string): boolean {
  const full = unit.includes('.') ? unit : `${unit}.service`;
  const base = full.replace(/\.service$/, '');
  if (full.endsWith('.mount') || full.endsWith('.swap')) {
    const m = /^(?:mount|umount|swapon): (\/[^:]*):/.exec(e.msg);
    if (e.ident === 'systemd' && m && (mountUnit(m[1]) === full || `${mountUnit(m[1]).replace(/\.mount$/, '')}.swap` === full)) return true;
  }
  if (full.endsWith('.service') && (e.ident === base || e.ident === `${base}-session`)) return true;
  if (e.ident === 'systemd') return e.msg.includes(`${full} `) || e.msg.endsWith(full) || e.msg.includes(`${full}.`) || e.msg.includes(`${full}:`);
  return false;
}

const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

export const journalctl: Command = ({ sh, args: argList }) => {
  const st = sh.state;
  const args = [...argList];
  const units: string[] = [];
  const idents: string[] = [];
  const matches: ((e: Entry) => boolean)[] = [];
  let prio: [number, number] | null = null;
  let boot: string | null = null;
  let lines: number | null = null;
  let since: number | null = null;
  let until: number | null = null;
  let grep: RegExp | null = null;
  let output = 'short';
  let follow = false;
  let reverse = false;
  let catalogOn = false;
  let pagerEnd = false;
  let kernel = false;
  let quiet = false;
  let noHost = false;
  let action: string | null = null;
  const usage = (msg: string) => fail(`journalctl: ${msg}`);
  const now = Date.now();
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let inline: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        inline = a.slice(eq + 1);
        a = a.slice(0, eq);
      }
    } else if (/^-[a-zA-Z]./.test(a)) {
      // grouped short options: -xb, -xe, -n20, -b-1, -perr, -fu sshd
      const c = a[1];
      if ('uptgSUonbFMD'.includes(c)) {
        inline = a.slice(2);
        a = `-${c}`;
      } else {
        args.splice(i, 1, `-${c}`, `-${a.slice(2)}`);
        a = `-${c}`;
      }
    }
    const value = (): string | null => {
      if (inline !== undefined) return inline;
      if (i + 1 >= args.length) return null;
      return args[++i];
    };
    const optional = (ok: RegExp): string | null => {
      if (inline !== undefined) return inline;
      if (i + 1 < args.length && ok.test(args[i + 1])) return args[++i];
      return null;
    };
    const need = () => {
      const v = value();
      if (v === null) throw new Error(a.startsWith('--') ? `option '${a}' requires an argument` : `option requires an argument -- '${a[1]}'`);
      return v;
    };
    try {
      switch (a) {
        case '-u':
        case '--unit':
          units.push(need());
          break;
        case '-t':
        case '--identifier':
          idents.push(need());
          break;
        case '-p':
        case '--priority': {
          const v = need();
          const [from, to] = v.includes('..') ? v.split('..') : ['0', v];
          const lo = from === '' ? 0 : parseLevel(from);
          const hi = to === '' ? 7 : parseLevel(to);
          if (lo === null || hi === null) return usage(`Unknown log level ${lo === null ? from : to}`);
          prio = [Math.min(lo, hi), Math.max(lo, hi)];
          break;
        }
        case '-b':
        case '--boot': {
          const v = optional(BOOT_ARG);
          if (v !== null && !BOOT_ARG.test(v)) return usage(`Failed to parse boot descriptor '${v}'`);
          boot = v ?? '0';
          break;
        }
        case '-n':
        case '--lines': {
          const v = optional(/^(\+?\d+|all)$/);
          if (v !== null && !/^(\+?\d+|all)$/.test(v)) return usage(`Failed to parse lines '${v}'`);
          lines = v === null ? 10 : v === 'all' ? Infinity : parseInt(v.replace('+', ''), 10);
          break;
        }
        case '-S':
        case '--since':
        case '-U':
        case '--until': {
          const v = need();
          const t = parseTimestamp(v, now);
          if (t === null) return usage(`Failed to parse timestamp: ${v}`);
          if (a === '-S' || a === '--since') since = t;
          else until = t;
          break;
        }
        case '-g':
        case '--grep': {
          const v = need();
          try {
            grep = new RegExp(v, /[A-Z]/.test(v) ? '' : 'i');
          } catch {
            return usage(`Bad pattern "${v}"`);
          }
          break;
        }
        case '-o':
        case '--output': {
          const v = need();
          if (!KNOWN_OUTPUTS.includes(v)) return usage(`Unknown output format '${v}'.`);
          if (!OUTPUTS.includes(v)) return usage(`the practice terminal shows -o ${OUTPUTS.join(', -o ')}, not -o ${v}.`);
          output = v;
          break;
        }
        case '-f':
        case '--follow':
          follow = true;
          break;
        case '-r':
        case '--reverse':
          reverse = true;
          break;
        case '-x':
        case '--catalog':
          catalogOn = true;
          break;
        case '-e':
        case '--pager-end':
          pagerEnd = true;
          break;
        case '-k':
        case '--dmesg':
          kernel = true;
          break;
        case '-q':
        case '--quiet':
          quiet = true;
          break;
        case '--no-hostname':
          noHost = true;
          break;
        case '-a':
        case '--all':
        case '-l':
        case '--full':
        case '-m':
        case '--merge':
        case '--no-pager':
        case '--no-full':
        case '--utc':
        case '--system':
          break;
        case '-h':
        case '--help':
          return ok('journalctl [OPTIONS...] [MATCHES...]\n\nQuery the journal.\n\n  -b --boot[=ID]      Show current boot or the specified boot\n  -u --unit=UNIT      Show logs from the specified unit\n  -p --priority=RANGE Show entries with the specified priority\n  -S --since=DATE     Show entries not older than the specified date\n  -U --until=DATE     Show entries not newer than the specified date\n  -g --grep=PATTERN   Show entries with MESSAGE matching PATTERN\n  -k --dmesg          Show kernel message log from the current boot\n  -n --lines[=INTEGER] Number of journal entries to show\n  -r --reverse        Show the newest entries first\n  -f --follow         Follow the journal\n  -e --pager-end      Immediately jump to the end in the pager\n  -x --catalog        Add message explanations where available\n  -o --output=STRING  Change journal output mode (short, short-iso, cat, ...)\n     --list-boots     Show terse information about recorded boots\n     --disk-usage     Show total disk usage of all journal files\n     --flush          Flush all journal data from /run into /var\n');
        case '--user':
          action = 'user';
          break;
        case '--version':
          return ok('systemd 257 (257-9.el10)\n');
        case '--list-boots':
        case '--disk-usage':
        case '--flush':
        case '--rotate':
        case '--sync':
        case '--vacuum-size':
        case '--vacuum-time':
        case '--vacuum-files':
          if (a.startsWith('--vacuum') && inline === undefined) need();
          action = a;
          break;
        default:
          if (a.startsWith('--')) return usage(`unrecognized option '${a}'`);
          if (a.startsWith('-') && a.length > 1) return usage(`invalid option -- '${a[1]}'`);
          if (a === '+') break;
          {
            const fm = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(a);
            if (fm) {
              const [, field, v] = fm;
              if (field === '_SYSTEMD_UNIT' || field === 'UNIT') matches.push((e) => unitMatches(e, v));
              else if (field === '_COMM' || field === 'SYSLOG_IDENTIFIER') matches.push((e) => e.ident === v);
              else if (field === '_PID' || field === 'SYSLOG_PID') matches.push((e) => e.pid === v);
              else if (field === 'PRIORITY') matches.push((e) => String(e.prio) === v);
              else if (field === '_HOSTNAME') matches.push((e) => e.host === v || e.host === v.split('.')[0]);
              else if (field === '_BOOT_ID') matches.push((e) => bootId(st, e.boot) === v);
              else matches.push(() => false);
            } else if (a.startsWith('/')) {
              const base = a.split('/').pop()!;
              matches.push((e) => e.ident === base);
            } else return usage(`Failed to add match '${a}': Invalid argument`);
          }
      }
    } catch (e) {
      return usage((e as Error).message);
    }
  }

  // who may read what: root and the groups wheel, adm and systemd-journal see everything
  if (!canReadAll(sh) || action === 'user') {
    if (action && action !== 'user') return fail(`Failed to ${action.slice(2).replace(/-.*/, '')} journal: Permission denied`);
    const hint = action === 'user' || quiet ? '' : "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal', 'wheel' can see all messages.\n      Pass -q to turn off this notice.\n";
    return { stdout: quiet ? '' : '-- No entries --\n', stderr: hint, code: 0 };
  }
  const isPersistent = persistent(st);
  const cur = st.kernel.boots;
  switch (action) {
    case '--flush':
    case '--rotate':
    case '--sync':
      if (sh.uid !== 0) return fail(`Failed to ${action.slice(2)} journal: Permission denied`);
      if (action === '--flush') journaldStart(st);
      return ok();
    case '--disk-usage':
      return ok(`Archived and active journals take up ${isPersistent ? '24.0M' : '8.0M'} in the file system.\n`);
    case '--vacuum-size':
    case '--vacuum-time':
    case '--vacuum-files':
      if (sh.uid !== 0) return fail('Failed to vacuum journal: Permission denied');
      return ok(`Vacuuming done, freed 0B of archived journals from ${isPersistent ? JOURNAL_DIR : '/run/log/journal'}.\n`);
  }

  let all = readJournal(st);
  const visible = (b: number) => b === cur || (isPersistent && b >= st.journalPersistFrom!);
  all = all.filter((e) => visible(e.boot));
  const boots = [...new Set(all.map((e) => e.boot))].sort((x, y) => x - y);
  if (!boots.includes(cur)) boots.push(cur);

  if (action === '--list-boots') {
    const rows = boots.map((b) => {
      const es = all.filter((e) => e.boot === b);
      const firstT = es[0]?.time ?? st.kernel.bootTime;
      const lastT = es[es.length - 1]?.time ?? now;
      return `${String(b - cur).padStart(3)} ${bootId(st, b)} ${fullDate(firstT)} ${fullDate(lastT)}`;
    });
    return ok(`IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n${rows.join('\n')}\n`);
  }

  // which boot: -b, -b -1, -b 1 (the first one recorded), -b ID; -k means this boot
  let err = '';
  let only: number | null = kernel && boot === null ? cur : null;
  if (boot !== null && boot !== 'all') {
    const m = /^(?:([0-9a-f]{32}))?([-+]?\d+)?$/.exec(boot)!;
    const off = m[2] !== undefined ? parseInt(m[2], 10) : 0;
    let target: number | undefined;
    if (m[1]) {
      const base = boots.find((b) => bootId(st, b) === m[1]);
      const idx = base === undefined ? -1 : boots.indexOf(base) + off;
      target = boots[idx];
      if (!isPersistent && m[1] !== bootId(st, cur)) {
        err += 'Specifying boot ID or boot offset has no effect, no persistent journal was found.\n';
        target = cur;
      } else if (target === undefined) return fail(`Data from the specified boot (${m[1]}) is not available: No such boot ID in journal`);
    } else if (!isPersistent && off !== 0 && off !== 1) {
      err += 'Specifying boot ID or boot offset has no effect, no persistent journal was found.\n';
      target = cur;
    } else {
      target = off <= 0 ? boots[boots.length - 1 + off] : boots[off - 1];
      if (target === undefined) return fail(`Data from the specified boot (${off > 0 ? '+' : ''}${off}) is not available: No such boot ID in journal`);
    }
    only = target;
  }

  let entries = all;
  if (kernel) {
    entries = entries.filter((e) => e.ident === 'kernel' && e.boot !== cur).concat(kernelEntries(sh));
    entries.sort((x, y) => x.boot - y.boot || x.time - y.time);
  }
  if (only !== null) entries = entries.filter((e) => e.boot === only);
  if (units.length) entries = entries.filter((e) => units.some((u) => (/[*?]/.test(u) ? globRe(u).test(e.ident) || globRe(u).test(`${e.ident}.service`) : unitMatches(e, u))));
  if (idents.length) entries = entries.filter((e) => idents.includes(e.ident));
  for (const m of matches) entries = entries.filter(m);
  if (prio) entries = entries.filter((e) => e.prio >= prio![0] && e.prio <= prio![1]);
  if (since !== null) entries = entries.filter((e) => e.time >= since!);
  if (until !== null) entries = entries.filter((e) => e.time <= until!);
  if (grep) entries = entries.filter((e) => grep!.test(e.msg));
  const limit = lines ?? (follow ? 10 : pagerEnd ? 1000 : Infinity);
  if (limit !== Infinity) entries = entries.slice(Math.max(0, entries.length - limit));
  if (reverse) entries = [...entries].reverse();

  const host = (e: Entry) => (noHost || !e.host ? '' : `${e.host} `);
  const tag = (e: Entry) => (e.ident ? `${e.ident}${e.pid ? `[${e.pid}]` : ''}: ` : '');
  const fmt = (e: Entry) => {
    if (output === 'cat') return e.msg;
    const when = output === 'short-iso' ? isoDate(e.time) : output === 'short-full' ? fullDate(e.time) : output === 'short-precise' ? `${syslogDate(e.time)}.${String(e.time % 1000).padStart(3, '0')}000` : syslogDate(e.time);
    return `${when} ${host(e)}${tag(e)}${e.msg}`;
  };
  const out: string[] = [];
  let prevBoot: number | null = null;
  const jobs = new Map<number, number>();
  for (const e of entries) {
    if (prevBoot !== null && e.boot !== prevBoot && output !== 'cat') out.push(`-- Boot ${bootId(st, e.boot)} --`);
    prevBoot = e.boot;
    out.push(fmt(e));
    if (catalogOn) {
      const job = (jobs.get(e.boot) ?? 60) + 1;
      jobs.set(e.boot, job);
      const c = catalog(e, job);
      if (c) out.push(...c);
    }
  }
  if (!out.length) return { stdout: quiet ? '' : '-- No entries --\n', stderr: err, code: 0 };
  // like dmesg -w: the note follows the messages, where the real command would go on waiting
  if (follow) out.push('(Practice terminal: journalctl -f keeps showing new messages until you press Ctrl+C. This terminal cannot wait, so it shows the last ones and stops.)');
  return { stdout: out.join('\n') + '\n', stderr: err, code: 0 };
};


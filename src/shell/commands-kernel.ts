// Kernel, module and boot loader commands for the RHCSA boot and kernel modules: uname, reboot,
// shutdown, lsmod, modprobe, modinfo, rmmod, insmod, depmod, dmesg, sysctl, dracut, grubby,
// grub2-mkconfig, grub2-set-default, grub2-reboot and grub2-editenv, plus the kernel parts of
// dnf and rpm, and what happens to the simulated server when it reboots.

import type { CommandContext, CommandResult } from './commands';
import { bootStorage } from './commands-storage';
import { FsError, errorText, joinPath, splitPath } from './fs';
import {
  BOOT_MODULES,
  BootEntry,
  EFI_GRUB_CFG,
  GRUB_CFG,
  MODULES,
  OS_TITLE,
  OS_VERSION,
  REPO_KERNELS,
  ROOT_DEVICE,
  RUNNING_KERNEL,
  autoloadBlocked,
  bootEntries,
  bootLog,
  cmdlineBlacklist,
  cmdlineFor,
  cmdlineParams,
  defaultBootIndex,
  entryArgs,
  entryRelease,
  grubCfg,
  grubCfgDefault,
  holdersOf,
  insertModule,
  installKernel,
  installonlyLimit,
  isLoaded,
  kernelBuild,
  kernelLog,
  linuxVersionLine,
  listDir,
  modprobeConfig,
  moduleDeps,
  moduleFileName,
  modulesLoadD,
  nodeAt,
  normalizeModule,
  parseParams,
  parseSysctlFile,
  pkgVersion,
  putFile,
  readGrubenv,
  readSettings,
  removeAt,
  removeKernel,
  removeModule,
  resetKernelFs,
  resetSysctls,
  resolveEntry,
  rootFsUuid,
  splitArgs,
  syncMountModules,
  sysctlDFiles,
  sysctlPath,
  sysctlValue,
  textAt,
  moduleUsers,
  verCmp,
  writeEntry,
  writeGrubenv,
  writeSysctl,
} from './kernel-state';
import type { Shell } from './shell';
import { journaldStart, mountUnit } from './journal';
import { AVAILABLE_PACKAGES, pkgKey, runningHostname } from './state';
import { parseFstab, readFstab } from './storage-state';
import type { NmConnection, SystemState, User } from './state';

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1, stdout = ''): CommandResult => ({
  stdout,
  stderr: stderr.endsWith('\n') ? stderr : stderr + '\n',
  code,
});
const result = (stdout: string, stderr: string, code: number): CommandResult => ({ stdout, stderr, code });

/** Split args into flags, values and operands. Long options keep everything after the first "=". */
function getopts(args: string[], valued: string[] = []) {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (eq >= 0) values[k] = a.slice(eq + 1);
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

const needRoot = (sh: Shell, cmd: string): CommandResult | null =>
  sh.uid === 0 ? null : fail(`${cmd}: Permission denied.\n(Hint: try running it with sudo)`);

// ---------- dates ----------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
const hms = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const ctime = (ms: number) => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${hms(d)} ${d.getFullYear()}`;
};
const syslogDate = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${hms(d)}`;
};
const rpmDate = (ms: number) => {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  return `${DAYS[d.getDay()]} ${p2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${p2(h)}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'} EDT`;
};
const systemdDate = (ms: number) => {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms(d)} EDT`;
};

// ---------- uname ----------

const UNAME_LONG: Record<string, string> = {
  all: 'a', 'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v',
  machine: 'm', processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o',
};

const uname: Command = ({ sh, args }) => {
  const want = new Set<string>();
  const usage = "\nTry 'uname --help' for more information.";
  for (const a of args) {
    if (a.startsWith('--')) {
      const f = UNAME_LONG[a.slice(2)];
      if (!f) return fail(`uname: unrecognized option '${a}'${usage}`);
      want.add(f);
    } else if (a.startsWith('-') && a.length > 1) {
      for (const ch of a.slice(1)) {
        if (!'asnrvmpio'.includes(ch)) return fail(`uname: invalid option -- '${ch}'${usage}`);
        want.add(ch);
      }
    } else return fail(`uname: extra operand '${a}'${usage}`);
  }
  const k = sh.state.kernel;
  const fields: [string, string][] = [
    ['s', 'Linux'], ['n', runningHostname(sh.state)], ['r', k.running], ['v', kernelBuild(k.running)],
    ['m', 'x86_64'], ['p', 'x86_64'], ['i', 'x86_64'], ['o', 'GNU/Linux'],
  ];
  const shown = fields.filter(([f]) => want.has('a') || want.has(f)).map(([, v]) => v);
  return ok((shown.length ? shown.join(' ') : 'Linux') + '\n');
};

// ---------- reboot ----------

const denied = (verb: string, unit: string) =>
  `Failed to ${verb} system via logind: Interactive authentication required.\nFailed to start ${unit}: Interactive authentication required.\nSee system logs and 'systemctl status ${unit}' for details.`;
const REBOOT_DENIED = denied('reboot', 'reboot.target') + '\n(Hint: use sudo reboot)';
const POWEROFF_DENIED = denied('power off', 'poweroff.target') + '\n(Hint: use sudo poweroff)';

const TARGETS: Record<string, string> = {
  'multi-user.target': 'Multi-User System',
  'graphical.target': 'Graphical Interface',
  'rescue.target': 'Rescue Mode',
  'emergency.target': 'Emergency Mode',
};

/**
 * The parts of a boot other agents' code provides. Tests may replace them. The storage step
 * returns the fstab errors that stop the boot, either as a list or as { errors, warnings }, where
 * warnings (a swap line, say) are logged but let the boot go on.
 */
export const bootSteps: { storage: (sh: Shell) => unknown } = { storage: bootStorage };

/** What the storage step reported, whatever its exact shape: messages as mount(8) or swapon(8) print them. */
function storageResult(r: unknown): { errors: string[]; warnings: string[] } {
  const text = (x: unknown): string =>
    typeof x === 'object' && x !== null && 'message' in x ? String((x as { message: unknown }).message) : String(x);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(text).filter((t) => t.trim()) : []);
  if (Array.isArray(r)) return { errors: list(r), warnings: [] };
  const o = (typeof r === 'object' && r !== null ? r : {}) as { errors?: unknown; warnings?: unknown };
  return { errors: list(o.errors), warnings: list(o.warnings) };
}

/** Replace every session with a fresh login of `user`, as after logging in again. */
function freshLogin(sh: Shell, user: User): void {
  // sudo and su notice that the session list was replaced and leave it alone
  sh.sessions = [{ user, cwd: user.home }];
  sh.env = {};
  sh.functions = new Map();
}

const bootPath = (p: string) => (p.startsWith('/boot/') ? p : `/boot${p}`);

/** What stops GRUB or the kernel from starting an entry, as the console shows it. */
function bootProblem(state: SystemState, e: BootEntry): string | null {
  if (!e.linux || nodeAt(state.root, bootPath(e.linux))?.type !== 'file') {
    return `error: ../../grub-core/fs/fshelp.c:257:file \`${e.linux || '(none)'}' not found.\nerror: ../../grub-core/loader/i386/efi/linux.c:258:you need to load the kernel first.\n\nPress any key to continue...\n`;
  }
  if (!e.initrd || nodeAt(state.root, bootPath(e.initrd.split(/\s+/)[0]))?.type !== 'file') {
    return `error: ../../grub-core/fs/fshelp.c:257:file \`${e.initrd || '(none)'}' not found.\n[    2.104112] Kernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)\n`;
  }
  return null;
}

/** Load what a boot loads: udev's hardware and boot modules, then /etc/modules-load.d. */
function bootModules(state: SystemState, journal: string[]): void {
  for (const n of Object.keys(state.kernel.loaded)) removeModule(state, n);
  const cfg = modprobeConfig(state.root);
  const load = (name: string): string | null => {
    for (const d of moduleDeps(name)) {
      if (isLoaded(state, d)) continue;
      const e = insertModule(state, d, { ...cfg.options[d], ...cmdlineParams(state, d) });
      if (e) return e;
    }
    return null;
  };
  for (const n of BOOT_MODULES) if (!autoloadBlocked(state, n, cfg)) load(n);
  for (const n of modulesLoadD(state.root)) {
    if (!MODULES[n]) journal.push(`systemd-modules-load[512]: Failed to find module '${n}'`);
    else if (autoloadBlocked(state, n, cfg)) journal.push(`systemd-modules-load[512]: Module '${n}' is deny-listed (by kmod)`);
    else if (!isLoaded(state, n)) {
      const e = load(n);
      journal.push(e ? `systemd-modules-load[512]: Failed to insert module '${n}': ${e}` : `systemd-modules-load[512]: Inserted module '${n}'`);
    }
  }
}

/** systemd-sysctl: apply /usr/lib/sysctl.d, /run/sysctl.d and /etc/sysctl.d. */
function bootSysctl(state: SystemState, journal: string[]): void {
  resetSysctls(state);
  for (const f of sysctlDFiles(state.root)) {
    for (const s of parseSysctlFile(f.text)) {
      const e = writeSysctl(state, s.key, s.value);
      if (e && !(e === 'ENOENT' && s.optional)) {
        journal.push(`systemd-sysctl[530]: Couldn't write '${s.value}' to '${s.key}', ignoring: ${e === 'ENOENT' ? 'No such file or directory' : e === 'EINVAL' ? 'Invalid argument' : 'Permission denied'}`);
      }
    }
  }
}

/** Runtime settings that a reboot throws away: services, firewall, network, processes. */
function bootRuntime(state: SystemState, full: boolean, login: User): void {
  state.transientHostname = undefined; // "hostname NAME" lasts until the reboot; /etc/hostname comes back
  journaldStart(state); // with /var/log/journal (or Storage=persistent) this boot's journal is kept
  for (const s of Object.values(state.services)) s.active = full ? s.enabled : s.name === 'systemd-journald';
  state.firewall.services = [...state.firewall.permServices];
  state.firewall.ports = [...state.firewall.permPorts];
  const up = (c: NmConnection) => c.applied.ipv4.length + c.applied.ipv6.length > 0;
  const byDevice = new Map<string, NmConnection>();
  for (const c of state.connections) {
    if (!full || !c.autoconnect) continue;
    const cur = byDevice.get(c.device);
    if (!cur || (up(c) && !up(cur))) byDevice.set(c.device, c);
  }
  for (const c of state.connections) {
    const start = byDevice.get(c.device) === c && !(c.ipv4.method === 'manual' && !c.ipv4.addresses.length);
    c.applied = start
      ? {
          ipv4: c.ipv4.method === 'manual' ? [...c.ipv4.addresses] : c.ipv4.method === 'auto' ? ['192.168.4.157/24'] : [],
          ipv6: c.ipv6.method === 'manual' ? [...c.ipv6.addresses] : [],
        }
      : { ipv4: [], ipv6: [] };
  }
  state.processes = state.processes
    .filter((p) => p.pid < 1000)
    .map((p) => ({ ...p, cpu: 0, nice: 0 }))
    .concat({ pid: 1602, user: login.name, cpu: 0, mem: 0.1, nice: 0, cmd: '-bash' });
}

/**
 * systemd-remount-fs: the initramfs mounts / read-only (the "ro" argument), and early in the boot
 * systemd remounts it with the options from /etc/fstab. Booting straight into emergency.target
 * skips that step, so / stays read-only until "mount -o remount,rw /". Leaving emergency mode for
 * a normal target runs the step after all (remountRoot(state, false)).
 */
export function remountRoot(state: SystemState, readOnly: boolean): void {
  const root = state.storage.mounts.find((m) => m.target === '/');
  if (!root) return;
  const fstab = parseFstab(readFstab(state)).entries.find((e) => e.file === '/' && e.type !== 'swap');
  const opts = fstab?.options.length ? [...fstab.options] : ['defaults'];
  root.options = readOnly ? [...opts.filter((o) => !['defaults', 'rw', 'ro'].includes(o)), 'ro'] : opts;
}

function appendJournal(state: SystemState, lines: string[]): void {
  const log = nodeAt(state.root, '/var/log/messages');
  if (log?.type !== 'file') return;
  const host = state.hostname.split('.')[0];
  const when = syslogDate(Date.now());
  log.content = (log.content ?? '') + lines.map((l) => `${when} ${host} ${l}\n`).join('');
}

/** systemd.unit= takes a unit name with its type (rescue.target); anything else is ignored. */
const UNIT_NAME = /^[\w:.\\-]+(?:@[\w:.\\-]+)?\.(?:service|socket|target|device|mount|automount|swap|timer|path|slice|scope)$/;

/**
 * The target that kernel arguments ask for (systemd.unit=, rescue, single, emergency, 3, 5). Last
 * one wins. `warnings` gets what systemd logs about arguments it ignores.
 */
function requestedTarget(args: string[], def: string, warnings: string[]): string {
  let target = def;
  for (const a of args) {
    if (a.startsWith('systemd.unit=')) {
      const v = a.slice('systemd.unit='.length);
      if (!v) warnings.push('Missing argument for systemd.unit= kernel command line switch, ignoring.');
      else if (!UNIT_NAME.test(v)) warnings.push(`Unit name specified on systemd.unit= is not valid, ignoring: ${v}`);
      else target = v === 'emergency.service' ? 'emergency.target' : v === 'rescue.service' ? 'rescue.target' : v;
    } else if (['rescue', 'single', 's', 'S', '1'].includes(a)) target = 'rescue.target';
    else if (a === 'emergency' || a === '-b') target = 'emergency.target';
    else if (['2', '3', '4'].includes(a)) target = 'multi-user.target';
    else if (a === '5') target = 'graphical.target';
  }
  return target === 'default.target' ? def : target;
}

// ---------- what systemd shows when /etc/fstab or swap fails at boot ----------

/** One failed mount or swap line, with the units systemd shows for it. */
interface BootFailure {
  raw: string; // what mount(8) or swapon(8) said, e.g. "mount: /data: can't find UUID=..."
  unit: string | null; // data.mount, dev-sdb1.swap; null when the message is not understood
  what: string; // the unit's description: the mount point, or the swap device
  device: string | null; // a device that never appeared, so systemd waited for it until the timeout
  swap: boolean;
}

const BY_TAG: Record<string, string> = { UUID: 'by-uuid', LABEL: 'by-label', PARTUUID: 'by-partuuid', PARTLABEL: 'by-partlabel' };
/** systemd's unit name for a path: /dev/disk/by-uuid/1a-2b -> dev-disk-by\x2duuid-1a\x2d2b.device */
const pathUnit = (path: string, type: string) => mountUnit(path).replace(/\.mount$/, `.${type}`);

function parseBootFailure(raw: string): BootFailure {
  const t = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^mount: (\/[^:]*): can't find (UUID|LABEL|PARTUUID|PARTLABEL)=(.+?)\.?$/.exec(t))) {
    return { raw: t, unit: mountUnit(m[1]), what: m[1], device: `/dev/disk/${BY_TAG[m[2]]}/${m[3]}`, swap: false };
  }
  if ((m = /^mount: (\/[^:]*): special device (\S+) does not exist\.?$/.exec(t))) {
    return { raw: t, unit: mountUnit(m[1]), what: m[1], device: m[2], swap: false };
  }
  if ((m = /^mount: (\/[^:]*):/.exec(t))) return { raw: t, unit: mountUnit(m[1]), what: m[1], device: null, swap: false };
  let dev: string | null = null;
  if ((m = /^swapon: cannot find the device for (UUID|LABEL|PARTUUID|PARTLABEL)=(.+)$/.exec(t))) dev = `/dev/disk/${BY_TAG[m[1]]}/${m[2]}`;
  else if ((m = /^swapon: cannot open (\/\S+): No such file or directory$/.exec(t))) dev = m[1];
  if (dev) return { raw: t, unit: pathUnit(dev, 'swap'), what: dev, device: dev, swap: true };
  if ((m = /^swapon: (\/[^:\s]+):/.exec(t))) return { raw: t, unit: pathUnit(m[1], 'swap'), what: m[1], device: null, swap: true };
  return { raw: t, unit: null, what: '', device: null, swap: /^swapon:/.test(t) };
}

/** The console lines for failures (systemd's status output), ending with the target that failed. */
function failureConsole(fs: BootFailure[]): string {
  let out = '';
  for (const f of fs) {
    if (!f.unit) out += f.raw + '\n';
    else if (f.device) {
      out += `[ TIME ] Timed out waiting for device ${pathUnit(f.device, 'device')} - ${f.device}.\n[DEPEND] Dependency failed for ${f.unit} - ${f.what}.\n`;
    } else {
      out += `[FAILED] Failed to ${f.swap ? 'activate swap' : 'mount'} ${f.unit} - ${f.what}.\nSee 'systemctl status ${f.unit}' for details.\n`;
    }
  }
  if (fs.some((f) => !f.swap)) out += '[DEPEND] Dependency failed for local-fs.target - Local File Systems.\n';
  if (fs.some((f) => f.swap)) out += '[DEPEND] Dependency failed for swap.target - Swaps.\n';
  return out;
}

/** The journal lines for failures, as systemd and mount(8) log them. */
function failureJournal(fs: BootFailure[]): string[] {
  const out: string[] = [];
  fs.forEach((f, i) => {
    if (!f.unit) {
      out.push(`systemd[1]: ${f.raw}`);
      return;
    }
    if (f.device) {
      const du = pathUnit(f.device, 'device');
      out.push(
        `systemd[1]: ${du}: Job ${du}/start timed out.`,
        `systemd[1]: Timed out waiting for device ${du} - ${f.device}.`,
        `systemd[1]: Dependency failed for ${f.unit} - ${f.what}.`,
        `systemd[1]: ${f.unit}: Job ${f.unit}/start failed with result 'dependency'.`,
        `systemd[1]: ${du}: Job ${du}/start failed with result 'timeout'.`,
      );
      return;
    }
    out.push(
      f.swap ? `systemd[1]: Activating swap ${f.unit} - ${f.what}...` : `systemd[1]: Mounting ${f.unit} - ${f.what}...`,
      `${f.swap ? 'swapon' : 'mount'}[${612 + i}]: ${f.raw}`,
      `systemd[1]: ${f.unit}: ${f.swap ? 'Swap' : 'Mount'} process exited, code=exited, status=${f.swap ? '255/EXCEPTION' : '32/n/a'}`,
      `systemd[1]: ${f.unit}: Failed with result 'exit-code'.`,
      `systemd[1]: Failed to ${f.swap ? 'activate swap' : 'mount'} ${f.unit} - ${f.what}.`,
    );
  });
  if (fs.some((f) => !f.swap)) {
    out.push(
      'systemd[1]: Dependency failed for local-fs.target - Local File Systems.',
      "systemd[1]: local-fs.target: Job local-fs.target/start failed with result 'dependency'.",
      'systemd[1]: local-fs.target: Triggering OnFailure= dependencies.',
    );
  }
  if (fs.some((f) => f.swap)) {
    out.push('systemd[1]: Dependency failed for swap.target - Swaps.', "systemd[1]: swap.target: Job swap.target/start failed with result 'dependency'.");
  }
  return out;
}

/**
 * How systemd reports fstab or swap failures (mount(8) and swapon(8) messages such as
 * "mount: /data: can't find UUID=..."): the console status lines and the journal lines.
 */
export function bootFailureMessages(messages: string[]): { console: string; journal: string[] } {
  const fs = messages.map(parseBootFailure);
  return { console: failureConsole(fs), journal: failureJournal(fs) };
}

/** Boot the server: GRUB picks an entry, the kernel starts with its arguments, systemd reaches a target. */
function bootServer(sh: Shell, before = ''): CommandResult {
  const state = sh.state;
  const k = state.kernel;
  let out = before;
  if (nodeAt(state.root, GRUB_CFG)?.type !== 'file') {
    return fail(`${out}error: ../../grub-core/kern/fs.c:123:file \`/grub2/grub.cfg' not found.\n\ngrub> \n(Practice server: GRUB found no grub.cfg and stopped at its own prompt. On a real server you would boot by hand from there or from installation media, then run grub2-mkconfig -o /boot/grub2/grub.cfg. This practice server stays up so you can run that now.)`);
  }
  const entries = bootEntries(state);
  if (!entries.length) {
    return fail(`${out}error: ../../grub-core/commands/blscfg.c:1109:no boot loader entries found in /boot/loader/entries.\n(Practice server: a real server would stop at an empty GRUB menu, and you would boot from installation media to repair it. This practice server stays up so you can restore /boot/loader/entries.)`);
  }

  // GRUB: a one-time next_entry wins over the default
  const env = readGrubenv(state.root);
  let spec: string;
  if (env.next_entry) {
    spec = env.next_entry;
    delete env.next_entry;
    writeGrubenv(state.root, env);
  } else {
    const def = grubCfgDefault(state.root);
    spec = def === 'saved' ? env.saved_entry ?? '0' : def;
  }
  const first = Math.max(0, resolveEntry(entries, spec));
  let chosen: BootEntry | null = null;
  for (const i of [first, ...entries.map((_, j) => j).filter((j) => j !== first)]) {
    const problem = bootProblem(state, entries[i]);
    if (!problem) {
      chosen = entries[i];
      break;
    }
    out += problem;
  }
  if (!chosen) {
    return fail(`${out}(Practice server: no boot entry can start. This practice server stays up so you can repair /boot, for example with "dracut -f --regenerate-all".)`);
  }
  if (chosen !== entries[first]) {
    out += `(Practice server: the default entry did not boot. You restarted the server and picked "${chosen.title}" in the GRUB menu.)\n\n`;
  }

  // kernel: new procfs and sysfs first, so nothing left from the last boot can get in the way
  resetKernelFs(state.root);
  const release = entryRelease(chosen);
  const args = splitArgs(chosen.options);
  k.running = release;
  k.cmdline = cmdlineFor(chosen.linux, chosen.options);
  k.boots++;
  k.bootTime = Date.now() - 6000; // "now" is about six seconds into the boot
  k.dmesg = bootLog(release, k.cmdline, rootFsUuid(state));
  const journal = [`kernel: ${linuxVersionLine(release)}`, `kernel: Command line: ${k.cmdline}`];

  // systemd: which target the kernel arguments ask for
  const argWarnings: string[] = [];
  let target = requestedTarget(args, state.defaultTarget, argWarnings);
  for (const w of argWarnings) {
    journal.push(`systemd[1]: ${w}`);
    kernelLog(state, `systemd[1]: ${w}`, 'warn');
  }
  if (!TARGETS[target]) {
    out += `Unit ${target} not found.\nFalling back to rescue.target.\n`;
    journal.push(`systemd[1]: Unit ${target} not found.`, 'systemd[1]: Falling back to rescue.target.');
    target = 'rescue.target';
  }

  // SELinux mode from /etc/selinux/config, unless a kernel argument overrides it
  const conf = state.selinuxConfigMode;
  let se: SystemState['selinux'] = conf === 'enforcing' ? 'Enforcing' : conf === 'permissive' ? 'Permissive' : 'Disabled';
  if (args.includes('selinux=0')) se = 'Disabled';
  else if (se !== 'Disabled' && args.includes('enforcing=0')) se = 'Permissive';
  else if (se !== 'Disabled' && args.includes('enforcing=1')) se = 'Enforcing';
  state.selinux = se;
  if (se !== 'Disabled' && nodeAt(state.root, '/.autorelabel')) {
    removeAt(state.root, '/.autorelabel');
    out += '*** Warning -- SELinux targeted policy relabel is required.\n*** Relabeling could take a very long time, depending on file\n*** system size and speed of hard drives.\n(Practice server: the relabel finished and the server rebooted once more by itself.)\n\n';
  }

  bootModules(state, journal);
  bootSysctl(state, journal);
  const storage = storageResult(bootSteps.storage(sh));
  syncMountModules(state);
  const errors = bootFailureMessages(storage.errors);
  const warnings = bootFailureMessages(storage.warnings);
  // straight into emergency.target: systemd-remount-fs never runs, so / stays read-only
  const readOnlyRoot = target === 'emergency.target';
  remountRoot(state, readOnlyRoot);

  if (storage.errors.length) target = 'emergency.target';
  k.bootTarget = target;
  k.emergency = target === 'emergency.target';
  k.bootErrors = storage.errors;
  journal.push(...errors.journal, ...warnings.journal);
  journal.push(`systemd[1]: Reached target ${target} - ${TARGETS[target]}.`);
  appendJournal(state, journal);

  const root = state.users.find((u) => u.uid === 0)!;
  const maintenance = target === 'rescue.target' || target === 'emergency.target';
  const login = maintenance ? root : state.users.find((u) => u.name === 'student') ?? root;
  bootRuntime(state, !maintenance, login);
  freshLogin(sh, login);

  const notes: string[] = [];
  for (const w of argWarnings) {
    const v = /: (\S+)$/.exec(w)?.[1];
    notes.push(`(Practice note: systemd ignored ${v ? `systemd.unit=${v}` : 'an empty systemd.unit='}, because it needs a whole unit name with its type, such as systemd.unit=rescue.target or systemd.unit=emergency.target.)`);
  }
  if (args.includes('rd.break')) {
    notes.push('(Practice note: rd.break stops the boot inside the initramfs, with the real root file system on /sysroot. This terminal cannot show that stage, so it booted on. Add rd.break in the GRUB menu (press e) for one boot only; remove it here with: grubby --update-kernel=ALL --remove-args=rd.break)');
  }
  if (args.some((a) => a.startsWith('init='))) {
    notes.push('(Practice note: init=/bin/bash starts a root shell instead of systemd. This terminal cannot show that stage, so it booted on. Add it in the GRUB menu (press e) for one boot only; remove it here with: grubby --update-kernel=ALL --remove-args=init)');
  }
  out += errors.console + warnings.console;
  const summary = `(Practice server rebooted: kernel ${release}, target ${target}.`;
  if (maintenance) {
    const mode = target === 'rescue.target' ? 'rescue' : 'emergency';
    out += `You are in ${mode} mode. After logging in, type "journalctl -xb" to view\nsystem logs, "systemctl reboot" to reboot, or "exit"\nto continue bootup.\n`;
    if (root.locked || !root.password) {
      out += 'Cannot open access to console, the root account is locked.\nSee sulogin(8) man page for more details.\n\nPress Enter to continue.\n';
      out += '(Practice server: a real server would be stuck here, because root has no usable password. You would reboot, press e in the GRUB menu and add rd.break or init=/bin/bash. To let you practise the repair, this terminal gives you a root shell anyway.)\n';
    } else {
      out += 'Give root password for maintenance\n(or press Control-D to continue):\n';
    }
    const ro = readOnlyRoot ? ' / is mounted read-only in emergency mode: run "mount -o remount,rw /" before you change files.' : '';
    out += storage.errors.length
      ? `${summary} The boot stopped because of the errors above. You are root on the console:${ro} fix them (for /etc/fstab, test with "mount -a"), then type "exit" to continue the boot, or run "systemctl reboot".)\n`
      : `${summary} You are root on the console.${ro} Type "exit" (or "systemctl default") to continue to ${state.defaultTarget}, or run "systemctl reboot".)\n`;
  } else {
    out += `${OS_TITLE} ${OS_VERSION}\nKernel ${release} on an x86_64\n\n${summary} You are logged in as ${login.name} again.)\n`;
  }
  if (notes.length) out += notes.join('\n') + '\n';
  return ok(out);
}

/** Reboot the simulated server (reboot, shutdown -r, systemctl reboot). */
export function rebootSystem(ctx: CommandContext): CommandResult {
  if (ctx.sh.uid !== 0) return fail(REBOOT_DENIED);
  return bootServer(ctx.sh);
}

const reboot: Command = (ctx) => {
  if (ctx.args.includes('--help')) return ok('reboot [OPTIONS...]\n\nReboot the system.\n');
  return rebootSystem(ctx);
};

const POWEROFF_NOTE = '(Practice server: pretending to power off. Your changes are kept. Use "reboot" to practise a restart.)\n';

const poweroff: Command = ({ sh }) => (sh.uid !== 0 ? fail(POWEROFF_DENIED) : ok(POWEROFF_NOTE));

const shutdown: Command = (ctx) => {
  const { sh, args } = ctx;
  const { flags, operands } = getopts(args);
  if (flags.has('c')) return ok();
  const isReboot = flags.has('r') || flags.has('reboot');
  const when = operands[0] ?? '+1';
  // systemd's parse_shutdown_time_spec: "now", minutes from now (with or without +), or hh:mm
  const m = /^(?:now|\+?(\d+)|(\d{1,2}):(\d{2}))$/.exec(when);
  if (!m) return fail(`Failed to parse time specification: ${when}`);
  if (sh.uid !== 0) return fail(isReboot ? REBOOT_DENIED : POWEROFF_DENIED);
  let note = '';
  if (when !== 'now') {
    const at = new Date();
    if (m[1] !== undefined) at.setMinutes(at.getMinutes() + Number(m[1]));
    else at.setHours(Number(m[2]), Number(m[3]), 0);
    note = `${isReboot ? 'Reboot' : 'Shutdown'} scheduled for ${systemdDate(at.getTime())}, use 'shutdown -c' to cancel.\n`;
    if (m[1] === undefined || Number(m[1]) > 0) note += '(Practice server: not waiting for it.)\n';
  }
  return isReboot ? bootServer(sh, note) : ok(note + POWEROFF_NOTE);
};

// ---------- modules ----------

const modDir = (sh: Shell, kver = sh.state.kernel.running) => `/lib/modules/${kver}`;
const moduleExists = (sh: Shell, name: string, kver = sh.state.kernel.running) =>
  !!MODULES[name] && nodeAt(sh.state.root, `/usr/lib/modules/${kver}/${MODULES[name].path}`)?.type === 'file';
const paramString = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(' ');

/** Which catalogue module a .ko file is: [name, kernel release]. */
function moduleForFile(sh: Shell, file: string): [string, string] | null {
  try {
    const r = sh.resolve(file);
    if (r.node.type !== 'file') return null;
    const m = /^\/usr\/lib\/modules\/([^/]+)\/(.+)$/.exec(joinPath(r.parts));
    const name = m && Object.keys(MODULES).find((n) => MODULES[n].path === m[2]);
    return name && m ? [name, m[1]] : null;
  } catch {
    return null;
  }
}

const lsmod: Command = ({ sh, args }) => {
  if (args.length) return fail('Usage: lsmod');
  const state = sh.state;
  syncMountModules(state);
  let out = `${'Module'.padEnd(19)} ${'Size'.padStart(8)}  Used by\n`;
  for (const n of Object.keys(state.kernel.loaded).reverse()) {
    const h = holdersOf(state, n);
    out += `${n.padEnd(19)} ${String(MODULES[n]?.size ?? 16384).padStart(8)}  ${moduleUsers(state, n)}${h.length ? ' ' + h.join(',') : ''}\n`;
  }
  return ok(out);
};

const modprobe: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const has = (s: string, l: string) => flags.has(s) || flags.has(l);
  const verbose = has('v', 'verbose');
  const dry = has('n', 'dry-run');
  const quiet = has('q', 'quiet');
  const state = sh.state;
  const cfg = modprobeConfig(state.root);
  if (has('c', 'showconfig')) return ok(cfg.text);
  if (!operands.length) return fail('modprobe: ERROR: missing parameters. See -h.');
  let out = '';
  let err = '';
  let code = 0;

  if (has('r', 'remove')) {
    syncMountModules(state);
    for (const raw of operands) {
      const n = normalizeModule(raw);
      if (!MODULES[n]) {
        err += `modprobe: FATAL: Module ${raw} not found.\n`;
        code = 1;
      } else if (!isLoaded(state, n)) {
        err += `modprobe: FATAL: Module ${n} is not in kernel.\n`;
        code = 1;
      } else if (moduleUsers(state, n) > 0) {
        err += `modprobe: FATAL: Module ${n} is in use.\n`;
        code = 1;
      } else if (sh.uid !== 0) {
        err += `modprobe: ERROR: could not remove '${n}': Operation not permitted\n`;
        code = 1;
      } else {
        if (verbose) out += `rmmod ${n}\n`;
        if (dry) continue;
        removeModule(state, n);
        // then the dependencies that nothing uses any more
        for (const d of moduleDeps(n).reverse().slice(1)) {
          if (isLoaded(state, d) && moduleUsers(state, d) === 0) {
            if (verbose) out += `rmmod ${d}\n`;
            removeModule(state, d);
          }
        }
      }
    }
    return result(out, err, code);
  }

  const all = has('a', 'all');
  const names = all ? operands : [operands[0]];
  const cli = all ? {} : parseParams(operands.slice(1));
  for (const raw of names) {
    const n = normalizeModule(raw);
    if (!moduleExists(sh, n)) {
      if (!quiet) err += `modprobe: FATAL: Module ${raw} not found in directory ${modDir(sh)}\n`;
      return result(out, err, 1);
    }
    const chain = moduleDeps(n);
    const paramsFor = (d: string) => ({ ...cfg.options[d], ...cmdlineParams(state, d), ...(d === n ? cli : {}) });
    if (has('D', 'show-depends')) {
      out += chain.map((d) => `insmod ${modDir(sh)}/${MODULES[d].path} ${paramString(paramsFor(d))}`.trimEnd()).join('\n') + '\n';
      continue;
    }
    if (has('b', 'use-blacklist') && cfg.blacklist.has(n)) continue;
    if (cmdlineBlacklist(state).hard.includes(n)) {
      err += `modprobe: ERROR: could not insert '${n}': Operation not permitted\n`;
      code = 1;
      continue;
    }
    const inst = cfg.install[n];
    if (inst && !has('i', 'ignore-install') && !isLoaded(state, n)) {
      if (verbose) out += `install ${inst}\n`;
      if (/(^|\/)false(\s|$)/.test(inst)) {
        err += `modprobe: ERROR: ../libkmod/libkmod-module.c:1094 command_do() Error running install command '${inst}' for module ${n}: retcode 1\nmodprobe: ERROR: could not insert '${n}': Operation not permitted\n`;
        code = 1;
        continue;
      }
      if (/(^|\/)true(\s|$)/.test(inst)) continue;
      // any other install command is assumed to load the module the usual way
    }
    for (const d of chain) {
      if (isLoaded(state, d)) continue;
      if (verbose) out += `insmod ${modDir(sh)}/${MODULES[d].path} ${paramString(paramsFor(d))}`.trimEnd() + '\n';
      if (dry) continue;
      if (sh.uid !== 0) return result(out, err + `modprobe: ERROR: could not insert '${n}': Operation not permitted\n`, 1);
      const e = insertModule(state, d, paramsFor(d));
      if (e) {
        err += `modprobe: ERROR: could not insert '${d}': ${e}\n`;
        code = 1;
        break;
      }
    }
  }
  return result(out, err, code);
};

const rmmod: Command = ({ sh, args }) => {
  const { operands } = getopts(args);
  if (!operands.length) return fail('rmmod: ERROR: missing module name.');
  const state = sh.state;
  syncMountModules(state);
  let err = '';
  for (const raw of operands) {
    const n = normalizeModule(raw.replace(/^.*\//, '').replace(/\.ko(\.xz)?$/, ''));
    const h = holdersOf(state, n);
    if (!isLoaded(state, n)) err += `rmmod: ERROR: Module ${n} is not currently loaded\n`;
    else if (h.length) err += `rmmod: ERROR: Module ${n} is in use by: ${h.join(' ')}\n`;
    else if (moduleUsers(state, n) > 0) err += `rmmod: ERROR: Module ${n} is in use\n`;
    else if (sh.uid !== 0) {
      err += `rmmod: ERROR: ../libkmod/libkmod-module.c:799 kmod_module_remove_module() could not remove '${n}': Operation not permitted\nrmmod: ERROR: could not remove module ${n}: Operation not permitted\n`;
    } else removeModule(state, n);
  }
  return err ? fail(err) : ok();
};

const insmod: Command = ({ sh, args }) => {
  const [file, ...rest] = args.filter((a) => !/^-[fs]$/.test(a));
  if (!file) return fail('insmod: ERROR: missing filename.');
  if (!sh.exists(file)) return fail(`insmod: ERROR: could not load module ${file}: No such file or directory`);
  const found = moduleForFile(sh, file);
  const state = sh.state;
  if (!found) return fail(`insmod: ERROR: could not insert module ${file}: Invalid module format`);
  const [n, kver] = found;
  if (kver !== state.kernel.running) {
    kernelLog(state, `${n}: version magic '${kver} SMP preempt mod_unload modversions ' should be '${state.kernel.running} SMP preempt mod_unload modversions '`, 'err');
    return fail(`insmod: ERROR: could not insert module ${file}: Invalid module format`);
  }
  if (isLoaded(state, n)) return fail(`insmod: ERROR: could not insert module ${file}: File exists`);
  if (sh.uid !== 0) return fail(`insmod: ERROR: could not insert module ${file}: Operation not permitted`);
  const missing = MODULES[n].depends.filter((d) => !isLoaded(state, d));
  if (missing.length) {
    kernelLog(state, `${n}: Unknown symbol ${missing[0]}_init (err -2)`, 'warn');
    return fail(`insmod: ERROR: could not insert module ${file}: Unknown symbol in module\n(Hint: insmod does not load dependencies. Load ${missing.join(', ')} first, or use modprobe ${n}.)`);
  }
  if (insertModule(state, n, parseParams(rest))) return fail(`insmod: ERROR: could not insert module ${file}: Invalid parameters`);
  return ok();
};

const depmod: Command = ({ sh, args }) => {
  const kver = args.find((a) => /^\d/.test(a)) ?? sh.state.kernel.running;
  const dir = `/usr/lib/modules/${kver}`;
  if (!nodeAt(sh.state.root, dir)) return fail(`depmod: ERROR: could not open directory /lib/modules/${kver}: No such file or directory`);
  if (sh.uid !== 0) return fail(`depmod: ERROR: openat(/lib/modules/${kver}, modules.dep.tmp): Permission denied`);
  let dep = '';
  for (const m of Object.values(MODULES)) {
    if (nodeAt(sh.state.root, `${dir}/${m.path}`)) dep += `${m.path}:${m.depends.map((d) => ' ' + MODULES[d].path).join('')}\n`;
  }
  putFile(sh.state.root, `${dir}/modules.dep`, dep);
  return ok();
};

const SIG_KEY = '1E:4F:7A:0B:93:C2:5D:68:E1:24:9F:3B:7C:D0:56:A8:12:EB:4C:9D';

function srcversion(name: string): string {
  let h = 2166136261;
  let out = '';
  for (let round = 0; out.length < 23; round++) {
    for (const ch of name + round) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).toUpperCase().padStart(8, '0');
  }
  return out.slice(0, 23);
}

const MODINFO_FIELDS: Record<string, string> = { p: 'parm', parameters: 'parm', d: 'description', description: 'description', l: 'license', license: 'license', n: 'filename', filename: 'filename' };

const modinfo: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['F', 'k', 'field']);
  let field = values.F ?? values.field ?? null;
  for (const f of flags) if (MODINFO_FIELDS[f]) field = MODINFO_FIELDS[f];
  const kver = values.k ?? sh.state.kernel.running;
  if (!operands.length) return fail('modinfo: ERROR: missing module or filename.');
  let out = '';
  let err = '';
  for (const raw of operands) {
    let n: string | null = null;
    let file = '';
    if (raw.includes('/')) {
      const found = moduleForFile(sh, raw);
      if (found) {
        n = found[0];
        file = raw;
      }
    } else if (moduleExists(sh, normalizeModule(raw), kver)) {
      n = normalizeModule(raw);
      file = `/lib/modules/${kver}/${MODULES[n].path}`;
    }
    if (!n) {
      err += `modinfo: ERROR: Module ${raw} not found.\n`;
      continue;
    }
    const m = MODULES[n];
    const rows: [string, string][] = [['filename', file]];
    if (m.description) rows.push(['description', m.description]);
    rows.push(
      ['license', m.license], ['rhelversion', '10.0'], ['srcversion', srcversion(n)],
      ['depends', m.depends.map(moduleFileName).join(',')], ['retpoline', 'Y'], ['intree', 'Y'], ['name', n],
      ['vermagic', `${kver} SMP preempt mod_unload modversions `], ['sig_id', 'PKCS#7'],
      ['signer', 'Red Hat Enterprise Linux kernel signing key'], ['sig_key', SIG_KEY], ['sig_hashalgo', 'sha256'],
      ...m.params.map((p): [string, string] => ['parm', `${p.name}:${p.desc ? `${p.desc} (${p.type})` : p.type}`]),
    );
    if (field) out += rows.filter(([k]) => k === field).map(([, v]) => v + '\n').join('');
    else out += rows.map(([k, v]) => `${(k + ':').padEnd(16)}${v}\n`).join('');
  }
  return result(out, err, err ? 1 : 0);
};

// ---------- dmesg ----------

const LEVELS = ['emerg', 'alert', 'crit', 'err', 'warn', 'notice', 'info', 'debug'];

const dmesg: Command = ({ sh, args }) => {
  const { flags, values } = getopts(args, ['l', 'level']);
  const has = (s: string, l: string) => flags.has(s) || flags.has(l);
  const state = sh.state;
  const k = state.kernel;
  const clear = has('C', 'clear');
  const readClear = has('c', 'read-clear');
  if (sh.uid !== 0 && (clear || readClear)) return fail('dmesg: klogctl failed: Operation not permitted');
  if (sh.uid !== 0 && sysctlValue(state, 'kernel.dmesg_restrict') === '1') return fail('dmesg: read kernel buffer failed: Operation not permitted');
  if (clear) {
    k.dmesg = [];
    return ok();
  }
  const wanted = (values.l ?? values.level)?.split(',');
  const bad = wanted?.find((l) => !LEVELS.includes(l));
  if (bad) return fail(`dmesg: unknown level '${bad}'`);
  let out = '';
  for (const l of k.dmesg) {
    if (wanted && !wanted.includes(l.level)) continue;
    const stamp = has('t', 'notime') ? '' : has('T', 'ctime') ? `[${ctime(k.bootTime + l.t * 1000)}] ` : `[${l.t.toFixed(6).padStart(12)}] `;
    const prefix = has('x', 'decode') ? `kern  :${l.level.padEnd(6)}: ` : '';
    out += `${prefix}${stamp}${l.msg}\n`;
  }
  if (readClear) k.dmesg = [];
  if (has('w', 'follow')) out += '(Practice terminal: dmesg -w keeps waiting for new messages, which this terminal cannot do.)\n';
  return ok(out);
};

// ---------- sysctl ----------

const SYSCTL_USAGE = '\nUsage:\n sysctl [options] [variable[=value] ...]\n\nOptions:\n  -a, --all            display all variables\n  -n, --values         print only values of the given variable(s)\n  -p, --load[=<file>]  read values from file\n      --system         read values from all system directories\n  -w, --write          enable writing a value to variable\n';

/** Every tunable that exists right now, sorted. */
function allSysctls(state: SystemState): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    const n = nodeAt(state.root, path);
    if (n?.type === 'file') out.push(path.slice('/proc/sys/'.length).replace(/\//g, '.'));
    else if (n?.type === 'dir') for (const c of listDir(state.root, path)) walk(`${path}/${c}`);
  };
  walk('/proc/sys');
  return out.sort();
}

const sysctl: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['p', 'load']);
  const has = (s: string, l: string) => flags.has(s) || flags.has(l);
  const state = sh.state;
  const quiet = has('q', 'quiet');
  const ignore = has('e', 'ignore');
  const show = (key: string, v: string) => (has('n', 'values') ? v : has('N', 'names') ? key : `${key} = ${v}`) + '\n';
  let out = '';
  let err = '';
  let code = 0;

  const set = (rawKey: string, value: string, optional = false) => {
    const key = rawKey.replace(/\//g, '.');
    if (sh.uid !== 0 && sysctlValue(state, key) !== null) {
      err += `sysctl: permission denied on key "${key}"\n`;
      code = 1;
      return;
    }
    const e = writeSysctl(state, key, value);
    if (e === 'ENOENT') {
      if (!optional && !ignore) {
        err += `sysctl: cannot stat ${sysctlPath(key)}: No such file or directory\n`;
        code = 255;
      }
    } else if (e === 'EACCES') {
      err += `sysctl: permission denied on key "${key}"\n`;
      code = 1;
    } else if (e === 'EINVAL') {
      err += `sysctl: setting key "${key}": Invalid argument\n`;
      code = 1;
    } else if (!quiet) out += show(key, sysctlValue(state, key) ?? value);
  };
  const loadFile = (path: string) => {
    let text: string;
    try {
      text = sh.readFile(path);
    } catch (e) {
      err += `sysctl: cannot open "${path}": ${e instanceof FsError ? errorText[e.reason] : String(e)}\n`;
      code = 255;
      return;
    }
    for (const s of parseSysctlFile(text)) set(s.key, s.value, s.optional);
  };

  if (has('a', 'all') || flags.has('A') || flags.has('X')) {
    for (const key of allSysctls(state)) out += show(key, sysctlValue(state, key) ?? '');
    return ok(out);
  }
  if (flags.has('system')) {
    for (const f of sysctlDFiles(state.root)) {
      out += `* Applying ${f.path} ...\n`;
      for (const s of parseSysctlFile(f.text)) set(s.key, s.value, s.optional);
    }
    if (textAt(state.root, '/etc/sysctl.conf') !== null) {
      out += '* Applying /etc/sysctl.conf ...\n';
      loadFile('/etc/sysctl.conf');
    }
    return result(out, err, code);
  }
  if ('p' in values || 'load' in values || flags.has('load')) {
    loadFile(values.p || values.load || '/etc/sysctl.conf');
    return result(out, err, code);
  }
  if (!operands.length) return fail(SYSCTL_USAGE);
  for (const op of operands) {
    const eq = op.indexOf('=');
    if (eq >= 0) set(op.slice(0, eq).trim(), op.slice(eq + 1));
    else if (has('w', 'write')) {
      err += `sysctl: "${op}" must be of the form name=value\n`;
      code = 1;
    } else {
      const key = op.replace(/\//g, '.');
      const v = sysctlValue(state, key);
      if (v !== null) out += show(key, v);
      else if (!ignore) {
        err += `sysctl: cannot stat ${sysctlPath(key)}: No such file or directory\n`;
        code = 255;
      }
    }
  }
  return result(out, err, code);
};

// ---------- dracut ----------

const dracut: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['kver']);
  const force = flags.has('f') || flags.has('force');
  const verbose = flags.has('v') || flags.has('verbose');
  const state = sh.state;
  if (sh.uid !== 0) return fail('dracut[F]: No permission to write to /boot.\n(Hint: use sudo dracut ...)');
  const jobs: [string, string][] = flags.has('regenerate-all')
    ? state.kernel.installed.map((r) => [`/boot/initramfs-${r}.img`, r])
    : (() => {
        const kver = operands[1] ?? values.kver ?? state.kernel.running;
        return [[operands[0] ?? `/boot/initramfs-${kver}.img`, kver]];
      })();
  let out = '';
  let err = '';
  for (const [image, kver] of jobs) {
    const abs = joinPath(splitPath(sh.cwd, image, sh.user.home));
    const dir = abs.replace(/\/[^/]*$/, '') || '/';
    if (!nodeAt(state.root, `/usr/lib/modules/${kver}`)) {
      err += `dracut[F]: Cannot find module directory /lib/modules/${kver}/\ndracut[F]: and --no-kernel was not specified\n`;
    } else if (nodeAt(state.root, dir)?.type !== 'dir') {
      err += `dracut[F]: Can't write to ${dir}: Directory ${dir} does not exist or is not accessible.\n`;
    } else if (nodeAt(state.root, abs) && !force) {
      err += `dracut[F]: Will not override existing initramfs (${abs}) without --force\n`;
    } else {
      if (verbose) out += `dracut[I]: Executing: /usr/bin/dracut ${args.join(' ')}\ndracut[I]: *** Including module: bash ***\ndracut[I]: *** Including module: systemd ***\ndracut[I]: *** Including module: lvm ***\ndracut[I]: *** Creating image file '${abs}' ***\n`;
      putFile(state.root, abs, `(initramfs (made by dracut) for Linux ${kver})\n`, 0o600);
      if (verbose) out += `dracut[I]: *** Creating initramfs image file '${abs}' done ***\n`;
    }
  }
  return result(out, err, err ? 1 : 0);
};

// ---------- GRUB ----------

const kpath = (e: BootEntry) => bootPath(e.linux);

/**
 * grubby-bls update_args: drop the --remove-args (a key=value word, or a key with any value),
 * then drop every existing value of each key being added, then append all the --args. So
 * --args="console=tty0 console=ttyS0,115200" keeps both console= arguments.
 */
export function updatedOptions(old: string, remove: string[], add: string[]): string {
  let toks = splitArgs(old);
  const drop = (a: string) => {
    toks = toks.filter((t) => (a.includes('=') ? t !== a : t !== a && !t.startsWith(a + '=')));
  };
  remove.forEach(drop);
  for (const a of add) drop(a.split('=')[0]);
  return [...toks, ...add].join(' ');
}

const GRUBBY_VALUED = ['info', 'set-default', 'set-default-index', 'update-kernel', 'args', 'remove-args', 'remove-kernel'];
const GRUBBY_FLAGS = ['default-kernel', 'default-index', 'default-title', 'bootloader-probe', 'help', 'no-etc-grub-update', 'grub2'];
const GRUBBY_USAGE = 'Usage: grubby [OPTION...]\n      --args=args                   default arguments for the new kernel or new arguments for kernel being updated\n      --default-kernel              display the path of the default kernel\n      --default-index               display the index of the default kernel\n      --default-title               display the title of the default kernel\n      --info=kernel-path            display boot information for specified kernel (ALL for every entry)\n      --remove-args=STRING          remove kernel arguments\n      --set-default=kernel-path     make the first entry referencing the specified kernel the default\n      --set-default-index=INDEX     make the given entry index the default entry\n      --update-kernel=kernel-path   updated information for the specified kernel (ALL, DEFAULT or a path)\n';

const grubby: Command = ({ sh, args }) => {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) return fail(`grubby: unexpected argument ${a}`);
    const eq = a.indexOf('=');
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (GRUBBY_VALUED.includes(key)) {
      if (eq >= 0) values[key] = a.slice(eq + 1);
      else if (i + 1 < args.length) values[key] = args[++i];
      else return fail(`grubby: --${key}: missing argument`);
    } else if (GRUBBY_FLAGS.includes(key) && eq < 0) flags.add(key);
    else return fail(`grubby: bad argument --${key}: unknown option`);
  }
  if (flags.has('help') || (!flags.size && !Object.keys(values).length)) return flags.has('help') ? ok(GRUBBY_USAGE) : fail(GRUBBY_USAGE);
  const state = sh.state;
  const entries = bootEntries(state);
  const def = defaultBootIndex(state);
  if (flags.has('bootloader-probe')) return ok('grub2\n');
  if (flags.has('default-kernel')) return entries[def] ? ok(kpath(entries[def]) + '\n') : ok();
  if (flags.has('default-index')) return ok(entries[def] ? `${def}\n` : '-1\n');
  if (flags.has('default-title')) return entries[def] ? ok(entries[def].title + '\n') : ok();

  /**
   * grubby-bls param_to_indexes: ALL, DEFAULT, an index, TITLE=<title>, or a kernel path. Only the
   * file name of a path counts, so /boot/vmlinuz-X, /vmlinuz-X and vmlinuz-X are the same kernel.
   */
  const indexes = (param: string): number[] => {
    if (param === 'ALL') return entries.map((_, i) => i);
    if (param === 'DEFAULT') return entries[def] ? [def] : [];
    if (/^\d+$/.test(param)) return Number(param) < entries.length ? [Number(param)] : [];
    const file = '/' + param.split('/').pop();
    return entries.flatMap((e, i) => (e.linux === param || e.linux === file || param === `TITLE=${e.title}` ? [i] : []));
  };
  const incorrect = (param: string) => fail(`The param ${param} is incorrect`);

  if ('info' in values) {
    const idx = indexes(values.info);
    if (!idx.length) return incorrect(values.info);
    let out = '';
    for (const i of idx) {
      const e = entries[i];
      const rootArg = entryArgs(e).find((a) => a.startsWith('root='));
      const rest = entryArgs(e).filter((a) => a !== rootArg).join(' ');
      out += `index=${i}\nkernel="${kpath(e)}"\nargs="${rest}"\n`;
      if (rootArg) out += `root="${rootArg.slice(5)}"\n`;
      out += `initrd="${e.initrd ? bootPath(e.initrd) : ''}"\ntitle="${e.title}"\nid="${e.id}"\n`;
    }
    return ok(out);
  }

  const noRoot = needRoot(sh, 'grubby');
  if ('set-default' in values || 'set-default-index' in values) {
    if (noRoot) return noRoot;
    const param = values['set-default'] ?? values['set-default-index'];
    const i = 'set-default' in values ? indexes(param)[0] : /^\d+$/.test(param) && Number(param) < entries.length ? Number(param) : undefined;
    if (i === undefined) return incorrect(param);
    const env = readGrubenv(state.root);
    env.saved_entry = entries[i].id;
    writeGrubenv(state.root, env);
    return ok(`The default is ${entries[i].file} with index ${i} and kernel ${kpath(entries[i])}\n`);
  }
  if ('remove-kernel' in values) {
    if (noRoot) return noRoot;
    const idx = indexes(values['remove-kernel']);
    if (!idx.length) return incorrect(values['remove-kernel']);
    for (const i of idx) removeAt(state.root, entries[i].file);
    return ok();
  }
  if ('update-kernel' in values) {
    if (noRoot) return noRoot;
    const param = values['update-kernel'];
    const idx = indexes(param);
    if (!idx.length) return incorrect(param);
    const add = splitArgs(values.args ?? '');
    const remove = splitArgs(values['remove-args'] ?? '');
    for (const i of idx) {
      entries[i].options = updatedOptions(entries[i].options, remove, add);
      writeEntry(state, entries[i]);
    }
    // like grubby-bls, ALL also changes GRUB_CMDLINE_LINUX so new kernels and grub2-mkconfig keep it:
    // it sources the file (the last line wins) and rewrites every GRUB_CMDLINE_LINUX= line with sed
    const grubDefault = textAt(state.root, '/etc/default/grub');
    if (param === 'ALL' && !flags.has('no-etc-grub-update') && grubDefault !== null && (add.length || remove.length)) {
      const old = readSettings(grubDefault).GRUB_CMDLINE_LINUX;
      if (old !== undefined) {
        const line = `GRUB_CMDLINE_LINUX="${updatedOptions(old, remove, add)}"`;
        putFile(state.root, '/etc/default/grub', grubDefault.replace(/^GRUB_CMDLINE_LINUX=.*$/gm, () => line));
      }
    }
    return ok();
  }
  if ('args' in values || 'remove-args' in values) return fail('grubby: no action specified. Use --update-kernel=ALL (or a kernel path) with --args or --remove-args.');
  return fail(GRUBBY_USAGE);
};

/** Check /etc/default/grub the way sourcing it with sh would; returns the error or null. */
function grubDefaultError(text: string): string | null {
  let open: number | null = null;
  let quote = '';
  text.split('\n').forEach((line, i) => {
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (!quote && ch === '#' && (j === 0 || /\s/.test(line[j - 1]))) break;
      if (!quote && (ch === '"' || ch === "'")) {
        quote = ch;
        open = i + 1;
      } else if (quote && ch === quote && line[j - 1] !== '\\') quote = '';
    }
  });
  return quote ? `/etc/default/grub: line ${open}: unexpected EOF while looking for matching \`${quote}'` : null;
}

const grub2Mkconfig: Command = ({ sh, args, name }) => {
  const { flags, values } = getopts(args, ['o', 'output']);
  if (sh.uid !== 0) return fail(`${name}: You must run this as root`);
  const state = sh.state;
  const outPath = values.o ?? values.output;
  if (outPath && joinPath(splitPath(sh.cwd, outPath, sh.user.home)) === EFI_GRUB_CFG) {
    return fail(`Running \`grub2-mkconfig -o ${outPath}' will overwrite the GRUB wrapper.\nPlease run \`grub2-mkconfig -o /boot/grub2/grub.cfg' instead to update grub.cfg.\nGRUB configuration file was not updated.`);
  }
  const text = textAt(state.root, '/etc/default/grub') ?? '';
  const syntax = grubDefaultError(text);
  if (syntax) return fail(syntax);
  const settings = readSettings(text);
  let err = 'Generating grub configuration file ...\n';
  if (flags.has('update-bls-cmdline')) {
    const cmdline = [settings.GRUB_CMDLINE_LINUX ?? '', settings.GRUB_CMDLINE_LINUX_DEFAULT ?? ''].join(' ').trim();
    for (const e of bootEntries(state)) {
      const rootDev = entryArgs(e).find((a) => a.startsWith('root='))?.slice(5) ?? ROOT_DEVICE;
      e.options = `root=${rootDev} ro ${cmdline}`.trim();
      writeEntry(state, e);
    }
  }
  const cfg = grubCfg(settings);
  if (outPath) {
    try {
      sh.writeFile(outPath, cfg);
    } catch (e) {
      return fail(`${err}/usr/sbin/grub2-mkconfig: line 290: ${outPath}.new: ${e instanceof FsError ? errorText[e.reason] : String(e)}`);
    }
  }
  err += 'Adding boot menu entry for UEFI Firmware Settings ...\ndone\n';
  return result(outPath ? '' : cfg, err, 0);
};

const grub2Install: Command = ({ sh, args }) => {
  if (!args.includes('--force')) {
    return fail('grub2-install: error: This utility should not be used for EFI platforms because it does not support UEFI Secure Boot. If you really wish to proceed, invoke the --force option.\nMake sure Secure Boot is disabled before proceeding.\n(Hint: on a UEFI system like this one, repair the boot loader files with: dnf reinstall grub2-efi-x64 shim-x64)');
  }
  if (sh.uid !== 0) return fail('grub2-install: error: failed to get canonical path of `/boot/efi\': Permission denied.');
  return ok('Installing for x86_64-efi platform.\nInstallation finished. No error reported.\n');
};

const EDITENV_DENIED = (file: string) => `grub2-editenv: error: cannot open \`${file}': Permission denied.`;

const grub2SetDefault: Command = ({ sh, args, name }) => {
  const entry = args.filter((a) => !a.startsWith('--'))[0];
  if (!entry) return fail(`Menu entry not specified.\nUsage: ${name} [OPTION] MENU_ENTRY`);
  if (sh.uid !== 0) return fail(EDITENV_DENIED('/boot/grub2/grubenv.new'));
  const env = readGrubenv(sh.state.root);
  env[name === 'grub2-reboot' ? 'next_entry' : 'saved_entry'] = entry;
  writeGrubenv(sh.state.root, env);
  return ok();
};

const grub2Editenv: Command = ({ sh, args }) => {
  const a = [...args];
  if (a[0] && !['list', 'set', 'unset', 'create'].includes(a[0])) {
    const file = a.shift()!;
    if (file !== '-' && joinPath(splitPath(sh.cwd, file, sh.user.home)) !== '/boot/grub2/grubenv') {
      return fail(`grub2-editenv: error: cannot open \`${file}': No such file or directory.`);
    }
  }
  const [cmd, ...rest] = a;
  const state = sh.state;
  if (!cmd) return fail('Usage: grub2-editenv [OPTION...] FILENAME COMMAND\n  create  list  set [NAME=VALUE ...]  unset [NAME ...]');
  if (sh.uid !== 0) return fail(EDITENV_DENIED(cmd === 'list' ? '/boot/grub2/grubenv' : '/boot/grub2/grubenv.new'));
  const env = readGrubenv(state.root);
  switch (cmd) {
    case 'list':
      return ok(Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''));
    case 'create':
      writeGrubenv(state.root, {});
      return ok();
    case 'set':
      for (const kv of rest) {
        const i = kv.indexOf('=');
        if (i <= 0) return fail(`grub2-editenv: error: invalid parameter ${kv}.`);
        env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      writeGrubenv(state.root, env);
      return ok();
    case 'unset':
      for (const k of rest) delete env[k];
      writeGrubenv(state.root, env);
      return ok();
    default:
      return fail(`grub2-editenv: error: unknown command \`${cmd}'.`);
  }
};

// ---------- dnf and rpm ----------
// RHEL 10 ships dnf 4 (dnf-4.20), not dnf5, so this is dnf 4 output. The dnf* helpers are exported
// so that the dnf for other packages can print the same way.

/** dnf run by a normal user, on a system registered with subscription-manager. */
export const DNF_ROOT =
  'Not root, Subscription Management repositories not updated\nError: This command has to be run with superuser privileges (under the root user on most systems).';

/**
 * What dnf 4 prints first: the subscription-manager plugin, then (for commands that read the
 * repositories, which dnf remove does not) the age of the cached metadata. dnf-makecache.timer
 * refreshes it 10 minutes after boot and then every hour.
 */
export function dnfHead(sh: Shell, repos = true): string {
  const plugin = sh.uid === 0 ? 'Updating Subscription Management repositories.\n' : 'Not root, Subscription Management repositories not updated\n';
  if (!repos) return plugin;
  const now = Date.now();
  const up = Math.max(0, now - sh.state.kernel.bootTime);
  const ago = up < 600000 ? up + 1460000 : (up - 600000) % 3600000;
  const s = Math.floor(ago / 1000);
  return `${plugin}Last metadata expiration check: ${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)} ago on ${rpmDate(now - ago)}.\n`;
}

export const DNF_NOTHING = 'Dependencies resolved.\nNothing to do.\nComplete!\n';
/** dnf 4 when no package matches a name (strict=True: nothing is installed). */
export const dnfNoMatch = (p: string) => `No match for argument: ${p}\nError: Unable to find a match: ${p}\n`;

/** One row of a transaction table: name, version-release, repository, size. */
export type DnfRow = [string, string, string, string];

/**
 * dnf 4's transaction: the package table, the summary and the transaction steps, up to
 * "Running transaction". `sections` are headings like "Installing:" with their rows.
 */
export function dnfTransaction(sections: [string, DnfRow[]][], summary: [string, number][], sizes: string[]): string {
  const rows = sections.flatMap(([, r]) => r);
  const head: DnfRow = ['Package', 'Version', 'Repository', 'Size'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: DnfRow, arch: string) => ` ${r[0].padEnd(w[0])}  ${arch.padEnd(6)}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3].padStart(w[3])}\n`;
  const rule = '='.repeat(w[0] + w[1] + w[2] + w[3] + 15) + '\n';
  let out = `Dependencies resolved.\n${rule}${line(head, 'Arch')}${rule}`;
  for (const [title, r] of sections) if (r.length) out += title + '\n' + r.map((x) => line(x, 'x86_64')).join('');
  out += `\nTransaction Summary\n${rule}`;
  for (const [verb, n] of summary) if (n) out += `${verb.padEnd(8)} ${n} Package${n === 1 ? '' : 's'}\n`;
  out += '\n' + sizes.map((s) => s + '\n').join('');
  return out + 'Running transaction check\nTransaction check succeeded.\nRunning transaction test\nTransaction test succeeded.\nRunning transaction\n';
}

/** dnf 4's closing lists after a transaction ("Installed:", "Removed:") and "Complete!". */
export const dnfDone = (lists: [string, string[]][]) =>
  '\n' + lists.filter(([, l]) => l.length).map(([t, l]) => `${t}\n${l.map((p) => `  ${p}\n`).join('')}`).join('') + '\nComplete!\n';

const BASEOS = 'rhel-10-for-x86_64-baseos-rpms';
/** The kernel packages of one release: name, download size, installed size, summary, description. */
const SUBPACKAGES: [string, string, string, string, string][] = [
  ['kernel', '1.6 M', '0  ', 'The Linux kernel', 'The kernel meta package'],
  ['kernel-core', '18 M', '68 M', 'The Linux kernel', 'The kernel package contains the Linux kernel (vmlinuz), the core of any Linux operating system.'],
  ['kernel-modules', '38 M', '40 M', 'kernel modules to match the core kernel', 'This package provides commonly used kernel modules for the core kernel package.'],
  ['kernel-modules-core', '33 M', '32 M', 'Core kernel modules to match the core kernel', 'This package provides essential kernel modules for the core kernel package.'],
];
const SUBPACKAGE_NAMES = SUBPACKAGES.map(([p]) => p);
const KERNEL_PKG = /^kernel(?:-(core|modules|modules-core))?(?:-(\d[\w.]*-\d[\w.]*?))?(?:\.x86_64)?$/;

/** "kernel-core-6.12.0-124.el10" -> { pkg: "kernel-core", release: "6.12.0-124.el10.x86_64" }. */
export function parseKernelPkg(name: string): { pkg: string; release: string | null } | null {
  const m = KERNEL_PKG.exec(name.replace(/\*$/, ''));
  if (!m) return null;
  return { pkg: m[1] ? `kernel-${m[1]}` : 'kernel', release: m[2] ? `${m[2]}.x86_64` : null };
}

const newestRepoKernel = () => [...REPO_KERNELS].sort(verCmp).pop()!;
/** The repository an installed kernel came from (dnf shows it with @): the installer, BaseOS or unknown. */
const repoOf = (release: string) => (release === RUNNING_KERNEL ? 'anaconda' : REPO_KERNELS.includes(release) ? BASEOS : 'System');
const nvras = (release: string) => SUBPACKAGE_NAMES.map((p) => `${p}-${release}`);

/** Why a kernel request cannot run at all (a version no repository has, the running kernel), or null. */
function kernelDnfProblem(sh: Shell, verb: 'install' | 'remove', pkgs: string[]): CommandResult | null {
  const k = sh.state.kernel;
  if (verb === 'install') {
    const bad = pkgs.find((p) => {
      const r = parseKernelPkg(p)!.release;
      return r && !REPO_KERNELS.includes(r);
    });
    return bad ? result('', dnfNoMatch(bad), 1) : null;
  }
  const releases = kernelRemoveSet(sh, pkgs).releases;
  if (releases.includes(k.running)) {
    return result('', `Error: \n Problem: The operation would result in removing of running kernel: kernel-core-${k.running}\n`, 1);
  }
  return null;
}

/** dnf install/upgrade of kernel packages (output without dnfHead). Kernels are installed next to the old ones. */
function dnfInstall(sh: Shell, pkgs: string[], upgrade: boolean): CommandResult {
  const k = sh.state.kernel;
  let release = newestRepoKernel();
  for (const p of pkgs) release = parseKernelPkg(p)!.release ?? release;
  if (k.installed.includes(release)) {
    return ok((upgrade ? '' : `Package kernel-${release} is already installed.\n`) + DNF_NOTHING);
  }
  installKernel(sh.state, release);
  // installonly_limit: drop the lowest versions, never the running kernel or the new one
  const limit = installonlyLimit(sh.state);
  const removed: string[] = [];
  if (limit >= 2) {
    for (const old of [...k.installed].sort(verCmp)) {
      if (k.installed.length <= limit) break;
      if (old === k.running || old === release) continue;
      removeKernel(sh.state, old);
      removed.push(old);
    }
  }
  // dnf upgrade lists every installonly package as installed; dnf install pulls the rest in as dependencies
  const asked = upgrade ? SUBPACKAGE_NAMES : [...new Set(pkgs.map((p) => parseKernelPkg(p)!.pkg))];
  const row = (p: string, r: string, repo: string, size: string): DnfRow => [p, pkgVersion(r), repo, size];
  const table = dnfTransaction(
    [
      ['Installing:', SUBPACKAGES.filter(([p]) => asked.includes(p)).map(([p, dl]) => row(p, release, BASEOS, dl))],
      ['Installing dependencies:', SUBPACKAGES.filter(([p]) => !asked.includes(p)).map(([p, dl]) => row(p, release, BASEOS, dl))],
      ['Removing:', removed.flatMap((r) => SUBPACKAGES.map(([p, , inst]) => row(p, r, '@' + repoOf(r), inst)))],
    ],
    [['Install', 4], ['Remove', removed.length * 4]],
    ['Total download size: 91 M', 'Installed size: 140 M'],
  );
  return ok(
    table + dnfDone([['Installed:', nvras(release)], ['Removed:', removed.flatMap(nvras)]]) +
      `(The new kernel is installed next to the old one${removed.length ? ` and the oldest kernel was removed (installonly_limit=${limit})` : ''}. It is the default boot entry now, but "uname -r" shows ${k.running} until you reboot.)\n`,
  );
}

/** Which installed kernels a dnf remove means, and the arguments that match none. */
function kernelRemoveSet(sh: Shell, pkgs: string[]): { releases: string[]; missing: string[] } {
  const k = sh.state.kernel;
  const releases = new Set<string>();
  const missing: string[] = [];
  for (const p of pkgs) {
    const parsed = parseKernelPkg(p)!;
    if (parsed.release && !k.installed.includes(parsed.release)) missing.push(p);
    else for (const r of parsed.release ? [parsed.release] : k.installed) releases.add(r);
  }
  return { releases: [...releases], missing };
}

/** dnf remove of kernel packages (output without dnfHead). */
function dnfRemove(sh: Shell, pkgs: string[]): CommandResult {
  const problem = kernelDnfProblem(sh, 'remove', pkgs);
  if (problem) return problem;
  const { releases, missing } = kernelRemoveSet(sh, pkgs);
  let out = missing.map((p) => `No match for argument: ${p}\n`).join('');
  if (!releases.length) return ok(out + 'No packages marked for removal.\n' + DNF_NOTHING);
  for (const r of releases) removeKernel(sh.state, r);
  const asked = [...new Set(pkgs.map((p) => parseKernelPkg(p)!.pkg))];
  const rows = (keep: (p: string) => boolean) =>
    releases.flatMap((r) => SUBPACKAGES.filter(([p]) => keep(p)).map(([p, , inst]): DnfRow => [p, pkgVersion(r), '@' + repoOf(r), inst]));
  out += dnfTransaction(
    [
      ['Removing:', rows((p) => asked.includes(p))],
      [asked.includes('kernel') ? 'Removing unused dependencies:' : 'Removing dependent packages:', rows((p) => !asked.includes(p))],
    ],
    [['Remove', releases.length * 4]],
    [`Freed space: ${releases.length * 140} M`],
  );
  return ok(out + dnfDone([['Removed:', releases.flatMap(nvras)]]));
}

/** The kernel package names that dnf arguments such as kernel, kernel-core or kernel* mean. */
const kernelNames = (pkgs: string[]) =>
  [...new Set(pkgs.flatMap((p) => (p.endsWith('*') ? SUBPACKAGE_NAMES.filter((s) => s.startsWith(parseKernelPkg(p)!.pkg)) : [parseKernelPkg(p)!.pkg])))];

function dnfList(sh: Shell, pkgs: string[], opts: { installed: boolean; available: boolean; all: boolean }): CommandResult {
  const k = sh.state.kernel;
  const names = kernelNames(pkgs);
  const line = (pkg: string, rel: string, repo: string) => `${(pkg + '.x86_64').padEnd(34)} ${pkgVersion(rel).padEnd(22)} ${repo}\n`;
  let out = '';
  if (!opts.available && k.installed.length) {
    out += 'Installed Packages\n';
    for (const n of names) for (const r of k.installed) out += line(n, r, '@' + repoOf(r));
  }
  const newest = [...k.installed].sort(verCmp).pop() ?? '';
  // --showduplicates: every version the repository has that is not installed; otherwise only a newer one
  const avail = REPO_KERNELS.filter((r) => (opts.all ? !k.installed.includes(r) : verCmp(r, newest) > 0));
  if (!opts.installed && avail.length) {
    out += 'Available Packages\n';
    for (const n of names) for (const r of avail) out += line(n, r, BASEOS);
  }
  return out ? ok(dnfHead(sh) + out) : fail(dnfHead(sh) + 'Error: No matching Packages to list');
}

function dnfInfo(sh: Shell, pkgs: string[]): CommandResult {
  const k = sh.state.kernel;
  const names = kernelNames(pkgs);
  const block = (name: string, r: string, installed: boolean) => {
    const [, dl, inst, summary, desc] = SUBPACKAGES.find(([p]) => p === name)!;
    const f = (key: string, v: string) => `${key.padEnd(12)} : ${v}\n`;
    return (
      f('Name', name) + f('Version', r.split('-')[0]) + f('Release', pkgVersion(r).split('-')[1]) + f('Architecture', 'x86_64') +
      f('Size', installed ? inst.replace(/^0 +$/, '0.0  ') : dl) + f('Source', `kernel-${pkgVersion(r)}.src.rpm`) +
      (installed ? f('Repository', '@System') + f('From repo', repoOf(r)) : f('Repository', BASEOS)) +
      f('Summary', summary) + f('URL', 'https://www.kernel.org/') + f('License', 'GPL-2.0-only') +
      f('Description', desc)
    );
  };
  let out = dnfHead(sh) + 'Installed Packages\n' + names.flatMap((n) => k.installed.map((r) => block(n, r, true))).join('\n');
  const newest = newestRepoKernel();
  if (!k.installed.includes(newest)) out += '\nAvailable Packages\n' + names.map((n) => block(n, newest, false)).join('\n');
  return ok(out);
}

let inBaseDnf = false; // set while kernelDnf runs the normal dnf for the other packages

/**
 * dnf requests that concern kernel packages (install/update kernel). Returns null to let dnf
 * handle it. When kernel and other packages are mixed, the other packages go to the normal dnf.
 */
export function kernelDnf(ctx: CommandContext): CommandResult | null {
  const { sh, args } = ctx;
  if (inBaseDnf) return null;
  const words: number[] = []; // indexes of the words that are not options
  let excludeKernel = false;
  const opts = { installed: false, available: false, all: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-x' || a === '--exclude') {
      if (/^kernel/.test(args[i + 1] ?? '')) excludeKernel = true;
      i++;
    } else if (/^(--exclude=|-x)kernel/.test(a)) excludeKernel = true;
    else if (a === '--showduplicates') opts.all = true;
    else if (a === '--installed') opts.installed = true;
    else if (a === '--available') opts.available = true;
    else if (!a.startsWith('-')) words.push(i);
  }
  const verb = args[words[0]];
  let pkgIdx = words.slice(1);
  if (verb === 'list' && ['installed', 'available'].includes(args[pkgIdx[0]] ?? '')) {
    opts[args[pkgIdx[0]] as 'installed' | 'available'] = true;
    pkgIdx = pkgIdx.slice(1);
  }
  const pkgs = pkgIdx.map((i) => args[i]);
  const kernelIdx = pkgIdx.filter((i) => parseKernelPkg(args[i]));
  const kernelPkgs = kernelIdx.map((i) => args[i]);
  const onlyKernel = pkgs.length > 0 && kernelPkgs.length === pkgs.length;
  const mixed = kernelPkgs.length > 0 && !onlyKernel;
  const k = sh.state.kernel;

  /** Run the kernel part, after the normal dnf has done the other packages (its answer goes first). */
  const withOthers = (verb: 'install' | 'remove', run: () => CommandResult): CommandResult => {
    const head = dnfHead(sh, verb === 'install');
    // on failure the whole answer goes to stderr, so that the terminal shows it in order
    const headed = (r: CommandResult) => (r.code ? fail(head + r.stdout + r.stderr, r.code) : { ...r, stdout: head + r.stdout });
    if (!mixed) return headed(run());
    // dnf does all or nothing: check the kernel part before the other packages change
    const problem = kernelDnfProblem(sh, verb, kernelPkgs);
    if (problem) return headed(problem);
    inBaseDnf = true;
    let base: CommandResult;
    try {
      base = sh.exec(['dnf', ...args.filter((_, i) => !kernelIdx.includes(i))]);
    } finally {
      inBaseDnf = false;
    }
    if (base.code !== 0) return base;
    const own = [dnfHead(sh, verb === 'install'), dnfHead(sh, false), 'Updating and loading repositories:\nRepositories loaded.\n'];
    const rest = own.reduce((s, h) => (s.startsWith(h) ? s.slice(h.length) : s), base.stdout);
    const r = run();
    return result(head + rest + r.stdout, base.stderr + r.stderr, r.code);
  };

  switch (verb) {
    case 'install':
      if (!kernelPkgs.length) return null;
      if (sh.uid !== 0) return fail(DNF_ROOT);
      return withOthers('install', () => kernelDnfProblem(sh, 'install', kernelPkgs) ?? dnfInstall(sh, kernelPkgs, false));
    case 'update':
    case 'upgrade':
      if (excludeKernel || (pkgs.length && !kernelPkgs.length)) return null;
      if (!pkgs.length && k.installed.includes(newestRepoKernel())) return null;
      if (sh.uid !== 0) return fail(DNF_ROOT);
      return withOthers('install', () => kernelDnfProblem(sh, 'install', kernelPkgs) ?? dnfInstall(sh, kernelPkgs, true));
    case 'remove':
    case 'erase':
      if (!kernelPkgs.length) return null;
      if (sh.uid !== 0) return fail(DNF_ROOT);
      return withOthers('remove', () => dnfRemove(sh, kernelPkgs));
    case 'list':
      return onlyKernel ? dnfList(sh, pkgs, opts) : null;
    case 'info':
      return onlyKernel ? dnfInfo(sh, pkgs) : null;
    case 'check-update':
    case 'check-upgrade': {
      const newest = newestRepoKernel();
      if (k.installed.includes(newest) || excludeKernel) return ok(dnfHead(sh));
      return result(dnfHead(sh) + '\n' + SUBPACKAGE_NAMES.map((p) => `${(p + '.x86_64').padEnd(34)} ${pkgVersion(newest).padEnd(22)} ${BASEOS}\n`).join(''), '', 100);
    }
    default:
      return null;
  }
}

function rpmFiles(pkg: string, r: string): string[] {
  if (pkg === 'kernel') return ['(contains no files)'];
  if (pkg === 'kernel-core') return [`/boot/.vmlinuz-${r}.hmac`, `/boot/System.map-${r}`, `/boot/config-${r}`, `/boot/initramfs-${r}.img`, `/boot/vmlinuz-${r}`, `/lib/modules/${r}/vmlinuz`];
  const core = pkg === 'kernel-modules-core';
  return Object.values(MODULES).filter((m) => !!m.boot === core).map((m) => `/lib/modules/${r}/${m.path}`);
}

let inBaseRpm = false; // set while kernelRpm runs the normal rpm

/** Run the normal rpm, for packages other than the kernel. */
function baseRpm(sh: Shell, args: string[]): CommandResult {
  inBaseRpm = true;
  try {
    return sh.exec(['rpm', ...args]);
  } finally {
    inBaseRpm = false;
  }
}

const RPM_FLAGS: Record<string, string> = { q: 'query', a: 'all', i: 'info', l: 'list', f: 'file' };

/** Which kernel package owns a path (rpm -qf), or null if it is not a kernel file. */
function kernelFileOwner(installed: string[], path: string): string | null {
  const boot = /^\/boot\/\.?(?:vmlinuz|initramfs|System\.map|config)-(.+?)(?:\.img|\.hmac)?$/.exec(path);
  if (boot) return installed.includes(boot[1]) ? `kernel-core-${boot[1]}` : null;
  const lib = /^\/(?:usr\/)?lib\/modules\/([^/]+)\/(.+)$/.exec(path);
  if (!lib || !installed.includes(lib[1])) return null;
  if (lib[2] === 'vmlinuz') return `kernel-core-${lib[1]}`;
  const mod = Object.values(MODULES).find((m) => m.path === lib[2]);
  return mod ? `${mod.boot ? 'kernel-modules-core' : 'kernel-modules'}-${lib[1]}` : null;
}

/** An installed package as rpm queries see it. `release` is the kernel release for kernel packages. */
interface RpmPkg {
  name: string;
  version: string;
  release: string;
  arch: string;
  time: number; // install time (ms)
  kernel: string | null;
}

const nvra = (p: RpmPkg) => `${p.name}-${p.version}-${p.release}.${p.arch}`;

function kernelPkg(k: SystemState['kernel'], name: string, r: string): RpmPkg {
  return { name, version: r.split('-')[0], release: pkgVersion(r).split('-')[1], arch: 'x86_64', time: k.installedAt[r] ?? Date.now(), kernel: r };
}

/** "bash-5.2.26-6.el10.x86_64" from the normal rpm, as a package; null for other lines. */
function parseNvra(line: string, time: number): RpmPkg | null {
  const m = /^(.+)-([^-]+)-([^-]+)\.([^.\s]+)$/.exec(line.trim());
  return m ? { name: m[1], version: m[2], release: m[3], arch: m[4], time, kernel: null } : null;
}

/** rpm --queryformat: %{TAG}, %-20{TAG}, %{INSTALLTIME:date} and backslash escapes. null for an unknown tag. */
function rpmQueryFormat(fmt: string, p: RpmPkg): string | null {
  const summary = SUBPACKAGES.find(([n]) => n === p.name)?.[3] ?? AVAILABLE_PACKAGES[pkgKey(p.name)]?.summary ?? '(none)';
  const tags: Record<string, string> = {
    NAME: p.name, VERSION: p.version, RELEASE: p.release, ARCH: p.arch, EPOCH: '(none)', SUMMARY: summary,
    NVR: `${p.name}-${p.version}-${p.release}`, NVRA: nvra(p), NEVRA: nvra(p), NEVR: `${p.name}-${p.version}-${p.release}`,
    INSTALLTIME: String(Math.floor(p.time / 1000)), VENDOR: 'Red Hat, Inc.', LICENSE: p.kernel ? 'GPL-2.0-only' : '(none)',
    SOURCERPM: p.kernel ? `kernel-${p.version}-${p.release}.src.rpm` : `${p.name}-${p.version}-${p.release}.src.rpm`,
  };
  let bad = false;
  const text = fmt.replace(/%(-?\d*)\{(\w+)(?::(\w+))?\}/g, (_m, width: string, tag: string, conv: string | undefined) => {
    let v = tags[tag.toUpperCase()];
    if (v === undefined) {
      bad = true;
      return '';
    }
    if (conv === 'date' && /TIME$/i.test(tag)) v = rpmDate(Number(v) * 1000);
    const n = Math.abs(Number(width) || 0);
    return width.startsWith('-') ? v.padEnd(n) : v.padStart(n);
  });
  if (bad) return null;
  const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', '\\': '\\', '"': '"' };
  return text.replace(/\\(.)/g, (m, c: string) => esc[c] ?? m);
}

/** rpm's glob match for -qa PATTERN: against the name, or the name with version and release. */
function rpmMatch(p: RpmPkg, globs: string[]): boolean {
  if (!globs.length) return true;
  const re = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  const forms = [p.name, `${p.name}-${p.version}`, `${p.name}-${p.version}-${p.release}`, nvra(p)];
  return globs.some((g) => forms.some((f) => re(g).test(f)));
}

/** rpm queries for kernel packages (rpm -q kernel, rpm -qa). Returns null to let rpm handle it. */
export function kernelRpm(ctx: CommandContext): CommandResult | null {
  const { sh, args } = ctx;
  if (inBaseRpm) return null;
  const f = new Set<string>();
  const ops: string[] = [];
  let qf: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = /^--(?:qf|queryformat)=([\s\S]*)$/.exec(a);
    if (eq) qf = eq[1];
    else if (a === '--qf' || a === '--queryformat') qf = args[++i] ?? '';
    else if (['--last', '--query', '--all', '--info', '--list', '--file'].includes(a)) f.add(a.slice(2));
    else if (a.startsWith('--')) return null;
    else if (a.startsWith('-') && a.length > 1) for (const ch of a.slice(1)) f.add(RPM_FLAGS[ch] ?? ch);
    else ops.push(a);
  }
  if (!f.has('query')) return null;
  const k = sh.state.kernel;

  if (f.has('file')) {
    if (!ops.every((p) => /^\/(boot|(usr\/)?lib\/modules)\//.test(p))) return null;
    let out = '';
    let code = 0;
    for (const p of ops) {
      const owner = kernelFileOwner(k.installed, p);
      if (!owner) code = 1;
      out += owner ? owner + '\n' : `file ${p} is not owned by any package\n`;
    }
    return result(out, '', code);
  }

  const kernels = k.installed.flatMap((r) => ['kernel-core', 'kernel-modules-core', 'kernel-modules', 'kernel'].map((n) => kernelPkg(k, n, r)));
  const systemTime = k.installedAt[RUNNING_KERNEL] ?? k.bootTime - 86400000; // when the other packages came
  let pkgs: (RpmPkg | string)[]; // a string is a line of the normal rpm's answer, such as "package x is not installed"

  if (f.has('all')) {
    // rpm -qa [PATTERN...]: the normal list plus the kernel packages
    const base = baseRpm(sh, ['-qa']);
    if (base.code !== 0) return base;
    const others = base.stdout.split('\n').filter(Boolean).map((l) => parseNvra(l, systemTime) ?? l);
    pkgs = [...others, ...kernels].filter((p) => typeof p !== 'string' && rpmMatch(p, ops));
    if ((f.has('info') || f.has('list')) && pkgs.some((p) => typeof p !== 'string' && !p.kernel)) return null;
  } else {
    if (!ops.length) return null;
    if (!ops.some((o) => parseKernelPkg(o)) && qf === null) return null;
    if ((f.has('info') || f.has('list')) && !ops.every((o) => parseKernelPkg(o))) return null;
    pkgs = ops.flatMap((op): (RpmPkg | string)[] => {
      const p = parseKernelPkg(op);
      if (!p) {
        const line = baseRpm(sh, ['-q', op]).stdout.split('\n')[0] ?? '';
        return [(!line.startsWith('package ') && parseNvra(line, systemTime)) || line];
      }
      if (p.release && !k.installed.includes(p.release)) return [`package ${op} is not installed`];
      return (p.release ? [p.release] : k.installed).map((r) => kernelPkg(k, p.pkg, r));
    });
  }

  if (f.has('last')) {
    pkgs = pkgs.map((p, i) => ({ p, i })).sort((a, b) => (typeof b.p === 'string' ? 0 : b.p.time) - (typeof a.p === 'string' ? 0 : a.p.time) || a.i - b.i).map((x) => x.p);
  }
  let out = '';
  let code = 0;
  for (const p of pkgs) {
    if (typeof p === 'string') {
      out += p + '\n';
      code = 1;
    } else if (qf !== null) {
      const s = rpmQueryFormat(qf, p);
      if (s === null) return fail('error: incorrect format: unknown tag');
      out += s;
    } else if (f.has('info')) {
      const summary = SUBPACKAGES.find(([n]) => n === p.name)?.[3] ?? '';
      out += `Name        : ${p.name}\nVersion     : ${p.version}\nRelease     : ${p.release}\nArchitecture: x86_64\nInstall Date: ${rpmDate(p.time)}\nGroup       : Unspecified\nLicense     : GPL-2.0-only\nSource RPM  : kernel-${p.version}-${p.release}.src.rpm\nVendor      : Red Hat, Inc.\nURL         : https://www.kernel.org/\nSummary     : ${summary}\n`;
    } else if (f.has('list')) out += rpmFiles(p.name, p.kernel!).join('\n') + '\n';
    else if (f.has('last')) out += `${nvra(p).padEnd(45)} ${rpmDate(p.time)}\n`;
    else out += nvra(p) + '\n';
  }
  return result(out, '', code);
}

// ---------- exports ----------

export const KERNEL_COMMANDS: Record<string, Command> = {
  uname, reboot, shutdown, poweroff, halt: poweroff,
  lsmod, modprobe, modinfo, rmmod, insmod, depmod, dmesg, sysctl, dracut,
  grubby, 'grub2-mkconfig': grub2Mkconfig, 'grub2-set-default': grub2SetDefault, 'grub2-reboot': grub2SetDefault,
  'grub2-editenv': grub2Editenv, 'grub2-install': grub2Install,
};

export const KERNEL_MAN: Record<string, string> = {
  uname: 'print system information. -r kernel release, -a everything, -n host name, -m machine',
  reboot: 'reboot the system (needs root). Settings in files are kept; runtime-only changes are lost',
  shutdown: 'power off or reboot the machine. shutdown -r now reboots, shutdown -h now powers off',
  poweroff: 'power off the machine',
  halt: 'halt the machine',
  lsmod: 'show the loaded kernel modules: name, size and what uses them',
  modprobe: 'add and remove kernel modules with their dependencies. modprobe NAME, -r NAME removes, -v shows what it does. Options go in /etc/modprobe.d/*.conf',
  modinfo: 'show information about a kernel module: file name, description, depends and parm (parameters)',
  rmmod: 'remove one module from the kernel (no dependencies; modprobe -r is usually better)',
  insmod: 'insert one module file into the kernel (no dependencies; modprobe is usually better)',
  depmod: 'generate modules.dep, the list of module dependencies',
  dmesg: 'print the kernel ring buffer: hardware and driver messages. -T readable times, -l err errors only',
  sysctl: 'show or set kernel parameters at runtime. sysctl -w key=value for now, a file in /etc/sysctl.d/ for every boot, sysctl -p FILE or --system to load files',
  dracut: 'create an initramfs image. dracut -f rebuilds the one for the running kernel, --regenerate-all for every kernel',
  grubby: 'show and change boot entries. --default-kernel, --info=ALL, --set-default=PATH, --update-kernel=ALL --args="..." --remove-args="..."',
  'grub2-mkconfig': 'generate grub.cfg. After editing /etc/default/grub: grub2-mkconfig -o /boot/grub2/grub.cfg --update-bls-cmdline',
  'grub2-set-default': 'set the default boot entry (saved_entry in /boot/grub2/grubenv)',
  'grub2-reboot': 'boot a menu entry once, at the next reboot only',
  'grub2-editenv': 'edit the GRUB environment block. grub2-editenv list shows saved_entry',
  'grub2-install': 'install GRUB to a disk (BIOS systems). On UEFI systems reinstall the grub2-efi-x64 and shim-x64 packages instead',
};

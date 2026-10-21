// Storage commands for the simulated server: lsblk, blkid, df, du, free, findmnt, fdisk, parted,
// partprobe, wipefs, mkfs.*, mkswap, swapon/swapoff, mount/umount, xfs and ext4 tools, and LVM.
// They work on Shell.state.storage (see storage-state.ts) and print what RHEL 10 prints.

import type { CommandContext, CommandResult } from './commands';
import { FsError, FsNode, canAccess, errorText, joinPath } from './fs';
import type { Shell } from './shell';
import type { SystemState } from './state';
import {
  BlockDevice,
  DISK_MODEL,
  Disk,
  FileSystem,
  FsType,
  GiB,
  KNOWN_FS,
  KiB,
  LogicalVolume,
  MiB,
  Mount,
  NETWORK_FS,
  PSEUDO_MOUNTS,
  Partition,
  PhysicalVolume,
  SECTOR,
  StorageState,
  VolumeGroup,
  attachMount,
  badOption,
  detachMount,
  deviceBusy,
  dmName,
  ext4JournalBlocks,
  findDevice,
  freshRoot,
  freshUsed,
  fsUsage,
  isSwapOn,
  kernelOptions,
  listDevices,
  lookup,
  lvExtents,
  mountAt,
  mountsOf,
  newDosId,
  newLvmUuid,
  newUuid,
  newVfatId,
  parseFstab,
  partPath,
  partSectors,
  planMount,
  planSwap,
  pvExtentCount,
  pvUsedExtents,
  pvsOf,
  readFstab,
  signatureOf,
  swapKiB,
  syncDev,
  vgByName,
  vgFreeExtents,
  vgTotalExtents,
  xfsLogSize,
} from './storage-state';

type Command = (ctx: CommandContext) => CommandResult;

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
const fail = (stderr: string, code = 1, stdout = ''): CommandResult => ({
  stdout,
  stderr: !stderr || stderr.endsWith('\n') ? stderr : stderr + '\n',
  code,
});
const SUDO = '(Hint: try running it with sudo)';
const NO_PROMPT = (fix: string) => `(This terminal cannot answer prompts. ${fix})`;
const DMESG = '       dmesg(1) may have more information after failed mount system call.';
const E2FS = 'mke2fs 1.47.1 (20-May-2024)';
const RESIZE2FS = 'resize2fs 1.47.1 (20-May-2024)';

/** Split args into flags and operands. `valued` options take the next arg; `multi` keeps repeats. */
function getopts(args: string[], valued: string[] = []) {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const operands: string[] = [];
  const set = (k: string, v: string) => {
    values[k] = v;
    (multi[k] ??= []).push(v);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) set(k, a.slice(eq + 1));
      else if (valued.includes(k)) set(k, args[++i] ?? '');
      else flags.add(k);
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (valued.includes(f)) {
          set(f, a.slice(j + 1) || args[++i] || '');
          break;
        }
        flags.add(f);
      }
    } else operands.push(a);
  }
  return { flags, values, multi, operands };
}

const st = (sh: Shell): StorageState => sh.state.storage;
const yesAnswer = (stdin: string) => /^\s*y/i.test(stdin);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- number formatting ----------

/** util-linux size_to_human_string: 18.4G, 600M (lsblk), or with space and iB: 16.41 GiB (fdisk). */
function humanSize(bytes: number, opt: { space?: boolean; iec?: boolean; two?: boolean } = {}): string {
  let exp = 0;
  while (exp < 60 && bytes >= 2 ** (exp + 10)) exp += 10;
  const letter = 'BKMGTPE'[exp / 10];
  let dec = Math.floor(bytes / 2 ** exp);
  const frac = exp ? bytes - dec * 2 ** exp : 0;
  let digits = '';
  if (frac) {
    const f3 = Math.floor((frac * 1000) / 2 ** exp);
    let f = opt.two ? Math.floor((f3 + 5) / 10) : Math.floor((f3 + 50) / 100) * 10;
    if (f >= 100) {
      dec++;
      f = 0;
    }
    if (f) digits = '.' + String(f).padStart(2, '0').replace(/0$/, '');
  }
  const suffix = letter === 'B' ? 'B' : letter + (opt.iec ? 'iB' : '');
  return `${dec}${digits}${opt.space ? ' ' : ''}${suffix}`;
}

/** LVM sizes: 16.41g, <18.41g, 0 (short) or 16.41 GiB (long). '<' marks a value rounded up. */
function lvmSize(bytes: number, long = false): string {
  if (bytes <= 0) return long ? '0   ' : '0 ';
  const units = long ? [' B', ' KiB', ' MiB', ' GiB', ' TiB', ' PiB'] : ['b', 'k', 'm', 'g', 't', 'p'];
  let e = 0;
  while (e < 5 && bytes >= 1024 ** (e + 1)) e++;
  const d = bytes / 1024 ** e;
  const shown = d.toFixed(e === 0 ? 0 : 2);
  return (Number(shown) > d + 1e-9 ? '<' : '') + shown + units[e];
}

/** coreutils df -h / du -h: powers of 1024, rounded up, one decimal below 10. -H uses powers of 1000. */
function dfHuman(bytes: number, si = false): string {
  if (bytes <= 0) return '0';
  const base = si ? 1000 : 1024;
  const units = si ? ['', 'k', 'M', 'G', 'T', 'P'] : ['', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let e = 0;
  while (v >= base && e < units.length - 1) {
    v /= base;
    e++;
  }
  if (e === 0) return String(Math.ceil(v));
  if (v < 10) {
    const t = Math.ceil(v * 10 - 1e-9) / 10;
    if (t < 10) return t.toFixed(1) + units[e];
    v = t;
  }
  const n = Math.ceil(v - 1e-9);
  return n >= base && e < units.length - 1 ? '1.0' + units[e + 1] : n + units[e];
}

/** Right- or left-aligned columns, one space apart, no trailing spaces. */
function columns(rows: string[][], right: boolean[] = [], indent = '', headRight = true): string {
  if (!rows.length) return '';
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows
    .map((r, ri) =>
      (indent + r.map((c, i) => ((right[i] && (headRight || ri > 0)) ? c.padStart(w[i]) : c.padEnd(w[i]))).join(' ')).trimEnd(),
    )
    .join('\n') + '\n';
}

// ---------- device helpers ----------

/** Turn a user-given path (relative, with symlinks) into a canonical absolute path. */
function canonical(sh: Shell, path: string): string | null {
  try {
    return joinPath(sh.resolve(path).parts);
  } catch {
    return null;
  }
}

/** Device for a user argument: /dev paths, /dev/vg/lv, UUID=, LABEL=. */
const dev = (sh: Shell, spec: string) => findDevice(st(sh), spec);

function childrenOf(s: StorageState, d: BlockDevice): BlockDevice[] {
  const all = listDevices(s);
  if (d.type === 'disk') {
    const parts = all.filter((x) => x.type === 'part' && x.disk === d.disk);
    return [...parts, ...lvsOnPv(s, d.path, all)];
  }
  if (d.type === 'part') return lvsOnPv(s, d.path, all);
  return [];
}
const lvsOnPv = (s: StorageState, path: string, all: BlockDevice[]) =>
  all.filter((x) => x.lv?.segments.some((seg) => seg.pv === path));

function mountpoints(s: StorageState, d: BlockDevice): string[] {
  const m = mountsOf(s, d.path).map((x) => x.target);
  if (isSwapOn(s, d.path)) m.push('[SWAP]');
  return m;
}

function fsVersion(sig: string | null): string {
  return sig === 'ext4' ? '1.0' : sig === 'vfat' ? 'FAT32' : sig === 'swap' ? '1' : sig === 'LVM2_member' ? 'LVM2 001' : '';
}

function gptTypeName(p: Partition): string {
  const f = p.flags;
  if (f.includes('esp')) return 'EFI System';
  if (f.includes('lvm')) return 'Linux LVM';
  if (f.includes('swap')) return 'Linux swap';
  if (f.includes('raid')) return 'Linux RAID';
  if (f.includes('msftdata')) return 'Microsoft basic data';
  if (f.includes('bios_grub')) return 'BIOS boot';
  if (f.includes('bls_boot')) return 'Linux extended boot';
  if (f.includes('linux-home')) return 'Linux home';
  return 'Linux filesystem';
}
function dosType(p: Partition): [string, string] {
  const f = p.flags;
  if (p.kind === 'extended') return ['5', 'Extended'];
  if (f.includes('lvm')) return ['8e', 'Linux LVM'];
  if (f.includes('swap')) return ['82', 'Linux swap / Solaris'];
  if (f.includes('raid')) return ['fd', 'Linux raid autodetect'];
  if (f.includes('esp')) return ['ef', 'EFI (FAT-12/16/32)'];
  if (f.includes('lba')) return ['c', 'W95 FAT32 (LBA)'];
  return ['83', 'Linux'];
}

/** Things that keep a device busy, as mkfs/parted/wipefs see it (including its partitions). */
function busy(s: StorageState, d: BlockDevice): boolean {
  if (deviceBusy(s, d)) return true;
  if (d.type === 'disk') return listDevices(s).some((x) => x.disk === d.disk && x.type === 'part' && deviceBusy(s, x));
  return false;
}

/** Remove every signature on a device (and the partitions of a disk) before a new one is written. */
function wipeDevice(s: StorageState, d: BlockDevice) {
  const drop = new Set([d.path]);
  if (d.type === 'disk' && d.disk) {
    for (const p of d.disk.partitions) drop.add(partPath(d.disk.name, p.number));
    d.disk.table = null;
    d.disk.partitions = [];
    d.disk.ptuuid = '';
  }
  s.pvs = s.pvs.filter((p) => !drop.has(p.device) || p.vg !== '');
  d.holder.fs = undefined;
}

// ---------- lsblk ----------

interface LsCol {
  head: string;
  right?: boolean;
  /** libsmartcols width hint: the column is never narrower than this. */
  min?: number;
  val: (d: BlockDevice) => string[];
}

function lsblkCols(s: StorageState, bytes: boolean, fullPath: boolean): Record<string, LsCol> {
  const one = (v: string | undefined) => [v ?? ''];
  const usage = (d: BlockDevice) => {
    const fs = d.holder.fs;
    return fs && mountsOf(s, d.path).length && fs.type !== 'swap' ? fsUsage(fs) : null;
  };
  const size = (n: number) => (bytes ? String(n) : humanSize(n));
  const parent = (d: BlockDevice) => (d.type === 'part' ? d.disk?.name : undefined);
  return {
    NAME: { head: 'NAME', val: (d) => one(fullPath ? d.path : d.name) },
    KNAME: { head: 'KNAME', val: (d) => one(d.kname) },
    PATH: { head: 'PATH', val: (d) => one(d.path) },
    'MAJ:MIN': { head: 'MAJ:MIN', val: (d) => one(`${String(d.major).padStart(3)}:${String(d.minor).padEnd(3)}`) },
    RM: { head: 'RM', right: true, val: () => one('0') },
    RO: { head: 'RO', right: true, val: () => one('0') },
    SIZE: { head: 'SIZE', right: true, min: 5, val: (d) => one(size(d.size)) },
    TYPE: { head: 'TYPE', val: (d) => one(d.type) },
    MOUNTPOINT: { head: 'MOUNTPOINT', val: (d) => one(mountpoints(s, d)[0]) },
    MOUNTPOINTS: { head: 'MOUNTPOINTS', val: (d) => mountpoints(s, d) },
    FSTYPE: { head: 'FSTYPE', val: (d) => one(signatureOf(s, d) ?? '') },
    FSVER: { head: 'FSVER', val: (d) => one(fsVersion(signatureOf(s, d))) },
    LABEL: { head: 'LABEL', val: (d) => one(d.holder.fs?.label) },
    UUID: { head: 'UUID', min: 36, val: (d) => one(d.holder.fs?.uuid ?? s.pvs.find((p) => p.device === d.path)?.uuid) },
    FSAVAIL: { head: 'FSAVAIL', right: true, val: (d) => one(usage(d) ? size(usage(d)!.avail) : '') },
    FSSIZE: { head: 'FSSIZE', right: true, val: (d) => one(usage(d) ? size(usage(d)!.size) : '') },
    FSUSED: { head: 'FSUSED', right: true, val: (d) => one(usage(d) ? size(usage(d)!.used) : '') },
    'FSUSE%': {
      head: 'FSUSE%',
      right: true,
      val: (d) => {
        const u = usage(d);
        return one(u ? `${Math.round(((u.size - u.avail) / u.size) * 100)}%` : '');
      },
    },
    PARTUUID: { head: 'PARTUUID', min: 36, val: (d) => one(d.part?.partuuid) },
    PARTLABEL: { head: 'PARTLABEL', val: (d) => one(d.part?.name) },
    PARTTYPENAME: {
      head: 'PARTTYPENAME',
      val: (d) => one(d.part ? (d.disk?.table === 'gpt' ? gptTypeName(d.part) : dosType(d.part)[1]) : ''),
    },
    PTUUID: { head: 'PTUUID', min: 36, val: (d) => one(d.disk?.table ? d.disk.ptuuid : '') },
    PTTYPE: { head: 'PTTYPE', val: (d) => one(d.disk?.table === 'msdos' ? 'dos' : d.disk?.table ?? '') },
    PKNAME: { head: 'PKNAME', val: (d) => one(parent(d)) },
    MODEL: { head: 'MODEL', val: (d) => one(d.type === 'disk' ? DISK_MODEL : '') },
  };
}

const LSBLK_DEFAULT = ['NAME', 'MAJ:MIN', 'RM', 'SIZE', 'RO', 'TYPE', 'MOUNTPOINTS'];
const LSBLK_FS = ['NAME', 'FSTYPE', 'FSVER', 'LABEL', 'UUID', 'FSAVAIL', 'FSUSE%', 'MOUNTPOINTS'];

const lsblk: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['o', 'output']);
  const s = st(sh);
  const cols = lsblkCols(s, flags.has('b') || flags.has('bytes'), flags.has('p') || flags.has('paths'));
  let names = flags.has('f') || flags.has('fs') ? [...LSBLK_FS] : [...LSBLK_DEFAULT];
  const o = values.o ?? values.output;
  if (o !== undefined) {
    const list = o.split(',').filter(Boolean).map((c) => c.toUpperCase());
    names = o.startsWith('+') ? [...names, ...list.map((c) => c.replace(/^\+/, ''))] : list;
    const bad = names.find((n) => !cols[n]);
    if (bad) return fail(`lsblk: unknown column: ${bad}`);
  }
  const tree = !flags.has('l') && !flags.has('list');
  const noChildren = flags.has('d') || flags.has('nodeps');
  let tops: BlockDevice[];
  if (operands.length) {
    tops = [];
    for (const a of operands) {
      const d = dev(sh, a);
      if (!d) return fail(`lsblk: ${a}: not a block device`, 32);
      tops.push(d);
    }
  } else tops = listDevices(s).filter((d) => d.type === 'disk');

  const rows: string[][] = [];
  const seen = new Set<string>();
  const add = (d: BlockDevice, prefix: string, branch: string) => {
    if (!tree) {
      if (seen.has(d.path)) return;
      seen.add(d.path);
    }
    const cells = names.map((n) => cols[n].val(d));
    const height = Math.max(1, ...cells.map((c) => c.length));
    for (let line = 0; line < height; line++) {
      rows.push(
        names.map((n, i) => {
          const v = cells[i][line] ?? '';
          return n === 'NAME' && tree && line === 0 ? prefix + branch + v : v;
        }),
      );
    }
    if (noChildren) return;
    const kids = childrenOf(s, d);
    const next = prefix + (branch === '├─' ? '│ ' : branch === '└─' ? '  ' : '');
    kids.forEach((k, i) => add(k, next, i === kids.length - 1 ? '└─' : '├─'));
  };
  for (const t of tops) add(t, '', '');
  const header = flags.has('n') || flags.has('noheadings') ? [] : [names.map((n) => cols[n].head)];
  const all = [...header, ...rows];
  if (!all.length) return ok();
  const right = names.map((n) => !!cols[n].right);
  const w = names.map((n, i) => Math.max(cols[n].min ?? 0, ...all.map((r) => r[i].length)));
  const text = all
    .map((r) => r.map((c, i) => (right[i] ? c.padStart(w[i]) : i === r.length - 1 ? c : c.padEnd(w[i]))).join(' ').trimEnd())
    .join('\n');
  return ok(text + '\n');
};

// ---------- blkid ----------

function blkidTags(s: StorageState, d: BlockDevice): [string, string][] {
  const tags: [string, string][] = [];
  const fs = d.holder.fs;
  const sig = signatureOf(s, d);
  if (d.type === 'disk' && d.disk?.table) {
    tags.push(['PTUUID', d.disk.ptuuid], ['PTTYPE', d.disk.table === 'msdos' ? 'dos' : 'gpt']);
  }
  if (fs?.label) tags.push(['LABEL', fs.label]);
  if (sig) tags.push(['UUID', fs?.uuid ?? s.pvs.find((p) => p.device === d.path)!.uuid]);
  if (fs && fs.type !== 'swap') tags.push(['BLOCK_SIZE', fs.type === 'ext4' ? '4096' : '512']);
  if (sig) tags.push(['TYPE', sig]);
  if (d.part?.name) tags.push(['PARTLABEL', d.part.name]);
  if (d.part) tags.push(['PARTUUID', d.part.partuuid]);
  return tags;
}

const blkid: Command = ({ sh, args }) => {
  const { flags, values, multi, operands } = getopts(args, ['s', 'o', 'U', 'L', 't', 'match-tag', 'output', 'match-token', 'label', 'uuid']);
  const s = st(sh);
  const uuid = values.U ?? values.uuid;
  const label = values.L ?? values.label;
  if (uuid !== undefined || label !== undefined) {
    const d = findDevice(s, uuid !== undefined ? `UUID=${uuid}` : `LABEL=${label}`);
    return d ? ok(d.path + '\n') : { stdout: '', stderr: '', code: 2 };
  }
  void flags;
  let devs = listDevices(s);
  if (operands.length) {
    devs = operands.map((a) => findDevice(s, a)).filter((d): d is BlockDevice => !!d);
  }
  const token = values.t ?? values['match-token'];
  const only = [...(multi.s ?? []), ...(multi['match-tag'] ?? [])].map((t) => t.toUpperCase());
  const format = values.o ?? values.output ?? 'full';
  const lines: string[] = [];
  for (const d of devs) {
    let tags = blkidTags(s, d);
    if (!tags.length) continue;
    if (token) {
      const [k, v] = token.split('=');
      if (!tags.some(([tk, tv]) => tk === k.toUpperCase() && tv === v.replace(/^"(.*)"$/, '$1'))) continue;
    }
    if (only.length) tags = tags.filter(([k]) => only.includes(k));
    if (!tags.length) continue;
    if (format === 'value') lines.push(...tags.map(([, v]) => v));
    else if (format === 'device') lines.push(d.path);
    else if (format === 'export') lines.push([`DEVNAME=${d.path}`, ...tags.map(([k, v]) => `${k}=${v}`)].join('\n') + '\n');
    else lines.push(`${d.path}: ${tags.map(([k, v]) => `${k}="${v}"`).join(' ')}`);
  }
  if (!lines.length) return { stdout: '', stderr: '', code: 2 };
  return ok(lines.join('\n') + '\n');
};

// ---------- df, du, free ----------

interface DfRow {
  source: string;
  type: string;
  target: string;
  size: number;
  used: number;
  avail: number;
}

function tmpfsSize(opts: string[]): number {
  const v = opts.find((o) => o.startsWith('size='))?.slice(5);
  const m = v ? /^(\d+)([kmgKMG%]?)$/.exec(v) : null;
  if (!m) return 1870140 * KiB;
  const n = +m[1];
  const u = m[2].toLowerCase();
  return u === '%' ? Math.floor((3740284 * KiB * n) / 100) : n * (u === 'k' ? KiB : u === 'm' ? MiB : u === 'g' ? GiB : 1);
}

function fsOfMount(s: StorageState, m: Mount): FileSystem | undefined {
  return findDevice(s, m.source)?.holder.fs;
}

function dfRows(s: StorageState): DfRow[] {
  const real = s.mounts.map((m): DfRow => {
    if (m.type === 'tmpfs') return { source: m.source, type: 'tmpfs', target: m.target, size: tmpfsSize(m.options), used: 0, avail: tmpfsSize(m.options) };
    const fs = fsOfMount(s, m);
    const u = fs ? fsUsage(fs) : { size: 0, used: 0, avail: 0 };
    return { source: m.source, type: m.type, target: m.target, ...u };
  });
  const pseudo = PSEUDO_MOUNTS.filter((p) => p.size).map((p) => ({ source: p.source, type: p.type, target: p.target, size: p.size, used: p.used, avail: p.size - p.used }));
  return [real[0], ...pseudo, ...real.slice(1)];
}

/** The mount that holds a canonical path: the longest mount point that is a prefix of it. */
function rowFor<T extends { target: string }>(rows: T[], path: string): T | undefined {
  let best: T | undefined;
  for (const r of rows) {
    const inside = r.target === '/' || path === r.target || path.startsWith(r.target + '/');
    if (inside && (!best || r.target.length >= best.target.length)) best = r;
  }
  return best;
}

const df: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['t', 'x', 'type', 'exclude-type', 'output']);
  const s = st(sh);
  const human = flags.has('h') || flags.has('human-readable');
  const si = flags.has('H') || flags.has('si');
  const showType = flags.has('T') || flags.has('print-type');
  const mb = flags.has('m');
  const all = dfRows(s);
  let rows: DfRow[] = [];
  let err = '';
  if (operands.length) {
    for (const a of operands) {
      const d = a.startsWith('/dev/') || /^(UUID|LABEL)=/.test(a) ? dev(sh, a) : null;
      const byDev = d ? all.filter((r) => r.source === d.path)[0] : undefined;
      if (byDev) {
        rows.push(byDev);
        continue;
      }
      let path: string;
      try {
        path = joinPath(sh.resolve(a).parts);
      } catch (e) {
        err += `df: ${a}: ${e instanceof FsError ? errorText[e.reason] : String(e)}\n`;
        continue;
      }
      const r = rowFor(all, path);
      if (r) rows.push(r);
    }
  } else rows = all;
  const only = values.t ?? values.type;
  const skip = values.x ?? values['exclude-type'];
  if (only) rows = rows.filter((r) => r.type === only);
  if (skip) rows = rows.filter((r) => r.type !== skip);
  if (!rows.length && !err) return fail('df: no file systems processed');
  const num = (b: number) => (human || si ? dfHuman(b, si) : String(Math.ceil(b / (mb ? MiB : KiB))));
  const pct = (r: DfRow) => (r.used + r.avail ? `${Math.ceil((r.used * 100) / (r.used + r.avail))}%` : '-');
  const head = ['Filesystem', ...(showType ? ['Type'] : []), human || si ? 'Size' : mb ? '1M-blocks' : '1K-blocks', 'Used', human || si ? 'Avail' : 'Available', 'Use%', 'Mounted on'];
  const table = [head, ...rows.map((r) => [r.source, ...(showType ? [r.type] : []), num(r.size), num(r.used), num(r.avail), pct(r), r.target])];
  const n = showType ? 1 : 0;
  const min = [14, ...(showType ? [4] : []), 5, 5, 5, 4, 0];
  const right = head.map((_, i) => i > n && i < head.length - 1);
  const w = head.map((_, i) => Math.max(min[i], ...table.map((r) => r[i].length)));
  const text = table.map((r) => r.map((c, i) => (right[i] ? c.padStart(w[i]) : i === r.length - 1 ? c : c.padEnd(w[i]))).join(' ')).join('\n') + '\n';
  return { stdout: text, stderr: err, code: err ? 1 : 0 };
};

const du: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args, ['max-depth', 'd']);
  const human = flags.has('h');
  const summary = flags.has('s');
  const all = flags.has('a');
  const targets = operands.length ? operands : ['.'];
  const fmt = (k: number) => (human ? dfHuman(k * KiB) : String(k));
  let out = '';
  let err = '';
  let total = 0;
  const walk = (node: FsNode, path: string, depth: number): number => {
    if (node.type === 'file') return Math.ceil((node.content ?? '').length / 4096) * 4;
    if (node.type !== 'dir') return 0;
    if (!canAccess(node, 'r', sh.uid, sh.gids) || !canAccess(node, 'x', sh.uid, sh.gids)) {
      err += `du: cannot read directory '${path}': Permission denied\n`;
      return 0;
    }
    let sum = 0;
    for (const [name, child] of Object.entries(node.children!).sort(([a], [b]) => a.localeCompare(b))) {
      const p = path === '/' ? `/${name}` : `${path}/${name}`;
      const k = walk(child, p, depth + 1);
      sum += k;
      if (all && !summary && child.type !== 'dir') out += `${fmt(k)}\t${p}\n`;
    }
    if (!summary || depth === 0) out += `${fmt(sum)}\t${path}\n`;
    return sum;
  };
  for (const t of targets) {
    try {
      const r = sh.resolve(t);
      const before = out.length;
      const k = walk(r.node, t.replace(/(.)\/$/, '$1'), 0);
      if (r.node.type !== 'dir') out = out.slice(0, before) + `${fmt(k)}\t${t}\n`;
      total += k;
    } catch (e) {
      err += `du: cannot access '${t}': ${e instanceof FsError ? errorText[e.reason] : String(e)}\n`;
    }
  }
  if (flags.has('c')) out += `${fmt(total)}\ttotal\n`;
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

const free: Command = ({ sh, args }) => {
  const { flags } = getopts(args);
  const s = st(sh);
  const swapTotal = s.swaps.reduce((sum, a) => {
    const fs = findDevice(s, a.device)?.holder.fs;
    return sum + (fs ? swapKiB(fs) : 0);
  }, 0);
  const mem = [3740284, 912340, 2105672, 11284, 968560, 2827944];
  const swap = [swapTotal, 0, swapTotal];
  const fmt = (k: number) => {
    if (flags.has('h')) {
      if (k === 0) return '0B';
      const units = ['Ki', 'Mi', 'Gi', 'Ti'];
      let v = k;
      let e = 0;
      while (v >= 1024 && e < units.length - 1) {
        v /= 1024;
        e++;
      }
      return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + units[e];
    }
    if (flags.has('b')) return String(k * 1024);
    if (flags.has('m')) return String(Math.floor(k / 1024));
    if (flags.has('g')) return String(Math.floor(k / 1024 / 1024));
    return String(k);
  };
  const row = (label: string, vals: number[]) => label.padEnd(8) + vals.map((v) => fmt(v).padStart(12)).join('');
  return ok(
    `${''.padEnd(8)}${['total', 'used', 'free', 'shared', 'buff/cache', 'available'].map((h) => h.padStart(12)).join('')}\n` +
      `${row('Mem:', mem)}\n${row('Swap:', swap)}\n`,
  );
};

// ---------- findmnt ----------

interface MntRow {
  source: string;
  target: string;
  type: string;
  options: string;
  dev?: BlockDevice | null;
}

function mountRows(s: StorageState): MntRow[] {
  const real = s.mounts.map((m) => ({ source: m.source, target: m.target, type: m.type, options: m.type === 'tmpfs' ? `rw,relatime,seclabel,inode64` : kernelOptions(m.type, m.options), dev: findDevice(s, m.source) }));
  const pseudo = PSEUDO_MOUNTS.map((p) => ({ source: p.source, target: p.target, type: p.type, options: p.options }));
  return [real[0], ...pseudo, ...real.slice(1)];
}

function verifyFstab(sh: Shell): CommandResult {
  const state = sh.state;
  const s = st(sh);
  const { entries, errors } = parseFstab(readFstab(state));
  let out = errors.map((n) => `findmnt: /etc/fstab: parse error at line ${n} -- ignored\n`).join('');
  let nerr = 0;
  let nwarn = 0;
  for (const e of entries) {
    const msgs: string[] = [];
    const E = (m: string) => {
      msgs.push(`   [E] ${m}`);
      nerr++;
    };
    const W = (m: string) => {
      msgs.push(`   [W] ${m}`);
      nwarn++;
    };
    const noauto = e.options.includes('noauto');
    const swap = e.type === 'swap';
    if (!swap) {
      const t = lookup(state, e.file);
      if (!t) (noauto ? W : E)(`unreachable ${noauto ? '' : 'on boot required '}target: No such file or directory`);
      else if ('/' + t.parts.join('/') !== e.file.replace(/(.)\/$/, '$1')) W(`non-canonical target path (real: /${t.parts.join('/')})`);
      else if (t.node.type !== 'dir') E('target is not a directory');
    }
    if (NETWORK_FS.includes(e.type) || e.type === 'tmpfs') {
      if (msgs.length) out += `${e.file}\n${msgs.join('\n')}\n`;
      continue;
    }
    const d = findDevice(s, e.spec);
    const tag = /^(UUID|LABEL|PARTUUID|PARTLABEL)=/.test(e.spec);
    if (!d) {
      if (tag) (noauto ? W : E)(noauto ? `unreachable: ${e.spec}` : `unreachable on boot required source: ${e.spec}`);
      else if (lookup(state, e.spec)) W(`non-bind mount source ${e.spec} is a directory or regular file`);
      else (noauto ? W : E)(`unreachable ${noauto ? '' : 'on boot required '}source: ${e.spec}: No such file or directory`);
    } else {
      const auto = e.type === 'auto';
      if (!auto && !KNOWN_FS.includes(e.type)) W(`${e.type} seems unsupported by the current kernel`);
      const sig = signatureOf(s, d);
      if (!sig) (auto ? E : W)('cannot detect on-disk filesystem type');
      else if (!auto && e.type !== sig) W(`${e.type} does not match with on-disk ${sig}`);
    }
    if (msgs.length) out += `${e.file}\n${msgs.join('\n')}\n`;
  }
  if (nerr || nwarn || errors.length) {
    out += `\n${plural(errors.length, 'parse error')}, ${plural(nerr, 'error')}, ${plural(nwarn, 'warning')}\n`;
    return { stdout: out, stderr: '', code: nerr || errors.length ? 1 : 0 };
  }
  return ok('Success, no errors or warnings detected\n');
}

const findmnt: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['o', 't', 'S', 'T', 'M', 'output', 'types', 'source', 'target', 'mountpoint']);
  const s = st(sh);
  if (flags.has('verify') || flags.has('x')) return verifyFstab(sh);
  const fstab = flags.has('s') || flags.has('fstab');
  let rows: MntRow[];
  if (fstab) {
    rows = parseFstab(readFstab(sh.state)).entries.map((e) => ({ source: e.spec, target: e.file, type: e.type, options: e.options.join(','), dev: findDevice(s, e.spec) }));
  } else rows = mountRows(s);
  const type = values.t ?? values.types;
  const src = values.S ?? values.source;
  const tgt = values.M ?? values.mountpoint ?? values.target;
  const contains = values.T;
  let filtered = !!(type || src || tgt || contains || operands.length);
  if (type) rows = rows.filter((r) => type.split(',').includes(r.type));
  const matchSource = (r: MntRow, a: string) => {
    const d = findDevice(s, a);
    return r.source === a || (!!d && (r.dev?.path === d.path || r.source === d.path));
  };
  if (src) rows = rows.filter((r) => matchSource(r, src));
  if (tgt) rows = rows.filter((r) => r.target === (canonical(sh, tgt) ?? tgt));
  if (contains) {
    const p = canonical(sh, contains) ?? contains;
    const r = rowFor(rows, p);
    rows = r ? [r] : [];
  }
  if (operands.length) {
    const a = operands[0];
    const p = canonical(sh, a) ?? a;
    rows = rows.filter((r) => r.target === p || matchSource(r, a));
  }
  if (filtered && !rows.length) return { stdout: '', stderr: '', code: 1 };
  const o = values.o ?? values.output;
  const names = (o ? o.split(',') : ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS']).map((c) => c.toUpperCase());
  const value = (r: MntRow, c: string): string => {
    const fs = r.dev?.holder.fs;
    const u = fs && fs.type !== 'swap' ? fsUsage(fs) : null;
    switch (c) {
      case 'TARGET': return r.target;
      case 'SOURCE': return r.source;
      case 'FSTYPE': return r.type;
      case 'OPTIONS': return r.options;
      case 'UUID': return fs?.uuid ?? '';
      case 'LABEL': return fs?.label ?? '';
      case 'SIZE': return u ? humanSize(u.size) : '';
      case 'USED': return u ? humanSize(u.used) : '';
      case 'AVAIL': return u ? humanSize(u.avail) : '';
      case 'USE%': return u ? `${Math.round(((u.size - u.avail) / u.size) * 100)}%` : '';
      default: return '';
    }
  };
  const known = ['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS', 'UUID', 'LABEL', 'SIZE', 'USED', 'AVAIL', 'USE%'];
  const bad = names.find((n) => !known.includes(n));
  if (bad) return fail(`findmnt: unknown column: ${bad}`);
  filtered = filtered || fstab || flags.has('l') || flags.has('list');
  // tree: each mount hangs under the nearest earlier mount that contains it
  const prefixes = rows.map(() => '');
  if (!filtered) {
    const parentOf = rows.map((r, i) => {
      let best = -1;
      for (let j = 0; j < i; j++) {
        const t = rows[j].target;
        if (r.target !== t && (t === '/' || r.target.startsWith(t + '/')) && (best < 0 || t.length > rows[best].target.length)) best = j;
      }
      return best;
    });
    const kids = (p: number) => rows.map((_, i) => i).filter((i) => parentOf[i] === p);
    const order: number[] = [];
    const walk = (i: number, prefix: string, branch: string) => {
      prefixes[i] = prefix + branch;
      order.push(i);
      const k = kids(i);
      const next = prefix + (branch === '├─' ? '│ ' : branch === '└─' ? '  ' : '');
      k.forEach((c, n) => walk(c, next, n === k.length - 1 ? '└─' : '├─'));
    };
    kids(-1).forEach((i) => walk(i, '', ''));
    rows = order.map((i) => rows[i]);
    const sorted = order.map((i) => prefixes[i]);
    prefixes.splice(0, prefixes.length, ...sorted);
  }
  const table = rows.map((r, i) => names.map((c) => (c === 'TARGET' ? prefixes[i] + r.target : value(r, c))));
  const noHead = flags.has('n') || flags.has('noheadings');
  const right = names.map((c) => ['SIZE', 'USED', 'AVAIL', 'USE%'].includes(c));
  return ok(columns(noHead ? table : [names, ...table], right, '', false));
};

// ---------- fdisk ----------

function fdiskHeader(d: BlockDevice): string {
  const head = `Disk ${d.path}: ${humanSize(d.size, { space: true, iec: true, two: true })}, ${d.size} bytes, ${d.size / SECTOR} sectors\n`;
  const model = d.type === 'disk' ? `Disk model: ${DISK_MODEL}\n` : '';
  return head + model + 'Units: sectors of 1 * 512 = 512 bytes\nSector size (logical/physical): 512 bytes / 512 bytes\nI/O size (minimum/optimal): 512 bytes / 512 bytes\n';
}

function fdiskList(s: StorageState, d: BlockDevice): string {
  let out = fdiskHeader(d);
  const disk = d.type === 'disk' ? d.disk : undefined;
  if (!disk?.table) return out;
  const gpt = disk.table === 'gpt';
  out += `Disklabel type: ${gpt ? 'gpt' : 'dos'}\nDisk identifier: ${gpt ? disk.ptuuid.toUpperCase() : '0x' + disk.ptuuid}\n`;
  const parts = [...disk.partitions].sort((a, b) => a.number - b.number);
  if (!parts.length) return out;
  const head = gpt ? ['Device', 'Start', 'End', 'Sectors', 'Size', 'Type'] : ['Device', 'Boot', 'Start', 'End', 'Sectors', 'Size', 'Id', 'Type'];
  const rows = parts.map((p) => {
    const size = humanSize(partSectors(p) * SECTOR);
    const path = partPath(disk.name, p.number);
    if (gpt) return [path, String(p.start), String(p.end), String(partSectors(p)), size, gptTypeName(p)];
    const [id, name] = dosType(p);
    return [path, p.flags.includes('boot') ? '*' : '', String(p.start), String(p.end), String(partSectors(p)), size, id, name];
  });
  const right = gpt ? [false, true, true, true, true, false] : [false, false, true, true, true, true, true, false];
  void s;
  return out + '\n' + columns([head, ...rows], right);
}

const fdisk: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const s = st(sh);
  const list = flags.has('l') || flags.has('list');
  const targets = operands.length ? operands.map((a) => ({ a, d: dev(sh, a) })) : listDevices(s).filter((d) => d.type !== 'part').map((d) => ({ a: d.path, d }));
  if (!list) {
    const a = operands[0];
    if (!a) return fail('Usage:\n fdisk [options] <disk>         change partition table\n fdisk [options] -l [<disk>...] list partition table(s)', 1);
    if (sh.uid !== 0) return fail(`fdisk: cannot open ${a}: Permission denied\n${SUDO}`);
    if (!dev(sh, a)) return fail(`fdisk: cannot open ${a}: No such file or directory`);
    return fail(
      `Welcome to fdisk (util-linux 2.40.2).\n\nfdisk is interactive, which this phone terminal cannot show.\nUse parted instead: it takes the whole job on one line, for example:\n  sudo parted -s ${a} mklabel gpt mkpart data xfs 1MiB 1GiB\n  sudo parted ${a} print`,
    );
  }
  let out = '';
  let err = '';
  for (const { a, d } of targets) {
    if (sh.uid !== 0) {
      err += `fdisk: cannot open ${a}: Permission denied\n`;
      continue;
    }
    if (!d) {
      err += `fdisk: cannot open ${a}: No such file or directory\n`;
      continue;
    }
    out += (out ? '\n\n' : '') + fdiskList(s, d);
  }
  if (sh.uid !== 0) err += SUDO + '\n';
  return { stdout: out, stderr: err, code: err ? 1 : 0 };
};

// ---------- parted ----------

const PARTED_UNITS: Record<string, [number, string]> = {
  b: [1, 'B'], kb: [1e3, 'kB'], mb: [1e6, 'MB'], gb: [1e9, 'GB'], tb: [1e12, 'TB'],
  kib: [KiB, 'KiB'], mib: [MiB, 'MiB'], gib: [GiB, 'GiB'], tib: [1024 * GiB, 'TiB'],
};
const PARTED_FS = ['xfs', 'ext2', 'ext3', 'ext4', 'fat16', 'fat32', 'linux-swap', 'linux-swap(v1)', 'btrfs', 'ntfs', 'hfs', 'hfs+', 'udf', 'f2fs', 'nilfs2', 'swsusp'];
const GPT_FLAGS = ['boot', 'esp', 'lvm', 'swap', 'raid', 'hidden', 'legacy_boot', 'msftdata', 'msftres', 'bios_grub', 'bls_boot', 'linux-home', 'diag', 'prep', 'irst', 'no_automount'];
const DOS_FLAGS = ['boot', 'lvm', 'swap', 'raid', 'hidden', 'lba', 'esp', 'diag', 'prep', 'palo', 'irst'];
// GPT flags that are really partition type GUIDs: only one at a time
const TYPE_FLAGS = ['esp', 'lvm', 'swap', 'raid', 'msftdata', 'msftres', 'bios_grub', 'bls_boot', 'linux-home', 'diag', 'prep', 'irst'];
const FLAG_ORDER = ['boot', 'root', 'swap', 'hidden', 'raid', 'lvm', 'lba', 'hp-service', 'palo', 'prep', 'msftres', 'bios_grub', 'atvrecv', 'diag', 'legacy_boot', 'msftdata', 'irst', 'esp', 'chromeos_kernel', 'bls_boot', 'linux-home', 'no_automount'];

/** parted's number format: 1049kB, 10.7GB (compact), 1.00MiB, 2048s. */
function partedFmt(bytes: number, unit: string, diskBytes: number): string {
  let u = unit.toLowerCase();
  if (u === 's') return `${Math.floor(bytes / SECTOR)}s`;
  if (u === 'compact') u = bytes >= 10e12 ? 'tb' : bytes >= 10e9 ? 'gb' : bytes >= 10e6 ? 'mb' : bytes >= 10e3 ? 'kb' : 'b';
  const [size, name] = u === '%' ? [diskBytes / 100, '%'] : PARTED_UNITS[u];
  const d = (bytes / size) * (1 + Number.EPSILON);
  const w = d + (d < 10 ? 0.005 : d < 100 ? 0.05 : 0.5);
  return d.toFixed(w < 10 ? 2 : w < 100 ? 1 : 0) + name;
}

const isUnit = (u: string) => u === 's' || u === '%' || u === 'compact' || !!PARTED_UNITS[u];
const POS = /^(-?)(\d+(?:\.\d+)?)([a-zA-Z%]*)$/;
const isPos = (t: string) => {
  const m = POS.exec(t);
  return !!m && (!m[3] || isUnit(m[3].toLowerCase()));
};

interface PosValue {
  sector: number;
  exact: boolean; // IEC units and sectors are exact; MB, GB and % may be moved to the nearest MiB
}

function parsePos(text: string, unit: string, disk: Disk, isEnd: boolean): PosValue {
  const m = POS.exec(text)!;
  let u = (m[3] || unit).toLowerCase();
  if (u === 'compact') u = 'mb';
  const v = parseFloat(m[2]);
  const total = disk.sectors * SECTOR;
  if (u === 's') {
    const sector = m[1] ? disk.sectors - v : v;
    return { sector, exact: true };
  }
  let bytes = u === '%' ? (v / 100) * total : v * PARTED_UNITS[u][0];
  if (m[1]) bytes = total - bytes;
  const exact = u.endsWith('ib') || u === 'b';
  let sector = isEnd ? Math.round(bytes / SECTOR) - 1 : Math.floor(bytes / SECTOR);
  if (!exact) {
    // parted lets a decimal position move by half a unit, which in practice lands on a MiB boundary
    sector = isEnd ? Math.round((sector + 1) / 2048) * 2048 - 1 : Math.round(sector / 2048) * 2048;
  }
  return { sector, exact };
}

/** Free regions [start, end] of a disk for a new primary partition, or inside the extended one for a logical. */
function freeRegions(disk: Disk, logical: boolean): [number, number][] {
  const first = disk.table === 'gpt' ? 34 : 1;
  const last = disk.table === 'gpt' ? disk.sectors - 34 : disk.sectors - 1;
  const ext = disk.partitions.find((p) => p.kind === 'extended');
  let lo = first;
  let hi = last;
  let used = disk.partitions.filter((p) => p.kind !== 'logical');
  if (logical) {
    if (!ext) return [];
    lo = ext.start + 1;
    hi = ext.end;
    used = disk.partitions.filter((p) => p.kind === 'logical');
  }
  const out: [number, number][] = [];
  let cur = lo;
  for (const p of [...used].sort((a, b) => a.start - b.start)) {
    if (p.start > cur) out.push([cur, Math.min(p.start - 1, hi)]);
    cur = Math.max(cur, p.end + 1);
  }
  if (cur <= hi) out.push([cur, hi]);
  return out;
}

const lowestFree = (used: number[], from: number) => {
  let n = from;
  while (used.includes(n)) n++;
  return n;
};

function nvmeMinor(s: StorageState): number {
  const used = s.disks.flatMap((d) => [d.minor, ...d.partitions.map((p) => p.minor)]);
  return lowestFree(used, 0);
}

interface PartedRun {
  sh: Shell;
  disk: Disk;
  path: string;
  unit: string;
  script: boolean;
  out: string;
  changed: boolean;
}

function partedPrint(r: PartedRun, free: boolean): { text: string; error?: string } {
  const { disk } = r;
  const total = disk.sectors * SECTOR;
  const fmt = (b: number) => partedFmt(b, r.unit, total);
  let head = `Model: ${DISK_MODEL} (nvme)\nDisk ${r.path}: ${fmt(total)}\nSector size (logical/physical): 512B/512B\nPartition Table: ${disk.table ?? 'unknown'}\nDisk Flags: \n`;
  if (!disk.table) return { text: head.replace(/ \n/g, '\n') + '\n', error: `Error: ${r.path}: unrecognised disk label` };
  head = head.replace(/ \n/g, '\n');
  const gpt = disk.table === 'gpt';
  const s = st(r.sh);
  const cols = gpt ? ['Number', 'Start', 'End', 'Size', 'File system', 'Name', 'Flags'] : ['Number', 'Start', 'End', 'Size', 'Type', 'File system', 'Flags'];
  const unitS = r.unit.toLowerCase() === 's';
  const rows: string[][] = [];
  const row = (num: string, start: number, end: number, rest: string[]) => {
    const size = unitS ? `${end - start + 1}s` : fmt((end - start + 1) * SECTOR);
    const endTxt = unitS ? `${end}s` : fmt(end * SECTOR + SECTOR - 1);
    rows.push([num, unitS ? `${start}s` : fmt(start * SECTOR), endTxt, size, ...rest]);
  };
  const parts = [...disk.partitions].sort((a, b) => a.start - b.start || a.number - b.number);
  const fsName = (p: Partition) => {
    const sig = signatureOf(s, findDevice(s, partPath(disk.name, p.number))!);
    return sig === 'vfat' ? 'fat32' : sig === 'swap' ? 'linux-swap(v1)' : sig === 'LVM2_member' || !sig ? '' : sig;
  };
  const flags = (p: Partition) => FLAG_ORDER.filter((f) => p.flags.includes(f)).join(', ');
  const freeRows = free ? [...freeRegions(disk, false), ...freeRegions(disk, true)].filter(([a, b]) => b - a + 1 >= 2048 || free) : [];
  const items: { start: number; render: () => void }[] = parts.map((p) => ({
    start: p.start,
    render: () => row(` ${p.number}`.slice(-Math.max(2, String(p.number).length)), p.start, p.end, gpt ? [fsName(p), p.name, flags(p)] : [p.kind, fsName(p), flags(p)]),
  }));
  for (const [a, b] of freeRows) items.push({ start: a, render: () => row('', a, b, gpt ? ['Free Space', '', ''] : ['', 'Free Space', '']) });
  items.sort((x, y) => x.start - y.start).forEach((i) => i.render());
  const table = [cols, ...rows];
  const w = cols.map((_, i) => Math.max(...table.map((t) => t[i].length)));
  const text = table.map((t) => t.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n');
  return { text: head + '\n' + text + '\n\n' };
}

function partedInUse(r: PartedRun, p: Partition): boolean {
  const s = st(r.sh);
  const d = findDevice(s, partPath(r.disk.name, p.number));
  return !!d && deviceBusy(s, d);
}

/** Renumber logical partitions in disk order (msdos): 5, 6, 7... Fails if a busy one would move. */
function renumberLogicals(r: PartedRun): string | null {
  const s = st(r.sh);
  const logicals = r.disk.partitions.filter((p) => p.kind === 'logical').sort((a, b) => a.start - b.start);
  const moves = logicals.map((p, i) => ({ p, to: 5 + i })).filter((x) => x.p.number !== x.to);
  const stuck = moves.find((x) => partedInUse(r, x.p));
  if (stuck) {
    return `Error: Partition(s) ${stuck.p.number} on ${r.path} have been written, but we have been unable to inform the kernel of the change, probably because it/they are in use.  As a result, the old partition(s) will remain in use.  You should reboot now before making further changes.`;
  }
  for (const { p, to } of moves) {
    const old = partPath(r.disk.name, p.number);
    for (const pv of s.pvs) if (pv.device === old) pv.device = partPath(r.disk.name, to);
    p.number = to;
    p.partuuid = `${r.disk.ptuuid}-${to.toString(16).padStart(2, '0')}`;
  }
  return null;
}

function partedMkpart(r: PartedRun, tokens: string[]): string | null {
  const { disk } = r;
  if (!disk.table) return `Error: ${r.path}: unrecognised disk label`;
  const gpt = disk.table === 'gpt';
  const pos = tokens.slice(-2);
  if (pos.length < 2 || !pos.every(isPos)) {
    const bad = tokens.find((t, i) => i >= tokens.length - 2 && !isPos(t));
    return bad ? `parted: invalid token: ${bad}\nError: Expecting a partition ${pos.length < 2 ? 'start' : 'end'}.` : 'Error: Expecting a partition start.';
  }
  const words = tokens.slice(0, -2);
  let kind: Partition['kind'] = 'primary';
  let name = '';
  if (gpt) {
    if (words.length && !PARTED_FS.includes(words[0].toLowerCase())) name = words.shift()!;
  } else if (words.length && ['primary', 'extended', 'logical'].includes(words[0])) kind = words.shift() as Partition['kind'];
  else if (words.length && !PARTED_FS.includes(words[0].toLowerCase())) return `parted: invalid token: ${words[0]}\nError: Expecting a partition type.`;
  const fsType = words.shift()?.toLowerCase();
  if (fsType && !PARTED_FS.includes(fsType)) return `parted: invalid token: ${fsType}\nError: Expecting a file system type.`;
  if (words.length) return `parted: invalid token: ${words[0]}`;

  const total = disk.sectors * SECTOR;
  const fmt = (sec: number) => partedFmt(sec * SECTOR, r.unit === 's' ? 's' : 'compact', total);
  const start = parsePos(pos[0], r.unit, disk, false);
  const end = parsePos(pos[1], r.unit, disk, true);
  const last = gpt ? disk.sectors - 34 : disk.sectors - 1;
  for (const [p, txt] of [[start, pos[0]], [end, pos[1]]] as const) {
    if (p.sector < 0 || p.sector > disk.sectors - 1) return `Error: The location ${txt} is outside of the device ${r.path}.`;
  }
  let s0 = start.sector;
  let e0 = Math.min(end.sector, last);
  if (!end.exact && end.sector > last) e0 = Math.floor((last + 1) / 2048) * 2048 - 1;
  if (!start.exact) s0 = Math.max(s0, 2048);
  if (e0 < s0) return `Error: Can't have the end before the start! (start sector=${s0} length=${e0 - s0 + 1})`;

  const ext = disk.partitions.find((p) => p.kind === 'extended');
  if (!gpt) {
    const primaries = disk.partitions.filter((p) => p.kind !== 'logical').length;
    if (kind !== 'logical' && primaries >= 4) return 'Error: Too many primary partitions.';
    if (kind === 'extended' && ext) return `Error: Can't have more than one extended partition on ${r.path}.`;
    if (kind === 'logical' && !ext) return `Error: Can't add a logical partition to ${r.path}, because there is no extended partition.`;
    if (kind === 'logical' && ext && (s0 < ext.start || e0 > ext.end)) return `Error: Can't have a logical partition outside of the extended partition on ${r.path}.`;
    if (kind === 'logical' && ext) {
      // each logical partition needs room for its boot record in front of it
      const before = disk.partitions.filter((p) => p.kind === 'logical' && p.end < s0).reduce((m, p) => Math.max(m, p.end + 1), ext.start);
      if (s0 < before + 2048) s0 = Math.ceil((before + 1) / 2048) * 2048;
    }
  }
  const regions = freeRegions(disk, kind === 'logical');
  const best = regions
    .map(([a, b]) => [Math.max(a, s0), Math.min(b, e0)] as [number, number])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => y[1] - y[0] - (x[1] - x[0]))[0];
  if (!best) return 'Error: Unable to satisfy all constraints on the partition.';
  if (best[0] !== s0 || best[1] !== e0) {
    return (
      `Error: You requested a partition from ${fmt(s0)} to ${fmt(e0 + 1)} (sectors ${s0}..${e0}).\n` +
      `The closest location we can manage is ${fmt(best[0])} to ${fmt(best[1] + 1)} (sectors ${best[0]}..${best[1]}).` +
      (r.script ? '' : `\n${NO_PROMPT('Fix the start or end and run it again.')}`)
    );
  }
  if (s0 % 2048) r.out += `Warning: The resulting partition is not properly aligned for best performance: ${s0}s % 2048s != 0s\n`;
  const s = st(r.sh);
  let number: number;
  if (gpt) number = lowestFree(disk.partitions.map((p) => p.number), 1);
  else if (kind === 'logical') number = 5 + disk.partitions.filter((p) => p.kind === 'logical').length;
  else number = lowestFree(disk.partitions.filter((p) => p.kind !== 'logical').map((p) => p.number), 1);
  if (gpt && number > 128) return 'Error: Too many primary partitions.';
  const flags: string[] = [];
  if (fsType?.startsWith('linux-swap')) flags.push('swap');
  if (fsType?.startsWith('fat') && gpt) flags.push('msftdata');
  if (fsType?.startsWith('fat') && !gpt) flags.push('lba');
  const part: Partition = {
    number, start: s0, end: kind === 'extended' ? e0 : e0, name: gpt ? name : '', kind, flags,
    partuuid: gpt ? newUuid(s) : `${disk.ptuuid}-${number.toString(16).padStart(2, '0')}`,
    minor: nvmeMinor(s),
  };
  disk.partitions.push(part);
  if (kind === 'logical') {
    const e = renumberLogicals(r);
    if (e) {
      disk.partitions = disk.partitions.filter((p) => p !== part);
      return e;
    }
  }
  r.changed = true;
  return null;
}

function partedFind(r: PartedRun, n: string | undefined): Partition | string {
  if (!n || !/^\d+$/.test(n)) return 'Error: Expecting a partition number.';
  if (!r.disk.table) return `Error: ${r.path}: unrecognised disk label`;
  return r.disk.partitions.find((p) => p.number === +n) ?? "Error: Partition doesn't exist.";
}

function partedRm(r: PartedRun, n: string | undefined): string | null {
  const p = partedFind(r, n);
  if (typeof p === 'string') return p;
  const s = st(r.sh);
  const victims = p.kind === 'extended' ? r.disk.partitions.filter((x) => x.kind === 'logical' || x === p) : [p];
  const used = victims.find((x) => partedInUse(r, x));
  if (used) return `Error: Partition ${partPath(r.disk.name, used.number)} is being used. You must unmount it before you modify it with Parted.`;
  const gone = new Set(victims.map((x) => partPath(r.disk.name, x.number)));
  s.pvs = s.pvs.filter((pv) => !gone.has(pv.device));
  r.disk.partitions = r.disk.partitions.filter((x) => !victims.includes(x));
  if (p.kind === 'logical') {
    const e = renumberLogicals(r);
    if (e) return e;
  }
  r.changed = true;
  return null;
}

function partedSet(r: PartedRun, n: string | undefined, flag: string | undefined, state: 'on' | 'off' | 'toggle'): string | null {
  const p = partedFind(r, n);
  if (typeof p === 'string') return p;
  const f = (flag ?? '').toLowerCase();
  const gpt = r.disk.table === 'gpt';
  if (!(gpt ? GPT_FLAGS : DOS_FLAGS).includes(f)) return flag ? `parted: invalid token: ${flag}\nError: Expecting a flag.` : 'Error: Expecting a flag.';
  const on = state === 'toggle' ? !p.flags.includes(f) : state === 'on';
  // on GPT "boot" is another name for "esp"
  const set = gpt && (f === 'boot' || f === 'esp') ? ['boot', 'esp'] : [f];
  if (on) {
    if (gpt && TYPE_FLAGS.includes(f)) p.flags = p.flags.filter((x) => !TYPE_FLAGS.includes(x) && !(x === 'boot' && f !== 'esp' && f !== 'boot'));
    if (!gpt && ['lvm', 'swap', 'raid', 'esp', 'diag', 'prep'].includes(f)) p.flags = p.flags.filter((x) => !['lvm', 'swap', 'raid', 'esp', 'diag', 'prep', 'lba'].includes(x));
    for (const x of set) if (!p.flags.includes(x)) p.flags.push(x);
  } else p.flags = p.flags.filter((x) => !set.includes(x));
  return null;
}

function partedMklabel(r: PartedRun, label: string | undefined): string | null {
  const l = (label ?? '').toLowerCase();
  if (!['gpt', 'msdos'].includes(l)) {
    return label ? `parted: invalid token: ${label}\nError: Expecting a disk label type.` : 'Error: Expecting a disk label type.';
  }
  const s = st(r.sh);
  const d = findDevice(s, r.path)!;
  if (busy(s, d)) return `Error: Partition(s) on ${r.path} are being used.`;
  if ((r.disk.table || r.disk.fs || s.pvs.some((p) => p.device === r.path)) && !r.script) {
    return `Warning: The existing disk label on ${r.path} will be destroyed and all data on this disk will be lost. Do you want to continue?\nYes/No? ${NO_PROMPT('Run parted with -s to answer yes.')}`;
  }
  wipeDevice(s, d);
  r.disk.table = l as 'gpt' | 'msdos';
  r.disk.ptuuid = l === 'gpt' ? newUuid(s) : newDosId(s);
  r.changed = true;
  return null;
}

function partedResize(r: PartedRun, n: string | undefined, endTxt: string | undefined): string | null {
  const p = partedFind(r, n);
  if (typeof p === 'string') return p;
  if (!endTxt || !isPos(endTxt)) return 'Error: Expecting a partition end.';
  if (partedInUse(r, p)) return `Error: Partition ${partPath(r.disk.name, p.number)} is being used. You must unmount it before you modify it with Parted.`;
  const end = parsePos(endTxt, r.unit, r.disk, true);
  const last = r.disk.table === 'gpt' ? r.disk.sectors - 34 : r.disk.sectors - 1;
  const e0 = end.exact ? Math.min(end.sector, last) : Math.min(end.sector, Math.floor((last + 1) / 2048) * 2048 - 1);
  const next = r.disk.partitions.filter((x) => x !== p && x.kind === p.kind && x.start > p.start).reduce((m, x) => Math.min(m, x.start - 1), last);
  if (e0 > next) return 'Error: Can\'t have overlapping partitions.';
  if (e0 < p.start) return `Error: Can't have the end before the start! (start sector=${p.start} length=${e0 - p.start + 1})`;
  p.end = e0;
  r.changed = true;
  return null;
}

const PARTED_CMDS = ['mklabel', 'mktable', 'mkpart', 'rm', 'print', 'set', 'toggle', 'unit', 'name', 'resizepart', 'quit', 'help', 'align-check', 'disk_set', 'disk_toggle', 'rescue', 'select', 'type'];

const parted: Command = ({ sh, args }) => {
  let script = false;
  let list = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--script') script = true;
    else if (a === '-l' || a === '--list') list = true;
    else if (a === '-a' || a === '--align') i++;
    else if (a.startsWith('--align=') || a === '--' || ['-m', '--machine', '-f', '--fix'].includes(a)) continue;
    else if (a === '-v' || a === '--version') return ok('parted (GNU parted) 3.6\n');
    else if (a === '-h' || a === '--help') return ok('Usage: parted [-hlmsv] [-a<align>] [DEVICE [COMMAND [PARAMETERS]]...]\nCommands: mklabel gpt|msdos, mkpart [NAME|TYPE] [FS-TYPE] START END, print [free], rm N,\n          set N FLAG on|off, name N NAME, resizepart N END, unit UNIT\n');
    else if (/^-[a-zA-Z]/.test(a)) return fail(`parted: invalid option -- '${a.slice(1, 2)}'\nUsage: parted [-hlmsv] [-a<align>] [DEVICE [COMMAND [PARAMETERS]]...]`);
    else rest.push(a);
  }
  const s = st(sh);
  if (sh.uid !== 0) {
    const shown = rest[0] ?? '/dev/nvme0n1';
    return fail(`WARNING: You are not superuser.  Watch out for permissions.\nError: Error opening ${shown}: Permission denied\n${SUDO}`);
  }
  if (list) {
    let out = '';
    for (const d of listDevices(s).filter((x) => x.type === 'disk')) {
      const r: PartedRun = { sh, disk: d.disk!, path: d.path, unit: 'compact', script: true, out: '', changed: false };
      const p = partedPrint(r, false);
      out += (p.error ? p.error + '\n' : '') + p.text;
    }
    return ok(out);
  }
  const path = rest[0];
  if (!path) return fail('GNU Parted 3.6\nUsing /dev/nvme0n1\n(parted) is interactive, which this phone terminal cannot show.\nPut the commands on the command line instead, for example:\n  sudo parted -s /dev/nvme0n2 mklabel gpt mkpart data xfs 1MiB 1GiB print');
  const d = dev(sh, path);
  if (!d) return fail(`Error: Could not stat device ${path} - No such file or directory.`);
  if (d.type !== 'disk') return fail(`Error: ${d.path}: unrecognised disk label`);
  const cmds = rest.slice(1);
  if (!cmds.length) {
    return fail(`GNU Parted 3.6\nUsing ${d.path}\nparted is interactive without commands, which this phone terminal cannot show.\nPut the commands on the command line instead, for example:\n  sudo parted ${d.path} print\n  sudo parted -s ${d.path} mklabel gpt mkpart data xfs 1MiB 1GiB`);
  }
  const r: PartedRun = { sh, disk: d.disk!, path: d.path, unit: 'compact', script, out: '', changed: false };
  let error: string | null = null;
  let failed = false;
  for (let j = 0; j < cmds.length && !error; ) {
    const c = cmds[j++];
    const next = () => cmds[j++];
    switch (c) {
      case 'mklabel':
      case 'mktable':
        error = partedMklabel(r, next());
        break;
      case 'mkpart': {
        const tokens: string[] = [];
        while (j < cmds.length && !PARTED_CMDS.includes(cmds[j])) tokens.push(cmds[j++]);
        error = partedMkpart(r, tokens);
        break;
      }
      case 'rm':
        error = partedRm(r, next());
        break;
      case 'print': {
        const opt = PARTED_CMDS.includes(cmds[j] ?? 'print') ? undefined : next();
        const p = partedPrint(r, opt === 'free');
        if (p.error) {
          r.out += p.error + '\n' + p.text;
          failed = true;
          j = cmds.length;
        } else r.out += p.text;
        break;
      }
      case 'set': {
        const n = next();
        const flag = next();
        const v = cmds[j] === 'on' || cmds[j] === 'off' ? (next() as 'on' | 'off') : 'toggle';
        error = partedSet(r, n, flag, v);
        break;
      }
      case 'toggle':
        error = partedSet(r, next(), next(), 'toggle');
        break;
      case 'name': {
        const p = partedFind(r, next());
        const n = next();
        if (typeof p === 'string') error = p;
        else if (r.disk.table !== 'gpt') error = `Error: msdos disk labels do not support partition names.`;
        else if (n === undefined) error = 'Error: Expecting a partition name.';
        else p.name = n;
        break;
      }
      case 'resizepart':
        error = partedResize(r, next(), next());
        break;
      case 'unit': {
        const u = next();
        if (!u || !isUnit(u.toLowerCase())) error = u ? `parted: invalid token: ${u}\nError: Expecting a unit.` : 'Error: Expecting a unit.';
        else r.unit = u.toLowerCase() === 'compact' ? 'compact' : u;
        break;
      }
      case 'quit':
        j = cmds.length;
        break;
      case 'help':
        r.out += '  mklabel,mktable LABEL-TYPE               create a new disklabel (partition table)\n  mkpart PART-TYPE [FS-TYPE] START END     make a partition\n  print [devices|free|list,all]            display the partition table\n  rm NUMBER                                delete partition NUMBER\n  set NUMBER FLAG STATE                    change the FLAG on partition NUMBER\n  unit UNIT                                set the default unit to UNIT\n';
        break;
      default:
        error = `parted: invalid token: ${c}`;
    }
  }
  const info = r.changed ? 'Information: You may need to update /etc/fstab.\n\n' : '';
  if (r.changed) syncDev(sh.state);
  if (error) return r.out || info ? { stdout: r.out + error + '\n' + info, stderr: '', code: 1 } : fail(error);
  return { stdout: r.out + info, stderr: '', code: failed ? 1 : 0 };
};

const partprobe: Command = ({ sh, args }) => {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (sh.uid !== 0) return fail(`Error: Error opening ${targets[0] ?? '/dev/nvme0n1'}: Permission denied\n${SUDO}`);
  for (const a of targets) if (!dev(sh, a)) return fail(`Error: Could not stat device ${a} - No such file or directory.`);
  return ok();
};

// ---------- wipefs ----------

const SIGS: Record<string, { off: number; magic: string }> = {
  xfs: { off: 0, magic: '58 46 53 42' },
  ext4: { off: 0x438, magic: '53 ef' },
  vfat: { off: 0x52, magic: '46 41 54 33 32 20 20 20' },
  swap: { off: 0xff6, magic: '53 57 41 50 53 50 41 43 45 32' },
  LVM2_member: { off: 0x218, magic: '4c 56 4d 32 20 30 30 31' },
};

function signatures(s: StorageState, d: BlockDevice): { off: number; type: string; magic: string }[] {
  const out: { off: number; type: string; magic: string }[] = [];
  const sig = signatureOf(s, d);
  if (sig) out.push({ ...SIGS[sig], type: sig });
  if (d.type === 'disk' && d.disk?.table === 'gpt') {
    out.push({ off: 0x200, type: 'gpt', magic: '45 46 49 20 50 41 52 54' }, { off: d.size - 0x200, type: 'gpt', magic: '45 46 49 20 50 41 52 54' }, { off: 0x1fe, type: 'PMBR', magic: '55 aa' });
  } else if (d.type === 'disk' && d.disk?.table === 'msdos') out.push({ off: 0x1fe, type: 'dos', magic: '55 aa' });
  return out;
}

const wipefs: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args, ['t', 'o']);
  const s = st(sh);
  if (!operands.length) return fail('wipefs: no device specified\nTry \'wipefs --help\' for more information.');
  if (sh.uid !== 0) return fail(`wipefs: error: ${operands[0]}: probing initialization failed: Permission denied\n${SUDO}`);
  const wipe = flags.has('a') || flags.has('all');
  const rows: string[][] = [['DEVICE', 'OFFSET', 'TYPE', 'UUID', 'LABEL']];
  let out = '';
  for (const a of operands) {
    const d = dev(sh, a);
    if (!d) return fail(`wipefs: error: ${a}: probing initialization failed: No such file or directory`);
    const sigs = signatures(s, d);
    if (!wipe) {
      for (const x of sigs) rows.push([d.kname, `0x${x.off.toString(16)}`, x.type, x.type === 'gpt' || x.type === 'PMBR' || x.type === 'dos' ? '' : blkidTags(s, d).find(([k]) => k === 'UUID')?.[1] ?? '', d.holder.fs?.label ?? '']);
      continue;
    }
    if (busy(s, d)) return fail(`wipefs: error: ${d.path}: probing initialization failed: Device or resource busy`);
    for (const x of sigs) out += `${d.path}: ${x.magic.split(' ').length} bytes were erased at offset 0x${x.off.toString(16).padStart(8, '0')} (${x.type}): ${x.magic}\n`;
    if (d.type === 'disk' && d.disk?.table) out += `${d.path}: calling ioctl to re-read partition table: Success\n`;
    wipeDevice(s, d);
  }
  if (!wipe) return ok(rows.length > 1 ? columns(rows) : '');
  syncDev(sh.state);
  return ok(out);
};

// ---------- mkfs, mkswap ----------

interface Target {
  d?: BlockDevice;
  error?: CommandResult;
  header?: string;
}

/** Common checks before writing a new signature. `force` overwrites an existing one. */
function mkfsCheck(ctx: CommandContext, prog: 'mkfs.xfs' | 'mke2fs' | 'mkfs.fat' | 'mkswap', path: string | undefined, force: boolean): Target {
  const { sh, stdin } = ctx;
  const s = st(sh);
  const header = prog === 'mke2fs' ? E2FS + '\n' : prog === 'mkfs.fat' ? 'mkfs.fat 4.2 (2021-01-31)\n' : '';
  const err = (msg: string, code = 1): Target => ({ error: { stdout: '', stderr: header + msg + (msg.endsWith('\n') ? '' : '\n'), code } });
  if (!path) {
    if (prog === 'mkfs.xfs') return err('Error: no device specified.\nUsage: mkfs.xfs [-L label] [-f] device');
    if (prog === 'mke2fs') return err('Usage: mkfs.ext4 [-L volume-label] [-F] device [fs-size]');
    if (prog === 'mkfs.fat') return err('No device specified.\nUsage: mkfs.fat [OPTIONS] TARGET [BLOCKS]');
    return err('mkswap: no device specified\nTry \'mkswap --help\' for more information.');
  }
  if (sh.uid !== 0) {
    const msg = {
      'mkfs.xfs': `mkfs.xfs: cannot open ${path}: Permission denied`,
      mke2fs: `Could not open ${path}: Permission denied`,
      'mkfs.fat': `mkfs.fat: unable to open ${path}: Permission denied`,
      mkswap: `mkswap: cannot open ${path}: Permission denied`,
    }[prog];
    return err(`${msg}\n${SUDO}`);
  }
  const d = dev(sh, path);
  if (!d) {
    return err({
      'mkfs.xfs': `Error accessing specified device ${path}: No such file or directory`,
      mke2fs: `The file ${path} does not exist and no size was specified.`,
      'mkfs.fat': `mkfs.fat: unable to open ${path}: No such file or directory`,
      mkswap: `mkswap: cannot open ${path}: No such file or directory`,
    }[prog]);
  }
  if (d.part?.kind === 'extended') return err(`${prog === 'mke2fs' ? 'mke2fs' : prog}: ${d.path}: device is too small`);
  const mounted = mountsOf(s, d.path).length > 0;
  if (mounted) {
    return err({
      'mkfs.xfs': `mkfs.xfs: ${d.path} contains a mounted filesystem`,
      mke2fs: `${d.path} is mounted; will not make a filesystem here!`,
      'mkfs.fat': `mkfs.fat: unable to open ${d.path}: Device or resource busy`,
      mkswap: `mkswap: error: ${d.path} is mounted; will not make swapspace`,
    }[prog]);
  }
  if (busy(s, d)) {
    return err({
      'mkfs.xfs': `mkfs.xfs: cannot open ${d.path}: Device or resource busy`,
      mke2fs: `${d.path} is apparently in use by the system; will not make a filesystem here!`,
      'mkfs.fat': `mkfs.fat: unable to open ${d.path}: Device or resource busy`,
      mkswap: `mkswap: cannot open ${d.path}: Device or resource busy`,
    }[prog]);
  }
  const sig = signatureOf(s, d);
  const pt = d.type === 'disk' && d.disk?.table ? (d.disk.table === 'msdos' ? 'dos' : 'gpt') : null;
  if ((sig || pt) && !force) {
    if (prog === 'mkfs.xfs') {
      return err(pt ? `mkfs.xfs: ${d.path} appears to contain a partition table (${pt}).\nmkfs.xfs: Use the -f option to force overwrite.` : `mkfs.xfs: ${d.path} appears to contain an existing filesystem (${sig}).\nmkfs.xfs: Use the -f option to force overwrite.`);
    }
    if (prog === 'mke2fs' && !yesAnswer(stdin)) {
      const what = pt ? `Found a ${pt} partition table in ${d.path}` : `${d.path} contains a ${sig} file system${d.holder.fs?.label ? ` labelled '${d.holder.fs.label}'` : ''}`;
      return err(`${what}\nProceed anyway? (y,N) \n${NO_PROMPT('Add -F to overwrite it.')}`);
    }
    if (prog === 'mkfs.fat' && pt) return err(`mkfs.fat: Partitions or virtual mappings on device '${d.path}', not making filesystem (use -I to override)`);
    if (prog === 'mkswap' && pt) return err(`mkswap: ${d.path}: warning: don't erase bootbits sectors\n        (${pt} partition table detected). Use -f to force.`);
  }
  return { d, header };
}

function writeFs(sh: Shell, d: BlockDevice, type: FsType, label: string, uuid?: string): FileSystem {
  const s = st(sh);
  wipeDevice(s, d);
  const size = type === 'swap' ? d.size : Math.floor(d.size / 4096) * 4096;
  const fs: FileSystem = {
    type, label, size, used: freshUsed(type, size),
    uuid: uuid ?? (type === 'vfat' ? newVfatId(s) : newUuid(s)),
  };
  d.holder.fs = fs;
  syncDev(sh.state);
  return fs;
}

function xfsGeometry(path: string, fs: FileSystem): string {
  const blocks = Math.floor(fs.size / 4096);
  const agcount = blocks > 4 * 1024 ** 3 / 4 ? Math.ceil(blocks / (GiB / 4)) : 4;
  return [
    `meta-data=${path.padEnd(22)} isize=512    agcount=${agcount}, agsize=${Math.ceil(blocks / agcount)} blks`,
    '         =                       sectsz=512   attr=2, projid32bit=1',
    '         =                       crc=1        finobt=1, sparse=1, rmapbt=1',
    '         =                       reflink=1    bigtime=1 inobtcount=1 nrext64=1',
    `data     =                       bsize=4096   blocks=${blocks}, imaxpct=25`,
    '         =                       sunit=0      swidth=0 blks',
    'naming   =version 2              bsize=4096   ascii-ci=0, ftype=1',
    `log      =internal log           bsize=4096   blocks=${xfsLogSize(fs.size) / 4096}, version=2`,
    '         =                       sectsz=512   sunit=0 blks, lazy-count=1',
    'realtime =none                   extsz=4096   blocks=0, rtextents=0',
  ].join('\n') + '\n';
}

const mkfsXfs: Command = (ctx) => {
  const { flags, values, operands } = getopts(ctx.args, ['L', 'b', 'd', 'i', 'l', 'm', 'n', 'r', 's']);
  const label = values.L ?? '';
  if (label.length > 12) return fail(`Invalid value ${label} for -L option\nUsage: mkfs.xfs [-L label] [-f] device`);
  const t = mkfsCheck(ctx, 'mkfs.xfs', operands[0], flags.has('f'));
  if (t.error) return t.error;
  if (t.d!.size < 300 * MiB) return fail('Filesystem must be larger than 300MB.\nUsage: mkfs.xfs [-L label] [-f] device');
  const fs = writeFs(ctx.sh, t.d!, 'xfs', label);
  return ok(xfsGeometry(t.d!.path, fs) + 'Discarding blocks...Done.\n');
};

function superblockBackups(blocks: number): string {
  const groups = Math.ceil(blocks / 32768);
  const has = (g: number) => g === 1 || [3, 5, 7].some((b) => {
    let x = b;
    while (x < g) x *= b;
    return x === g;
  });
  let out = '';
  let left = 0;
  let first = true;
  for (let g = 1; g < groups; g++) {
    if (!has(g)) continue;
    const blk = g * 32768;
    if (!first) out += ', ';
    first = false;
    const need = String(blk).length + 2;
    if (need > left) {
      out += '\n\t';
      left = 72;
    }
    left -= need;
    out += blk;
  }
  return out ? `Superblock backups stored on blocks: ${out}`.replace(/ +\n/g, '\n') + '\n\n' : '';
}

const mkfsExt4: Command = (ctx) => {
  const { flags, values, operands } = getopts(ctx.args, ['L', 'b', 'm', 'i', 'I', 'N', 'O', 'T', 't', 'E', 'U', 'j']);
  const t = mkfsCheck(ctx, 'mke2fs', operands[0], flags.has('F'));
  if (t.error) return t.error;
  let label = values.L ?? '';
  let warn = '';
  if (label.length > 16) {
    label = label.slice(0, 16);
    warn = `Warning: label too long; will be truncated to '${label}'\n\n`;
  }
  const fs = writeFs(ctx.sh, t.d!, 'ext4', label);
  const blocks = fs.size / 4096;
  const inodes = Math.ceil(blocks / 32768) * Math.min(8192, Math.floor(blocks / 4));
  return ok(
    `${E2FS}\n${warn}Discarding device blocks: done\nCreating filesystem with ${blocks} 4k blocks and ${inodes} inodes\nFilesystem UUID: ${fs.uuid}\n` +
      superblockBackups(blocks).replace(/^/, '') +
      (superblockBackups(blocks) ? '' : '\n') +
      `Allocating group tables: done\nWriting inode tables: done\nCreating journal (${ext4JournalBlocks(blocks)} blocks): done\nWriting superblocks and filesystem accounting information: done\n\n`,
  );
};

const mkfsVfat: Command = (ctx) => {
  const { flags, values, operands } = getopts(ctx.args, ['n', 'F', 's', 'S', 'i', 'L']);
  const head = 'mkfs.fat 4.2 (2021-01-31)\n';
  if (values.L !== undefined || flags.has('L')) {
    return fail(`mkfs.fat: invalid option -- 'L'\nUsage: mkfs.fat [OPTIONS] TARGET [BLOCKS]\n(Hint: the label option of mkfs.vfat is -n, for example: mkfs.vfat -n USBDATA ${operands[0] ?? '/dev/nvme0n2p1'})`);
  }
  const label = values.n ?? '';
  if (label.length > 11) return fail(`${head}mkfs.fat: Label can be no longer than 11 characters`);
  const t = mkfsCheck(ctx, 'mkfs.fat', operands[0], flags.has('I'));
  if (t.error) return t.error;
  const warn = label !== label.toUpperCase() ? 'mkfs.fat: Warning: lowercase labels might not work properly on some systems\n' : '';
  writeFs(ctx.sh, t.d!, 'vfat', label);
  return ok(head + warn);
};

const mkswap: Command = (ctx) => {
  const { flags, values, operands } = getopts(ctx.args, ['L', 'U', 'p', 'label', 'uuid']);
  const t = mkfsCheck(ctx, 'mkswap', operands[0], flags.has('f') || flags.has('force'));
  if (t.error) return t.error;
  const d = t.d!;
  if (d.size < 40 * KiB) return fail(`mkswap: error: swap area needs to be at least 40 KiB`);
  let label = values.L ?? values.label ?? '';
  let out = '';
  if (label.length > 16) {
    label = label.slice(0, 16);
    out += `mkswap: label is too long. Truncating it to '${label}'\n`;
  }
  const old = signatureOf(st(ctx.sh), d);
  if (old) out += `mkswap: ${d.path}: warning: wiping old ${old} signature.\n`;
  const fs = writeFs(ctx.sh, d, 'swap', label, values.U ?? values.uuid);
  const bytes = fs.size - 4096;
  out += `Setting up swapspace version 1, size = ${humanSize(bytes, { space: true, iec: true, two: true })} (${bytes} bytes)\n`;
  out += label ? `LABEL=${label}, UUID=${fs.uuid}\n` : `no label, UUID=${fs.uuid}\n`;
  return ok(out);
};

const mkfs: Command = (ctx) => {
  const args = [...ctx.args];
  let type: string | undefined;
  const i = args.findIndex((a) => a === '-t' || a.startsWith('--type') || /^-t./.test(a));
  if (i >= 0) {
    const a = args[i];
    if (a === '-t' || a === '--type') {
      type = args[i + 1];
      args.splice(i, 2);
    } else {
      type = a.startsWith('--type=') ? a.slice(7) : a.slice(2);
      args.splice(i, 1);
    }
  }
  const run = { xfs: mkfsXfs, ext4: mkfsExt4, vfat: mkfsVfat, fat: mkfsVfat, msdos: mkfsVfat }[type ?? ''];
  if (!run) {
    return fail(`mkfs: failed to execute mkfs.${type ?? 'ext2'}: No such file or directory\n(This practice server knows mkfs -t xfs, mkfs -t ext4 and mkfs -t vfat.)`);
  }
  return run({ ...ctx, args, name: `mkfs.${type}` });
};

// ---------- swap ----------

function swapOn(state: SystemState, spec: string, prio?: number): string | null {
  const p = planSwap(state, spec);
  if (p.error) return p.error;
  const s = state.storage;
  s.swaps.push({ device: p.dev!.path, priority: prio ?? s.nextSwapPriority-- });
  return null;
}

const prioOf = (opts: string[]) => {
  const v = opts.find((o) => o.startsWith('pri='))?.slice(4);
  return v !== undefined && /^-?\d+$/.test(v) ? +v : undefined;
};

const swapon: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['p', 'priority', 'o', 'options']);
  const s = st(sh);
  const show = flags.has('show') || values.show !== undefined;
  if (flags.has('s') || flags.has('summary')) return ok(sh.readFile('/proc/swaps'));
  if (show || (!operands.length && !flags.has('a') && !flags.has('all'))) {
    const cols = (values.show ?? 'NAME,TYPE,SIZE,USED,PRIO').split(',').map((c) => c.toUpperCase());
    const rows = s.swaps.map((a) => {
      const d = findDevice(s, a.device)!;
      const size = d.holder.fs ? swapKiB(d.holder.fs) * KiB : 0;
      const v: Record<string, string> = { NAME: `/dev/${d.kname}`, TYPE: 'partition', SIZE: humanSize(size), USED: '0B', PRIO: String(a.priority), UUID: d.holder.fs?.uuid ?? '', LABEL: d.holder.fs?.label ?? '' };
      return cols.map((c) => v[c] ?? '');
    });
    if (!rows.length) return ok();
    const right = cols.map((c) => ['SIZE', 'USED', 'PRIO'].includes(c));
    return ok(columns(flags.has('noheadings') ? rows : [cols, ...rows], right));
  }
  if (sh.uid !== 0) {
    const what = operands[0] ?? parseFstab(readFstab(sh.state)).entries.find((e) => e.type === 'swap')?.spec ?? '/dev/dm-1';
    return fail(`swapon: ${what}: swapon failed: Operation not permitted\n${SUDO}`);
  }
  const prioArg = values.p ?? values.priority;
  const prio = prioArg !== undefined ? parseInt(prioArg, 10) : undefined;
  let err = '';
  let out = '';
  if (flags.has('a') || flags.has('all')) {
    for (const e of parseFstab(readFstab(sh.state)).entries) {
      if (e.type !== 'swap' || e.options.includes('noauto')) continue;
      const d = findDevice(s, e.spec);
      if (d && isSwapOn(s, d.path)) continue;
      const r = swapOn(sh.state, e.spec, prioOf(e.options));
      if (r && !e.options.includes('nofail')) err += r + '\n';
      else if (!r && flags.has('v')) out += `swapon: ${d!.path}: found signature [pagesize=4096, signature=swap]\nswapon: /dev/${d!.kname}: pagesize=4096, swapsize=${d!.size}, devsize=${d!.size}\nswapon ${d!.path}\n`;
    }
  }
  for (const a of operands) {
    const r = swapOn(sh.state, a, prio);
    if (r) err += r + '\n';
  }
  return { stdout: out, stderr: err, code: err ? 255 : 0 };
};

const swapoff: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args);
  const s = st(sh);
  if (sh.uid !== 0) return fail(`swapoff: ${operands[0] ?? '/dev/dm-1'}: swapoff failed: Operation not permitted\n${SUDO}`);
  if (flags.has('a') || flags.has('all')) {
    s.swaps = [];
    return ok();
  }
  if (!operands.length) return fail('swapoff: bad usage\nTry \'swapoff --help\' for more information.');
  let err = '';
  for (const a of operands) {
    const d = findDevice(s, a);
    if (!d) {
      err += /^(UUID|LABEL)=/.test(a) ? `swapoff: cannot find the device for ${a}\n` : `swapoff: ${a}: swapoff failed: No such file or directory\n`;
      continue;
    }
    if (!isSwapOn(s, d.path)) {
      err += `swapoff: ${a}: swapoff failed: Invalid argument\n`;
      continue;
    }
    s.swaps = s.swaps.filter((x) => x.device !== d.path);
  }
  return { stdout: '', stderr: err, code: err ? 255 : 0 };
};

// ---------- mount, umount ----------

/** Mount a device (or tmpfs) on a mount point. Returns an error (without "mount: ") or null. */
function doMount(state: SystemState, spec: string, target: string, type: string | undefined, opts: string[]): { error: string; dmesg?: boolean } | null {
  const s = state.storage;
  if (type === 'tmpfs') {
    const t = lookup(state, target);
    if (!t) return { error: `${target}: mount point does not exist.`, dmesg: true };
    attachMount(state, { source: spec, target: '/' + t.parts.join('/'), type: 'tmpfs', options: opts }, makeTmpfsRoot());
    return null;
  }
  const plan = planMount(state, spec, target, type, opts);
  if (plan.error) return { error: plan.error, dmesg: plan.dmesg };
  const d = plan.dev!;
  const fs = plan.fs!;
  const where = '/' + lookup(state, target)!.parts.join('/');
  // a file system mounted a second time shows the same files
  const other = mountsOf(s, d.path)[0];
  const node = (other && lookup(state, other.target)?.node) || fs.root || freshRoot(fs.type);
  fs.root = undefined;
  attachMount(state, { source: d.path, target: where, type: fs.type, options: opts.length ? opts : ['defaults'] }, node);
  return null;
}

function makeTmpfsRoot(): FsNode {
  const n = freshRoot('xfs');
  n.mode = 0o1777;
  return n;
}

/** Unmount one mount, keeping the file system's files for the next mount. */
function doUnmount(state: SystemState, m: Mount) {
  const node = detachMount(state, m);
  const s = state.storage;
  if (m.type === 'tmpfs' || !node) return;
  const fs = findDevice(s, m.source)?.holder.fs;
  if (fs && !mountsOf(s, m.source).length) fs.root = node;
}

/** True when /etc/fstab changed after systemd last read it (boot or systemctl daemon-reload). */
function fstabStale(sh: Shell): boolean {
  const s = st(sh);
  const text = readFstab(sh.state);
  let reload = -1;
  let edit = -1;
  let reloadPos = -1;
  let editPos = -1;
  sh.history.forEach((line, i) => {
    const r = line.search(/systemctl\s+(\S+\s+)*daemon-reload/);
    const e = /fstab/.test(line) && /(>|\btee\b|\bsed\s+-i|\bvim?\b|\bnano\b|\bcp\b|\bmv\b)/.test(line) ? line.lastIndexOf('fstab') : -1;
    if (r >= 0) [reload, reloadPos] = [i, r];
    if (e >= 0) [edit, editPos] = [i, e];
  });
  if (reload > edit || (reload === edit && reload >= 0 && reloadPos > editPos)) s.fstabLoaded = text;
  return text !== s.fstabLoaded;
}

const FSTAB_HINT = "mount: (hint) your fstab has been modified, but systemd still uses\n       the old version; use 'systemctl daemon-reload' to reload.\n";

function mountError(e: { error: string; dmesg?: boolean }): string {
  return `mount: ${e.error}\n${e.dmesg ? DMESG + '\n' : ''}`;
}

function listMounts(s: StorageState, type: string | undefined, labels: boolean): string {
  return mountRows(s)
    .filter((r) => !type || type.split(',').includes(r.type))
    .map((r) => `${r.source} on ${r.target} type ${r.type} (${r.options})${labels && r.dev?.holder.fs?.label ? ` [${r.dev.holder.fs.label}]` : ''}`)
    .join('\n') + '\n';
}

const mount: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['t', 'o', 'L', 'U', 'types', 'options', 'label', 'uuid']);
  const s = st(sh);
  const type = values.t ?? values.types;
  const opts = (values.o ?? values.options ?? '').split(',').filter(Boolean);
  const label = values.L ?? values.label;
  const uuid = values.U ?? values.uuid;
  const all = flags.has('a') || flags.has('all');
  const verbose = flags.has('v') || flags.has('verbose');
  if (flags.has('bind') || flags.has('B') || flags.has('rbind')) return fail('mount: bind mounts are not simulated on this practice server.');
  if (!all && !operands.length && label === undefined && uuid === undefined) return ok(listMounts(s, type, flags.has('l')));
  const denied = (target: string) => `mount: ${target}: must be superuser to use mount.\n`;

  if (all) {
    const { entries, errors } = parseFstab(readFstab(sh.state));
    let err = errors.map((n) => `mount: /etc/fstab: parse error at line ${n} -- ignored\n`).join('');
    let out = '';
    for (const e of entries) {
      const target = e.file;
      const say = (msg: string) => {
        if (verbose) out += `${target.padEnd(25)}: ${msg}\n`;
      };
      if (e.type === 'swap' || e.options.includes('noauto')) {
        say('ignored');
        continue;
      }
      if (type && !type.split(',').includes(e.type)) continue;
      const where = lookup(sh.state, target);
      if (target === '/' || (where && s.mounts.some((m) => m.target === '/' + where.parts.join('/')))) {
        say('already mounted');
        continue;
      }
      if (sh.uid !== 0) {
        err += denied(target);
        continue;
      }
      if (NETWORK_FS.includes(e.type)) {
        err += `mount.${e.type.replace(/4$/, '')}: Connection timed out\n(This practice server has no network file servers to reach.)\n`;
        continue;
      }
      const r = doMount(sh.state, e.spec, target, e.type, e.options);
      if (r) err += mountError(r);
      else say('successfully mounted');
    }
    if (sh.uid !== 0 && err) err += SUDO + '\n';
    if (fstabStale(sh)) out += FSTAB_HINT;
    syncDev(sh.state);
    return { stdout: out, stderr: err, code: err ? (sh.uid !== 0 ? 1 : 32) : 0 };
  }

  let spec = label !== undefined ? `LABEL=${label}` : uuid !== undefined ? `UUID=${uuid}` : operands[0];
  let target = label !== undefined || uuid !== undefined ? operands[0] : operands[1];
  let mtype = type;
  let mopts = opts;
  let fromFstab = false;

  if (opts.includes('remount')) {
    const t = canonical(sh, target ?? spec) ?? target ?? spec;
    if (sh.uid !== 0) return fail(denied(t) + SUDO);
    const m = mountAt(s, t) ?? (findDevice(s, t) ? mountsOf(s, findDevice(s, t)!.path)[0] : undefined);
    if (!m) return fail(`mount: ${t}: mount point not mounted or bad option.\n${DMESG}`, 32);
    const rest = opts.filter((o) => o !== 'remount');
    const bad = m.type === 'tmpfs' ? null : badOption(m.type, rest);
    if (bad) return fail(`mount: ${t}: mount point not mounted or bad option.\n${DMESG}`, 32);
    m.options = [...m.options.filter((o) => o !== 'defaults' && !rest.some((r) => r.split('=')[0] === o.split('=')[0] || (['ro', 'rw'].includes(r) && ['ro', 'rw'].includes(o)))), ...rest];
    return ok();
  }

  if (!target) {
    // one argument: look it up in /etc/fstab by mount point or by device
    const a = spec!;
    const p = canonical(sh, a) ?? a;
    const d = findDevice(s, a);
    const e = parseFstab(readFstab(sh.state)).entries.find((x) => x.file === p || x.file === a || x.spec === a || (!!d && findDevice(s, x.spec)?.path === d.path));
    if (!e) return fail(`mount: ${a}: can't find in /etc/fstab.`);
    if (e.type === 'swap') return fail(`mount: ${e.file}: unknown filesystem type 'swap'.\n${DMESG}`, 32);
    spec = e.spec;
    target = e.file;
    mtype = type ?? e.type;
    mopts = [...e.options, ...opts];
    fromFstab = true;
  }
  const where = canonical(sh, target) ?? target;
  if (sh.uid !== 0) return fail(denied(where) + SUDO);
  if (mtype && NETWORK_FS.includes(mtype)) {
    return fail(`mount.${mtype.replace(/4$/, '')}: Connection timed out\n(This practice server has no network file servers to reach.)`, 32);
  }
  const r = doMount(sh.state, spec!, where, mtype, mopts);
  if (r) return fail(mountError(r), 32);
  syncDev(sh.state);
  return ok(fromFstab && fstabStale(sh) ? FSTAB_HINT : '');
};

function umountBusy(sh: Shell, target: string): boolean {
  if (target === '/') return true;
  const inside = (p: string) => p === target || p.startsWith(target + '/');
  if (sh.sessions.some((x) => inside(x.cwd))) return true;
  return st(sh).mounts.some((m) => m.target !== target && m.target.startsWith(target + '/'));
}

const umount: Command = ({ sh, args }) => {
  const { flags, operands } = getopts(args, ['t', 'O']);
  const s = st(sh);
  if (!operands.length) return fail("umount: bad usage\nTry 'umount --help' for more information.");
  let err = '';
  let code = 0;
  for (const a of operands) {
    const d = a.startsWith('/dev/') || /^(UUID|LABEL)=/.test(a) ? findDevice(s, a) : null;
    let m: Mount | undefined;
    let shown = a;
    if (d) {
      const ms = mountsOf(s, d.path);
      m = ms[ms.length - 1];
    } else {
      const p = canonical(sh, a);
      if (!p) {
        err += `umount: ${a}: no mount point specified.\n`;
        code = 32;
        continue;
      }
      shown = p;
      m = mountAt(s, p);
    }
    if (sh.uid !== 0) {
      err += `umount: ${shown}: must be superuser to unmount.\n${SUDO}\n`;
      code = 32;
      continue;
    }
    if (!m) {
      err += `umount: ${shown}: not mounted.\n`;
      code = 32;
      continue;
    }
    if (!(flags.has('l') || flags.has('lazy')) && umountBusy(sh, m.target)) {
      const inShell = sh.sessions.some((x) => x.cwd === m!.target || x.cwd.startsWith(m!.target + '/'));
      err += `umount: ${m.target}: target is busy.\n${inShell ? `(Your shell is inside ${m.target}. Run cd / first.)\n` : ''}`;
      code = 32;
      continue;
    }
    doUnmount(sh.state, m);
  }
  syncDev(sh.state);
  return { stdout: '', stderr: err, code };
};

// ---------- xfs and ext4 tools ----------

/** Find a mounted file system by mount point or device. */
function mountedFs(sh: Shell, a: string): { m: Mount; d: BlockDevice; fs: FileSystem } | null {
  const s = st(sh);
  const d0 = a.startsWith('/dev/') ? findDevice(s, a) : null;
  const m = d0 ? mountsOf(s, d0.path)[0] : mountAt(s, canonical(sh, a) ?? a);
  const d = m ? findDevice(s, m.source) : null;
  return m && d?.holder.fs ? { m, d, fs: d.holder.fs } : null;
}

function growXfs(path: string, fs: FileSystem, deviceSize: number, blocksWanted?: number): string {
  const old = Math.floor(fs.size / 4096);
  const max = Math.floor(deviceSize / 4096);
  const target = blocksWanted ? Math.min(blocksWanted, max) : max;
  let out = xfsGeometry(path, fs);
  if (target > old) {
    fs.size = target * 4096;
    out += `data blocks changed from ${old} to ${target}\n`;
  }
  return out;
}

const xfsGrowfs: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['D', 'L', 'R', 'm']);
  const a = operands[0];
  if (!a) return fail('Usage: xfs_growfs [-dlnrx] [-D size] mountpoint');
  const f = mountedFs(sh, a);
  if (!f || f.fs.type !== 'xfs') return fail(`xfs_growfs: ${a} is not a mounted XFS filesystem`);
  if (sh.uid !== 0) return fail(`xfs_growfs: XFS_IOC_FSGROWFSDATA xfsctl failed: Operation not permitted\n${SUDO}`);
  if (flags.has('n')) return ok(xfsGeometry(f.d.path, f.fs));
  const want = values.D ? parseInt(values.D, 10) : undefined;
  if (want !== undefined && want < f.fs.size / 4096) return fail(xfsGeometry(f.d.path, f.fs) + 'xfs_growfs: XFS_IOC_FSGROWFSDATA xfsctl failed: Invalid argument');
  return ok(growXfs(f.d.path, f.fs, f.d.size, want));
};

const xfsInfo: Command = ({ sh, args }) => {
  const a = args.find((x) => !x.startsWith('-'));
  if (!a) return fail('Usage: xfs_info [-V] [-t mtab] [mountpoint|device|file]');
  const f = mountedFs(sh, a);
  const d = f?.d ?? dev(sh, a);
  const fs = f?.fs ?? d?.holder.fs;
  if (!d || !fs || fs.type !== 'xfs') return fail(`${a}: cannot find an XFS filesystem`);
  if (!f && sh.uid !== 0) return fail(`xfs_info: cannot open ${a}: Permission denied\n${SUDO}`);
  return ok(xfsGeometry(d.path, fs));
};

const xfsAdmin: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['L', 'U']);
  const a = operands[0];
  if (!a) return fail('Usage: xfs_admin [-efjlpuV] [-c 0|1] [-L label] [-O v5_feature] [-r rtdev] [-U uuid] device [logdev]');
  if (sh.uid !== 0) return fail(`xfs_admin: cannot open ${a}: Permission denied\n${SUDO}`);
  const d = dev(sh, a);
  if (!d) return fail(`xfs_admin: ${a}: No such file or directory`);
  const fs = d.holder.fs;
  if (!fs || fs.type !== 'xfs') return fail(`xfs_db: ${d.path} is not a valid XFS filesystem (unexpected SB magic number 0x00000000)\nUse -F to force a read attempt.`);
  let out = '';
  if (flags.has('l')) out += `label = "${fs.label}"\n`;
  if (flags.has('u')) out += `UUID = ${fs.uuid}\n`;
  if (values.L !== undefined) {
    const label = values.L === '--' ? '' : values.L;
    if (label.length > 12) return fail(`xfs_admin: label "${label}" is too long, it can be at most 12 characters`);
    fs.label = label;
    out += mountsOf(st(sh), d.path).length ? `label = "${label}"\n` : `writing all SBs\nnew label = "${label}"\n`;
  }
  if (values.U !== undefined) {
    if (mountsOf(st(sh), d.path).length) return fail(`xfs_admin: ${d.path} contains a mounted filesystem`);
    fs.uuid = values.U === 'generate' ? newUuid(st(sh)) : values.U;
    out += `Clearing log and setting UUID\nwriting all SBs\nnew UUID = ${fs.uuid}\n`;
  }
  syncDev(sh.state);
  return ok(out);
};

function ext4Fs(sh: Shell, prog: string, a: string | undefined): { d: BlockDevice; fs: FileSystem } | CommandResult {
  if (!a) return fail(`Usage: ${prog} device [newlabel]`);
  if (sh.uid !== 0) return fail(`${prog}: Permission denied while trying to open ${a}\nCouldn't find valid filesystem superblock.\n${SUDO}`);
  const d = dev(sh, a);
  if (!d) return fail(`${prog}: No such file or directory while trying to open ${a}\nCouldn't find valid filesystem superblock.`);
  const fs = d.holder.fs;
  if (!fs || fs.type !== 'ext4') {
    const sig = signatureOf(st(sh), d);
    return fail(`${prog}: Bad magic number in super-block while trying to open ${d.path}${sig ? `\n${d.path} contains a ${sig} file system` : "\nCouldn't find valid filesystem superblock."}`);
  }
  return { d, fs };
}

const e2label: Command = ({ sh, args }) => {
  const r = ext4Fs(sh, 'e2label', args[0]);
  if ('code' in r) return r;
  if (args[1] === undefined) return ok(r.fs.label + '\n');
  let warn = '';
  let label = args[1];
  if (label.length > 16) {
    label = label.slice(0, 16);
    warn = 'Warning: label too long, truncating.\n';
  }
  r.fs.label = label;
  syncDev(sh.state);
  return { stdout: '', stderr: warn, code: 0 };
};

const tune2fs: Command = ({ sh, args }) => {
  const { flags, values, operands } = getopts(args, ['L', 'm', 'c', 'i', 'e', 'o', 'O', 'U']);
  const r = ext4Fs(sh, 'tune2fs', operands[0]);
  const head = 'tune2fs 1.47.1 (20-May-2024)\n';
  if ('code' in r) return { ...r, stderr: head + r.stderr };
  if (values.L !== undefined) {
    r.fs.label = values.L.slice(0, 16);
    syncDev(sh.state);
  }
  if (flags.has('l')) {
    const blocks = r.fs.size / 4096;
    return ok(
      `${head}Filesystem volume name:   ${r.fs.label || '<none>'}\nLast mounted on:          ${mountsOf(st(sh), r.d.path)[0]?.target ?? '<not available>'}\nFilesystem UUID:          ${r.fs.uuid}\n` +
        `Filesystem magic number:  0xEF53\nFilesystem features:      has_journal ext_attr resize_inode dir_index filetype extent 64bit flex_bg sparse_super large_file huge_file dir_nlink extra_isize metadata_csum\n` +
        `Block count:              ${blocks}\nReserved block count:     ${Math.floor(blocks * 0.05)}\nBlock size:               4096\n`,
    );
  }
  return ok(head);
};

function parseResizeSize(text: string): number | null {
  const m = /^(\d+)([KMGTs]?)$/.exec(text);
  if (!m) return null;
  const n = +m[1];
  const mult = { '': 4096, K: KiB, M: MiB, G: GiB, T: 1024 * GiB, s: SECTOR }[m[2]] ?? 4096;
  return Math.floor((n * mult) / 4096) * 4096;
}

/** Resize an ext4 file system. Returns the resize2fs output; `error` is set when it fails. */
function resizeExt4(path: string, fs: FileSystem, deviceSize: number, newSize: number, mountedOn: string | undefined): { out: string; error?: boolean } {
  const old = fs.size / 4096;
  const blocks = newSize / 4096;
  let out = `${RESIZE2FS}\n`;
  if (newSize > deviceSize) {
    return { out: out + `The containing partition (or device) is only ${Math.floor(deviceSize / 4096)} (4k) blocks.\nYou requested a new size of ${blocks} blocks.\n\n`, error: true };
  }
  if (blocks === old) return { out: out + `The filesystem is already ${old} (4k) blocks long.  Nothing to do!\n\n` };
  if (blocks < old && mountedOn) return { out: out + `Filesystem at ${path} is mounted on ${mountedOn}; on-line resizing required\nresize2fs: On-line shrinking not supported\n`, error: true };
  if (newSize < fs.used + 64 * MiB) return { out: out + `resize2fs: New size smaller than minimum (${Math.ceil((fs.used + 64 * MiB) / 4096)})\n`, error: true };
  out += mountedOn
    ? `Filesystem at ${path} is mounted on ${mountedOn}; on-line resizing required\nold_desc_blocks = 1, new_desc_blocks = 1\n`
    : `Resizing the filesystem on ${path} to ${blocks} (4k) blocks.\n`;
  fs.size = newSize;
  return { out: out + `The filesystem on ${path} is now ${blocks} (4k) blocks long.\n\n` };
}

const resize2fs: Command = ({ sh, args }) => {
  const { operands } = getopts(args);
  if (!operands[0]) return fail(`${RESIZE2FS}\nUsage: resize2fs [-d debug_flags] [-f] [-F] [-M] [-P] [-p] device [-b|-s|new_size] [-S RAID-stride] [-z undo_file]`);
  if (sh.uid !== 0) return fail(`${RESIZE2FS}\nopen: Permission denied while opening ${operands[0]}\n${SUDO}`);
  const d = dev(sh, operands[0]);
  if (!d) return fail(`${RESIZE2FS}\nopen: No such file or directory while opening ${operands[0]}`);
  const fs = d.holder.fs;
  if (!fs || fs.type !== 'ext4') return fail(`${RESIZE2FS}\nresize2fs: Bad magic number in super-block while trying to open ${d.path}\nCouldn't find valid filesystem superblock.`);
  const size = operands[1] ? parseResizeSize(operands[1]) : Math.floor(d.size / 4096) * 4096;
  if (size === null) return fail(`${RESIZE2FS}\nresize2fs: Invalid new size: ${operands[1]}\n`);
  const r = resizeExt4(operands[0], fs, d.size, size, mountsOf(st(sh), d.path)[0]?.target);
  return r.error ? { stdout: '', stderr: r.out, code: 1 } : ok(r.out);
};

// ---------- LVM ----------

const LVM_DENIED = `  WARNING: Running as a non-root user. Functionality may be unavailable.\n  /run/lock/lvm/P_global:aux: open failed: Permission denied\n${SUDO}`;
const NO_SYNTAX = (cmd: string) => `  No command with matching syntax recognised.  Run '${cmd} --help' for more information.`;
const VG_NOT_FOUND = (vg: string) => `  Volume group "${vg}" not found\n  Cannot process volume group ${vg}`;
const lvmFail = (msg: string, code = 5, stdout = '') => fail(msg, code, stdout);
const NAME_OK = /^[A-Za-z0-9+_.][A-Za-z0-9+_.-]*$/;

function validName(name: string): string | null {
  if (!NAME_OK.test(name) || name === '.' || name === '..' || /^(snapshot|pvmove)$/.test(name)) {
    return `  Name "${name}" contains invalid character, valid set includes: [a-zA-Z0-9.-_+].`;
  }
  return null;
}

/** Turn an LVM size like 1G, 500m, +2G, 1.5t (default unit MiB) into bytes. */
function parseLvmSize(text: string): { sign: '' | '+' | '-'; bytes: number } | null {
  const m = /^([+-]?)(\d+(?:\.\d+)?)([bBsSkKmMgGtTpPeE]?)$/.exec(text);
  if (!m) return null;
  const mult: Record<string, number> = { b: 1, s: SECTOR, k: KiB, m: MiB, g: GiB, t: 1024 * GiB, p: 1024 ** 2 * GiB, e: 1024 ** 3 * GiB };
  return { sign: m[1] as '' | '+' | '-', bytes: parseFloat(m[2]) * mult[(m[3] || 'm').toLowerCase()] };
}

function parseExtents(text: string): { sign: '' | '+' | '-'; n: number; pct?: string } | null {
  const m = /^([+-]?)(\d+)(?:%(FREE|VG|PVS|ORIGIN))?$/i.exec(text);
  return m ? { sign: m[1] as '' | '+' | '-', n: +m[2], pct: m[3]?.toUpperCase() } : null;
}

function lvMinor(s: StorageState): number {
  return lowestFree(s.vgs.flatMap((v) => v.lvs.map((l) => l.minor)), 0);
}

/** Take n extents for an LV from the VG's PVs (in order), optionally only from `only`. */
function allocate(s: StorageState, vg: VolumeGroup, lv: LogicalVolume, n: number, only?: string[]): boolean {
  const pvs = pvsOf(s, vg).filter((p) => !only?.length || only.includes(p.device));
  const free = pvs.map((p) => pvExtentCount(s, p, vg.extentSize) - pvUsedExtents(vg, p.device));
  if (free.reduce((a, b) => a + b, 0) < n) return false;
  let left = n;
  pvs.forEach((p, i) => {
    const take = Math.min(free[i], left);
    if (take <= 0) return;
    const last = lv.segments[lv.segments.length - 1];
    if (last && last.pv === p.device) last.extents += take;
    else lv.segments.push({ pv: p.device, extents: take });
    left -= take;
  });
  return true;
}

function release(lv: LogicalVolume, n: number) {
  let left = n;
  while (left > 0 && lv.segments.length) {
    const last = lv.segments[lv.segments.length - 1];
    const take = Math.min(last.extents, left);
    last.extents -= take;
    left -= take;
    if (!last.extents) lv.segments.pop();
  }
}

function lvPathOf(vg: VolumeGroup, lv: LogicalVolume) {
  return `/dev/mapper/${dmName(vg.name, lv.name)}`;
}
function lvOpen(s: StorageState, vg: VolumeGroup, lv: LogicalVolume): boolean {
  const p = lvPathOf(vg, lv);
  return mountsOf(s, p).length > 0 || isSwapOn(s, p);
}

function resolveLv(s: StorageState, arg: string): { vg: VolumeGroup; lv: LogicalVolume } | { error: string } {
  const d = arg.startsWith('/dev/') ? findDevice(s, arg) : null;
  if (d?.vg && d.lv) return { vg: d.vg, lv: d.lv };
  const m = /^(?:\/dev\/)?([^/]+)\/([^/]+)$/.exec(arg);
  if (!m || m[1] === 'mapper') return { error: `  Failed to find logical volume "${arg.replace(/^\/dev\//, '')}"` };
  const vg = vgByName(s, m[1]);
  if (!vg) return { error: VG_NOT_FOUND(m[1]) };
  const lv = vg.lvs.find((l) => l.name === m[2]);
  return lv ? { vg, lv } : { error: `  Failed to find logical volume "${m[1]}/${m[2]}"` };
}

interface PvInit {
  ok: boolean;
  out: string;
  err: string;
}

/** pvcreate one device (also used by vgcreate and vgextend for devices that are not PVs yet). */
function pvInit(ctx: CommandContext, path: string, force: number, yes: boolean, implicit: boolean): PvInit {
  const s = st(ctx.sh);
  const d = findDevice(s, path);
  const no = (err: string): PvInit => ({ ok: false, out: '', err: err + '\n' });
  if (!d) return no(`  Cannot use ${path}: device not found`);
  if (d.type === 'lvm') return no(`  Cannot use ${d.path}: device is an LV`);
  if (d.type === 'disk' && d.disk?.table) return no(`  Cannot use ${d.path}: device is partitioned`);
  if (d.part?.kind === 'extended' || d.size < 2 * MiB) return no(`  Cannot use ${d.path}: device is too small (pv_min_size)`);
  if (mountsOf(s, d.path).length || isSwapOn(s, d.path)) return no(`  Can't open ${d.path} exclusively.  Mounted filesystem?`);
  const pv = s.pvs.find((p) => p.device === d.path);
  if (pv?.vg && force < 2) {
    return no(`  Can't initialize physical volume "${d.path}" of volume group "${pv.vg}" without -ff\n  ${d.path}: physical volume not initialized.`);
  }
  if (pv?.vg) return no(`  Can't open ${d.path} exclusively.  Mounted filesystem?`);
  if (pv && implicit) return { ok: true, out: '', err: '' };
  let out = '';
  const fs = d.holder.fs;
  if (fs) {
    const off = SIGS[fs.type].off;
    if (!yes && !force && !yesAnswer(ctx.stdin)) {
      return no(`WARNING: ${fs.type} signature detected on ${d.path} at offset ${off}. Wipe it? [y/n]: n\n  Aborted wiping of ${fs.type}.\n  1 existing signature left on the device.\n  Aborting pvcreate on ${d.path}.\n${NO_PROMPT('Add -y to wipe it.')}`);
    }
    out += `  Wiping ${fs.type} signature on ${d.path}.\n`;
    d.holder.fs = undefined;
  }
  if (pv) pv.uuid = newLvmUuid(s);
  else s.pvs.push({ device: d.path, uuid: newLvmUuid(s), vg: '' });
  out += `  Physical volume "${d.path}" successfully created.\n`;
  return { ok: true, out, err: '' };
}

const pvcreate: Command = (ctx) => {
  if (ctx.sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, operands } = getopts(ctx.args);
  if (!operands.length) return lvmFail(`  Please enter a physical volume path.\n  Run \`pvcreate --help' for more information.`, 3);
  const force = ctx.args.filter((a) => a === '-ff').length ? 2 : flags.has('f') || flags.has('force') ? 1 : 0;
  let out = '';
  let err = '';
  for (const p of operands) {
    const r = pvInit(ctx, p, force, flags.has('y') || flags.has('yes'), false);
    out += r.out;
    err += r.err;
  }
  syncDev(ctx.sh.state);
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

const pvremove: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { operands } = getopts(args);
  const s = st(sh);
  if (!operands.length) return lvmFail(`  Please enter a physical volume path`, 3);
  let out = '';
  let err = '';
  for (const p of operands) {
    const d = findDevice(s, p);
    const pv = d && s.pvs.find((x) => x.device === d.path);
    if (!d || !pv) {
      err += `  No PV found on device ${p}.\n`;
      continue;
    }
    if (pv.vg) {
      err += `  PV ${d.path} is used by VG ${pv.vg} so please use vgreduce first.\n  (If you are certain you need pvremove, then confirm by using --force twice.)\n`;
      continue;
    }
    s.pvs = s.pvs.filter((x) => x !== pv);
    out += `  Labels on physical volume "${d.path}" successfully wiped.\n`;
  }
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

function pvRows(s: StorageState, filter: PhysicalVolume[]) {
  return [...filter].sort((a, b) => a.device.localeCompare(b.device)).map((pv) => {
    const vg = pv.vg ? vgByName(s, pv.vg) : undefined;
    const size = vg ? pvExtentCount(s, pv, vg.extentSize) * vg.extentSize : findDevice(s, pv.device)?.size ?? 0;
    const free = vg ? size - pvUsedExtents(vg, pv.device) * vg.extentSize : size;
    return [pv.device, pv.vg, 'lvm2', vg ? 'a--' : '---', lvmSize(size), lvmSize(free)];
  });
}

function pvTargets(s: StorageState, operands: string[]): { pvs: PhysicalVolume[]; err: string } {
  if (!operands.length) return { pvs: s.pvs, err: '' };
  const pvs: PhysicalVolume[] = [];
  let err = '';
  for (const a of operands) {
    const d = findDevice(s, a);
    const pv = d && s.pvs.find((p) => p.device === d.path);
    if (pv) pvs.push(pv);
    else err += `  Failed to find physical volume "${a}".\n`;
  }
  return { pvs, err };
}

const pvs: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const { pvs: list, err } = pvTargets(s, getopts(args).operands);
  const rows = pvRows(s, list);
  const out = rows.length ? columns([['PV', 'VG', 'Fmt', 'Attr', 'PSize', 'PFree'], ...rows], [false, false, false, false, true, true], '  ', false) : '';
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

const pvdisplay: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const { pvs: list, err } = pvTargets(s, getopts(args).operands);
  let out = '';
  const sorted = [...list].sort((a, b) => (a.vg === '' ? 1 : 0) - (b.vg === '' ? 1 : 0) || a.vg.localeCompare(b.vg) || a.device.localeCompare(b.device));
  for (const pv of sorted) {
    const vg = pv.vg ? vgByName(s, pv.vg) : undefined;
    const devSize = findDevice(s, pv.device)?.size ?? 0;
    if (!vg) {
      out += `  "${pv.device}" is a new physical volume of "${lvmSize(devSize, true)}"\n  --- NEW Physical volume ---\n  PV Name               ${pv.device}\n  VG Name               \n  PV Size               ${lvmSize(devSize, true)}\n  Allocatable           NO\n  PE Size               0   \n  Total PE              0\n  Free PE               0\n  Allocated PE          0\n  PV UUID               ${pv.uuid}\n   \n`;
      continue;
    }
    const total = pvExtentCount(s, pv, vg.extentSize);
    const used = pvUsedExtents(vg, pv.device);
    out += `  --- Physical volume ---\n  PV Name               ${pv.device}\n  VG Name               ${vg.name}\n  PV Size               ${lvmSize(devSize, true)} / not usable ${lvmSize(devSize - total * vg.extentSize, true)}\n  Allocatable           yes ${used === total ? '(but full)' : ''}\n  PE Size               ${lvmSize(vg.extentSize, true)}\n  Total PE              ${total}\n  Free PE               ${total - used}\n  Allocated PE          ${used}\n  PV UUID               ${pv.uuid}\n   \n`;
  }
  return { stdout: out.replace(/yes \n/g, 'yes\n'), stderr: err, code: err ? 5 : 0 };
};

const pvscan: Command = ({ sh }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const rows = pvRows(s, s.pvs);
  const w = Math.max(...rows.map((r) => r[0].length), 0);
  const vw = Math.max(...rows.map((r) => r[1].length), 0);
  let total = 0;
  let inUse = 0;
  let out = '';
  for (const pv of [...s.pvs].sort((a, b) => a.device.localeCompare(b.device))) {
    const vg = pv.vg ? vgByName(s, pv.vg) : undefined;
    const size = vg ? pvExtentCount(s, pv, vg.extentSize) * vg.extentSize : findDevice(s, pv.device)?.size ?? 0;
    total += size;
    if (vg) {
      inUse += size;
      const free = size - pvUsedExtents(vg, pv.device) * vg.extentSize;
      out += `  PV ${pv.device.padEnd(w)}   VG ${vg.name.padEnd(vw)}   lvm2 [${lvmSize(size, true)} / ${lvmSize(free, true)} free]\n`;
    } else out += `  PV ${pv.device.padEnd(w)}   ${''.padEnd(vw + 3)}   lvm2 [${lvmSize(size, true)}]\n`;
  }
  const orphan = s.pvs.filter((p) => !p.vg).length;
  out += `  Total: ${s.pvs.length} [${lvmSize(total, true)}] / in use: ${s.pvs.length - orphan} [${lvmSize(inUse, true)}] / in no VG: ${orphan} [${lvmSize(total - inUse, true)}]\n`;
  return ok(out);
};

const vgcreate: Command = (ctx) => {
  const { sh, args } = ctx;
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, values, operands } = getopts(args, ['s', 'physicalextentsize']);
  const s = st(sh);
  const [name, ...devs] = operands;
  if (!name || !devs.length) return lvmFail(NO_SYNTAX('vgcreate'), 3);
  const bad = validName(name);
  if (bad) return lvmFail(bad, 3);
  if (vgByName(s, name)) return lvmFail(`  A volume group called ${name} already exists.`);
  const pe = parseLvmSize(values.s ?? values.physicalextentsize ?? '4m');
  if (!pe || pe.sign || pe.bytes < KiB || (pe.bytes & (pe.bytes - 1)) !== 0) return lvmFail(`  Invalid physical extent size ${values.s}. It must be a power of 2.`, 3);
  let out = '';
  for (const p of devs) {
    const d = findDevice(s, p);
    const pv = d && s.pvs.find((x) => x.device === d.path);
    if (pv?.vg) return lvmFail(`  Physical volume '${d!.path}' is already in volume group '${pv.vg}'\n  Unable to add physical volume '${d!.path}' to volume group '${name}'\n  ${d!.path}: physical volume not initialized.`, 5, out);
    const r = pvInit(ctx, p, flags.has('f') ? 1 : 0, flags.has('y') || flags.has('yes'), true);
    out += r.out;
    if (!r.ok) return { stdout: out, stderr: r.err, code: 5 };
  }
  const paths = devs.map((p) => findDevice(s, p)!.path);
  const tooSmall = paths.find((p) => pvExtentCount(s, s.pvs.find((x) => x.device === p)!, pe.bytes) < 1);
  if (tooSmall) return lvmFail(`  Physical volume ${tooSmall} is too small for physical extent size ${lvmSize(pe.bytes, true)}.`, 5, out);
  for (const p of paths) s.pvs.find((x) => x.device === p)!.vg = name;
  s.vgs.push({ name, uuid: newLvmUuid(s), extentSize: pe.bytes, seqno: 1, lvs: [] });
  syncDev(sh.state);
  return ok(out + `  Volume group "${name}" successfully created\n`);
};

const vgextend: Command = (ctx) => {
  const { sh, args } = ctx;
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, operands } = getopts(args);
  const s = st(sh);
  const [name, ...devs] = operands;
  if (!name || !devs.length) return lvmFail(NO_SYNTAX('vgextend'), 3);
  const vg = vgByName(s, name);
  if (!vg) return lvmFail(VG_NOT_FOUND(name));
  let out = '';
  for (const p of devs) {
    const d = findDevice(s, p);
    const pv = d && s.pvs.find((x) => x.device === d.path);
    if (pv?.vg) return lvmFail(`  Physical volume '${d!.path}' is already in volume group '${pv.vg}'\n  Unable to add physical volume '${d!.path}' to volume group '${name}'`, 5, out);
    const r = pvInit(ctx, p, flags.has('f') ? 1 : 0, flags.has('y') || flags.has('yes'), true);
    out += r.out;
    if (!r.ok) return { stdout: out, stderr: r.err, code: 5 };
    s.pvs.find((x) => x.device === findDevice(s, p)!.path)!.vg = name;
  }
  vg.seqno++;
  return ok(out + `  Volume group "${name}" successfully extended\n`);
};

const vgreduce: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, operands } = getopts(args);
  const s = st(sh);
  const [name, ...devs] = operands;
  if (!name) return lvmFail(NO_SYNTAX('vgreduce'), 3);
  const vg = vgByName(s, name);
  if (!vg) return lvmFail(VG_NOT_FOUND(name));
  const members = pvsOf(s, vg);
  const targets = flags.has('a') || flags.has('all') ? members.filter((p) => !pvUsedExtents(vg, p.device)).map((p) => p.device) : devs;
  if (!targets.length) return lvmFail(NO_SYNTAX('vgreduce'), 3);
  let out = '';
  let err = '';
  for (const p of targets) {
    const d = findDevice(s, p);
    const pv = d && members.find((x) => x.device === d.path);
    if (!pv) {
      err += `  Physical Volume "${p}" not found in Volume Group "${name}".\n`;
      continue;
    }
    if (pvUsedExtents(vg, pv.device)) {
      err += `  Physical volume "${pv.device}" still in use\n`;
      continue;
    }
    if (pvsOf(s, vg).length === 1) {
      err += `  Can't remove final physical volume "${pv.device}" from volume group "${name}"\n`;
      continue;
    }
    pv.vg = '';
    vg.seqno++;
    out += `  Removed "${pv.device}" from volume group "${name}"\n`;
  }
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

function removeLv(s: StorageState, vg: VolumeGroup, lv: LogicalVolume) {
  vg.lvs = vg.lvs.filter((l) => l !== lv);
  vg.seqno++;
  void s;
}

const vgremove: Command = ({ sh, args, stdin }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, operands } = getopts(args);
  const s = st(sh);
  if (!operands.length) return lvmFail(NO_SYNTAX('vgremove'), 3);
  const yes = flags.has('f') || flags.has('force') || flags.has('y') || flags.has('yes') || yesAnswer(stdin);
  let out = '';
  for (const name of operands) {
    const vg = vgByName(s, name);
    if (!vg) return lvmFail(VG_NOT_FOUND(name), 5, out);
    const open = vg.lvs.find((lv) => lvOpen(s, vg, lv));
    if (open) {
      const swap = isSwapOn(s, lvPathOf(vg, open));
      return lvmFail(swap ? `  Logical volume ${name}/${open.name} in use.` : `  Logical volume ${name}/${open.name} contains a filesystem in use.`, 5, out);
    }
    if (vg.lvs.length && !yes) {
      return lvmFail(`Do you really want to remove volume group "${name}" containing ${vg.lvs.length} logical volumes? [y/n]: n\n  Volume group "${name}" not removed\n${NO_PROMPT(`Add -f: vgremove -f ${name}`)}`, 5, out);
    }
    for (const lv of [...vg.lvs]) {
      removeLv(s, vg, lv);
      out += `  Logical volume "${lv.name}" successfully removed.\n`;
    }
    for (const pv of pvsOf(s, vg)) pv.vg = '';
    s.vgs = s.vgs.filter((v) => v !== vg);
    out += `  Volume group "${name}" successfully removed\n`;
  }
  syncDev(sh.state);
  return ok(out);
};

function vgTargets(s: StorageState, operands: string[]): { vgs: VolumeGroup[]; err: string } {
  if (!operands.length) return { vgs: [...s.vgs].sort((a, b) => a.name.localeCompare(b.name)), err: '' };
  const vgs: VolumeGroup[] = [];
  let err = '';
  for (const n of operands) {
    const v = vgByName(s, n);
    if (v) vgs.push(v);
    else err += VG_NOT_FOUND(n) + '\n';
  }
  return { vgs, err };
}

const vgs: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const { vgs: list, err } = vgTargets(s, getopts(args).operands);
  const rows = list.map((vg) => [vg.name, String(pvsOf(s, vg).length), String(vg.lvs.length), '0', 'wz--n-', lvmSize(vgTotalExtents(s, vg) * vg.extentSize), lvmSize(vgFreeExtents(s, vg) * vg.extentSize)]);
  const out = rows.length ? columns([['VG', '#PV', '#LV', '#SN', 'Attr', 'VSize', 'VFree'], ...rows], [false, true, true, true, false, true, true], '  ', false) : '';
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

const vgdisplay: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const { vgs: list, err } = vgTargets(s, getopts(args).operands);
  let out = '';
  for (const vg of list) {
    const total = vgTotalExtents(s, vg);
    const free = vgFreeExtents(s, vg);
    const n = pvsOf(s, vg).length;
    const sz = (e: number) => lvmSize(e * vg.extentSize, true);
    out +=
      `  --- Volume group ---\n  VG Name               ${vg.name}\n  System ID             \n  Format                lvm2\n  Metadata Areas        ${n}\n  Metadata Sequence No  ${vg.seqno}\n` +
      `  VG Access             read/write\n  VG Status             resizable\n  MAX LV                0\n  Cur LV                ${vg.lvs.length}\n  Open LV               ${vg.lvs.filter((lv) => lvOpen(s, vg, lv)).length}\n` +
      `  Max PV                0\n  Cur PV                ${n}\n  Act PV                ${n}\n  VG Size               ${sz(total)}\n  PE Size               ${lvmSize(vg.extentSize, true)}\n` +
      `  Total PE              ${total}\n  Alloc PE / Size       ${total - free} / ${sz(total - free)}\n  Free  PE / Size       ${free} / ${sz(free)}\n  VG UUID               ${vg.uuid}\n   \n`;
  }
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

const vgscan: Command = ({ sh }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  return ok(st(sh).vgs.map((v) => `  Found volume group "${v.name}" using metadata type lvm2\n`).join(''));
};

const lvcreate: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, values, operands } = getopts(args, ['n', 'L', 'l', 'name', 'size', 'extents', 'W', 'Z', 'wipesignatures', 'zero', 'i', 'I', 'm', 'type', 'activate', 'a']);
  const s = st(sh);
  if (flags.has('s') || flags.has('snapshot') || values.type === 'thin-pool' || flags.has('T')) {
    return fail('  Snapshots and thin pools are not simulated on this practice server.', 5);
  }
  const [target, ...pvArgs] = operands;
  const sizeArg = values.L ?? values.size;
  const extArg = values.l ?? values.extents;
  if (!target || (!sizeArg && !extArg)) return lvmFail(NO_SYNTAX('lvcreate'), 3);
  if (sizeArg && extArg) return lvmFail('  Please specify either size or extents but not both.', 3);
  let vgName = target;
  let name = values.n ?? values.name;
  const slash = /^(?:\/dev\/)?([^/]+)\/([^/]+)$/.exec(target);
  if (slash) [vgName, name] = [slash[1], name ?? slash[2]];
  const vg = vgByName(s, vgName);
  if (!vg) return lvmFail(VG_NOT_FOUND(vgName));
  if (!name) name = `lvol${lowestFree(vg.lvs.map((l) => /^lvol(\d+)$/.exec(l.name)?.[1]).filter((x): x is string => !!x).map(Number), 0)}`;
  const bad = validName(name);
  if (bad) return lvmFail(bad, 3);
  if (vg.lvs.some((l) => l.name === name)) return lvmFail(`  Logical Volume "${name}" already exists in volume group "${vg.name}"`);
  const only = pvArgs.map((p) => findDevice(s, p)?.path ?? p);
  const missing = only.find((p) => !pvsOf(s, vg).some((x) => x.device === p));
  if (missing) return lvmFail(`  Physical Volume "${missing}" not found in Volume Group "${vg.name}".`);
  const free = vgFreeExtents(s, vg);
  let extents: number;
  let out = '';
  if (sizeArg) {
    const sz = parseLvmSize(sizeArg);
    if (!sz || sz.sign || sz.bytes <= 0) return lvmFail(`  Invalid argument for --size: ${sizeArg}\n  Error during parsing of command line.`, 3);
    extents = Math.ceil(sz.bytes / vg.extentSize);
    if (extents * vg.extentSize !== sz.bytes) out += `  Rounding up size to full physical extent ${lvmSize(extents * vg.extentSize, true)}\n`;
  } else {
    const e = parseExtents(extArg!);
    if (!e || e.sign) return lvmFail(`  Invalid argument for --extents: ${extArg}\n  Error during parsing of command line.`, 3);
    const base = e.pct === 'FREE' ? free : e.pct === 'VG' ? vgTotalExtents(s, vg) : e.pct === 'PVS' ? pvsOf(s, vg).filter((p) => !only.length || only.includes(p.device)).reduce((a, p) => a + pvExtentCount(s, p, vg.extentSize), 0) : 0;
    if (e.pct === 'ORIGIN') return lvmFail('  Please specify a snapshot origin with %ORIGIN.', 3);
    extents = e.pct ? Math.floor((base * Math.min(e.n, 100)) / 100) : e.n;
  }
  if (extents < 1) return lvmFail(`  Cannot create logical volume ${name} with no extents.`);
  const lv: LogicalVolume = { name, uuid: newLvmUuid(s), minor: lvMinor(s), segments: [], created: `${sh.state.hostname}, ${lvmTime()}` };
  if (!allocate(s, vg, lv, extents, only)) {
    const avail = only.length ? only.reduce((a, p) => a + pvExtentCount(s, s.pvs.find((x) => x.device === p)!, vg.extentSize) - pvUsedExtents(vg, p), 0) : free;
    return lvmFail(`  Volume group "${vg.name}" has insufficient free space (${avail} extents): ${extents} required.`, 5, out);
  }
  vg.lvs.push(lv);
  vg.seqno++;
  syncDev(sh.state);
  return ok(out + `  Logical volume "${name}" created.\n`);
};

function lvmTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** lvextend, lvresize and lvreduce. */
const lvresizeCmd = (mode: 'extend' | 'resize' | 'reduce'): Command => ({ sh, args, stdin }) => {
  const cmd = `lv${mode}`;
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, values, operands } = getopts(args, ['L', 'l', 'size', 'extents', 'fs', 'fsmode']);
  const s = st(sh);
  const [target, ...pvArgs] = operands;
  const sizeArg = values.L ?? values.size;
  const extArg = values.l ?? values.extents;
  if (!target || (!sizeArg && !extArg)) return lvmFail(NO_SYNTAX(cmd), 3);
  if (sizeArg && extArg) return lvmFail('  Please specify either size or extents but not both.', 3);
  const found = resolveLv(s, target);
  if ('error' in found) return lvmFail(found.error);
  const { vg, lv } = found;
  const full = `${vg.name}/${lv.name}`;
  const cur = lvExtents(lv);
  const free = vgFreeExtents(s, vg);
  let wanted: number;
  let out = '';
  if (sizeArg) {
    const sz = parseLvmSize(sizeArg);
    if (!sz) return lvmFail(`  Invalid argument for --size: ${sizeArg}\n  Error during parsing of command line.`, 3);
    let ext = sz.bytes / vg.extentSize;
    if (!Number.isInteger(ext)) {
      ext = sz.sign === '-' ? Math.floor(ext) : Math.ceil(ext);
      out += `  Rounding size to boundary between physical extents: ${lvmSize(ext * vg.extentSize, true)}.\n`;
    }
    wanted = sz.sign === '+' ? cur + ext : sz.sign === '-' ? cur - ext : ext;
  } else {
    const e = parseExtents(extArg!);
    if (!e) return lvmFail(`  Invalid argument for --extents: ${extArg}\n  Error during parsing of command line.`, 3);
    const base = e.pct === 'FREE' ? free : e.pct === 'VG' ? vgTotalExtents(s, vg) : e.pct === 'PVS' ? vgTotalExtents(s, vg) : e.pct === 'ORIGIN' ? cur : 1;
    const n = e.pct ? Math.floor((base * e.n) / 100) : e.n;
    // %FREE without a sign still means "add the free space" when extending
    const sign = !e.sign && e.pct === 'FREE' && mode !== 'reduce' ? '+' : e.sign;
    wanted = sign === '+' ? cur + n : sign === '-' ? cur - n : n;
  }
  const sizeOf = (n: number) => `${lvmSize(n * vg.extentSize, true)} (${n} extents)`;
  if (wanted === cur) return lvmFail(out + `  New size (${cur} extents) matches existing size (${cur} extents).`);
  if (mode === 'extend' && wanted < cur) return lvmFail(out + `  New size given (${wanted} extents) not larger than existing size (${cur} extents)`);
  if (mode === 'reduce' && wanted > cur) return lvmFail(out + `  New size given (${wanted} extents) not less than existing size (${cur} extents)`);
  if (wanted < 1) return lvmFail(out + `  New size (${wanted} extents) is too small.`);
  const resizeFs = flags.has('r') || flags.has('resizefs') || values.fs === 'resize';
  const path = lvPathOf(vg, lv);
  const fs = lv.fs;
  const mounted = mountsOf(s, path)[0]?.target;
  const fsLine = fs && fs.type !== 'swap' ? `  File system ${fs.type} found on ${full}${mounted ? ` mounted at ${mounted}` : ''}.\n` : '';
  const newBytes = wanted * vg.extentSize;

  if (wanted < cur) {
    if (fs && fs.type !== 'swap' && fs.size > newBytes) {
      const why = `${fsLine}  File system size (${lvmSize(fs.size, true)}) is larger than the requested size (${lvmSize(newBytes, true)}).\n`;
      if (!resizeFs) return lvmFail(out + why + '  File system reduce is required (see resize2fs or --resizefs.)');
      if (fs.type !== 'ext4') return lvmFail(out + why + `  File system reduce is required and not supported (${fs.type}).`);
      const r = resizeExt4(`/dev/${vg.name}/${lv.name}`, fs, newBytes, newBytes, undefined);
      if (r.error) return lvmFail(out + why + r.out + `  Failed to reduce file system with resize2fs.`);
      out += why + '  File system reduce is required using resize2fs.\n' + (mounted ? '  File system unmount is needed for reduce.\n' : '') +
        `  File system fsck will be run before reduce.\n  Reducing file system ext4 to ${lvmSize(newBytes, true)} (${newBytes} bytes) on ${full}...\n` +
        r.out + `  Reduced file system ext4 on ${full}.\n`;
    } else if (!(flags.has('y') || flags.has('yes') || flags.has('f') || flags.has('force') || yesAnswer(stdin))) {
      return lvmFail(out + `  WARNING: Reducing active${lvOpen(s, vg, lv) ? ' and open' : ''} logical volume to ${lvmSize(newBytes, true)}.\n  THIS MAY DESTROY YOUR DATA (filesystem etc.)\nDo you really want to reduce ${full}? [y/n]: n\n  Logical volume ${full} NOT reduced.\n${NO_PROMPT('Add -y to the command.')}`);
    }
    release(lv, cur - wanted);
    if (fs?.type === 'swap') fs.size = Math.min(fs.size, newBytes);
  } else {
    const only = pvArgs.map((p) => findDevice(s, p)?.path ?? p);
    if (!allocate(s, vg, lv, wanted - cur, only)) return lvmFail(out + `  Insufficient free space: ${wanted - cur} extents needed, but only ${free} available`);
  }
  vg.seqno++;
  out += (wanted > cur && resizeFs ? fsLine : '') + `  Size of logical volume ${full} changed from ${sizeOf(cur)} to ${sizeOf(wanted)}.\n`;
  if (wanted > cur && resizeFs && fs && fs.type !== 'swap') {
    out += `  Extending file system ${fs.type} to ${lvmSize(newBytes, true)} (${newBytes} bytes) on ${full}...\n`;
    if (fs.type === 'xfs') out += `xfs_growfs /dev/${vg.name}/${lv.name}\n` + growXfs(path, fs, newBytes);
    else if (fs.type === 'ext4') out += `resize2fs /dev/${vg.name}/${lv.name}\n` + resizeExt4(`/dev/${vg.name}/${lv.name}`, fs, newBytes, Math.floor(newBytes / 4096) * 4096, mounted).out;
    out += `  Extended file system ${fs.type} on ${full}.\n`;
  }
  syncDev(sh.state);
  return ok(out + `  Logical volume ${full} successfully resized.\n`);
};

const lvremove: Command = ({ sh, args, stdin }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { flags, operands } = getopts(args);
  const s = st(sh);
  if (!operands.length) return lvmFail(NO_SYNTAX('lvremove'), 3);
  const yes = flags.has('f') || flags.has('force') || flags.has('y') || flags.has('yes') || yesAnswer(stdin);
  let out = '';
  let err = '';
  for (const a of operands) {
    let targets: { vg: VolumeGroup; lv: LogicalVolume }[];
    const asVg = !a.includes('/') ? vgByName(s, a) : undefined;
    if (asVg) targets = asVg.lvs.map((lv) => ({ vg: asVg, lv }));
    else if (!a.includes('/')) {
      err += VG_NOT_FOUND(a) + '\n';
      continue;
    } else {
      const r = resolveLv(s, a);
      if ('error' in r) {
        err += r.error + '\n';
        continue;
      }
      targets = [r];
    }
    for (const { vg, lv } of targets) {
      const full = `${vg.name}/${lv.name}`;
      if (lvOpen(s, vg, lv)) {
        err += isSwapOn(s, lvPathOf(vg, lv)) ? `  Logical volume ${full} in use.\n` : `  Logical volume ${full} contains a filesystem in use.\n`;
        continue;
      }
      if (!yes) {
        err += `Do you really want to remove active logical volume ${full}? [y/n]: n\n  Logical volume ${full} not removed.\n${NO_PROMPT(`Add -y: lvremove -y ${a}`)}\n`;
        continue;
      }
      removeLv(s, vg, lv);
      out += `  Logical volume "${lv.name}" successfully removed.\n`;
    }
  }
  syncDev(sh.state);
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

function lvTargets(s: StorageState, operands: string[]): { list: { vg: VolumeGroup; lv: LogicalVolume }[]; err: string } {
  const all = s.vgs.flatMap((vg) => vg.lvs.map((lv) => ({ vg, lv })));
  const sorted = (l: typeof all) => [...l].sort((a, b) => a.vg.name.localeCompare(b.vg.name) || a.lv.name.localeCompare(b.lv.name));
  if (!operands.length) return { list: sorted(all), err: '' };
  const list: typeof all = [];
  let err = '';
  for (const a of operands) {
    if (!a.includes('/')) {
      const vg = vgByName(s, a);
      if (vg) list.push(...vg.lvs.map((lv) => ({ vg, lv })));
      else err += VG_NOT_FOUND(a) + '\n';
      continue;
    }
    const r = resolveLv(s, a);
    if ('error' in r) err += r.error + '\n';
    else list.push(r);
  }
  return { list: sorted(list), err };
}

const lvs: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const { list, err } = lvTargets(s, getopts(args, ['o', 'O']).operands);
  const rows = list.map(({ vg, lv }) => [lv.name, vg.name, `-wi-a${lvOpen(s, vg, lv) ? 'o' : '-'}----`, lvmSize(lvExtents(lv) * vg.extentSize), '', '', '', '', '', '', '', '']);
  // Data% and Meta% are six characters wide, like lvm's percent fields
  const head = ['LV', 'VG', 'Attr', 'LSize', 'Pool', 'Origin', 'Data% ', 'Meta% ', 'Move', 'Log', 'Cpy%Sync', 'Convert'];
  const right = head.map((h) => ['LSize', 'Data% ', 'Meta% ', 'Cpy%Sync'].includes(h));
  const out = rows.length ? columns([head, ...rows], right, '  ', false) : '';
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

const lvdisplay: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  const { list, err } = lvTargets(s, getopts(args).operands);
  let out = '';
  for (const { vg, lv } of list) {
    const n = lvExtents(lv);
    out +=
      `  --- Logical volume ---\n  LV Path                /dev/${vg.name}/${lv.name}\n  LV Name                ${lv.name}\n  VG Name                ${vg.name}\n  LV UUID                ${lv.uuid}\n` +
      `  LV Write Access        read/write\n  LV Creation host, time ${lv.created}\n  LV Status              available\n  # open                 ${lvOpen(s, vg, lv) ? 1 : 0}\n` +
      `  LV Size                ${lvmSize(n * vg.extentSize, true)}\n  Current LE             ${n}\n  Segments               ${lv.segments.length}\n  Allocation             inherit\n` +
      `  Read ahead sectors     auto\n  - currently set to     256\n  Block device           253:${lv.minor}\n   \n`;
  }
  return { stdout: out, stderr: err, code: err ? 5 : 0 };
};

const lvscan: Command = ({ sh }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const s = st(sh);
  return ok(lvTargets(s, []).list.map(({ vg, lv }) => `  ACTIVE            '/dev/${vg.name}/${lv.name}' [${lvmSize(lvExtents(lv) * vg.extentSize, true)}] inherit\n`).join(''));
};

const pvmove: Command = ({ sh, args }) => {
  if (sh.uid !== 0) return lvmFail(LVM_DENIED);
  const { operands } = getopts(args);
  const s = st(sh);
  const [from, ...to] = operands;
  if (!from) return lvmFail(NO_SYNTAX('pvmove'), 3);
  const d = findDevice(s, from);
  const pv = d && s.pvs.find((p) => p.device === d.path);
  if (!pv || !pv.vg) return lvmFail(`  Physical volume ${from} not found or not in a volume group`);
  const vg = vgByName(s, pv.vg)!;
  const used = pvUsedExtents(vg, pv.device);
  if (!used) return lvmFail(`  No data to move for ${vg.name}.`);
  const dest = (to.length ? to.map((t) => findDevice(s, t)?.path ?? t) : pvsOf(s, vg).map((p) => p.device)).filter((p) => p !== pv.device);
  const room = dest.reduce((a, p) => {
    const x = s.pvs.find((y) => y.device === p && y.vg === vg.name);
    return a + (x ? pvExtentCount(s, x, vg.extentSize) - pvUsedExtents(vg, p) : 0);
  }, 0);
  if (room < used) return lvmFail(`  Insufficient free space: ${used} extents needed, but only ${room} available\n  Unable to allocate mirror extents for ${vg.name}/pvmove0.\n  Failed to convert pvmove LV to mirrored.`);
  for (const lv of vg.lvs) {
    const n = lv.segments.filter((x) => x.pv === pv.device).reduce((a, x) => a + x.extents, 0);
    if (!n) continue;
    lv.segments = lv.segments.filter((x) => x.pv !== pv.device);
    allocate(s, vg, lv, n, dest);
  }
  vg.seqno++;
  return ok(`  ${pv.device}: Moved: 100.00%\n`);
};

// ---------- boot ----------

/**
 * The storage part of a reboot: drop mounts and swap that are not in /etc/fstab, then mount
 * everything listed there. Returns the errors a real boot would hit (empty when it is clean),
 * one line each, worded like mount -a and swapon -a, e.g. "mount: /data: can't find UUID=1234.".
 * Entries with nofail never count as errors.
 */
export function bootStorage(sh: Shell): string[] {
  const state = sh.state;
  const s = state.storage;
  for (const m of [...s.mounts].reverse()) if (m.target !== '/') doUnmount(state, m);
  s.swaps = [];
  s.nextSwapPriority = -2;
  const text = readFstab(state);
  s.fstabLoaded = text;
  const { entries } = parseFstab(text);
  const depth = (p: string) => p.split('/').filter(Boolean).length;
  const errors: string[] = [];
  const mounts = entries.filter((e) => e.type !== 'swap').sort((a, b) => depth(a.file) - depth(b.file));
  for (const e of mounts) {
    if (e.options.includes('noauto') || e.file === '/' || NETWORK_FS.includes(e.type)) continue;
    const r = doMount(state, e.spec, e.file, e.type, e.options);
    if (r && !e.options.includes('nofail') && !/already mounted/.test(r.error)) errors.push(`mount: ${r.error}`);
  }
  for (const e of entries.filter((x) => x.type === 'swap')) {
    if (e.options.includes('noauto')) continue;
    const d = findDevice(s, e.spec);
    if (d && isSwapOn(s, d.path)) continue;
    const r = swapOn(state, e.spec, prioOf(e.options));
    if (r && !e.options.includes('nofail')) errors.push(r);
  }
  syncDev(state);
  return errors;
}

// ---------- tables ----------

export const STORAGE_COMMANDS: Record<string, Command> = {
  lsblk, blkid, df, du, free, findmnt, fdisk, parted, partprobe, wipefs,
  mkfs, 'mkfs.xfs': mkfsXfs, 'mkfs.ext4': mkfsExt4, 'mkfs.vfat': mkfsVfat, 'mkfs.fat': mkfsVfat, 'mkfs.msdos': mkfsVfat, 'mke2fs': mkfsExt4,
  mkswap, swapon, swapoff, mount, umount,
  xfs_growfs: xfsGrowfs, xfs_info: xfsInfo, xfs_admin: xfsAdmin, e2label, tune2fs, resize2fs,
  pvcreate, pvremove, pvs, pvdisplay, pvscan, pvmove,
  vgcreate, vgextend, vgreduce, vgremove, vgs, vgdisplay, vgscan,
  lvcreate, lvextend: lvresizeCmd('extend'), lvresize: lvresizeCmd('resize'), lvreduce: lvresizeCmd('reduce'),
  lvremove, lvs, lvdisplay, lvscan,
};

export const STORAGE_MAN: Record<string, string> = {
  lsblk: 'list block devices as a tree. -f shows file systems, UUIDs and labels, -p full paths, -o NAME,SIZE,TYPE picks columns',
  blkid: 'show the UUID, LABEL and TYPE of each block device. blkid /dev/x for one; -s UUID -o value prints only the UUID',
  df: 'report file system disk space usage. -h human sizes, -T shows the type; df -h /data shows the file system holding /data',
  du: 'estimate file space usage. du -sh dir shows the total of a directory',
  free: 'display amount of free and used memory and swap. -h for human sizes',
  findmnt: 'find a file system. findmnt shows the mount tree, findmnt /data one mount, -s /etc/fstab, --verify checks /etc/fstab',
  fdisk: 'list or edit partition tables. fdisk -l lists them (interactive editing: use parted on this phone terminal)',
  parted: 'partition editor. parted -s /dev/x mklabel gpt mkpart data xfs 1MiB 1GiB; print, rm N, set N lvm on, unit MiB',
  partprobe: 'tell the kernel about partition table changes',
  wipefs: 'list or wipe file system and partition table signatures. wipefs -a /dev/x erases them',
  mkfs: 'build a file system. mkfs -t xfs|ext4|vfat device',
  'mkfs.xfs': 'create an XFS file system. -L label sets a label (max 12), -f overwrites an existing file system',
  'mkfs.ext4': 'create an ext4 file system. -L label sets a label (max 16), -F overwrites',
  'mkfs.vfat': 'create a FAT file system. -n LABEL sets the label (max 11)',
  mkswap: 'set up a swap area on a device. -L label sets a label. Then swapon to use it',
  swapon: 'enable swap. swapon /dev/x, swapon -a (all in /etc/fstab), swapon --show lists active swap',
  swapoff: 'disable swap. swapoff /dev/x, swapoff -a',
  mount: 'mount a file system. mount /dev/x /data, mount UUID=... /data, mount -a mounts all of /etc/fstab, mount alone lists mounts',
  umount: 'unmount a file system by mount point or device. "target is busy" means something (maybe your shell) is using it',
  xfs_growfs: 'grow a mounted XFS file system to fill its device: xfs_growfs /data',
  xfs_info: 'show the geometry of an XFS file system',
  xfs_admin: 'change XFS parameters. -L label sets the label, -l shows it, -u shows the UUID',
  e2label: 'show or change the label of an ext4 file system: e2label /dev/x newlabel',
  tune2fs: 'adjust ext4 parameters. -L label sets the label, -l lists the superblock',
  resize2fs: 'grow or shrink an ext4 file system: resize2fs /dev/vg/lv (grows to fill the device)',
  pvcreate: 'initialize a disk or partition as an LVM physical volume',
  pvremove: 'remove the LVM label from a physical volume that is not in a volume group',
  pvs: 'report physical volumes, their volume group, size and free space',
  pvdisplay: 'show details of physical volumes',
  pvscan: 'list all physical volumes',
  pvmove: 'move extents from one physical volume to others in the volume group',
  vgcreate: 'create a volume group: vgcreate vgdata /dev/x [/dev/y]. -s 8M sets the extent size (default 4 MiB)',
  vgextend: 'add physical volumes to a volume group: vgextend vgdata /dev/y',
  vgreduce: 'remove an unused physical volume from a volume group',
  vgremove: 'remove a volume group (-f also removes its logical volumes)',
  vgs: 'report volume groups with their size and free space',
  vgdisplay: 'show details of volume groups, including extent size and free extents',
  vgscan: 'list volume groups',
  lvcreate: 'create a logical volume: lvcreate -n data -L 500M vgdata, or -l 100%FREE, or -l 20 (extents)',
  lvextend: 'grow a logical volume: lvextend -r -L +1G /dev/vgdata/data (-r grows the file system too)',
  lvresize: 'grow or shrink a logical volume. -L/-l with or without +/-, -r resizes the file system too',
  lvreduce: 'shrink a logical volume (XFS cannot shrink; ext4 with -r)',
  lvremove: 'remove a logical volume (it must not be mounted). -y skips the question',
  lvs: 'report logical volumes and their sizes',
  lvdisplay: 'show details of logical volumes',
  lvscan: 'list logical volumes',
};

// Disks, partitions, file systems, mounts, swap and LVM for the simulated server.
//
// The model: disks hold an optional partition table and partitions; a file system (or swap)
// signature lives on a disk, a partition or a logical volume (`fs`). LVM physical volumes are
// listed in `pvs` by device path; volume groups own logical volumes, whose extents are taken
// from the group's PVs (`segments`). Mounted file systems are nodes placed in the normal
// in-memory tree; the directory they cover is kept in the Mount and put back on unmount.
import { FsNode, makeDir, makeFile, makeLink } from './fs';
import type { SystemState } from './state';

export const SECTOR = 512;
export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;
/** LVM puts the first extent 1 MiB into each physical volume. */
export const PE_START = MiB;
export const DISK_MODEL = 'VMware Virtual NVMe Disk';

export type FsType = 'xfs' | 'ext4' | 'vfat' | 'swap';

export interface FileSystem {
  type: FsType;
  uuid: string;
  label: string;
  size: number; // bytes the file system spans; xfs/ext4 keep it until grown (xfs_growfs, resize2fs, lvextend -r)
  used: number; // bytes in use
  root?: FsNode; // the file tree while the file system is not mounted
}

export interface Partition {
  number: number;
  start: number; // first sector
  end: number; // last sector (inclusive)
  name: string; // GPT partition name (PARTLABEL)
  kind: 'primary' | 'extended' | 'logical'; // GPT partitions are always 'primary'
  flags: string[]; // parted flags: boot, esp, lvm, swap, raid, ...
  partuuid: string;
  minor: number;
  fs?: FileSystem;
}

export interface Disk {
  name: string; // nvme0n1
  sectors: number;
  minor: number;
  table: 'gpt' | 'msdos' | null;
  ptuuid: string;
  partitions: Partition[];
  fs?: FileSystem; // a file system on the whole disk
}

export interface PhysicalVolume {
  device: string; // canonical device path, e.g. /dev/nvme0n2
  uuid: string;
  vg: string; // '' when the PV is not in a volume group
}

export interface LvSegment {
  pv: string; // device path of the PV the extents come from
  extents: number;
}

export interface LogicalVolume {
  name: string;
  uuid: string;
  minor: number; // device-mapper minor: /dev/dm-<minor>, 253:<minor>
  segments: LvSegment[];
  created: string; // "host, time" shown by lvdisplay
  fs?: FileSystem;
}

export interface VolumeGroup {
  name: string;
  uuid: string;
  extentSize: number; // bytes
  seqno: number; // metadata sequence number
  lvs: LogicalVolume[];
}

export interface Mount {
  source: string; // canonical device path, e.g. /dev/mapper/vgdata-data
  target: string; // canonical mount point
  type: string; // xfs, ext4, vfat
  options: string[]; // as given to mount or in fstab, e.g. ['defaults'] or ['ro', 'noexec']
  covered?: FsNode; // the directory that was at the mount point before mounting
}

export interface SwapArea {
  device: string; // canonical device path
  priority: number;
}

export interface StorageState {
  disks: Disk[];
  pvs: PhysicalVolume[];
  vgs: VolumeGroup[];
  mounts: Mount[]; // in mount order; '/' is always first
  swaps: SwapArea[]; // active swap
  nextSwapPriority: number; // the kernel hands out -2, -3, ... to swap without pri=
  fstabLoaded: string; // the /etc/fstab text systemd read at boot or at the last daemon-reload
  devDirs: string[]; // VG directories this module created under /dev
  seed: number; // for UUIDs; deterministic so practice runs repeat
}

/** One block device as lsblk sees it. `holder` is the object that carries the signature. */
export interface BlockDevice {
  path: string; // /dev/nvme0n1p2, /dev/mapper/rhel-root
  kname: string; // nvme0n1p2, dm-0
  name: string; // lsblk NAME: nvme0n1p2, rhel-root
  type: 'disk' | 'part' | 'lvm';
  size: number; // bytes
  major: number;
  minor: number;
  holder: Disk | Partition | LogicalVolume;
  disk?: Disk;
  part?: Partition;
  vg?: VolumeGroup;
  lv?: LogicalVolume;
}

// ---------- the initial system ----------

const ROOT_UUID = 'a3f7c2d1-5b8e-4f6a-9d2c-1e7b3a5f8c4d';
const BOOT_UUID = '4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c';
const EFI_UUID = '7B77-95E7';
const SWAP_UUID = 'b2e8d4f1-3c7a-4e9b-8f1d-6a2c5e7b9d3f';

export const INITIAL_FSTAB = `
#
# /etc/fstab
# Created by anaconda on Mon Oct 19 09:12:44 2026
#
# Accessible filesystems, by reference, are maintained under '/dev/disk/'.
# See man pages fstab(5), findfs(8), mount(8) and/or blkid(8) for more info.
#
# After editing this file, run 'systemctl daemon-reload' to update systemd
# units generated from this file.
#
/dev/mapper/rhel-root   /                       xfs     defaults        0 0
UUID=${BOOT_UUID} /boot                   xfs     defaults        0 0
UUID=${EFI_UUID}          /boot/efi               vfat    umask=0077,shortname=winnt 0 2
/dev/mapper/rhel-swap   none                    swap    defaults        0 0
`;

export function initialStorage(): StorageState {
  const pv3 = '/dev/nvme0n1p3';
  const created = 'server1.example.com, 2026-10-19 09:12:30 +0000';
  return {
    disks: [
      {
        name: 'nvme0n1',
        sectors: 41943040, // 20 GiB
        minor: 0,
        table: 'gpt',
        ptuuid: '3f8e1a2c-5d4b-4e6f-8a9c-0b1d2e3f4a5b',
        partitions: [
          {
            number: 1, start: 2048, end: 1230847, name: 'EFI System Partition', kind: 'primary', flags: ['boot', 'esp'],
            partuuid: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f', minor: 1,
            fs: { type: 'vfat', uuid: EFI_UUID, label: '', size: 600 * MiB, used: 7260 * KiB },
          },
          {
            number: 2, start: 1230848, end: 3327999, name: '', kind: 'primary', flags: [],
            partuuid: 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60', minor: 2,
            fs: { type: 'xfs', uuid: BOOT_UUID, label: '', size: GiB, used: 318976 * KiB },
          },
          {
            number: 3, start: 3328000, end: 41940991, name: '', kind: 'primary', flags: ['lvm'],
            partuuid: 'e3f4a5b6-c7d8-4e9f-8a1b-2c3d4e5f6071', minor: 3,
          },
        ],
      },
      { name: 'nvme0n2', sectors: 20971520, minor: 4, table: null, ptuuid: '', partitions: [] }, // 10 GiB
      { name: 'nvme0n3', sectors: 10485760, minor: 5, table: null, ptuuid: '', partitions: [] }, // 5 GiB
    ],
    pvs: [{ device: pv3, uuid: 'Xb3d2F-q8Rk-1aZc-4LmN-7pQs-2wEr-9TyU5v', vg: 'rhel' }],
    vgs: [
      {
        name: 'rhel',
        uuid: 'Kd7Lp2-9mQx-3Rt5-Vb8n-4Hj6-Wc2z-1Fg9Sy',
        extentSize: 4 * MiB,
        seqno: 3,
        lvs: [
          {
            name: 'root', uuid: 'Tq4Zr8-2Lm6-5Nb3-Xc7v-9Kp1-Hd4f-6Ws2Ja', minor: 0, created,
            segments: [{ pv: pv3, extents: 4201 }],
            fs: { type: 'xfs', uuid: ROOT_UUID, label: '', size: 4201 * 4 * MiB, used: 4247040 * KiB },
          },
          {
            name: 'swap', uuid: 'Pm3Yc6-8Rn1-4Gt7-Zb5x-2Lq9-Vf3d-7Kh1Ue', minor: 1, created,
            segments: [{ pv: pv3, extents: 512 }],
            fs: { type: 'swap', uuid: SWAP_UUID, label: '', size: 2 * GiB, used: 0 },
          },
        ],
      },
    ],
    mounts: [
      { source: '/dev/mapper/rhel-root', target: '/', type: 'xfs', options: ['defaults'] },
      { source: '/dev/nvme0n1p2', target: '/boot', type: 'xfs', options: ['defaults'] },
      { source: '/dev/nvme0n1p1', target: '/boot/efi', type: 'vfat', options: ['umask=0077', 'shortname=winnt'] },
    ],
    swaps: [{ device: '/dev/mapper/rhel-swap', priority: -2 }],
    nextSwapPriority: -3,
    fstabLoaded: INITIAL_FSTAB,
    devDirs: ['rhel'],
    seed: 20261021,
  };
}

// ---------- random ids ----------

function rand(st: StorageState): number {
  // mulberry32
  st.seed = (st.seed + 0x6d2b79f5) | 0;
  let t = st.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (st: StorageState, chars: string, n: number) =>
  Array.from({ length: n }, () => chars[Math.floor(rand(st) * chars.length)]).join('');
const HEX = '0123456789abcdef';

export function newUuid(st: StorageState): string {
  return `${pick(st, HEX, 8)}-${pick(st, HEX, 4)}-4${pick(st, HEX, 3)}-${pick(st, '89ab', 1)}${pick(st, HEX, 3)}-${pick(st, HEX, 12)}`;
}
/** The volume id of a FAT file system, shown as its UUID: 1A2B-3C4D. */
export function newVfatId(st: StorageState): string {
  return `${pick(st, HEX, 4)}-${pick(st, HEX, 4)}`.toUpperCase();
}
export function newLvmUuid(st: StorageState): string {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [6, 4, 4, 4, 4, 4, 6].map((n) => pick(st, a, n)).join('-');
}
export function newDosId(st: StorageState): string {
  return pick(st, HEX, 8);
}

// ---------- devices ----------

export const partPath = (disk: string, n: number) => `/dev/${disk}${/\d$/.test(disk) ? 'p' : ''}${n}`;
/** Device-mapper name of an LV: dashes in names are doubled, vg-lv. */
export const dmName = (vg: string, lv: string) => `${vg.replace(/-/g, '--')}-${lv.replace(/-/g, '--')}`;
export const lvExtents = (lv: LogicalVolume) => lv.segments.reduce((s, x) => s + x.extents, 0);
export const partSectors = (p: Partition) => p.end - p.start + 1;

export function listDevices(st: StorageState): BlockDevice[] {
  const out: BlockDevice[] = [];
  for (const d of st.disks) {
    out.push({ path: `/dev/${d.name}`, kname: d.name, name: d.name, type: 'disk', size: d.sectors * SECTOR, major: 259, minor: d.minor, holder: d, disk: d });
    for (const p of [...d.partitions].sort((a, b) => a.number - b.number)) {
      const path = partPath(d.name, p.number);
      const kname = path.slice(5);
      // the kernel exposes an extended partition as a tiny 1 KiB device
      const size = p.kind === 'extended' ? KiB : partSectors(p) * SECTOR;
      out.push({ path, kname, name: kname, type: 'part', size, major: 259, minor: p.minor, holder: p, disk: d, part: p });
    }
  }
  for (const vg of st.vgs) {
    for (const lv of vg.lvs) {
      const name = dmName(vg.name, lv.name);
      out.push({
        path: `/dev/mapper/${name}`, kname: `dm-${lv.minor}`, name, type: 'lvm', size: lvExtents(lv) * vg.extentSize,
        major: 253, minor: lv.minor, holder: lv, vg, lv,
      });
    }
  }
  return out;
}

type Tag = 'UUID' | 'LABEL' | 'PARTUUID' | 'PARTLABEL';

function tagValue(st: StorageState, d: BlockDevice, tag: Tag): string | undefined {
  switch (tag) {
    case 'UUID':
      return d.holder.fs?.uuid ?? st.pvs.find((p) => p.device === d.path)?.uuid;
    case 'LABEL':
      return d.holder.fs?.label || undefined;
    case 'PARTUUID':
      return d.part?.partuuid;
    case 'PARTLABEL':
      return d.part?.name || undefined;
  }
}

/**
 * Find a block device by path (/dev/nvme0n2p1, /dev/dm-2, /dev/vg/lv, /dev/mapper/vg-lv,
 * /dev/disk/by-uuid/...) or by tag (UUID=..., LABEL=..., PARTUUID=..., PARTLABEL=...).
 */
export function findDevice(st: StorageState, spec: string): BlockDevice | null {
  const devs = listDevices(st);
  let tag: Tag | null = null;
  let value = '';
  const t = /^(UUID|LABEL|PARTUUID|PARTLABEL)=(.*)$/.exec(spec);
  const by = /^\/dev\/disk\/by-(uuid|label|partuuid|partlabel)\/(.+)$/.exec(spec);
  if (t) [tag, value] = [t[1] as Tag, t[2].replace(/^"(.*)"$/, '$1')];
  else if (by) [tag, value] = [by[1].toUpperCase() as Tag, by[2]];
  if (tag) {
    const want = tag === 'UUID' || tag === 'PARTUUID' ? value.toLowerCase() : value;
    return (
      devs.find((d) => {
        const v = tagValue(st, d, tag!);
        return v !== undefined && (tag === 'UUID' || tag === 'PARTUUID' ? v.toLowerCase() : v) === want;
      }) ?? null
    );
  }
  const p = spec.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  return (
    devs.find(
      (d) => d.path === p || `/dev/${d.kname}` === p || (d.vg && d.lv && `/dev/${d.vg.name}/${d.lv.name}` === p),
    ) ?? null
  );
}

/** The signature on a device as blkid reports it: xfs, ext4, vfat, swap, LVM2_member or null. */
export function signatureOf(st: StorageState, d: BlockDevice): string | null {
  if (d.holder.fs) return d.holder.fs.type;
  if (st.pvs.some((p) => p.device === d.path)) return 'LVM2_member';
  return null;
}

export const isSwapOn = (st: StorageState, path: string) => st.swaps.some((s) => s.device === path);
export const mountsOf = (st: StorageState, path: string) => st.mounts.filter((m) => m.source === path);
export const mountAt = (st: StorageState, target: string) =>
  [...st.mounts].reverse().find((m) => m.target === target);

/** Partitions of a disk that something is using: mounted, active swap, or a PV in a VG. */
export function deviceBusy(st: StorageState, d: BlockDevice): boolean {
  if (mountsOf(st, d.path).length || isSwapOn(st, d.path)) return true;
  const pv = st.pvs.find((p) => p.device === d.path);
  return !!pv && pv.vg !== '';
}

// ---------- LVM arithmetic ----------

export const vgByName = (st: StorageState, name: string) => st.vgs.find((v) => v.name === name);
export const pvsOf = (st: StorageState, vg: VolumeGroup) => st.pvs.filter((p) => p.vg === vg.name);

export function deviceSize(st: StorageState, path: string): number {
  return findDevice(st, path)?.size ?? 0;
}
/** Number of extents a PV holds in a VG with this extent size. */
export function pvExtentCount(st: StorageState, pv: PhysicalVolume, extentSize: number): number {
  return Math.max(0, Math.floor((deviceSize(st, pv.device) - PE_START) / extentSize));
}
export function pvUsedExtents(vg: VolumeGroup, pvPath: string): number {
  let n = 0;
  for (const lv of vg.lvs) for (const s of lv.segments) if (s.pv === pvPath) n += s.extents;
  return n;
}
export function vgTotalExtents(st: StorageState, vg: VolumeGroup): number {
  return pvsOf(st, vg).reduce((s, pv) => s + pvExtentCount(st, pv, vg.extentSize), 0);
}
export function vgFreeExtents(st: StorageState, vg: VolumeGroup): number {
  return vgTotalExtents(st, vg) - vg.lvs.reduce((s, lv) => s + lvExtents(lv), 0);
}

// ---------- file system space ----------

/** Size of the internal XFS log: 1/2048 of the file system, at least 64 MiB, at most 2 GiB. */
export function xfsLogSize(size: number): number {
  return Math.min(2 * GiB, Math.max(64 * MiB, Math.ceil(size / 2048 / 4096) * 4096));
}
/** Journal size mke2fs picks for an ext4 file system of this many 4k blocks (in blocks). */
export function ext4JournalBlocks(blocks: number): number {
  if (blocks < 32768) return 1024;
  if (blocks < 256 * 1024) return 4096;
  if (blocks < 512 * 1024) return 8192;
  if (blocks < 4096 * 1024) return 16384;
  if (blocks < 8192 * 1024) return 32768;
  if (blocks < 16384 * 1024) return 65536;
  if (blocks < 32768 * 1024) return 131072;
  return 262144;
}

/** What statfs (and so df) reports for a file system, in bytes. */
export function fsUsage(fs: FileSystem): { size: number; used: number; avail: number } {
  let size = fs.size;
  let reserved = 0;
  if (fs.type === 'xfs') size -= xfsLogSize(fs.size);
  else if (fs.type === 'ext4') {
    size -= Math.floor(fs.size / 64) + ext4JournalBlocks(fs.size / 4096) * 4096; // inode tables and journal
    reserved = Math.floor(fs.size * 0.05); // blocks reserved for root
  } else if (fs.type === 'vfat') size -= Math.floor(fs.size / 512) + 16 * KiB; // the two FATs
  size = Math.floor(size / 4096) * 4096;
  return { size, used: fs.used, avail: Math.max(0, size - fs.used - reserved) };
}

/** Bytes in use on a file system that was just created. */
export function freshUsed(type: FsType, size: number): number {
  if (type === 'xfs') return Math.ceil((32 * MiB + size * 0.007) / 4096) * 4096;
  if (type === 'ext4') return 24 * KiB;
  if (type === 'vfat') return 4 * KiB;
  return 0;
}

/** The root directory of a file system that was just created. */
export function freshRoot(type: FsType): FsNode {
  const root = makeDir(0, 0, 0o755);
  if (type === 'ext4') root.children!['lost+found'] = makeDir(0, 0, 0o700);
  return root;
}

// ---------- mount options ----------

export const PSEUDO_MOUNTS = [
  { source: 'proc', target: '/proc', type: 'proc', options: 'rw,nosuid,nodev,noexec,relatime', size: 0, used: 0 },
  { source: 'sysfs', target: '/sys', type: 'sysfs', options: 'rw,nosuid,nodev,noexec,relatime,seclabel', size: 0, used: 0 },
  { source: 'devtmpfs', target: '/dev', type: 'devtmpfs', options: 'rw,nosuid,seclabel,size=4096k,nr_inodes=465821,mode=755,inode64', size: 4096 * KiB, used: 0 },
  { source: 'tmpfs', target: '/dev/shm', type: 'tmpfs', options: 'rw,nosuid,nodev,seclabel,inode64', size: 1870140 * KiB, used: 0 },
  { source: 'tmpfs', target: '/run', type: 'tmpfs', options: 'rw,nosuid,nodev,seclabel,size=748056k,nr_inodes=819200,mode=755,inode64', size: 748056 * KiB, used: 9012 * KiB },
];

const GENERIC_OPTS = [
  'defaults', 'rw', 'ro', 'auto', 'noauto', 'nofail', 'user', 'nouser', 'users', 'owner', 'group', 'exec', 'noexec',
  'suid', 'nosuid', 'dev', 'nodev', 'async', 'sync', 'dirsync', 'atime', 'noatime', 'relatime', 'norelatime',
  'strictatime', 'lazytime', 'nolazytime', 'diratime', 'nodiratime', '_netdev', 'remount', 'loop', 'iversion',
  'noiversion', 'mand', 'nomand',
];
const VALUED_GENERIC = ['context', 'fscontext', 'defcontext', 'rootcontext', 'comment'];
const FS_OPTS: Record<string, string[]> = {
  xfs: ['usrquota', 'grpquota', 'prjquota', 'uquota', 'gquota', 'pquota', 'quota', 'noquota', 'uqnoenforce', 'gqnoenforce',
    'inode64', 'inode32', 'nouuid', 'discard', 'nodiscard', 'largeio', 'nolargeio', 'swalloc', 'wsync', 'attr2', 'noattr2',
    'norecovery', 'grpid', 'nogrpid', 'logbufs', 'logbsize', 'allocsize', 'logdev', 'sunit', 'swidth'],
  ext4: ['acl', 'noacl', 'user_xattr', 'nouser_xattr', 'usrquota', 'grpquota', 'quota', 'noquota', 'discard', 'nodiscard',
    'errors', 'data', 'barrier', 'nobarrier', 'commit', 'journal_checksum', 'noload', 'dax', 'auto_da_alloc', 'noauto_da_alloc',
    'delalloc', 'nodelalloc', 'stripe', 'resuid', 'resgid', 'sb', 'grpid', 'nogrpid', 'init_itable', 'noinit_itable'],
  vfat: ['uid', 'gid', 'umask', 'dmask', 'fmask', 'codepage', 'iocharset', 'shortname', 'utf8', 'flush', 'errors', 'quiet',
    'showexec', 'tz', 'time_offset', 'allow_utime', 'check', 'discard', 'dos1xfloppy', 'nfs', 'rodir', 'sys_immutable'],
};

/** The first option that the kernel (or mount) would reject for this file system type, if any. */
export function badOption(type: string, opts: string[]): string | null {
  for (const o of opts) {
    const key = o.split('=')[0];
    if (GENERIC_OPTS.includes(o) || VALUED_GENERIC.includes(key) || key.startsWith('x-') || o === '') continue;
    if ((FS_OPTS[type] ?? []).includes(key)) continue;
    return o;
  }
  return null;
}

/** Options as the kernel shows them in /proc/mounts. */
export function kernelOptions(type: string, opts: string[]): string {
  const has = (o: string) => opts.includes(o);
  const val = (k: string) => opts.find((o) => o.startsWith(k + '='))?.slice(k.length + 1);
  const ro = opts.reduce((r, o) => (o === 'ro' ? true : o === 'rw' ? false : r), false);
  const out = [ro ? 'ro' : 'rw'];
  for (const o of ['nosuid', 'nodev', 'noexec', 'sync', 'dirsync']) if (has(o)) out.push(o);
  out.push(has('noatime') ? 'noatime' : has('strictatime') ? 'strictatime' : 'relatime');
  if (type === 'vfat') {
    const umask = val('umask');
    if (val('uid')) out.push(`uid=${val('uid')}`);
    if (val('gid')) out.push(`gid=${val('gid')}`);
    out.push(`fmask=${val('fmask') ?? umask ?? '0022'}`, `dmask=${val('dmask') ?? umask ?? '0022'}`);
    out.push('codepage=437', 'iocharset=ascii', `shortname=${val('shortname') ?? 'mixed'}`, 'errors=remount-ro');
    return out.join(',');
  }
  out.push('seclabel');
  if (type === 'xfs') {
    out.push('attr2', 'inode64', 'logbufs=8', 'logbsize=32k');
    const quotas = ['usrquota', 'grpquota', 'prjquota'].filter((q) => has(q) || has(q[0] + 'quota'));
    out.push(...(quotas.length ? quotas : ['noquota']));
  } else if (type === 'ext4') {
    for (const q of ['usrquota', 'grpquota']) if (has(q)) out.push(q);
  }
  return out.join(',');
}

// ---------- the file tree ----------

interface Located {
  node: FsNode;
  parent: FsNode;
  name: string;
  parts: string[];
}

/** Walk the tree with no permission checks, following symlinks. Returns null if missing. */
export function lookup(state: SystemState, path: string, followLast = true, depth = 0): Located | null {
  if (depth > 20) return null;
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  let node = state.root;
  let parent = state.root;
  const walked: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (node.type !== 'dir') return null;
    const child = node.children![parts[i]];
    if (!child) return null;
    const last = i === parts.length - 1;
    if (child.type === 'link' && (!last || followLast)) {
      const base = child.target!.startsWith('/') ? child.target! : '/' + walked.join('/') + '/' + child.target!;
      const rest = parts.slice(i + 1).join('/');
      return lookup(state, rest ? `${base}/${rest}` : base, followLast, depth + 1);
    }
    parent = node;
    node = child;
    walked.push(parts[i]);
  }
  return { node, parent, name: parts[parts.length - 1] ?? '/', parts: walked };
}

export function readFstab(state: SystemState): string {
  const r = lookup(state, '/etc/fstab');
  return r && r.node.type === 'file' ? (r.node.content ?? '') : '';
}

/** Put a file system root (or other directory) onto the tree at m.target and record the mount. */
export function attachMount(state: SystemState, m: Mount, node: FsNode): boolean {
  const r = lookup(state, m.target);
  if (!r || m.target === '/') return false;
  m.covered = r.parent.children![r.name];
  r.parent.children![r.name] = node;
  state.storage.mounts.push(m);
  return true;
}

/** Take a mount off the tree, putting back the directory it covered. Returns the detached root. */
export function detachMount(state: SystemState, m: Mount): FsNode | undefined {
  const st = state.storage;
  st.mounts = st.mounts.filter((x) => x !== m);
  const r = lookup(state, m.target, false);
  const parentPath = m.target.slice(0, m.target.lastIndexOf('/')) || '/';
  const parent = r?.parent ?? lookup(state, parentPath)?.node;
  if (!parent || parent.type !== 'dir') return undefined;
  const name = m.target.slice(m.target.lastIndexOf('/') + 1);
  const node = parent.children![name];
  parent.children![name] = m.covered ?? makeDir(0, 0, 0o755);
  return node;
}

// ---------- fstab ----------

export interface FstabEntry {
  line: number; // 1-based line number in /etc/fstab
  spec: string; // UUID=..., LABEL=..., /dev/...
  file: string; // mount point, or none/swap for swap
  type: string;
  options: string[];
  freq: number;
  passno: number;
}

/** Parse /etc/fstab text. Lines that cannot be parsed are listed in `errors` by line number. */
export function parseFstab(text: string): { entries: FstabEntry[]; errors: number[] } {
  const entries: FstabEntry[] = [];
  const errors: number[] = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#')) return;
    const f = l.split(/\s+/);
    const num = (s: string | undefined) => (s === undefined ? 0 : /^\d+$/.test(s) ? +s : NaN);
    if (f.length < 3 || f.length > 6 || Number.isNaN(num(f[4])) || Number.isNaN(num(f[5]))) {
      errors.push(i + 1);
      return;
    }
    entries.push({ line: i + 1, spec: f[0], file: f[1], type: f[2], options: (f[3] ?? 'defaults').split(','), freq: num(f[4]), passno: num(f[5]) });
  });
  return { entries, errors };
}

export const NETWORK_FS = ['nfs', 'nfs4', 'cifs', 'smb3', 'glusterfs', 'ceph', 'fuse.sshfs', 'autofs'];
const MOUNTABLE = ['xfs', 'ext4', 'vfat'];
export const KNOWN_FS = [...MOUNTABLE, 'auto', 'ext2', 'ext3', 'msdos', 'fat', 'tmpfs', 'iso9660', 'udf', 'btrfs', 'ntfs', 'ntfs3', 'swap', ...NETWORK_FS];

export interface MountPlan {
  dev?: BlockDevice;
  fs?: FileSystem;
  error?: string; // e.g. "/data: can't find UUID=1234." (mount(8) prints it after "mount: ")
  dmesg?: boolean; // mount(8) adds its "dmesg(1) may have more information" line
}

/** Check whether `mount spec target` would work, without changing anything. */
export function planMount(state: SystemState, spec: string, target: string, type: string | undefined, opts: string[]): MountPlan {
  const st = state.storage;
  const dev = findDevice(st, spec);
  if (!dev) {
    if (/^(UUID|LABEL|PARTUUID|PARTLABEL)=/.test(spec)) return { error: `${target}: can't find ${spec}.` };
    return { error: `${target}: special device ${spec} does not exist.`, dmesg: true };
  }
  const t = lookup(state, target);
  if (!t) return { dev, error: `${target}: mount point does not exist.`, dmesg: true };
  if (t.node.type !== 'dir') return { dev, error: `${target}: mount point is not a directory.`, dmesg: true };
  const sig = signatureOf(st, dev);
  const want = type && type !== 'auto' ? type : undefined;
  if (want && !KNOWN_FS.includes(want)) return { dev, error: `${target}: unknown filesystem type '${want}'.`, dmesg: true };
  if (!want && (sig === 'swap' || sig === 'LVM2_member')) return { dev, error: `${target}: unknown filesystem type '${sig}'.`, dmesg: true };
  const wrong = { dev, error: `${target}: wrong fs type, bad option, bad superblock on ${dev.path}, missing codepage or helper program, or other error.`, dmesg: true };
  if (!sig || !MOUNTABLE.includes(sig) || (want && want !== sig)) return wrong;
  if (badOption(sig, opts)) return wrong;
  const canonical = '/' + t.parts.join('/');
  if (st.mounts.some((m) => m.target === canonical && m.source === dev.path)) {
    return { dev, error: `${target}: ${dev.path} already mounted on ${canonical}.`, dmesg: true };
  }
  return { dev, fs: dev.holder.fs };
}

/** Check whether `swapon spec` would work. Errors are full swapon(8) messages. */
export function planSwap(state: SystemState, spec: string): { dev?: BlockDevice; error?: string } {
  const st = state.storage;
  const dev = findDevice(st, spec);
  if (!dev) {
    if (/^(UUID|LABEL|PARTUUID|PARTLABEL)=/.test(spec)) return { error: `swapon: cannot find the device for ${spec}` };
    return { error: `swapon: cannot open ${spec}: No such file or directory` };
  }
  if (signatureOf(st, dev) !== 'swap') return { dev, error: `swapon: ${dev.path}: read swap header failed` };
  if (isSwapOn(st, dev.path)) return { dev, error: `swapon: ${dev.path}: swapon failed: Device or resource busy` };
  return { dev };
}

/**
 * For lab checks: what each /etc/fstab line resolves to, and the error a boot would hit
 * (null when the line is fine). Lines with noauto are reported with error null.
 */
export function fstabCheck(state: SystemState): { entry: FstabEntry; dev: BlockDevice | null; error: string | null }[] {
  const { entries } = parseFstab(readFstab(state));
  return entries.map((entry) => {
    if (entry.type === 'swap') {
      const p = planSwap(state, entry.spec);
      const error = p.error && !(p.dev && isSwapOn(state.storage, p.dev.path)) ? p.error : null;
      return { entry, dev: p.dev ?? null, error: entry.options.includes('noauto') ? null : error };
    }
    if (NETWORK_FS.includes(entry.type) || entry.file === '/') {
      return { entry, dev: findDevice(state.storage, entry.spec), error: null };
    }
    const p = planMount(state, entry.spec, entry.file, entry.type, entry.options);
    const error = p.error && !/already mounted/.test(p.error) ? `mount: ${p.error}` : null;
    return { entry, dev: p.dev ?? null, error: entry.options.includes('noauto') ? null : error };
  });
}

// ---------- generated files ----------

const FILE_MODE = 0o444;

/** Rebuild the storage nodes under /dev: disks, partitions, dm-N, /dev/mapper, /dev/VG and /dev/disk/by-*. */
export function syncDevTree(root: FsNode, st: StorageState): void {
  const dev = root.children!.dev;
  if (!dev || dev.type !== 'dir') return;
  const kids = dev.children!;
  const devs = listDevices(st);
  const want = new Set(devs.map((d) => d.kname));
  for (const n of Object.keys(kids)) {
    if (/^(nvme\d+n\d+(p\d+)?|dm-\d+)$/.test(n) && !want.has(n)) delete kids[n];
  }
  for (const d of devs) if (!kids[d.kname]) kids[d.kname] = makeFile('', 0, 0, 0o660);

  const mapper = makeDir();
  mapper.children!.control = makeFile('', 0, 0, 0o600);
  for (const d of devs) if (d.type === 'lvm') mapper.children![d.name] = makeLink(`../${d.kname}`);
  kids.mapper = mapper;

  for (const name of st.devDirs) if (!st.vgs.some((v) => v.name === name)) delete kids[name];
  st.devDirs = [];
  for (const vg of st.vgs) {
    if (!vg.lvs.length) {
      delete kids[vg.name];
      continue;
    }
    const dir = makeDir();
    for (const lv of vg.lvs) dir.children![lv.name] = makeLink(`../dm-${lv.minor}`);
    kids[vg.name] = dir;
    st.devDirs.push(vg.name);
  }

  const disk = makeDir();
  const by = (kind: string) => (disk.children![`by-${kind}`] ??= makeDir());
  for (const d of devs) {
    const link = makeLink(`../../${d.kname}`);
    const fs = d.holder.fs;
    if (fs) by('uuid').children![fs.uuid] = link;
    if (fs?.label) by('label').children![fs.label.replace(/ /g, '\\x20')] = makeLink(`../../${d.kname}`);
    if (d.part) by('partuuid').children![d.part.partuuid] = makeLink(`../../${d.kname}`);
    if (d.part?.name) by('partlabel').children![d.part.name.replace(/ /g, '\\x20')] = makeLink(`../../${d.kname}`);
  }
  kids.disk = disk;
}

export function syncDev(state: SystemState): void {
  syncDevTree(state.root, state.storage);
}

const EFI_FILES: Record<string, string> = {
  'EFI/BOOT/BOOTX64.EFI': '(UEFI boot loader: shim)\n',
  'EFI/BOOT/fbx64.efi': '(UEFI fallback loader)\n',
  'EFI/redhat/shimx64.efi': '(shim, signed by Red Hat)\n',
  'EFI/redhat/grubx64.efi': '(GRUB 2 for UEFI)\n',
  'EFI/redhat/grub.cfg': "search --no-floppy --fs-uuid --set=dev 4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c\nset prefix=($dev)/grub2\nexport $prefix\nconfigfile $prefix/grub.cfg\n",
};

/** Add storage-related files (such as /etc/fstab) to a fresh root file system. */
export function addStorageFiles(root: FsNode): void {
  const c = root.children!;
  c.etc.children!.fstab = makeFile(INITIAL_FSTAB);
  c.etc.children!.mtab = makeLink('../proc/self/mounts');
  const proc = (c.proc ??= makeDir());
  for (const f of ['mounts', 'swaps', 'partitions']) proc.children![f] = makeFile('', 0, 0, FILE_MODE);
  const self = (proc.children!.self ??= makeDir(0, 0, 0o555));
  self.children!.mounts = makeFile('', 0, 0, FILE_MODE);
  // /boot/efi is the root of the vfat EFI system partition (umask=0077 makes it root-only)
  const boot = (c.boot ??= makeDir());
  const efi = (boot.children!.efi ??= makeDir(0, 0, 0o700));
  for (const [path, content] of Object.entries(EFI_FILES)) {
    const parts = path.split('/');
    let dir = efi;
    for (const p of parts.slice(0, -1)) dir = dir.children![p] ??= makeDir(0, 0, 0o700);
    dir.children![parts[parts.length - 1]] ??= makeFile(content, 0, 0, 0o700);
  }
  syncDevTree(root, initialStorage());
}

function procMounts(state: SystemState): string {
  const st = state.storage;
  const real = st.mounts.map((m) => `${m.source} ${m.target} ${m.type} ${kernelOptions(m.type, m.options)} 0 0`);
  const pseudo = PSEUDO_MOUNTS.map((p) => `${p.source} ${p.target} ${p.type} ${p.options} 0 0`);
  return [real[0], ...pseudo, ...real.slice(1)].filter(Boolean).join('\n') + '\n';
}

/** Size in KiB the kernel reports for a swap area: the device minus the header page. */
export const swapKiB = (fs: FileSystem) => Math.max(0, fs.size - 4096) / 1024;

function procSwaps(state: SystemState): string {
  const st = state.storage;
  let out = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n';
  for (const s of st.swaps) {
    const d = findDevice(st, s.device);
    if (!d?.holder.fs) continue;
    const name = `/dev/${d.kname}`;
    const kb = swapKiB(d.holder.fs);
    out += `${name}${' '.repeat(Math.max(1, 40 - name.length))}partition\t${kb}\t${kb < 10000000 ? '\t' : ''}0\t\t${s.priority}\n`;
  }
  return out;
}

function procPartitions(state: SystemState): string {
  let out = 'major minor  #blocks  name\n\n';
  for (const d of listDevices(state.storage)) {
    out += `${String(d.major).padStart(4)} ${String(d.minor).padStart(7)} ${String(Math.floor(d.size / 1024)).padStart(10)} ${d.kname}\n`;
  }
  return out;
}

/** Files whose content is generated from the storage state, e.g. /proc/mounts. */
export const STORAGE_FILES: Record<string, (state: SystemState) => string> = {
  '/proc/mounts': procMounts,
  '/proc/self/mounts': procMounts,
  '/proc/swaps': procSwaps,
  '/proc/partitions': procPartitions,
};

// ---------- helpers for lab checks ----------

/** The mount (if any) at a mount point, e.g. mountedAt(sh.state, '/data')?.source. */
export const mountedAt = (state: SystemState, target: string) => mountAt(state.storage, target);
/** The file system on a device given by path or tag, e.g. fsOn(sh.state, '/dev/vgdata/data')?.type. */
export const fsOn = (state: SystemState, spec: string) => findDevice(state.storage, spec)?.holder.fs;
/** Find an LV, e.g. lvOf(sh.state, 'vgdata', 'data'). */
export function lvOf(state: SystemState, vg: string, lv: string): LogicalVolume | undefined {
  return vgByName(state.storage, vg)?.lvs.find((l) => l.name === lv);
}
/** Size of an LV in bytes (0 if missing). */
export function lvSize(state: SystemState, vg: string, lv: string): number {
  const v = vgByName(state.storage, vg);
  const l = v?.lvs.find((x) => x.name === lv);
  return v && l ? lvExtents(l) * v.extentSize : 0;
}
/** Is swap active on this device (path or tag)? */
export function swapActive(state: SystemState, spec: string): boolean {
  const d = findDevice(state.storage, spec);
  return !!d && isSwapOn(state.storage, d.path);
}
/**
 * The /etc/fstab line for a mount point, what it resolves to, and the error a boot would hit
 * (null when fine), e.g. fstabFor(sh.state, '/data')?.entry.spec.startsWith('UUID=').
 */
export function fstabFor(state: SystemState, target: string) {
  return fstabCheck(state).find((c) => c.entry.file === target);
}

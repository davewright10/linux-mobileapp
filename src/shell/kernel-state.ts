// Installed kernels, kernel modules, boot loader entries and kernel arguments.
//
// The files are the source of truth wherever a real system keeps the setting in a file:
// /etc/default/grub, the BLS entries in /boot/loader/entries, /boot/grub2/grubenv, the
// /etc/modprobe.d and /etc/sysctl.d files, and the values in /proc/sys. KernelState holds what
// only exists in the running kernel: which kernel booted, its arguments and the loaded modules.
import { FsNode, makeDir, makeFile, makeLink } from './fs';
import type { SystemState } from './state';
import { STORAGE_FILES, findDevice } from './storage-state';

// ---------- constants ----------

/** The kernel the server was installed with, and which runs at the start of every lab. */
export const RUNNING_KERNEL = '6.12.0-55.el10.x86_64';
/** The newer kernel in the BaseOS repository that "dnf update kernel" installs. */
export const UPDATE_KERNEL = '6.12.0-124.el10.x86_64';
/** Kernels the repositories offer (dnf can install these). */
export const REPO_KERNELS = [RUNNING_KERNEL, UPDATE_KERNEL];
export const MACHINE_ID = '4f6c2a9e8b1d4c7a9e3f5b2d6a8c1e07';
export const ROOT_DEVICE = '/dev/mapper/rhel-root';
/**
 * GRUB_CMDLINE_LINUX of a fresh RHEL 10 install with LVM. The installer adds "rhgb quiet" because
 * plymouth (the boot splash) is part of @core.
 */
export const DEFAULT_KERNEL_ARGS =
  'crashkernel=2G-64G:256M,64G-:512M resume=/dev/mapper/rhel-swap rd.lvm.lv=rhel/root rd.lvm.lv=rhel/swap rhgb quiet';
export const DEFAULT_OPTIONS = `root=${ROOT_DEVICE} ro ${DEFAULT_KERNEL_ARGS}`;
const BOOT_DEVICE = '(hd0,gpt2)'; // /boot is the second GPT partition
const BOOT_UUID = '4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c';
const ROOT_FS_UUID = 'a3f7c2d1-5b8e-4f6a-9d2c-1e7b3a5f8c4d'; // the XFS file system on rhel-root, as blkid shows it
export const OS_TITLE = 'Red Hat Enterprise Linux';
export const OS_VERSION = '10.0 (Coughlan)';
export const ENTRIES_DIR = '/boot/loader/entries';
export const GRUBENV = '/boot/grub2/grubenv';
export const GRUB_CFG = '/boot/grub2/grub.cfg';
export const EFI_GRUB_CFG = '/boot/efi/EFI/redhat/grub.cfg';
const UPTIME_MS = (3 * 86400 + 4 * 3600 + 11 * 60) * 1000; // matches `uptime`

const BUILD_DATES: Record<string, string> = {
  [RUNNING_KERNEL]: 'Fri Mar 28 06:59:43 EDT 2025',
  [UPDATE_KERNEL]: 'Thu Sep 25 08:16:12 EDT 2025',
};

/** The `uname -v` string of a kernel release. */
export const kernelBuild = (release: string) =>
  `#1 SMP PREEMPT_DYNAMIC ${BUILD_DATES[release] ?? 'Mon Jan 13 10:02:51 EST 2025'}`;

/** "6.12.0-124.el10.x86_64" -> "6.12.0-124.el10" (the version-release dnf and rpm show). */
export const pkgVersion = (release: string) => release.replace(/\.x86_64$/, '');

export const linuxVersionLine = (release: string) =>
  `Linux version ${release} (mockbuild@x86-64-03.build.eng.rdu2.redhat.com) (gcc (GCC) 14.2.1 20250110 (Red Hat 14.2.1-7), GNU ld version 2.41-53.el10) ${kernelBuild(release)}`;

// ---------- module catalogue ----------

export interface ModuleParam {
  name: string;
  type: 'int' | 'uint' | 'ushort' | 'bool' | 'charp' | 'string' | 'array of int';
  desc: string;
  def: string; // value shown in /sys/module/NAME/parameters/ when not set
}

export interface ModuleDef {
  path: string; // relative to /lib/modules/<release>/
  description: string;
  license: string;
  depends: string[];
  size: number;
  params: ModuleParam[];
  boot?: boolean; // loaded at boot by udev, LVM, firewalld, ... unless blacklisted
  refs?: number; // users that are not modules (devices, sockets)
  fsTypes?: string[]; // file system types it provides; mounts of them keep it in use
  messages?: string[]; // what it prints to the kernel log when it loads
}

const prm = (name: string, type: ModuleParam['type'], desc: string, def: string): ModuleParam => ({ name, type, desc, def });

const mod = (path: string, description: string, size: number, extra: Partial<ModuleDef> = {}): ModuleDef => ({
  path,
  description,
  license: 'GPL',
  depends: [],
  size,
  params: [],
  ...extra,
});

export const MODULES: Record<string, ModuleDef> = {
  xfs: mod('kernel/fs/xfs/xfs.ko.xz', 'SGI XFS with ACLs, security attributes, scrub, quota, no debug enabled', 2797568, {
    depends: ['libcrc32c'], boot: true, fsTypes: ['xfs'],
  }),
  libcrc32c: mod('kernel/lib/libcrc32c.ko.xz', 'CRC32c (Castagnoli) calculations', 12288, { boot: true }),
  crc32c_intel: mod('kernel/arch/x86/crypto/crc32c-intel.ko.xz', 'CRC32c (Castagnoli) optimization using Intel Hardware.', 24576, { boot: true, refs: 1 }),
  ext4: mod('kernel/fs/ext4/ext4.ko.xz', 'Fourth Extended Filesystem', 1105920, { depends: ['mbcache', 'jbd2'], fsTypes: ['ext4', 'ext3', 'ext2'] }),
  mbcache: mod('kernel/fs/mbcache.ko.xz', 'Meta block cache (for extended attributes)', 16384),
  jbd2: mod('kernel/fs/jbd2/jbd2.ko.xz', 'Generic filesystem journal-writing code', 204800),
  vfat: mod('kernel/fs/fat/vfat.ko.xz', 'VFAT filesystem support', 20480, { depends: ['fat'], boot: true, fsTypes: ['vfat'] }),
  fat: mod('kernel/fs/fat/fat.ko.xz', 'Core FAT filesystem support', 102400, { boot: true }),
  isofs: mod('kernel/fs/isofs/isofs.ko.xz', 'ISO 9660 CDROM file system support', 61440, { fsTypes: ['iso9660'] }),
  overlay: mod('kernel/fs/overlayfs/overlay.ko.xz', 'Overlay filesystem', 241664, {
    fsTypes: ['overlay'],
    params: [
      prm('redirect_dir', 'bool', 'Default to on or off for the redirect_dir feature', 'N'),
      prm('index', 'bool', 'Default to on or off for the inodes index feature', 'N'),
      prm('metacopy', 'bool', 'Default to on or off for the metadata only copy up feature', 'N'),
    ],
  }),
  fuse: mod('kernel/fs/fuse/fuse.ko.xz', 'Filesystem in Userspace', 212992, { boot: true, refs: 1, fsTypes: ['fuse', 'fuseblk'] }),
  loop: mod('kernel/drivers/block/loop.ko.xz', 'Loopback device support', 45056, {
    params: [
      prm('max_loop', 'int', 'Maximum number of loop devices', '0'),
      prm('max_part', 'int', 'Maximum number of partitions per loop device', '0'),
    ],
    messages: ['loop: module loaded'],
  }),
  dm_mod: mod('kernel/drivers/md/dm-mod.ko.xz', 'device-mapper driver', 249856, {
    boot: true,
    refs: 7,
    params: [
      prm('major', 'uint', 'The major number of the device mapper', '253'),
      prm('reserved_bio_based_ios', 'uint', 'Reserved IOs in bio-based mempools', '16'),
    ],
  }),
  dm_log: mod('kernel/drivers/md/dm-log.ko.xz', 'device-mapper dirty region log', 24576, { depends: ['dm_mod'], boot: true }),
  dm_region_hash: mod('kernel/drivers/md/dm-region-hash.ko.xz', 'device-mapper region hash', 28672, { depends: ['dm_log'], boot: true }),
  dm_mirror: mod('kernel/drivers/md/dm-mirror.ko.xz', 'device-mapper mirror target', 28672, {
    depends: ['dm_region_hash', 'dm_log', 'dm_mod'], boot: true,
  }),
  nvme_core: mod('kernel/drivers/nvme/host/nvme-core.ko.xz', 'NVMe host core framework', 233472, {
    boot: true,
    refs: 4,
    params: [
      prm('io_timeout', 'uint', 'timeout in seconds for I/O', '30'),
      prm('multipath', 'bool', 'turn on native support for multiple controllers per subsystem', 'Y'),
    ],
  }),
  nvme: mod('kernel/drivers/nvme/host/nvme.ko.xz', 'NVMe host PCIe transport driver', 65536, { depends: ['nvme_core'], boot: true, refs: 3 }),
  sg: mod('kernel/drivers/scsi/sg.ko.xz', 'SCSI generic (sg) driver', 45056, {
    boot: true,
    params: [
      prm('def_reserved_size', 'int', 'size of buffer reserved for each fd', '32768'),
      prm('allow_dio', 'int', 'allow direct I/O (default: 0 (disallow))', '0'),
    ],
  }),
  vmxnet3: mod('kernel/drivers/net/vmxnet3/vmxnet3.ko.xz', 'VMware vmxnet3 virtual NIC driver', 86016, { boot: true, license: 'Dual BSD/GPL' }),
  vmw_balloon: mod('kernel/drivers/misc/vmw_balloon.ko.xz', 'VMware Memory Control (Balloon) Driver', 28672, { boot: true, license: 'GPL' }),
  e1000e: mod('kernel/drivers/net/ethernet/intel/e1000e/e1000e.ko.xz', 'Intel(R) PRO/1000 Network Driver', 364544, {
    license: 'GPL v2',
    params: [
      prm('debug', 'int', 'Debug level (0=none,...,16=all)', '-1'),
      prm('InterruptThrottleRate', 'array of int', 'Interrupt Throttling Rate', '3'),
      prm('SmartPowerDownEnable', 'array of int', 'Enable PHY smart power down', '0'),
    ],
    messages: ['e1000e: Intel(R) PRO/1000 Network Driver', 'e1000e: Copyright(c) 1999 - 2015 Intel Corporation.'],
  }),
  nfnetlink: mod('kernel/net/netfilter/nfnetlink.ko.xz', 'Netfilter messages via netlink socket', 20480, { boot: true, refs: 1 }),
  nf_tables: mod('kernel/net/netfilter/nf_tables.ko.xz', 'Framework for packet filtering and classification', 368640, {
    depends: ['nfnetlink', 'libcrc32c'], boot: true, refs: 4,
  }),
  nf_defrag_ipv4: mod('kernel/net/ipv4/netfilter/nf_defrag_ipv4.ko.xz', 'IPv4 defragmentation support', 12288, { boot: true }),
  nf_defrag_ipv6: mod('kernel/net/ipv6/netfilter/nf_defrag_ipv6.ko.xz', 'IPv6 defragmentation support', 24576, { boot: true }),
  nf_conntrack: mod('kernel/net/netfilter/nf_conntrack.ko.xz', 'IPv4 and IPv6 connection tracking', 196608, {
    depends: ['nf_defrag_ipv6', 'nf_defrag_ipv4', 'libcrc32c'],
    boot: true,
    params: [prm('hashsize', 'uint', 'Size of the connection tracking table', '16384')],
  }),
  nft_ct: mod('kernel/net/netfilter/nft_ct.ko.xz', 'Netfilter nf_tables conntrack module', 28672, {
    depends: ['nf_tables', 'nf_conntrack'], boot: true, refs: 8,
  }),
  llc: mod('kernel/net/llc/llc.ko.xz', 'LLC IEEE 802.2 core support', 16384),
  stp: mod('kernel/net/802/stp.ko.xz', 'SAP demux for IEEE 802.1D Spanning Tree Protocol (STP)', 12288, { depends: ['llc'] }),
  bridge: mod('kernel/net/bridge/bridge.ko.xz', 'Ethernet bridge driver', 421888, {
    depends: ['stp', 'llc'],
    messages: ['bridge: filtering via arp/ip/ip6tables is no longer available by default. Update your scripts to load br_netfilter if you need this.'],
  }),
  br_netfilter: mod('kernel/net/bridge/br_netfilter.ko.xz', 'Linux ethernet netfilter firewall bridge', 36864, {
    depends: ['bridge'],
    messages: ['Bridge firewalling registered'],
  }),
  usb_storage: mod('kernel/drivers/usb/storage/usb-storage.ko.xz', 'USB Mass Storage driver for Linux', 90112, {
    params: [
      prm('delay_use', 'uint', 'time to delay before using a new device', '1'),
      prm('quirks', 'string', 'supplemental list of device IDs and their quirks', ''),
    ],
    messages: ['usbcore: registered new interface driver usb-storage'],
  }),
  uas: mod('kernel/drivers/usb/storage/uas.ko.xz', 'USB Attached SCSI driver', 36864, {
    depends: ['usb_storage'],
    messages: ['usbcore: registered new interface driver uas'],
  }),
  rfkill: mod('kernel/net/rfkill/rfkill.ko.xz', 'RF switch support', 40960, {
    params: [prm('default_state', 'uint', 'Default initial state for all radio types, 0 = radio off', '1')],
  }),
  bluetooth: mod('kernel/net/bluetooth/bluetooth.ko.xz', 'Bluetooth Core ver 2.22', 1081344, {
    depends: ['rfkill'],
    params: [
      prm('disable_esco', 'bool', 'Disable eSCO connection creation', 'N'),
      prm('disable_ertm', 'bool', 'Disable enhanced retransmission mode', 'N'),
      prm('enable_ecred', 'bool', 'Enable enhanced credit flow control mode', 'Y'),
    ],
    messages: ['Bluetooth: Core ver 2.22', 'NET: Registered PF_BLUETOOTH protocol family', 'Bluetooth: HCI device and connection manager initialized'],
  }),
  btintel: mod('kernel/drivers/bluetooth/btintel.ko.xz', 'Bluetooth support for Intel devices ver 0.1', 61440, { depends: ['bluetooth'] }),
  btrtl: mod('kernel/drivers/bluetooth/btrtl.ko.xz', 'Bluetooth support for Realtek devices ver 0.1', 32768, { depends: ['bluetooth'] }),
  btusb: mod('kernel/drivers/bluetooth/btusb.ko.xz', 'Generic Bluetooth USB driver ver 0.8', 77824, {
    depends: ['btintel', 'btrtl', 'bluetooth'],
    params: [
      prm('disable_scofix', 'bool', 'Disable fixup of wrong SCO buffer size', 'N'),
      prm('force_scofix', 'bool', 'Force fixup of wrong SCO buffers size', 'N'),
      prm('enable_autosuspend', 'bool', 'Enable USB autosuspend by default', 'Y'),
      prm('reset', 'bool', 'Send HCI reset command on initialization', 'N'),
    ],
    messages: ['usbcore: registered new interface driver btusb'],
  }),
  sunrpc: mod('kernel/net/sunrpc/sunrpc.ko.xz', 'Sun RPC core', 851968, {
    boot: true,
    refs: 1,
    messages: ['RPC: Registered named UNIX socket transport module.', 'RPC: Registered tcp transport module.'],
  }),
  grace: mod('kernel/fs/nfs_common/grace.ko.xz', 'NFS client and server infrastructure', 16384),
  lockd: mod('kernel/fs/lockd/lockd.ko.xz', 'NFS file locking service version 0.5.', 143360, { depends: ['grace', 'sunrpc'] }),
  netfs: mod('kernel/fs/netfs/netfs.ko.xz', 'Network fs support', 552960),
  nfs: mod('kernel/fs/nfs/nfs.ko.xz', 'NFS client support', 581632, {
    depends: ['lockd', 'grace', 'sunrpc', 'netfs'],
    fsTypes: ['nfs', 'nfs4'],
    params: [
      prm('nfs4_disable_idmapping', 'bool', "Turn off NFSv4 idmapping when using 'sec=sys'", 'Y'),
      prm('enable_ino64', 'bool', '', 'Y'),
      prm('callback_nr_threads', 'ushort', 'Number of threads that will be assigned to the NFSv4 callback channels.', '0'),
    ],
    messages: ['NFS: Registering the id_resolver key type', 'Key type id_resolver registered', 'Key type id_legacy registered'],
  }),
  dns_resolver: mod('kernel/net/dns_resolver/dns_resolver.ko.xz', 'DNS Resolver', 16384),
  cifs: mod('kernel/fs/smb/client/cifs.ko.xz', 'VFS to access SMB3 servers e.g. Samba, Macs, Azure and Windows (and also older servers complying with the SNIA CIFS Specification)', 1146880, {
    depends: ['netfs', 'dns_resolver'],
    fsTypes: ['cifs', 'smb3'],
    params: [
      prm('CIFSMaxBufSize', 'uint', 'Network buffer size (not including header) for CIFS requests. Default: 16384 Range: 8192 to 130048', '16384'),
      prm('enable_oplocks', 'bool', 'Enable or disable oplocks. Default: y/Y/1', 'Y'),
    ],
    messages: ['Key type cifs.spnego registered', 'Key type cifs.idmap registered'],
  }),
  irqbypass: mod('kernel/virt/lib/irqbypass.ko.xz', 'IRQ bypass manager utility module', 12288),
  kvm: mod('kernel/arch/x86/kvm/kvm.ko.xz', 'Kernel-based Virtual Machine (KVM) Hypervisor', 1404928, {
    depends: ['irqbypass'],
    params: [
      prm('ignore_msrs', 'bool', '', 'N'),
      prm('halt_poll_ns', 'uint', '', '200000'),
    ],
  }),
  kvm_intel: mod('kernel/arch/x86/kvm/kvm-intel.ko.xz', 'KVM support for VMX (Intel VT-x) extensions', 438272, {
    depends: ['kvm'],
    params: [
      prm('nested', 'bool', '', 'Y'),
      prm('ept', 'bool', '', 'Y'),
      prm('enable_apicv', 'bool', '', 'Y'),
    ],
  }),
};

/** modprobe and lsmod treat - and _ the same; the kernel uses _. */
export const normalizeModule = (name: string) => name.replace(/-/g, '_');

/** The file name part of a module, as modinfo's depends: field shows it (dm-mod, not dm_mod). */
export const moduleFileName = (name: string) => MODULES[name]?.path.split('/').pop()!.replace(/\.ko\.xz$/, '') ?? name;

/** A module and everything it needs, dependencies first. */
export function moduleDeps(name: string): string[] {
  const out: string[] = [];
  const walk = (n: string) => {
    for (const d of MODULES[n]?.depends ?? []) walk(d);
    if (!out.includes(n)) out.push(n);
  };
  walk(name);
  return out;
}

/** Modules udev, LVM and firewalld load at every boot (unless blacklisted). */
export const BOOT_MODULES = Object.keys(MODULES).filter((n) => MODULES[n].boot);

// ---------- sysctl ----------

interface SysctlDef {
  def: string | ((state: SystemState | null) => string);
  module?: string; // the key only exists while this module is loaded
  readonly?: boolean;
}

const tunedGuest = (s: SystemState | null) => !s || s.tunedProfile === 'virtual-guest';

export const SYSCTLS: Record<string, SysctlDef> = {
  'fs.file-max': { def: '9223372036854775807' },
  'fs.protected_hardlinks': { def: '1' },
  'fs.protected_symlinks': { def: '1' },
  'kernel.core_uses_pid': { def: '1' },
  'kernel.dmesg_restrict': { def: '0' },
  'kernel.osrelease': { def: (s) => s?.kernel.running ?? RUNNING_KERNEL, readonly: true },
  'kernel.panic': { def: '0' },
  'kernel.pid_max': { def: '4194304' },
  'kernel.randomize_va_space': { def: '2' },
  'kernel.sysrq': { def: '16' },
  'kernel.yama.ptrace_scope': { def: '0' },
  'net.bridge.bridge-nf-call-ip6tables': { def: '1', module: 'br_netfilter' },
  'net.bridge.bridge-nf-call-iptables': { def: '1', module: 'br_netfilter' },
  'net.core.somaxconn': { def: '4096' },
  'net.ipv4.icmp_echo_ignore_all': { def: '0' },
  'net.ipv4.ip_forward': { def: '0' },
  'net.ipv4.ping_group_range': { def: '0\t2147483647' },
  'net.ipv4.tcp_keepalive_time': { def: '7200' },
  'net.ipv4.tcp_syncookies': { def: '1' },
  'net.ipv6.conf.all.disable_ipv6': { def: '0' },
  'net.ipv6.conf.all.forwarding': { def: '0' },
  'net.ipv6.conf.default.disable_ipv6': { def: '0' },
  'net.netfilter.nf_conntrack_max': { def: '65536', module: 'nf_conntrack' },
  'vm.dirty_ratio': { def: (s) => (tunedGuest(s) ? '30' : '20') },
  'vm.overcommit_memory': { def: '0' },
  'vm.swappiness': { def: (s) => (tunedGuest(s) ? '30' : '60') },
};

export const sysctlPath = (key: string) => '/proc/sys/' + key.replace(/\./g, '/');
const sysctlDefault = (key: string, state: SystemState | null) => {
  const d = SYSCTLS[key].def;
  return typeof d === 'function' ? d(state) : d;
};

/** Current value of a kernel tunable, or null if it does not exist right now. */
export function sysctlValue(state: SystemState, key: string): string | null {
  const n = nodeAt(state.root, sysctlPath(key));
  return n?.type === 'file' ? (n.content ?? '').replace(/\n$/, '') : null;
}

// ---------- file system helpers (system view, no permission checks) ----------

function normalize(path: string): string[] {
  const out: string[] = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out;
}

/** Find a node by absolute path, following symlinks, the way the kernel or systemd would. */
export function nodeAt(root: FsNode, path: string, depth = 0): FsNode | null {
  const parts = normalize(path);
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    if (node.type !== 'dir') return null;
    const child = node.children![parts[i]];
    if (!child) return null;
    if (child.type === 'link') {
      if (depth > 10) return null;
      const t = child.target!;
      const base = t.startsWith('/') ? t : '/' + [...parts.slice(0, i), t].join('/');
      return nodeAt(root, [base, ...parts.slice(i + 1)].join('/'), depth + 1);
    }
    node = child;
  }
  return node;
}

export const textAt = (root: FsNode, path: string): string | null => {
  const n = nodeAt(root, path);
  return n?.type === 'file' ? n.content ?? '' : null;
};

export function ensureDir(root: FsNode, path: string, mode = 0o755): FsNode {
  let node = root;
  const done: string[] = [];
  for (const p of normalize(path)) {
    let child = node.children![p];
    if (!child) {
      child = makeDir(0, 0, mode);
      node.children![p] = child;
    } else if (child.type === 'link') {
      child = nodeAt(root, '/' + [...done, p].join('/')) ?? child;
    }
    if (child.type !== 'dir') throw new Error(`${path}: Not a directory`);
    done.push(p);
    node = child;
  }
  return node;
}

/** Create or overwrite a file (keeping an existing node, as a real write would). */
export function putFile(root: FsNode, path: string, content: string, mode = 0o644): FsNode {
  const parts = normalize(path);
  const name = parts.pop()!;
  const dir = ensureDir(root, '/' + parts.join('/'));
  const cur = dir.children![name];
  if (cur?.type === 'file') {
    cur.content = content;
    cur.mtime = Date.now();
    return cur;
  }
  const f = makeFile(content, 0, 0, mode);
  dir.children![name] = f;
  return f;
}

export function removeAt(root: FsNode, path: string): boolean {
  const parts = normalize(path);
  const name = parts.pop();
  const dir = nodeAt(root, '/' + parts.join('/'));
  if (!name || dir?.type !== 'dir' || !dir.children![name]) return false;
  delete dir.children![name];
  return true;
}

export function listDir(root: FsNode, path: string): string[] {
  const n = nodeAt(root, path);
  return n?.type === 'dir' ? Object.keys(n.children!).sort() : [];
}

/** Text of every *.conf file in the given directories; a later directory overrides a same-named file. */
export function confFiles(root: FsNode, dirs: string[]): { path: string; text: string }[] {
  const byName = new Map<string, string>();
  for (const d of dirs) for (const f of listDir(root, d)) if (f.endsWith('.conf')) byName.set(f, `${d}/${f}`);
  return [...byName.keys()].sort().flatMap((f) => {
    const path = byName.get(f)!;
    const text = textAt(root, path);
    return text === null ? [] : [{ path, text }];
  });
}

// ---------- versions ----------

/** rpm-style version comparison, enough for kernel releases. */
export function verCmp(a: string, b: string): number {
  const sa = a.match(/\d+|[a-zA-Z]+/g) ?? [];
  const sb = b.match(/\d+|[a-zA-Z]+/g) ?? [];
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx !== ny) return nx ? 1 : -1;
    const c = nx ? Number(x) - Number(y) : x.localeCompare(y);
    if (c) return c < 0 ? -1 : 1;
  }
  return 0;
}

// ---------- BLS boot entries and GRUB ----------

export interface BootEntry {
  id: string; // file name without .conf
  file: string; // full path of the entry file
  title: string;
  version: string;
  linux: string; // relative to the /boot partition, e.g. /vmlinuz-6.12.0-55.el10.x86_64
  initrd: string;
  options: string;
  lines: [string, string][]; // every line in order, for writing it back
}

export function parseEntry(id: string, text: string): BootEntry {
  const lines: [string, string][] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^(\S+)\s*(.*)$/.exec(l)!;
    lines.push([m[1], m[2]]);
  }
  const get = (k: string) => lines.find(([key]) => key === k)?.[1] ?? '';
  return {
    id, file: `${ENTRIES_DIR}/${id}.conf`,
    title: get('title'), version: get('version'), linux: get('linux'), initrd: get('initrd'), options: get('options'), lines,
  };
}

export function formatEntry(e: BootEntry): string {
  const set: Record<string, string> = { title: e.title, version: e.version, linux: e.linux, initrd: e.initrd, options: e.options };
  const lines = e.lines.map(([k, v]): [string, string] => [k, k in set ? set[k] : v]);
  for (const k of Object.keys(set)) if (!lines.some(([key]) => key === k) && set[k]) lines.push([k, set[k]]);
  return lines.map(([k, v]) => `${k} ${v}`).join('\n') + '\n';
}

export function writeEntry(state: SystemState, e: BootEntry): void {
  putFile(state.root, e.file, formatEntry(e));
}

/** Boot entries in GRUB menu order: newest kernel first, rescue entries last. */
export function bootEntries(state: SystemState): BootEntry[] {
  return listDir(state.root, ENTRIES_DIR)
    .filter((f) => f.endsWith('.conf') && nodeAt(state.root, `${ENTRIES_DIR}/${f}`)?.type === 'file')
    .map((f) => parseEntry(f.slice(0, -5), textAt(state.root, `${ENTRIES_DIR}/${f}`) ?? ''))
    .sort((a, b) => verCmp(b.version || b.id, a.version || a.id));
}

export const isRescue = (e: BootEntry) => e.version.startsWith('0-rescue') || e.id.includes('-0-rescue');

/** The kernel release an entry boots. The rescue kernel is a copy of the installation kernel. */
export const entryRelease = (e: BootEntry) =>
  isRescue(e) ? RUNNING_KERNEL : e.version || e.linux.replace(/^.*\/vmlinuz-/, '');

export const splitArgs = (options: string) => options.split(/\s+/).filter(Boolean);
/** The arguments of an entry, without root= (what grubby shows as args=). */
export const entryArgs = (e: BootEntry) => splitArgs(e.options);
export const entryHasArg = (e: BootEntry, arg: string) =>
  entryArgs(e).some((a) => a === arg || (!arg.includes('=') && a.startsWith(arg + '=')));

/** Find an entry by GRUB's rules: a menu index, an id or a title. -1 if nothing matches. */
export function resolveEntry(entries: BootEntry[], spec: string): number {
  if (/^\d+$/.test(spec)) return Number(spec) < entries.length ? Number(spec) : -1;
  return entries.findIndex((e) => e.id === spec || e.title === spec);
}

export function readGrubenv(root: FsNode): Record<string, string> {
  const env: Record<string, string> = {};
  for (const l of (textAt(root, GRUBENV) ?? '').split('\n')) {
    const m = /^([A-Za-z_][\w]*)=(.*)$/.exec(l);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** grubenv is a fixed 1024-byte block padded with #. */
export function writeGrubenv(root: FsNode, env: Record<string, string>): void {
  let text = '# GRUB Environment Block\n# WARNING: Do not edit this file by tools other than grub-editenv!!!\n';
  for (const [k, v] of Object.entries(env)) text += `${k}=${v}\n`;
  putFile(root, GRUBENV, text + '#'.repeat(Math.max(0, 1024 - text.length)), 0o600);
}

/** The GRUB_DEFAULT that grub.cfg was generated with: "saved" or a menu index/id/title. */
export function grubCfgDefault(root: FsNode): string {
  const cfg = textAt(root, GRUB_CFG) ?? '';
  const sets = [...cfg.matchAll(/^\s*set default="([^"]*)"\s*$/gm)].map((m) => m[1]).filter((v) => v !== '${next_entry}');
  const last = sets[sets.length - 1] ?? '0';
  return last === '${saved_entry}' ? 'saved' : last;
}

/** The entry GRUB boots next time (ignoring a one-time next_entry). */
export function defaultBootIndex(state: SystemState): number {
  const entries = bootEntries(state);
  const def = grubCfgDefault(state.root);
  const spec = def === 'saved' ? readGrubenv(state.root).saved_entry ?? '0' : def;
  return Math.max(0, resolveEntry(entries, spec));
}

export function defaultBootEntry(state: SystemState): BootEntry | null {
  return bootEntries(state)[defaultBootIndex(state)] ?? null;
}

/** Read shell-style KEY=value settings such as /etc/default/grub. */
export function readSettings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split('\n')) {
    const m = /^\s*([A-Za-z_]\w*)=(.*)$/.exec(l);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function grubCfg(settings: Record<string, string>): string {
  const def = settings.GRUB_DEFAULT ?? 'saved';
  const timeout = settings.GRUB_TIMEOUT ?? '5';
  return [
    '#',
    '# DO NOT EDIT THIS FILE',
    '#',
    '# It is automatically generated by grub2-mkconfig using templates',
    '# from /etc/grub.d and settings from /etc/default/grub',
    '#',
    '',
    '### BEGIN /etc/grub.d/00_header ###',
    'set pager=1',
    '',
    'if [ -f ${config_directory}/grubenv ]; then',
    '  load_env -f ${config_directory}/grubenv',
    'elif [ -s $prefix/grubenv ]; then',
    '  load_env',
    'fi',
    'if [ "${next_entry}" ] ; then',
    '   set default="${next_entry}"',
    '   set next_entry=',
    '   save_env next_entry',
    '   set boot_once=true',
    'else',
    `   set default="${def === 'saved' ? '${saved_entry}' : def}"`,
    'fi',
    '',
    `terminal_output ${settings.GRUB_TERMINAL_OUTPUT ?? 'console'}`,
    'if [ x$feature_timeout_style = xy ] ; then',
    '  set timeout_style=menu',
    `  set timeout=${timeout}`,
    '# Fallback normal timeout code in case the timeout_style feature is',
    '# unavailable.',
    'else',
    `  set timeout=${timeout}`,
    'fi',
    '### END /etc/grub.d/00_header ###',
    '',
    '### BEGIN /etc/grub.d/10_linux ###',
    'insmod part_gpt',
    'insmod xfs',
    `search --no-floppy --fs-uuid --set=root ${BOOT_UUID}`,
    'insmod blscfg',
    'blscfg',
    '### END /etc/grub.d/10_linux ###',
    '',
    '### BEGIN /etc/grub.d/30_uefi-firmware ###',
    'if [ "$grub_platform" = "efi" ]; then',
    '\tfwsetup --is-supported',
    '\tif [ "$?" = 0 ]; then',
    "\t\tmenuentry 'UEFI Firmware Settings' $menuentry_id_option 'uefi-firmware' {",
    '\t\t\tfwsetup',
    '\t\t}',
    '\tfi',
    'fi',
    '### END /etc/grub.d/30_uefi-firmware ###',
    '',
  ].join('\n');
}

const DEFAULT_GRUB = `GRUB_TIMEOUT=5
GRUB_DISTRIBUTOR="$(sed 's, release .*$,,g' /etc/system-release)"
GRUB_DEFAULT=saved
GRUB_DISABLE_SUBMENU=true
GRUB_TERMINAL_OUTPUT="console"
GRUB_CMDLINE_LINUX="${DEFAULT_KERNEL_ARGS}"
GRUB_DISABLE_RECOVERY="true"
GRUB_ENABLE_BLSCFG=true
`;

const EFI_STUB = `search --no-floppy --fs-uuid --set=dev ${BOOT_UUID}
set prefix=($dev)/grub2

export $prefix
configfile $prefix/grub.cfg
`;

const SYSCONFIG_KERNEL = `# UPDATEDEFAULT specifies if kernel-install should make
# new kernels the default
UPDATEDEFAULT=yes

# DEFAULTKERNEL specifies the default kernel package type
DEFAULTKERNEL=kernel-core
`;

const DNF_CONF = `[main]
gpgcheck=1
installonly_limit=3
clean_requirements_on_remove=True
best=True
skip_if_unavailable=False
`;

const SYSCTL_CONF = `# sysctl settings are defined through files in
# /usr/lib/sysctl.d/, /run/sysctl.d/, and /etc/sysctl.d/.
#
# Vendors settings live in /usr/lib/sysctl.d/.
# To override a whole file, create a new file with the same in
# /etc/sysctl.d/ and put new settings there. To override
# only specific settings, add a file with a lexically later
# name in /etc/sysctl.d/ and put new settings there.
#
# For more information, see sysctl.conf(5) and sysctl.d(5).
`;

const SYSCTL_DEFAULT = `# This file is part of systemd.
# See sysctl.d(5) and core(5) for documentation.

# System Request functionality of the kernel (SYNC)
kernel.sysrq = 16

# Append the PID to the core filename
kernel.core_uses_pid = 1

# Enable hard and soft link protection
fs.protected_hardlinks = 1
fs.protected_symlinks = 1

# Allow all users to send ICMP echo (ping)
-net.ipv4.ping_group_range = 0 2147483647
`;

// ---------- kernel state ----------

export interface LoadedModule {
  params: Record<string, string>; // parameter values given when it was loaded
}

export type DmesgLevel = 'err' | 'warn' | 'notice' | 'info';

export interface DmesgLine {
  t: number; // seconds since boot
  level: DmesgLevel;
  msg: string;
}

export interface KernelState {
  installed: string[]; // kernel releases in install order, e.g. "6.12.0-55.el10.x86_64"
  installedAt: Record<string, number>; // release -> install time (ms), for rpm -q --last
  running: string; // release of the booted kernel (uname -r)
  cmdline: string; // /proc/cmdline of the current boot; kernel argument changes show here after a reboot
  loaded: Record<string, LoadedModule>; // loaded modules in load order
  bootTarget: string; // the systemd target the current boot reached
  emergency: boolean; // the current boot stopped in emergency mode
  bootErrors: string[]; // why it stopped (from bootStorage)
  boots: number; // reboots since the lab started
  bootTime: number; // ms timestamp of the current boot
  dmesg: DmesgLine[];
}

export const cmdlineFor = (linux: string, options: string) => `BOOT_IMAGE=${BOOT_DEVICE}${linux} ${options}`.trim();

/** The UUID of the root file system, from the storage simulation. */
export const rootFsUuid = (state: SystemState) => findDevice(state.storage, ROOT_DEVICE)?.holder.fs?.uuid ?? ROOT_FS_UUID;

/** The kernel ring buffer right after booting `release` with `cmdline`. */
export function bootLog(release: string, cmdline: string, rootUuid = ROOT_FS_UUID): DmesgLine[] {
  const l = (t: number, msg: string, level: DmesgLevel = 'info'): DmesgLine => ({ t, level, msg });
  return [
    l(0, linuxVersionLine(release), 'notice'),
    l(0, `Command line: ${cmdline}`),
    l(0, 'DMI: VMware, Inc. VMware20,1/440BX Desktop Reference Platform, BIOS VMW201.00V.24006586.B64.2406042154 06/04/2024'),
    l(0, 'Hypervisor detected: VMware'),
    l(0.043418, `Kernel command line: ${cmdline}`, 'notice'),
    l(0.512981, 'Memory: 3612344K/3931704K available (18432K kernel code, 5893K rwdata, 13212K rodata, 4580K init, 7432K bss, 319360K reserved, 0K cma-reserved)'),
    l(1.204117, 'nvme nvme0: 2/0/0 default/read/poll queues'),
    l(1.211342, ' nvme0n1: p1 p2 p3'),
    l(2.318645, 'SGI XFS with ACLs, security attributes, scrub, quota, no debug enabled', 'notice'),
    l(2.329873, `XFS (dm-0): Mounting V5 Filesystem ${rootUuid}`, 'notice'),
    l(2.371207, 'XFS (dm-0): Ending clean mount'),
    l(3.120554, 'systemd[1]: systemd 257-9.el10 running in system mode (+PAM +AUDIT +SELINUX -APPARMOR +IMA +SECCOMP +ACL +BLKID +KMOD +PWQUALITY +TPM2 +XZ +ZSTD)'),
    l(3.981236, 'vmxnet3 0000:0b:00.0 ens160: renamed from eth0'),
    l(4.402111, `XFS (nvme0n1p2): Mounting V5 Filesystem ${BOOT_UUID}`, 'notice'),
    l(4.437810, 'XFS (nvme0n1p2): Ending clean mount'),
  ];
}

export function initialKernel(): KernelState {
  const bootTime = Date.now() - UPTIME_MS;
  const cmdline = cmdlineFor(`/vmlinuz-${RUNNING_KERNEL}`, DEFAULT_OPTIONS);
  const loaded: Record<string, LoadedModule> = {};
  for (const n of BOOT_MODULES.flatMap(moduleDeps)) loaded[n] ??= { params: {} };
  return {
    installed: [RUNNING_KERNEL],
    installedAt: { [RUNNING_KERNEL]: bootTime - 86400000 },
    running: RUNNING_KERNEL,
    cmdline,
    loaded,
    bootTarget: 'multi-user.target',
    emergency: false,
    bootErrors: [],
    boots: 0,
    bootTime,
    dmesg: bootLog(RUNNING_KERNEL, cmdline),
  };
}

/** Add a line to the kernel ring buffer (dmesg). */
export function kernelLog(state: SystemState, msg: string, level: DmesgLevel = 'info'): void {
  const k = state.kernel;
  k.dmesg.push({ t: Math.max(0, (Date.now() - k.bootTime) / 1000), level, msg });
}

// ---------- kernel packages ----------

export const machineId = (root: FsNode) => (textAt(root, '/etc/machine-id') ?? MACHINE_ID).trim() || MACHINE_ID;

function writeKernelFiles(root: FsNode, release: string): void {
  const marker = (what: string) => `(${what} for Linux ${release})\n`;
  putFile(root, `/boot/vmlinuz-${release}`, marker('Linux kernel x86 boot executable bzImage'), 0o755);
  putFile(root, `/boot/.vmlinuz-${release}.hmac`, `a1b2c3d4e5f60718293a4b5c6d7e8f90  vmlinuz-${release}\n`);
  putFile(root, `/boot/initramfs-${release}.img`, marker('initramfs (made by dracut)'), 0o600);
  putFile(root, `/boot/System.map-${release}`, marker('kernel symbol table'));
  putFile(root, `/boot/config-${release}`, `# Linux/x86_64 ${release.split('-')[0]} Kernel Configuration\nCONFIG_XFS_FS=m\nCONFIG_EXT4_FS=m\nCONFIG_BLK_DEV_LOOP=m\n`);
  const dir = `/usr/lib/modules/${release}`;
  putFile(root, `${dir}/vmlinuz`, marker('Linux kernel x86 boot executable bzImage'), 0o755);
  let dep = '';
  for (const [name, m] of Object.entries(MODULES)) {
    putFile(root, `${dir}/${m.path}`, `(kernel module ${name})\n`);
    dep += `${m.path}:${m.depends.map((d) => ' ' + MODULES[d].path).join('')}\n`;
  }
  putFile(root, `${dir}/modules.dep`, dep);
}

function newEntry(root: FsNode, release: string, options: string): BootEntry {
  const id = `${machineId(root)}-${release}`;
  return parseEntry(
    id,
    `title ${OS_TITLE} (${release}) ${OS_VERSION}\nversion ${release}\nlinux /vmlinuz-${release}\ninitrd /initramfs-${release}.img\noptions ${options}\ngrub_users $grub_users\ngrub_arg --unrestricted\ngrub_class rhel\n`,
  );
}

/**
 * Install a kernel package next to the others, the way kernel-install does: files in /boot and
 * /usr/lib/modules, a BLS entry that copies the default entry's arguments, and (with
 * UPDATEDEFAULT=yes in /etc/sysconfig/kernel) make it the default. Also usable in lab setup.
 */
export function installKernel(state: SystemState, release: string): void {
  const k = state.kernel;
  const def = defaultBootEntry(state);
  writeKernelFiles(state.root, release);
  const entry = newEntry(state.root, release, def?.options || DEFAULT_OPTIONS);
  writeEntry(state, entry);
  if (!k.installed.includes(release)) k.installed = [...k.installed, release].sort(verCmp);
  k.installedAt[release] = Date.now();
  const sys = readSettings(textAt(state.root, '/etc/sysconfig/kernel') ?? '');
  if ((sys.UPDATEDEFAULT ?? 'yes') === 'yes') {
    const env = readGrubenv(state.root);
    env.saved_entry = entry.id;
    writeGrubenv(state.root, env);
  }
}

/** Remove a kernel package: its /boot files, modules and boot entry. */
export function removeKernel(state: SystemState, release: string): void {
  const r = state.root;
  for (const f of [`vmlinuz-${release}`, `.vmlinuz-${release}.hmac`, `initramfs-${release}.img`, `System.map-${release}`, `config-${release}`]) {
    removeAt(r, `/boot/${f}`);
  }
  removeAt(r, `/usr/lib/modules/${release}`);
  for (const e of bootEntries(state)) if (!isRescue(e) && entryRelease(e) === release) removeAt(r, e.file);
  state.kernel.installed = state.kernel.installed.filter((x) => x !== release);
  delete state.kernel.installedAt[release];
}

export function installonlyLimit(state: SystemState): number {
  const m = /^\s*installonly_limit\s*=\s*(\d+)/m.exec(textAt(state.root, '/etc/dnf/dnf.conf') ?? '');
  return m ? Number(m[1]) : 3;
}

// ---------- modules ----------

export interface ModprobeConfig {
  options: Record<string, Record<string, string>>;
  blacklist: Set<string>;
  install: Record<string, string>;
  text: string; // all directives, for modprobe -c
}

/** Parse "k=v k2=v2" module parameters. */
export function parseParams(words: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const w of words) {
    const i = w.indexOf('=');
    if (i < 0) out[w] = '';
    else out[w.slice(0, i)] = w.slice(i + 1).replace(/^"(.*)"$/, '$1');
  }
  return out;
}

/** Everything in /usr/lib/modprobe.d and /etc/modprobe.d (*.conf). */
export function modprobeConfig(root: FsNode): ModprobeConfig {
  const cfg: ModprobeConfig = { options: {}, blacklist: new Set(), install: {}, text: '' };
  for (const { text } of confFiles(root, ['/usr/lib/modprobe.d', '/etc/modprobe.d'])) {
    for (const raw of text.split('\n')) {
      const words = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
      if (words.length < 2) continue;
      const [cmd, name, ...rest] = words;
      const m = normalizeModule(name);
      if (cmd === 'options') cfg.options[m] = { ...cfg.options[m], ...parseParams(rest) };
      else if (cmd === 'blacklist') cfg.blacklist.add(m);
      else if (cmd === 'install' && rest.length) cfg.install[m] = rest.join(' ');
      else continue;
      cfg.text += words.join(' ') + '\n';
    }
  }
  return cfg;
}

/** Module parameters given on the kernel command line as module.param=value. */
export function cmdlineParams(state: SystemState, name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of splitArgs(state.kernel.cmdline)) {
    const m = /^([\w-]+)\.([\w-]+)(?:=(.*))?$/.exec(a);
    if (m && normalizeModule(m[1]) === name) out[m[2]] = m[3] ?? '';
  }
  return out;
}

/** Modules the kernel command line forbids (module_blacklist= stops even an explicit modprobe). */
export function cmdlineBlacklist(state: SystemState): { hard: string[]; soft: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  for (const a of splitArgs(state.kernel.cmdline)) {
    const m = /^(module_blacklist|modprobe\.blacklist|rd\.driver\.blacklist)=(.*)$/.exec(a);
    if (m) (m[1] === 'module_blacklist' ? hard : soft).push(...m[2].split(',').filter(Boolean).map(normalizeModule));
  }
  return { hard, soft };
}

export const isLoaded = (state: SystemState, name: string) => normalizeModule(name) in state.kernel.loaded;

/** Value of a parameter of a loaded module as /sys/module/NAME/parameters/PARAM shows it. */
export function moduleParam(state: SystemState, name: string, param: string): string | null {
  const n = normalizeModule(name);
  if (!isLoaded(state, n)) return null;
  const p = MODULES[n]?.params.find((x) => x.name === param);
  return p ? state.kernel.loaded[n].params[param] ?? p.def : null;
}

/** Loaded modules that depend on this one (lsmod's "Used by" names). */
export const holdersOf = (state: SystemState, name: string) =>
  Object.keys(state.kernel.loaded).filter((m) => MODULES[m]?.depends.includes(name));

const FALLBACK_FS = ['xfs', 'xfs', 'vfat']; // what the stock /etc/fstab mounts

/** File system types of the current mounts (from the storage simulation's /proc/mounts). */
export function mountedFsTypes(state: SystemState): string[] {
  let text: string | null = null;
  try {
    const gen = STORAGE_FILES['/proc/mounts'] ?? STORAGE_FILES['/proc/self/mounts'];
    text = gen ? gen(state) : textAt(state.root, '/proc/mounts');
  } catch {
    text = null;
  }
  if (!text) return FALLBACK_FS;
  return text.split('\n').map((l) => l.trim().split(/\s+/)[2]).filter((t): t is string => !!t);
}

/** lsmod's "Used by" count: other modules, devices and mounted file systems. */
export function moduleUsers(state: SystemState, name: string): number {
  const def = MODULES[name];
  const mounts = def?.fsTypes ? mountedFsTypes(state).filter((t) => def.fsTypes!.includes(t)).length : 0;
  return holdersOf(state, name).length + (def?.refs ?? 0) + mounts;
}

const BOOL_TRUE = ['1', 'y', 'Y', 'yes', 'on', ''];
const BOOL_FALSE = ['0', 'n', 'N', 'no', 'off'];

/** Check a parameter value the way the kernel parses it; null if invalid. */
export function checkParam(p: ModuleParam, v: string): string | null {
  switch (p.type) {
    case 'bool':
      return BOOL_TRUE.includes(v) ? 'Y' : BOOL_FALSE.includes(v) ? 'N' : null;
    case 'int':
      return /^-?\d+$/.test(v) ? String(Number(v)) : null;
    case 'uint':
    case 'ushort':
      return /^\d+$/.test(v) ? String(Number(v)) : null;
    case 'array of int':
      return /^-?\d+(,-?\d+)*$/.test(v) ? v : null;
    default:
      return v;
  }
}

/**
 * Insert one module (its dependencies must already be loaded). Unknown parameters are ignored
 * with a warning, like the real kernel; an invalid value fails with "Invalid argument".
 */
export function insertModule(state: SystemState, name: string, given: Record<string, string>): string | null {
  const def = MODULES[name];
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(given)) {
    const p = def.params.find((x) => x.name === k);
    if (!p) {
      kernelLog(state, `${name}: unknown parameter '${k}' ignored`, 'warn');
      continue;
    }
    const norm = checkParam(p, v);
    if (norm === null) {
      kernelLog(state, `${name}: \`${v}' invalid for parameter \`${k}'`, 'err');
      return 'Invalid argument';
    }
    values[k] = norm;
  }
  state.kernel.loaded[name] = { params: values };
  writeModuleSysfs(state.root, name, values);
  for (const [key, s] of Object.entries(SYSCTLS)) {
    if (s.module === name) putFile(state.root, sysctlPath(key), sysctlDefault(key, state) + '\n');
  }
  for (const msg of def.messages ?? []) kernelLog(state, msg);
  return null;
}

function writeModuleSysfs(root: FsNode, name: string, values: Record<string, string>): void {
  const dir = ensureDir(root, `/sys/module/${name}`);
  if (!MODULES[name].params.length) return;
  dir.children!.parameters = makeDir();
  for (const p of MODULES[name].params) dir.children!.parameters.children![p.name] = makeFile((values[p.name] ?? p.def) + '\n', 0, 0, 0o644);
}

export function removeModule(state: SystemState, name: string): void {
  delete state.kernel.loaded[name];
  removeAt(state.root, `/sys/module/${name}`);
  for (const [key, s] of Object.entries(SYSCTLS)) if (s.module === name) removeAt(state.root, sysctlPath(key));
}

const FS_MODULE: Record<string, string> = Object.fromEntries(
  Object.entries(MODULES).flatMap(([n, m]) => (m.fsTypes ?? []).map((t) => [t, n])),
);

/** Mounting a file system makes the kernel load its module; catch up with the current mounts. */
export function syncMountModules(state: SystemState): void {
  for (const t of mountedFsTypes(state)) {
    const m = FS_MODULE[t];
    if (!m) continue;
    for (const d of moduleDeps(m)) if (!isLoaded(state, d)) insertModule(state, d, {});
  }
}

/**
 * Mounting a file system type whose driver is not loaded makes the kernel call
 * request_module("fs-TYPE"), which runs modprobe on that alias. A blacklist line, an install
 * command such as "install ext4 /bin/false" or a blacklist kernel argument stops it, and the
 * mount then fails with "unknown filesystem type". Returns false in that case, true when the
 * type can be mounted (its module was already loaded, loads now, or it needs none).
 */
export function loadFsModule(state: SystemState, fsType: string): boolean {
  const m = FS_MODULE[fsType];
  if (!m || isLoaded(state, m)) return true;
  const cfg = modprobeConfig(state.root);
  if (autoloadBlocked(state, m, cfg)) return false;
  const dir = `/usr/lib/modules/${state.kernel.running}`;
  for (const d of moduleDeps(m)) {
    if (isLoaded(state, d)) continue;
    if (nodeAt(state.root, `${dir}/${MODULES[d].path}`)?.type !== 'file') return false;
    if (insertModule(state, d, { ...cfg.options[d], ...cmdlineParams(state, d) })) return false;
  }
  return true;
}

/** Is `name` kept from loading automatically (blacklist line, install /bin/false, kernel argument)? */
export function autoloadBlocked(state: SystemState, name: string, cfg = modprobeConfig(state.root)): boolean {
  const cl = cmdlineBlacklist(state);
  const inst = cfg.install[name];
  return cfg.blacklist.has(name) || cl.hard.includes(name) || cl.soft.includes(name) || (!!inst && /(^|\/)(false|true)(\s|$)/.test(inst));
}

/** Modules listed in /etc/modules-load.d (and /usr/lib/modules-load.d) to load at boot. */
export function modulesLoadD(root: FsNode): string[] {
  const out: string[] = [];
  for (const { text } of confFiles(root, ['/usr/lib/modules-load.d', '/etc/modules-load.d'])) {
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (l && !l.startsWith('#') && !l.startsWith(';')) out.push(normalizeModule(l.split(/\s+/)[0]));
    }
  }
  return out;
}

// ---------- sysctl files ----------

/** Set a tunable as root would. Returns an errno name on failure. */
export function writeSysctl(state: SystemState, key: string, value: string): 'ENOENT' | 'EINVAL' | 'EACCES' | null {
  const k = key.replace(/\//g, '.');
  const n = nodeAt(state.root, sysctlPath(k));
  if (n?.type !== 'file') return 'ENOENT';
  if (SYSCTLS[k]?.readonly) return 'EACCES';
  const v = value.trim().split(/\s+/).join('\t');
  const def = SYSCTLS[k] ? sysctlDefault(k, state) : '';
  if (/^-?\d+(\t-?\d+)*$/.test(def) && !/^-?\d+(\t-?\d+)*$/.test(v)) return 'EINVAL';
  n.content = v + '\n';
  n.mtime = Date.now();
  return null;
}

/** "key = value" lines of a sysctl.conf-style file. A leading - means "ignore if missing". */
export function parseSysctlFile(text: string): { key: string; value: string; optional: boolean }[] {
  const out: { key: string; value: string; optional: boolean }[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const i = l.indexOf('=');
    if (i < 0) continue;
    const optional = l.startsWith('-');
    out.push({ key: l.slice(optional ? 1 : 0, i).trim().replace(/\//g, '.'), value: l.slice(i + 1).trim(), optional });
  }
  return out;
}

/** The files systemd-sysctl and "sysctl --system" read, in order. */
export const sysctlDFiles = (root: FsNode) => confFiles(root, ['/usr/lib/sysctl.d', '/run/sysctl.d', '/etc/sysctl.d']);

/** Put every tunable back to its kernel default, as at power on. */
export function resetSysctls(state: SystemState): void {
  for (const key of Object.keys(SYSCTLS)) {
    const s = SYSCTLS[key];
    if (s.module && !isLoaded(state, s.module)) removeAt(state.root, sysctlPath(key));
    else putFile(state.root, sysctlPath(key), sysctlDefault(key, state) + '\n', s.readonly ? 0o444 : 0o644);
  }
}

// ---------- the fresh file system ----------

/** Add kernel and boot files (/etc/default/grub, /boot/loader/entries, ...) to a fresh root file system. */
export function addKernelFiles(root: FsNode): void {
  const c = root.children!;
  if (!nodeAt(root, '/etc/machine-id')) putFile(root, '/etc/machine-id', MACHINE_ID + '\n', 0o444);
  ensureDir(root, '/usr/lib');
  c.lib ??= makeLink('usr/lib');

  putFile(root, '/etc/default/grub', DEFAULT_GRUB);
  putFile(root, '/etc/sysconfig/kernel', SYSCONFIG_KERNEL);
  if (!nodeAt(root, '/etc/dnf/dnf.conf')) putFile(root, '/etc/dnf/dnf.conf', DNF_CONF);
  for (const d of ['/etc/modprobe.d', '/etc/modules-load.d', '/usr/lib/modprobe.d', '/usr/lib/modules-load.d', '/etc/sysctl.d', '/usr/lib/sysctl.d']) ensureDir(root, d);
  if (!nodeAt(root, '/etc/sysctl.conf')) putFile(root, '/etc/sysctl.conf', SYSCTL_CONF);
  nodeAt(root, '/etc/sysctl.d')!.children!['99-sysctl.conf'] ??= makeLink('../sysctl.conf');
  putFile(root, '/usr/lib/sysctl.d/10-default-yama-scope.conf', '# When yama is enabled in the kernel it might be used to filter any user\n# space access which requires PTRACE_MODE_ATTACH like ptrace attach, access\n# to /proc/PID/{mem,personality,stack,syscall}, and the syscalls\n# process_vm_readv and process_vm_writev which are used for interprocess\n# services, communication and introspection (like synchronisation, signaling,\n# debugging, tracing and profiling) of processes.\n\nkernel.yama.ptrace_scope = 0\n');
  putFile(root, '/usr/lib/sysctl.d/50-default.conf', SYSCTL_DEFAULT);
  putFile(root, '/usr/lib/sysctl.d/50-pid-max.conf', '# Bump the numeric PID range to its maximum of 2^22 (from the in-kernel default\n# of 2^16), to make PID collisions less likely.\nkernel.pid_max = 4194304\n');

  // boot loader
  ensureDir(root, '/boot/grub2', 0o700);
  ensureDir(root, '/boot/loader/entries');
  ensureDir(root, '/boot/efi/EFI/redhat', 0o700);
  putFile(root, EFI_GRUB_CFG, EFI_STUB, 0o700);
  putFile(root, '/boot/efi/EFI/redhat/shimx64.efi', '(shim boot loader)\n', 0o700);
  putFile(root, '/boot/efi/EFI/redhat/grubx64.efi', '(GRUB 2 EFI boot loader)\n', 0o700);
  putFile(root, GRUB_CFG, grubCfg(readSettings(DEFAULT_GRUB)), 0o600);
  writeKernelFiles(root, RUNNING_KERNEL);
  const id = machineId(root);
  const entry = newEntry(root, RUNNING_KERNEL, DEFAULT_OPTIONS);
  putFile(root, entry.file, formatEntry(entry));
  const rescue = `0-rescue-${id}`;
  putFile(root, `/boot/vmlinuz-${rescue}`, `(Linux kernel x86 boot executable bzImage for Linux ${RUNNING_KERNEL})\n`, 0o755);
  putFile(root, `/boot/initramfs-${rescue}.img`, '(rescue initramfs with every driver, made by dracut)\n', 0o600);
  const re = parseEntry(
    `${id}-0-rescue`,
    `title ${OS_TITLE} (${rescue}) ${OS_VERSION}\nversion ${rescue}\nlinux /vmlinuz-${rescue}\ninitrd /initramfs-${rescue}.img\noptions ${DEFAULT_OPTIONS}\ngrub_users $grub_users\ngrub_arg --unrestricted\ngrub_class rhel\n`,
  );
  putFile(root, re.file, formatEntry(re));
  writeGrubenv(root, { saved_entry: entry.id, menu_auto_hide: '1', boot_success: '0', boot_indeterminate: '0' });

  // what the running kernel shows
  for (const f of ['cmdline', 'modules', 'version']) putFile(root, `/proc/${f}`, '', 0o444);
  for (const key of Object.keys(SYSCTLS)) {
    const s = SYSCTLS[key];
    if (s.module && !BOOT_MODULES.flatMap(moduleDeps).includes(s.module)) continue;
    putFile(root, sysctlPath(key), sysctlDefault(key, null) + '\n', s.readonly ? 0o444 : 0o644);
  }
  for (const n of new Set(BOOT_MODULES.flatMap(moduleDeps))) writeModuleSysfs(root, n, {});
}

/** Make `name` in `dir` a directory (an empty one if `fresh`), replacing whatever else is there. */
function forceDir(dir: FsNode, name: string, mode: number, fresh = false): FsNode {
  const cur = dir.children![name];
  if (cur?.type === 'dir' && !fresh) return cur;
  return (dir.children![name] = makeDir(0, 0, mode));
}

/**
 * A boot mounts a new procfs and sysfs: whatever was deleted or put there before the reboot is
 * gone, and /proc/cmdline, /proc/modules and /proc/version are back. The tunables in /proc/sys and
 * the modules in /sys/module are filled in again by the boot (resetSysctls, insertModule).
 */
export function resetKernelFs(root: FsNode): void {
  const proc = forceDir(root, 'proc', 0o555);
  for (const f of ['cmdline', 'modules', 'version']) proc.children![f] = makeFile('', 0, 0, 0o444);
  forceDir(proc, 'sys', 0o755, true);
  forceDir(forceDir(root, 'sys', 0o555), 'module', 0o755, true);
  // the files the storage simulation fills in (/proc/mounts, /proc/swaps, ...) are back too
  for (const p of Object.keys(STORAGE_FILES)) {
    if (!p.startsWith('/proc/') || nodeAt(root, p)) continue;
    try {
      putFile(root, p, '', 0o444);
    } catch {
      // something that is not a directory is in the way; the file stays missing
    }
  }
}

/** /proc/modules: name size refcount holders state address, newest first. */
function procModules(state: SystemState): string {
  syncMountModules(state);
  return Object.keys(state.kernel.loaded)
    .reverse()
    .map((n) => {
      const h = holdersOf(state, n);
      return `${n} ${MODULES[n]?.size ?? 16384} ${moduleUsers(state, n)} ${h.length ? h.join(',') + ',' : '-'} Live 0x0000000000000000`;
    })
    .join('\n') + '\n';
}

/** Files whose content is generated from the kernel state, e.g. /proc/cmdline. */
export const KERNEL_FILES: Record<string, (state: SystemState) => string> = {
  '/proc/cmdline': (s) => s.kernel.cmdline + '\n',
  '/proc/modules': procModules,
  '/proc/version': (s) => linuxVersionLine(s.kernel.running) + '\n',
};

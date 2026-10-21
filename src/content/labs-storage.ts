import type { Shell } from '@/shell/shell';
import { GiB, MiB, findDevice, fsOn, fstabCheck, fstabFor, lvExtents, lvOf, lvSize, mountedAt, swapActive, vgByName } from '@/shell/storage-state';
import { Lab, peek } from './types';

// Labs that use the simulated disks, LVM, mounts and swap.
// Every lab starts on a fresh server1: nvme0n2 (10 GiB) and nvme0n3 (5 GiB) are empty.

const diskOf = (sh: Shell, name: string) => sh.state.storage.disks.find((d) => d.name === name);
/** Size in bytes of a block device such as /dev/nvme0n2p1 (0 if it does not exist). */
const sizeOf = (sh: Shell, path: string) => findDevice(sh.state.storage, path)?.size ?? 0;
const isDir = (sh: Shell, path: string) => peek(sh, path)?.type === 'dir';
/** True if one of the commands typed (a line split at ;, &&, || and |) matches `re`. */
const typed = (sh: Shell, re: RegExp) => sh.history.some((h) => h.split(/&&|\|\||[;|]/).some((c) => re.test(c.trim())));
/** The fstab line for a mount point refers to `dev`, has this type and would mount cleanly. */
function fstabOk(sh: Shell, target: string, dev: string, type: string, spec?: 'UUID=' | 'LABEL=') {
  const c = fstabFor(sh.state, target);
  return !!c && c.dev?.path === dev && c.entry.type === type && c.error === null && (!spec || c.entry.spec.startsWith(spec));
}
const mountedFrom = (sh: Shell, target: string, dev: string) => mountedAt(sh.state, target)?.source === dev;
/** The server has been rebooted at least once and did not stop in emergency mode. */
const rebootedCleanly = (sh: Shell) => sh.state.kernel.boots > 0 && !sh.state.kernel.emergency;

/** R14-swap: partition 1 still holds the data file system, mounted on /data with its file. */
function dataSafe(sh: Shell) {
  return (
    fsOn(sh.state, '/dev/nvme0n2p1')?.label === 'data' &&
    mountedFrom(sh, '/data', '/dev/nvme0n2p1') &&
    peek(sh, '/data/keep.txt')?.content === 'Do not lose me.\n'
  );
}

/** R15-lvm-grow: lvapp is still mounted on /app and its file is still there. */
function appSafe(sh: Shell) {
  return mountedFrom(sh, '/app', '/dev/mapper/vgapp-lvapp') && peek(sh, '/app/version.txt')?.content === 'version 1\n';
}

/** Run lab setup commands as the student would type them, then forget them. */
function prepare(sh: Shell, lines: string[]) {
  for (const l of lines) sh.run(l);
  sh.history.length = 0;
}

export const F11_STORAGE_LABS: Lab[] = [
  {
    id: 'F11-first-fs',
    title: 'Your first file system',
    intro:
      'The disk /dev/nvme0n2 is empty. Turn it into storage you can use: a partition table, one partition, an XFS file system mounted on /data, and a line in /etc/fstab so it is mounted again at every boot. Disk commands need root, so start them with sudo.',
    tasks: [
      {
        text: 'Give /dev/nvme0n2 a GPT partition table.',
        hint: 'sudo parted -s /dev/nvme0n2 mklabel gpt  (-s means parted does not ask questions)',
        check: (sh) => diskOf(sh, 'nvme0n2')?.table === 'gpt',
      },
      {
        text: 'Create one partition of exactly 2 GiB named data. Start it at 1MiB, so it ends at 2049MiB.',
        hint: 'sudo parted -s /dev/nvme0n2 mkpart data xfs 1MiB 2049MiB  (the word xfs only sets the partition type, it does not create a file system)',
        check: (sh) => sizeOf(sh, '/dev/nvme0n2p1') === 2 * GiB,
      },
      {
        text: 'Create an XFS file system on the new partition, /dev/nvme0n2p1.',
        hint: 'sudo mkfs.xfs /dev/nvme0n2p1',
        check: (sh) => fsOn(sh.state, '/dev/nvme0n2p1')?.type === 'xfs',
      },
      {
        text: 'Create the directory /data and mount the new file system on it.',
        hint: 'sudo mkdir /data && sudo mount /dev/nvme0n2p1 /data',
        check: (sh) => mountedFrom(sh, '/data', '/dev/nvme0n2p1'),
      },
      {
        text: 'Show the size and free space of /data in human-readable units.',
        hint: 'df -h /data',
        check: (sh) => typed(sh, /^(sudo\s+)?df\b.*\s-\w*h/),
      },
      {
        text: 'Show nvme0n2 and its partition as a tree, with the file system type and UUID.',
        hint: 'lsblk -f /dev/nvme0n2',
        check: (sh) => typed(sh, /^(sudo\s+)?lsblk\b.*\s(-\w*f|--fs)\b/),
      },
      {
        text: 'Make the mount permanent: add a line to /etc/fstab that mounts the file system by its UUID on /data, as xfs with default options.',
        hint: 'echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme0n2p1) /data xfs defaults 0 0" | sudo tee -a /etc/fstab  (sudo blkid /dev/nvme0n2p1 shows the UUID if you want to type it yourself)',
        check: (sh) => fstabOk(sh, '/data', '/dev/nvme0n2p1', 'xfs', 'UUID='),
      },
      {
        text: 'Test the new line: unmount /data, tell systemd that /etc/fstab changed, and mount everything listed in /etc/fstab.',
        hint: 'sudo umount /data && sudo systemctl daemon-reload && sudo mount -a',
        check: (sh) =>
          mountedFrom(sh, '/data', '/dev/nvme0n2p1') &&
          typed(sh, /^(sudo\s+)?umount\s+(\/data|\/dev\/nvme0n2p1)\/?$/) &&
          typed(sh, /^(sudo\s+)?mount\s+(-\w+\s+)*(-\w*a|--all\b)/),
      },
    ],
  },
];

export const R14_LABS: Lab[] = [
  {
    id: 'R14-label-uuid',
    title: 'Mount by label and by UUID',
    intro:
      'Exam task: on /dev/nvme0n2, create a 1 GiB XFS file system with the label archive that is mounted on /archive at boot by its label, and a 512 MiB ext4 file system that is mounted on /reports at boot by its UUID. Then add a 256 MiB VFAT file system with the label USB and mount it by hand.',
    tasks: [
      {
        text: 'Create a GPT partition table on /dev/nvme0n2 with partition 1 of exactly 1 GiB and partition 2 of exactly 512 MiB. Start at 1MiB and leave no gap between them.',
        hint: 'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart archive xfs 1MiB 1025MiB mkpart reports ext4 1025MiB 1537MiB',
        check: (sh) =>
          diskOf(sh, 'nvme0n2')?.table === 'gpt' && sizeOf(sh, '/dev/nvme0n2p1') === GiB && sizeOf(sh, '/dev/nvme0n2p2') === 512 * MiB,
      },
      {
        text: 'Format partition 1 as XFS with the label archive, and partition 2 as ext4.',
        hint: 'sudo mkfs.xfs -L archive /dev/nvme0n2p1 && sudo mkfs.ext4 /dev/nvme0n2p2',
        check: (sh) => {
          const xfs = fsOn(sh.state, '/dev/nvme0n2p1');
          return xfs?.type === 'xfs' && xfs.label === 'archive' && fsOn(sh.state, '/dev/nvme0n2p2')?.type === 'ext4';
        },
      },
      {
        text: 'Create the mount points /archive and /reports.',
        hint: 'sudo mkdir /archive /reports',
        check: (sh) => isDir(sh, '/archive') && isDir(sh, '/reports'),
      },
      {
        text: 'Add a line to /etc/fstab that mounts LABEL=archive on /archive as xfs with default options.',
        hint: 'echo "LABEL=archive /archive xfs defaults 0 0" | sudo tee -a /etc/fstab',
        check: (sh) => fstabOk(sh, '/archive', '/dev/nvme0n2p1', 'xfs', 'LABEL='),
      },
      {
        text: 'Add a line to /etc/fstab that mounts partition 2 on /reports by its UUID, as ext4 with default options.',
        hint: 'echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme0n2p2) /reports ext4 defaults 0 0" | sudo tee -a /etc/fstab  (sudo blkid /dev/nvme0n2p2 shows the UUID)',
        check: (sh) => fstabOk(sh, '/reports', '/dev/nvme0n2p2', 'ext4', 'UUID='),
      },
      {
        text: 'Check /etc/fstab for mistakes before you rely on it.',
        hint: 'sudo findmnt --verify',
        check: (sh) => typed(sh, /^(sudo\s+)?findmnt\b.*\s--verify\b/),
      },
      {
        text: 'Tell systemd that /etc/fstab changed, then mount everything listed in it.',
        hint: 'sudo systemctl daemon-reload && sudo mount -a',
        check: (sh) => mountedFrom(sh, '/archive', '/dev/nvme0n2p1') && mountedFrom(sh, '/reports', '/dev/nvme0n2p2'),
      },
      {
        text: 'Add partition 3 of exactly 256 MiB right after partition 2, and format it as VFAT with the label USB.',
        hint: 'sudo parted -s /dev/nvme0n2 mkpart usb fat32 1537MiB 1793MiB && sudo mkfs.vfat -n USB /dev/nvme0n2p3  (mkfs.vfat sets the label with -n, not -L)',
        check: (sh) => {
          const fat = fsOn(sh.state, '/dev/nvme0n2p3');
          return sizeOf(sh, '/dev/nvme0n2p3') === 256 * MiB && fat?.type === 'vfat' && fat.label === 'USB';
        },
      },
      {
        text: 'Create /mnt/usb and mount the USB file system on it by its label. This one is only for now, so it needs no fstab line.',
        hint: 'sudo mkdir /mnt/usb && sudo mount LABEL=USB /mnt/usb',
        check: (sh) => mountedFrom(sh, '/mnt/usb', '/dev/nvme0n2p3'),
      },
    ],
  },
  {
    id: 'R14-swap',
    title: 'Add swap safely',
    intro:
      'server1 needs 512 MiB more swap. Partition 1 of /dev/nvme0n2 holds important files on /data, so put the swap in the free space after it and do not touch partition 1. The new swap must be active now and after a reboot, next to the swap that is already there.',
    setup: (sh) =>
      prepare(sh, [
        'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart data xfs 1MiB 1025MiB',
        'sudo mkfs.xfs -L data /dev/nvme0n2p1',
        'sudo mkdir /data',
        "echo 'LABEL=data /data xfs defaults 0 0' | sudo tee -a /etc/fstab",
        'sudo systemctl daemon-reload',
        'sudo mount -a',
        "echo 'Do not lose me.' | sudo tee /data/keep.txt",
      ]),
    tasks: [
      {
        text: 'Find out where the free space on /dev/nvme0n2 starts.',
        hint: 'sudo parted /dev/nvme0n2 print free  (lsblk /dev/nvme0n2 also shows what is there)',
        check: (sh) => typed(sh, /^(sudo\s+)?(parted\b.*\bprint|lsblk\b|fdisk\s+-l\b)/),
      },
      {
        text: 'Create partition 2 of exactly 512 MiB right after partition 1, with the name swap and the type linux-swap.',
        hint: 'sudo parted -s /dev/nvme0n2 mkpart swap linux-swap 1025MiB 1537MiB',
        check: (sh) => sizeOf(sh, '/dev/nvme0n2p2') === 512 * MiB && dataSafe(sh),
      },
      {
        text: 'Write a swap signature on /dev/nvme0n2p2.',
        hint: 'sudo mkswap /dev/nvme0n2p2',
        check: (sh) => fsOn(sh.state, '/dev/nvme0n2p2')?.type === 'swap' && dataSafe(sh),
      },
      {
        text: 'Add a line to /etc/fstab that turns on the new swap at boot, by its UUID.',
        hint: 'echo "UUID=$(sudo blkid -s UUID -o value /dev/nvme0n2p2) none swap defaults 0 0" | sudo tee -a /etc/fstab',
        check: (sh) =>
          fstabCheck(sh.state).some(
            (c) => c.entry.type === 'swap' && c.entry.spec.startsWith('UUID=') && c.dev?.path === '/dev/nvme0n2p2' && c.error === null,
          ) && dataSafe(sh),
      },
      {
        text: 'Turn on all swap listed in /etc/fstab. This also tests your new line.',
        hint: 'sudo swapon -a',
        check: (sh) => swapActive(sh.state, '/dev/nvme0n2p2') && swapActive(sh.state, '/dev/mapper/rhel-swap') && dataSafe(sh),
      },
      {
        text: 'Check that both swap areas are in use and that the total swap is now 2.5 GiB.',
        hint: 'swapon --show && free -h',
        check: (sh) => typed(sh, /^(sudo\s+)?swapon\s+(--show|-s|--summary)\b/) && typed(sh, /^(sudo\s+)?free\b/),
      },
      {
        text: 'Reboot server1. The new swap and /data must come back on their own.',
        hint: 'sudo reboot  (then run swapon --show again)',
        check: (sh) => rebootedCleanly(sh) && swapActive(sh.state, '/dev/nvme0n2p2') && dataSafe(sh),
      },
    ],
  },
];

export const R15_LABS: Lab[] = [
  {
    id: 'R15-lvm-build',
    title: 'Build LVM storage',
    intro:
      'Exam task: on a new 2 GiB partition of /dev/nvme0n2, create a volume group named vgdata with 16 MiB physical extents. In it, create a logical volume named lvdata of exactly 50 extents, format it as ext4 and mount it on /mnt/lvdata at every boot.',
    tasks: [
      {
        text: 'Create a GPT partition table on /dev/nvme0n2 and partition 1 of exactly 2 GiB (1MiB to 2049MiB), with the lvm flag set.',
        hint: 'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart lvm 1MiB 2049MiB set 1 lvm on',
        check: (sh) => {
          const d = findDevice(sh.state.storage, '/dev/nvme0n2p1');
          return diskOf(sh, 'nvme0n2')?.table === 'gpt' && d?.size === 2 * GiB && !!d.part?.flags.includes('lvm');
        },
      },
      {
        text: 'Make the partition an LVM physical volume.',
        hint: 'sudo pvcreate /dev/nvme0n2p1',
        check: (sh) => sh.state.storage.pvs.some((p) => p.device === '/dev/nvme0n2p1'),
      },
      {
        text: 'Create the volume group vgdata with an extent size of 16 MiB, using that physical volume.',
        hint: 'sudo vgcreate -s 16M vgdata /dev/nvme0n2p1',
        check: (sh) =>
          vgByName(sh.state.storage, 'vgdata')?.extentSize === 16 * MiB &&
          sh.state.storage.pvs.some((p) => p.device === '/dev/nvme0n2p1' && p.vg === 'vgdata'),
      },
      {
        text: 'Create the logical volume lvdata in vgdata with a size of exactly 50 extents.',
        hint: 'sudo lvcreate -n lvdata -l 50 vgdata  (small l counts extents: 50 x 16 MiB = 800 MiB)',
        check: (sh) => {
          const lv = lvOf(sh.state, 'vgdata', 'lvdata');
          return !!lv && lvExtents(lv) === 50;
        },
      },
      {
        text: 'Create an ext4 file system on lvdata.',
        hint: 'sudo mkfs.ext4 /dev/vgdata/lvdata',
        check: (sh) => fsOn(sh.state, '/dev/vgdata/lvdata')?.type === 'ext4',
      },
      {
        text: 'Create /mnt/lvdata and add a line to /etc/fstab that mounts lvdata there as ext4 with default options.',
        hint: "sudo mkdir /mnt/lvdata && echo '/dev/vgdata/lvdata /mnt/lvdata ext4 defaults 0 0' | sudo tee -a /etc/fstab",
        check: (sh) => fstabOk(sh, '/mnt/lvdata', '/dev/mapper/vgdata-lvdata', 'ext4'),
      },
      {
        text: 'Tell systemd that /etc/fstab changed, then mount everything listed in it.',
        hint: 'sudo systemctl daemon-reload && sudo mount -a',
        check: (sh) => mountedFrom(sh, '/mnt/lvdata', '/dev/mapper/vgdata-lvdata'),
      },
      {
        text: 'Look at the result: the extent size and free space of vgdata, and the size of lvdata.',
        hint: 'sudo vgdisplay vgdata && sudo lvs vgdata  (PE Size is the extent size)',
        check: (sh) => typed(sh, /^(sudo\s+)?(vgs|vgdisplay)\b/) && typed(sh, /^(sudo\s+)?(lvs|lvdisplay)\b/),
      },
      {
        text: 'Reboot server1 and make sure /mnt/lvdata is mounted again.',
        hint: 'sudo reboot  (then run findmnt /mnt/lvdata)',
        check: (sh) => rebootedCleanly(sh) && mountedFrom(sh, '/mnt/lvdata', '/dev/mapper/vgdata-lvdata'),
      },
    ],
  },
  {
    id: 'R15-lvm-grow',
    title: 'Grow a full volume group',
    intro:
      'The volume group vgapp on /dev/nvme0n2p1 is almost full. The logical volume lvapp (XFS, mounted on /app) needs 1 GiB more, and lvlogs (ext4, mounted on /logs) must become exactly 500 MiB. Add the empty 5 GiB disk /dev/nvme0n3 to vgapp and grow both while they stay mounted.',
    setup: (sh) =>
      prepare(sh, [
        'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart lvm 1MiB 1025MiB set 1 lvm on',
        'sudo vgcreate vgapp /dev/nvme0n2p1',
        'sudo lvcreate -y -n lvapp -L 768M vgapp',
        'sudo lvcreate -y -n lvlogs -L 200M vgapp',
        'sudo mkfs.xfs /dev/vgapp/lvapp',
        'sudo mkfs.ext4 /dev/vgapp/lvlogs',
        'sudo mkdir /app /logs',
        "echo '/dev/vgapp/lvapp /app xfs defaults 0 0' | sudo tee -a /etc/fstab",
        "echo '/dev/vgapp/lvlogs /logs ext4 defaults 0 0' | sudo tee -a /etc/fstab",
        'sudo systemctl daemon-reload',
        'sudo mount -a',
        "echo 'version 1' | sudo tee /app/version.txt",
      ]),
    tasks: [
      {
        text: 'Check how much free space vgapp has now.',
        hint: 'sudo vgs vgapp  (VFree is the free space)',
        check: (sh) => typed(sh, /^(sudo\s+)?(vgs|vgdisplay)\b/),
      },
      {
        text: 'Add the whole disk /dev/nvme0n3 to vgapp.',
        hint: 'sudo vgextend vgapp /dev/nvme0n3  (vgextend makes the disk a physical volume for you; sudo pvcreate /dev/nvme0n3 first also works)',
        check: (sh) => sh.state.storage.pvs.some((p) => p.device === '/dev/nvme0n3' && p.vg === 'vgapp'),
      },
      {
        text: 'Grow lvapp by 1 GiB, and its XFS file system with it, in one command.',
        hint: 'sudo lvextend -r -L +1G /dev/vgapp/lvapp',
        check: (sh) => {
          const size = lvSize(sh.state, 'vgapp', 'lvapp');
          return size === 768 * MiB + GiB && (fsOn(sh.state, '/dev/vgapp/lvapp')?.size ?? 0) >= size && appSafe(sh);
        },
      },
      {
        text: 'Set lvlogs to exactly 500 MiB. This time resize only the logical volume.',
        hint: 'sudo lvextend -L 500M /dev/vgapp/lvlogs',
        check: (sh) => lvSize(sh.state, 'vgapp', 'lvlogs') === 500 * MiB,
      },
      {
        text: 'Now grow the ext4 file system on lvlogs so it fills the logical volume.',
        hint: 'sudo resize2fs /dev/vgapp/lvlogs',
        check: (sh) =>
          (fsOn(sh.state, '/dev/vgapp/lvlogs')?.size ?? 0) >= 500 * MiB && mountedFrom(sh, '/logs', '/dev/mapper/vgapp-lvlogs'),
      },
      {
        text: 'Check the new sizes with lvs and df -h.',
        hint: 'sudo lvs vgapp && df -h /app /logs',
        check: (sh) => typed(sh, /^(sudo\s+)?(lvs|lvdisplay)\b/) && typed(sh, /^(sudo\s+)?df\b.*\s-\w*h/),
      },
    ],
  },
];

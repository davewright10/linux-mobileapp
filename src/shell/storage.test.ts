import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootStorage } from './commands-storage';
import { Shell } from './shell';
import {
  findDevice,
  fsOn,
  fstabCheck,
  fstabFor,
  lvExtents,
  lvOf,
  lvSize,
  mountedAt,
  swapActive,
  vgByName,
  vgFreeExtents,
} from './storage-state';

const out = (sh: Shell, line: string) => sh.run(line).output;
/** A shell that is already root (sudo -i). */
function rootShell() {
  const sh = new Shell();
  sh.run('sudo -i');
  return sh;
}
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

test('initial disks match the installed system', () => {
  const sh = new Shell();
  assert.equal(
    out(sh, 'lsblk'),
    'NAME          MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\n' +
      'nvme0n1       259:0    0   20G  0 disk\n' +
      '├─nvme0n1p1   259:1    0  600M  0 part /boot/efi\n' +
      '├─nvme0n1p2   259:2    0    1G  0 part /boot\n' +
      '└─nvme0n1p3   259:3    0 18.4G  0 part\n' +
      '  ├─rhel-root 253:0    0 16.4G  0 lvm  /\n' +
      '  └─rhel-swap 253:1    0    2G  0 lvm  [SWAP]\n' +
      'nvme0n2       259:4    0   10G  0 disk\n' +
      'nvme0n3       259:5    0    5G  0 disk\n',
  );
  const df = out(sh, 'df -h');
  assert.match(df, /^Filesystem             Size  Used Avail Use% Mounted on\n/);
  assert.match(df, /\n\/dev\/mapper\/rhel-root   17G  4\.1G   13G  25% \/\n/);
  assert.match(df, /\ndevtmpfs               4\.0M     0  4\.0M   0% \/dev\n/);
  assert.match(df, /\ntmpfs                  1\.8G     0  1\.8G   0% \/dev\/shm\n/);
  assert.match(df, /\n\/dev\/nvme0n1p2         960M  312M  649M  33% \/boot\n/);
  assert.match(df, /\/dev\/nvme0n1p1 .* \/boot\/efi\n$/);
  assert.match(out(sh, 'df'), /\n\/dev\/nvme0n1p2           983040  318976    664064  33% \/boot\n/);
  assert.match(out(sh, 'cat /etc/fstab'), /^UUID=4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c \/boot +xfs +defaults +0 0$/m);
  assert.match(out(sh, 'cat /etc/fstab'), /^\/dev\/mapper\/rhel-swap +none +swap +defaults +0 0$/m);
  assert.equal(out(sh, 'findmnt --verify'), 'Success, no errors or warnings detected\n');
  assert.deepEqual(bootStorage(sh), { errors: [], warnings: [] });
});

test('lsblk options, blkid and /proc files', () => {
  const sh = new Shell();
  const f = out(sh, 'lsblk -f');
  assert.match(f, /^NAME +FSTYPE +FSVER +LABEL UUID +FSAVAIL FSUSE% MOUNTPOINTS\n/);
  assert.match(f, /├─nvme0n1p2 +xfs +4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c +648\.5M +32% \/boot\n/);
  assert.match(f, /└─nvme0n1p3 +LVM2_member LVM2 001 +Xb3d2F-/);
  assert.match(f, /└─rhel-swap swap +1 +b2e8d4f1-3c7a-4e9b-8f1d-6a2c5e7b9d3f +\[SWAP\]\n/);
  assert.match(out(sh, 'lsblk -p'), /  ├─\/dev\/mapper\/rhel-root 253:0 /);
  assert.equal(out(sh, 'lsblk -no UUID /dev/nvme0n1p2'), '4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c\n');
  assert.equal(out(sh, 'lsblk -o NAME,SIZE /dev/nvme0n3'), 'NAME     SIZE\nnvme0n3    5G\n');
  assert.equal(out(sh, 'lsblk -d -o NAME,TYPE'), 'NAME    TYPE\nnvme0n1 disk\nnvme0n2 disk\nnvme0n3 disk\n');
  assert.match(out(sh, 'lsblk -o NAME,FOO'), /lsblk: unknown column: FOO/);
  assert.match(out(sh, 'lsblk /dev/sdz'), /lsblk: \/dev\/sdz: not a block device/);
  assert.equal(sh.lastCode, 32);

  const b = out(sh, 'blkid');
  assert.match(b, /^\/dev\/nvme0n1: PTUUID="3f8e1a2c-5d4b-4e6f-8a9c-0b1d2e3f4a5b" PTTYPE="gpt"\n/);
  assert.match(b, /\n\/dev\/nvme0n1p1: UUID="7B77-95E7" BLOCK_SIZE="512" TYPE="vfat" PARTLABEL="EFI System Partition" PARTUUID=/);
  assert.match(b, /\n\/dev\/mapper\/rhel-swap: UUID="b2e8d4f1-3c7a-4e9b-8f1d-6a2c5e7b9d3f" TYPE="swap"\n/);
  assert.doesNotMatch(b, /nvme0n2/);
  assert.equal(out(sh, 'blkid -s UUID -o value /dev/nvme0n1p2'), '4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c\n');
  assert.equal(out(sh, 'blkid -U 4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c'), '/dev/nvme0n1p2\n');
  assert.equal(out(sh, 'blkid -t TYPE=swap -o device'), '/dev/mapper/rhel-swap\n');
  assert.equal(out(sh, 'blkid /dev/nvme0n2'), '');
  assert.equal(sh.lastCode, 2);
  assert.match(out(sh, 'blkid -o export /dev/nvme0n1p2'), /^DEVNAME=\/dev\/nvme0n1p2\nUUID=4c8a1e2b-.*\nTYPE=xfs\n/s);

  assert.match(out(sh, 'cat /proc/partitions'), / 259 +3 +19306496 nvme0n1p3\n/);
  assert.match(out(sh, 'cat /proc/partitions'), / 253 +0 +17207296 dm-0\n/);
  assert.match(out(sh, 'cat /proc/mounts'), /^\/dev\/mapper\/rhel-root \/ xfs rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota 0 0\n/);
  assert.match(out(sh, 'cat /etc/mtab'), /\/dev\/nvme0n1p1 \/boot\/efi vfat rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro 0 0/);
  assert.equal(
    out(sh, 'cat /proc/swaps'),
    'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/dm-1                               partition\t2097148\t\t0\t\t-2\n',
  );
  assert.match(out(sh, 'ls -l /dev/mapper'), /rhel-root -> \.\.\/dm-0/);
  assert.match(out(sh, 'ls /dev/disk/by-uuid'), /4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c/);
  assert.match(out(sh, 'ls -l /dev/rhel'), /swap -> \.\.\/dm-1/);
});

test('mount listing, findmnt and df with a path', () => {
  const sh = new Shell();
  assert.match(out(sh, 'mount'), /^\/dev\/mapper\/rhel-root on \/ type xfs \(rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota\)\n/);
  assert.equal(out(sh, 'mount -t vfat'), '/dev/nvme0n1p1 on /boot/efi type vfat (rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro)\n');
  const tree = out(sh, 'findmnt');
  assert.match(tree, /^TARGET +SOURCE +FSTYPE +OPTIONS\n\/ +\/dev\/mapper\/rhel-root +xfs /);
  assert.match(tree, /\n└─\/boot +\/dev\/nvme0n1p2 +xfs .*\n  └─\/boot\/efi +\/dev\/nvme0n1p1 +vfat /);
  assert.match(tree, /\n│ └─\/dev\/shm +tmpfs/);
  assert.match(out(sh, 'findmnt /boot'), /^TARGET SOURCE +FSTYPE OPTIONS\n\/boot +\/dev\/nvme0n1p2 xfs +rw,/);
  assert.equal(out(sh, 'findmnt -n -o SOURCE /'), '/dev/mapper/rhel-root\n');
  assert.equal(out(sh, 'findmnt /etc'), '');
  assert.equal(sh.lastCode, 1);
  assert.match(out(sh, 'findmnt -s'), /^TARGET +SOURCE +FSTYPE OPTIONS\n\/ +\/dev\/mapper\/rhel-root/);
  assert.match(out(sh, 'df -h /home/student'), /^Filesystem +Size +Used Avail Use% Mounted on\n\/dev\/mapper\/rhel-root +17G +4\.1G +13G +25% \/\n$/);
  assert.match(out(sh, 'df -hT /boot/efi'), /\/dev\/nvme0n1p1 vfat +599M +7\.1M +592M +2% \/boot\/efi\n$/);
  assert.match(out(sh, 'df /nothere'), /df: \/nothere: No such file or directory/);
});

test('non-root users get the real errors', () => {
  const sh = new Shell();
  assert.match(out(sh, 'parted /dev/nvme0n2 print'), /WARNING: You are not superuser\.  Watch out for permissions\.\nError: Error opening \/dev\/nvme0n2: Permission denied\n\(Hint: try running it with sudo\)/);
  assert.match(out(sh, 'fdisk -l'), /fdisk: cannot open \/dev\/nvme0n1: Permission denied/);
  assert.match(out(sh, 'mkfs.xfs /dev/nvme0n2'), /mkfs\.xfs: cannot open \/dev\/nvme0n2: Permission denied/);
  assert.match(out(sh, 'mkfs.ext4 /dev/nvme0n2'), /Could not open \/dev\/nvme0n2: Permission denied/);
  assert.match(out(sh, 'mkswap /dev/nvme0n2'), /mkswap: cannot open \/dev\/nvme0n2: Permission denied/);
  assert.match(out(sh, 'pvs'), /WARNING: Running as a non-root user\. Functionality may be unavailable\.\n  \/run\/lock\/lvm\/P_global:aux: open failed: Permission denied/);
  assert.equal(sh.lastCode, 5);
  assert.match(out(sh, 'lvcreate -n x -L 1G rhel'), /Running as a non-root user/);
  assert.match(out(sh, 'mount /dev/nvme0n2 /mnt'), /mount: \/mnt: must be superuser to use mount\./);
  assert.match(out(sh, 'umount /boot'), /umount: \/boot: must be superuser to unmount\./);
  assert.match(out(sh, 'swapon /dev/nvme0n2'), /swapon: \/dev\/nvme0n2: swapon failed: Operation not permitted/);
  assert.match(out(sh, 'swapoff -a'), /swapoff failed: Operation not permitted/);
  assert.match(out(sh, 'wipefs -a /dev/nvme0n2'), /probing initialization failed: Permission denied/);
  // reading works without root
  assert.match(out(sh, 'swapon --show'), /^NAME +TYPE +SIZE USED PRIO\n\/dev\/dm-1 partition +2G +0B +-2\n$/);
  assert.match(out(sh, 'lsblk'), /nvme0n2/);
  // nothing changed
  assert.equal(sh.state.storage.disks[1].table, null);
  assert.equal(sh.state.storage.swaps.length, 1);
});

test('parted: GPT partitions in one line, print, rm and flags', () => {
  const sh = rootShell();
  assert.equal(out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart data xfs 1MiB 1GiB mkpart swap2 linux-swap 1GiB 2GiB mkpart lvm 2GiB 100% set 3 lvm on'), 'Information: You may need to update /etc/fstab.\n\n');
  assert.equal(
    out(sh, 'parted /dev/nvme0n2 print'),
    'Model: VMware Virtual NVMe Disk (nvme)\nDisk /dev/nvme0n2: 10.7GB\nSector size (logical/physical): 512B/512B\nPartition Table: gpt\nDisk Flags:\n\n' +
      'Number  Start   End     Size    File system  Name   Flags\n' +
      ' 1      1049kB  1074MB  1073MB               data\n' +
      ' 2      1074MB  2147MB  1074MB               swap2  swap\n' +
      ' 3      2147MB  10.7GB  8589MB               lvm    lvm\n\n',
  );
  assert.match(out(sh, 'parted /dev/nvme0n2 unit s print'), / 1      2048s +2097151s +2095104s +data/);
  assert.match(out(sh, 'parted /dev/nvme0n2 unit MiB print'), / 3      2048MiB +10239MiB +8191MiB +lvm +lvm/);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /├─nvme0n2p1 259:6    0 1023M  0 part\n├─nvme0n2p2 259:7    0    1G  0 part\n└─nvme0n2p3 259:8    0    8G  0 part\n/);
  const fd = out(sh, 'fdisk -l /dev/nvme0n2');
  assert.match(fd, /^Disk \/dev\/nvme0n2: 10 GiB, 10737418240 bytes, 20971520 sectors\nDisk model: VMware Virtual NVMe Disk\n/);
  assert.match(fd, /Disklabel type: gpt\n/);
  assert.match(fd, /\/dev\/nvme0n2p1    2048  2097151  2095104 1023M Linux filesystem\n/);
  assert.match(fd, /\/dev\/nvme0n2p2 2097152  4194303  2097152    1G Linux swap\n/);
  assert.match(fd, /\/dev\/nvme0n2p3 4194304 20969471 16775168    8G Linux LVM\n/);
  assert.match(out(sh, 'blkid /dev/nvme0n2p1'), /PARTLABEL="data" PARTUUID="[0-9a-f-]{36}"/);

  // errors
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mkpart x 500MiB 1500MiB'), /Error: Unable to satisfy all constraints on the partition\./);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mkpart x 9GiB 12GiB'), /Error: The location 12GiB is outside of the device \/dev\/nvme0n2\./);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 rm 7'), /Error: Partition doesn't exist\./);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 set 1 nonsense on'), /parted: invalid token: nonsense/);
  assert.match(out(sh, 'parted /dev/nvme0n2 mklabel msdos'), /Warning: The existing disk label on \/dev\/nvme0n2 will be destroyed .*\nYes\/No\? \(This terminal cannot answer prompts\. Run parted with -s/);
  assert.equal(sh.state.storage.disks[1].table, 'gpt');

  // rm and the free space it leaves
  out(sh, 'parted -s /dev/nvme0n2 rm 2');
  assert.doesNotMatch(out(sh, 'lsblk'), /nvme0n2p2/);
  assert.match(out(sh, 'parted /dev/nvme0n2 print free'), / +1074MB +2147MB +1074MB +Free Space/);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mkpart more 1100MiB 1200MiB'), /^Information/);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mkpart clash 1150MiB 1300MiB'), /You requested a partition from .* \(sectors 2355200\.\.2662399\)\.\nThe closest location we can manage is .* \(sectors 2457600\.\.2662399\)\./);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /nvme0n2p2 +259:7 +0 +100M/);

  // boot/esp go together on GPT; lvm replaces other type flags
  out(sh, 'parted -s /dev/nvme0n2 set 2 esp on');
  assert.deepEqual(sh.state.storage.disks[1].partitions.find((p) => p.number === 2)!.flags.sort(), ['boot', 'esp']);
  out(sh, 'parted -s /dev/nvme0n2 set 2 lvm on');
  assert.deepEqual(sh.state.storage.disks[1].partitions.find((p) => p.number === 2)!.flags, ['lvm']);
  out(sh, 'parted -s /dev/nvme0n2 name 2 extra');
  assert.match(out(sh, 'parted -s /dev/nvme0n2 print'), / 2 .* extra +lvm/);

  // the unlabeled disk
  assert.equal(
    out(sh, 'parted /dev/nvme0n3 print'),
    'Error: /dev/nvme0n3: unrecognised disk label\nModel: VMware Virtual NVMe Disk (nvme)\nDisk /dev/nvme0n3: 5369MB\nSector size (logical/physical): 512B/512B\nPartition Table: unknown\nDisk Flags:\n\n',
  );
  assert.equal(sh.lastCode, 1);
  assert.match(out(sh, 'parted -s /dev/nvme0n3 mkpart x 1MiB 100MiB'), /Error: \/dev\/nvme0n3: unrecognised disk label/);
  assert.match(out(sh, 'parted /dev/nvme0n9 print'), /Error: Could not stat device \/dev\/nvme0n9 - No such file or directory\./);
  assert.match(out(sh, 'parted /dev/nvme0n3'), /parted is interactive without commands/);
  assert.match(out(sh, 'parted -l'), /Disk \/dev\/nvme0n1: 21\.5GB[^]*Disk \/dev\/nvme0n2: 10\.7GB[^]*Error: \/dev\/nvme0n3: unrecognised disk label/);
  assert.equal(out(sh, 'partprobe /dev/nvme0n2'), '');
});

test('parted: decimal units, percent, -1 and alignment', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a 0% 50% mkpart b 50% -1');
  const parts = sh.state.storage.disks[1].partitions;
  assert.deepEqual(parts.map((p) => [p.start, p.end]), [[2048, 10485759], [10485760, 20969471]]);
  out(sh, 'parted -s /dev/nvme0n3 mklabel gpt mkpart a 1 1000 mkpart b 1GB 2GB');
  assert.deepEqual(sh.state.storage.disks[2].partitions.map((p) => [p.start, p.end]), [[2048, 1953791], [1953792, 3905535]]);
});

test('parted: msdos primary, extended and logical partitions', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel msdos mkpart primary xfs 1MiB 1GiB mkpart extended 1GiB 100% mkpart logical 1GiB 3GiB mkpart logical linux-swap 3GiB 4GiB');
  const fd = out(sh, 'fdisk -l /dev/nvme0n2');
  assert.match(fd, /Disklabel type: dos\nDisk identifier: 0x[0-9a-f]{8}\n/);
  assert.match(fd, /\/dev\/nvme0n2p1 +2048  2097151  2095104 1023M 83 Linux\n/);
  assert.match(fd, /\/dev\/nvme0n2p2 +2097152 20971519 18874368    9G  5 Extended\n/);
  assert.match(fd, /\/dev\/nvme0n2p5 +2099200  6291455  4192256    2G 83 Linux\n/);
  assert.match(fd, /\/dev\/nvme0n2p6 +6293504  8388607  2095104 1023M 82 Linux swap \/ Solaris\n/);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /├─nvme0n2p2 259:7    0    1K  0 part\n/);
  assert.match(out(sh, 'blkid /dev/nvme0n2p5'), /PARTUUID="[0-9a-f]{8}-05"/);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 print'), /Number  Start   End     Size    Type      File system  Flags\n 1      1049kB  1074MB  1073MB  primary\n 2      1074MB  10\.7GB  9664MB  extended\n 5 /);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mkpart primary 1MiB 100MiB'), /Error: Unable to satisfy all constraints/);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mkpart extended 1MiB 100MiB'), /Error: Can't have more than one extended partition/);
  // removing logical 5 renumbers 6 to 5
  out(sh, 'parted -s /dev/nvme0n2 rm 5');
  const nums = sh.state.storage.disks[1].partitions.map((p) => p.number).sort();
  assert.deepEqual(nums, [1, 2, 5]);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /└─nvme0n2p5 .* 1023M/);
  // too many primaries
  out(sh, 'parted -s /dev/nvme0n3 mklabel msdos mkpart primary 1MiB 100MiB mkpart primary 100MiB 200MiB mkpart primary 200MiB 300MiB mkpart primary 300MiB 400MiB');
  assert.match(out(sh, 'parted -s /dev/nvme0n3 mkpart primary 400MiB 500MiB'), /Error: Too many primary partitions\./);
  assert.match(out(sh, 'parted -s /dev/nvme0n3 mkpart logical 400MiB 500MiB'), /because there is no extended partition/);
  assert.match(out(sh, 'parted -s /dev/nvme0n3 set 1 boot on print'), / 1 .* primary +boot/);
  assert.match(out(sh, 'fdisk -l /dev/nvme0n3'), /\/dev\/nvme0n3p1 \* +2048 /);
});

test('fdisk is interactive, so it points to parted', () => {
  const sh = rootShell();
  const r = out(sh, 'fdisk /dev/nvme0n2');
  assert.match(r, /fdisk is interactive, which this phone terminal cannot show\./);
  assert.match(r, /sudo parted -s \/dev\/nvme0n2 mklabel gpt mkpart data xfs 1MiB 1GiB/);
  assert.equal(sh.lastCode, 1);
  const l = out(sh, 'fdisk -l');
  assert.match(l, /\/dev\/nvme0n1p1    2048  1230847  1228800  600M EFI System\n/);
  assert.match(l, /\/dev\/nvme0n1p3 3328000 41940991 38612992 18\.4G Linux LVM\n/);
  assert.match(l, /Disk \/dev\/mapper\/rhel-root: 16\.41 GiB, 17620271104 bytes, 34414592 sectors\n/);
  assert.match(l, /Disk \/dev\/nvme0n3: 5 GiB, 5368709120 bytes, 10485760 sectors\n/);
});

test('mkfs: xfs, ext4, vfat, mkfs -t and overwrite protection', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1GiB mkpart b 1GiB 2GiB mkpart c 2GiB 2100MiB');
  const x = out(sh, 'mkfs.xfs -L data /dev/nvme0n2p1');
  assert.match(x, /^meta-data=\/dev\/nvme0n2p1 +isize=512    agcount=4, agsize=65472 blks\n/);
  assert.match(x, /data     = +bsize=4096   blocks=261888, imaxpct=25\n/);
  assert.match(x, /Discarding blocks\.\.\.Done\.\n$/);
  assert.equal(fsOn(sh.state, '/dev/nvme0n2p1')?.label, 'data');
  assert.equal(out(sh, 'mkfs.xfs /dev/nvme0n2p1'), 'mkfs.xfs: /dev/nvme0n2p1 appears to contain an existing filesystem (xfs).\nmkfs.xfs: Use the -f option to force overwrite.\n');
  assert.match(out(sh, 'mkfs.xfs -f -L waytoolonglabel /dev/nvme0n2p1'), /Invalid value waytoolonglabel for -L option/);
  assert.match(out(sh, 'mkfs.xfs /dev/nvme0n2p3'), /Filesystem must be larger than 300MB\./);
  assert.match(out(sh, 'mkfs.xfs /dev/nvme0n2'), /appears to contain a partition table \(gpt\)/);
  assert.match(out(sh, 'mkfs.xfs /dev/nvme0n9'), /Error accessing specified device \/dev\/nvme0n9: No such file or directory/);

  const e = out(sh, 'mkfs.ext4 /dev/nvme0n2p1');
  assert.match(e, /^mke2fs 1\.47\.1 \(20-May-2024\)\n\/dev\/nvme0n2p1 contains a xfs file system labelled 'data'\nProceed anyway\? \(y,N\) /);
  assert.equal(fsOn(sh.state, '/dev/nvme0n2p1')?.type, 'xfs');
  const e2 = out(sh, 'mkfs.ext4 -F -L web /dev/nvme0n2p1');
  assert.match(e2, /Creating filesystem with 261888 4k blocks and 65536 inodes\nFilesystem UUID: [0-9a-f-]{36}\nSuperblock backups stored on blocks:\n\t32768, 98304, 163840, 229376\n\nAllocating group tables: done\n/);
  assert.equal(fsOn(sh.state, '/dev/nvme0n2p1')?.type, 'ext4');
  out(sh, 'echo y | mkfs.ext4 /dev/nvme0n2p1');
  assert.equal(fsOn(sh.state, '/dev/nvme0n2p1')?.label, '');

  assert.match(out(sh, 'mkfs.vfat -L USB /dev/nvme0n2p2'), /invalid option -- 'L'[^]*the label option of mkfs\.vfat is -n/);
  assert.equal(out(sh, 'mkfs.vfat -n USB /dev/nvme0n2p2'), 'mkfs.fat 4.2 (2021-01-31)\n');
  assert.match(out(sh, 'blkid /dev/nvme0n2p2'), /^\/dev\/nvme0n2p2: LABEL="USB" UUID="[0-9A-F]{4}-[0-9A-F]{4}" BLOCK_SIZE="512" TYPE="vfat"/);
  assert.match(out(sh, 'mkfs.vfat -n TOOLONGLABEL1 /dev/nvme0n2p2'), /Label can be no longer than 11 characters/);
  assert.match(out(sh, 'mkfs.vfat /dev/nvme0n2'), /Partitions or virtual mappings on device '\/dev\/nvme0n2'/);

  out(sh, 'mkfs -t xfs -f /dev/nvme0n2p2');
  assert.equal(fsOn(sh.state, '/dev/nvme0n2p2')?.type, 'xfs');
  assert.match(out(sh, 'mkfs -t btrfs /dev/nvme0n2p2'), /mkfs: failed to execute mkfs\.btrfs/);
  // a whole disk can hold a file system too, once forced
  out(sh, 'mkfs.ext4 /dev/nvme0n3');
  assert.match(out(sh, 'lsblk -f /dev/nvme0n3'), /nvme0n3 ext4 +1\.0 /);
  // mounted and in-use devices are refused
  assert.equal(out(sh, 'mkfs.xfs -f /dev/nvme0n1p2'), 'mkfs.xfs: /dev/nvme0n1p2 contains a mounted filesystem\n');
  assert.match(out(sh, 'mkfs.ext4 -F /dev/rhel/root'), /\/dev\/mapper\/rhel-root is mounted; will not make a filesystem here!/);
  assert.match(out(sh, 'mkfs.xfs -f /dev/nvme0n1p3'), /cannot open \/dev\/nvme0n1p3: Device or resource busy/);
  assert.match(out(sh, 'mkswap /dev/rhel/swap'), /Device or resource busy/);
});

test('mount and umount', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1GiB mkpart b 1GiB 2GiB');
  out(sh, 'mkfs.xfs -L data /dev/nvme0n2p1');
  out(sh, 'mkdir /data');
  out(sh, 'touch /data/hidden-by-mount');
  assert.match(out(sh, 'mount /dev/nvme0n2p1 /nodir'), /^mount: \/nodir: mount point does not exist\.\n       dmesg\(1\) may have more information after failed mount system call\.\n$/);
  assert.equal(sh.lastCode, 32);
  assert.match(out(sh, 'mount /dev/nvme0n2p2 /data'), /mount: \/data: wrong fs type, bad option, bad superblock on \/dev\/nvme0n2p2, missing codepage or helper program, or other error\./);
  assert.match(out(sh, 'mount -t ext4 /dev/nvme0n2p1 /data'), /wrong fs type, bad option/);
  assert.match(out(sh, 'mount -t foofs /dev/nvme0n2p1 /data'), /mount: \/data: unknown filesystem type 'foofs'\./);
  assert.match(out(sh, 'mount -o defualts /dev/nvme0n2p1 /data'), /wrong fs type, bad option/);
  assert.match(out(sh, 'mount /dev/nvme0n2p9 /data'), /mount: \/data: special device \/dev\/nvme0n2p9 does not exist\./);
  assert.equal(out(sh, 'mount UUID=0000 /data'), "mount: /data: can't find UUID=0000.\n");
  assert.equal(out(sh, 'mount /dev/nvme0n2p1 /data'), '');
  assert.equal(mountedAt(sh.state, '/data')?.source, '/dev/nvme0n2p1');
  assert.match(out(sh, 'mount /dev/nvme0n2p1 /data'), /mount: \/data: \/dev\/nvme0n2p1 already mounted on \/data\./);
  assert.equal(out(sh, 'ls /data'), '');
  assert.match(out(sh, 'ls -ld /data'), /^drwxr-xr-x\. \d+ root root/);
  assert.match(out(sh, 'df -h /data'), /^Filesystem +Size +Used Avail Use% Mounted on\n\/dev\/nvme0n2p1 +959M +40M +920M +5% \/data\n$/);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /├─nvme0n2p1 259:6    0 1023M  0 part \/data\n/);
  assert.match(out(sh, 'findmnt /data'), /\/data +\/dev\/nvme0n2p1 xfs +rw,relatime/);

  // files live on the file system, and the mount point's own files come back after umount
  out(sh, 'echo hi > /data/file.txt');
  out(sh, 'cd /data');
  assert.equal(out(sh, 'umount /data'), 'umount: /data: target is busy.\n(Your shell is inside /data. Run cd / first.)\n');
  assert.equal(sh.lastCode, 32);
  out(sh, 'cd /');
  assert.equal(out(sh, 'umount /data'), '');
  assert.equal(out(sh, 'ls /data'), 'hidden-by-mount\n');
  assert.equal(out(sh, 'umount /data'), 'umount: /data: not mounted.\n');
  assert.equal(out(sh, 'umount /nothere'), 'umount: /nothere: no mount point specified.\n');
  out(sh, 'mount LABEL=data /data');
  assert.equal(out(sh, 'cat /data/file.txt'), 'hi\n');
  out(sh, 'umount /dev/nvme0n2p1');
  assert.equal(mountedAt(sh.state, '/data'), undefined);
  const uuid = fsOn(sh.state, '/dev/nvme0n2p1')!.uuid;
  out(sh, `mount UUID=${uuid} /data`);
  assert.equal(out(sh, 'cat /data/file.txt'), 'hi\n');
  // a second mount of the same file system shows the same files
  out(sh, 'mount /dev/nvme0n2p1 /mnt');
  assert.equal(out(sh, 'cat /mnt/file.txt'), 'hi\n');
  assert.match(out(sh, 'lsblk -o NAME,MOUNTPOINTS /dev/nvme0n2p1'), /nvme0n2p1 \/data\n +\/mnt\n/);
  out(sh, 'umount /mnt');
  // a busy parent: something mounted below it
  out(sh, 'mkdir /data/sub');
  out(sh, 'mount -t tmpfs tmpfs /data/sub');
  assert.match(out(sh, 'umount /data'), /target is busy/);
  assert.match(out(sh, 'df -h /data/sub'), /tmpfs +1\.8G +0 +1\.8G +0% \/data\/sub/);
  out(sh, 'umount /data/sub');
  // remount read-only
  out(sh, 'mount -o remount,ro /data');
  assert.match(out(sh, 'findmnt -n -o OPTIONS /data'), /^ro,relatime,seclabel/);
  assert.match(out(sh, 'umount /'), /umount: \/: target is busy\./);
  // swap and LVM signatures are not mountable
  out(sh, 'mkswap /dev/nvme0n2p2');
  assert.match(out(sh, 'mount /dev/nvme0n2p2 /mnt'), /unknown filesystem type 'swap'/);
  assert.match(out(sh, 'mount /dev/nvme0n1p3 /mnt'), /unknown filesystem type 'LVM2_member'/);
  assert.match(out(sh, 'mount -t nfs server:/x /mnt'), /mount\.nfs: Connection timed out/);
});

test('the student\'s shell inside a mount keeps it busy for root', () => {
  const sh = new Shell();
  sh.run('sudo parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1GiB');
  sh.run('sudo mkfs.xfs /dev/nvme0n2p1');
  sh.run('sudo mkdir /data');
  sh.run('sudo mount /dev/nvme0n2p1 /data');
  sh.run('sudo chmod 1777 /data');
  sh.run('cd /data');
  out(sh, 'touch mine');
  assert.match(out(sh, 'sudo umount /data'), /target is busy/);
  sh.run('cd');
  assert.equal(out(sh, 'sudo umount /data'), '');
  sh.run('sudo mount /dev/nvme0n2p1 /data');
  assert.match(out(sh, 'ls -l /data'), /student student .* mine/);
  assert.match(out(sh, 'ls -ld /data'), /^drwxrwxrwt\./);
});

test('fstab, mount -a, the daemon-reload hint and findmnt --verify', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a xfs 1MiB 1GiB mkpart b ext4 1GiB 2GiB mkpart c 2GiB 3GiB');
  out(sh, 'mkfs.xfs -L data /dev/nvme0n2p1');
  out(sh, 'mkfs.ext4 /dev/nvme0n2p2');
  out(sh, 'mkfs.vfat -n VFAT /dev/nvme0n2p3');
  out(sh, 'mkdir /data /ext /vfat');
  const uuid = fsOn(sh.state, '/dev/nvme0n2p2')!.uuid;
  out(sh, 'echo "LABEL=data /data xfs defaults 0 0" >> /etc/fstab');
  out(sh, `echo "UUID=${uuid} /ext ext4 defaults 0 0" >> /etc/fstab`);
  out(sh, 'echo "/dev/nvme0n2p3 /vfat vfat noauto 0 0" >> /etc/fstab');
  assert.equal(out(sh, 'findmnt --verify'), 'Success, no errors or warnings detected\n');
  assert.equal(
    out(sh, 'mount -a'),
    "mount: (hint) your fstab has been modified, but systemd still uses\n       the old version; use 'systemctl daemon-reload' to reload.\n",
  );
  assert.equal(sh.lastCode, 0);
  assert.equal(mountedAt(sh.state, '/data')?.source, '/dev/nvme0n2p1');
  assert.equal(mountedAt(sh.state, '/ext')?.source, '/dev/nvme0n2p2');
  assert.equal(mountedAt(sh.state, '/vfat'), undefined);
  assert.match(out(sh, 'ls /ext'), /lost\+found/);
  out(sh, 'systemctl daemon-reload');
  assert.equal(out(sh, 'mount -a'), '');
  assert.equal(out(sh, 'mount /vfat'), '');
  assert.equal(mountedAt(sh.state, '/vfat')?.type, 'vfat');
  assert.match(out(sh, 'mount /nothere'), /mount: \/nothere: can't find in \/etc\/fstab\./);
  assert.match(out(sh, 'mount -av'), /\/data +: already mounted\n/);

  // broken lines
  out(sh, 'echo "UUID=1234-ABCD /web xfs defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "/dev/nvme0n2p1 /missing xfs defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "LABEL=data /data2 ext4 defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "broken" >> /etc/fstab');
  out(sh, 'mkdir /data2');
  const v = out(sh, 'findmnt --verify');
  assert.match(v, /findmnt: \/etc\/fstab: parse error at line \d+ -- ignored\n/);
  assert.match(v, /\/web\n   \[E\] unreachable on boot required target: No such file or directory\n   \[E\] unreachable on boot required source: UUID=1234-ABCD\n/);
  assert.match(v, /\/missing\n   \[E\] unreachable on boot required target: No such file or directory\n/);
  assert.match(v, /\/data2\n   \[W\] ext4 does not match with on-disk xfs\n/);
  assert.match(v, /\n1 parse error, 3 errors, 1 warning\n$/);
  assert.equal(sh.lastCode, 1);
  const a = out(sh, 'mount -a');
  assert.match(a, /mount: \/etc\/fstab: parse error at line \d+ -- ignored\n/);
  assert.match(a, /mount: \/web: can't find UUID=1234-ABCD\.\n/);
  assert.match(a, /mount: \/missing: mount point does not exist\.\n/);
  assert.match(a, /mount: \/data2: wrong fs type, bad option, bad superblock on \/dev\/nvme0n2p1/);
  assert.match(a, /your fstab has been modified/);
  assert.equal(sh.lastCode, 32);

  const checks = fstabCheck(sh.state);
  assert.equal(checks.find((c) => c.entry.file === '/data')?.error, null);
  assert.equal(fstabFor(sh.state, '/web')?.error, "mount: /web: can't find UUID=1234-ABCD.");
  assert.equal(fstabFor(sh.state, '/ext')?.dev?.path, '/dev/nvme0n2p2');
  assert.match(out(sh, 'findmnt -s /web'), /\/web +UUID=1234-ABCD xfs +defaults/);
});

test('swap: mkswap, swapon, swapoff, fstab and free', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart swap2 linux-swap 1MiB 1025MiB mkpart other 1025MiB 2049MiB');
  assert.match(out(sh, 'swapon /dev/nvme0n2p1'), /swapon: \/dev\/nvme0n2p1: read swap header failed/);
  const mk = out(sh, 'mkswap -L swap2 /dev/nvme0n2p1');
  assert.match(mk, /^Setting up swapspace version 1, size = 1024 MiB \(1073737728 bytes\)\nLABEL=swap2, UUID=[0-9a-f-]{36}\n$/);
  assert.equal(out(sh, 'swapon LABEL=swap2'), '');
  assert.ok(swapActive(sh.state, '/dev/nvme0n2p1'));
  assert.equal(out(sh, 'swapon --show'), 'NAME           TYPE       SIZE USED PRIO\n/dev/dm-1      partition    2G   0B   -2\n/dev/nvme0n2p1 partition 1024M   0B   -3\n');
  assert.match(out(sh, 'swapon -s'), /\/dev\/nvme0n2p1                          partition\t1048572\t\t0\t\t-3\n/);
  assert.match(out(sh, 'free'), /\nSwap:        3145720           0     3145720\n/);
  assert.match(out(sh, 'free -h'), /\nSwap: +3\.0Gi +0B +3\.0Gi\n/);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /nvme0n2p1 .* \[SWAP\]/);
  assert.match(out(sh, 'swapon /dev/nvme0n2p1'), /swapon failed: Device or resource busy/);
  assert.match(out(sh, 'mkswap /dev/nvme0n2p1'), /Device or resource busy/);
  assert.equal(out(sh, 'swapoff /dev/nvme0n2p1'), '');
  assert.match(out(sh, 'swapoff /dev/nvme0n2p1'), /swapoff: \/dev\/nvme0n2p1: swapoff failed: Invalid argument/);
  assert.match(out(sh, 'swapon UUID=0000'), /swapon: cannot find the device for UUID=0000/);
  // a second mkswap warns about the old signature
  out(sh, 'mkfs.xfs /dev/nvme0n2p2');
  assert.match(out(sh, 'mkswap /dev/nvme0n2p2'), /^mkswap: \/dev\/nvme0n2p2: warning: wiping old xfs signature\.\nSetting up swapspace/);
  // from /etc/fstab with a priority
  const uuid = fsOn(sh.state, '/dev/nvme0n2p1')!.uuid;
  out(sh, `echo "UUID=${uuid} none swap defaults,pri=5 0 0" >> /etc/fstab`);
  assert.equal(out(sh, 'swapon -a'), '');
  assert.match(out(sh, 'swapon --show'), /\/dev\/nvme0n2p1 partition 1024M   0B    5\n/);
  assert.equal(out(sh, 'swapon -a'), '');
  assert.equal(sh.state.storage.swaps.length, 2);
  out(sh, 'swapoff -a');
  assert.equal(out(sh, 'swapon --show'), '');
  assert.match(out(sh, 'free'), /\nSwap: +0 +0 +0\n/);
});

test('LVM: create PV, VG and LVs with sizes that add up', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart lvm 1MiB 100% set 1 lvm on');
  assert.equal(out(sh, 'pvcreate /dev/nvme0n2p1'), '  Physical volume "/dev/nvme0n2p1" successfully created.\n');
  assert.match(out(sh, 'pvs'), /  \/dev\/nvme0n2p1      lvm2 ---  <10\.00g <10\.00g\n/);
  assert.equal(out(sh, 'vgcreate -s 8M vgdata /dev/nvme0n2p1'), '  Volume group "vgdata" successfully created\n');
  assert.equal(out(sh, 'vgcreate vgdata /dev/nvme0n3'), '  A volume group called vgdata already exists.\n');
  const vg = vgByName(sh.state.storage, 'vgdata')!;
  assert.equal(vg.extentSize, 8 * MiB);
  assert.equal(vgFreeExtents(sh.state.storage, vg), 1279);
  assert.equal(
    out(sh, 'vgs'),
    '  VG     #PV #LV #SN Attr   VSize  VFree\n  rhel     1   2   0 wz--n- 18.41g    0\n  vgdata   1   0   0 wz--n-  9.99g 9.99g\n',
  );
  assert.equal(out(sh, 'lvcreate -n data -L 500M vgdata'), '  Rounding up size to full physical extent 504.00 MiB\n  Logical volume "data" created.\n');
  assert.equal(lvSize(sh.state, 'vgdata', 'data'), 504 * MiB);
  assert.equal(out(sh, 'lvcreate -n logs -l 20 vgdata'), '  Logical volume "logs" created.\n');
  assert.equal(lvSize(sh.state, 'vgdata', 'logs'), 160 * MiB);
  assert.equal(out(sh, 'lvcreate -n big -L 20G vgdata'), '  Volume group "vgdata" has insufficient free space (1196 extents): 2560 required.\n');
  assert.equal(sh.lastCode, 5);
  assert.equal(out(sh, 'lvcreate -n data -L 1G vgdata'), '  Logical Volume "data" already exists in volume group "vgdata"\n');
  assert.match(out(sh, 'lvcreate -n x -L 1G novg'), /  Volume group "novg" not found\n  Cannot process volume group novg\n/);
  assert.match(out(sh, 'lvcreate -n x vgdata'), /No command with matching syntax recognised/);
  assert.match(out(sh, 'lvcreate -n "bad name" -L 1G vgdata'), /contains invalid character/);
  out(sh, 'lvcreate -n half -l 50%FREE vgdata');
  assert.equal(lvExtents(lvOf(sh.state, 'vgdata', 'half')!), 598);
  out(sh, 'lvcreate -n rest -l 100%FREE vgdata');
  assert.equal(vgFreeExtents(sh.state.storage, vg), 0);
  assert.equal(
    out(sh, 'lvs vgdata'),
    '  LV   VG     Attr       LSize   Pool Origin Data%  Meta%  Move Log Cpy%Sync Convert\n' +
      '  data vgdata -wi-a----- 504.00m\n  half vgdata -wi-a-----   4.67g\n  logs vgdata -wi-a----- 160.00m\n  rest vgdata -wi-a-----   4.67g\n',
  );
  assert.match(out(sh, 'vgs vgdata'), /vgdata   1   4   0 wz--n- 9\.99g    0\n$/);
  // lsblk, /dev names and both device paths
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /└─nvme0n2p1 +259:6 +0 +10G +0 part\n  ├─vgdata-data 253:2    0  504M  0 lvm\n/);
  assert.match(out(sh, 'ls /dev/vgdata'), /data/);
  assert.match(out(sh, 'ls -l /dev/mapper'), /vgdata-data -> \.\.\/dm-2/);
  assert.equal(findDevice(sh.state.storage, '/dev/vgdata/data')?.path, '/dev/mapper/vgdata-data');
  assert.equal(findDevice(sh.state.storage, '/dev/dm-2')?.path, '/dev/mapper/vgdata-data');
  assert.match(out(sh, 'lvdisplay /dev/vgdata/data'), /  LV Path                \/dev\/vgdata\/data\n[^]*  LV Size                504\.00 MiB\n  Current LE             63\n[^]*  Block device           253:2\n/);
  assert.match(out(sh, 'lvdisplay /dev/mapper/vgdata-data'), /LV Name                data/);
  assert.match(out(sh, 'vgdisplay vgdata'), /  PE Size               8\.00 MiB\n  Total PE              1279\n  Alloc PE \/ Size       1279 \/ 9\.99 GiB\n  Free  PE \/ Size       0 \/ 0   \n/);
  assert.match(out(sh, 'pvdisplay /dev/nvme0n2p1'), /  VG Name               vgdata\n[^]*  Allocatable           yes \(but full\)\n/);
  // names with dashes double up in /dev/mapper
  out(sh, 'vgcreate my-vg /dev/nvme0n3');
  out(sh, 'lvcreate -n my-lv -L 100M my-vg');
  assert.equal(findDevice(sh.state.storage, '/dev/my-vg/my-lv')?.path, '/dev/mapper/my--vg-my--lv');
  assert.match(out(sh, 'lsblk /dev/nvme0n3'), /└─my--vg-my--lv/);
  assert.match(out(sh, 'lvscan'), /  ACTIVE            '\/dev\/my-vg\/my-lv' \[100\.00 MiB\] inherit\n/);
  assert.match(out(sh, 'vgscan'), /Found volume group "vgdata" using metadata type lvm2/);
});

test('LVM: grow with lvextend -r, xfs_growfs and resize2fs; df follows', () => {
  const sh = rootShell();
  out(sh, 'vgcreate vgdata /dev/nvme0n2');
  out(sh, 'lvcreate -n data -L 1G vgdata');
  out(sh, 'mkfs.xfs /dev/vgdata/data');
  out(sh, 'mkdir /data');
  out(sh, 'mount /dev/mapper/vgdata-data /data');
  assert.match(out(sh, 'df -h /data'), /\/dev\/mapper\/vgdata-data +960M /);
  const ext = out(sh, 'lvextend -r -L +1G /dev/vgdata/data');
  assert.match(ext, /^  File system xfs found on vgdata\/data mounted at \/data\.\n  Size of logical volume vgdata\/data changed from 1\.00 GiB \(256 extents\) to 2\.00 GiB \(512 extents\)\.\n  Extending file system xfs to 2\.00 GiB \(2147483648 bytes\) on vgdata\/data\.\.\.\n/);
  assert.match(ext, /data blocks changed from 262144 to 524288\n  Extended file system xfs on vgdata\/data\.\n  Logical volume vgdata\/data successfully resized\.\n$/);
  assert.match(out(sh, 'df -h /data'), /\/dev\/mapper\/vgdata-data +2\.0G /);
  assert.match(out(sh, 'lsblk /dev/vgdata/data'), /vgdata-data 253:2    0    2G  0 lvm  \/data/);
  assert.match(out(sh, 'lvs vgdata/data'), /data vgdata -wi-ao---- 2\.00g/);
  // grow the LV only, then the file system
  assert.equal(out(sh, 'lvextend -L 3G /dev/vgdata/data'), '  Size of logical volume vgdata/data changed from 2.00 GiB (512 extents) to 3.00 GiB (768 extents).\n  Logical volume vgdata/data successfully resized.\n');
  assert.match(out(sh, 'df -h /data'), /\/dev\/mapper\/vgdata-data +2\.0G /);
  assert.match(out(sh, 'xfs_growfs /data'), /data blocks changed from 524288 to 786432\n$/);
  assert.match(out(sh, 'df -h /data'), /\/dev\/mapper\/vgdata-data +3\.0G /);
  assert.doesNotMatch(out(sh, 'xfs_growfs /data'), /changed/);
  assert.match(out(sh, 'xfs_growfs /boot/efi'), /xfs_growfs: \/boot\/efi is not a mounted XFS filesystem/);
  assert.match(out(sh, 'xfs_info /data'), /^meta-data=\/dev\/mapper\/vgdata-data isize=512/);
  // size rules
  assert.equal(out(sh, 'lvextend -L 3G /dev/vgdata/data'), '  New size (768 extents) matches existing size (768 extents).\n');
  assert.equal(out(sh, 'lvextend -L 1G /dev/vgdata/data'), '  New size given (256 extents) not larger than existing size (768 extents)\n');
  assert.match(out(sh, 'lvextend -L +100G /dev/vgdata/data'), /Insufficient free space: 25600 extents needed, but only 1791 available/);
  assert.match(out(sh, 'lvextend -l +100%FREE vgdata/data'), /to <10\.00 GiB \(2559 extents\)/);
  assert.equal(vgFreeExtents(sh.state.storage, vgByName(sh.state.storage, 'vgdata')!), 0);
  // xfs cannot shrink
  assert.match(out(sh, 'lvreduce -L 1G /dev/vgdata/data'), /File system size \(3\.00 GiB\) is larger than the requested size \(1\.00 GiB\)\.\n  File system reduce is required \(see resize2fs or --resizefs\.\)/);
  assert.match(out(sh, 'lvreduce -r -L 1G /dev/vgdata/data'), /File system reduce is required and not supported \(xfs\)\./);
  assert.equal(lvExtents(lvOf(sh.state, 'vgdata', 'data')!), 2559);

  // ext4 on a second VG: grows online, shrinks with -r
  out(sh, 'vgcreate vgweb /dev/nvme0n3');
  out(sh, 'lvcreate -n web -L 1G vgweb');
  out(sh, 'mkfs.ext4 /dev/vgweb/web');
  out(sh, 'mkdir /web');
  out(sh, 'mount /dev/vgweb/web /web');
  out(sh, 'lvextend -L 2G /dev/vgweb/web');
  const r = out(sh, 'resize2fs /dev/vgweb/web');
  assert.match(r, /^resize2fs 1\.47\.1 \(20-May-2024\)\nFilesystem at \/dev\/vgweb\/web is mounted on \/web; on-line resizing required\nold_desc_blocks = 1, new_desc_blocks = 1\nThe filesystem on \/dev\/vgweb\/web is now 524288 \(4k\) blocks long\.\n/);
  assert.match(out(sh, 'resize2fs /dev/vgweb/web'), /The filesystem is already 524288 \(4k\) blocks long\.  Nothing to do!/);
  assert.match(out(sh, 'resize2fs /dev/vgweb/web 1G'), /On-line shrinking not supported/);
  assert.match(out(sh, 'resize2fs /dev/vgdata/data'), /Bad magic number in super-block/);
  const red = out(sh, 'lvreduce -r -L 1G /dev/vgweb/web');
  assert.match(red, /File system reduce is required using resize2fs\.\n/);
  assert.match(red, /Size of logical volume vgweb\/web changed from 2\.00 GiB \(512 extents\) to 1\.00 GiB \(256 extents\)\./);
  assert.equal(fsOn(sh.state, '/dev/vgweb/web')!.size, GiB);
  assert.match(out(sh, 'lvresize -r -l +128 /dev/vgweb/web'), /resize2fs \/dev\/vgweb\/web\n/);
  assert.equal(fsOn(sh.state, '/dev/vgweb/web')!.size, 1.5 * GiB);
  // shrinking an LV with no file system needs a yes
  out(sh, 'lvcreate -n raw -L 100M vgweb');
  assert.match(out(sh, 'lvreduce -L 52M vgweb/raw'), /Do you really want to reduce vgweb\/raw\? \[y\/n\]: n\n  Logical volume vgweb\/raw NOT reduced\.\n\(This terminal cannot answer prompts\./);
  assert.match(out(sh, 'lvreduce -y -L 52M vgweb/raw'), /changed from 100\.00 MiB \(25 extents\) to 52\.00 MiB \(13 extents\)/);
  assert.match(out(sh, 'lvreduce -L 1G vgweb/raw'), /not less than existing size/);
});

test('LVM: extend the root VG with a new disk, then shrink it back', () => {
  const sh = rootShell();
  assert.equal(out(sh, 'vgextend rhel /dev/nvme0n3'), '  Physical volume "/dev/nvme0n3" successfully created.\n  Volume group "rhel" successfully extended\n');
  assert.match(out(sh, 'vgs rhel'), /  rhel   2   2   0 wz--n- <23\.41g <5\.00g\n/);
  assert.match(out(sh, 'vgextend rhel /dev/nvme0n3'), /Physical volume '\/dev\/nvme0n3' is already in volume group 'rhel'/);
  out(sh, 'lvextend -r -L +1G /dev/rhel/root');
  assert.match(out(sh, 'df -h /'), /\/dev\/mapper\/rhel-root +18G /);
  // the LV now spans two PVs and shows under both in lsblk
  const tree = out(sh, 'lsblk');
  assert.match(tree, /└─nvme0n1p3 .*\n  ├─rhel-root .*\n  └─rhel-swap/);
  assert.match(tree, /nvme0n3 .*\n└─rhel-root +253:0    0 17\.4G  0 lvm  \/\n/);
  assert.equal(out(sh, 'vgreduce rhel /dev/nvme0n3'), '  Physical volume "/dev/nvme0n3" still in use\n');
  assert.match(out(sh, 'pvremove /dev/nvme0n3'), /PV \/dev\/nvme0n3 is used by VG rhel so please use vgreduce first\./);
  assert.match(out(sh, 'vgreduce rhel /dev/nvme0n1p3'), /still in use/);
  // add another disk, move the extents away, and remove the PV
  out(sh, 'vgextend rhel /dev/nvme0n2');
  assert.equal(out(sh, 'pvmove /dev/nvme0n3'), '  /dev/nvme0n3: Moved: 100.00%\n');
  assert.equal(out(sh, 'vgreduce rhel /dev/nvme0n3'), '  Removed "/dev/nvme0n3" from volume group "rhel"\n');
  assert.equal(out(sh, 'pvremove /dev/nvme0n3'), '  Labels on physical volume "/dev/nvme0n3" successfully wiped.\n');
  assert.match(out(sh, 'pvremove /dev/nvme0n3'), /No PV found on device \/dev\/nvme0n3\./);
  assert.equal(lvSize(sh.state, 'rhel', 'root'), 4457 * 4 * MiB);
  assert.match(out(sh, 'lsblk /dev/nvme0n2'), /└─rhel-root/);
});

test('LVM: removing LVs, VGs and PVs, and what is in use', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart lvm 1MiB 100% set 1 lvm on');
  out(sh, 'vgcreate vgdata /dev/nvme0n2p1');
  out(sh, 'lvcreate -n data -L 1G vgdata');
  out(sh, 'lvcreate -n swap2 -L 512M vgdata');
  out(sh, 'mkfs.xfs /dev/vgdata/data');
  out(sh, 'mkswap /dev/vgdata/swap2');
  out(sh, 'mkdir /data');
  out(sh, 'mount /dev/vgdata/data /data');
  out(sh, 'swapon /dev/vgdata/swap2');
  assert.match(out(sh, 'lvs vgdata'), /data  vgdata -wi-ao----/);
  assert.match(out(sh, 'swapon --show'), /\/dev\/dm-3 +partition +512M/);
  assert.equal(out(sh, 'lvremove -y /dev/vgdata/data'), '  Logical volume vgdata/data contains a filesystem in use.\n');
  assert.equal(out(sh, 'lvremove -y vgdata/swap2'), '  Logical volume vgdata/swap2 in use.\n');
  assert.match(out(sh, 'vgremove -f vgdata'), /contains a filesystem in use/);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 rm 1'), /Error: Partition \/dev\/nvme0n2p1 is being used\. You must unmount it before you modify it with Parted\./);
  assert.match(out(sh, 'parted -s /dev/nvme0n2 mklabel msdos'), /Error: Partition\(s\) on \/dev\/nvme0n2 are being used\./);
  assert.match(out(sh, 'wipefs -a /dev/nvme0n2p1'), /Device or resource busy/);
  assert.match(out(sh, 'pvcreate /dev/nvme0n2p1'), /Can't initialize physical volume "\/dev\/nvme0n2p1" of volume group "vgdata" without -ff/);
  out(sh, 'umount /data');
  out(sh, 'swapoff /dev/vgdata/swap2');
  assert.match(out(sh, 'lvremove /dev/vgdata/data'), /^Do you really want to remove active logical volume vgdata\/data\? \[y\/n\]: n\n  Logical volume vgdata\/data not removed\.\n\(This terminal cannot answer prompts\. Add -y: lvremove -y \/dev\/vgdata\/data\)\n$/);
  assert.equal(out(sh, 'echo y | lvremove /dev/vgdata/data'), '  Logical volume "data" successfully removed.\n');
  assert.doesNotMatch(out(sh, 'ls /dev/mapper'), /vgdata-data/);
  assert.match(out(sh, 'lvremove -y vgdata/nope'), /Failed to find logical volume "vgdata\/nope"/);
  assert.match(out(sh, 'vgremove vgdata'), /Do you really want to remove volume group "vgdata" containing 1 logical volumes\? \[y\/n\]: n/);
  assert.equal(out(sh, 'vgremove -f vgdata'), '  Logical volume "swap2" successfully removed.\n  Volume group "vgdata" successfully removed\n');
  assert.doesNotMatch(out(sh, 'ls /dev'), /vgdata/);
  assert.match(out(sh, 'pvs'), /\/dev\/nvme0n2p1 +lvm2 ---/);
  assert.equal(out(sh, 'pvremove /dev/nvme0n2p1'), '  Labels on physical volume "/dev/nvme0n2p1" successfully wiped.\n');
  assert.equal(out(sh, 'parted -s /dev/nvme0n2 rm 1'), 'Information: You may need to update /etc/fstab.\n\n');
  // the original system cannot be broken
  assert.match(out(sh, 'lvremove -y /dev/rhel/root'), /contains a filesystem in use/);
  assert.match(out(sh, 'vgreduce rhel /dev/nvme0n1p3'), /still in use/);
  assert.match(out(sh, 'pvcreate /dev/nvme0n1'), /Cannot use \/dev\/nvme0n1: device is partitioned/);
  assert.match(out(sh, 'pvcreate /dev/rhel/root'), /Cannot use \/dev\/mapper\/rhel-root: device is an LV/);
  assert.match(out(sh, 'pvcreate /dev/nvme0n9'), /Cannot use \/dev\/nvme0n9: device not found/);
  assert.match(out(sh, 'parted -s /dev/nvme0n1 rm 3'), /is being used/);
  assert.match(out(sh, 'parted -s /dev/nvme0n1 rm 2'), /\/dev\/nvme0n1p2 is being used/);
});

test('pvcreate asks before wiping a file system', () => {
  const sh = rootShell();
  out(sh, 'mkfs.xfs /dev/nvme0n3');
  const r = out(sh, 'pvcreate /dev/nvme0n3');
  assert.match(r, /^WARNING: xfs signature detected on \/dev\/nvme0n3 at offset 0\. Wipe it\? \[y\/n\]: n\n  Aborted wiping of xfs\.\n/);
  assert.equal(fsOn(sh.state, '/dev/nvme0n3')?.type, 'xfs');
  assert.equal(out(sh, 'pvcreate -y /dev/nvme0n3'), '  Wiping xfs signature on /dev/nvme0n3.\n  Physical volume "/dev/nvme0n3" successfully created.\n');
  assert.equal(fsOn(sh.state, '/dev/nvme0n3'), undefined);
  assert.match(out(sh, 'blkid /dev/nvme0n3'), /TYPE="LVM2_member"/);
  assert.match(out(sh, 'mkfs.xfs /dev/nvme0n3'), /appears to contain an existing filesystem \(LVM2_member\)/);
  out(sh, 'mkfs.xfs -f /dev/nvme0n3');
  assert.doesNotMatch(out(sh, 'pvs'), /nvme0n3/);
});

test('labels: xfs_admin, e2label, tune2fs', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1GiB mkpart b 1GiB 2GiB');
  out(sh, 'mkfs.xfs /dev/nvme0n2p1');
  out(sh, 'mkfs.ext4 /dev/nvme0n2p2');
  assert.equal(out(sh, 'xfs_admin -l /dev/nvme0n2p1'), 'label = ""\n');
  assert.equal(out(sh, 'xfs_admin -L data /dev/nvme0n2p1'), 'writing all SBs\nnew label = "data"\n');
  assert.equal(out(sh, 'xfs_admin -l /dev/nvme0n2p1'), 'label = "data"\n');
  assert.match(out(sh, 'ls /dev/disk/by-label'), /data/);
  assert.match(out(sh, 'xfs_admin -L x /dev/nvme0n2p2'), /is not a valid XFS filesystem/);
  assert.equal(out(sh, 'e2label /dev/nvme0n2p2 logs'), '');
  assert.equal(out(sh, 'e2label /dev/nvme0n2p2'), 'logs\n');
  assert.match(out(sh, 'e2label /dev/nvme0n2p1'), /Bad magic number in super-block while trying to open \/dev\/nvme0n2p1\n\/dev\/nvme0n2p1 contains a xfs file system/);
  out(sh, 'tune2fs -L web /dev/nvme0n2p2');
  assert.match(out(sh, 'blkid /dev/nvme0n2p2'), /LABEL="web"/);
  assert.match(out(sh, 'tune2fs -l /dev/nvme0n2p2'), /Filesystem volume name:   web\n/);
  assert.equal(out(sh, 'blkid -L web'), '/dev/nvme0n2p2\n');
  out(sh, 'mkdir /web');
  out(sh, 'mount LABEL=web /web');
  assert.equal(mountedAt(sh.state, '/web')?.source, '/dev/nvme0n2p2');
  // labelling a mounted XFS works online
  out(sh, 'mkdir /data && mount /dev/nvme0n2p1 /data');
  assert.equal(out(sh, 'xfs_admin -L data2 /dev/nvme0n2p1'), 'label = "data2"\n');
});

test('wipefs lists and wipes signatures', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1GiB');
  out(sh, 'mkfs.xfs -L d /dev/nvme0n2p1');
  assert.match(out(sh, 'wipefs /dev/nvme0n2p1'), /^DEVICE +OFFSET TYPE UUID +LABEL\nnvme0n2p1 0x0 +xfs +[0-9a-f-]{36} d\n$/);
  assert.equal(out(sh, 'wipefs -a /dev/nvme0n2p1'), '/dev/nvme0n2p1: 4 bytes were erased at offset 0x00000000 (xfs): 58 46 53 42\n');
  assert.equal(fsOn(sh.state, '/dev/nvme0n2p1'), undefined);
  const w = out(sh, 'wipefs -a /dev/nvme0n2');
  assert.match(w, /\/dev\/nvme0n2: 8 bytes were erased at offset 0x00000200 \(gpt\): 45 46 49 20 50 41 52 54\n/);
  assert.match(w, /\/dev\/nvme0n2: 2 bytes were erased at offset 0x000001fe \(PMBR\): 55 aa\n\/dev\/nvme0n2: calling ioctl to re-read partition table: Success\n$/);
  assert.equal(sh.state.storage.disks[1].table, null);
  assert.equal(out(sh, 'lsblk /dev/nvme0n2'), 'NAME    MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\nnvme0n2 259:4    0   10G  0 disk\n');
  assert.doesNotMatch(out(sh, 'ls /dev'), /nvme0n2p1/);
});

test('reboot: runtime mounts and swap go away, fstab entries come back', () => {
  const sh = rootShell();
  out(sh, 'parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1GiB mkpart b 1GiB 2GiB mkpart c 2GiB 3GiB');
  out(sh, 'mkfs.xfs -L data /dev/nvme0n2p1');
  out(sh, 'mkswap /dev/nvme0n2p2');
  out(sh, 'mkfs.ext4 /dev/nvme0n2p3');
  out(sh, 'mkdir /data /tmpmount /extra');
  out(sh, 'mount /dev/nvme0n2p3 /tmpmount');
  out(sh, 'swapon /dev/nvme0n2p2');
  out(sh, 'echo "LABEL=data /data xfs defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "/dev/nvme0n2p3 /extra ext4 noauto 0 0" >> /etc/fstab');
  out(sh, 'touch /data/under-the-mount');
  assert.deepEqual(bootStorage(sh), { errors: [], warnings: [] });
  assert.equal(mountedAt(sh.state, '/tmpmount'), undefined);
  assert.equal(mountedAt(sh.state, '/extra'), undefined);
  assert.equal(mountedAt(sh.state, '/data')?.source, '/dev/nvme0n2p1');
  assert.equal(mountedAt(sh.state, '/boot')?.source, '/dev/nvme0n1p2');
  assert.equal(mountedAt(sh.state, '/boot/efi')?.source, '/dev/nvme0n1p1');
  assert.ok(!swapActive(sh.state, '/dev/nvme0n2p2'));
  assert.ok(swapActive(sh.state, '/dev/rhel/swap'));
  assert.equal(out(sh, 'ls /data'), '');
  assert.match(out(sh, 'ls /boot/efi/EFI'), /redhat/);
  // mount -a no longer hints: systemd read the new fstab at boot
  assert.equal(out(sh, 'mount -a'), '');

  // boot errors, and nofail
  out(sh, 'echo "UUID=1234 /web xfs defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "/dev/nvme0n2p1 /nodir xfs defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "/dev/nvme0n2p3 /data ext4 defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "/dev/sdz1 /backup xfs defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "LABEL=nope none swap defaults 0 0" >> /etc/fstab');
  out(sh, 'echo "UUID=5678 /opt xfs defaults,nofail 0 0" >> /etc/fstab');
  out(sh, 'mkdir /web');
  assert.deepEqual(bootStorage(sh), {
    errors: ["mount: /web: can't find UUID=1234.", 'mount: /backup: special device /dev/sdz1 does not exist.'],
    // a bad swap line only fails swap.target
    warnings: ['swapon: cannot find the device for LABEL=nope'],
  });
  // systemd creates a missing mount point
  assert.equal(mountedAt(sh.state, '/nodir')?.source, '/dev/nvme0n2p1');
  // two entries for /data: the first wins and the second stacks on top, like a real boot
  assert.equal(mountedAt(sh.state, '/data')?.source, '/dev/nvme0n2p3');
});

test('boot reports a wrong file system type', () => {
  const sh = rootShell();
  out(sh, 'mkfs.xfs /dev/nvme0n3');
  out(sh, 'mkdir /data');
  out(sh, 'echo "/dev/nvme0n3 /data ext4 defaults 0 0" >> /etc/fstab');
  assert.deepEqual(bootStorage(sh).errors, ['mount: /data: wrong fs type, bad option, bad superblock on /dev/nvme0n3, missing codepage or helper program, or other error.']);
  assert.equal(mountedAt(sh.state, '/data'), undefined);
});

test('du, free and man pages', () => {
  const sh = new Shell();
  out(sh, 'mkdir -p d/e && echo hello > d/a && echo world > d/e/b');
  assert.equal(out(sh, 'du -sh d'), '8.0K\td\n');
  assert.equal(out(sh, 'du d'), '4\td/e\n8\td\n');
  assert.equal(out(sh, 'du -a d'), '4\td/a\n4\td/e/b\n4\td/e\n8\td\n');
  assert.match(out(sh, 'du -s /root'), /du: cannot read directory '\/root': Permission denied/);
  assert.match(out(sh, 'free -m'), /\nSwap: +2047 +0 +2047\n/);
  assert.match(out(sh, 'man lvextend'), /lvextend - grow a logical volume/);
  assert.match(out(sh, 'man -k swap'), /swapon/);
  assert.match(out(sh, 'which parted'), /\/usr\/bin\/parted/);
});

test('every storage command is known to the terminal', async () => {
  const { COMMANDS } = await import('./commands');
  const { STORAGE_COMMANDS, STORAGE_MAN } = await import('./commands-storage');
  for (const name of Object.keys(STORAGE_COMMANDS)) {
    assert.equal(COMMANDS[name], STORAGE_COMMANDS[name], name);
    if (!name.startsWith('mkfs.') && name !== 'mke2fs') assert.ok(STORAGE_MAN[name] || ['free', 'du'].includes(name), `man page for ${name}`);
  }
  // gdisk is not in the RHEL 10 repositories
  assert.match(new Shell().run('gdisk /dev/nvme0n2').output, /command not found/);
});

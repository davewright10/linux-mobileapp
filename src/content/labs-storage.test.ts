import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shell } from '../shell/shell';
import { GiB, MiB, fsOn, fstabFor, lvSize, mountedAt, swapActive, vgByName, vgFreeExtents } from '../shell/storage-state';
import { F11_STORAGE_LABS, R14_LABS, R15_LABS } from './labs-storage';
import { MODULES, getModule } from './index';
import type { Lab } from './types';

const ALL = [...F11_STORAGE_LABS, ...R14_LABS, ...R15_LABS];
const out = (sh: Shell, line: string) => sh.run(line).output;
const labById = (id: string) => ALL.find((l) => l.id === id)!;
/** The part of a hint that is typed: text after two spaces and "(" is an explanation. */
const cmdOf = (hint: string) => hint.split(/\s{2,}\(/)[0];

/** A fresh server with the lab's setup done. */
function start(lab: Lab): Shell {
  const sh = new Shell();
  lab.setup?.(sh);
  return sh;
}
/** Type the hints of the first `n` tasks, returning the output of each task. */
function solve(lab: Lab, sh: Shell, n = lab.tasks.length): string[] {
  return lab.tasks.slice(0, n).map((t) => cmdOf(t.hint).split('\n').map((l) => out(sh, l)).join(''));
}
/** Type the hint of task `n` (1-based) only. */
const hint = (lab: Lab, sh: Shell, n: number) => cmdOf(lab.tasks[n - 1].hint).split('\n').map((l) => out(sh, l)).join('');
const passed = (lab: Lab, sh: Shell) => lab.tasks.map((t) => t.check(sh));
/** Check of task `n` (1-based). */
const task = (lab: Lab, n: number) => (sh: Shell) => lab.tasks[n - 1].check(sh);
/** The UUID blkid reports for a device, read as root. */
const uuidOf = (sh: Shell, dev: string) => out(sh, `sudo blkid -s UUID -o value ${dev}`).trim();

test('storage labs are wired into F11, R14 and R15 with unique ids', () => {
  assert.equal(F11_STORAGE_LABS.length, 1);
  assert.equal(R14_LABS.length, 2);
  assert.equal(R15_LABS.length, 2);
  for (const [mod, labs] of [['F11', F11_STORAGE_LABS], ['R14', R14_LABS], ['R15', R15_LABS]] as const) {
    const m = getModule(mod)!;
    for (const lab of labs) {
      assert.ok(m.labs.includes(lab), `${lab.id} is not in ${mod}`);
      assert.ok(lab.id.startsWith(`${mod}-`), `${lab.id} should start with ${mod}-`);
    }
  }
  const ids = MODULES.flatMap((m) => m.labs.map((l) => l.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('lab texts are plain and complete', () => {
  for (const lab of ALL) {
    assert.ok(lab.title.length > 0 && lab.intro.length > 40, lab.id);
    assert.ok(lab.tasks.length >= 6, `${lab.id} has few tasks`);
    for (const s of [lab.title, lab.intro, ...lab.tasks.flatMap((t) => [t.text, t.hint])]) {
      assert.doesNotMatch(s, /[–—]/, `dash in ${lab.id}: ${s}`);
      assert.doesNotMatch(s, /\s$/, `trailing space in ${lab.id}: ${s}`);
    }
    for (const t of lab.tasks) {
      assert.match(t.text, /[.?]$/, `${lab.id}: task text should be a sentence: ${t.text}`);
      // hints are command lines; root-only storage commands go through sudo, as user student must
      for (const c of cmdOf(t.hint).split(/&&|\|/).map((x) => x.trim())) {
        assert.doesNotMatch(c, /^(parted|mkfs\S*|mkswap|swapon -a|mount\s+\S|umount|pvcreate|vgcreate|vgextend|lvcreate|lvextend|resize2fs|reboot|tee)\b/, `${lab.id}: needs sudo: ${c}`);
      }
    }
  }
});

test('no task passes before the lab starts, and checks never throw', () => {
  for (const lab of ALL) {
    assert.deepEqual(passed(lab, start(lab)), lab.tasks.map(() => false), lab.id);
    // the app calls every check after every command, also on a system without the setup
    const bare = new Shell();
    for (const t of lab.tasks) assert.doesNotThrow(() => t.check(bare), `${lab.id}: ${t.text}`);
  }
});

test('every hint line succeeds and tasks pass one by one, in order', () => {
  for (const lab of ALL) {
    const sh = start(lab);
    lab.tasks.forEach((t, i) => {
      assert.equal(t.check(sh), false, `${lab.id} task ${i + 1} passes too early`);
      for (const line of cmdOf(t.hint).split('\n')) {
        const r = sh.run(line);
        assert.equal(sh.lastCode, 0, `${lab.id} task ${i + 1}: "${line}" failed:\n${r.output}`);
        assert.doesNotMatch(r.output, /command not found|not simulated|\(hint\) your fstab has been modified/, `${lab.id}: ${line}`);
      }
      assert.ok(t.check(sh), `${lab.id} task ${i + 1} not passed by its hint`);
      // a later command never undoes an earlier task
      assert.deepEqual(passed(lab, sh).slice(0, i + 1), lab.tasks.slice(0, i + 1).map(() => true), `${lab.id} after task ${i + 1}`);
    });
  }
});

test('a solved lab survives a reboot without errors', () => {
  const after: Record<string, (sh: Shell) => boolean> = {
    'F11-first-fs': (sh) => mountedAt(sh.state, '/data')?.source === '/dev/nvme0n2p1',
    'R14-label-uuid': (sh) =>
      mountedAt(sh.state, '/archive')?.source === '/dev/nvme0n2p1' &&
      mountedAt(sh.state, '/reports')?.source === '/dev/nvme0n2p2' &&
      !mountedAt(sh.state, '/mnt/usb'), // mounted by hand only
    'R14-swap': (sh) => swapActive(sh.state, '/dev/nvme0n2p2') && swapActive(sh.state, '/dev/mapper/rhel-swap'),
    'R15-lvm-build': (sh) => mountedAt(sh.state, '/mnt/lvdata')?.source === '/dev/mapper/vgdata-lvdata',
    'R15-lvm-grow': (sh) =>
      lvSize(sh.state, 'vgapp', 'lvapp') === 1792 * MiB && mountedAt(sh.state, '/logs')?.source === '/dev/mapper/vgapp-lvlogs',
  };
  for (const lab of ALL) {
    const sh = start(lab);
    solve(lab, sh);
    const boots = sh.state.kernel.boots;
    assert.match(out(sh, 'sudo reboot'), /rebooted/, lab.id);
    assert.equal(sh.state.kernel.boots, boots + 1, lab.id);
    assert.equal(sh.state.kernel.emergency, false, lab.id);
    assert.deepEqual(sh.state.kernel.bootErrors, [], lab.id);
    assert.ok(after[lab.id](sh), `${lab.id}: storage not back after reboot`);
    assert.equal(out(sh, 'sudo findmnt --verify'), 'Success, no errors or warnings detected\n', lab.id);
  }
});

test('F11-first-fs: the output a beginner sees', () => {
  const lab = labById('F11-first-fs');
  const sh = start(lab);
  const o = solve(lab, sh);
  assert.match(o[1], /Information: You may need to update \/etc\/fstab\./);
  assert.match(o[2], /^meta-data=\/dev\/nvme0n2p1 /);
  assert.match(o[4], /^Filesystem +Size +Used Avail Use% Mounted on\n\/dev\/nvme0n2p1 +2\.0G .* \/data\n$/);
  assert.match(o[5], /└─nvme0n2p1 xfs +[0-9a-f-]{36} .* \/data\n$/);
  const uuid = uuidOf(sh, '/dev/nvme0n2p1');
  assert.equal(o[6], `UUID=${uuid} /data xfs defaults 0 0\n`);
  assert.equal(o[7], '');
  assert.match(out(sh, 'tail -1 /etc/fstab'), new RegExp(`^UUID=${uuid} /data xfs defaults 0 0\n$`));
});

test('F11-first-fs: other correct ways pass', () => {
  const lab = labById('F11-first-fs');
  const sh = start(lab);
  solve(lab, sh, 1);
  out(sh, 'sudo parted -s /dev/nvme0n2 mkpart primary 2048s 4196351s'); // sectors, no type word
  assert.ok(task(lab, 2)(sh));
  out(sh, 'sudo mkfs -t xfs /dev/nvme0n2p1');
  assert.ok(task(lab, 3)(sh));
  const uuid = uuidOf(sh, '/dev/nvme0n2p1');
  out(sh, 'sudo mkdir /data');
  out(sh, `sudo mount UUID=${uuid} /data`);
  assert.ok(task(lab, 4)(sh));
  out(sh, 'df -hT | grep data');
  assert.ok(task(lab, 5)(sh));
  out(sh, 'lsblk --fs');
  assert.ok(task(lab, 6)(sh));
  out(sh, `echo 'UUID="${uuid}"  /data  xfs  defaults  0 0' | sudo tee -a /etc/fstab`); // quoted UUID, wide spacing
  assert.ok(task(lab, 7)(sh));
  out(sh, 'sudo umount /dev/nvme0n2p1');
  out(sh, 'sudo systemctl daemon-reload');
  out(sh, 'sudo mount -av');
  assert.ok(task(lab, 8)(sh));
});

test('F11-first-fs: wrong answers do not pass', () => {
  const lab = labById('F11-first-fs');
  const sh = start(lab);
  out(sh, 'sudo parted -s /dev/nvme0n2 mklabel msdos');
  assert.equal(task(lab, 1)(sh), false);
  out(sh, 'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart data xfs 1MiB 2GiB'); // 2047 MiB
  assert.ok(task(lab, 1)(sh));
  assert.equal(task(lab, 2)(sh), false);
  out(sh, 'sudo parted -s /dev/nvme0n2 rm 1 mkpart data xfs 1MiB 2049MiB');
  assert.ok(task(lab, 2)(sh));
  out(sh, 'sudo mkfs.ext4 /dev/nvme0n2p1');
  assert.equal(task(lab, 3)(sh), false);
  out(sh, 'sudo mkfs.xfs -f /dev/nvme0n2p1');
  assert.ok(task(lab, 3)(sh));
  out(sh, 'sudo mkdir /data /mnt/data && sudo mount /dev/nvme0n2p1 /mnt/data'); // wrong mount point
  assert.equal(task(lab, 4)(sh), false);
  out(sh, 'df /data'); // not human-readable
  out(sh, 'lsblk /dev/nvme0n2'); // no file system columns
  assert.equal(task(lab, 5)(sh), false);
  assert.equal(task(lab, 6)(sh), false);
  out(sh, 'sudo umount /mnt/data && sudo mount /dev/nvme0n2p1 /data');
  // by device name, by the wrong type, or with a mount point that has a typo
  for (const line of ['/dev/nvme0n2p1 /data xfs defaults 0 0', `UUID=${uuidOf(sh, '/dev/nvme0n2p1')} /data ext4 defaults 0 0`, `UUID=${uuidOf(sh, '/dev/nvme0n2p1')} /dta xfs defaults 0 0`]) {
    out(sh, 'sudo cp /etc/fstab /root/fstab.orig');
    out(sh, `echo '${line}' | sudo tee -a /etc/fstab`);
    assert.equal(task(lab, 7)(sh), false, line);
    out(sh, 'sudo cp /root/fstab.orig /etc/fstab');
  }
  hint(lab, sh, 7);
  assert.ok(task(lab, 7)(sh));
  out(sh, 'sudo mount -a'); // still mounted from before: nothing was tested
  assert.equal(task(lab, 8)(sh), false);
  out(sh, 'sudo umount /data');
  assert.equal(task(lab, 8)(sh), false); // unmounted and not mounted again
  out(sh, 'sudo mount -a');
  assert.ok(task(lab, 8)(sh));
});

test('R14-label-uuid: other correct ways pass, wrong ones do not', () => {
  const lab = labById('R14-label-uuid');
  const sh = start(lab);
  out(sh, 'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart a 1MiB 1025MiB mkpart b 1025MiB 1500MiB');
  assert.equal(task(lab, 1)(sh), false); // partition 2 too small
  out(sh, 'sudo parted -s /dev/nvme0n2 resizepart 2 1537MiB');
  assert.ok(task(lab, 1)(sh));
  out(sh, 'sudo mkfs.xfs -L Archive /dev/nvme0n2p1 && sudo mkfs.ext4 /dev/nvme0n2p2');
  assert.equal(task(lab, 2)(sh), false); // labels are case-sensitive
  out(sh, 'sudo xfs_admin -L archive /dev/nvme0n2p1');
  assert.ok(task(lab, 2)(sh));
  hint(lab, sh, 3);
  // the label of the other file system, or a label that does not exist
  for (const line of ['LABEL=archive /reports xfs defaults 0 0', 'LABEL=archiv /archive xfs defaults 0 0', 'LABEL=archive /archive ext4 defaults 0 0']) {
    out(sh, 'sudo cp /etc/fstab /root/fstab.orig');
    out(sh, `echo '${line}' | sudo tee -a /etc/fstab`);
    assert.equal(task(lab, 4)(sh), false, line);
    out(sh, 'sudo cp /root/fstab.orig /etc/fstab');
  }
  out(sh, `echo 'LABEL="archive" /archive xfs defaults 0 0' | sudo tee -a /etc/fstab`);
  assert.ok(task(lab, 4)(sh));
  const xfsUuid = uuidOf(sh, '/dev/nvme0n2p1');
  out(sh, 'sudo cp /etc/fstab /root/fstab.orig');
  out(sh, `echo 'UUID=${xfsUuid} /reports ext4 defaults 0 0' | sudo tee -a /etc/fstab`); // UUID of the wrong partition
  assert.equal(task(lab, 5)(sh), false);
  out(sh, 'sudo cp /root/fstab.orig /etc/fstab');
  out(sh, "echo '/dev/nvme0n2p2 /reports ext4 defaults 0 0' | sudo tee -a /etc/fstab"); // not by UUID
  assert.equal(task(lab, 5)(sh), false);
  out(sh, 'sudo cp /root/fstab.orig /etc/fstab');
  out(sh, `echo 'UUID=${uuidOf(sh, '/dev/nvme0n2p2')} /reports ext4 defaults 0 0' | sudo tee -a /etc/fstab`);
  assert.ok(task(lab, 5)(sh));
  assert.equal(out(sh, 'findmnt --verify | head -1'), 'Success, no errors or warnings detected\n');
  assert.ok(task(lab, 6)(sh));
  out(sh, 'sudo mount /archive'); // looks /archive up in fstab
  assert.equal(task(lab, 7)(sh), false); // /reports not yet
  out(sh, 'sudo mount /reports');
  assert.ok(task(lab, 7)(sh));
  out(sh, 'sudo parted -s /dev/nvme0n2 mkpart usb fat32 1537MiB 1793MiB && sudo mkfs.vfat -n usb /dev/nvme0n2p3');
  assert.equal(task(lab, 8)(sh), false); // label must be USB
  assert.match(out(sh, 'sudo mkfs.vfat -L USB /dev/nvme0n2p3'), /invalid option/);
  out(sh, 'sudo mkfs.fat -F 32 -n USB /dev/nvme0n2p3');
  assert.ok(task(lab, 8)(sh));
  out(sh, 'sudo mkdir /mnt/usb && sudo mount /dev/nvme0n2p3 /mnt/usb');
  assert.ok(task(lab, 9)(sh));
  assert.equal(fsOn(sh.state, 'LABEL=USB')?.type, 'vfat');
});

test('R14-swap: setup leaves a disk with data on it', () => {
  const lab = labById('R14-swap');
  const sh = start(lab);
  assert.deepEqual(sh.history, []);
  assert.equal(out(sh, 'cat /data/keep.txt'), 'Do not lose me.\n');
  assert.equal(fstabFor(sh.state, '/data')?.entry.spec, 'LABEL=data');
  assert.equal(out(sh, 'sudo mount -a'), ''); // systemd already has this fstab
  assert.match(out(sh, 'swapon --show'), /^NAME +TYPE +SIZE USED PRIO\n\/dev\/dm-1 partition +2G +0B +-2\n$/);
  assert.match(out(sh, 'sudo parted /dev/nvme0n2 print free'), /\n 1 +1049kB +1075MB +1074MB +xfs +data\n +1075MB +10\.7GB +9663MB +Free Space\n/);
  // partition 1 is in use, so it cannot be removed or relabelled by accident
  out(sh, 'sudo parted -s /dev/nvme0n2 rm 1');
  assert.equal(sh.state.storage.disks[1].partitions.length, 1);
});

test('R14-swap: the swap area, fstab and the totals', () => {
  const lab = labById('R14-swap');
  const sh = start(lab);
  const o = solve(lab, sh, 6);
  assert.match(o[2], /^Setting up swapspace version 1, size = 512 MiB \(536866816 bytes\)\nno label, UUID=[0-9a-f-]{36}\n$/);
  assert.match(o[5], /\n\/dev\/dm-1 +partition +2G +0B +-2\n\/dev\/nvme0n2p2 partition 512M +0B +-3\n/);
  assert.match(o[5], /\nSwap: +2\.5Gi +0B +2\.5Gi\n$/);
  assert.match(out(sh, 'tail -1 /etc/fstab'), /^UUID=[0-9a-f-]{36} none swap defaults 0 0\n$/);
  // swapon by hand also passes task 5
  const sh2 = start(lab);
  solve(lab, sh2, 4);
  out(sh2, 'sudo swapon /dev/nvme0n2p2');
  assert.ok(task(lab, 5)(sh2));
  out(sh2, 'swapon -s && free -m');
  assert.ok(task(lab, 6)(sh2));
});

test('R14-swap: destroying the data or skipping fstab does not pass', () => {
  const lab = labById('R14-swap');
  // a new partition table loses partition 1 and the data on it
  const sh = start(lab);
  out(sh, 'sudo umount /data');
  out(sh, 'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart swap linux-swap 1MiB 513MiB mkpart two 513MiB 1025MiB');
  assert.equal(sh.state.storage.disks[1].partitions.length, 2);
  assert.equal(task(lab, 2)(sh), false);
  // fstab by device name
  const sh2 = start(lab);
  solve(lab, sh2, 3);
  out(sh2, "echo '/dev/nvme0n2p2 none swap defaults 0 0' | sudo tee -a /etc/fstab");
  assert.equal(task(lab, 4)(sh2), false);
  // swap turned on by hand only is gone after a reboot
  const sh3 = start(lab);
  solve(lab, sh3, 3);
  out(sh3, 'sudo swapon /dev/nvme0n2p2');
  assert.ok(swapActive(sh3.state, '/dev/nvme0n2p2'));
  out(sh3, 'sudo reboot');
  assert.equal(task(lab, 7)(sh3), false);
  assert.ok(swapActive(sh3.state, '/dev/mapper/rhel-swap'));
  assert.equal(out(sh3, 'cat /data/keep.txt'), 'Do not lose me.\n');
});

test('R15-lvm-build: sizes, other ways and wrong answers', () => {
  const lab = labById('R15-lvm-build');
  const sh = start(lab);
  const o = solve(lab, sh);
  assert.match(o[2], /Volume group "vgdata" successfully created/);
  assert.match(o[7], /PE Size +16\.00 MiB\n/);
  assert.match(o[7], /Alloc PE \/ Size +50 \/ 800\.00 MiB\n/);
  assert.match(o[7], /\n +lvdata vgdata -wi-ao---- 800\.00m\n$/);
  assert.equal(lvSize(sh.state, 'vgdata', 'lvdata'), 800 * MiB);

  // vgcreate on the bare partition makes it a PV too; -L 800M is the same 50 extents; fstab by UUID
  const sh2 = start(lab);
  solve(lab, sh2, 1);
  out(sh2, 'sudo vgcreate -s 16M vgdata /dev/nvme0n2p1');
  assert.ok(task(lab, 2)(sh2) && task(lab, 3)(sh2));
  out(sh2, 'sudo lvcreate -n lvdata -L 800M vgdata');
  assert.ok(task(lab, 4)(sh2));
  out(sh2, 'sudo mkfs -t ext4 /dev/mapper/vgdata-lvdata && sudo mkdir /mnt/lvdata');
  assert.ok(task(lab, 5)(sh2));
  out(sh2, `echo 'UUID=${uuidOf(sh2, '/dev/vgdata/lvdata')} /mnt/lvdata ext4 defaults 0 0' | sudo tee -a /etc/fstab`);
  assert.ok(task(lab, 6)(sh2));

  // the default extent size, or a size in MiB instead of extents
  const sh3 = start(lab);
  solve(lab, sh3, 2);
  out(sh3, 'sudo vgcreate vgdata /dev/nvme0n2p1');
  assert.equal(vgByName(sh3.state.storage, 'vgdata')?.extentSize, 4 * MiB);
  assert.equal(task(lab, 3)(sh3), false);
  out(sh3, 'sudo vgremove -y vgdata && sudo vgcreate -s 16M vgdata /dev/nvme0n2p1');
  assert.ok(task(lab, 3)(sh3));
  out(sh3, 'sudo lvcreate -n lvdata -L 50M vgdata');
  assert.equal(task(lab, 4)(sh3), false);
  // a missing partition flag
  const sh4 = new Shell();
  out(sh4, 'sudo parted -s /dev/nvme0n2 mklabel gpt mkpart lvm 1MiB 2049MiB');
  assert.equal(task(lab, 1)(sh4), false);
});

test('R15-lvm-build: a broken fstab line ends in emergency mode, so the reboot task fails', () => {
  const lab = labById('R15-lvm-build');
  const sh = start(lab);
  solve(lab, sh, 5);
  out(sh, "sudo mkdir /mnt/lvdata && echo '/dev/vgdata/lvdat /mnt/lvdata ext4 defaults 0 0' | sudo tee -a /etc/fstab");
  assert.equal(task(lab, 6)(sh), false);
  out(sh, 'sudo mount /dev/vgdata/lvdata /mnt/lvdata');
  assert.ok(task(lab, 7)(sh)); // mounted by hand
  out(sh, 'sudo reboot');
  assert.equal(sh.state.kernel.emergency, true);
  assert.equal(task(lab, 9)(sh), false);
});

test('R15-lvm-grow: setup leaves vgapp almost full', () => {
  const lab = labById('R15-lvm-grow');
  const sh = start(lab);
  assert.deepEqual(sh.history, []);
  const vg = vgByName(sh.state.storage, 'vgapp')!;
  assert.equal(vg.extentSize, 4 * MiB);
  assert.equal(vgFreeExtents(sh.state.storage, vg), 13);
  assert.match(out(sh, 'sudo vgs vgapp'), /\n +vgapp +1 +2 +0 wz--n- 1020\.00m 52\.00m\n$/);
  assert.equal(out(sh, 'cat /app/version.txt'), 'version 1\n');
  assert.equal(lvSize(sh.state, 'vgapp', 'lvapp'), 768 * MiB);
  assert.equal(lvSize(sh.state, 'vgapp', 'lvlogs'), 200 * MiB);
  // the first thing a learner may try fails for lack of space
  assert.match(out(sh, 'sudo lvextend -r -L +1G /dev/vgapp/lvapp'), /Insufficient free space: 256 extents needed, but only 13 available/);
  assert.equal(lvSize(sh.state, 'vgapp', 'lvapp'), 768 * MiB);
  assert.equal(out(sh, 'sudo mount -a'), '');
});

test('R15-lvm-grow: the grown sizes in lvs and df', () => {
  const lab = labById('R15-lvm-grow');
  const sh = start(lab);
  const o = solve(lab, sh);
  assert.match(o[1], /Physical volume "\/dev\/nvme0n3" successfully created\.\n +Volume group "vgapp" successfully extended\n/);
  assert.match(o[2], /Size of logical volume vgapp\/lvapp changed from 768\.00 MiB \(192 extents\) to 1\.75 GiB \(448 extents\)\./);
  assert.match(o[4], /The filesystem on \/dev\/vgapp\/lvlogs is now 128000 \(4k\) blocks long\./);
  assert.match(o[5], /\n +lvapp +vgapp -wi-ao---- +1\.75g\n +lvlogs vgapp -wi-ao---- 500\.00m\n/);
  assert.match(o[5], /\n\/dev\/mapper\/vgapp-lvapp +1\.7G .* \/app\n\/dev\/mapper\/vgapp-lvlogs +477M .* \/logs\n$/);
  assert.equal(fsOn(sh.state, '/dev/vgapp/lvlogs')?.size, 500 * MiB);
  assert.ok((fsOn(sh.state, '/dev/vgapp/lvapp')?.size ?? 0) >= 1792 * MiB);
});

test('R15-lvm-grow: other correct ways pass, wrong ones do not', () => {
  const lab = labById('R15-lvm-grow');
  // pvcreate first, then grow in two steps with xfs_growfs; lvresize -r for lvlogs does tasks 4 and 5 at once
  const sh = start(lab);
  out(sh, 'sudo vgdisplay vgapp');
  assert.ok(task(lab, 1)(sh));
  out(sh, 'sudo pvcreate /dev/nvme0n3');
  assert.equal(task(lab, 2)(sh), false); // a PV, but not in vgapp yet
  out(sh, 'sudo vgextend vgapp /dev/nvme0n3');
  assert.ok(task(lab, 2)(sh));
  out(sh, 'sudo lvextend -L 1G /dev/vgapp/lvapp'); // 1G is the new total, not 1G more
  assert.equal(task(lab, 3)(sh), false);
  out(sh, 'sudo lvextend -l +192 /dev/vgapp/lvapp');
  assert.equal(lvSize(sh.state, 'vgapp', 'lvapp'), 1792 * MiB);
  assert.equal(task(lab, 3)(sh), false); // the file system is still 768 MiB
  out(sh, 'sudo xfs_growfs /app');
  assert.ok(task(lab, 3)(sh));
  out(sh, 'sudo lvextend -L +500M /dev/vgapp/lvlogs'); // 700 MiB
  assert.equal(task(lab, 4)(sh), false);
  const sh2 = start(lab);
  solve(lab, sh2, 3);
  out(sh2, 'sudo lvresize -r -L 500M /dev/vgapp/lvlogs');
  assert.ok(task(lab, 4)(sh2) && task(lab, 5)(sh2));
  out(sh2, 'sudo lvdisplay vgapp/lvlogs && df -h');
  assert.ok(task(lab, 6)(sh2));
  // unmounting /app to grow it breaks the "while mounted" rule until it is mounted again
  const sh3 = start(lab);
  solve(lab, sh3, 2);
  out(sh3, 'sudo umount /app && sudo lvextend -r -L +1G /dev/vgapp/lvapp');
  assert.equal(lvSize(sh3.state, 'vgapp', 'lvapp'), 1792 * MiB);
  assert.equal(task(lab, 3)(sh3), false);
  out(sh3, 'sudo mount /app');
  assert.ok(task(lab, 3)(sh3));
});

test('sizes in task texts match the checks', () => {
  // the exam-style numbers in the texts are what the checks measure
  assert.match(labById('F11-first-fs').tasks[1].text, /exactly 2 GiB/);
  assert.match(labById('R14-label-uuid').intro, /1 GiB XFS .* 512 MiB ext4 .* 256 MiB VFAT/);
  assert.match(labById('R14-swap').intro, /512 MiB more swap/);
  assert.match(labById('R15-lvm-build').intro, /16 MiB physical extents.* exactly 50 extents/);
  assert.match(labById('R15-lvm-grow').intro, /1 GiB more.* exactly 500 MiB/);
  assert.equal(GiB, 1024 * MiB);
});

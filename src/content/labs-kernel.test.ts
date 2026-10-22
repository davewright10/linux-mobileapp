import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNNING_KERNEL, UPDATE_KERNEL, bootEntries, defaultBootEntry, entryHasArg, isLoaded, moduleParam, readSettings, textAt } from '../shell/kernel-state';
import { Shell } from '../shell/shell';
import { fstabFor, mountedAt } from '../shell/storage-state';
import { MODULES, getLab } from './index';
import { DATA_UUID, R16_BOOT_LABS, R17_LABS, R18_LABS, TYPO_UUID } from './labs-kernel';
import type { Lab } from './types';

const out = (sh: Shell, line: string) => sh.run(line).output;
/** Exit status of a command line ($?). */
const status = (sh: Shell, line: string) => {
  sh.run(line);
  return sh.lastCode;
};
const LABS: [string, Lab[]][] = [['R16', R16_BOOT_LABS], ['R17', R17_LABS], ['R18', R18_LABS]];
const ALL = LABS.flatMap(([, labs]) => labs);

const lab = (id: string) => {
  const l = ALL.find((x) => x.id === id);
  assert.ok(l, id);
  return l;
};

/** A fresh server with the lab's setup applied. */
function start(id: string): { sh: Shell; l: Lab } {
  const sh = new Shell();
  const l = lab(id);
  l.setup?.(sh);
  return { sh, l };
}

/** Type the hints of tasks [from, to) in order. */
function solve(sh: Shell, l: Lab, from: number, to: number): void {
  for (const t of l.tasks.slice(from, to)) sh.run(t.hint.split(/\s{2,}\(/)[0]);
}

const done = (sh: Shell, l: Lab, task: number) => l.tasks[task - 1].check(sh);
const grub = (sh: Shell) => readSettings(textAt(sh.state.root, '/etc/default/grub') ?? '');

test('kernel labs are registered under their modules with unique ids', () => {
  assert.equal(R16_BOOT_LABS.length, 1);
  assert.equal(R17_LABS.length, 2);
  assert.equal(R18_LABS.length, 2);
  const allIds = MODULES.flatMap((m) => m.labs.map((x) => x.id));
  assert.equal(new Set(allIds).size, allIds.length, 'lab ids are unique across the app');
  for (const [mod, labs] of LABS) {
    for (const l of labs) {
      assert.match(l.id, new RegExp(`^${mod}-[a-z][a-z-]*$`));
      assert.equal(getLab(l.id)?.module.id, mod, `${l.id} is listed in ${mod}`);
    }
  }
});

test('kernel lab texts are plain and every hint is one command line', () => {
  for (const l of ALL) {
    const texts = [l.title, l.intro, ...l.tasks.flatMap((t) => [t.text, t.hint])];
    for (const s of texts) assert.doesNotMatch(s, /[–—]/, `no dashes in "${s}"`);
    assert.ok(l.tasks.length >= 5, `${l.id} has enough tasks`);
    for (const t of l.tasks) {
      assert.match(t.text, /\.$/, t.text);
      assert.doesNotMatch(t.hint, /\n/, t.hint);
      assert.doesNotMatch(t.hint, /\s{2,}\(/, t.hint);
    }
  }
});

test('lab setups leave no history behind', () => {
  for (const l of ALL) {
    const sh = new Shell();
    l.setup?.(sh);
    assert.deepEqual(sh.history, [], l.id);
    assert.equal(sh.user.name, 'student', l.id);
  }
});

test('lab checks never change the system', () => {
  for (const l of ALL) {
    const sh = new Shell();
    l.setup?.(sh);
    for (let i = 0; i <= l.tasks.length; i++) {
      const before = JSON.stringify(sh.state);
      const history = [...sh.history];
      for (const t of l.tasks) t.check(sh);
      assert.equal(JSON.stringify(sh.state), before, `${l.id}: checks after task ${i}`);
      assert.deepEqual(sh.history, history);
      if (i < l.tasks.length) solve(sh, l, i, i + 1);
    }
    assert.ok(l.tasks[l.tasks.length - 1].check(sh), `${l.id}: the last task passes at the end`);
  }
});

// ---------- R16-kernel-args ----------

test('R16-kernel-args: a fresh install boots with rhgb quiet everywhere', () => {
  const { sh } = start('R16-kernel-args');
  assert.match(out(sh, 'cat /proc/cmdline'), / rd\.lvm\.lv=rhel\/swap rhgb quiet\n$/);
  assert.ok(bootEntries(sh.state).length >= 2);
  assert.ok(bootEntries(sh.state).every((e) => entryHasArg(e, 'rhgb') && entryHasArg(e, 'quiet')));
  assert.match(grub(sh).GRUB_CMDLINE_LINUX, / rhgb quiet$/);
  assert.match(out(sh, 'dmesg'), /Command line: .* rhgb quiet\n/);
  assert.match(out(sh, 'sudo grubby --info=DEFAULT'), /^args=".* rhgb quiet"$/m);
});

test('R16-kernel-args: plain grub2-mkconfig does not update the boot entries', () => {
  const { sh, l } = start('R16-kernel-args');
  solve(sh, l, 0, 4);
  assert.equal(out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg'), 'Generating grub configuration file ...\nAdding boot menu entry for UEFI Firmware Settings ...\ndone\n');
  assert.match(textAt(sh.state.root, '/boot/grub2/grub.cfg') ?? '', /set timeout=10\n/);
  assert.equal(done(sh, l, 5), false, 'the entries still lack audit=1');
  out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg --update-bls-cmdline');
  assert.equal(done(sh, l, 5), true);
});

test('R16-kernel-args: a reboot before grub2-mkconfig boots the old arguments', () => {
  const { sh, l } = start('R16-kernel-args');
  solve(sh, l, 0, 4);
  out(sh, 'sudo reboot');
  assert.doesNotMatch(out(sh, 'cat /proc/cmdline'), /audit=1|rhgb|quiet/);
  assert.equal(done(sh, l, 6), false);
  assert.equal(done(sh, l, 7), false);
  solve(sh, l, 4, 5);
  assert.equal(done(sh, l, 7), false, 'the running kernel has not got audit=1 yet');
  out(sh, 'sudo reboot');
  assert.equal(done(sh, l, 6), true);
  assert.equal(done(sh, l, 7), false, '/proc/cmdline has not been read since the reboot');
  out(sh, 'grep -o audit=1 /proc/cmdline');
  assert.equal(done(sh, l, 7), true);
});

test('R16-kernel-args: reading /proc/cmdline before the reboot does not count, and grub2-reboot is no reboot', () => {
  const { sh, l } = start('R16-kernel-args');
  solve(sh, l, 0, 5);
  out(sh, 'cat /proc/cmdline');
  assert.equal(done(sh, l, 7), false);
  out(sh, 'sudo reboot');
  out(sh, 'cat /proc/cmdline');
  out(sh, 'sudo grub2-reboot 0');
  assert.equal(done(sh, l, 7), true, 'grub2-reboot only sets next_entry');
  assert.equal(sh.state.kernel.boots, 1);
});

test('R16-kernel-args: grubby alone can add audit=1, and removing on one entry is not enough', () => {
  const { sh, l } = start('R16-kernel-args');
  out(sh, 'sudo grubby --update-kernel=DEFAULT --remove-args="rhgb quiet"');
  assert.equal(done(sh, l, 2), false, 'the rescue entry keeps rhgb quiet');
  out(sh, 'sudo grubby --update-kernel=ALL --remove-args="rhgb quiet"');
  assert.equal(done(sh, l, 2), true);
  out(sh, 'sudo grubby --update-kernel=ALL --args=audit=1');
  assert.equal(done(sh, l, 3), true, 'grubby --update-kernel=ALL also writes GRUB_CMDLINE_LINUX');
  assert.equal(done(sh, l, 4), false);
  solve(sh, l, 3, 4);
  out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg');
  assert.equal(done(sh, l, 5), true);
  assert.equal(grub(sh).GRUB_TIMEOUT, '10');
});

test('R16-kernel-args: a commented-out GRUB_TIMEOUT does not count, and the file needs root', () => {
  const { sh, l } = start('R16-kernel-args');
  out(sh, "echo '#GRUB_TIMEOUT=10' | sudo tee -a /etc/default/grub");
  assert.equal(done(sh, l, 4), false);
  assert.match(out(sh, 'sed -i s/x/y/ /etc/default/grub'), /Permission denied/);
  assert.equal(grub(sh).GRUB_TIMEOUT, '5');
});

// ---------- R17-modules ----------

test('R17-modules: the setup loads btusb with its dependencies, but not loop', () => {
  const { sh } = start('R17-modules');
  for (const m of ['btusb', 'btintel', 'btrtl', 'bluetooth', 'rfkill']) assert.ok(isLoaded(sh.state, m), m);
  assert.equal(isLoaded(sh.state, 'loop'), false);
  assert.match(out(sh, 'lsmod'), /^bluetooth +1081344  3 btintel,btrtl,btusb$/m);
  assert.match(out(sh, 'modinfo -F depends btusb'), /^btintel,btrtl,bluetooth\n$/);
});

test('R17-modules: an option written after loading needs a reload', () => {
  const { sh, l } = start('R17-modules');
  solve(sh, l, 0, 2);
  out(sh, 'sudo modprobe loop');
  assert.equal(moduleParam(sh.state, 'loop', 'max_loop'), '0');
  solve(sh, l, 2, 3);
  assert.equal(done(sh, l, 4), false, 'the loaded module keeps max_loop=0');
  out(sh, 'sudo modprobe loop');
  assert.equal(done(sh, l, 4), false, 'modprobe does nothing for a loaded module');
  out(sh, 'sudo modprobe -r loop');
  out(sh, 'sudo modprobe loop');
  assert.equal(done(sh, l, 4), true);
  assert.equal(out(sh, 'cat /sys/module/loop/parameters/max_loop'), '16\n');
});

test('R17-modules: the option and blacklist checks want the right module and directive', () => {
  const { sh, l } = start('R17-modules');
  out(sh, 'echo "options loop max_part=16" | sudo tee /etc/modprobe.d/loop.conf');
  assert.equal(done(sh, l, 3), false);
  out(sh, 'echo "options loop max_loop=16" | sudo tee /etc/modprobe.d/loop.txt');
  assert.equal(done(sh, l, 3), false, 'modprobe only reads *.conf files');
  out(sh, 'echo "blacklist uas" | sudo tee /etc/modprobe.d/usb_storage.conf');
  assert.equal(done(sh, l, 6), false);
  out(sh, 'echo "blacklist usb-storage" | sudo tee /etc/modprobe.d/blacklist.conf');
  assert.equal(done(sh, l, 6), true, 'dashes and underscores are the same module name');
});

test('R17-modules: unloading needs root and modprobe -r, and a blacklist unloads nothing', () => {
  const { sh, l } = start('R17-modules');
  out(sh, 'echo "blacklist btusb" | sudo tee /etc/modprobe.d/btusb.conf');
  assert.equal(done(sh, l, 7), false);
  assert.match(out(sh, 'modprobe -r btusb'), /could not remove 'btusb': Operation not permitted/);
  assert.equal(done(sh, l, 7), false);
  assert.match(out(sh, 'sudo rmmod bluetooth'), /Module bluetooth is in use by: btintel btrtl btusb/);
  out(sh, 'sudo rmmod btusb');
  assert.equal(done(sh, l, 7), false, 'rmmod leaves the dependencies loaded');
  out(sh, 'sudo modprobe -r btintel btrtl');
  assert.equal(done(sh, l, 7), true);
});

// ---------- R17-kernel-update ----------

test('R17-kernel-update: dnf needs root, and the new kernel only runs after a reboot', () => {
  const { sh, l } = start('R17-kernel-update');
  solve(sh, l, 0, 1);
  assert.match(out(sh, 'dnf update -y kernel'), /has to be run with superuser privileges/);
  assert.equal(done(sh, l, 2), false);
  out(sh, 'sudo reboot');
  assert.equal(done(sh, l, 5), false, 'rebooting without the update keeps the old kernel');
  solve(sh, l, 1, 4);
  assert.equal(out(sh, 'uname -r'), `${RUNNING_KERNEL}\n`);
  assert.equal(done(sh, l, 6), false);
  solve(sh, l, 4, 5);
  assert.equal(done(sh, l, 6), false, 'uname -r has not been run since this reboot');
  assert.equal(out(sh, 'uname -a').split(' ')[2], UPDATE_KERNEL);
  assert.equal(done(sh, l, 6), true);
});

test('R17-kernel-update: dnf install kernel works as well, and the old kernel stays in the menu', () => {
  const { sh, l } = start('R17-kernel-update');
  out(sh, 'sudo dnf install -y kernel');
  assert.equal(done(sh, l, 2), true);
  assert.equal(done(sh, l, 3), false);
  out(sh, 'rpm -qa kernel');
  assert.equal(done(sh, l, 3), true);
  assert.deepEqual(bootEntries(sh.state).map((e) => e.version).slice(0, 2), [UPDATE_KERNEL, RUNNING_KERNEL]);
  assert.equal(defaultBootEntry(sh.state)?.version, UPDATE_KERNEL);
});

test('R17-kernel-update: the kernel list must come after the install, by rpm or by dnf', () => {
  const { sh, l } = start('R17-kernel-update');
  out(sh, 'rpm -q kernel');
  out(sh, 'sudo dnf update -y kernel');
  assert.equal(done(sh, l, 3), false, 'rpm -q kernel before the install does not count');
  out(sh, 'sudo dnf list installed kernel');
  assert.equal(done(sh, l, 3), true);
});

// ---------- R18-fstab ----------

test('R18-fstab: the setup leaves /data mounted with a typo in its fstab line', () => {
  const { sh, l } = start('R18-fstab');
  assert.equal(mountedAt(sh.state, '/data')?.source, '/dev/nvme0n2p1');
  assert.equal(out(sh, 'cat /data/projects.txt'), 'Project plans for the next quarter\n');
  assert.match(out(sh, 'cat /etc/fstab'), new RegExp(`^UUID=${TYPO_UUID} /data xfs defaults 0 0$`, 'm'));
  assert.match(out(sh, 'blkid /dev/nvme0n2p1'), new RegExp(`UUID="${DATA_UUID}"`));
  assert.match(out(sh, 'ls -l /dev/disk/by-uuid'), new RegExp(`${DATA_UUID} -> \\.\\./\\.\\./nvme0n2p1`));
  assert.equal(fstabFor(sh.state, '/data')?.error, `mount: /data: can't find UUID=${TYPO_UUID}.`);
  assert.equal(status(sh, 'findmnt --verify'), 1);
  assert.equal(done(sh, l, 5), false);
  // the hint changes exactly the two swapped characters
  const [, from, to] = /^sed -i 's\/(\w+)\/(\w+)\/' \/etc\/fstab$/.exec(l.tasks[4].hint) ?? [];
  assert.equal(TYPO_UUID.replace(from, to), DATA_UUID);
});

test('R18-fstab: testing with mount -a before the reboot shows the problem', () => {
  const { sh, l } = start('R18-fstab');
  out(sh, 'sudo umount /data');
  assert.match(out(sh, 'sudo mount -a'), new RegExp(`mount: /data: can't find UUID=${TYPO_UUID}\\.`));
  assert.equal(done(sh, l, 6), false);
});

test('R18-fstab: rebooting or mount -a without a fix stays broken', () => {
  const { sh, l } = start('R18-fstab');
  solve(sh, l, 0, 4);
  assert.equal(sh.user.name, 'root');
  out(sh, 'mount -a');
  assert.equal(done(sh, l, 6), false);
  out(sh, 'systemctl reboot');
  assert.equal(sh.state.kernel.emergency, true);
  assert.equal(sh.state.kernel.boots, 2);
  assert.equal(done(sh, l, 7), false);
});

test('R18-fstab: commenting the line out boots, but /data is not mounted', () => {
  const { sh, l } = start('R18-fstab');
  solve(sh, l, 0, 4);
  out(sh, "sed -i 's/^UUID=5d3e8f21/#UUID=5d3e8f21/' /etc/fstab");
  assert.equal(status(sh, 'findmnt --verify'), 0);
  assert.equal(done(sh, l, 5), false);
  out(sh, 'systemctl daemon-reload && mount -a');
  assert.equal(done(sh, l, 6), false);
  out(sh, 'systemctl reboot');
  assert.equal(sh.state.kernel.emergency, false);
  assert.equal(done(sh, l, 7), false);
});

test('R18-fstab: another correct source for /data is accepted, and files come back', () => {
  const { sh, l } = start('R18-fstab');
  solve(sh, l, 0, 4);
  out(sh, `sed -i 's|^UUID=${TYPO_UUID}|/dev/nvme0n2p1|' /etc/fstab`);
  assert.equal(done(sh, l, 5), true);
  solve(sh, l, 5, 7);
  assert.equal(done(sh, l, 7), true);
  assert.equal(out(sh, 'cat /data/projects.txt'), 'Project plans for the next quarter\n');
  assert.equal(out(sh, 'findmnt -n -o SOURCE /data'), '/dev/nvme0n2p1\n');
});

// ---------- R18-rescue ----------

test('R18-rescue: the argument must be on the default entry only', () => {
  const { sh, l } = start('R18-rescue');
  out(sh, 'sudo grubby --update-kernel=ALL --args=systemd.unit=rescue.target');
  assert.equal(done(sh, l, 1), false, 'ALL also changes the rescue entry and GRUB_CMDLINE_LINUX');
  out(sh, 'sudo grubby --update-kernel=DEFAULT --remove-args=systemd.unit');
  assert.equal(done(sh, l, 4), false, 'the argument is still in the rescue entry and /etc/default/grub');
  out(sh, 'sudo grubby --update-kernel=ALL --remove-args=systemd.unit');
  assert.equal(done(sh, l, 4), true);
  solve(sh, l, 0, 1);
  assert.equal(done(sh, l, 1), true);
  assert.equal(done(sh, l, 4), false);
});

test('R18-rescue: without removing the argument every boot is rescue mode', () => {
  const { sh, l } = start('R18-rescue');
  out(sh, 'systemctl is-active sshd');
  solve(sh, l, 0, 2);
  assert.equal(sh.prompt(), '[root@server1 ~]# ');
  assert.equal(done(sh, l, 3), false, 'sshd was checked before the reboot');
  solve(sh, l, 2, 3);
  assert.equal(done(sh, l, 3), true);
  out(sh, 'systemctl reboot');
  assert.equal(sh.state.kernel.bootTarget, 'rescue.target');
  assert.equal(done(sh, l, 5), false);
  solve(sh, l, 3, 5);
  assert.equal(done(sh, l, 5), true);
  assert.equal(sh.user.name, 'student');
  assert.equal(out(sh, 'systemctl is-active sshd'), 'active\n');
});

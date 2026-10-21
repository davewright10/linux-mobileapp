import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootSteps, parseKernelPkg, updatedOptions } from './commands-kernel';
import {
  DEFAULT_KERNEL_ARGS,
  MACHINE_ID,
  RUNNING_KERNEL,
  UPDATE_KERNEL,
  bootEntries,
  defaultBootEntry,
  entryHasArg,
  installKernel,
  isLoaded,
  moduleDeps,
  moduleParam,
  nodeAt,
  readGrubenv,
  sysctlValue,
  textAt,
  verCmp,
} from './kernel-state';
import { Shell } from './shell';

const out = (sh: Shell, line: string) => sh.run(line).output;
const file = (sh: Shell, path: string) => textAt(sh.state.root, path);
const OLD = RUNNING_KERNEL; // 6.12.0-55.el10.x86_64
const NEW = UPDATE_KERNEL; // 6.12.0-124.el10.x86_64
const ENTRY = `/boot/loader/entries/${MACHINE_ID}-${OLD}.conf`;
const NEW_ENTRY = `/boot/loader/entries/${MACHINE_ID}-${NEW}.conf`;

/** Run a reboot with the storage step replaced (for example to make it fail). */
function withStorage<T>(errors: string[], fn: () => T): T {
  const saved = bootSteps.storage;
  bootSteps.storage = () => errors;
  try {
    return fn();
  } finally {
    bootSteps.storage = saved;
  }
}

test('fresh system: running kernel, boot entry and kernel arguments', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);
  assert.equal(out(sh, 'uname'), 'Linux\n');
  assert.equal(out(sh, 'uname -m'), 'x86_64\n');
  assert.equal(out(sh, 'uname -sr'), `Linux ${OLD}\n`);
  assert.match(out(sh, 'uname -a'), /^Linux server1\.example\.com 6\.12\.0-55\.el10\.x86_64 #1 SMP PREEMPT_DYNAMIC .* x86_64 x86_64 x86_64 GNU\/Linux\n$/);
  assert.match(out(sh, 'uname -z'), /uname: invalid option -- 'z'/);
  assert.match(out(sh, 'cat /proc/version'), /^Linux version 6\.12\.0-55\.el10\.x86_64 \(mockbuild@/);

  const cmdline = `BOOT_IMAGE=(hd0,gpt2)/vmlinuz-${OLD} root=/dev/mapper/rhel-root ro ${DEFAULT_KERNEL_ARGS}\n`;
  assert.equal(out(sh, 'cat /proc/cmdline'), cmdline);

  const grub = out(sh, 'cat /etc/default/grub');
  for (const line of ['GRUB_TIMEOUT=5', 'GRUB_DISTRIBUTOR=', 'GRUB_DEFAULT=saved', 'GRUB_DISABLE_SUBMENU=true', 'GRUB_TERMINAL_OUTPUT="console"', `GRUB_CMDLINE_LINUX="crashkernel=`, 'resume=/dev/mapper/rhel-swap rd.lvm.lv=rhel/root rd.lvm.lv=rhel/swap"', 'GRUB_DISABLE_RECOVERY="true"', 'GRUB_ENABLE_BLSCFG=true']) {
    assert.ok(grub.includes(line), line);
  }

  const entry = file(sh, ENTRY)!;
  assert.match(entry, new RegExp(`^title Red Hat Enterprise Linux \\(${OLD.replace(/\./g, '\\.')}\\) 10\\.0 \\(Coughlan\\)$`, 'm'));
  assert.match(entry, new RegExp(`^version ${OLD}$`, 'm'));
  assert.match(entry, new RegExp(`^linux /vmlinuz-${OLD}$`, 'm'));
  assert.match(entry, new RegExp(`^initrd /initramfs-${OLD}\\.img$`, 'm'));
  assert.match(entry, /^options root=\/dev\/mapper\/rhel-root ro crashkernel=/m);
  for (const p of [`/boot/vmlinuz-${OLD}`, `/boot/initramfs-${OLD}.img`, '/boot/grub2/grub.cfg', '/boot/grub2/grubenv', '/etc/modprobe.d', '/etc/modules-load.d', `/usr/lib/modules/${OLD}/kernel/fs/xfs/xfs.ko.xz`, `/lib/modules/${OLD}/modules.dep`, '/etc/sysctl.d/99-sysctl.conf']) {
    assert.ok(nodeAt(sh.state.root, p), p);
  }
  assert.match(file(sh, `/usr/lib/modules/${OLD}/modules.dep`)!, /^kernel\/fs\/xfs\/xfs\.ko\.xz: kernel\/lib\/libcrc32c\.ko\.xz$/m);
  assert.match(out(sh, 'ls /boot/grub2'), /Permission denied/);
  assert.match(out(sh, 'sudo ls /boot'), /vmlinuz-6\.12\.0-55\.el10\.x86_64/);
  assert.equal(readGrubenv(sh.state.root).saved_entry, `${MACHINE_ID}-${OLD}`);
  assert.equal(file(sh, '/boot/grub2/grubenv')!.length, 1024);
  assert.equal(defaultBootEntry(sh.state)?.version, OLD);
  assert.equal(sh.state.kernel.running, OLD);
  assert.deepEqual(sh.state.kernel.installed, [OLD]);
});

test('rpm -q kernel and friends', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'rpm -q kernel'), `kernel-${OLD}\n`);
  assert.equal(out(sh, 'rpm -q kernel-core'), `kernel-core-${OLD}\n`);
  assert.equal(out(sh, 'rpm -qa kernel'), `kernel-${OLD}\n`);
  assert.equal(out(sh, "rpm -qa 'kernel*'").split('\n').filter(Boolean).length, 4);
  assert.match(out(sh, 'rpm -q kernel-6.12.0-1.el10'), /package kernel-6\.12\.0-1\.el10 is not installed/);
  assert.match(out(sh, 'rpm -q --last kernel'), /^kernel-6\.12\.0-55\.el10\.x86_64 +\w{3} \d{2} \w{3} \d{4} /);
  assert.match(out(sh, 'rpm -qi kernel'), /Name {8}: kernel\nVersion {5}: 6\.12\.0\nRelease {5}: 55\.el10\n/);
  assert.equal(out(sh, `rpm -qf /boot/vmlinuz-${OLD}`), `kernel-core-${OLD}\n`);
  assert.equal(out(sh, `rpm -qf /lib/modules/${OLD}/kernel/fs/xfs/xfs.ko.xz`), `kernel-modules-core-${OLD}\n`);
  assert.equal(out(sh, 'rpm -ql kernel'), '(contains no files)\n');
  // other packages still go to the normal rpm
  assert.match(out(sh, 'rpm -q bash'), /^bash-/);
  // rpm -qa is the normal list plus the kernel packages
  const qa = out(sh, 'rpm -qa');
  assert.match(qa, /^bash-/m);
  assert.match(qa, /^kernel-core-6\.12\.0-55\.el10\.x86_64$/m);
  assert.equal(out(sh, 'rpm -qa | grep ^kernel-6'), `kernel-${OLD}\n`);
  assert.deepEqual(parseKernelPkg('kernel-modules-core-6.12.0-124.el10.x86_64'), { pkg: 'kernel-modules-core', release: NEW });
  assert.deepEqual(parseKernelPkg('kernel'), { pkg: 'kernel', release: null });
  assert.equal(parseKernelPkg('kernel-devel'), null);
});

test('grubby shows the boot entries', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'sudo grubby --default-kernel'), `/boot/vmlinuz-${OLD}\n`);
  assert.equal(out(sh, 'sudo grubby --default-index'), '0\n');
  assert.equal(out(sh, 'sudo grubby --default-title'), `Red Hat Enterprise Linux (${OLD}) 10.0 (Coughlan)\n`);
  const info = out(sh, 'sudo grubby --info=ALL');
  assert.match(info, new RegExp(`^index=0\nkernel="/boot/vmlinuz-${OLD}"\nargs="ro crashkernel=[^"]+ rd\\.lvm\\.lv=rhel/swap"\nroot="/dev/mapper/rhel-root"\ninitrd="/boot/initramfs-${OLD}\\.img"\ntitle="[^"]+"\nid="${MACHINE_ID}-${OLD}"\n`));
  assert.match(info, /index=1\nkernel="\/boot\/vmlinuz-0-rescue-/);
  assert.match(out(sh, `sudo grubby --info=/boot/vmlinuz-${OLD}`), /^index=0\n/);
  assert.match(out(sh, 'sudo grubby --info=DEFAULT'), /^index=0\n/);
  assert.match(out(sh, 'sudo grubby --info=/boot/vmlinuz-nope'), /^The param \/boot\/vmlinuz-nope is incorrect\n$/);
  assert.match(out(sh, 'grubby --frobnicate'), /grubby: bad argument --frobnicate: unknown option/);
  assert.match(out(sh, 'grubby'), /Usage: grubby/);
  assert.equal(bootEntries(sh.state).length, 2);
});

test('dnf installs a new kernel next to the old one, and reboot starts it', () => {
  const sh = new Shell();
  assert.match(out(sh, 'dnf check-update'), /kernel\.x86_64 +6\.12\.0-124\.el10 +rhel-10-for-x86_64-baseos-rpms/);
  assert.equal(sh.lastCode, 100);
  assert.match(out(sh, 'dnf update kernel'), /has to be run with superuser privileges/);
  assert.match(out(sh, 'dnf install kernel'), /has to be run with superuser privileges/);
  assert.match(out(sh, 'dnf list kernel'), /Installed packages\nkernel\.x86_64 +6\.12\.0-55\.el10 +anaconda\n\nAvailable packages\nkernel\.x86_64 +6\.12\.0-124\.el10/);

  const res = out(sh, 'sudo dnf update -y kernel');
  assert.match(res, /Installing:\n kernel +x86_64 6\.12\.0-124\.el10 /);
  assert.match(res, /kernel-core +x86_64 6\.12\.0-124\.el10/);
  assert.match(res, /Complete!/);
  assert.doesNotMatch(res, /Removing:/);
  assert.equal(out(sh, 'rpm -q kernel'), `kernel-${OLD}\nkernel-${NEW}\n`);
  assert.ok(nodeAt(sh.state.root, `/boot/vmlinuz-${NEW}`));
  assert.ok(nodeAt(sh.state.root, `/usr/lib/modules/${NEW}/kernel/drivers/block/loop.ko.xz`));
  assert.match(file(sh, NEW_ENTRY)!, /^options root=\/dev\/mapper\/rhel-root ro crashkernel=/m);
  // the new kernel is the default, but the old one keeps running until a reboot
  assert.equal(out(sh, 'sudo grubby --default-kernel'), `/boot/vmlinuz-${NEW}\n`);
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);
  assert.match(out(sh, 'cat /proc/cmdline'), /vmlinuz-6\.12\.0-55\.el10/);
  assert.equal(bootEntries(sh.state)[0].version, NEW);

  assert.match(out(sh, 'sudo dnf update kernel'), /Nothing to do\./);
  assert.match(out(sh, 'sudo dnf install kernel'), /Package "kernel-6\.12\.0-124\.el10\.x86_64" is already installed\./);
  assert.match(out(sh, 'sudo dnf update'), /Nothing to do\./);
  assert.equal(out(sh, 'dnf check-update'), 'Updating and loading repositories:\nRepositories loaded.\n');
  // normal packages still go through dnf
  assert.match(out(sh, 'sudo dnf install -y tmux'), /Installing: tmux/);

  assert.match(out(sh, 'sudo reboot'), /Practice server rebooted: kernel 6\.12\.0-124\.el10\.x86_64, target multi-user\.target/);
  assert.equal(out(sh, 'uname -r'), `${NEW}\n`);
  assert.equal(sh.state.kernel.boots, 1);
  assert.match(out(sh, 'cat /proc/cmdline'), /^BOOT_IMAGE=\(hd0,gpt2\)\/vmlinuz-6\.12\.0-124\.el10\.x86_64 root=/);

  // the running kernel is protected; the old one can go
  assert.match(out(sh, 'sudo dnf remove kernel-6.12.0-124.el10'), /removing of running kernel: kernel-core-6\.12\.0-124\.el10\.x86_64/);
  assert.match(out(sh, 'sudo dnf remove kernel'), /removing of running kernel/);
  assert.match(out(sh, 'sudo dnf remove -y kernel-6.12.0-55.el10'), /Removing:\n kernel +x86_64 6\.12\.0-55\.el10 +@System/);
  assert.equal(out(sh, 'rpm -q kernel'), `kernel-${NEW}\n`);
  assert.equal(nodeAt(sh.state.root, `/boot/vmlinuz-${OLD}`), null);
  assert.equal(nodeAt(sh.state.root, ENTRY), null);
  assert.equal(nodeAt(sh.state.root, `/usr/lib/modules/${OLD}`), null);
  assert.match(out(sh, 'sudo dnf remove kernel-6.12.0-1.el10'), /No packages to remove for argument/);
});

test('dnf update without packages installs the kernel; -x kernel* skips it', () => {
  const sh = new Shell();
  assert.match(out(sh, 'sudo dnf update -x kernel*'), /Nothing to do/);
  assert.deepEqual(sh.state.kernel.installed, [OLD]);
  assert.match(out(sh, 'dnf update'), /superuser privileges/);
  assert.match(out(sh, 'sudo dnf upgrade -y'), /Installing:\n kernel /);
  assert.deepEqual(sh.state.kernel.installed, [OLD, NEW]);
  assert.match(out(sh, 'sudo dnf install kernel-6.12.0-999.el10'), /No match for argument: kernel-6\.12\.0-999\.el10/);
});

test('installonly_limit keeps three kernels and never removes the running one', () => {
  const sh = new Shell();
  installKernel(sh.state, '6.12.0-10.el10.x86_64');
  installKernel(sh.state, '6.12.0-31.el10.x86_64');
  sh.state.kernel.running = '6.12.0-10.el10.x86_64'; // booted the oldest one
  assert.deepEqual(sh.state.kernel.installed, ['6.12.0-10.el10.x86_64', '6.12.0-31.el10.x86_64', OLD]);
  const res = out(sh, 'sudo dnf update -y kernel');
  assert.match(res, /Removing:\n kernel +x86_64 6\.12\.0-31\.el10 +@System/);
  assert.match(res, /installonly_limit=3/);
  assert.deepEqual(sh.state.kernel.installed, ['6.12.0-10.el10.x86_64', OLD, NEW]);
  assert.equal(bootEntries(sh.state).filter((e) => e.version.startsWith('6.12.0-31')).length, 0);

  // installonly_limit=2 in dnf.conf
  const sh2 = new Shell();
  out(sh2, "sudo sed -i 's/installonly_limit=3/installonly_limit=2/' /etc/dnf/dnf.conf");
  installKernel(sh2.state, '6.12.0-31.el10.x86_64');
  out(sh2, 'sudo dnf update -y kernel');
  assert.deepEqual(sh2.state.kernel.installed, [OLD, NEW]);
});

test('UPDATEDEFAULT=no keeps the old default entry', () => {
  const sh = new Shell();
  out(sh, "sudo sed -i 's/UPDATEDEFAULT=yes/UPDATEDEFAULT=no/' /etc/sysconfig/kernel");
  out(sh, 'sudo dnf install -y kernel');
  assert.equal(out(sh, 'sudo grubby --default-kernel'), `/boot/vmlinuz-${OLD}\n`);
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);
});

test('grubby changes kernel arguments; /proc/cmdline follows after a reboot', () => {
  const sh = new Shell();
  out(sh, 'sudo dnf install -y kernel');
  assert.match(out(sh, 'grubby --update-kernel=ALL --args=quiet'), /grubby: Permission denied/);
  assert.equal(out(sh, 'sudo grubby --update-kernel=ALL --args="audit=1 quiet"'), '');
  for (const e of bootEntries(sh.state)) {
    assert.ok(entryHasArg(e, 'audit=1') && entryHasArg(e, 'quiet'), e.id);
  }
  assert.match(file(sh, '/etc/default/grub')!, /^GRUB_CMDLINE_LINUX="crashkernel=\S+ resume=\/dev\/mapper\/rhel-swap rd\.lvm\.lv=rhel\/root rd\.lvm\.lv=rhel\/swap audit=1 quiet"$/m);
  assert.doesNotMatch(out(sh, 'cat /proc/cmdline'), /audit=1/);
  out(sh, 'sudo reboot');
  assert.match(out(sh, 'cat /proc/cmdline'), /rd\.lvm\.lv=rhel\/swap audit=1 quiet\n$/);

  // key=value replaces the old value; --remove-args takes keys or exact words
  out(sh, 'sudo grubby --update-kernel=ALL --args=audit=0 --remove-args=quiet');
  const def = defaultBootEntry(sh.state)!;
  assert.ok(entryHasArg(def, 'audit=0'));
  assert.ok(!entryHasArg(def, 'audit=1') && !entryHasArg(def, 'quiet'));
  out(sh, 'sudo grubby --update-kernel=ALL --remove-args=crashkernel');
  assert.ok(!entryHasArg(defaultBootEntry(sh.state)!, 'crashkernel'));
  assert.doesNotMatch(file(sh, '/etc/default/grub')!, /crashkernel/);

  // one kernel only: DEFAULT, a path or an index; /etc/default/grub stays as it was
  out(sh, 'sudo grubby --update-kernel=DEFAULT --args=nomodeset');
  out(sh, `sudo grubby --update-kernel=/boot/vmlinuz-${OLD} --args=console=ttyS0,115200`);
  const [newest, older] = bootEntries(sh.state);
  assert.ok(entryHasArg(newest, 'nomodeset') && !entryHasArg(older, 'nomodeset'));
  assert.ok(entryHasArg(older, 'console=ttyS0,115200') && !entryHasArg(newest, 'console'));
  assert.doesNotMatch(file(sh, '/etc/default/grub')!, /nomodeset|console=/);
  assert.match(out(sh, 'sudo grubby --update-kernel=/boot/vmlinuz-nope --args=x'), /The param \/boot\/vmlinuz-nope is incorrect/);
  out(sh, 'sudo grubby --update-kernel=ALL --args=quiet --no-etc-grub-update');
  assert.doesNotMatch(file(sh, '/etc/default/grub')!, /quiet/);

  assert.equal(updatedOptions('a b=1 c', ['c'], ['b=2', 'd']), 'a b=2 d');
});

test('editing /etc/default/grub needs grub2-mkconfig --update-bls-cmdline', () => {
  const sh = new Shell();
  out(sh, `sudo sed -i 's/^GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="console=ttyS0 /' /etc/default/grub`);
  assert.match(file(sh, '/etc/default/grub')!, /GRUB_CMDLINE_LINUX="console=ttyS0 crashkernel/);

  assert.match(out(sh, 'grub2-mkconfig -o /boot/grub2/grub.cfg'), /^grub2-mkconfig: You must run this as root\n$/);
  assert.equal(
    out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg'),
    'Generating grub configuration file ...\nAdding boot menu entry for UEFI Firmware Settings ...\ndone\n',
  );
  // without --update-bls-cmdline the boot entries keep their old arguments
  assert.ok(!entryHasArg(defaultBootEntry(sh.state)!, 'console'));
  out(sh, 'sudo reboot');
  assert.doesNotMatch(out(sh, 'cat /proc/cmdline'), /console=ttyS0/);

  out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg --update-bls-cmdline');
  for (const e of bootEntries(sh.state)) {
    assert.match(e.options, /^root=\/dev\/mapper\/rhel-root ro console=ttyS0 crashkernel=\S+ resume=\/dev\/mapper\/rhel-swap rd\.lvm\.lv=rhel\/root rd\.lvm\.lv=rhel\/swap$/, e.id);
  }
  assert.doesNotMatch(out(sh, 'cat /proc/cmdline'), /console=ttyS0/);
  out(sh, 'sudo reboot');
  assert.match(out(sh, 'cat /proc/cmdline'), /ro console=ttyS0 crashkernel=/);
  // new kernels copy the arguments of the default entry
  out(sh, 'sudo dnf install -y kernel');
  assert.ok(entryHasArg(defaultBootEntry(sh.state)!, 'console=ttyS0'));
});

test('grub2-mkconfig regenerates grub.cfg and refuses the EFI wrapper', () => {
  const sh = new Shell();
  assert.match(file(sh, '/boot/grub2/grub.cfg')!, /set timeout=5\n/);
  out(sh, "sudo sed -i 's/GRUB_TIMEOUT=5/GRUB_TIMEOUT=10/' /etc/default/grub");
  out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg');
  assert.match(file(sh, '/boot/grub2/grub.cfg')!, /set timeout=10\n/);
  assert.match(file(sh, '/boot/grub2/grub.cfg')!, /set default="\$\{saved_entry\}"/);

  const wrapper = file(sh, '/boot/efi/EFI/redhat/grub.cfg');
  assert.equal(
    out(sh, 'sudo grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg'),
    "Running `grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg' will overwrite the GRUB wrapper.\nPlease run `grub2-mkconfig -o /boot/grub2/grub.cfg' instead to update grub.cfg.\nGRUB configuration file was not updated.\n",
  );
  assert.equal(file(sh, '/boot/efi/EFI/redhat/grub.cfg'), wrapper);
  // without -o it prints the configuration
  assert.match(out(sh, 'sudo grub2-mkconfig'), /### BEGIN \/etc\/grub\.d\/10_linux ###\n[\s\S]*blscfg/);

  // a broken /etc/default/grub stops it before anything is written
  const before = file(sh, '/boot/grub2/grub.cfg');
  out(sh, 'echo \'GRUB_TIMEOUT="3\' | sudo tee -a /etc/default/grub');
  assert.match(out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg'), /\/etc\/default\/grub: line 9: unexpected EOF while looking for matching `"'/);
  assert.equal(file(sh, '/boot/grub2/grub.cfg'), before);
});

test('GRUB_DEFAULT with a menu index wins over saved_entry after grub2-mkconfig', () => {
  const sh = new Shell();
  out(sh, 'sudo dnf install -y kernel'); // entries: 0 = new kernel, 1 = old kernel, 2 = rescue
  out(sh, "sudo sed -i 's/GRUB_DEFAULT=saved/GRUB_DEFAULT=1/' /etc/default/grub");
  out(sh, 'sudo reboot'); // grub.cfg not regenerated yet: still the saved entry
  assert.equal(out(sh, 'uname -r'), `${NEW}\n`);
  out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);
});

test('choosing the default boot entry: grubby, grub2-set-default, grub2-reboot', () => {
  const sh = new Shell();
  out(sh, 'sudo dnf install -y kernel');
  assert.match(out(sh, `grubby --set-default=/boot/vmlinuz-${OLD}`), /Permission denied/);
  assert.equal(
    out(sh, `sudo grubby --set-default=/boot/vmlinuz-${OLD}`),
    `The default is ${ENTRY} with index 1 and kernel /boot/vmlinuz-${OLD}\n`,
  );
  assert.equal(out(sh, 'sudo grubby --default-index'), '1\n');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);

  assert.match(out(sh, 'sudo grubby --set-default-index=0'), /with index 0 and kernel \/boot\/vmlinuz-6\.12\.0-124/);
  assert.match(out(sh, 'sudo grubby --set-default-index=7'), /The param 7 is incorrect/);
  assert.match(out(sh, 'sudo grubby --set-default=/boot/vmlinuz-x'), /The param \/boot\/vmlinuz-x is incorrect/);
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${NEW}\n`);

  // grub2-set-default stores a menu index or id in saved_entry
  assert.match(out(sh, 'grub2-set-default 1'), /grub2-editenv: error: cannot open `\/boot\/grub2\/grubenv\.new': Permission denied\./);
  out(sh, 'sudo grub2-set-default 1');
  assert.equal(out(sh, 'sudo grubby --default-kernel'), `/boot/vmlinuz-${OLD}\n`);
  assert.match(out(sh, 'sudo grub2-editenv list'), /^saved_entry=1$/m);
  assert.match(out(sh, 'grub2-editenv list'), /Permission denied/);
  out(sh, `sudo grub2-set-default ${MACHINE_ID}-${NEW}`);
  assert.equal(out(sh, 'sudo grubby --default-kernel'), `/boot/vmlinuz-${NEW}\n`);

  // grub2-reboot: once only
  out(sh, 'sudo grub2-reboot 1');
  assert.equal(readGrubenv(sh.state.root).next_entry, '1');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);
  assert.equal(readGrubenv(sh.state.root).next_entry, undefined);
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${NEW}\n`);

  out(sh, 'sudo grub2-editenv - set menu_auto_hide=0');
  assert.equal(readGrubenv(sh.state.root).menu_auto_hide, '0');
  out(sh, 'sudo grub2-editenv - unset menu_auto_hide');
  assert.equal(readGrubenv(sh.state.root).menu_auto_hide, undefined);
});

test('lsmod, modprobe and modprobe -r with dependencies', () => {
  const sh = new Shell();
  const ls = out(sh, 'lsmod');
  assert.match(ls, /^Module {18}Size {2}Used by\n/);
  assert.match(ls, /^xfs {18}2797568 {2}2$/m);
  assert.match(ls, /^libcrc32c +\d+ {2}3 [\w,]*xfs/m);
  assert.match(ls, /^fat +\d+ {2}1 vfat$/m);
  assert.ok(!isLoaded(sh.state, 'loop'));

  assert.equal(out(sh, 'modprobe loop'), "modprobe: ERROR: could not insert 'loop': Operation not permitted\n");
  assert.equal(out(sh, 'sudo modprobe loop'), '');
  assert.ok(isLoaded(sh.state, 'loop'));
  assert.match(out(sh, 'lsmod | grep loop'), /^loop +45056 {2}0\n$/);
  assert.match(out(sh, 'cat /proc/modules'), /^loop 45056 0 - Live 0x0000000000000000$/m);
  assert.match(out(sh, 'dmesg'), /loop: module loaded\n$/);
  assert.equal(out(sh, 'sudo modprobe loop'), ''); // already loaded: nothing to do
  assert.equal(out(sh, 'sudo modprobe dm-mod'), '');

  const v = out(sh, 'sudo modprobe -v btusb');
  assert.deepEqual(v.trim().split('\n').map((l) => l.split('/').pop()), ['rfkill.ko.xz', 'bluetooth.ko.xz', 'btintel.ko.xz', 'btrtl.ko.xz', 'btusb.ko.xz']);
  assert.match(v, /^insmod \/lib\/modules\/6\.12\.0-55\.el10\.x86_64\/kernel\/net\/rfkill\/rfkill\.ko\.xz$/m);
  assert.match(out(sh, 'lsmod'), /^bluetooth +\d+ {2}3 btintel,btrtl,btusb$/m);
  assert.match(out(sh, 'modprobe -r btusb'), /could not remove 'btusb': Operation not permitted/);
  assert.equal(out(sh, 'sudo modprobe -rv btusb'), 'rmmod btusb\nrmmod btrtl\nrmmod btintel\nrmmod bluetooth\nrmmod rfkill\n');
  assert.ok(!isLoaded(sh.state, 'bluetooth') && !isLoaded(sh.state, 'rfkill'));

  assert.equal(out(sh, 'sudo modprobe -r xfs'), 'modprobe: FATAL: Module xfs is in use.\n');
  assert.equal(out(sh, 'sudo modprobe -r fat'), 'modprobe: FATAL: Module fat is in use.\n');
  assert.equal(out(sh, 'sudo modprobe -r usb_storage'), 'modprobe: FATAL: Module usb_storage is not in kernel.\n');
  assert.equal(out(sh, 'sudo modprobe -r nosuchmod'), 'modprobe: FATAL: Module nosuchmod not found.\n');
  assert.equal(out(sh, 'sudo modprobe btrfs'), `modprobe: FATAL: Module btrfs not found in directory /lib/modules/${OLD}\n`);
  assert.equal(sh.lastCode, 1);
  assert.equal(out(sh, 'modprobe'), 'modprobe: ERROR: missing parameters. See -h.\n');

  // dry run and --show-depends load nothing
  assert.match(out(sh, 'sudo modprobe -nv ext4'), /mbcache\.ko\.xz\ninsmod .*jbd2\.ko\.xz\ninsmod .*ext4\.ko\.xz\n$/);
  assert.ok(!isLoaded(sh.state, 'ext4'));
  assert.match(out(sh, 'modprobe --show-depends uas'), /usb-storage\.ko\.xz\ninsmod .*uas\.ko\.xz\n$/);
  assert.ok(!isLoaded(sh.state, 'uas'));
  // -a loads several
  out(sh, 'sudo modprobe -a overlay isofs');
  assert.ok(isLoaded(sh.state, 'overlay') && isLoaded(sh.state, 'isofs'));
  assert.deepEqual(moduleDeps('dm_mirror'), ['dm_mod', 'dm_log', 'dm_region_hash', 'dm_mirror']);
});

test('rmmod and insmod work on one module, without dependencies', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'sudo rmmod fat'), 'rmmod: ERROR: Module fat is in use by: vfat\n');
  assert.equal(out(sh, 'sudo rmmod xfs'), 'rmmod: ERROR: Module xfs is in use\n');
  assert.equal(out(sh, 'sudo rmmod loop'), 'rmmod: ERROR: Module loop is not currently loaded\n');
  const dir = `/lib/modules/${OLD}/kernel`;
  assert.match(out(sh, `sudo insmod ${dir}/drivers/bluetooth/btusb.ko.xz`), /could not insert module .*btusb\.ko\.xz: Unknown symbol in module/);
  assert.match(out(sh, 'sudo insmod loop'), /insmod: ERROR: could not load module loop: No such file or directory/);
  assert.match(out(sh, `insmod ${dir}/drivers/block/loop.ko.xz`), /Operation not permitted/);
  assert.equal(out(sh, `sudo insmod ${dir}/drivers/block/loop.ko.xz max_loop=4`), '');
  assert.equal(moduleParam(sh.state, 'loop', 'max_loop'), '4');
  assert.match(out(sh, `sudo insmod ${dir}/drivers/block/loop.ko.xz`), /File exists/);
  assert.match(out(sh, 'rmmod loop'), /could not remove module loop: Operation not permitted/);
  assert.equal(out(sh, 'sudo rmmod loop'), '');
  assert.ok(!isLoaded(sh.state, 'loop'));
  assert.match(out(sh, 'sudo insmod /etc/hostname'), /Invalid module format/);
});

test('modinfo shows file, description, depends and parameters', () => {
  const sh = new Shell();
  const info = out(sh, 'modinfo loop');
  assert.match(info, new RegExp(`^filename: {7}/lib/modules/${OLD}/kernel/drivers/block/loop\\.ko\\.xz\n`));
  assert.match(info, /^description: {4}Loopback device support$/m);
  assert.match(info, /^license: {8}GPL$/m);
  assert.match(info, /^name: {11}loop$/m);
  assert.match(info, /^parm: {11}max_loop:Maximum number of loop devices \(int\)$/m);
  assert.equal(out(sh, 'modinfo -F depends dm_mirror'), 'dm-region-hash,dm-log,dm-mod\n');
  assert.equal(out(sh, 'modinfo -p kvm_intel'), 'nested:bool\nept:bool\nenable_apicv:bool\n');
  assert.equal(out(sh, 'modinfo -d xfs'), 'SGI XFS with ACLs, security attributes, scrub, quota, no debug enabled\n');
  assert.match(out(sh, 'modinfo dm-mod'), /^name: {11}dm_mod$/m);
  assert.equal(out(sh, 'modinfo nosuch'), 'modinfo: ERROR: Module nosuch not found.\n');
  assert.equal(sh.lastCode, 1);
  assert.match(out(sh, `modinfo /lib/modules/${OLD}/kernel/fs/ext4/ext4.ko.xz`), /^depends: {8}mbcache,jbd2$/m);
});

test('module parameters: options lines, the command line and bad values', () => {
  const sh = new Shell();
  out(sh, 'sudo modprobe loop max_loop=8');
  assert.equal(out(sh, 'cat /sys/module/loop/parameters/max_loop'), '8\n');
  assert.equal(moduleParam(sh.state, 'loop', 'max_part'), '0');
  out(sh, 'sudo modprobe -r loop');
  assert.equal(nodeAt(sh.state.root, '/sys/module/loop'), null);

  out(sh, 'echo "options loop max_loop=16 max_part=2" | sudo tee /etc/modprobe.d/loop.conf');
  out(sh, 'sudo modprobe loop');
  assert.equal(moduleParam(sh.state, 'loop', 'max_loop'), '16');
  assert.equal(moduleParam(sh.state, 'loop', 'max_part'), '2');
  assert.match(out(sh, 'modprobe -c'), /^options loop max_loop=16 max_part=2$/m);
  out(sh, 'sudo modprobe -r loop');
  out(sh, 'sudo modprobe loop max_loop=32'); // the command line wins over the file
  assert.equal(moduleParam(sh.state, 'loop', 'max_loop'), '32');
  out(sh, 'sudo modprobe -r loop');

  assert.equal(out(sh, 'sudo modprobe loop max_loop=lots'), "modprobe: ERROR: could not insert 'loop': Invalid argument\n");
  assert.ok(!isLoaded(sh.state, 'loop'));
  assert.match(out(sh, 'sudo dmesg -l err'), /loop: `lots' invalid for parameter `max_loop'/);
  assert.equal(out(sh, 'sudo modprobe loop colour=blue'), '');
  assert.match(out(sh, 'dmesg -l warn'), /loop: unknown parameter 'colour' ignored/);

  // bool parameters show as Y/N
  out(sh, 'echo "options kvm_intel nested=0" | sudo tee /etc/modprobe.d/kvm.conf');
  out(sh, 'sudo modprobe kvm_intel');
  assert.equal(out(sh, 'cat /sys/module/kvm_intel/parameters/nested'), 'N\n');
  assert.ok(isLoaded(sh.state, 'kvm') && isLoaded(sh.state, 'irqbypass'));
});

test('blacklist, install and modules-load.d decide what loads at boot', () => {
  const sh = new Shell();
  assert.ok(isLoaded(sh.state, 'sg'));
  out(sh, 'echo "blacklist sg" | sudo tee /etc/modprobe.d/blacklist-sg.conf');
  out(sh, 'echo "install usb_storage /bin/false" | sudo tee /etc/modprobe.d/usb.conf');
  out(sh, 'echo "install bluetooth /bin/true" | sudo tee /etc/modprobe.d/bt.conf');
  out(sh, 'echo "options loop max_loop=16" | sudo tee /etc/modprobe.d/loop.conf');
  out(sh, 'echo loop | sudo tee /etc/modules-load.d/practice.conf');
  for (const line of ['# comment', 'br_netfilter', 'usb_storage', 'sg', 'nosuchmodule']) {
    out(sh, `echo "${line}" | sudo tee -a /etc/modules-load.d/practice.conf`);
  }
  // nothing changes until the next boot
  assert.ok(isLoaded(sh.state, 'sg') && !isLoaded(sh.state, 'loop'));
  out(sh, 'sudo reboot');
  assert.ok(isLoaded(sh.state, 'loop'));
  assert.equal(moduleParam(sh.state, 'loop', 'max_loop'), '16');
  assert.ok(isLoaded(sh.state, 'br_netfilter') && isLoaded(sh.state, 'bridge'));
  assert.ok(!isLoaded(sh.state, 'sg'), 'blacklisted module stays out');
  assert.ok(!isLoaded(sh.state, 'usb_storage'), 'install /bin/false stays out');
  const log = file(sh, '/var/log/messages')!;
  assert.match(log, /systemd-modules-load\[512\]: Failed to find module 'nosuchmodule'/);
  assert.match(log, /systemd-modules-load\[512\]: Module 'sg' is deny-listed \(by kmod\)/);
  assert.match(log, /systemd-modules-load\[512\]: Inserted module 'loop'/);

  // a blacklist line does not stop an explicit modprobe (but -b honours it); install does
  assert.equal(out(sh, 'sudo modprobe -b sg'), '');
  assert.ok(!isLoaded(sh.state, 'sg'));
  assert.equal(out(sh, 'sudo modprobe sg'), '');
  assert.ok(isLoaded(sh.state, 'sg'));
  assert.equal(
    out(sh, 'sudo modprobe usb-storage'),
    "modprobe: ERROR: ../libkmod/libkmod-module.c:1094 command_do() Error running install command '/bin/false' for module usb_storage: retcode 1\nmodprobe: ERROR: could not insert 'usb_storage': Operation not permitted\n",
  );
  assert.equal(out(sh, 'sudo modprobe bluetooth'), '');
  assert.ok(!isLoaded(sh.state, 'bluetooth'), 'install /bin/true loads nothing');
  assert.equal(out(sh, 'sudo modprobe -i usb_storage'), '');
  assert.ok(isLoaded(sh.state, 'usb_storage'), '-i ignores install commands');
});

test('kernel arguments for modules: NAME.param= and module_blacklist=', () => {
  const sh = new Shell();
  out(sh, 'echo loop | sudo tee /etc/modules-load.d/loop.conf');
  out(sh, 'echo "options loop max_loop=16" | sudo tee /etc/modprobe.d/loop.conf');
  out(sh, 'sudo grubby --update-kernel=ALL --args="loop.max_loop=4 module_blacklist=e1000e modprobe.blacklist=sg"');
  out(sh, 'sudo reboot');
  assert.equal(moduleParam(sh.state, 'loop', 'max_loop'), '4');
  assert.ok(!isLoaded(sh.state, 'sg'));
  assert.equal(out(sh, 'sudo modprobe e1000e'), "modprobe: ERROR: could not insert 'e1000e': Operation not permitted\n");
  assert.equal(out(sh, 'sudo modprobe sg'), '');
});

test('sysctl reads and writes /proc/sys; files in /etc/sysctl.d apply at boot', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'sysctl vm.swappiness'), 'vm.swappiness = 30\n');
  assert.equal(out(sh, 'sysctl -n net.ipv4.ip_forward'), '0\n');
  assert.equal(out(sh, 'sysctl net/ipv4/ip_forward'), 'net.ipv4.ip_forward = 0\n');
  assert.equal(out(sh, 'cat /proc/sys/vm/swappiness'), '30\n');
  assert.equal(out(sh, 'sysctl -w vm.swappiness=10'), 'sysctl: permission denied on key "vm.swappiness"\n');
  assert.equal(out(sh, 'sudo sysctl -w vm.swappiness=10'), 'vm.swappiness = 10\n');
  assert.equal(out(sh, 'sudo sysctl net.ipv4.ip_forward=1'), 'net.ipv4.ip_forward = 1\n');
  assert.equal(sysctlValue(sh.state, 'vm.swappiness'), '10');
  assert.equal(out(sh, 'sudo sysctl -w vm.swappiness=lots'), 'sysctl: setting key "vm.swappiness": Invalid argument\n');
  assert.equal(out(sh, 'sudo sysctl -w kernel.osrelease=1'), 'sysctl: permission denied on key "kernel.osrelease"\n');
  assert.equal(out(sh, 'sysctl kernel.osrelease'), `kernel.osrelease = ${OLD}\n`);
  assert.equal(out(sh, 'sysctl net.ipv4.nope'), 'sysctl: cannot stat /proc/sys/net/ipv4/nope: No such file or directory\n');
  assert.equal(sh.lastCode, 255);
  assert.equal(out(sh, 'sudo sysctl -w net.ipv4.ip_forward'), 'sysctl: "net.ipv4.ip_forward" must be of the form name=value\n');
  out(sh, 'echo 1 | sudo tee /proc/sys/net/ipv4/icmp_echo_ignore_all');
  assert.equal(sysctlValue(sh.state, 'net.ipv4.icmp_echo_ignore_all'), '1');
  assert.match(out(sh, 'sysctl -a'), /^kernel\.pid_max = 4194304$/m);
  assert.match(out(sh, 'sysctl -a'), /^net\.ipv4\.ping_group_range = 0\t2147483647$/m);

  // runtime changes are lost at reboot; files in /etc/sysctl.d are applied
  out(sh, 'echo "vm.swappiness = 5" | sudo tee /etc/sysctl.d/90-swap.conf');
  assert.equal(out(sh, 'sudo sysctl -p /etc/sysctl.d/90-swap.conf'), 'vm.swappiness = 5\n');
  out(sh, 'echo "net.ipv4.ip_forward = 1" | sudo tee -a /etc/sysctl.conf');
  out(sh, 'sudo sysctl -w vm.dirty_ratio=50');
  out(sh, 'sudo reboot');
  assert.equal(sysctlValue(sh.state, 'vm.swappiness'), '5');
  assert.equal(sysctlValue(sh.state, 'net.ipv4.ip_forward'), '1', '/etc/sysctl.conf via 99-sysctl.conf');
  assert.equal(sysctlValue(sh.state, 'vm.dirty_ratio'), '30');
  assert.equal(sysctlValue(sh.state, 'net.ipv4.icmp_echo_ignore_all'), '0');

  const sys = out(sh, 'sudo sysctl --system');
  assert.match(sys, /^\* Applying \/usr\/lib\/sysctl\.d\/50-default\.conf \.\.\.$/m);
  assert.match(sys, /^\* Applying \/etc\/sysctl\.d\/90-swap\.conf \.\.\.\nvm\.swappiness = 5$/m);
  assert.match(sys, /\* Applying \/etc\/sysctl\.conf \.\.\.\nnet\.ipv4\.ip_forward = 1\n$/);
  assert.match(out(sh, 'sudo sysctl -p'), /^net\.ipv4\.ip_forward = 1\n$/);
  assert.match(out(sh, 'sudo sysctl -p /etc/sysctl.d/nope.conf'), /sysctl: cannot open "\/etc\/sysctl\.d\/nope\.conf": No such file or directory/);
});

test('bridge sysctls exist only while br_netfilter is loaded', () => {
  const sh = new Shell();
  assert.match(out(sh, 'sysctl net.bridge.bridge-nf-call-iptables'), /cannot stat \/proc\/sys\/net\/bridge\/bridge-nf-call-iptables/);
  out(sh, 'sudo modprobe br_netfilter');
  assert.equal(out(sh, 'sysctl net.bridge.bridge-nf-call-iptables'), 'net.bridge.bridge-nf-call-iptables = 1\n');
  assert.match(out(sh, 'dmesg'), /Bridge firewalling registered/);
  out(sh, 'sudo modprobe -r br_netfilter');
  assert.equal(sysctlValue(sh.state, 'net.bridge.bridge-nf-call-iptables'), null);
  assert.ok(!isLoaded(sh.state, 'bridge'));
  // at boot, modules-load.d runs before systemd-sysctl
  out(sh, 'echo br_netfilter | sudo tee /etc/modules-load.d/k8s.conf');
  out(sh, 'echo "net.bridge.bridge-nf-call-iptables = 0" | sudo tee /etc/sysctl.d/k8s.conf');
  out(sh, 'sudo reboot');
  assert.equal(sysctlValue(sh.state, 'net.bridge.bridge-nf-call-iptables'), '0');
});

test('dmesg shows the kernel ring buffer', () => {
  const sh = new Shell();
  const lines = out(sh, 'dmesg').split('\n');
  assert.match(lines[0], /^\[ {4}0\.000000\] Linux version 6\.12\.0-55\.el10\.x86_64 \(mockbuild@/);
  assert.match(lines[1], /^\[ {4}0\.000000\] Command line: BOOT_IMAGE=\(hd0,gpt2\)\/vmlinuz-6\.12\.0-55/);
  assert.match(out(sh, 'dmesg -T | head -n 1'), /^\[\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\] Linux version/);
  assert.match(out(sh, 'dmesg -x | head -n 1'), /^kern {2}:notice: \[/);
  assert.match(out(sh, 'dmesg -t | head -n 1'), /^Linux version/);
  assert.equal(out(sh, 'dmesg -l err'), '');
  assert.match(out(sh, 'dmesg -l bogus'), /dmesg: unknown level 'bogus'/);
  assert.match(out(sh, 'dmesg -C'), /klogctl failed: Operation not permitted/);
  out(sh, 'sudo sysctl -w kernel.dmesg_restrict=1');
  assert.equal(out(sh, 'dmesg'), 'dmesg: read kernel buffer failed: Operation not permitted\n');
  assert.match(out(sh, 'sudo dmesg'), /Linux version/);
  out(sh, 'sudo dmesg -C');
  assert.equal(out(sh, 'sudo dmesg'), '');
  out(sh, 'sudo reboot');
  assert.match(out(sh, 'dmesg'), /Linux version 6\.12\.0-55\.el10\.x86_64/);
});

test('reboot needs root, and logs student in again with a fresh session', () => {
  const sh = new Shell();
  const denied = "Failed to reboot system via logind: Interactive authentication required.\nFailed to start reboot.target: Interactive authentication required.\nSee system logs and 'systemctl status reboot.target' for details.\n(Hint: use sudo reboot)\n";
  assert.equal(out(sh, 'reboot'), denied);
  assert.equal(out(sh, 'systemctl reboot'), denied);
  assert.equal(out(sh, 'shutdown -r now'), denied);
  assert.equal(sh.state.kernel.boots, 0);

  out(sh, 'sudo -i');
  out(sh, 'cd /etc');
  out(sh, 'export COLOR=blue');
  const res = out(sh, 'reboot');
  assert.equal(res, `Red Hat Enterprise Linux 10.0 (Coughlan)\nKernel ${OLD} on an x86_64\n\n(Practice server rebooted: kernel ${OLD}, target multi-user.target. You are logged in as student again.)\n`);
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
  assert.equal(sh.sessions.length, 1);
  assert.equal(out(sh, 'echo $COLOR'), '\n');
  assert.match(out(sh, 'exit'), /top-level login shell/);
  assert.equal(sh.user.name, 'student');
  // sudo inside the new session still works and returns to student
  assert.equal(out(sh, 'sudo whoami'), 'root\n');
  out(sh, 'sudo -i');
  assert.equal(out(sh, 'exit'), 'logout\n');
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
  // "sudo reboot" pops the session sudo pushed after the reboot replaced them all
  out(sh, 'cd /tmp');
  out(sh, 'sudo reboot');
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
  assert.equal(sh.sessions.length, 1);
  assert.equal(sh.state.kernel.boots, 2);
  assert.ok(sh.history.includes('sudo reboot'), 'history is kept');

  assert.match(out(sh, 'sudo shutdown -r +5'), /^Reboot scheduled for \w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d EDT, use 'shutdown -c' to cancel\.\n\(Practice server: not waiting for it\.\)\nRed Hat Enterprise Linux/);
  assert.equal(sh.state.kernel.boots, 3);
  assert.match(out(sh, 'sudo shutdown -h now'), /pretending to power off/);
  assert.match(out(sh, 'poweroff'), /Failed to power off system via logind/);
  assert.match(out(sh, 'sudo shutdown -r soon'), /Failed to parse time specification: soon/);
  assert.equal(sh.state.kernel.boots, 3);
});

test('reboot throws away runtime-only changes', () => {
  const sh = new Shell();
  out(sh, 'sudo dnf install -y httpd vsftpd');
  out(sh, 'sudo systemctl start httpd');
  out(sh, 'sudo systemctl enable vsftpd');
  out(sh, 'sudo systemctl stop sshd');
  out(sh, 'sudo firewall-cmd --add-service=http');
  out(sh, 'sudo firewall-cmd --permanent --add-service=ftp');
  out(sh, 'sudo setenforce 0');
  out(sh, 'sudo nmcli con mod ens160 ipv4.addresses 10.0.0.5/24');
  out(sh, 'sudo renice -n 5 -p 901');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'systemctl is-active httpd'), 'inactive\n');
  assert.equal(out(sh, 'systemctl is-active vsftpd'), 'active\n');
  assert.equal(out(sh, 'systemctl is-active sshd'), 'active\n');
  assert.equal(out(sh, 'sudo firewall-cmd --list-services'), 'cockpit dhcpv6-client ssh ftp\n');
  assert.equal(out(sh, 'getenforce'), 'Enforcing\n');
  assert.match(out(sh, 'ip a'), /inet 10\.0\.0\.5\/24/);
  assert.equal(sh.state.processes.find((p) => p.pid === 901)?.nice, 0);
  assert.ok(!sh.state.processes.some((p) => p.cmd.startsWith('dd ')), 'the runaway dd is gone');

  out(sh, "sudo sed -i 's/^SELINUX=.*/SELINUX=permissive/' /etc/selinux/config");
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'getenforce'), 'Permissive\n');
  out(sh, "sudo sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config");
  out(sh, 'sudo grubby --update-kernel=ALL --args=enforcing=0');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'getenforce'), 'Permissive\n');
  out(sh, 'sudo grubby --update-kernel=ALL --remove-args=enforcing');

  out(sh, 'sudo touch /.autorelabel');
  assert.match(out(sh, 'sudo reboot'), /^\*\*\* Warning -- SELinux targeted policy relabel is required\./);
  assert.equal(nodeAt(sh.state.root, '/.autorelabel'), null);
  assert.equal(out(sh, 'getenforce'), 'Enforcing\n');
});

test('boot targets: default target, systemd.unit= and runlevel words', () => {
  const sh = new Shell();
  out(sh, 'sudo systemctl set-default graphical.target');
  assert.match(out(sh, 'sudo reboot'), /target graphical\.target/);
  assert.equal(sh.state.kernel.bootTarget, 'graphical.target');

  out(sh, 'sudo grubby --update-kernel=ALL --args=systemd.unit=rescue.target');
  const res = out(sh, 'sudo reboot');
  assert.match(res, /^You are in rescue mode\. After logging in, type "journalctl -xb" to view\nsystem logs, "systemctl reboot" to reboot, or "exit"\nto continue bootup\.\nGive root password for maintenance\n\(or press Control-D to continue\):\n/);
  assert.match(res, /target rescue\.target\. You are root on the console/);
  assert.equal(sh.state.kernel.bootTarget, 'rescue.target');
  assert.equal(sh.state.kernel.emergency, false);
  assert.equal(sh.prompt(), '[root@server1 ~]# ');
  assert.equal(out(sh, 'systemctl is-active sshd'), 'inactive\n');
  assert.doesNotMatch(out(sh, 'ip a'), /192\.168\.4\.100/);

  out(sh, 'grubby --update-kernel=ALL --remove-args=systemd.unit --args=emergency');
  assert.match(out(sh, 'systemctl reboot'), /You are in emergency mode/);
  assert.equal(sh.state.kernel.bootTarget, 'emergency.target');
  assert.equal(sh.state.kernel.emergency, true);

  out(sh, 'grubby --update-kernel=ALL --remove-args=emergency --args=systemd.unit=bogus.target');
  assert.match(out(sh, 'reboot'), /^Failed to load default target: Unit bogus\.target not found\.\nFalling back to rescue\.target\.\n/);
  assert.equal(sh.state.kernel.bootTarget, 'rescue.target');

  out(sh, 'grubby --update-kernel=ALL --remove-args=systemd.unit --args=3');
  out(sh, 'reboot');
  assert.equal(sh.state.kernel.bootTarget, 'multi-user.target');
  assert.equal(sh.user.name, 'student');

  out(sh, 'sudo grubby --update-kernel=ALL --remove-args=3 --args=rd.break');
  assert.match(out(sh, 'sudo reboot'), /Practice note: rd\.break stops the boot inside the initramfs/);
});

test('fstab errors at boot put the server in emergency mode until a clean reboot', () => {
  const sh = new Shell();
  const err = 'mount: /data: special device /dev/vgdata/lvdata does not exist.';
  const res = withStorage([err], () => out(sh, 'sudo reboot'));
  assert.match(res, /^mount: \/data: special device \/dev\/vgdata\/lvdata does not exist\.\n\[DEPEND\] Dependency failed for local-fs\.target - Local File Systems\.\nYou are in emergency mode\./);
  assert.match(res, /Give root password for maintenance/);
  assert.match(res, /target emergency\.target\. The boot stopped because of the errors above\./);
  assert.equal(sh.state.kernel.emergency, true);
  assert.equal(sh.state.kernel.bootTarget, 'emergency.target');
  assert.deepEqual(sh.state.kernel.bootErrors, [err]);
  assert.equal(sh.prompt(), '[root@server1 ~]# ');
  assert.match(out(sh, 'journalctl'), /systemd\[1\]: mount: \/data: special device \/dev\/vgdata\/lvdata does not exist\.\n.*Dependency failed for local-fs\.target/);

  const clean = withStorage([], () => out(sh, 'systemctl reboot'));
  assert.match(clean, /target multi-user\.target\. You are logged in as student again/);
  assert.equal(sh.state.kernel.emergency, false);
  assert.deepEqual(sh.state.kernel.bootErrors, []);
  assert.equal(sh.user.name, 'student');

  // with a locked root account sulogin refuses; the practice terminal still gives a shell
  out(sh, 'sudo usermod -L root');
  const locked = withStorage([err], () => out(sh, 'sudo reboot'));
  assert.match(locked, /Cannot open access to console, the root account is locked\.\nSee sulogin\(8\) man page for more details\.\n\nPress Enter to continue\.\n/);
  assert.match(locked, /rd\.break or init=\/bin\/bash/);
  assert.equal(sh.user.name, 'root');
});

test('GRUB falls back when kernel files are missing; dracut rebuilds the initramfs', () => {
  const sh = new Shell();
  out(sh, 'sudo dnf install -y kernel');
  out(sh, `sudo rm /boot/initramfs-${NEW}.img`);
  const res = out(sh, 'sudo reboot');
  assert.match(res, new RegExp(`^error: \\.\\./\\.\\./grub-core/fs/fshelp\\.c:257:file \`/initramfs-${NEW.replace(/\./g, '\\.')}\\.img' not found\\.\n`));
  assert.match(res, /Kernel panic - not syncing: VFS: Unable to mount root fs/);
  assert.match(res, /picked "Red Hat Enterprise Linux \(6\.12\.0-55\.el10\.x86_64\) 10\.0 \(Coughlan\)" in the GRUB menu/);
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);

  assert.match(out(sh, `dracut -f --kver ${NEW}`), /dracut\[F\]: No permission to write to \/boot\./);
  assert.equal(out(sh, `sudo dracut --kver ${NEW}`), '');
  assert.ok(nodeAt(sh.state.root, `/boot/initramfs-${NEW}.img`));
  assert.equal(out(sh, 'sudo dracut'), `dracut[F]: Will not override existing initramfs (/boot/initramfs-${OLD}.img) without --force\n`);
  assert.equal(out(sh, 'sudo dracut -f'), '');
  assert.match(out(sh, 'sudo dracut -f --kver 6.1.0-1.el10.x86_64'), /Cannot find module directory \/lib\/modules\/6\.1\.0-1\.el10\.x86_64\//);
  assert.equal(out(sh, 'sudo dracut -f --regenerate-all'), '');
  assert.match(out(sh, 'sudo dracut -fv'), /Creating initramfs image file '\/boot\/initramfs-6\.12\.0-55\.el10\.x86_64\.img' done/);
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'uname -r'), `${NEW}\n`);

  // a missing kernel image: GRUB says so and the next entry boots
  out(sh, `sudo rm /boot/vmlinuz-${NEW}`);
  assert.match(out(sh, 'sudo reboot'), /file `\/vmlinuz-6\.12\.0-124\.el10\.x86_64' not found\.\nerror: .*you need to load the kernel first\./);
  assert.equal(out(sh, 'uname -r'), `${OLD}\n`);

  // without grub.cfg GRUB stops at its prompt; grub2-mkconfig repairs it
  out(sh, 'sudo rm /boot/grub2/grub.cfg');
  const noCfg = out(sh, 'sudo reboot');
  assert.match(noCfg, /file `\/grub2\/grub\.cfg' not found\.\n\ngrub> \n\(Practice server: GRUB found no grub\.cfg/);
  assert.equal(sh.state.kernel.boots, 3);
  out(sh, 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg');
  assert.match(out(sh, 'sudo reboot'), /Practice server rebooted/);
  assert.equal(sh.state.kernel.boots, 4);

  // with no boot entries at all the practice server stays up
  out(sh, 'sudo rm -r /boot/loader/entries');
  out(sh, 'sudo mkdir /boot/loader/entries');
  assert.match(out(sh, 'sudo reboot'), /no boot loader entries found/);
  assert.equal(sh.state.kernel.running, OLD);
});

test('grub2-install refuses on UEFI without --force', () => {
  const sh = new Shell();
  assert.match(out(sh, 'sudo grub2-install /dev/nvme0n1'), /^grub2-install: error: This utility should not be used for EFI platforms because it does not support UEFI Secure Boot\./);
  assert.match(out(sh, 'sudo grub2-install /dev/nvme0n1'), /dnf reinstall grub2-efi-x64 shim-x64/);
  assert.equal(out(sh, 'sudo grub2-install --force /dev/nvme0n1'), 'Installing for x86_64-efi platform.\nInstallation finished. No error reported.\n');
});

test('kernel commands have man pages, and helpers sort versions like rpm', () => {
  const sh = new Shell();
  for (const c of ['grubby', 'grub2-mkconfig', 'modprobe', 'lsmod', 'modinfo', 'sysctl', 'dracut', 'reboot', 'dmesg']) {
    assert.match(out(sh, `man ${c}`), new RegExp(`NAME\n {7}${c} - `), c);
  }
  assert.ok(verCmp('6.12.0-124.el10.x86_64', '6.12.0-55.el10.x86_64') > 0);
  assert.ok(verCmp('0-rescue-abc', '6.12.0-55.el10.x86_64') < 0);
  assert.equal(verCmp('6.12.0-55.el10', '6.12.0-55.el10'), 0);
});

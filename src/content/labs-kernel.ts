import {
  UPDATE_KERNEL,
  type BootEntry,
  bootEntries,
  defaultBootEntry,
  entryHasArg,
  insertModule,
  isLoaded,
  modprobeConfig,
  moduleDeps,
  moduleParam,
  readSettings,
  splitArgs,
  textAt,
} from '@/shell/kernel-state';
import type { Shell } from '@/shell/shell';
import { fsOn, fstabCheck, fstabFor, mountedAt, syncDev } from '@/shell/storage-state';
import { Lab, ran, ranAfter } from './types';

// Labs that use kernels, modules, GRUB and the boot process.

/** A reboot typed at the prompt: reboot, sudo reboot, systemctl reboot, shutdown -r (not grub2-reboot). */
const REBOOT = /(^|[\s;&|(])(reboot|shutdown\s+(-\S*r|--reboot))\b/;

/** True if a command matching `re` was typed after the last reboot command, e.g. a check of /proc/cmdline. */
const ranAfterReboot = (sh: Shell, re: RegExp) => ranAfter(sh, REBOOT, re);

/** Run setup commands as the student would, then forget them so they do not count for ran(). */
function quietly(sh: Shell, lines: string[]): void {
  for (const l of lines) sh.run(l);
  sh.history.length = 0;
}

/** True when there are boot entries and every one of them passes `ok`. */
const allEntries = (sh: Shell, ok: (e: BootEntry) => boolean) => {
  const entries = bootEntries(sh.state);
  return entries.length > 0 && entries.every(ok);
};

const grubSetting = (sh: Shell, key: string) => readSettings(textAt(sh.state.root, '/etc/default/grub') ?? '')[key];
const runningArgs = (sh: Shell) => splitArgs(sh.state.kernel.cmdline);

// ---------- R16: boot procedure and GRUB ----------

const noSplash = (e: BootEntry) => !entryHasArg(e, 'rhgb') && !entryHasArg(e, 'quiet');
const newArgsRunning = (sh: Shell) => {
  const a = runningArgs(sh);
  return a.includes('audit=1') && !a.includes('rhgb') && !a.includes('quiet');
};

export const R16_BOOT_LABS: Lab[] = [
  {
    id: 'R16-kernel-args',
    title: 'Kernel arguments and the GRUB timeout',
    intro:
      'server1 shows a splash screen while it boots (the rhgb kernel argument) and hides most boot messages (quiet). Make the messages visible, turn on auditing from the very start of the boot (audit=1), and give the GRUB menu 10 seconds. Kernel arguments live in the boot entries in /boot/loader/entries. grubby changes those entries directly, and with --update-kernel=ALL it also updates GRUB_CMDLINE_LINUX in /etc/default/grub. If you edit /etc/default/grub yourself, run grub2-mkconfig with --update-bls-cmdline: on RHEL 10 the boot entries keep their old arguments without it. The kernel gets new arguments at the next boot; /proc/cmdline shows the ones it is running with.',
    tasks: [
      {
        text: 'Show the arguments the running kernel was booted with.',
        hint: 'cat /proc/cmdline',
        check: (sh) => ran(sh, /\/proc\/cmdline/),
      },
      {
        text: 'Use grubby to remove rhgb and quiet from every boot entry.',
        hint: 'sudo grubby --update-kernel=ALL --remove-args="rhgb quiet"',
        check: (sh) => allEntries(sh, noSplash),
      },
      {
        text: 'Now add audit=1 the other way: put it in GRUB_CMDLINE_LINUX in /etc/default/grub.',
        hint: `sudo sed -i 's/^GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="audit=1 /' /etc/default/grub`,
        check: (sh) => splitArgs(grubSetting(sh, 'GRUB_CMDLINE_LINUX') ?? '').includes('audit=1'),
      },
      {
        text: 'In the same file, set GRUB_TIMEOUT to 10 seconds.',
        hint: "sudo sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=10/' /etc/default/grub",
        check: (sh) => grubSetting(sh, 'GRUB_TIMEOUT') === '10',
      },
      {
        text: 'Generate /boot/grub2/grub.cfg again, and copy the new GRUB_CMDLINE_LINUX into the boot entries.',
        hint: 'sudo grub2-mkconfig -o /boot/grub2/grub.cfg --update-bls-cmdline',
        check: (sh) =>
          /^\s*set timeout=10$/m.test(textAt(sh.state.root, '/boot/grub2/grub.cfg') ?? '') &&
          allEntries(sh, (e) => entryHasArg(e, 'audit=1') && noSplash(e)),
      },
      {
        text: 'Reboot server1 so the kernel starts with the new arguments.',
        hint: 'sudo reboot',
        check: (sh) => sh.state.kernel.boots > 0 && newArgsRunning(sh),
      },
      {
        text: 'Check /proc/cmdline again: audit=1 is there, and rhgb and quiet are gone.',
        hint: 'cat /proc/cmdline',
        check: (sh) => newArgsRunning(sh) && ranAfterReboot(sh, /\/proc\/cmdline/),
      },
    ],
  },
];

// ---------- R17: kernel management ----------

const UNAME_R = /^uname\s+(-\S*[ra]|--kernel-release|--all)/;
/** dnf or yum installing or updating packages. */
const DNF_INSTALL = /^(dnf|yum)\s.*\b(install|update|upgrade)\b/;
/** rpm -q kernel, rpm -qa | grep kernel, dnf list installed kernel. */
const LIST_KERNELS = /^(rpm\s+-q\S*\s.*\bkernel\b|(dnf|yum)\s+list\s+((--)?installed\s+)?kernel\b)/;

export const R17_LABS: Lab[] = [
  {
    id: 'R17-modules',
    title: 'Load, configure and block kernel modules',
    intro:
      'Kernel modules are drivers and features that the kernel loads when it needs them. modprobe loads a module together with the modules it depends on, and modprobe -r unloads it the same way. Settings that must survive a reboot go in a .conf file in /etc/modprobe.d: an options line sets module parameters, and a blacklist line stops a module from loading automatically. A blacklist does not stop you from typing modprobe NAME yourself; to block that too, add the line install NAME /bin/false. Someone loaded the Bluetooth driver btusb on server1, which has no Bluetooth hardware.',
    setup: (sh) => {
      for (const m of moduleDeps('btusb')) insertModule(sh.state, m, {});
    },
    tasks: [
      {
        text: 'List the loaded modules and find bluetooth. The last column shows which modules use it.',
        hint: 'lsmod | grep bluetooth',
        check: (sh) => ran(sh, /^lsmod\b/),
      },
      {
        text: 'The loop module is not loaded yet. Show its details, including the parameters (parm) it accepts.',
        hint: 'modinfo loop',
        check: (sh) => ran(sh, /^modinfo\b.*\bloop\b/),
      },
      {
        text: 'Create /etc/modprobe.d/loop.conf so that loop always loads with max_loop=16.',
        hint: 'echo "options loop max_loop=16" | sudo tee /etc/modprobe.d/loop.conf',
        check: (sh) => modprobeConfig(sh.state.root).options.loop?.max_loop === '16',
      },
      {
        text: 'Load the loop module now. modprobe reads the options in /etc/modprobe.d by itself.',
        hint: 'sudo modprobe loop',
        check: (sh) => moduleParam(sh.state, 'loop', 'max_loop') === '16',
      },
      {
        text: 'Check the value the running module got in /sys/module/loop/parameters/max_loop.',
        hint: 'cat /sys/module/loop/parameters/max_loop',
        check: (sh) => ran(sh, /\/sys\/module\/loop\/parameters\/max_loop/),
      },
      {
        text: 'Blacklist usb_storage in /etc/modprobe.d/usb_storage.conf, so that a USB disk does not load it automatically.',
        hint: 'echo "blacklist usb_storage" | sudo tee /etc/modprobe.d/usb_storage.conf',
        check: (sh) => modprobeConfig(sh.state.root).blacklist.has('usb_storage'),
      },
      {
        text: 'Unload btusb, together with the Bluetooth modules it pulled in.',
        hint: 'sudo modprobe -r btusb',
        check: (sh) => !isLoaded(sh.state, 'btusb') && !isLoaded(sh.state, 'bluetooth'),
      },
    ],
  },
  {
    id: 'R17-kernel-update',
    title: 'Update the kernel and boot it',
    intro:
      'A newer kernel is waiting in the BaseOS repository. dnf installs a new kernel next to the old one instead of replacing it, and makes the new one the default boot entry. The old kernel stays in the GRUB menu, so you can pick it if the new one does not boot. dnf keeps at most three kernels (installonly_limit=3 in /etc/dnf/dnf.conf). uname -r shows the old kernel until you reboot.',
    tasks: [
      {
        text: 'Show the release of the running kernel.',
        hint: 'uname -r',
        check: (sh) => ran(sh, UNAME_R),
      },
      {
        text: 'Install the newer kernel.',
        hint: 'sudo dnf update -y kernel',
        check: (sh) => sh.state.kernel.installed.includes(UPDATE_KERNEL),
      },
      {
        text: 'List the installed kernel packages. Both versions must be there.',
        hint: 'rpm -q kernel',
        check: (sh) => sh.state.kernel.installed.length >= 2 && ranAfter(sh, DNF_INSTALL, LIST_KERNELS),
      },
      {
        text: 'Check which kernel GRUB boots by default now.',
        hint: 'sudo grubby --default-kernel',
        check: (sh) => ran(sh, /\bgrubby\s+--(default-kernel|default-index|default-title|info)\b/),
      },
      {
        text: 'Reboot into the new kernel.',
        hint: 'sudo reboot',
        check: (sh) => sh.state.kernel.running === UPDATE_KERNEL,
      },
      {
        text: 'Confirm that the new kernel is the one running now.',
        hint: 'uname -r',
        check: (sh) => sh.state.kernel.running === UPDATE_KERNEL && ranAfterReboot(sh, UNAME_R),
      },
    ],
  },
];

// ---------- R18: troubleshooting ----------

/** The UUID of the /data file system in R18-fstab, and the typo in its fstab line (the last two characters swapped). */
export const DATA_UUID = '5d3e8f21-7a4c-4b9e-8c1d-2f6a9b0e7d43';
export const TYPO_UUID = '5d3e8f21-7a4c-4b9e-8c1d-2f6a9b0e7d34';

const dataMounted = (sh: Shell) => mountedAt(sh.state, '/data')?.source === '/dev/nvme0n2p1';
/** grubby --update-kernel=ALL also writes GRUB_CMDLINE_LINUX, from where grub2-mkconfig would copy the argument back. */
const rescueInGrubDefault = (sh: Shell) => splitArgs(grubSetting(sh, 'GRUB_CMDLINE_LINUX') ?? '').some((a) => a.startsWith('systemd.unit='));

export const R18_LABS: Lab[] = [
  {
    id: 'R18-fstab',
    title: 'Rescue a server with a broken /etc/fstab',
    intro:
      'A colleague created an XFS file system on /dev/nvme0n2p1, mounted it on /data by hand and added a line for it to /etc/fstab, but never tested that line. Its UUID has a typo. At boot, systemd waits for that device, gives up after 90 seconds, and the server stops in emergency mode, where you log in as root on the console. Fix the file there, test it with mount -a, and reboot. If / is read-only in emergency mode, run mount -o remount,rw / first. On the exam, if you cannot fix a line quickly, put a # in front of it so the server boots, and fix it later. Better still: test every fstab change with findmnt --verify and mount -a before you reboot.',
    setup: (sh) => {
      quietly(sh, ['sudo parted -s /dev/nvme0n2 mklabel gpt mkpart data xfs 1MiB 1025MiB', 'sudo mkfs.xfs /dev/nvme0n2p1']);
      const fs = fsOn(sh.state, '/dev/nvme0n2p1');
      if (fs) fs.uuid = DATA_UUID; // a fixed UUID, so the hints can name it
      syncDev(sh.state);
      quietly(sh, [
        'sudo mkdir /data',
        'sudo mount /dev/nvme0n2p1 /data',
        "echo 'Project plans for the next quarter' | sudo tee /data/projects.txt",
        `echo 'UUID=${TYPO_UUID} /data xfs defaults 0 0' | sudo tee -a /etc/fstab`,
      ]);
    },
    tasks: [
      {
        text: 'Reboot server1 and watch the boot stop in emergency mode.',
        hint: 'sudo reboot',
        check: (sh) => sh.state.kernel.boots > 0 && sh.state.kernel.emergency,
      },
      {
        text: 'You are root on the console now. Read the messages of this boot to see what failed.',
        hint: 'journalctl -xb',
        check: (sh) => ran(sh, /^journalctl\b/),
      },
      {
        text: 'Let findmnt check every line in /etc/fstab.',
        hint: 'findmnt --verify',
        check: (sh) => ran(sh, /^findmnt\b.*(--verify|\s-x\b)/),
      },
      {
        text: 'Show the real UUID of /dev/nvme0n2p1 and compare it with the one in /etc/fstab.',
        hint: 'blkid /dev/nvme0n2p1',
        check: (sh) => ran(sh, /^(blkid\b|lsblk\b.*\s-\S*f)/),
      },
      {
        text: 'Correct the UUID in the /data line of /etc/fstab with sed.',
        hint: "sed -i 's/9b0e7d34/9b0e7d43/' /etc/fstab",
        check: (sh) => {
          const c = fstabFor(sh.state, '/data');
          return !!c && c.error === null && c.dev?.path === '/dev/nvme0n2p1';
        },
      },
      {
        text: 'Tell systemd that /etc/fstab changed, then mount everything in it. mount -a must not report any error.',
        hint: 'systemctl daemon-reload && mount -a',
        check: (sh) => dataMounted(sh) && fstabCheck(sh.state).every((c) => c.error === null),
      },
      {
        text: 'Reboot again. This time the server must reach multi-user.target with /data mounted.',
        hint: 'systemctl reboot',
        check: (sh) => {
          const k = sh.state.kernel;
          return k.boots >= 2 && !k.emergency && k.bootTarget === 'multi-user.target' && dataMounted(sh);
        },
      },
    ],
  },
  {
    id: 'R18-rescue',
    title: 'Boot into rescue mode once',
    intro:
      'Resetting a forgotten root password needs the GRUB menu, which this terminal cannot show, so learn the steps here. Reboot and press e on the default entry. At the end of the line that starts with linux, add init=/bin/bash and press Ctrl+X. In the root shell that starts, run mount -o remount,rw /, then passwd root, then touch /.autorelabel (SELinux is not running yet, so /etc/shadow would keep a wrong label without a relabel), and finish with exec /usr/lib/systemd/systemd. Many guides use rd.break instead: there you run mount -o remount,rw /sysroot and chroot /sysroot before passwd, and type exit twice at the end. An argument you add in the GRUB menu counts for one boot only. Rescue mode is different: it asks for the root password, so it is for repairs when you know that password. Here you add systemd.unit=rescue.target with grubby instead of the GRUB menu, so remove it again afterwards.',
    tasks: [
      {
        text: 'Add the kernel argument systemd.unit=rescue.target to the default boot entry only.',
        hint: 'sudo grubby --update-kernel=DEFAULT --args=systemd.unit=rescue.target',
        check: (sh) => {
          const def = defaultBootEntry(sh.state);
          const others = bootEntries(sh.state).filter((e) => e.id !== def?.id);
          return !!def && entryHasArg(def, 'systemd.unit=rescue.target') && others.every((e) => !entryHasArg(e, 'systemd.unit')) && !rescueInGrubDefault(sh);
        },
      },
      {
        text: 'Reboot. The server stops in rescue mode and gives you a root shell.',
        hint: 'sudo reboot',
        check: (sh) => sh.state.kernel.boots > 0 && sh.state.kernel.bootTarget === 'rescue.target',
      },
      {
        text: 'Rescue mode starts only a few services. Check that sshd is not running.',
        hint: 'systemctl is-active sshd',
        check: (sh) => sh.state.kernel.bootTarget === 'rescue.target' && ranAfterReboot(sh, /^systemctl\s+(is-active|status)\b.*\bsshd\b/),
      },
      {
        text: 'Remove the argument again, so that the next boot is a normal one.',
        hint: 'grubby --update-kernel=DEFAULT --remove-args=systemd.unit=rescue.target',
        check: (sh) => allEntries(sh, (e) => !entryHasArg(e, 'systemd.unit')) && !rescueInGrubDefault(sh),
      },
      {
        text: 'Reboot into the normal target, where you log in as student again.',
        hint: 'systemctl reboot',
        check: (sh) => sh.state.kernel.boots >= 2 && sh.state.kernel.bootTarget === 'multi-user.target',
      },
    ],
  },
];

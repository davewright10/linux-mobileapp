import { Module, groupOf, inGroup, peek, permBits, ran, userByName } from './types';

// RHCSA track: R1 and R13–R26. Original practice material mapped to the EX200 objectives.

const text = (sh: Parameters<typeof peek>[0], path: string) => peek(sh, path)?.content ?? '';

export const R1: Module = {
  id: 'R1',
  track: 'rhcsa',
  title: 'RHEL and installation',
  courseRef: 'Video Lessons 1–2 · Cert Guide Ch. 1',
  summary: 'What RHEL 10 is, subscriptions, and installing a server.',
  quiz: [
    {
      q: 'What kind of exam is the RHCSA (EX200)?',
      choices: ['Multiple choice', 'Hands-on: you configure real systems and they are checked afterwards', 'An essay', 'An oral interview'],
      answer: 1,
      why: 'You get tasks and live machines. Only the end state counts, and it must survive a reboot.',
    },
    {
      q: 'How can you get RHEL for free to practise at home?',
      choices: ['You cannot', 'With the no-cost Red Hat Developer subscription', 'Only through a university', 'By downloading Fedora and renaming it'],
      answer: 1,
      why: 'The Developer subscription gives you RHEL for personal use and lab work. Rebuilds like AlmaLinux or Rocky Linux are also close enough for most practice.',
    },
    {
      q: 'Which program is the RHEL installer?',
      choices: ['Anaconda', 'Kickstart', 'Calamares', 'yast'],
      answer: 0,
      why: 'Anaconda runs the installation. Kickstart files can answer its questions automatically.',
    },
    {
      q: 'Which software selection gives you a small server without a graphical desktop?',
      choices: ['Server with GUI', 'Minimal Install', 'Workstation'],
      answer: 1,
      why: 'Minimal Install has the basics. You add what you need with dnf later. Server with GUI and Workstation both include a desktop.',
    },
    {
      q: 'Which tool registers a system with Red Hat so it can get updates?',
      choices: ['subscription-manager (or rhc)', 'dnf register', 'rpm --register', 'redhat-login'],
      answer: 0,
      why: 'Registering connects the system to its subscription and turns on the BaseOS and AppStream repositories.',
    },
    {
      q: 'What are the two main RHEL repositories?',
      choices: ['main and extra', 'BaseOS and AppStream', 'core and contrib', 'stable and testing'],
      answer: 1,
      why: 'BaseOS has the core operating system. AppStream has applications, languages and databases.',
    },
  ],
  cards: [
    { front: 'EX200', back: 'The RHCSA exam code. Hands-on, about 3 hours, results checked after a reboot.' },
    { front: 'RHEL', back: 'Red Hat Enterprise Linux: a supported, long-lived enterprise distribution.' },
    { front: 'Fedora → CentOS Stream → RHEL', back: 'New features appear in Fedora, are prepared in CentOS Stream, then released in RHEL.' },
    { front: 'Anaconda', back: 'The RHEL installer.' },
    { front: 'Kickstart', back: 'A file that answers installer questions for automated installs.' },
    { front: 'BaseOS / AppStream', back: 'Core OS packages / applications and runtimes.' },
    { front: 'subscription-manager register', back: 'Connect the system to a Red Hat subscription.' },
    { front: 'Exam tip: reboot', back: 'Everything must still work after a reboot. Test it before the exam ends.' },
  ],
  labs: [],
};

export const R13: Module = {
  id: 'R13',
  track: 'rhcsa',
  title: 'Logging and the journal',
  courseRef: 'Video Lesson 17 · Cert Guide Ch. 13',
  summary: 'journalctl, rsyslog, log rotation and a persistent journal.',
  quiz: [
    {
      q: 'How do you make the systemd journal survive a reboot?',
      choices: ['It always does', 'Create /var/log/journal (or set Storage=persistent) and restart systemd-journald', 'Install rsyslog', 'Run journalctl --save'],
      answer: 1,
      why: 'With Storage=auto, journald writes to disk only if /var/log/journal exists. Otherwise it uses /run, which is cleared at boot.',
    },
    {
      q: 'Which command shows messages from the previous boot?',
      choices: ['journalctl -b -1', 'journalctl --last', 'journalctl -p 1', 'dmesg -1'],
      answer: 0,
      why: '-b alone is this boot, -b -1 the one before. This only works with a persistent journal.',
    },
    {
      q: 'In an rsyslog rule like "authpriv.* /var/log/secure", what is authpriv?',
      choices: ['The priority', 'The facility', 'The file name', 'The user'],
      answer: 1,
      why: 'Rules are facility.priority followed by a destination. * means every priority.',
    },
    {
      q: 'Which priority is more severe: warning or err?',
      choices: ['warning', 'err', 'They are the same', 'It depends on the facility'],
      answer: 1,
      why: 'From low to high: debug, info, notice, warning, err, crit, alert, emerg.',
    },
    {
      q: 'Which journalctl option shows messages since 9:00 today?',
      choices: ['--since 09:00', '-t 09:00', '--from=9', '-b 09:00'],
      answer: 0,
      why: '--since and --until take times like "09:00", "yesterday" or "2026-10-21 08:00".',
    },
    {
      q: 'What keeps log files in /var/log from growing forever?',
      choices: ['journald', 'logrotate', 'cron itself', 'tmpfiles'],
      answer: 1,
      why: 'logrotate (run daily by a timer) renames, compresses and removes old logs. Settings are in /etc/logrotate.conf and /etc/logrotate.d.',
    },
    {
      q: 'Which command writes your own message to the logs?',
      choices: ['logger "text"', 'echo "text" > /var/log', 'journalctl --write', 'syslog text'],
      answer: 0,
      why: 'logger sends a message to the logging system, handy to test rsyslog rules.',
    },
  ],
  cards: [
    { front: 'Persistent journal', back: 'mkdir /var/log/journal, systemctl restart systemd-journald, then journalctl --flush. Or create /etc/systemd/journald.conf with a [Journal] line and Storage=persistent (on RHEL 10 that file does not exist until you make it).' },
    { front: 'journalctl -b -1', back: 'Messages from the previous boot.' },
    { front: 'journalctl --since / --until', back: 'Messages in a time range.' },
    { front: 'journalctl _PID=1234', back: 'Messages from one process. Tab completion shows other fields.' },
    { front: 'journalctl -o verbose', back: 'Show every field of each message.' },
    { front: 'Priorities', back: 'debug info notice warning err crit alert emerg' },
    { front: 'rsyslog rule', back: 'facility.priority  destination — e.g. cron.* /var/log/cron' },
    { front: '/etc/rsyslog.d/*.conf', back: 'Your own rsyslog rules. Restart rsyslog after changes.' },
    { front: 'logrotate', back: 'Rotates logs. /etc/logrotate.conf and /etc/logrotate.d/.' },
    { front: 'logger', back: 'Send a test message to the logs.' },
  ],
  labs: [
    {
      id: 'R13-logging',
      title: 'Keep the logs',
      intro: 'Make server1 keep its journal across reboots and send a copy of all err-level messages to their own file.',
      tasks: [
        {
          text: 'Create the directory that makes the journal persistent.',
          hint: 'sudo mkdir -p /var/log/journal',
          check: (sh) => peek(sh, '/var/log/journal')?.type === 'dir',
        },
        {
          text: 'Restart systemd-journald so it starts writing there.',
          hint: 'sudo systemctl restart systemd-journald',
          check: (sh) => ran(sh, /systemctl\s+restart\s+systemd-journald/),
        },
        {
          text: 'Create /etc/rsyslog.d/errors.conf with a rule that writes all messages of priority err and higher to /var/log/errors.',
          hint: "echo '*.err /var/log/errors' | sudo tee /etc/rsyslog.d/errors.conf",
          check: (sh) => /^\*\.err\s+\/var\/log\/errors$/m.test(text(sh, '/etc/rsyslog.d/errors.conf')),
        },
        {
          text: 'Restart rsyslog to load the new rule.',
          hint: 'sudo systemctl restart rsyslog',
          check: (sh) => ran(sh, /systemctl\s+restart\s+rsyslog/),
        },
      ],
    },
  ],
};

export const R14: Module = {
  id: 'R14',
  track: 'rhcsa',
  title: 'Partitions, file systems and mounts',
  courseRef: 'Video Lesson 18 · Cert Guide Ch. 14',
  summary: 'GPT partitions, XFS, ext4 and VFAT, fstab by UUID or label, and swap.',
  quiz: [
    {
      q: 'Which partition table should you use on a disk larger than 2 TiB?',
      choices: ['MBR', 'GPT', 'Either works', 'None'],
      answer: 1,
      why: 'MBR is limited to 2 TiB and four primary partitions. GPT has neither limit and is the default on modern systems.',
    },
    {
      q: 'Which command creates an XFS file system with the label "data"?',
      choices: ['mkfs.xfs -L data /dev/sdb1', 'mkfs -t xfs --name data /dev/sdb1', 'xfs_create data /dev/sdb1', 'mount -L data /dev/sdb1'],
      answer: 0,
      why: 'mkfs.xfs -L sets the label at creation. You can then mount with LABEL=data in fstab.',
    },
    {
      q: 'What is the safest way to test new /etc/fstab lines before rebooting?',
      choices: ['Reboot and hope', 'mount -a (after systemctl daemon-reload), then check with findmnt or df', 'cat /etc/fstab', 'fsck -A'],
      answer: 1,
      why: 'A bad fstab line can stop the boot. mount -a mounts everything listed and shows errors right away.',
    },
    {
      q: 'Which fstab line activates a swap partition at boot?',
      choices: ['UUID=… swap swap defaults 0 0 (mount point can be none or swap)', 'UUID=… /swap xfs defaults 0 0', 'swapon UUID=…', 'UUID=… / swap defaults 1 1'],
      answer: 0,
      why: 'Swap has no real mount point. Prepare it with mkswap and turn it on with swapon -a.',
    },
    {
      q: 'Can you shrink an XFS file system?',
      choices: ['Yes, with xfs_growfs -s', 'No, XFS can only grow', 'Only when unmounted', 'Only on LVM'],
      answer: 1,
      why: 'XFS can be extended but never reduced. ext4 can be shrunk while unmounted.',
    },
    {
      q: 'Which command shows the UUIDs and labels of file systems?',
      choices: ['blkid', 'lsuuid', 'df -u', 'fdisk -u'],
      answer: 0,
      why: 'blkid (or lsblk -f) shows the type, UUID and label of each device.',
    },
    {
      q: 'Which file system type would you use for a USB stick that Windows must also read?',
      choices: ['xfs', 'ext4', 'vfat', 'swap'],
      answer: 2,
      why: 'VFAT (FAT32) works almost everywhere. Create it with mkfs.vfat.',
    },
  ],
  cards: [
    { front: 'MBR vs GPT', back: 'MBR: 2 TiB, 4 primary partitions. GPT: huge disks, 128 partitions.' },
    { front: 'fdisk / parted', back: 'Partition tools. Both handle MBR and GPT. parted can be scripted: parted /dev/sdb mkpart … (gdisk is not in the RHEL 10 repositories.)' },
    { front: 'mkfs.xfs / mkfs.ext4 / mkfs.vfat', back: 'Create a file system.' },
    { front: 'mkswap /dev/sdb2 ; swapon /dev/sdb2', back: 'Prepare and activate swap. swapon -s shows active swap.' },
    { front: 'blkid / lsblk -f', back: 'Show UUID, label and type.' },
    { front: 'fstab by UUID', back: 'UUID=1234-… /data xfs defaults 0 0' },
    { front: 'fstab by label', back: 'LABEL=data /data xfs defaults 0 0' },
    { front: 'mount -a', back: 'Mount all fstab entries. Run systemctl daemon-reload after editing fstab.' },
    { front: 'findmnt --verify', back: 'Check /etc/fstab for mistakes.' },
    { front: 'xfs_admin -L / e2label', back: 'Change the label of an XFS / ext4 file system.' },
  ],
  labs: [],
};

export const R15: Module = {
  id: 'R15',
  track: 'rhcsa',
  title: 'LVM',
  courseRef: 'Video Lesson 19 · Cert Guide Ch. 15',
  summary: 'Physical volumes, volume groups and logical volumes, and extending them.',
  quiz: [
    {
      q: 'What is the correct order to build LVM storage?',
      choices: ['LV → VG → PV', 'PV → VG → LV', 'VG → PV → LV', 'PV → LV → VG'],
      answer: 1,
      why: 'Mark disks or partitions as physical volumes, pool them into a volume group, then cut logical volumes from the group.',
    },
    {
      q: 'Which command creates a 500 MiB logical volume named data in volume group vgdata?',
      choices: ['lvcreate -n data -L 500M vgdata', 'lvcreate vgdata data 500M', 'lvcreate -L data -n 500M vgdata', 'vgcreate -n data 500M'],
      answer: 0,
      why: '-n is the name, -L the size, and the last argument is the volume group.',
    },
    {
      q: 'How do you grow a logical volume by 1 GiB AND its file system in one command?',
      choices: ['lvextend -r -L +1G /dev/vgdata/data', 'lvresize 1G', 'xfs_growfs +1G', 'lvextend -L 1G'],
      answer: 0,
      why: '-r resizes the file system too. Note +1G adds 1 GiB; 1G without + sets the total size.',
    },
    {
      q: 'The volume group is full. How do you add space?',
      choices: ['pvcreate a new disk, then vgextend the group with it', 'lvcreate a bigger LV', 'mkfs the group again', 'It is not possible'],
      answer: 0,
      why: 'Adding a PV to the VG gives it more extents to hand out to LVs.',
    },
    {
      q: 'An exam task says "create an LV of 20 extents" in a VG with 8 MiB extents. How big is it?',
      choices: ['20 MiB', '160 MiB', '8 MiB', '28 MiB'],
      answer: 1,
      why: 'Size = extents × extent size. Use lvcreate -l 20 (small l) for extents. Set the extent size at vgcreate with -s 8M.',
    },
    {
      q: 'Which commands give a short overview of PVs, VGs and LVs?',
      choices: ['pvs, vgs, lvs', 'lsblk only', 'pvlist, vglist, lvlist', 'lvm show'],
      answer: 0,
      why: 'pvdisplay, vgdisplay and lvdisplay show more detail.',
    },
  ],
  cards: [
    { front: 'PV', back: 'Physical volume: a disk or partition prepared for LVM with pvcreate.' },
    { front: 'VG', back: 'Volume group: a pool of PVs. vgcreate vgdata /dev/sdb1' },
    { front: 'LV', back: 'Logical volume: a slice of a VG used like a partition.' },
    { front: 'lvcreate -n name -L 1G vg', back: 'Create an LV by size.' },
    { front: 'lvcreate -n name -l 100%FREE vg', back: 'Use all remaining space. -l counts extents or percentages.' },
    { front: 'vgcreate -s 8M vg /dev/sdb1', back: 'Create a VG with 8 MiB extents.' },
    { front: 'vgextend vg /dev/sdc1', back: 'Add a PV to a VG.' },
    { front: 'lvextend -r -L +500M', back: 'Grow an LV and its file system.' },
    { front: '/dev/vg/lv and /dev/mapper/vg-lv', back: 'Two names for the same LV. Either works in fstab.' },
    { front: 'pvs / vgs / lvs', back: 'Short overview. *display commands give detail.' },
  ],
  labs: [],
};

export const R16: Module = {
  id: 'R16',
  track: 'rhcsa',
  title: 'Boot procedure and GRUB',
  courseRef: 'Video Lesson 20 · Cert Guide Ch. 17',
  summary: 'Targets, GRUB 2 and modifying the boot loader.',
  quiz: [
    {
      q: 'What is the order of the boot process?',
      choices: ['Firmware → GRUB → kernel + initramfs → systemd → target', 'GRUB → firmware → systemd → kernel', 'kernel → GRUB → systemd', 'systemd → GRUB → kernel'],
      answer: 0,
      why: 'Firmware (BIOS or UEFI) loads GRUB, GRUB loads the kernel and initramfs, and the kernel starts systemd, which reaches the default target.',
    },
    {
      q: 'Which command makes the server boot into text mode by default?',
      choices: ['systemctl set-default multi-user.target', 'systemctl isolate text', 'grub2 --text', 'init 3 --permanent'],
      answer: 0,
      why: 'set-default changes the default target. isolate switches now without changing the default.',
    },
    {
      q: 'Which file holds the kernel arguments you change permanently with an editor?',
      choices: ['/etc/default/grub (GRUB_CMDLINE_LINUX)', '/boot/grub2/grub.cfg', '/etc/grub.conf', '/proc/cmdline'],
      answer: 0,
      why: 'Never edit grub.cfg by hand. Change /etc/default/grub, then run grub2-mkconfig -o /boot/grub2/grub.cfg --update-bls-cmdline. Without --update-bls-cmdline, RHEL 10 keeps the old kernel arguments.',
    },
    {
      q: 'How do you change kernel arguments for one boot only?',
      choices: ['Press e in the GRUB menu, edit the linux line, then Ctrl+X', 'Edit /etc/default/grub', 'Run grubby', 'Use systemctl'],
      answer: 0,
      why: 'Changes made in the GRUB menu are forgotten at the next boot.',
    },
    {
      q: 'Which tool adds a kernel argument to all installed kernels without editing files?',
      choices: ['grubby --update-kernel=ALL --args="…"', 'dnf kernel-args', 'modprobe', 'dracut --args'],
      answer: 0,
      why: 'grubby edits the boot entries directly. --remove-args takes them away again.',
    },
    {
      q: 'Which target gives you a root shell with the most file systems mounted, for repairs?',
      choices: ['rescue.target', 'graphical.target', 'multi-user.target', 'default.target'],
      answer: 0,
      why: 'rescue.target starts a minimum of services. emergency.target is even more minimal, with / mounted read-only.',
    },
  ],
  cards: [
    { front: 'Boot order', back: 'Firmware → GRUB 2 → kernel + initramfs → systemd → default target.' },
    { front: 'systemctl get-default / set-default', back: 'Show or change the default target.' },
    { front: 'systemctl isolate rescue.target', back: 'Switch to another target now.' },
    { front: 'multi-user vs graphical', back: 'Text mode server / with a graphical login.' },
    { front: '/etc/default/grub', back: 'GRUB settings: GRUB_TIMEOUT, GRUB_CMDLINE_LINUX.' },
    { front: 'grub2-mkconfig -o /boot/grub2/grub.cfg', back: 'Write the GRUB configuration after editing /etc/default/grub. Add --update-bls-cmdline if you changed GRUB_CMDLINE_LINUX.' },
    { front: 'grubby --update-kernel=ALL --args=quiet', back: 'Add a kernel argument to all kernels.' },
    { front: 'GRUB menu: e, then Ctrl+X', back: 'Edit boot options once and boot.' },
    { front: '/proc/cmdline', back: 'The kernel arguments used for the current boot.' },
    { front: 'systemd.unit=rescue.target', back: 'Kernel argument to boot straight into rescue mode.' },
  ],
  labs: [
    {
      id: 'R16-targets',
      title: 'Text mode by default',
      intro: 'Someone set server1 to boot into a graphical login. It is a server, so put it back.',
      setup: (sh) => {
        sh.state.defaultTarget = 'graphical.target';
      },
      tasks: [
        {
          text: 'Check which target server1 boots into.',
          hint: 'systemctl get-default',
          check: (sh) => ran(sh, /systemctl\s+get-default/),
        },
        {
          text: 'Make multi-user.target the default.',
          hint: 'sudo systemctl set-default multi-user.target',
          check: (sh) => sh.state.defaultTarget === 'multi-user.target',
        },
      ],
    },
  ],
};

export const R17: Module = {
  id: 'R17',
  track: 'rhcsa',
  title: 'Kernel management',
  courseRef: 'Video Lesson 21 · Cert Guide Ch. 16',
  summary: 'Kernel modules and updating the kernel.',
  quiz: [
    {
      q: 'Which command shows the running kernel version?',
      choices: ['uname -r', 'kernel -v', 'rpm -q linux', 'cat /boot/version'],
      answer: 0,
      why: 'uname -r prints the release. rpm -q kernel lists all installed kernels.',
    },
    {
      q: 'What happens to the old kernel when you run dnf update and a new kernel is available?',
      choices: ['It is replaced', 'It stays installed next to the new one, so you can boot the old one if needed', 'It is deleted at reboot', 'dnf refuses to update the kernel'],
      answer: 1,
      why: 'Kernels are installed side by side. dnf keeps a few (installonly_limit in /etc/dnf/dnf.conf) and removes the oldest.',
    },
    {
      q: 'Which command loads a kernel module along with the modules it depends on?',
      choices: ['modprobe name', 'insmod name', 'lsmod name', 'modload name'],
      answer: 0,
      why: 'modprobe handles dependencies. modprobe -r unloads a module.',
    },
    {
      q: 'Where do you set options for a module so they apply every time it loads?',
      choices: ['/etc/modprobe.d/*.conf', '/etc/modules', '/proc/modules', '/boot/modules.conf'],
      answer: 0,
      why: 'A line like "options mymodule debug=1" in /etc/modprobe.d/mymodule.conf.',
    },
    {
      q: 'Which command lists the loaded modules?',
      choices: ['lsmod', 'modinfo', 'modprobe -l', 'ls /proc'],
      answer: 0,
      why: 'modinfo shows details and parameters of a single module.',
    },
    {
      q: 'What is /proc?',
      choices: ['A disk partition', 'A virtual file system showing kernel and process information', 'The process backup folder', 'Where programs are installed'],
      answer: 1,
      why: 'Nothing in /proc is on disk. /proc/cpuinfo and /proc/meminfo are useful examples. /sys is similar, for devices.',
    },
  ],
  cards: [
    { front: 'uname -r', back: 'Running kernel version.' },
    { front: 'rpm -q kernel', back: 'All installed kernels.' },
    { front: 'dnf update kernel', back: 'Install a newer kernel next to the current one.' },
    { front: 'lsmod', back: 'Loaded modules.' },
    { front: 'modprobe / modprobe -r', back: 'Load / unload a module and its dependencies.' },
    { front: 'modinfo name', back: 'Details and parameters of a module.' },
    { front: '/etc/modprobe.d/', back: 'Persistent module options and blacklists.' },
    { front: '/proc and /sys', back: 'Virtual file systems with kernel, process and device information.' },
    { front: 'dmesg', back: 'Kernel ring buffer: hardware and driver messages.' },
  ],
  labs: [],
};

export const R18: Module = {
  id: 'R18',
  track: 'rhcsa',
  title: 'Troubleshooting and root password reset',
  courseRef: 'Video Lesson 22 · Cert Guide Ch. 18',
  summary: 'Interrupting the boot, rescue mode, and fixing common issues.',
  quiz: [
    {
      q: 'You must reset a forgotten root password. What is the first step?',
      choices: ['Reboot and press e in the GRUB menu to edit the boot entry', 'Log in as root', 'Run passwd root as student', 'Reinstall'],
      answer: 0,
      why: 'You interrupt the boot and add an argument such as rd.break or init=/bin/bash to the linux line, then press Ctrl+X.',
    },
    {
      q: 'After booting with init=/bin/bash, the root file system is read-only. How do you make it writable?',
      choices: ['mount -o remount,rw /', 'chmod +w /', 'fsck /', 'setenforce 0'],
      answer: 0,
      why: 'Remount read-write, then run passwd to set the new password.',
    },
    {
      q: 'Why do you run "touch /.autorelabel" after resetting the root password this way?',
      choices: ['To speed up the boot', 'SELinux was not running, so /etc/shadow got the wrong label; this relabels files at next boot', 'To reset the GRUB password', 'It is optional decoration'],
      answer: 1,
      why: 'Without it, the wrong context on /etc/shadow can stop anyone from logging in.',
    },
    {
      q: 'With rd.break, where is the real root file system mounted?',
      choices: ['/sysroot', '/', '/mnt', '/boot'],
      answer: 0,
      why: 'Remount /sysroot read-write, then chroot /sysroot before running passwd.',
    },
    {
      q: 'A typo in /etc/fstab stops the server from booting. Where do you end up?',
      choices: ['Emergency mode, where you log in as root and fix fstab', 'The GRUB shell', 'A graphical error screen', 'The installer'],
      answer: 0,
      why: 'Enter the root password, remount / read-write if needed, fix the line, then reboot. If the root account is locked (the RHEL 10 installer default), you get no shell there; boot with rd.break or init=/bin/bash instead. Always test fstab with mount -a first.',
    },
    {
      q: 'How do you finish the init=/bin/bash procedure so the system boots normally?',
      choices: ['exec /usr/lib/systemd/systemd', 'exit', 'Ctrl+C', 'reboot'],
      answer: 0,
      why: 'bash replaces itself with systemd, which continues the normal boot. A plain reboot does not work there, because systemd is not running yet.',
    },
  ],
  cards: [
    { front: 'Root reset (init=/bin/bash)', back: 'e in GRUB, add init=/bin/bash, Ctrl+X; mount -o remount,rw /; passwd root; touch /.autorelabel; exec /usr/lib/systemd/systemd' },
    { front: 'Root reset (rd.break)', back: 'Add rd.break; mount -o remount,rw /sysroot; chroot /sysroot; passwd root; touch /.autorelabel; exit twice.' },
    { front: '/.autorelabel', back: 'Make SELinux relabel the whole file system on the next boot.' },
    { front: 'systemd.unit=emergency.target', back: 'Minimal boot: root shell, / read-only, almost nothing started.' },
    { front: 'systemd.unit=rescue.target', back: 'Root shell with file systems mounted, few services.' },
    { front: 'Broken fstab', back: 'Emergency mode: log in, mount -o remount,rw /, fix fstab, reboot.' },
    { front: 'Boot an older kernel', back: 'Pick it in the GRUB menu if a new kernel fails.' },
    { front: 'journalctl -xb', back: 'All messages of this boot, with extra explanation where available. Add -p err for errors only.' },
  ],
  labs: [],
};

export const R19: Module = {
  id: 'R19',
  track: 'rhcsa',
  title: 'Bash scripting',
  courseRef: 'Video Lesson 23 · Cert Guide Ch. 19',
  summary: 'if, test, for loops, script arguments and command output.',
  quiz: [
    {
      q: 'What must the first line of a Bash script be?',
      choices: ['#!/bin/bash', '# bash', 'bash:', '#include bash'],
      answer: 0,
      why: 'The shebang tells the system which interpreter runs the script. Also make it executable with chmod +x.',
    },
    {
      q: 'In a script, what is $1?',
      choices: ['The first argument given to the script', 'The exit code', 'The script name', 'The first line'],
      answer: 0,
      why: '$0 is the script name, $1 the first argument, $# the number of arguments and $@ all of them.',
    },
    {
      q: 'Which variable holds the exit code of the last command?',
      choices: ['$?', '$!', '$$', '$#'],
      answer: 0,
      why: '0 means success. Anything else means something went wrong.',
    },
    {
      q: 'Which test checks whether /etc/hosts is a regular file?',
      choices: ['[ -f /etc/hosts ]', '[ -d /etc/hosts ]', '[ -z /etc/hosts ]', '[ /etc/hosts ]'],
      answer: 0,
      why: '-f file, -d directory, -e exists, -z empty string, -n non-empty string.',
    },
    {
      q: 'Which loop prints each user name from users.txt?',
      choices: ['for u in $(cat users.txt); do echo $u; done', 'for u in users.txt; echo u', 'while users.txt do echo', 'loop users.txt'],
      answer: 0,
      why: '$(…) runs the command and puts its output in place. The loop runs once per word.',
    },
    {
      q: 'How do you compare two numbers in a test?',
      choices: ['[ $a -gt $b ]', '[ $a > $b ]', '[ $a gt $b ]', '[[ a greater b ]]'],
      answer: 0,
      why: '-eq, -ne, -lt, -le, -gt and -ge compare numbers. = and != compare strings.',
    },
  ],
  cards: [
    { front: '#!/bin/bash', back: 'Shebang: run this script with Bash. chmod +x to make it executable.' },
    { front: '$1 $2 … / $# / $@', back: 'Arguments / number of arguments / all arguments.' },
    { front: '$?', back: 'Exit code of the last command. 0 = success.' },
    { front: '$(command)', back: 'Command substitution: use the output of a command.' },
    { front: 'if [ … ]; then … else … fi', back: 'Run commands depending on a test.' },
    { front: 'for x in list; do … done', back: 'Repeat for each item.' },
    { front: 'while [ … ]; do … done', back: 'Repeat while a test is true.' },
    { front: 'test -f / -d / -e', back: 'Is a file / directory / exists.' },
    { front: '-eq -ne -lt -gt', back: 'Number comparisons in [ ].' },
    { front: 'exit 1', back: 'Stop the script with an error code.' },
    { front: 'read NAME', back: 'Ask for input and store it in NAME.' },
  ],
  labs: [],
};

export const R20: Module = {
  id: 'R20',
  track: 'rhcsa',
  title: 'SSH and key-based auth',
  courseRef: 'Video Lesson 24 · Cert Guide Ch. 20',
  summary: 'Hardening sshd, key-based login, and secure file transfer.',
  quiz: [
    {
      q: 'Which two commands set up key-based login to server2?',
      choices: ['ssh-keygen, then ssh-copy-id server2', 'ssh-add, then ssh server2', 'passwd -k, then scp', 'sshd -k, then ssh'],
      answer: 0,
      why: 'ssh-keygen makes the key pair, ssh-copy-id installs the public key in the remote authorized_keys.',
    },
    {
      q: 'You moved sshd to port 2022 and it fails to start. What is the likely cause on RHEL?',
      choices: ['SELinux does not allow sshd on that port yet', 'The port is too high', 'You must reboot', 'sshd cannot use other ports'],
      answer: 0,
      why: 'Run semanage port -a -t ssh_port_t -p tcp 2022, and open the port in the firewall.',
    },
    {
      q: 'Why put your changes in /etc/ssh/sshd_config.d/ instead of sshd_config?',
      choices: ['It is faster', 'Package updates do not overwrite them, and they are easy to find', 'sshd_config is read-only', 'It is required by SELinux'],
      answer: 1,
      why: 'sshd_config includes sshd_config.d/*.conf. For each setting, the first value sshd reads wins.',
    },
    {
      q: 'Which setting allows only key-based logins?',
      choices: ['PasswordAuthentication no', 'PubkeyOnly yes', 'KeysOnly yes', 'PermitPasswords no'],
      answer: 0,
      why: 'Make sure your key works before turning passwords off, or you can lock yourself out.',
    },
    {
      q: 'Which command copies a directory to server2 over SSH and copies only what changed on later runs?',
      choices: ['rsync -a dir server2:/backup/', 'scp dir server2', 'cp -r dir server2:', 'ssh-copy dir'],
      answer: 0,
      why: 'rsync works over SSH and transfers only differences. scp -r copies everything each time.',
    },
    {
      q: 'What does ssh-agent do?',
      choices: ['Keeps your unlocked private key in memory so you type the passphrase once', 'Runs the SSH server', 'Copies keys to servers', 'Blocks attacks'],
      answer: 0,
      why: 'Add your key with ssh-add after starting the agent.',
    },
  ],
  cards: [
    { front: 'ssh-keygen -t ed25519', back: 'Create a modern key pair.' },
    { front: 'ssh-copy-id user@host', back: 'Install your public key on a server.' },
    { front: 'ssh-agent / ssh-add', back: 'Cache your unlocked key for the session.' },
    { front: '/etc/ssh/sshd_config.d/', back: 'Drop-in server settings. First value read wins.' },
    { front: 'New SSH port', back: 'Port line + semanage port -a -t ssh_port_t -p tcp N + firewall-cmd --add-port=N/tcp --permanent, then firewall-cmd --reload and systemctl restart sshd.' },
    { front: 'AllowUsers anna bob', back: 'Only these users may log in over SSH.' },
    { front: 'scp -r dir host:/path', back: 'Copy a directory over SSH.' },
    { front: 'rsync -av src host:/dest', back: 'Sync files over SSH, only what changed.' },
    { front: 'sftp host', back: 'Interactive file transfer over SSH.' },
  ],
  labs: [
    {
      id: 'R20-sshd',
      title: 'Lock down SSH with a drop-in file',
      intro: 'Put your sshd settings in their own file under /etc/ssh/sshd_config.d, where package updates will not touch them. Files there are read in name order and the first value wins, so check for lower-numbered files (the installer may create 01-permitrootlogin.conf). On a real server, sudo sshd -T shows the settings in effect.',
      tasks: [
        {
          text: 'Create /etc/ssh/sshd_config.d/50-exam.conf with the line PermitRootLogin no.',
          hint: "echo 'PermitRootLogin no' | sudo tee /etc/ssh/sshd_config.d/50-exam.conf",
          check: (sh) => /^PermitRootLogin\s+no$/m.test(text(sh, '/etc/ssh/sshd_config.d/50-exam.conf')),
        },
        {
          text: 'Add a line to the same file so only student and anna may log in over SSH.',
          hint: "echo 'AllowUsers student anna' | sudo tee -a /etc/ssh/sshd_config.d/50-exam.conf",
          check: (sh) => /^AllowUsers\s+(student\s+anna|anna\s+student)$/m.test(text(sh, '/etc/ssh/sshd_config.d/50-exam.conf')),
        },
        {
          text: 'Make sure the file is only readable and writable by root (mode 600).',
          hint: 'sudo chmod 600 /etc/ssh/sshd_config.d/50-exam.conf',
          check: (sh) => permBits(peek(sh, '/etc/ssh/sshd_config.d/50-exam.conf')) === 0o600,
        },
        {
          text: 'Restart sshd to apply the settings.',
          hint: 'sudo systemctl restart sshd',
          check: (sh) => ran(sh, /systemctl\s+(restart|reload)\s+sshd/),
        },
      ],
    },
  ],
};

export const R21: Module = {
  id: 'R21',
  track: 'rhcsa',
  title: 'Apache HTTP',
  courseRef: 'Video Lesson 25 · Cert Guide Ch. 21',
  summary: 'A basic web server, configuration files and virtual hosts.',
  quiz: [
    {
      q: 'Which package provides the Apache web server on RHEL?',
      choices: ['httpd', 'apache2', 'nginx', 'www'],
      answer: 0,
      why: 'The package and service are both called httpd.',
    },
    {
      q: 'Where does Apache look for web pages by default?',
      choices: ['/var/www/html', '/srv/www', '/usr/share/html', '/home/www'],
      answer: 0,
      why: 'DocumentRoot in /etc/httpd/conf/httpd.conf points to /var/www/html.',
    },
    {
      q: 'Where do you add your own configuration, such as a virtual host?',
      choices: ['A .conf file in /etc/httpd/conf.d/', '/var/www/html/.config', '/etc/apache2/sites-enabled', 'httpd.conf only'],
      answer: 0,
      why: 'httpd.conf includes conf.d/*.conf. Keeping your changes separate makes them easy to manage.',
    },
    {
      q: 'Which command checks the Apache configuration for errors before restarting?',
      choices: ['apachectl configtest (or httpd -t)', 'httpd --check', 'systemctl test httpd', 'nginx -t'],
      answer: 0,
      why: 'It says "Syntax OK" or shows the line with the problem.',
    },
    {
      q: 'You serve pages from /web instead of /var/www/html, and get "403 Forbidden". The permissions look fine. What is the likely cause?',
      choices: ['SELinux: /web needs the httpd_sys_content_t context', 'The firewall', 'DNS', 'The page is too big'],
      answer: 0,
      why: 'semanage fcontext -a -t httpd_sys_content_t "/web(/.*)?" then restorecon -Rv /web.',
    },
    {
      q: 'What two things make the web server reachable from other machines?',
      choices: ['systemctl enable --now httpd, and firewall-cmd --add-service=http --permanent plus --reload', 'Only starting httpd', 'Rebooting', 'Editing /etc/hosts'],
      answer: 0,
      why: 'The service must run, and firewalld must let port 80 in.',
    },
  ],
  cards: [
    { front: 'httpd', back: 'Apache package and service name on RHEL.' },
    { front: '/etc/httpd/conf/httpd.conf', back: 'Main Apache configuration.' },
    { front: '/etc/httpd/conf.d/*.conf', back: 'Extra configuration, such as virtual hosts.' },
    { front: '/var/www/html', back: 'Default DocumentRoot.' },
    { front: 'apachectl configtest', back: 'Check the configuration syntax.' },
    { front: '<VirtualHost *:80>', back: 'Define a site with its own ServerName and DocumentRoot.' },
    { front: 'firewall-cmd --add-service=http', back: 'Open port 80. https opens 443.' },
    { front: 'httpd_sys_content_t', back: 'SELinux type for web content.' },
    { front: 'curl http://localhost', back: 'Test the web server from the command line.' },
  ],
  labs: [
    {
      id: 'R21-web',
      title: 'Publish a web page',
      intro: 'Set up server1 as a web server with a simple home page that other machines can reach.',
      tasks: [
        {
          text: 'Install the Apache web server.',
          hint: 'sudo dnf install -y httpd',
          check: (sh) => sh.state.installed.includes('httpd'),
        },
        {
          text: 'Create /var/www/html/index.html containing the text: Welcome to server1',
          hint: "echo 'Welcome to server1' | sudo tee /var/www/html/index.html",
          check: (sh) => text(sh, '/var/www/html/index.html').includes('Welcome to server1'),
        },
        {
          text: 'Start the web server and make it start at boot.',
          hint: 'sudo systemctl enable --now httpd',
          check: (sh) => !!sh.state.services.httpd?.active && !!sh.state.services.httpd?.enabled,
        },
        {
          text: 'Permanently allow http through the firewall, and apply it now.',
          hint: 'sudo firewall-cmd --permanent --add-service=http && sudo firewall-cmd --reload',
          check: (sh) => sh.state.firewall.permServices.includes('http') && sh.state.firewall.services.includes('http'),
        },
      ],
    },
  ],
};

export const R22: Module = {
  id: 'R22',
  track: 'rhcsa',
  title: 'Time services',
  courseRef: 'Video Lesson 26 · Cert Guide Ch. 25',
  summary: 'Time zones and chrony as a time client.',
  quiz: [
    {
      q: 'An exam task says: "Use classroom.example.com as the NTP server." Which file do you change?',
      choices: ['/etc/chrony.conf', '/etc/ntp.conf', '/etc/timezone', '/etc/systemd/timesyncd.conf'],
      answer: 0,
      why: 'Add "server classroom.example.com iburst" (and usually remove the pool line), then restart chronyd.',
    },
    {
      q: 'How do you check that chrony is really syncing with the new server?',
      choices: ['chronyc sources (look for ^*)', 'ping classroom.example.com', 'date', 'systemctl status ntpd'],
      answer: 0,
      why: 'The * marks the source in use. chronyc tracking shows the offset.',
    },
    {
      q: 'Why does "timedatectl set-time 12:00" fail on a fresh RHEL system?',
      choices: ['NTP sync is on; turn it off first with set-ntp false', 'You need a date too', 'The command does not exist', 'Only works in UTC'],
      answer: 0,
      why: 'While NTP controls the clock, setting it by hand is refused.',
    },
    {
      q: 'What does iburst do on a server line?',
      choices: ['Sends a quick burst of requests at start so the clock syncs faster', 'Limits bandwidth', 'Uses IPv6', 'Encrypts the traffic'],
      answer: 0,
      why: 'It only affects the first sync after starting.',
    },
    {
      q: 'Which command shows only the time zone names in Europe?',
      choices: ['timedatectl list-timezones | grep Europe', 'timedatectl europe', 'ls /etc/zones', 'date --zones'],
      answer: 0,
      why: 'Pipe the long list through grep to find the one you need.',
    },
  ],
  cards: [
    { front: 'server host iburst', back: 'chrony.conf line for one NTP server.' },
    { front: 'pool host iburst', back: 'chrony.conf line for a pool of NTP servers.' },
    { front: 'systemctl restart chronyd', back: 'Apply chrony.conf changes.' },
    { front: 'chronyc sources', back: 'Time sources; ^* is the one in use.' },
    { front: 'chronyc tracking', back: 'How far off the clock is and how it is being corrected.' },
    { front: 'timedatectl set-ntp false', back: 'Turn off sync so you can set the time by hand.' },
    { front: 'timedatectl set-time "2026-10-21 12:00"', back: 'Set the clock by hand.' },
  ],
  labs: [
    {
      id: 'R22-chrony',
      title: 'Use the classroom time server',
      intro: 'Exam style: server1 must get its time from classroom.example.com and use London time.',
      tasks: [
        {
          text: 'Replace the pool line in /etc/chrony.conf with: server classroom.example.com iburst',
          hint: "sudo sed -i 's/^pool.*/server classroom.example.com iburst/' /etc/chrony.conf",
          check: (sh) => /^server\s+classroom\.example\.com\s+iburst$/m.test(text(sh, '/etc/chrony.conf')) && !/^pool/m.test(text(sh, '/etc/chrony.conf')),
        },
        {
          text: 'Restart chronyd.',
          hint: 'sudo systemctl restart chronyd',
          check: (sh) => ran(sh, /systemctl\s+restart\s+chronyd/),
        },
        {
          text: 'Set the time zone to Europe/London.',
          hint: 'sudo timedatectl set-timezone Europe/London',
          check: (sh) => sh.state.timezone === 'Europe/London',
        },
      ],
    },
  ],
};

export const R23: Module = {
  id: 'R23',
  track: 'rhcsa',
  title: 'SELinux',
  courseRef: 'Video Lesson 27 · Cert Guide Ch. 22',
  summary: 'Modes, contexts, restorecon, port labels, booleans and troubleshooting.',
  quiz: [
    {
      q: 'What is the difference between enforcing and permissive mode?',
      choices: ['Permissive logs what would be blocked but allows it; enforcing blocks it', 'Permissive turns SELinux off', 'Enforcing only logs', 'No difference'],
      answer: 0,
      why: 'Permissive is useful for troubleshooting. On the exam, leave systems enforcing.',
    },
    {
      q: 'Which command sets the right context for /web so Apache may read it, in a way that survives a relabel?',
      choices: ['semanage fcontext -a -t httpd_sys_content_t "/web(/.*)?" then restorecon -Rv /web', 'chcon -t httpd_sys_content_t /web', 'chmod 755 /web', 'setsebool web on'],
      answer: 0,
      why: 'semanage fcontext stores the rule in the policy; restorecon applies it. chcon changes are lost on a relabel.',
    },
    {
      q: 'Which option shows the SELinux context of files?',
      choices: ['ls -Z', 'ls -S', 'ls -c', 'stat -s'],
      answer: 0,
      why: '-Z works for ps and id too.',
    },
    {
      q: 'Apache must listen on port 8888. What SELinux command allows that?',
      choices: ['semanage port -a -t http_port_t -p tcp 8888', 'setsebool httpd_8888 on', 'restorecon -p 8888', 'chcon -p 8888'],
      answer: 0,
      why: 'Services may only bind to ports with the right type. Check first with semanage port -l | grep http: ports such as 80, 443, 8008 and 8443 already have http_port_t, and Apache may also use 8080.',
    },
    {
      q: 'How do you turn on the boolean httpd_enable_homedirs permanently?',
      choices: ['setsebool -P httpd_enable_homedirs on', 'setsebool httpd_enable_homedirs on', 'getsebool -P', 'semanage boolean --on'],
      answer: 0,
      why: 'Without -P the change is lost at reboot. getsebool -a lists all booleans.',
    },
    {
      q: 'Where do you look to find out why SELinux blocked something?',
      choices: ['/var/log/audit/audit.log (ausearch -m AVC) and sealert messages in the journal', '/var/log/selinux', 'dmesg only', '/etc/selinux/config'],
      answer: 0,
      why: 'Denials are logged as AVC messages. With setroubleshoot installed, sealert explains them and suggests a fix.',
    },
    {
      q: 'How do you make enforcing mode survive a reboot?',
      choices: ['SELINUX=enforcing in /etc/selinux/config', 'setenforce 1', 'setenforce -P 1', 'systemctl enable selinux'],
      answer: 0,
      why: 'setenforce only changes the current mode. The config file sets the mode at boot.',
    },
  ],
  cards: [
    { front: 'getenforce / setenforce 0|1', back: 'Show / change the current mode (until reboot).' },
    { front: '/etc/selinux/config', back: 'SELINUX=enforcing|permissive|disabled at boot.' },
    { front: 'ls -Z / ps -Z', back: 'Show SELinux contexts.' },
    { front: 'semanage fcontext -a -t TYPE "/dir(/.*)?"', back: 'Store a file context rule.' },
    { front: 'restorecon -Rv /dir', back: 'Apply the stored contexts to files.' },
    { front: 'semanage port -a -t http_port_t -p tcp 8888', back: 'Label a new port so Apache may use it. Check semanage port -l first; the port may already have a label.' },
    { front: 'setsebool -P name on', back: 'Turn on a boolean permanently.' },
    { front: 'getsebool -a', back: 'List all booleans and their state.' },
    { front: 'ausearch -m AVC', back: 'Find SELinux denials in the audit log.' },
    { front: 'chcon', back: 'Change a context directly. Lost on relabel, so prefer semanage + restorecon.' },
    { front: 'man semanage-fcontext', back: 'Has examples you can copy during the exam. Install policycoreutils-python-utils for semanage.' },
  ],
  labs: [
    {
      id: 'R23-modes',
      title: 'Back to enforcing',
      intro: 'A colleague put server1 in permissive mode while troubleshooting and forgot to switch it back. Fix it now and for the next boot.',
      setup: (sh) => {
        sh.state.selinux = 'Permissive';
        sh.state.selinuxConfigMode = 'permissive';
      },
      tasks: [
        {
          text: 'Show the current and the configured SELinux mode.',
          hint: 'sestatus',
          check: (sh) => ran(sh, /^(sudo\s+)?sestatus/),
        },
        {
          text: 'Switch to enforcing mode right now.',
          hint: 'sudo setenforce 1',
          check: (sh) => sh.state.selinux === 'Enforcing',
        },
        {
          text: 'Make enforcing the mode at boot by editing /etc/selinux/config.',
          hint: "sudo sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config",
          check: (sh) => sh.state.selinuxConfigMode === 'enforcing',
        },
      ],
    },
  ],
};

export const R24: Module = {
  id: 'R24',
  track: 'rhcsa',
  title: 'firewalld',
  courseRef: 'Video Lesson 28 · Cert Guide Ch. 23',
  summary: 'Zones, services and ports with firewall-cmd.',
  quiz: [
    {
      q: 'You add a service with --permanent only. Is it active now?',
      choices: ['Yes', 'No, run firewall-cmd --reload to apply permanent rules', 'Only after reboot, reload does nothing', 'Only for root'],
      answer: 1,
      why: 'Permanent rules are saved but not applied. Either reload, or add the rule twice (with and without --permanent).',
    },
    {
      q: 'Which command opens TCP port 8080 permanently?',
      choices: ['firewall-cmd --permanent --add-port=8080/tcp', 'firewall-cmd --open 8080', 'firewall-cmd --add-port 8080 --forever', 'iptables -A 8080'],
      answer: 0,
      why: 'Ports need the protocol: 8080/tcp or 53/udp.',
    },
    {
      q: 'What is the default zone on RHEL?',
      choices: ['public', 'trusted', 'home', 'drop'],
      answer: 0,
      why: 'Interfaces without another zone use the default zone. firewall-cmd --get-default-zone shows it.',
    },
    {
      q: 'Why is adding a service better than adding its port?',
      choices: ['A service can include several ports and helpers, and its name is clear', 'Ports do not work', 'Services are faster', 'There is no difference'],
      answer: 0,
      why: 'firewall-cmd --get-services lists the predefined ones. Their definitions are XML files in /usr/lib/firewalld/services.',
    },
    {
      q: 'You tested runtime rules and they work. How do you keep them all?',
      choices: ['firewall-cmd --runtime-to-permanent', 'firewall-cmd --save-all', 'Reboot', 'firewall-cmd --reload'],
      answer: 0,
      why: 'Careful: --reload would throw away runtime-only rules.',
    },
    {
      q: 'Which command shows everything allowed in the default zone?',
      choices: ['firewall-cmd --list-all', 'firewall-cmd --show', 'firewall-cmd --status', 'iptables -L'],
      answer: 0,
      why: 'Add --permanent to see the saved configuration instead of the running one.',
    },
  ],
  cards: [
    { front: 'firewall-cmd --list-all', back: 'What the default zone allows right now.' },
    { front: '--permanent', back: 'Save the rule. It takes effect after --reload.' },
    { front: 'firewall-cmd --reload', back: 'Apply permanent rules; drops runtime-only rules.' },
    { front: '--add-service=http', back: 'Allow a predefined service.' },
    { front: '--add-port=8080/tcp', back: 'Allow a port with its protocol.' },
    { front: '--remove-service / --remove-port', back: 'Take a rule away.' },
    { front: '--runtime-to-permanent', back: 'Save all current runtime rules.' },
    { front: '--get-services', back: 'List predefined service names.' },
    { front: 'Zones', back: 'Sets of rules. Default: public. --zone=NAME to work on another one.' },
  ],
  labs: [
    {
      id: 'R24-firewall',
      title: 'Open and close ports',
      intro: 'server1 will host an application on port 8080 and HTTPS. Cockpit should not be reachable.',
      tasks: [
        {
          text: 'Show what the firewall currently allows.',
          hint: 'sudo firewall-cmd --list-all',
          check: (sh) => ran(sh, /firewall-cmd\s+.*--list-(all|services)/),
        },
        {
          text: 'Permanently allow TCP port 8080.',
          hint: 'sudo firewall-cmd --permanent --add-port=8080/tcp',
          check: (sh) => sh.state.firewall.permPorts.includes('8080/tcp'),
        },
        {
          text: 'Permanently allow the https service.',
          hint: 'sudo firewall-cmd --permanent --add-service=https',
          check: (sh) => sh.state.firewall.permServices.includes('https'),
        },
        {
          text: 'Permanently remove the cockpit service.',
          hint: 'sudo firewall-cmd --permanent --remove-service=cockpit',
          check: (sh) => !sh.state.firewall.permServices.includes('cockpit'),
        },
        {
          text: 'Apply the permanent rules.',
          hint: 'sudo firewall-cmd --reload',
          check: (sh) => sh.state.firewall.ports.includes('8080/tcp') && sh.state.firewall.services.includes('https') && !sh.state.firewall.services.includes('cockpit'),
        },
      ],
    },
  ],
};

export const R25: Module = {
  id: 'R25',
  track: 'rhcsa',
  title: 'NFS and autofs',
  courseRef: 'Video Lesson 29 · Cert Guide Ch. 24',
  summary: 'Mounting NFS shares and configuring autofs.',
  quiz: [
    {
      q: 'Which command shows the shares an NFS server offers?',
      choices: ['showmount -e nfsserver', 'nfs list nfsserver', 'mount -l nfsserver', 'exportfs nfsserver'],
      answer: 0,
      why: 'showmount -e lists the exports. It comes with the nfs-utils package.',
    },
    {
      q: 'Which fstab line mounts nfsserver:/data on /mnt/data at boot?',
      choices: ['nfsserver:/data /mnt/data nfs defaults,_netdev 0 0', '/mnt/data nfsserver:/data nfs 0 0', 'nfs://nfsserver/data /mnt/data', 'nfsserver /data /mnt/data'],
      answer: 0,
      why: '_netdev waits for the network before mounting.',
    },
    {
      q: 'What is the advantage of autofs over fstab for NFS?',
      choices: ['Shares are mounted only when someone uses them, and unmounted when idle', 'It is faster', 'It encrypts NFS', 'It needs no network'],
      answer: 0,
      why: 'The boot also does not hang if the NFS server is down.',
    },
    {
      q: 'In /etc/auto.master, what does "/shares /etc/auto.shares" mean?',
      choices: ['Directories under /shares are defined in the map file /etc/auto.shares', 'Copy /shares to /etc', 'Mount /etc on /shares', 'A comment'],
      answer: 0,
      why: 'The master map names the parent directory and the map file. autofs creates /shares itself.',
    },
    {
      q: 'In an autofs map, what does the line "* -rw nfsserver:/home/&" do?',
      choices: ['Mounts any requested name from the matching directory on the server', 'Mounts everything at once', 'Is invalid', 'Mounts only /home/&'],
      answer: 0,
      why: '* matches the name being accessed and & repeats it. This is the classic setup for home directories.',
    },
    {
      q: 'After changing autofs maps, what do you do?',
      choices: ['systemctl restart autofs (and enable it if not done)', 'mount -a', 'reboot', 'exportfs -r'],
      answer: 0,
      why: 'Changes to /etc/auto.master (or /etc/auto.master.d/) need a restart or reload. Edits to an indirect map like /etc/auto.shares work right away, but restarting is a safe habit.',
    },
  ],
  cards: [
    { front: 'showmount -e server', back: 'List NFS exports.' },
    { front: 'mount server:/share /mnt', back: 'Mount an NFS share by hand.' },
    { front: 'fstab NFS', back: 'server:/share /mnt/x nfs defaults,_netdev 0 0' },
    { front: 'dnf install autofs', back: 'Install the automounter.' },
    { front: '/etc/auto.master', back: 'Master map: parent directory and map file.' },
    { front: '/etc/auto.master.d/*.autofs', back: 'Drop-in master map entries.' },
    { front: 'Map line', back: 'name  -rw  server:/path' },
    { front: 'Wildcard map', back: '*  -rw  server:/home/&' },
    { front: 'systemctl enable --now autofs', back: 'Start the automounter now and at boot.' },
  ],
  labs: [
    {
      id: 'R25-autofs',
      title: 'Automount a share',
      intro: 'nfsserver exports /data. Make it appear automatically as /shares/data on server1.',
      tasks: [
        {
          text: 'Install autofs.',
          hint: 'sudo dnf install -y autofs',
          check: (sh) => sh.state.installed.includes('autofs'),
        },
        {
          text: 'Add the line "/shares /etc/auto.shares" to /etc/auto.master.',
          hint: "echo '/shares /etc/auto.shares' | sudo tee -a /etc/auto.master",
          check: (sh) => /^\/shares\s+\/etc\/auto\.shares$/m.test(text(sh, '/etc/auto.master')),
        },
        {
          text: 'Create the map /etc/auto.shares so "data" mounts nfsserver:/data read-write.',
          hint: "echo 'data -rw nfsserver:/data' | sudo tee /etc/auto.shares",
          check: (sh) => /^data\s+-rw\s+nfsserver:\/data$/m.test(text(sh, '/etc/auto.shares')),
        },
        {
          text: 'Start autofs and make it start at boot.',
          hint: 'sudo systemctl enable --now autofs',
          check: (sh) => !!sh.state.services.autofs?.active && !!sh.state.services.autofs?.enabled,
        },
      ],
    },
  ],
};

export const R26: Module = {
  id: 'R26',
  track: 'rhcsa',
  title: 'Exam prep and mock exam',
  courseRef: 'Video Lessons 30–32 · Cert Guide Ch. 26–27',
  summary: 'Exam tips and a timed, mixed practice exam.',
  quiz: [
    {
      q: 'What should you do before the exam time runs out?',
      choices: ['Reboot every system and check that your work still works', 'Delete your history', 'Turn off SELinux', 'Nothing'],
      answer: 0,
      why: 'Grading happens after a reboot. Anything not persistent is lost.',
    },
    {
      q: 'You are stuck on a task. What is the best approach?',
      choices: ['Move on and come back later', 'Keep trying until it works', 'Reinstall the system', 'Skip all remaining tasks'],
      answer: 0,
      why: 'Every task counts. Do the ones you know first.',
    },
    {
      q: 'You do not remember the exact semanage syntax. Where do you look?',
      choices: ['man semanage-fcontext (the EXAMPLES section)', 'The internet', 'A colleague', '/etc/selinux/config'],
      answer: 0,
      why: 'No internet in the exam. Man pages and /usr/share/doc are your references. man -k helps find the right page.',
    },
    {
      q: 'Why can disabling SELinux to make a task work cost you points?',
      choices: ['Systems are expected to run in enforcing mode, and other tasks may depend on it', 'It cannot be disabled', 'It slows the system', 'It deletes files'],
      answer: 0,
      why: 'Fix the context, port or boolean instead.',
    },
    {
      q: 'An exam task asks for a user with UID 1500 in a secondary group. Which command fits?',
      choices: ['useradd -u 1500 -G group user', 'useradd -g 1500 user', 'usermod -U 1500 user', 'adduser 1500'],
      answer: 0,
      why: '-u sets the UID. -G sets secondary groups; -g would change the primary group.',
    },
  ],
  cards: [
    { front: 'Exam rule 1', back: 'Everything must survive a reboot. Reboot and check before time is up.' },
    { front: 'Exam rule 2', back: 'Keep SELinux enforcing. Fix contexts, ports and booleans instead.' },
    { front: 'Exam rule 3', back: 'Read each task carefully: names, numbers, permissions and paths must match exactly.' },
    { front: 'man -k keyword', back: 'Find the man page you need.' },
    { front: '/usr/share/doc', back: 'Example configuration files and documentation.' },
    { front: 'Test fstab', back: 'mount -a before rebooting.' },
    { front: 'Network tasks', back: 'Use nmcli and check with ip a and ping after nmcli con up.' },
  ],
  labs: [
    {
      id: 'R26-mock',
      title: 'Mock exam',
      intro: 'Exam style tasks across the whole course. Try to finish them without hints, then check your score.',
      setup: (sh) => {
        sh.state.selinux = 'Permissive';
        sh.state.selinuxConfigMode = 'permissive';
      },
      tasks: [
        {
          text: 'Create a group "admins" and a user "lisa" with UID 1500 who has admins as a secondary group.',
          hint: 'sudo groupadd admins && sudo useradd -u 1500 -G admins lisa',
          check: (sh) => userByName(sh, 'lisa')?.uid === 1500 && inGroup(sh, 'lisa', 'admins'),
        },
        {
          text: 'Create /exam/shared with group owner admins, so members can work there and new files get the admins group (mode 2770).',
          hint: 'sudo mkdir -p /exam/shared && sudo chgrp admins /exam/shared && sudo chmod 2770 /exam/shared',
          check: (sh) => groupOf(sh, peek(sh, '/exam/shared')) === 'admins' && permBits(peek(sh, '/exam/shared')) === 0o2770,
        },
        {
          text: 'Install httpd, make it run now and at boot, and allow http in the firewall permanently and now.',
          hint: 'sudo dnf install -y httpd && sudo systemctl enable --now httpd && sudo firewall-cmd --permanent --add-service=http && sudo firewall-cmd --reload',
          check: (sh) => !!sh.state.services.httpd?.active && !!sh.state.services.httpd?.enabled && sh.state.firewall.permServices.includes('http') && sh.state.firewall.services.includes('http'),
        },
        {
          text: 'Make lisa run "/usr/bin/logger exam" at 03:00 on weekdays (Monday to Friday) with cron.',
          hint: "echo '0 3 * * 1-5 /usr/bin/logger exam' | sudo crontab -u lisa -",
          check: (sh) => /^0\s+3\s+\*\s+\*\s+1-5\s+\/usr\/bin\/logger exam/m.test(text(sh, '/var/spool/cron/lisa')),
        },
        {
          text: 'Set the time zone to America/Chicago.',
          hint: 'sudo timedatectl set-timezone America/Chicago',
          check: (sh) => sh.state.timezone === 'America/Chicago',
        },
        {
          text: 'Apply the tuned profile throughput-performance.',
          hint: 'sudo tuned-adm profile throughput-performance',
          check: (sh) => sh.state.tunedProfile === 'throughput-performance',
        },
        {
          text: 'SELinux must be enforcing now and after a reboot.',
          hint: "sudo setenforce 1 && sudo sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config",
          check: (sh) => sh.state.selinux === 'Enforcing' && sh.state.selinuxConfigMode === 'enforcing',
        },
      ],
    },
  ],
};

import { Module, peek, ran } from './types';

// Linux Fundamentals, Lessons 11–19. Original practice material.

const text = (sh: Parameters<typeof peek>[0], path: string) => peek(sh, path)?.content ?? '';

export const F11: Module = {
  id: 'F11',
  track: 'fundamentals',
  title: 'Storage essentials',
  courseRef: 'Linux Fundamentals, Lesson 11',
  summary: 'Disks, partitions, file systems and mounting.',
  quiz: [
    {
      q: 'Which command shows the disks and partitions in a tree, whether they are mounted or not?',
      choices: ['df -h', 'lsblk', 'mount', 'free'],
      answer: 1,
      why: 'lsblk lists every block device and shows which partitions belong to which disk. df only shows file systems that are mounted.',
    },
    {
      q: 'What does df -h show?',
      choices: ['How much space is used and free on each mounted file system', 'Which files are the biggest', 'The partition table', 'Memory usage'],
      answer: 0,
      why: 'df reports disk free space per mounted file system. -h prints sizes like 17G instead of block counts.',
    },
    {
      q: 'What is a mount point?',
      choices: ['A partition number', 'An empty directory where a file system is made visible', 'A type of disk', 'The first sector of a disk'],
      answer: 1,
      why: 'Linux has one directory tree. Mounting attaches a file system to a directory, and its files appear there.',
    },
    {
      q: 'Which file lists the file systems that are mounted automatically at boot?',
      choices: ['/etc/mtab', '/etc/fstab', '/etc/disks', '/boot/mounts'],
      answer: 1,
      why: '/etc/fstab has one line per file system: device, mount point, type, options, dump and fsck order.',
    },
    {
      q: 'What is the default file system on RHEL?',
      choices: ['ext4', 'XFS', 'NTFS', 'FAT32'],
      answer: 1,
      why: 'RHEL uses XFS by default. ext4 is also supported. You create one with mkfs.xfs or mkfs.ext4.',
    },
    {
      q: 'Why is a UUID often used instead of /dev/sdb1 in /etc/fstab?',
      choices: ['It is shorter', 'Device names can change when disks are added; a UUID stays with the file system', 'It is required by XFS', 'It makes the disk faster'],
      answer: 1,
      why: 'Disk names depend on the order the kernel finds them. The UUID is written in the file system itself. blkid shows it.',
    },
    {
      q: 'On a server with NVMe disks, what is nvme0n1p2?',
      choices: ['The second disk', 'Partition 2 on the first NVMe disk', 'A logical volume', 'A swap file'],
      answer: 1,
      why: 'nvme0n1 is the disk and p2 is partition 2. On SATA or virtual disks you would see names like sda2 or vda2.',
    },
  ],
  cards: [
    { front: 'lsblk', back: 'Show disks, partitions and logical volumes as a tree.' },
    { front: 'df -h', back: 'Used and free space on mounted file systems, in human-readable sizes.' },
    { front: 'du -sh dir', back: 'Total size of a directory.' },
    { front: 'Mount point', back: 'A directory where a file system is attached to the tree.' },
    { front: 'mount /dev/sdb1 /data', back: 'Mount a file system by hand. umount /data unmounts it.' },
    { front: '/etc/fstab fields', back: 'device  mountpoint  type  options  dump  fsck — e.g. UUID=… /data xfs defaults 0 0' },
    { front: 'mount -a', back: 'Mount everything in /etc/fstab that is not mounted yet. Use it to test fstab before rebooting.' },
    { front: 'blkid', back: 'Show the UUID and type of each file system.' },
    { front: 'mkfs.xfs /dev/sdb1', back: 'Create an XFS file system on a partition. This erases what was there.' },
    { front: 'Partition tools', back: 'fdisk for interactive use, parted for scripting. Both handle MBR and GPT.' },
  ],
  labs: [
    {
      id: 'F11-storage',
      title: 'Look around the disks',
      intro: 'A second disk was added to server1. Find it, check free space, and prepare /etc/fstab for it.',
      tasks: [
        {
          text: 'List the block devices and find the disk that has no partitions yet.',
          hint: 'lsblk   (nvme0n2 is the empty 10G disk)',
          check: (sh) => ran(sh, /^lsblk/),
        },
        {
          text: 'Save a human-readable report of free space to ~/space.txt.',
          hint: 'df -h > space.txt',
          check: (sh) => text(sh, '/home/student/space.txt').includes('/boot'),
        },
        {
          text: 'Add a line to /etc/fstab that mounts /dev/nvme0n2p1 on /data as xfs with default options.',
          hint: "echo '/dev/nvme0n2p1 /data xfs defaults 0 0' | sudo tee -a /etc/fstab",
          check: (sh) => /^\/dev\/nvme0n2p1\s+\/data\s+xfs\s+defaults\s+0\s+0$/m.test(text(sh, '/etc/fstab')),
        },
        {
          text: 'Create the /data mount point.',
          hint: 'sudo mkdir /data',
          check: (sh) => peek(sh, '/data')?.type === 'dir',
        },
      ],
    },
  ],
};

export const F12: Module = {
  id: 'F12',
  track: 'fundamentals',
  title: 'Networking basics',
  courseRef: 'Linux Fundamentals, Lesson 12',
  summary: 'IP addresses, ip, ping and host names.',
  quiz: [
    {
      q: 'Which command shows the IP addresses of this machine?',
      choices: ['ip a', 'ifconfig -all', 'netstat -ip', 'hostname -ip'],
      answer: 0,
      why: 'ip a (short for ip address show) lists each interface and its addresses. ifconfig is old and not installed by default.',
    },
    {
      q: 'What does the /24 in 192.168.4.100/24 mean?',
      choices: ['The host number', 'The first 24 bits are the network part, so the network is 192.168.4.0', 'Port 24', 'The address expires in 24 hours'],
      answer: 1,
      why: '/24 is the prefix length, the same as netmask 255.255.255.0. Machines in 192.168.4.x are on the same network.',
    },
    {
      q: 'What is the default gateway?',
      choices: ['The DNS server', 'The router that traffic to other networks is sent to', 'The first IP on the machine', 'The firewall'],
      answer: 1,
      why: 'Anything not on your own network goes to the default gateway. ip route shows it as "default via …".',
    },
    {
      q: 'Which command tests whether you can reach another host?',
      choices: ['ping -c 3 host', 'reach host', 'ip test host', 'nc -ping host'],
      answer: 0,
      why: 'ping sends small packets and reports replies. -c 3 stops after three, otherwise it runs until Ctrl+C.',
    },
    {
      q: 'Which file sets which DNS servers the system uses (as written by NetworkManager)?',
      choices: ['/etc/hosts', '/etc/resolv.conf', '/etc/hostname', '/etc/dns.conf'],
      answer: 1,
      why: '/etc/resolv.conf lists nameservers. On RHEL, NetworkManager manages it, so set DNS with nmcli instead of editing it.',
    },
    {
      q: 'How do you change the host name permanently?',
      choices: ['hostname newname', 'hostnamectl set-hostname newname', 'echo newname', 'nmcli hostname --temp'],
      answer: 1,
      why: 'hostnamectl set-hostname writes /etc/hostname, so the name survives a reboot. Plain hostname changes it only until reboot.',
    },
    {
      q: 'What is 127.0.0.1?',
      choices: ['The router', 'The loopback address: this machine itself', 'A public DNS server', 'An invalid address'],
      answer: 1,
      why: 'The lo interface always has 127.0.0.1, also called localhost.',
    },
  ],
  cards: [
    { front: 'ip a', back: 'Show interfaces and IP addresses.' },
    { front: 'ip route', back: 'Show the routing table. "default via X" is the gateway.' },
    { front: '/24', back: 'Netmask 255.255.255.0. The first three numbers are the network.' },
    { front: 'Default gateway', back: 'Router that receives traffic for other networks.' },
    { front: 'ping -c 3 host', back: 'Send three test packets to check a host is reachable.' },
    { front: '/etc/hosts', back: 'Fixed name-to-IP mappings, checked before DNS.' },
    { front: '/etc/resolv.conf', back: 'The DNS servers in use. Managed by NetworkManager on RHEL.' },
    { front: 'hostnamectl set-hostname', back: 'Change the host name permanently.' },
    { front: 'ss -tuln', back: 'Show listening TCP and UDP ports.' },
    { front: 'lo / 127.0.0.1', back: 'Loopback: the machine talking to itself.' },
  ],
  labs: [
    {
      id: 'F12-network',
      title: 'Check the network',
      intro: 'Find out how server1 is connected and give it a new name.',
      tasks: [
        {
          text: 'Show the IP addresses of server1.',
          hint: 'ip a',
          check: (sh) => ran(sh, /^ip\s+(a|addr|address)\b/),
        },
        {
          text: 'Check that web01 can be reached, sending exactly 3 packets.',
          hint: 'ping -c 3 web01',
          check: (sh) => ran(sh, /^ping\s+.*-c\s*3/),
        },
        {
          text: 'Add db01 with IP 192.168.4.20 to /etc/hosts.',
          hint: "echo '192.168.4.20 db01.example.com db01' | sudo tee -a /etc/hosts",
          check: (sh) => /^192\.168\.4\.20\s+.*\bdb01\b/m.test(text(sh, '/etc/hosts')),
        },
        {
          text: 'Permanently change the host name to server1.lab.example.com.',
          hint: 'sudo hostnamectl set-hostname server1.lab.example.com',
          check: (sh) => sh.state.hostname === 'server1.lab.example.com',
        },
      ],
    },
  ],
};

export const F13: Module = {
  id: 'F13',
  track: 'fundamentals',
  title: 'systemd and services',
  courseRef: 'Linux Fundamentals, Lesson 13',
  summary: 'Starting, stopping and enabling services with systemctl.',
  quiz: [
    {
      q: 'What is the difference between systemctl start and systemctl enable?',
      choices: ['None', 'start runs it now; enable makes it start at boot', 'enable runs it now; start makes it start at boot', 'start is for root only'],
      answer: 1,
      why: 'They are separate. Use systemctl enable --now to do both in one command.',
    },
    {
      q: 'Which command shows whether sshd is running and its latest log lines?',
      choices: ['systemctl status sshd', 'systemctl list sshd', 'ps sshd', 'service sshd'],
      answer: 0,
      why: 'status shows Loaded (enabled or not), Active (running or not) and recent log messages.',
    },
    {
      q: 'What is PID 1 on a RHEL system?',
      choices: ['bash', 'systemd', 'init.d', 'kernel'],
      answer: 1,
      why: 'systemd is the first process the kernel starts. It starts and watches every other service.',
    },
    {
      q: 'You changed a service\'s configuration file. What do you usually run next?',
      choices: ['systemctl restart <service>', 'systemctl enable <service>', 'reboot', 'Nothing'],
      answer: 0,
      why: 'Most services read their configuration only at start. Restart (or reload, if supported) to apply changes.',
    },
    {
      q: 'Which command lists all service unit files and whether they are enabled?',
      choices: ['systemctl list-unit-files', 'systemctl list-units --failed', 'ls /etc/services', 'systemctl show'],
      answer: 0,
      why: 'list-unit-files shows every installed unit and its enabled/disabled state. list-units shows only loaded ones.',
    },
    {
      q: 'What does systemctl mask do?',
      choices: ['Hides the service from status', 'Makes it impossible to start the service, even by hand', 'Restarts it quietly', 'Removes the package'],
      answer: 1,
      why: 'A masked unit is linked to /dev/null so nothing can start it. unmask reverses it.',
    },
    {
      q: 'Where should your own changes to a unit file go?',
      choices: ['/usr/lib/systemd/system', '/etc/systemd/system', '/var/lib/systemd', '/home/student'],
      answer: 1,
      why: '/usr/lib/systemd/system belongs to packages and is overwritten on updates. Files in /etc/systemd/system win. systemctl edit creates them for you.',
    },
  ],
  cards: [
    { front: 'systemctl start / stop', back: 'Start or stop a service now.' },
    { front: 'systemctl enable / disable', back: 'Start, or do not start, a service at boot.' },
    { front: 'systemctl enable --now', back: 'Enable at boot and start right away.' },
    { front: 'systemctl status', back: 'Is it enabled, is it running, latest log lines.' },
    { front: 'systemctl is-active / is-enabled', back: 'One-word answers, handy in scripts.' },
    { front: 'systemctl restart / reload', back: 'Restart stops and starts. Reload only rereads the config, if the service supports it.' },
    { front: 'systemctl mask', back: 'Block a unit from being started at all.' },
    { front: 'Unit types', back: '.service, .socket, .timer, .mount, .target and more.' },
    { front: '/etc/systemd/system', back: 'Admin unit files and overrides. Wins over /usr/lib/systemd/system.' },
    { front: 'systemctl --failed', back: 'Show units that failed to start.' },
  ],
  labs: [
    {
      id: 'F13-services',
      title: 'Manage services',
      intro: 'Someone stopped and disabled the scheduler services on server1. Put them back.',
      setup: (sh) => {
        sh.state.services.crond.active = false;
        sh.state.services.atd.active = false;
        sh.state.services.atd.enabled = false;
      },
      tasks: [
        {
          text: 'Check the status of crond.',
          hint: 'systemctl status crond',
          check: (sh) => ran(sh, /^systemctl\s+status\s+crond/),
        },
        {
          text: 'Start crond.',
          hint: 'sudo systemctl start crond',
          check: (sh) => sh.state.services.crond.active,
        },
        {
          text: 'Make atd start at boot and start it now, in one command.',
          hint: 'sudo systemctl enable --now atd',
          check: (sh) => sh.state.services.atd.active && sh.state.services.atd.enabled,
        },
        {
          text: 'Disable tuned at boot but leave it running.',
          hint: 'sudo systemctl disable tuned',
          check: (sh) => !sh.state.services.tuned.enabled && sh.state.services.tuned.active,
        },
      ],
    },
  ],
};

export const F14: Module = {
  id: 'F14',
  track: 'fundamentals',
  title: 'Managing software',
  courseRef: 'Linux Fundamentals, Lesson 14',
  summary: 'Installing and removing packages with dnf.',
  quiz: [
    {
      q: 'Which command installs the tmux package without asking for confirmation?',
      choices: ['dnf install -y tmux', 'rpm -i tmux', 'dnf get tmux', 'install tmux'],
      answer: 0,
      why: 'dnf downloads the package and its dependencies from the repositories. -y answers yes.',
    },
    {
      q: 'What is a repository?',
      choices: ['A folder in your home directory', 'A collection of packages that dnf can install from', 'A backup', 'A Git server'],
      answer: 1,
      why: 'Repositories are configured in /etc/yum.repos.d. On RHEL you get them through your subscription.',
    },
    {
      q: 'You need the semanage command but do not know which package has it. What do you run?',
      choices: ['dnf provides */semanage', 'dnf find semanage', 'rpm -q semanage', 'which semanage'],
      answer: 0,
      why: 'dnf provides searches the files in all packages and tells you which one contains it.',
    },
    {
      q: 'What does rpm -qa show?',
      choices: ['All packages in the repositories', 'All installed packages', 'Packages with updates', 'Package errors'],
      answer: 1,
      why: 'rpm -q queries the local package database. -a means all. dnf list installed shows the same.',
    },
    {
      q: 'Why use dnf instead of rpm -i to install a downloaded package?',
      choices: ['rpm cannot install packages', 'dnf also installs missing dependencies from the repositories', 'dnf is faster', 'rpm needs internet'],
      answer: 1,
      why: 'rpm installs exactly the file you give it and fails on missing dependencies. dnf resolves them.',
    },
    {
      q: 'Which command updates every installed package?',
      choices: ['dnf update', 'dnf upgrade-all', 'rpm -U *', 'dnf refresh'],
      answer: 0,
      why: 'dnf update (or dnf upgrade) installs newer versions of all packages.',
    },
    {
      q: 'Which command shows the description and version of the httpd package?',
      choices: ['dnf info httpd', 'dnf show httpd', 'rpm httpd', 'man httpd'],
      answer: 0,
      why: 'dnf info shows details for installed and available packages.',
    },
  ],
  cards: [
    { front: 'dnf install pkg', back: 'Install a package and its dependencies.' },
    { front: 'dnf remove pkg', back: 'Remove a package.' },
    { front: 'dnf search word', back: 'Find packages by name or summary.' },
    { front: 'dnf info pkg', back: 'Version, summary and description.' },
    { front: 'dnf provides */file', back: 'Which package contains this file.' },
    { front: 'dnf update', back: 'Update all packages.' },
    { front: 'dnf list installed', back: 'List installed packages. rpm -qa does the same.' },
    { front: '/etc/yum.repos.d', back: 'Repository configuration files (.repo).' },
    { front: 'rpm -qf /path', back: 'Which installed package owns this file.' },
    { front: 'rpm -ql pkg', back: 'List the files a package installed.' },
  ],
  labs: [
    {
      id: 'F14-software',
      title: 'Install some tools',
      intro: 'Set up server1 with a few tools you like to have.',
      tasks: [
        {
          text: 'Search the repositories for a "terminal multiplexer".',
          hint: 'dnf search multiplexer',
          check: (sh) => ran(sh, /^dnf\s+search\s+/),
        },
        {
          text: 'Install tmux and tree.',
          hint: 'sudo dnf install -y tmux tree',
          check: (sh) => sh.state.installed.includes('tmux') && sh.state.installed.includes('tree'),
        },
        {
          text: 'Show information about the httpd package without installing it.',
          hint: 'dnf info httpd',
          check: (sh) => ran(sh, /^dnf\s+info\s+httpd/) && !sh.state.installed.includes('httpd'),
        },
        {
          text: 'Save the list of installed packages to ~/packages.txt.',
          hint: 'dnf list installed > packages.txt   (or rpm -qa > packages.txt)',
          check: (sh) => text(sh, '/home/student/packages.txt').includes('tmux'),
        },
      ],
    },
  ],
};

export const F15: Module = {
  id: 'F15',
  track: 'fundamentals',
  title: 'Managing SSH',
  courseRef: 'Linux Fundamentals, Lesson 15',
  summary: 'Configuring the SSH server and using key-based login.',
  quiz: [
    {
      q: 'Which file configures the SSH server?',
      choices: ['/etc/ssh/ssh_config', '/etc/ssh/sshd_config', '~/.ssh/config', '/etc/sshd'],
      answer: 1,
      why: 'sshd_config (with the d, for daemon) is the server. ssh_config is for the client.',
    },
    {
      q: 'After changing sshd_config, what must you do?',
      choices: ['Nothing', 'Restart sshd', 'Reboot', 'Log out'],
      answer: 1,
      why: 'sshd reads its config at start. systemctl restart sshd applies the change. Your current session stays open.',
    },
    {
      q: 'Which setting stops root from logging in over SSH?',
      choices: ['PermitRootLogin no', 'RootLogin off', 'DenyUsers all', 'AllowRoot false'],
      answer: 0,
      why: 'Many admins block direct root logins and log in as a normal user with sudo instead.',
    },
    {
      q: 'Where does ssh-copy-id put your public key on the server?',
      choices: ['/etc/ssh/keys', '~/.ssh/authorized_keys of the target user', '/root/.ssh/id_rsa', '~/.ssh/known_hosts'],
      answer: 1,
      why: 'Each line in authorized_keys is a public key that may log in as that user.',
    },
    {
      q: 'Lines in sshd_config that start with # show…',
      choices: ['Errors', 'The default value, which is active even though the line is commented out', 'Settings that are turned on', 'Nothing useful'],
      answer: 1,
      why: 'The file lists defaults as comments. To change one, remove the # and set the value you want.',
    },
    {
      q: 'You move SSH to port 2022 on RHEL. What else is needed besides the Port line?',
      choices: ['Nothing', 'Allow the port in SELinux (semanage port) and in the firewall', 'Reinstall openssh', 'Change /etc/services only'],
      answer: 1,
      why: 'SELinux only lets sshd bind to ports labeled ssh_port_t, and firewalld blocks unknown ports. Both must allow 2022.',
    },
    {
      q: 'What permissions should ~/.ssh have?',
      choices: ['777', '700', '644', '755'],
      answer: 1,
      why: 'sshd refuses keys if ~/.ssh or authorized_keys can be written by others. 700 for the directory, 600 for the files.',
    },
  ],
  cards: [
    { front: '/etc/ssh/sshd_config', back: 'SSH server settings. Restart sshd after changing it.' },
    { front: '/etc/ssh/sshd_config.d/', back: 'Drop-in files that are included by sshd_config.' },
    { front: 'PermitRootLogin no', back: 'Block direct root login over SSH.' },
    { front: 'PasswordAuthentication no', back: 'Only allow key-based login. Copy your key first!' },
    { front: 'Port 2022', back: 'Run sshd on another port. Also update SELinux and the firewall.' },
    { front: 'ssh-keygen', back: 'Create a key pair in ~/.ssh.' },
    { front: 'ssh-copy-id user@host', back: 'Copy your public key into the server\'s authorized_keys.' },
    { front: '~/.ssh permissions', back: 'Directory 700, private key and authorized_keys 600.' },
    { front: 'sshd -t', back: 'Test sshd_config for errors before restarting.' },
    { front: '/var/log/secure', back: 'Where SSH logins and failures are logged.' },
  ],
  labs: [
    {
      id: 'F15-ssh',
      title: 'Harden the SSH server',
      intro: 'Tighten the SSH server settings on server1. The practice terminal has no editor, so use sed -i to change lines.',
      tasks: [
        {
          text: 'Look at the current sshd_config (it is only readable by root).',
          hint: 'sudo cat /etc/ssh/sshd_config',
          check: (sh) => ran(sh, /^sudo\s+(cat|less|grep).*sshd_config/),
        },
        {
          text: 'Set PermitRootLogin to no.',
          hint: "sudo sed -i 's/^#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
          check: (sh) => /^PermitRootLogin\s+no$/m.test(text(sh, '/etc/ssh/sshd_config')),
        },
        {
          text: 'Allow at most 3 login attempts per connection, by adding MaxAuthTries 3.',
          hint: "echo 'MaxAuthTries 3' | sudo tee -a /etc/ssh/sshd_config",
          check: (sh) => /^MaxAuthTries\s+3$/m.test(text(sh, '/etc/ssh/sshd_config')),
        },
        {
          text: 'Restart sshd so the changes take effect.',
          hint: 'sudo systemctl restart sshd',
          check: (sh) => ran(sh, /systemctl\s+(restart|reload)\s+sshd/) && sh.state.services.sshd.active,
        },
      ],
    },
  ],
};

export const F16: Module = {
  id: 'F16',
  track: 'fundamentals',
  title: 'Managing time',
  courseRef: 'Linux Fundamentals, Lesson 16',
  summary: 'Time zones, the system clock and NTP.',
  quiz: [
    {
      q: 'Which command shows the time, the time zone and whether the clock is synchronized?',
      choices: ['timedatectl', 'date -z', 'clock', 'ntpq'],
      answer: 0,
      why: 'timedatectl with no options gives a full overview, including the NTP state.',
    },
    {
      q: 'Which service keeps the clock in sync with NTP servers on RHEL?',
      choices: ['ntpd', 'chronyd', 'timesyncd', 'crond'],
      answer: 1,
      why: 'RHEL uses chrony. Its configuration is /etc/chrony.conf.',
    },
    {
      q: 'How do you set the time zone to Europe/Amsterdam?',
      choices: ['timedatectl set-timezone Europe/Amsterdam', 'date --tz Amsterdam', 'export TZ=Europe/Amsterdam', 'echo Amsterdam > /etc/timezone'],
      answer: 0,
      why: 'set-timezone updates the /etc/localtime link. timedatectl list-timezones shows the valid names.',
    },
    {
      q: 'What is the hardware clock (RTC)?',
      choices: ['A clock in the firmware that keeps time while the machine is off', 'The clock in the top bar', 'An NTP server', 'A systemd timer'],
      answer: 0,
      why: 'At boot, Linux reads the RTC to set the system clock. Linux usually keeps the RTC in UTC.',
    },
    {
      q: 'Which line in /etc/chrony.conf adds an NTP server?',
      choices: ['server time.example.com iburst', 'ntp=time.example.com', 'sync time.example.com', 'NTPServer time.example.com'],
      answer: 0,
      why: 'server (or pool) lines list time sources. iburst speeds up the first sync. Restart chronyd afterwards.',
    },
    {
      q: 'Which command shows which time sources chrony is using?',
      choices: ['chronyc sources', 'chronyd -l', 'timedatectl sources', 'ntpstat -a'],
      answer: 0,
      why: 'A * in front of a source means it is the one currently selected.',
    },
  ],
  cards: [
    { front: 'timedatectl', back: 'Show time, time zone and NTP state.' },
    { front: 'timedatectl set-timezone Zone', back: 'Change the time zone.' },
    { front: 'timedatectl list-timezones', back: 'All valid time zone names.' },
    { front: 'timedatectl set-ntp true', back: 'Turn on automatic time sync (starts chronyd).' },
    { front: 'chronyd', back: 'The NTP service on RHEL.' },
    { front: '/etc/chrony.conf', back: 'NTP sources: server or pool lines.' },
    { front: 'chronyc sources', back: 'Show NTP sources. * = currently used.' },
    { front: 'date', back: 'Show the current date and time.' },
    { front: 'RTC', back: 'Hardware clock that runs while the machine is off. hwclock reads it.' },
    { front: 'UTC', back: 'Universal time. Servers often run in UTC to avoid daylight saving confusion.' },
  ],
  labs: [
    {
      id: 'F16-time',
      title: 'Set the clock',
      intro: 'server1 is moving to a data centre in Amsterdam and its time sync was switched off.',
      setup: (sh) => {
        sh.state.ntp = false;
        sh.state.services.chronyd.active = false;
      },
      tasks: [
        {
          text: 'Show the current time settings.',
          hint: 'timedatectl',
          check: (sh) => ran(sh, /^timedatectl(\s+status)?\s*$/),
        },
        {
          text: 'Set the time zone to Europe/Amsterdam.',
          hint: 'sudo timedatectl set-timezone Europe/Amsterdam',
          check: (sh) => sh.state.timezone === 'Europe/Amsterdam',
        },
        {
          text: 'Turn automatic time synchronization back on.',
          hint: 'sudo timedatectl set-ntp true',
          check: (sh) => sh.state.ntp && sh.state.services.chronyd.active,
        },
        {
          text: 'Check which NTP sources chrony uses.',
          hint: 'chronyc sources',
          check: (sh) => ran(sh, /^chronyc\s+sources/),
        },
      ],
    },
  ],
};

export const F17: Module = {
  id: 'F17',
  track: 'fundamentals',
  title: 'Processes',
  courseRef: 'Linux Fundamentals, Lesson 17',
  summary: 'Viewing and controlling processes with ps, top and kill.',
  quiz: [
    {
      q: 'Which command lists every process on the system with its user, CPU and memory use?',
      choices: ['ps aux', 'ps', 'jobs', 'ls /proc'],
      answer: 0,
      why: 'Plain ps only shows processes in your own terminal. ps aux shows all of them.',
    },
    {
      q: 'What signal does kill send by default?',
      choices: ['SIGKILL (9)', 'SIGTERM (15)', 'SIGHUP (1)', 'SIGSTOP (19)'],
      answer: 1,
      why: 'SIGTERM asks the process to stop cleanly. Use kill -9 only when it does not respond.',
    },
    {
      q: 'Which key in top sorts processes by memory?',
      choices: ['M', 'P', 'k', 'q'],
      answer: 0,
      why: 'In top, P sorts by CPU, M by memory, k kills a process and q quits.',
    },
    {
      q: 'What does a higher nice value mean?',
      choices: ['Higher priority', 'Lower priority: the process is "nicer" to others', 'More memory', 'It runs as root'],
      answer: 1,
      why: 'Nice ranges from -20 (most favored) to 19 (least). Only root can lower the nice value.',
    },
    {
      q: 'How do you stop all processes named dd?',
      choices: ['pkill dd', 'kill dd', 'stop dd', 'ps -k dd'],
      answer: 0,
      why: 'kill needs a PID. pkill and killall find processes by name.',
    },
    {
      q: 'You started a long command and want it to run in the background. What do you add at the end?',
      choices: ['&', '|', ';', '>'],
      answer: 0,
      why: 'command & starts it as a background job. jobs lists jobs and fg brings one back.',
    },
    {
      q: 'Can user student kill a process owned by root?',
      choices: ['Yes, always', 'No, only its own processes, unless using sudo', 'Only with kill -9', 'Only in top'],
      answer: 1,
      why: 'Normal users can send signals only to their own processes.',
    },
  ],
  cards: [
    { front: 'ps aux', back: 'All processes with user, PID, %CPU, %MEM and command.' },
    { front: 'ps aux --sort=-%cpu', back: 'Busiest processes first.' },
    { front: 'top', back: 'Live process view. P = CPU, M = memory, k = kill, q = quit.' },
    { front: 'kill PID', back: 'Send SIGTERM (15): please stop.' },
    { front: 'kill -9 PID', back: 'SIGKILL: stop now, no clean-up. Last resort.' },
    { front: 'pkill name', back: 'Signal processes by name.' },
    { front: 'nice -n 10 cmd', back: 'Start a command with lower priority.' },
    { front: 'renice -n 5 -p PID', back: 'Change the priority of a running process.' },
    { front: 'cmd &, jobs, fg, bg', back: 'Run in background, list jobs, bring to front, continue in background.' },
    { front: 'Ctrl+Z', back: 'Pause the foreground job. bg continues it in the background.' },
  ],
  labs: [
    {
      id: 'F17-procs',
      title: 'The server is slow',
      intro: 'Users say server1 is slow. Find the processes that are hogging it and deal with them.',
      tasks: [
        {
          text: 'List all processes, busiest CPU first.',
          hint: 'ps aux --sort=-%cpu',
          check: (sh) => ran(sh, /^(ps\s+aux\s+--sort=-%cpu|top)/),
        },
        {
          text: 'The dd process is yours. Stop it.',
          hint: 'kill 1650   (or pkill dd)',
          check: (sh) => !sh.state.processes.some((p) => p.cmd.startsWith('dd ')),
        },
        {
          text: 'memhog belongs to root and is needed, but give it the lowest priority (nice 19).',
          hint: 'sudo renice -n 19 -p 1702',
          check: (sh) => sh.state.processes.find((p) => p.pid === 1702)?.nice === 19,
        },
      ],
    },
  ],
};

export const F18: Module = {
  id: 'F18',
  track: 'fundamentals',
  title: 'Scheduling tasks',
  courseRef: 'Linux Fundamentals, Lesson 18',
  summary: 'Running jobs later with cron, at and systemd timers.',
  quiz: [
    {
      q: 'In the cron line "30 2 * * 1 /usr/local/bin/backup.sh", when does it run?',
      choices: ['Every day at 2:30', 'Mondays at 02:30', 'On the 30th at 2 PM', 'Every 30 minutes'],
      answer: 1,
      why: 'The fields are minute, hour, day of month, month, day of week. Day of week 1 is Monday.',
    },
    {
      q: 'Which command edits your own crontab?',
      choices: ['crontab -e', 'vi /etc/crontab', 'cron edit', 'at -e'],
      answer: 0,
      why: 'crontab -e opens your crontab in an editor and installs it when you save. crontab -l shows it.',
    },
    {
      q: 'Which tool runs a command once at a set time?',
      choices: ['at', 'cron', 'nice', 'watch'],
      answer: 0,
      why: 'at runs a job one time. cron and timers repeat.',
    },
    {
      q: 'What does */15 in the minute field mean?',
      choices: ['At minute 15', 'Every 15 minutes', '15 times an hour', 'Minute 1 to 15'],
      answer: 1,
      why: '*/15 is every value divisible by 15: minutes 0, 15, 30 and 45.',
    },
    {
      q: 'Which command lists the systemd timers and when they run next?',
      choices: ['systemctl list-timers', 'crontab -l', 'atq', 'timedatectl'],
      answer: 0,
      why: 'Timers are units that start a matching .service on a schedule.',
    },
    {
      q: 'Where should a package or admin put a system-wide cron job?',
      choices: ['A file in /etc/cron.d', '/var/spool/cron/root only', '~/.cron', '/etc/hosts'],
      answer: 0,
      why: 'Files in /etc/cron.d have an extra user field after the schedule. User crontabs live in /var/spool/cron.',
    },
  ],
  cards: [
    { front: 'Cron fields', back: 'minute  hour  day-of-month  month  day-of-week  command' },
    { front: '0 2 * * *', back: 'Every day at 02:00.' },
    { front: '*/10 * * * *', back: 'Every 10 minutes.' },
    { front: '0 9 * * 1-5', back: 'Weekdays at 09:00.' },
    { front: 'crontab -e / -l / -r', back: 'Edit / list / remove your crontab.' },
    { front: 'crontab -u anna -e', back: 'Root edits anna\'s crontab.' },
    { front: '/etc/cron.d', back: 'System cron files, with a user field.' },
    { front: 'at now + 1 hour', back: 'Run commands (from STDIN) once, an hour from now.' },
    { front: 'atq / atrm N', back: 'List pending at jobs / remove job N.' },
    { front: 'systemctl list-timers', back: 'systemd timers and their next run.' },
  ],
  labs: [
    {
      id: 'F18-schedule',
      title: 'Automate the chores',
      intro: 'Schedule a backup, a one-time reminder, and a weekly clean-up. crontab -e needs an editor, so pipe lines into crontab - instead.',
      tasks: [
        {
          text: 'As student, run /home/student/backup.sh every day at 23:30.',
          hint: 'echo "30 23 * * * /home/student/backup.sh" | crontab -',
          check: (sh) => /^30\s+23\s+\*\s+\*\s+\*\s+\/home\/student\/backup\.sh/m.test(text(sh, '/var/spool/cron/student')),
        },
        {
          text: 'Schedule a one-time job that runs "touch /tmp/reminder" in 2 hours.',
          hint: 'echo "touch /tmp/reminder" | at now + 2 hours',
          check: (sh) => sh.state.atJobs.some((j) => j.user === 'student'),
        },
        {
          text: 'Turn on the weekly fstrim timer and start it now.',
          hint: 'sudo systemctl enable --now fstrim.timer',
          check: (sh) => sh.state.services['fstrim.timer'].enabled && sh.state.services['fstrim.timer'].active,
        },
      ],
    },
  ],
};

export const F19: Module = {
  id: 'F19',
  track: 'fundamentals',
  title: 'Reading log files',
  courseRef: 'Linux Fundamentals, Lesson 19',
  summary: 'Finding answers in journald and /var/log.',
  quiz: [
    {
      q: 'Which two logging systems run side by side on RHEL?',
      choices: ['systemd-journald and rsyslog', 'syslog-ng and logstash', 'auditd and cron', 'journald only'],
      answer: 0,
      why: 'journald collects everything. rsyslog writes copies to text files in /var/log.',
    },
    {
      q: 'Which file has the general system messages?',
      choices: ['/var/log/messages', '/var/log/secure', '/var/log/boot', '/etc/log'],
      answer: 0,
      why: '/var/log/messages has most messages. Logins and sudo go to /var/log/secure.',
    },
    {
      q: 'Which command shows log messages for the sshd service only?',
      choices: ['journalctl -u sshd', 'journalctl sshd -all', 'grep sshd /etc/ssh', 'systemctl log sshd'],
      answer: 0,
      why: '-u filters on a unit. Combine with -f to follow new messages.',
    },
    {
      q: 'What does journalctl -p err show?',
      choices: ['Only messages with priority error or more severe', 'Messages from the err service', 'Errors in journalctl', 'The last error'],
      answer: 0,
      why: '-p filters on priority. err includes crit, alert and emerg too.',
    },
    {
      q: 'Which command keeps showing new lines as they are added to /var/log/messages?',
      choices: ['tail -f /var/log/messages', 'cat -f /var/log/messages', 'less -n', 'head -f'],
      answer: 0,
      why: 'tail -f follows the file. Press Ctrl+C to stop. journalctl -f does the same for the journal.',
    },
    {
      q: 'By default on RHEL, are journal messages kept after a reboot?',
      choices: ['Yes, always', 'Only if /var/log/journal exists or Storage=persistent is set', 'Never', 'Only for root'],
      answer: 1,
      why: 'Without /var/log/journal the journal lives in /run and is lost at reboot. rsyslog files in /var/log are kept.',
    },
    {
      q: 'Why does student see "not seeing messages from other users and the system" in journalctl?',
      choices: ['The journal is broken', 'Only root and members of wheel (or adm) can read the full journal', 'journald is stopped', 'Logs are encrypted'],
      answer: 1,
      why: 'Use sudo or add the user to wheel or adm to read system messages.',
    },
  ],
  cards: [
    { front: 'journalctl', back: 'Read the systemd journal.' },
    { front: 'journalctl -u unit', back: 'Messages for one service.' },
    { front: 'journalctl -p err', back: 'Errors and worse only.' },
    { front: 'journalctl -f', back: 'Follow new messages live.' },
    { front: 'journalctl -b', back: 'Messages since the last boot.' },
    { front: 'journalctl -n 20', back: 'The last 20 messages.' },
    { front: '/var/log/messages', back: 'General system log (written by rsyslog).' },
    { front: '/var/log/secure', back: 'Logins, sudo and SSH authentication.' },
    { front: 'tail -f file', back: 'Watch a log file grow.' },
    { front: 'Persistent journal', back: 'mkdir /var/log/journal and restart systemd-journald to keep logs across reboots.' },
  ],
  labs: [
    {
      id: 'F19-logs',
      title: 'Investigate the logs',
      intro: 'Someone reported SSH problems on server1. Use the logs to find out what happened.',
      tasks: [
        {
          text: 'Show the journal messages for the sshd service.',
          hint: 'journalctl -u sshd',
          check: (sh) => ran(sh, /journalctl\s+.*-u\s+sshd/),
        },
        {
          text: 'Save all error messages from the journal to ~/errors.txt.',
          hint: 'journalctl -p err > errors.txt',
          check: (sh) => text(sh, '/home/student/errors.txt').includes('preventing'),
        },
        {
          text: 'Find the failed SSH logins in /var/log/secure and save them to ~/failed.txt.',
          hint: 'sudo grep Failed /var/log/secure > failed.txt',
          check: (sh) => (text(sh, '/home/student/failed.txt').match(/Failed password/g) ?? []).length === 2,
        },
        {
          text: 'Show the last 3 lines of /var/log/messages.',
          hint: 'sudo tail -n 3 /var/log/messages',
          check: (sh) => ran(sh, /tail\s+(-n\s*3|-3)\s+\/var\/log\/messages/),
        },
      ],
    },
  ],
};

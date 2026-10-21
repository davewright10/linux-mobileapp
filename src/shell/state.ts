import { FsNode, makeDir, makeFile, makeLink } from './fs';

export interface User {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  comment: string;
  password: string | null; // null = no password set ("!!" in shadow)
  locked: boolean;
  maxDays: number;
  minDays: number;
  warnDays: number;
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

export interface Service {
  name: string;
  description: string;
  active: boolean;
  enabled: boolean;
  installedBy?: string; // package that provides it
}

export interface SystemState {
  hostname: string;
  root: FsNode;
  users: User[];
  groups: Group[];
  services: Record<string, Service>;
  installed: string[];
  selinux: 'Enforcing' | 'Permissive' | 'Disabled';
  selinuxConfigMode: 'enforcing' | 'permissive' | 'disabled';
  firewall: { services: string[]; ports: string[]; permServices: string[]; permPorts: string[] };
  defaultTarget: string;
}

export const AVAILABLE_PACKAGES: Record<string, { summary: string; service?: string; version: string }> = {
  httpd: { summary: 'Apache HTTP Server', service: 'httpd', version: '2.4.63-1.el10' },
  vsftpd: { summary: 'Very Secure Ftp Daemon', service: 'vsftpd', version: '3.0.5-10.el10' },
  nfs_utils: { summary: 'NFS utilities and supporting clients and daemons', service: 'nfs-server', version: '2.8.2-3.el10' },
  autofs: { summary: 'A tool for automatically mounting and unmounting filesystems', service: 'autofs', version: '5.1.9-8.el10' },
  chrony: { summary: 'An NTP client/server', service: 'chronyd', version: '4.6.1-1.el10' },
  tmux: { summary: 'A terminal multiplexer', version: '3.4-6.el10' },
  vim_enhanced: { summary: 'A version of the VIM editor which includes recent enhancements', version: '9.1.083-5.el10' },
  nano: { summary: 'A small text editor', version: '8.1-2.el10' },
  tree: { summary: 'File system tree viewer', version: '2.1.0-8.el10' },
  bash_completion: { summary: 'Programmable completion for Bash', version: '2.11-16.el10' },
  mariadb_server: { summary: 'The MariaDB server and related files', service: 'mariadb', version: '10.11.11-1.el10' },
  tuned: { summary: 'A dynamic adaptive system tuning daemon', service: 'tuned', version: '2.25.1-1.el10' },
};

// dnf names use dashes; keys above use underscores to stay valid identifiers
export const pkgKey = (name: string) => name.replace(/-/g, '_');
export const pkgName = (key: string) => key.replace(/_/g, '-');

const OS_RELEASE = `NAME="Red Hat Enterprise Linux"
VERSION="10.0 (Coughlan)"
ID="rhel"
ID_LIKE="centos fedora"
VERSION_ID="10.0"
PLATFORM_ID="platform:el10"
PRETTY_NAME="Red Hat Enterprise Linux 10.0 (Coughlan)"
`;

const SSHD_CONFIG = `# Practice copy of /etc/ssh/sshd_config
#Port 22
#PermitRootLogin prohibit-password
PasswordAuthentication yes
#PubkeyAuthentication yes
Include /etc/ssh/sshd_config.d/*.conf
`;

const MESSAGES = `Oct 21 08:00:01 server1 systemd[1]: Started Session 1 of User student.
Oct 21 08:02:13 server1 NetworkManager[812]: <info>  device (ens160): state change: activated
Oct 21 08:05:44 server1 chronyd[790]: Selected source 192.168.4.1
Oct 21 08:10:02 server1 systemd[1]: Starting dnf-makecache.service - dnf makecache...
Oct 21 08:10:09 server1 systemd[1]: Finished dnf-makecache.service - dnf makecache.
Oct 21 08:15:30 server1 kernel: XFS (dm-0): Mounting V5 Filesystem
Oct 21 08:20:11 server1 sshd[1520]: error: Bind to port 2022 on 0.0.0.0 failed: Permission denied.
Oct 21 08:20:11 server1 setroubleshoot[1530]: SELinux is preventing /usr/sbin/sshd from name_bind access on the tcp_socket port 2022.
`;

const SECURE = `Oct 21 08:01:12 server1 sshd[1401]: Accepted password for student from 192.168.4.20 port 50122 ssh2
Oct 21 08:03:40 server1 sudo[1450]: student : TTY=pts/0 ; PWD=/home/student ; USER=root ; COMMAND=/usr/bin/dnf update
Oct 21 08:07:55 server1 sshd[1490]: Failed password for invalid user admin from 203.0.113.9 port 40400 ssh2
Oct 21 08:07:59 server1 sshd[1490]: Failed password for invalid user admin from 203.0.113.9 port 40400 ssh2
`;

const SERVERS = `web01 192.168.4.10 rhel10 production
web02 192.168.4.11 rhel10 production
db01 192.168.4.20 rhel9 production
test01 192.168.4.30 rhel10 test
dev01 192.168.4.40 fedora development
web03 192.168.4.12 rhel10 test
`;

const NOTES = `Welcome to the practice terminal!
This is a simulated RHEL 10 system called server1.
You are logged in as "student", who can use sudo.

Try: ls -l, cat /etc/os-release, id, sudo -i
Type "help" to see every command this terminal knows.
`;

function etcFiles(root: FsNode) {
  const etc = root.children!.etc;
  const add = (name: string, content: string, mode = 0o644) => {
    etc.children![name] = makeFile(content, 0, 0, mode);
  };
  add('hostname', 'server1.example.com\n');
  // contents of these are generated from the user/group tables, see dynamicFile()
  add('passwd', '');
  add('group', '');
  add('shadow', '', 0o000);
  add('hosts', '127.0.0.1   localhost localhost.localdomain\n::1         localhost localhost.localdomain\n192.168.4.10 web01.example.com web01\n');
  add('os-release', OS_RELEASE);
  add('redhat-release', 'Red Hat Enterprise Linux release 10.0 (Coughlan)\n');
  add('fstab', '/dev/mapper/rhel-root   /       xfs     defaults        0 0\nUUID=4c8a1e2b-7f3d-4a8e-9c1b-2d5e6f7a8b9c /boot xfs defaults 0 0\n/dev/mapper/rhel-swap   none    swap    defaults        0 0\n');
  add('resolv.conf', 'search example.com\nnameserver 192.168.4.1\n');
  add('login.defs', 'PASS_MAX_DAYS\t99999\nPASS_MIN_DAYS\t0\nPASS_WARN_AGE\t7\nUID_MIN\t\t1000\nGID_MIN\t\t1000\nCREATE_HOME\tyes\nUMASK\t\t022\n');
  add('sudoers', '## Allows people in group wheel to run all commands\n%wheel\tALL=(ALL)\tALL\n', 0o440);
  add('crontab', 'SHELL=/bin/bash\nPATH=/sbin:/bin:/usr/sbin:/usr/bin\n# .---------------- minute (0 - 59)\n# |  .------------- hour (0 - 23)\n# |  |  .---------- day of month (1 - 31)\n# |  |  |  .------- month (1 - 12)\n# |  |  |  |  .---- day of week (0 - 6) (Sunday=0)\n# *  *  *  *  * user-name  command to be executed\n');
  const ssh = makeDir();
  ssh.children!['sshd_config'] = makeFile(SSHD_CONFIG, 0, 0, 0o600);
  ssh.children!['sshd_config.d'] = makeDir();
  etc.children!.ssh = ssh;
  const selinux = makeDir();
  selinux.children!.config = makeFile('SELINUX=enforcing\nSELINUXTYPE=targeted\n');
  etc.children!.selinux = selinux;
  etc.children!['skel'] = makeDir();
  etc.children!['skel'].children!['.bashrc'] = makeFile('# .bashrc\n');
  etc.children!['yum.repos.d'] = makeDir();
  etc.children!['yum.repos.d'].children!['redhat.repo'] = makeFile('[rhel-10-for-x86_64-baseos-rpms]\nname = Red Hat Enterprise Linux 10 for x86_64 - BaseOS (RPMs)\nenabled = 1\n\n[rhel-10-for-x86_64-appstream-rpms]\nname = Red Hat Enterprise Linux 10 for x86_64 - AppStream (RPMs)\nenabled = 1\n');
}

export function createInitialState(): SystemState {
  const root = makeDir();
  const c = root.children!;
  for (const d of ['boot', 'dev', 'etc', 'mnt', 'opt', 'proc', 'srv', 'usr', 'var', 'run', 'sys']) c[d] = makeDir();
  c.home = makeDir();
  c.root = makeDir(0, 0, 0o550);
  c.tmp = makeDir(0, 0, 0o1777);
  c.bin = makeLink('usr/bin');
  c.sbin = makeLink('usr/sbin');
  const usr = c.usr.children!;
  usr.bin = makeDir();
  usr.sbin = makeDir();
  usr.share = makeDir();
  usr.share.children!.doc = makeDir();
  usr.share.children!.doc.children!.bash = makeDir();
  usr.share.children!.doc.children!.bash.children!['README'] = makeFile(
    'Bash is the GNU Project\'s shell, the "Bourne Again SHell".\nDocumentation lives in man bash and info bash.\n',
  );
  const var_ = c.var.children!;
  var_.log = makeDir();
  var_.log.children!.messages = makeFile(MESSAGES, 0, 0, 0o600);
  var_.log.children!.secure = makeFile(SECURE, 0, 0, 0o600);
  var_.www = makeDir();
  var_.www.children!.html = makeDir();
  var_.spool = makeDir();
  var_.spool.children!.cron = makeDir(0, 0, 0o700);
  etcFiles(root);

  const student = makeDir(1000, 1000, 0o700);
  student.children!['notes.txt'] = makeFile(NOTES, 1000, 1000);
  student.children!['servers.txt'] = makeFile(SERVERS, 1000, 1000);
  student.children!['.bashrc'] = makeFile('# .bashrc\nalias ll=\'ls -l\'\n', 1000, 1000);
  student.children!.Documents = makeDir(1000, 1000);
  c.home.children!.student = student;

  const user = (name: string, uid: number, gid: number, home: string, shell: string, comment = ''): User => ({
    name, uid, gid, home, shell, comment, password: uid === 0 || uid === 1000 ? '$6$hash' : null,
    locked: false, maxDays: 99999, minDays: 0, warnDays: 7,
  });

  return {
    hostname: 'server1.example.com',
    root,
    users: [
      user('root', 0, 0, '/root', '/bin/bash', 'root'),
      user('bin', 1, 1, '/bin', '/sbin/nologin', 'bin'),
      user('daemon', 2, 2, '/sbin', '/sbin/nologin', 'daemon'),
      user('apache', 48, 48, '/usr/share/httpd', '/sbin/nologin', 'Apache'),
      user('sshd', 74, 74, '/usr/share/empty.sshd', '/sbin/nologin', 'Privilege-separated SSH'),
      user('student', 1000, 1000, '/home/student', '/bin/bash', 'Student'),
    ],
    groups: [
      { name: 'root', gid: 0, members: [] },
      { name: 'bin', gid: 1, members: [] },
      { name: 'daemon', gid: 2, members: [] },
      { name: 'wheel', gid: 10, members: ['student'] },
      { name: 'apache', gid: 48, members: [] },
      { name: 'sshd', gid: 74, members: [] },
      { name: 'student', gid: 1000, members: [] },
    ],
    services: {
      sshd: { name: 'sshd', description: 'OpenSSH server daemon', active: true, enabled: true },
      chronyd: { name: 'chronyd', description: 'NTP client/server', active: true, enabled: true },
      firewalld: { name: 'firewalld', description: 'firewalld - dynamic firewall daemon', active: true, enabled: true },
      NetworkManager: { name: 'NetworkManager', description: 'Network Manager', active: true, enabled: true },
      crond: { name: 'crond', description: 'Command Scheduler', active: true, enabled: true },
      atd: { name: 'atd', description: 'Deferred execution scheduler', active: true, enabled: true },
      'systemd-journald': { name: 'systemd-journald', description: 'Journal Service', active: true, enabled: true },
      rsyslog: { name: 'rsyslog', description: 'System Logging Service', active: true, enabled: true },
      tuned: { name: 'tuned', description: 'Dynamic System Tuning Daemon', active: true, enabled: true },
    },
    installed: ['bash', 'coreutils', 'openssh-server', 'chrony', 'firewalld', 'vim-minimal', 'dnf', 'tuned', 'policycoreutils'],
    selinux: 'Enforcing',
    selinuxConfigMode: 'enforcing',
    firewall: { services: ['cockpit', 'dhcpv6-client', 'ssh'], ports: [], permServices: ['cockpit', 'dhcpv6-client', 'ssh'], permPorts: [] },
    defaultTarget: 'multi-user.target',
  };
}

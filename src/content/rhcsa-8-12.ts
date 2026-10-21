import type { Shell } from '@/shell/shell';
import { Module, peek, ran } from './types';

// RHCSA track, video lessons 11–16 / Cert Guide chapters 8–12. Original practice material.

const ens = (sh: Shell) => sh.state.connections.find((c) => c.name === 'ens160');

export const R8: Module = {
  id: 'R8',
  track: 'rhcsa',
  title: 'Network configuration',
  courseRef: 'Video Lesson 11 · Cert Guide Ch. 8',
  summary: 'IPv4 and IPv6 addresses with nmcli, host names and name resolution. Exam objectives: Manage basic networking.',
  quiz: [
    {
      q: 'You changed ipv4.addresses with nmcli con mod, but ip a still shows the old address. Why?',
      choices: ['nmcli is broken', 'The change is saved in the profile but only applied after nmcli con up', 'You must reboot', 'IPv4 cannot be changed'],
      answer: 1,
      why: 'con mod edits the connection profile. con up (re)activates it so the new settings take effect.',
    },
    {
      q: 'Which command sets a static IPv4 address of 10.0.0.10/24 on connection "ens160"?',
      choices: [
        'nmcli con mod ens160 ipv4.addresses 10.0.0.10/24 ipv4.method manual',
        'ip addr add 10.0.0.10/24 dev ens160 permanent',
        'nmcli dev set ens160 10.0.0.10',
        'ifconfig ens160 10.0.0.10',
      ],
      answer: 0,
      why: 'Set the address and switch the method to manual. ip addr add works too, but is lost at reboot.',
    },
    {
      q: 'How do you ADD a second IPv4 address without removing the first?',
      choices: ['nmcli con mod ens160 +ipv4.addresses 10.0.0.11/24', 'nmcli con mod ens160 ipv4.addresses 10.0.0.11/24', 'nmcli con add 10.0.0.11', 'ip a 10.0.0.11'],
      answer: 0,
      why: 'A + in front of the property appends to the list. Without it, the list is replaced.',
    },
    {
      q: 'Which command sets the host name permanently?',
      choices: ['hostname server2.example.com', 'hostnamectl set-hostname server2.example.com', 'echo server2 > /proc/hostname', 'nmcli hostname'],
      answer: 1,
      why: 'hostnamectl writes /etc/hostname. The plain hostname command only changes it until reboot.',
    },
    {
      q: 'Where do you add a fixed name-to-IP mapping that is checked before DNS?',
      choices: ['/etc/resolv.conf', '/etc/hosts', '/etc/hostname', '/etc/nsswitch.conf'],
      answer: 1,
      why: '/etc/hosts is consulted first by default (the order is set in /etc/nsswitch.conf).',
    },
    {
      q: 'Why should you not edit /etc/resolv.conf directly on RHEL?',
      choices: ['It is read-only', 'NetworkManager overwrites it from the ipv4.dns setting', 'It does not exist', 'It needs SELinux off'],
      answer: 1,
      why: 'Set DNS servers with nmcli con mod NAME ipv4.dns, and NetworkManager writes resolv.conf for you.',
    },
    {
      q: 'Which tool gives a menu-driven interface for network settings?',
      choices: ['nmtui', 'nmcli', 'netconf', 'ip'],
      answer: 0,
      why: 'nmtui is a text menu. Handy on the exam if you forget nmcli property names, but remember to reactivate the connection.',
    },
    {
      q: 'What does "ipv6.method auto" mean?',
      choices: ['IPv6 is off', 'The address comes from router advertisements / DHCPv6', 'You must give an address', 'Use IPv4 instead'],
      answer: 1,
      why: 'auto gets IPv6 configuration from the network. manual means you set addresses yourself.',
    },
  ],
  cards: [
    { front: 'nmcli con show', back: 'List connection profiles. Add a name to see all settings of one.' },
    { front: 'nmcli con mod NAME ipv4.addresses A/24 ipv4.gateway G ipv4.dns D ipv4.method manual', back: 'Static IPv4 configuration in one command.' },
    { front: 'nmcli con up NAME', back: 'Activate a profile (apply changes).' },
    { front: '+ipv4.addresses', back: 'Append an address instead of replacing the list.' },
    { front: 'nmcli con mod NAME ipv6.addresses fd00::10/64 ipv6.method manual', back: 'Static IPv6 address.' },
    { front: 'ip a / ip route', back: 'Show current addresses / routing table.' },
    { front: 'hostnamectl set-hostname NAME', back: 'Set the host name permanently.' },
    { front: '/etc/hosts', back: 'Local name resolution, checked before DNS.' },
    { front: 'nmtui', back: 'Menu interface for NetworkManager.' },
    { front: 'Profiles stored in', back: '/etc/NetworkManager/system-connections/ (keyfile format on RHEL 10).' },
  ],
  labs: [
    {
      id: 'R8-network',
      title: 'Re-address the server',
      intro: 'Exam style: give server1 a new static address, an IPv6 address, and a new name.',
      tasks: [
        { text: 'Show the current connection profiles.', hint: 'nmcli con show', check: (sh) => ran(sh, /^nmcli\s+c\w*\s+s\w*\s*$/) },
        {
          text: 'Set connection ens160 to the static IPv4 address 192.168.4.110/24 with gateway 192.168.4.1.',
          hint: 'sudo nmcli con mod ens160 ipv4.addresses 192.168.4.110/24 ipv4.gateway 192.168.4.1 ipv4.method manual',
          check: (sh) => {
            const c = ens(sh);
            return !!c && c.ipv4.addresses.includes('192.168.4.110/24') && c.ipv4.method === 'manual' && c.ipv4.gateway === '192.168.4.1';
          },
        },
        {
          text: 'Also give it the IPv6 address fd00:4::110/64.',
          hint: 'sudo nmcli con mod ens160 ipv6.addresses fd00:4::110/64 ipv6.method manual',
          check: (sh) => !!ens(sh)?.ipv6.addresses.includes('fd00:4::110/64'),
        },
        {
          text: 'Apply the changes and check that both addresses are active.',
          hint: 'sudo nmcli con up ens160 && ip a',
          check: (sh) => !!ens(sh)?.applied.ipv4.includes('192.168.4.110/24') && !!ens(sh)?.applied.ipv6.includes('fd00:4::110/64'),
        },
        {
          text: 'Set the host name permanently to server2.example.com.',
          hint: 'sudo hostnamectl set-hostname server2.example.com',
          check: (sh) => sh.state.hostname === 'server2.example.com',
        },
        {
          text: 'Make the name "server1" resolve to 192.168.4.100 using /etc/hosts.',
          hint: 'echo "192.168.4.100 server1.example.com server1" | sudo tee -a /etc/hosts',
          check: (sh) => /^192\.168\.4\.100\s.*\bserver1\b/m.test(peek(sh, '/etc/hosts')?.content ?? ''),
        },
      ],
    },
  ],
};

export const R9: Module = {
  id: 'R9',
  track: 'rhcsa',
  title: 'Software: dnf, rpm and Flatpak',
  courseRef: 'Video Lesson 12 · Cert Guide Ch. 9',
  summary: 'Repositories, installing and removing RPM packages, and Flatpak apps (new on the RHEL 10 exam). Exam objectives: Manage software.',
  quiz: [
    {
      q: 'Which directory holds .repo files that tell dnf where to find packages?',
      choices: ['/etc/dnf/repos', '/etc/yum.repos.d', '/var/lib/rpm', '/etc/rpm'],
      answer: 1,
      why: 'Each file in /etc/yum.repos.d defines one or more repositories.',
    },
    {
      q: 'Which lines does a minimal repository file need?',
      choices: ['[id], name, baseurl (and gpgcheck or a gpgkey)', 'Only a URL', 'server= and port=', 'enabled=0'],
      answer: 0,
      why: 'For example: [appstream] name=AppStream baseurl=http://repo.example.com/AppStream gpgcheck=0. dnf config-manager --add-repo URL also creates one.',
    },
    {
      q: 'You need the semanage command but it is not installed. How do you find which package provides it?',
      choices: ['dnf provides */semanage', 'rpm -qa semanage', 'dnf search --all', 'which semanage'],
      answer: 0,
      why: 'dnf provides (or whatprovides) searches file lists in the repositories.',
    },
    {
      q: 'Which command shows which package installed the file /etc/ssh/sshd_config?',
      choices: ['rpm -qf /etc/ssh/sshd_config', 'dnf info sshd_config', 'rpm -ql sshd', 'file /etc/ssh/sshd_config'],
      answer: 0,
      why: 'rpm -qf asks the RPM database which package owns a file. rpm -ql lists the files in a package.',
    },
    {
      q: 'What is Flatpak?',
      choices: ['A filesystem', 'A way to install sandboxed desktop applications that bring their own runtimes', 'A replacement for dnf for system packages', 'A container registry'],
      answer: 1,
      why: 'Flatpak apps run isolated from the system and do not depend on system libraries. dnf still manages the operating system.',
    },
    {
      q: 'Which command adds the Flathub repository?',
      choices: ['flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo', 'dnf install flathub', 'flatpak install flathub', 'flatpak repo flathub on'],
      answer: 0,
      why: 'remote-add names the remote and points to its .flatpakrepo file. --if-not-exists avoids an error if it is already there.',
    },
    {
      q: 'Which command installs the Calculator app from Flathub?',
      choices: ['flatpak install flathub org.gnome.Calculator', 'dnf install org.gnome.Calculator', 'flatpak add Calculator', 'rpm -i flathub/calculator'],
      answer: 0,
      why: 'flatpak install REMOTE APP-ID. flatpak list shows what is installed.',
    },
    {
      q: 'How do you install an RPM file that you downloaded to /tmp, so dependencies are resolved?',
      choices: ['dnf install /tmp/package.rpm', 'rpm -i /tmp/package.rpm', 'flatpak install /tmp/package.rpm', 'tar -x /tmp/package.rpm'],
      answer: 0,
      why: 'dnf can install local RPM files and pulls dependencies from your repositories. rpm -i does not resolve dependencies.',
    },
  ],
  cards: [
    { front: '/etc/yum.repos.d/*.repo', back: 'Repository definitions: [id], name=, baseurl=, gpgcheck=, enabled=.' },
    { front: 'dnf config-manager --add-repo URL', back: 'Create a .repo file for a repository URL.' },
    { front: 'dnf install / remove / update', back: 'Install, remove, update packages.' },
    { front: 'dnf search / info / provides', back: 'Find by keyword / details / which package has a file.' },
    { front: 'dnf repolist', back: 'Show enabled repositories.' },
    { front: 'dnf list installed', back: 'Show installed packages.' },
    { front: 'rpm -qa / -qf FILE / -ql PKG', back: 'All packages / owner of a file / files in a package.' },
    { front: 'flatpak remotes', back: 'List Flatpak repositories.' },
    { front: 'flatpak remote-add NAME URL', back: 'Add a Flatpak repository, e.g. flathub.' },
    { front: 'flatpak install REMOTE APPID', back: 'Install a Flatpak app. flatpak uninstall APPID removes it.' },
    { front: 'flatpak list', back: 'Show installed Flatpak apps and runtimes.' },
  ],
  labs: [
    {
      id: 'R9-software',
      title: 'Set up software sources',
      intro: 'Configure a repository, install a package, and install a Flatpak app. Work as root.',
      tasks: [
        { text: 'Become root.', hint: 'sudo -i', check: (sh) => sh.uid === 0 },
        {
          text: 'Create /etc/yum.repos.d/local.repo for repository "local" with baseurl http://repo.example.com/BaseOS and gpgcheck=0.',
          hint: 'echo -e "[local]\\nname=local\\nbaseurl=http://repo.example.com/BaseOS\\ngpgcheck=0" > /etc/yum.repos.d/local.repo',
          check: (sh) => {
            const c = peek(sh, '/etc/yum.repos.d/local.repo')?.content ?? '';
            return /^\[local\]/m.test(c) && /^baseurl\s*=\s*http:\/\/repo\.example\.com\/BaseOS/m.test(c) && /^gpgcheck\s*=\s*0/m.test(c);
          },
        },
        { text: 'Install the tmux package.', hint: 'dnf install -y tmux', check: (sh) => sh.state.installed.includes('tmux') },
        { text: 'Verify with rpm that tmux is installed.', hint: 'rpm -q tmux', check: (sh) => ran(sh, /^rpm\s+-q\s+tmux/) },
        {
          text: 'Add the flathub Flatpak remote.',
          hint: 'flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo',
          check: (sh) => sh.state.flatpakRemotes.includes('flathub'),
        },
        { text: 'Install the Flatpak app org.gnome.Calculator from flathub.', hint: 'flatpak install -y flathub org.gnome.Calculator', check: (sh) => sh.state.flatpakApps.includes('org.gnome.Calculator') },
      ],
    },
  ],
};

export const R10: Module = {
  id: 'R10',
  track: 'rhcsa',
  title: 'Monitoring and processes',
  courseRef: 'Video Lessons 13–14 · Cert Guide Ch. 10',
  summary: 'Finding CPU and memory hogs, killing processes, adjusting priority, and tuning profiles. Exam objectives: Operate running systems.',
  quiz: [
    {
      q: 'Which command lists processes sorted by CPU usage, highest first?',
      choices: ['ps aux --sort=-%cpu', 'ps aux --sort=cpu', 'ps -cpu', 'free -c'],
      answer: 0,
      why: 'The minus means descending. --sort=-%mem does the same for memory.',
    },
    {
      q: 'What is the difference between kill PID and kill -9 PID?',
      choices: ['None', 'kill sends SIGTERM (ask nicely), -9 sends SIGKILL (stop now, no cleanup)', '-9 kills 9 processes', 'kill -9 only works for root'],
      answer: 1,
      why: 'Try a normal kill first so the program can clean up. Use -9 if it does not respond.',
    },
    {
      q: 'A nice value of 19 means…',
      choices: ['Highest priority', 'Lowest priority (the process is very "nice" to others)', 'The process is paused', 'It runs on CPU 19'],
      answer: 1,
      why: 'Nice ranges from -20 (most favoured) to 19 (least). Normal users can only make processes nicer.',
    },
    {
      q: 'Which command changes the nice value of running process 2345 to 10?',
      choices: ['renice -n 10 -p 2345', 'nice -n 10 2345', 'kill -10 2345', 'top -n 10 2345'],
      answer: 0,
      why: 'nice starts a new command with a priority. renice changes one that is already running.',
    },
    {
      q: 'Which command applies the "throughput-performance" tuning profile?',
      choices: ['tuned-adm profile throughput-performance', 'systemctl tune throughput-performance', 'tuned --set throughput', 'sysctl throughput-performance'],
      answer: 0,
      why: 'tuned-adm list shows the profiles, tuned-adm active shows the current one, and tuned-adm recommend suggests one.',
    },
    {
      q: 'In top, which key kills a process?',
      choices: ['k', 'x', 'd', 'q'],
      answer: 0,
      why: 'k asks for a PID and signal. r renices, M sorts by memory, P by CPU, and q quits.',
    },
    {
      q: 'What does the load average in uptime and top show?',
      choices: ['Free memory', 'The average number of processes running or waiting for CPU over 1, 5 and 15 minutes', 'Disk usage', 'Network traffic'],
      answer: 1,
      why: 'Compare it to the number of CPU cores. A load higher than the core count means processes are waiting.',
    },
  ],
  cards: [
    { front: 'ps aux --sort=-%cpu | head', back: 'Top CPU users.' },
    { front: 'ps aux --sort=-%mem | head', back: 'Top memory users.' },
    { front: 'top keys: k r M P q', back: 'k kill, r renice, M sort by memory, P sort by CPU, q quit.' },
    { front: 'kill PID / kill -9 PID', back: 'SIGTERM (graceful) / SIGKILL (forced).' },
    { front: 'pkill NAME / killall NAME', back: 'Kill processes by name.' },
    { front: 'Nice range', back: '-20 (highest priority) to 19 (lowest). Default 0.' },
    { front: 'nice -n 5 cmd', back: 'Start cmd with nice value 5.' },
    { front: 'renice -n 5 -p PID', back: 'Change nice value of a running process.' },
    { front: 'tuned-adm active / list / recommend', back: 'Current profile / all profiles / suggested profile.' },
    { front: 'tuned-adm profile NAME', back: 'Switch tuning profile.' },
    { front: 'uptime', back: 'Shows load average for 1, 5 and 15 minutes.' },
  ],
  labs: [
    {
      id: 'R10-procs',
      title: 'Tame a busy server',
      intro: 'The server feels slow. Find and handle the processes responsible, then tune it.',
      tasks: [
        { text: 'List processes with the highest CPU usage first.', hint: 'ps aux --sort=-%cpu | head', check: (sh) => ran(sh, /ps\b.*--sort[= ]-%?cpu|^top\b/) },
        {
          text: 'The dd process is eating the CPU. Stop it.',
          hint: 'kill 1650',
          check: (sh) => !sh.state.processes.some((p) => p.cmd.startsWith('dd ')),
        },
        { text: 'Find the process using the most memory.', hint: 'ps aux --sort=-%mem | head', check: (sh) => ran(sh, /ps\b.*--sort[= ]-%?mem/) },
        {
          text: 'Do not kill memhog (it is needed), but give it the lowest priority (nice 19).',
          hint: 'sudo renice -n 19 -p 1702',
          check: (sh) => sh.state.processes.find((p) => p.cmd.includes('memhog'))?.nice === 19,
        },
        { text: 'Show the active tuning profile.', hint: 'tuned-adm active', check: (sh) => ran(sh, /tuned-adm\s+active/) },
        {
          text: 'Switch to the throughput-performance profile.',
          hint: 'sudo tuned-adm profile throughput-performance',
          check: (sh) => sh.state.tunedProfile === 'throughput-performance',
        },
      ],
    },
  ],
};

export const R11: Module = {
  id: 'R11',
  track: 'rhcsa',
  title: 'systemd units and targets',
  courseRef: 'Video Lesson 15 · Cert Guide Ch. 11',
  summary: 'Starting, stopping and enabling services, unit files, and targets. Exam objectives: Deploy, configure and maintain systems.',
  quiz: [
    {
      q: 'What is the difference between "systemctl start httpd" and "systemctl enable httpd"?',
      choices: ['None', 'start runs it now; enable makes it start at boot', 'enable runs it now; start makes it start at boot', 'enable installs it'],
      answer: 1,
      why: 'You usually want both: systemctl enable --now httpd.',
    },
    {
      q: 'Which command shows whether sshd is running and its latest log lines?',
      choices: ['systemctl status sshd', 'systemctl show sshd', 'ps sshd', 'journalctl sshd'],
      answer: 0,
      why: 'status shows loaded/enabled state, active state, and recent journal entries.',
    },
    {
      q: 'Which target is the normal text-mode server target?',
      choices: ['graphical.target', 'multi-user.target', 'rescue.target', 'default.target'],
      answer: 1,
      why: 'multi-user.target is the usual server target. graphical.target adds a desktop.',
    },
    {
      q: 'How do you make the system boot into graphical.target by default?',
      choices: ['systemctl set-default graphical.target', 'systemctl isolate graphical.target', 'systemctl enable graphical.target', 'echo graphical > /etc/target'],
      answer: 0,
      why: 'set-default changes the default for future boots. isolate switches the running system now.',
    },
    {
      q: 'Where do you put your own changes to a unit file so updates don\'t overwrite them?',
      choices: ['/usr/lib/systemd/system', '/etc/systemd/system (for example with systemctl edit)', '/var/lib/systemd', '/run/systemd'],
      answer: 1,
      why: '/usr/lib/systemd/system belongs to packages. systemctl edit unit creates a drop-in in /etc/systemd/system.',
    },
    {
      q: 'What does "systemctl mask httpd" do?',
      choices: ['Hides it from the list', 'Makes it impossible to start, even manually, until unmasked', 'Stops it', 'Restarts it'],
      answer: 1,
      why: 'mask links the unit to /dev/null. Useful when two services conflict.',
    },
    {
      q: 'After editing a unit file by hand, what must you run?',
      choices: ['systemctl daemon-reload', 'systemctl reboot', 'systemctl refresh', 'Nothing'],
      answer: 0,
      why: 'daemon-reload makes systemd re-read its unit files.',
    },
  ],
  cards: [
    { front: 'systemctl enable --now UNIT', back: 'Start now and at every boot.' },
    { front: 'systemctl disable --now UNIT', back: 'Stop now and do not start at boot.' },
    { front: 'systemctl status UNIT', back: 'State plus recent log lines.' },
    { front: 'systemctl is-active / is-enabled', back: 'Quick yes/no style checks, good for verifying exam tasks.' },
    { front: 'systemctl list-units --type=service', back: 'Loaded services. Add --all for inactive ones.' },
    { front: 'systemctl get-default / set-default', back: 'Show / change the boot target.' },
    { front: 'systemctl isolate TARGET', back: 'Switch the running system to another target.' },
    { front: 'multi-user vs graphical target', back: 'Text server vs desktop.' },
    { front: 'systemctl edit UNIT', back: 'Create a drop-in override in /etc/systemd/system/UNIT.d/.' },
    { front: 'systemctl mask / unmask', back: 'Block / allow a unit from being started.' },
    { front: 'systemctl daemon-reload', back: 'Re-read unit files after changing them.' },
  ],
  labs: [
    {
      id: 'R11-services',
      title: 'Manage services and targets',
      intro: 'Install an FTP server, control services, and change the boot target.',
      tasks: [
        { text: 'Install the vsftpd package.', hint: 'sudo dnf install -y vsftpd', check: (sh) => sh.state.installed.includes('vsftpd') },
        {
          text: 'Start vsftpd now and make sure it starts at boot.',
          hint: 'sudo systemctl enable --now vsftpd',
          check: (sh) => !!sh.state.services.vsftpd?.active && !!sh.state.services.vsftpd?.enabled,
        },
        {
          text: 'The atd service is not needed. Stop it and keep it from starting at boot.',
          hint: 'sudo systemctl disable --now atd',
          check: (sh) => !sh.state.services.atd.active && !sh.state.services.atd.enabled,
        },
        { text: 'Show the current default target.', hint: 'systemctl get-default', check: (sh) => ran(sh, /systemctl\s+get-default/) },
        {
          text: 'Make the server boot into the graphical target by default.',
          hint: 'sudo systemctl set-default graphical.target',
          check: (sh) => sh.state.defaultTarget === 'graphical.target',
        },
      ],
    },
  ],
};

export const R12: Module = {
  id: 'R12',
  track: 'rhcsa',
  title: 'Scheduling: cron, at and timers',
  courseRef: 'Video Lesson 16 · Cert Guide Ch. 12',
  summary: 'Recurring jobs with cron and systemd timers, and one-off jobs with at. Exam objective: Schedule tasks using at, cron and systemd timer units.',
  quiz: [
    {
      q: 'What does the cron line "30 2 * * 1-5 /usr/local/bin/backup" mean?',
      choices: ['Every 30 minutes on day 2', 'At 02:30 Monday to Friday', 'At 30 past every hour in February', 'Once on the 1st to 5th'],
      answer: 1,
      why: 'Fields: minute hour day-of-month month day-of-week. 1-5 is Monday to Friday.',
    },
    {
      q: 'Which cron line runs a job every 15 minutes?',
      choices: ['*/15 * * * * job', '15 * * * * job', '* 15 * * * job', '0/15 * job'],
      answer: 0,
      why: '*/15 in the minute field means every 15 minutes. "15 * * * *" means once an hour at :15.',
    },
    {
      q: 'Which command edits the current user\'s crontab?',
      choices: ['crontab -e', 'vim /etc/crontab', 'cron -e', 'at -e'],
      answer: 0,
      why: 'crontab -e opens your personal crontab. As root, crontab -e -u lisa edits lisa\'s.',
    },
    {
      q: 'What is the difference between /etc/crontab and a user crontab?',
      choices: ['None', '/etc/crontab lines include a user name field', 'User crontabs need root', '/etc/crontab runs only at boot'],
      answer: 1,
      why: 'System cron files (/etc/crontab, /etc/cron.d/*) have an extra field saying which user runs the command.',
    },
    {
      q: 'How do you schedule "touch /tmp/done" to run once, 10 minutes from now?',
      choices: ['echo "touch /tmp/done" | at now + 10 minutes', 'crontab 10 touch /tmp/done', 'sleep 10 touch', 'systemctl at 10'],
      answer: 0,
      why: 'at reads the commands from STDIN. atq lists jobs and atrm removes them.',
    },
    {
      q: 'Which command shows the systemd timers and when they run next?',
      choices: ['systemctl list-timers', 'systemctl status cron', 'atq', 'crontab -l'],
      answer: 0,
      why: 'Timers are units ending in .timer. They activate a matching .service.',
    },
    {
      q: 'What makes a systemd timer catch up on runs that were missed while the machine was off?',
      choices: ['Persistent=true', 'OnBootSec=0', 'Restart=always', 'WantedBy=multi-user.target'],
      answer: 0,
      why: 'Persistent=true in the [Timer] section runs the job at the next boot if a scheduled run was missed.',
    },
  ],
  cards: [
    { front: 'Cron fields', back: 'minute hour day-of-month month day-of-week command' },
    { front: '*/10 in a cron field', back: 'Every 10 units (minutes, hours...).' },
    { front: '1-5 in day-of-week', back: 'Monday to Friday. 0 or 7 = Sunday.' },
    { front: 'crontab -e / -l / -r', back: 'Edit / list / remove your crontab. -u USER as root.' },
    { front: '/etc/cron.d/', back: 'Drop-in system cron files, with a user field.' },
    { front: '/etc/cron.daily etc.', back: 'Scripts run daily/weekly/monthly by anacron.' },
    { front: 'echo "cmd" | at 14:00', back: 'Run once at a set time. at now + 1 hour also works.' },
    { front: 'atq / atrm N', back: 'List / remove at jobs.' },
    { front: 'systemctl list-timers', back: 'Show timers, last and next run.' },
    { front: '[Timer] OnCalendar=', back: 'When a timer fires, e.g. OnCalendar=daily or Mon *-*-* 02:00:00.' },
    { front: 'systemctl enable --now NAME.timer', back: 'Activate a timer.' },
  ],
  labs: [
    {
      id: 'R12-schedule',
      title: 'Automate the chores',
      intro: 'Schedule a recurring backup, a one-off job, and turn on a systemd timer.',
      tasks: [
        {
          text: 'As student, schedule /usr/local/bin/backup.sh to run at 02:30 every weekday (Monday to Friday).',
          hint: 'echo "30 2 * * 1-5 /usr/local/bin/backup.sh" | crontab -',
          check: (sh) => /^30\s+2\s+\*\s+\*\s+(1-5|mon-fri)\s+\/usr\/local\/bin\/backup\.sh/im.test(peek(sh, '/var/spool/cron/student')?.content ?? ''),
        },
        { text: 'List your crontab to check it.', hint: 'crontab -l', check: (sh) => ran(sh, /^crontab\s+-l/) },
        {
          text: 'Schedule "touch /tmp/reminder" to run once, 30 minutes from now.',
          hint: 'echo "touch /tmp/reminder" | at now + 30 minutes',
          check: (sh) => sh.state.atJobs.some((j) => j.cmd.includes('/tmp/reminder')),
        },
        { text: 'Show the pending at jobs.', hint: 'atq', check: (sh) => ran(sh, /^atq\b|^at\s+-l/) },
        { text: 'List the systemd timers on this system.', hint: 'systemctl list-timers --all', check: (sh) => ran(sh, /systemctl\s+list-timers/) },
        {
          text: 'Enable and start fstrim.timer.',
          hint: 'sudo systemctl enable --now fstrim.timer',
          check: (sh) => !!sh.state.services['fstrim.timer']?.active && !!sh.state.services['fstrim.timer']?.enabled,
        },
      ],
    },
  ],
};

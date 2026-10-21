import { Module, peek, ran } from './types';

// Track 1 follows the lesson order of Sander van Vugt's "Linux Fundamentals, 2nd Edition".
// All questions, cards and labs here are original practice material.

const F1: Module = {
  id: 'F1',
  track: 'fundamentals',
  title: 'Installing Linux and first login',
  courseRef: 'Linux Fundamentals, Lesson 1',
  summary: 'What a Linux distribution is, how an installation is laid out, and logging in for the first time.',
  quiz: [
    {
      q: 'What is a Linux distribution?',
      choices: ['Just the Linux kernel', 'The kernel plus tools, libraries and an installer packaged together', 'A graphical desktop', 'A virtual machine image'],
      answer: 1,
      why: 'The kernel alone cannot do much. A distribution like RHEL, Fedora or Ubuntu bundles the kernel with shells, tools, a package manager and an installer.',
    },
    {
      q: 'Which of these is the upstream community project that Red Hat Enterprise Linux is developed from today?',
      choices: ['CentOS Stream', 'Debian', 'Arch Linux', 'openSUSE'],
      answer: 0,
      why: 'CentOS Stream sits just ahead of RHEL: changes land there before they appear in the next RHEL minor release. Fedora is further upstream still.',
    },
    {
      q: 'What does the prompt [student@server1 ~]$ tell you?',
      choices: ['You are root in /root', 'You are student on server1, in your home directory, as a normal user', 'You are on server ~', 'The system is in rescue mode'],
      answer: 1,
      why: 'The prompt shows user@host, then the current directory (~ means home). A $ means a normal user and a # means root.',
    },
    {
      q: 'Which file tells you which release of RHEL is installed?',
      choices: ['/etc/hostname', '/etc/os-release', '/etc/passwd', '/boot/version'],
      answer: 1,
      why: '/etc/os-release (and /etc/redhat-release) describe the installed operating system version.',
    },
    {
      q: 'Why do installers usually ask you to create a non-root user?',
      choices: ['Root cannot log in at all', 'Daily work as a normal user limits the damage mistakes can cause', 'It is required for the network to work', 'Normal users are faster'],
      answer: 1,
      why: 'Working as a normal user and using sudo only when needed means a typo cannot accidentally wreck the whole system.',
    },
    {
      q: 'Which command shows the version of the running kernel?',
      choices: ['uname -r', 'kernel --version', 'cat /etc/hostname', 'lsblk'],
      answer: 0,
      why: 'uname -r prints the kernel release, for example 6.12.0-55.el10.x86_64.',
    },
    {
      q: 'Which of these is the minimum you need to give the RHEL installer before it will begin installing?',
      choices: ['A host name only', 'An installation destination (disk)', 'A graphical desktop choice', 'An SSH key'],
      answer: 1,
      why: 'The installer needs to know which disk to install to. Most other settings have usable defaults.',
    },
    {
      q: 'In a terminal, what does the # at the end of a prompt mean?',
      choices: ['A comment', 'You are logged in as root', 'The command failed', 'You are in a script'],
      answer: 1,
      why: '# signals the root user. Be careful: every command now runs with full privileges.',
    },
  ],
  cards: [
    { front: 'Kernel', back: 'The core of the operating system. It talks to the hardware and manages memory, processes and devices.' },
    { front: 'Distribution', back: 'A complete Linux operating system: kernel + tools + package manager + installer. Examples: RHEL, Fedora, Ubuntu.' },
    { front: 'Shell', back: 'The program that reads the commands you type and runs them. On RHEL it is bash.' },
    { front: 'root', back: 'The administrator account, UID 0. It can do anything on the system.' },
    { front: 'Prompt ending in $ vs #', back: '$ = normal user. # = root.' },
    { front: '~ (tilde)', back: "Shorthand for your home directory, for example /home/student." },
    { front: 'uname -r', back: 'Show the running kernel version.' },
    { front: '/etc/os-release', back: 'File describing the installed distribution and version.' },
    { front: 'Terminal vs console', back: 'A console is the screen directly attached to the machine. A terminal (or terminal window) is any text interface to a shell, including over SSH.' },
    { front: 'Virtual machine', back: 'A computer emulated in software. A great way to practise installing Linux without touching your real machine.' },
  ],
  labs: [
    {
      id: 'F1-explore',
      title: 'Look around a new system',
      intro: 'You just logged in to a fresh server. Find out who you are and what you are running.',
      tasks: [
        { text: 'Show which user you are logged in as.', hint: 'whoami', check: (sh) => ran(sh, /^whoami\b|^id\b/) },
        { text: 'Show the installed RHEL release.', hint: 'cat /etc/os-release', check: (sh) => ran(sh, /(os|redhat)-release/) },
        { text: 'Show the running kernel version.', hint: 'uname -r', check: (sh) => ran(sh, /^uname\b.*-[ra]/) },
        { text: 'Read the notes.txt file in your home directory.', hint: 'cat notes.txt', check: (sh) => ran(sh, /(cat|less|more|head|tail).*notes\.txt/) },
      ],
    },
  ],
};

const F2: Module = {
  id: 'F2',
  track: 'fundamentals',
  title: 'Essential tools: shell, man and help',
  courseRef: 'Linux Fundamentals, Lesson 2',
  summary: 'How a command is built, how to find help with man and --help, and the basic editors.',
  quiz: [
    {
      q: 'In "ls -l /etc", what is "-l"?',
      choices: ['The command', 'An option', 'An argument (operand)', 'A variable'],
      answer: 1,
      why: 'ls is the command, -l is an option that changes how it behaves, and /etc is the argument it works on.',
    },
    {
      q: 'Which command searches man page descriptions for a keyword?',
      choices: ['man -k keyword', 'help keyword', 'find keyword', 'grep man keyword'],
      answer: 0,
      why: 'man -k (same as apropos) searches the short descriptions of all man pages. Run mandb as root if it returns nothing.',
    },
    {
      q: 'Inside a man page, how do you search forward for a word?',
      choices: ['Ctrl+F', '/word', ':find word', '?search'],
      answer: 1,
      why: 'Man pages open in less. Type /word and press Enter, then n for the next match. q quits.',
    },
    {
      q: 'Which man section holds administrative commands like useradd?',
      choices: ['1', '5', '8', '3'],
      answer: 2,
      why: 'Section 1 is user commands, 5 is file formats, 8 is system administration commands.',
    },
    {
      q: 'In vim, which key do you press to start typing text?',
      choices: ['i', 'q', 'x', 'w'],
      answer: 0,
      why: 'vim starts in command mode. i switches to insert mode. Esc goes back to command mode.',
    },
    {
      q: 'How do you save and quit in vim?',
      choices: [':q!', ':wq', 'Ctrl+S', ':exit!'],
      answer: 1,
      why: ':wq writes and quits. :q! quits without saving.',
    },
    {
      q: 'You get "bash: sl: command not found". What most likely happened?',
      choices: ['You lack permission', 'There is no command called sl on the system (often a typo for ls)', 'The disk is full', 'The network is down'],
      answer: 1,
      why: '"command not found" means bash could not find a program with that name in any directory in $PATH.',
    },
    {
      q: 'Where can you often find extra documentation and examples for installed packages?',
      choices: ['/usr/share/doc', '/var/log', '/etc/skel', '/tmp'],
      answer: 0,
      why: 'Many packages put README files and examples in /usr/share/doc/<package>.',
    },
  ],
  cards: [
    { front: 'Command syntax', back: 'command [options] [arguments]\nExample: ls -l /etc' },
    { front: 'man <command>', back: 'Open the manual page. Space = next page, /word = search, q = quit.' },
    { front: 'man -k <keyword>', back: 'Search all man page descriptions for a keyword. Same as apropos.' },
    { front: 'Man sections 1, 5, 8', back: '1 = user commands\n5 = configuration file formats\n8 = admin commands' },
    { front: '<command> --help', back: 'Quick usage summary printed straight to the terminal.' },
    { front: 'vim: i, Esc', back: 'i enters insert mode to type. Esc returns to command mode.' },
    { front: 'vim: :wq, :q!', back: ':wq save and quit. :q! quit and throw away changes.' },
    { front: 'vim: dd, yy, p, u', back: 'dd delete line, yy copy line, p paste, u undo.' },
    { front: 'Tab key', back: 'Completes commands and file names. Press twice to see all options.' },
    { front: 'history and !n', back: 'history lists earlier commands. !n reruns command number n, !! reruns the last one.' },
    { front: 'Ctrl+C', back: 'Stop the command that is running in the foreground.' },
    { front: '/usr/share/doc', back: 'Extra documentation installed with packages.' },
  ],
  labs: [
    {
      id: 'F2-help',
      title: 'Find your own answers',
      intro: 'Being able to look things up is the most important exam skill. Practise using the built-in help.',
      tasks: [
        { text: 'Open the manual page for the ls command.', hint: 'man ls', check: (sh) => ran(sh, /^man\s+(\d\s+)?ls\b/) },
        { text: 'Search the man page descriptions for anything about "password".', hint: 'man -k password', check: (sh) => ran(sh, /^(man\s+-k|apropos)\s+passw/) },
        { text: 'Look at the documentation directory for bash under /usr/share/doc.', hint: 'ls /usr/share/doc/bash', check: (sh) => ran(sh, /\/usr\/share\/doc\/bash/) },
        { text: 'Show your command history.', hint: 'history', check: (sh) => ran(sh, /^history\b/) },
      ],
    },
  ],
};

const F3: Module = {
  id: 'F3',
  track: 'fundamentals',
  title: 'Files and directories',
  courseRef: 'Linux Fundamentals, Lesson 3',
  summary: 'The file system hierarchy and the everyday commands to move around and manage files.',
  quiz: [
    {
      q: 'Which directory holds system-wide configuration files?',
      choices: ['/bin', '/etc', '/var', '/home'],
      answer: 1,
      why: '/etc holds configuration. /var holds data that changes, like logs. /home holds user directories.',
    },
    {
      q: 'Where do log files usually live?',
      choices: ['/etc/log', '/var/log', '/usr/log', '/tmp/log'],
      answer: 1,
      why: 'Logs change constantly, so they live under /var ("variable"), in /var/log.',
    },
    {
      q: 'What is the difference between an absolute and a relative path?',
      choices: ['Absolute paths are shorter', 'An absolute path starts at / and a relative path starts from where you are now', 'Relative paths only work for root', 'There is no difference'],
      answer: 1,
      why: '/etc/hosts works from anywhere. ../hosts depends on your current directory.',
    },
    {
      q: 'Which command creates /data/a/b even if /data does not exist yet?',
      choices: ['mkdir /data/a/b', 'mkdir -p /data/a/b', 'touch /data/a/b', 'mkdir -r /data/a/b'],
      answer: 1,
      why: '-p (parents) creates every missing directory in the path, and does not complain if it already exists.',
    },
    {
      q: 'How do you copy the directory /etc/ssh and everything in it to /tmp?',
      choices: ['cp /etc/ssh /tmp', 'cp -r /etc/ssh /tmp', 'mv /etc/ssh /tmp', 'copy /etc/ssh /tmp'],
      answer: 1,
      why: 'cp needs -r (recursive) to copy a directory. Without it cp skips the directory.',
    },
    {
      q: 'Which ls option shows hidden files (files whose names start with a dot)?',
      choices: ['-h', '-l', '-a', '-d'],
      answer: 2,
      why: '-a shows all files, including hidden ones like .bashrc.',
    },
    {
      q: 'What does "mv report.txt old-report.txt" do?',
      choices: ['Copies the file', 'Renames the file', 'Deletes the file', 'Creates a link'],
      answer: 1,
      why: 'mv moves files. Moving within the same directory is how you rename in Linux.',
    },
    {
      q: 'What does "cd .." do?',
      choices: ['Go to your home directory', 'Go up one directory', 'Go to /', 'Go to the previous directory'],
      answer: 1,
      why: '.. is the parent directory. cd with no argument goes home, and cd - returns to the previous directory.',
    },
    {
      q: 'Which command removes a directory and everything in it?',
      choices: ['rmdir dir', 'rm dir', 'rm -r dir', 'del dir'],
      answer: 2,
      why: 'rmdir only removes empty directories. rm -r removes the directory and its contents. There is no undo, so double check first.',
    },
  ],
  cards: [
    { front: '/etc', back: 'System configuration files.' },
    { front: '/var', back: 'Data that changes: logs (/var/log), web content (/var/www), spool files.' },
    { front: '/home and /root', back: '/home holds normal users\' home directories. /root is root\'s home.' },
    { front: '/usr', back: 'Installed programs, libraries and documentation. /bin and /sbin are links into /usr.' },
    { front: '/tmp', back: 'Temporary files that anyone can write. Often cleared on reboot.' },
    { front: '/boot', back: 'The kernel and boot loader files.' },
    { front: 'pwd', back: 'Print the current (working) directory.' },
    { front: 'cd, cd .., cd -', back: 'cd = go home. cd .. = up one level. cd - = back to the previous directory.' },
    { front: 'ls -l, ls -a, ls -ld', back: '-l long listing, -a include hidden files, -ld show the directory itself instead of its contents.' },
    { front: 'mkdir -p', back: 'Create a directory and any missing parent directories.' },
    { front: 'cp -r', back: 'Copy a directory recursively.' },
    { front: 'mv', back: 'Move or rename files and directories.' },
    { front: 'rm -r / rmdir', back: 'rm -r removes a directory and contents. rmdir only removes empty directories.' },
    { front: 'Absolute vs relative path', back: 'Absolute starts with / (works anywhere). Relative starts from the current directory.' },
  ],
  labs: [
    {
      id: 'F3-tree',
      title: 'Build a project folder',
      intro: 'Create and organise a small directory tree in your home directory.',
      tasks: [
        {
          text: 'Create the directories ~/projects/web/images in one command.',
          hint: 'mkdir -p ~/projects/web/images',
          check: (sh) => peek(sh, '/home/student/projects/web/images')?.type === 'dir',
        },
        {
          text: 'Copy servers.txt into ~/projects/web.',
          hint: 'cp servers.txt projects/web/',
          check: (sh) => peek(sh, '/home/student/projects/web/servers.txt')?.type === 'file',
        },
        {
          text: 'Rename the copy to ~/projects/web/inventory.txt.',
          hint: 'mv projects/web/servers.txt projects/web/inventory.txt',
          check: (sh) => !!peek(sh, '/home/student/projects/web/inventory.txt') && !peek(sh, '/home/student/projects/web/servers.txt'),
        },
        {
          text: 'Copy the whole ~/projects directory to /tmp/projects-backup.',
          hint: 'cp -r projects /tmp/projects-backup',
          check: (sh) => peek(sh, '/tmp/projects-backup/web/inventory.txt')?.type === 'file',
        },
        {
          text: 'Remove the images directory.',
          hint: 'rmdir projects/web/images',
          check: (sh) => !!peek(sh, '/home/student/projects/web') && !peek(sh, '/home/student/projects/web/images'),
        },
      ],
    },
  ],
};

const F4: Module = {
  id: 'F4',
  track: 'fundamentals',
  title: 'Links, find and archives',
  courseRef: 'Linux Fundamentals, Lesson 4',
  summary: 'Hard and symbolic links, finding files, and packing files with tar and gzip.',
  quiz: [
    {
      q: 'What happens to a symbolic link when you delete the file it points to?',
      choices: ['The link is deleted too', 'The link still exists but is broken', 'The file is restored', 'Nothing, it still works'],
      answer: 1,
      why: 'A symbolic link only stores a path. If the target is gone, the link points to nothing ("dangling").',
    },
    {
      q: 'What happens to a hard link when you delete the original file name?',
      choices: ['The data is gone', 'The data is still reachable through the hard link', 'It becomes a symbolic link', 'It is moved to /tmp'],
      answer: 1,
      why: 'A hard link is another name for the same inode. The data stays until the last name is removed.',
    },
    {
      q: 'Which command creates a symbolic link called "web" pointing to /var/www/html?',
      choices: ['ln /var/www/html web', 'ln -s /var/www/html web', 'ln -s web /var/www/html', 'link web /var/www/html'],
      answer: 1,
      why: 'ln -s TARGET LINKNAME. The target comes first, like cp.',
    },
    {
      q: 'Why can\'t you hard link a directory or across file systems?',
      choices: ['Hard links point to an inode, which only exists within one file system, and directory hard links could create loops', 'Hard links are deprecated', 'Only root can create them', 'They need SELinux'],
      answer: 0,
      why: 'Inode numbers are only unique per file system. Symbolic links have neither limitation.',
    },
    {
      q: 'Which command creates a gzip-compressed archive of /etc called etc.tar.gz?',
      choices: ['tar -xzf etc.tar.gz /etc', 'tar -czf etc.tar.gz /etc', 'gzip /etc etc.tar.gz', 'tar -tf etc.tar.gz /etc'],
      answer: 1,
      why: 'c = create, z = gzip, f = file name of the archive. x extracts and t lists.',
    },
    {
      q: 'How do you list the contents of archive.tar without extracting it?',
      choices: ['tar -tf archive.tar', 'tar -lf archive.tar', 'cat archive.tar', 'tar -xf archive.tar --list'],
      answer: 0,
      why: 't means "table of contents".',
    },
    {
      q: 'Which command finds all files named "*.conf" under /etc?',
      choices: ['find /etc -name "*.conf"', 'grep conf /etc', 'locate /etc conf', 'ls /etc/*.conf -r'],
      answer: 0,
      why: 'find START -name PATTERN searches the whole tree. Quote the pattern so the shell does not expand it first.',
    },
    {
      q: 'How do you extract an archive into the /tmp directory?',
      choices: ['tar -xf a.tar /tmp', 'tar -xf a.tar -C /tmp', 'tar -cf a.tar -C /tmp', 'cd a.tar /tmp'],
      answer: 1,
      why: '-C changes to the given directory before extracting.',
    },
  ],
  cards: [
    { front: 'Inode', back: 'The record that stores a file\'s data location, owner and permissions. A file name points to an inode.' },
    { front: 'Hard link', back: 'An extra name for the same inode. Same file system only, no directories. ln target name' },
    { front: 'Symbolic link', back: 'A small file that points to a path. Can cross file systems and point to directories. ln -s target name' },
    { front: 'ls -i', back: 'Show inode numbers. Hard links share the same number.' },
    { front: 'tar -czf', back: 'Create a gzip-compressed archive: tar -czf archive.tar.gz files...' },
    { front: 'tar -xf / -tf', back: '-x extract, -t list contents. Add -C dir to extract elsewhere.' },
    { front: 'tar compression flags', back: '-z gzip (.gz), -j bzip2 (.bz2), -J xz (.xz).' },
    { front: 'gzip / gunzip', back: 'Compress or decompress a single file. gzip file creates file.gz.' },
    { front: 'find -name / -type / -user', back: 'find /etc -name "*.conf"\nfind / -type d -name ssh\nfind / -user anna' },
    { front: 'Link count in ls -l', back: 'The number after the permissions. For files it counts hard links.' },
  ],
  labs: [
    {
      id: 'F4-links',
      title: 'Links and backups',
      intro: 'Create links, then pack a directory into a compressed archive.',
      tasks: [
        {
          text: 'Create a symbolic link ~/hosts that points to /etc/hosts.',
          hint: 'ln -s /etc/hosts ~/hosts',
          check: (sh) => peek(sh, '/home/student/hosts', false)?.target === '/etc/hosts',
        },
        {
          text: 'Create a hard link ~/notes-hard.txt to ~/notes.txt.',
          hint: 'ln notes.txt notes-hard.txt',
          check: (sh) => {
            const a = peek(sh, '/home/student/notes.txt');
            return !!a && a === peek(sh, '/home/student/notes-hard.txt');
          },
        },
        {
          text: 'Create a gzip-compressed archive /tmp/etc-ssh.tar.gz of the /etc/ssh directory.',
          hint: 'sudo tar -czf /tmp/etc-ssh.tar.gz /etc/ssh',
          check: (sh) => (peek(sh, '/tmp/etc-ssh.tar.gz')?.content ?? '').startsWith('TAR:gzip'),
        },
        {
          text: 'List the contents of that archive without extracting it.',
          hint: 'tar -tzf /tmp/etc-ssh.tar.gz',
          check: (sh) => ran(sh, /^tar\s+-?\w*t\w*\s+.*etc-ssh/),
        },
      ],
    },
  ],
};

const F5: Module = {
  id: 'F5',
  track: 'fundamentals',
  title: 'Working with text files',
  courseRef: 'Linux Fundamentals, Lesson 5',
  summary: 'Viewing files with cat, less, head and tail, and searching them with grep.',
  quiz: [
    {
      q: 'Which command shows only the last 5 lines of /var/log/messages?',
      choices: ['head -5 /var/log/messages', 'tail -n 5 /var/log/messages', 'less -5 /var/log/messages', 'cat -5 /var/log/messages'],
      answer: 1,
      why: 'tail shows the end of a file and head the start. tail -f keeps following new lines as they arrive.',
    },
    {
      q: 'Why use less instead of cat for a long file?',
      choices: ['less is faster to type', 'less lets you scroll and search one screen at a time', 'cat cannot read long files', 'less edits the file'],
      answer: 1,
      why: 'cat dumps the whole file at once. less lets you page with Space, search with /, and quit with q.',
    },
    {
      q: 'Which command shows lines in servers.txt containing "rhel10", ignoring case?',
      choices: ['grep -v rhel10 servers.txt', 'grep -i rhel10 servers.txt', 'find rhel10 servers.txt', 'cat -i rhel10 servers.txt'],
      answer: 1,
      why: '-i ignores case. -v would show the lines that do NOT match.',
    },
    {
      q: 'How do you show the 3rd line through 5th line of a file using head and tail?',
      choices: ['head -n 5 file | tail -n 3', 'tail -n 3 file | head -n 5', 'head -3 -5 file', 'cat file | 3-5'],
      answer: 0,
      why: 'head -n 5 gives lines 1 to 5, then tail -n 3 keeps the last three of those: lines 3, 4 and 5.',
    },
    {
      q: 'What does "wc -l /etc/passwd" tell you?',
      choices: ['The number of words', 'The number of lines, which here equals the number of user accounts', 'The file size', 'The last line'],
      answer: 1,
      why: 'wc counts lines (-l), words (-w) and characters (-c). /etc/passwd has one user per line.',
    },
    {
      q: 'Which command shows the first field (the user name) of every line in /etc/passwd?',
      choices: ['cut -d: -f1 /etc/passwd', 'cut -f1 /etc/passwd', 'head -1 /etc/passwd', 'grep -1 /etc/passwd'],
      answer: 0,
      why: 'Fields in /etc/passwd are separated by colons, so tell cut the delimiter with -d: and the field with -f1.',
    },
    {
      q: 'What does "grep -v ^# /etc/fstab" show?',
      choices: ['Only comment lines', 'All lines that do not start with #', 'Lines containing #', 'Nothing'],
      answer: 1,
      why: '^ anchors the pattern to the start of the line and -v inverts the match, so comments are hidden.',
    },
    {
      q: 'Which command sorts a file numerically in reverse order?',
      choices: ['sort -nr file', 'sort -a file', 'sort file -z', 'order -n file'],
      answer: 0,
      why: '-n sorts by number and -r reverses the order.',
    },
  ],
  cards: [
    { front: 'cat', back: 'Print the whole file to the screen. Best for short files.' },
    { front: 'less', back: 'Page through a file. Space = down, b = up, /text = search, q = quit.' },
    { front: 'head -n N / tail -n N', back: 'First or last N lines (10 by default).' },
    { front: 'tail -f', back: 'Keep following a file as new lines are added. Great for watching logs. Ctrl+C to stop.' },
    { front: 'grep pattern file', back: 'Show matching lines. -i ignore case, -v invert, -n line numbers, -r recursive.' },
    { front: 'wc -l', back: 'Count lines.' },
    { front: 'cut -d: -f1', back: 'Show field 1 using : as the separator.' },
    { front: 'sort / sort -n / sort -r', back: 'Alphabetical, numeric, reversed.' },
    { front: 'uniq -c', back: 'Collapse repeated adjacent lines and count them. Usually used after sort.' },
    { front: '^ and $ in patterns', back: '^ = start of line, $ = end of line. ^$ matches empty lines.' },
  ],
  labs: [
    {
      id: 'F5-text',
      title: 'Dig through text',
      intro: 'servers.txt in your home directory lists servers: name, IP, OS and environment.',
      tasks: [
        { text: 'Show only the first 3 lines of servers.txt.', hint: 'head -n 3 servers.txt', check: (sh) => ran(sh, /^head\b.*3.*servers|^head\b.*servers.*3/) },
        { text: 'Show the lines for production servers only.', hint: 'grep production servers.txt', check: (sh) => ran(sh, /grep\b.*production/) },
        { text: 'Count how many servers run rhel10.', hint: 'grep rhel10 servers.txt | wc -l   (or grep -c rhel10 servers.txt)', check: (sh) => ran(sh, /grep\b.*-c.*rhel10|grep\b.*rhel10.*\|\s*wc -l/) },
        {
          text: 'Save just the server names (first column) to ~/names.txt.',
          hint: "cut -d' ' -f1 servers.txt > names.txt   (or awk '{ print $1 }' servers.txt > names.txt)",
          check: (sh) => (peek(sh, '/home/student/names.txt')?.content ?? '').startsWith('web01\nweb02\n'),
        },
      ],
    },
  ],
};

const stub = (id: string, lesson: number, title: string, summary: string): Module => ({
  id, track: 'fundamentals', title, courseRef: `Linux Fundamentals, Lesson ${lesson}`, summary, quiz: [], cards: [], labs: [],
});

export const FUNDAMENTALS: Module[] = [
  F1, F2, F3, F4, F5,
  stub('F6', 6, 'Text processing', 'Regular expressions, cut, sort, tr, and an introduction to awk and sed.'),
  stub('F7', 7, 'Connecting to a server', 'Consoles, terminals and connecting with ssh and scp.'),
  stub('F8', 8, 'The Bash shell', 'Redirection, pipes, variables, history and shell startup files.'),
  stub('F9', 9, 'Users and groups', 'User accounts, groups, /etc/passwd and /etc/group.'),
  stub('F10', 10, 'Permissions', 'Ownership, read/write/execute and changing them with chmod and chown.'),
  stub('F11', 11, 'Storage essentials', 'Disks, partitions, file systems and mounting.'),
  stub('F12', 12, 'Networking basics', 'IP addresses, ip, ping and host names.'),
  stub('F13', 13, 'systemd and services', 'Starting, stopping and enabling services with systemctl.'),
  stub('F14', 14, 'Managing software', 'Installing and removing packages with dnf.'),
  stub('F15', 15, 'Managing SSH', 'Configuring the SSH server and using key-based login.'),
  stub('F16', 16, 'Managing time', 'Time zones, the system clock and NTP.'),
  stub('F17', 17, 'Processes', 'Viewing and controlling processes with ps, top and kill.'),
  stub('F18', 18, 'Scheduling tasks', 'Running jobs later with cron, at and systemd timers.'),
  stub('F19', 19, 'Reading log files', 'Finding answers in journald and /var/log.'),
];


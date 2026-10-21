import { R10, R11, R12, R8, R9 } from './rhcsa-8-12';
import { R1, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26 } from './rhcsa-rest';
import { Module, groupByName, groupOf, inGroup, ownerName, peek, permBits, ran, userByName } from './types';

// Track 2 follows Sander van Vugt's "Red Hat RHCSA RHEL 10 with Exam Labs" video course and the
// "Red Hat RHCSA 10 Cert Guide: EX200", mapped to Red Hat's published EX200 objectives.
// All questions, cards and labs here are original practice material.

const R2: Module = {
  id: 'R2',
  track: 'rhcsa',
  title: 'Command line, essential tools and Bash',
  courseRef: 'Video Lessons 3–5 · Cert Guide Ch. 2',
  summary: 'Shell syntax, I/O redirection, pipes, variables, and finding documentation. Exam objective: Understand and use essential tools.',
  quiz: [
    {
      q: 'Which redirection sends only error messages to /dev/null?',
      choices: ['> /dev/null', '2> /dev/null', '< /dev/null', '| /dev/null'],
      answer: 1,
      why: 'File descriptor 2 is STDERR. 2> redirects it, while > (same as 1>) redirects STDOUT.',
    },
    {
      q: 'What is the difference between > and >>?',
      choices: ['> appends, >> overwrites', '> overwrites the file, >> appends to it', 'They are the same', '>> redirects errors'],
      answer: 1,
      why: '> truncates the file first. >> adds to the end. Using > on the wrong file is a classic way to lose a config file.',
    },
    {
      q: 'How do you send both STDOUT and STDERR of a command to all.log?',
      choices: ['cmd > all.log 2>&1', 'cmd 2>&1 > all.log', 'cmd >> 2 all.log', 'cmd | all.log'],
      answer: 0,
      why: 'First point STDOUT at the file, then point STDERR (2) at wherever STDOUT (1) goes. In bash, cmd &> all.log is a shortcut.',
    },
    {
      q: 'Which file is read by every interactive non-login bash shell for a single user?',
      choices: ['/etc/profile', '~/.bashrc', '/etc/environment', '~/.bash_logout'],
      answer: 1,
      why: '~/.bashrc is the usual place for personal aliases and variables. /etc/profile and /etc/bashrc are system-wide.',
    },
    {
      q: 'You need to switch to a full root login environment. Which is correct on RHEL?',
      choices: ['su', 'sudo -i', 'root -i', 'login root'],
      answer: 1,
      why: 'sudo -i (or su -) gives a login shell with root\'s environment. Plain su keeps your own environment, which can cause surprises.',
    },
    {
      q: 'Which command shows the value of the PATH variable?',
      choices: ['echo PATH', 'echo $PATH', 'cat PATH', 'set PATH'],
      answer: 1,
      why: 'A $ in front tells the shell to substitute the variable\'s value.',
    },
    {
      q: 'What will echo \'$HOME\' print?',
      choices: ['/home/student', '$HOME', 'HOME', 'An error'],
      answer: 1,
      why: 'Single quotes stop all expansion. Double quotes ("$HOME") would print /home/student.',
    },
    {
      q: 'The exam asks you to find documentation for a configuration file format. Which man section should you check?',
      choices: ['1', '3', '5', '8'],
      answer: 2,
      why: 'Section 5 documents file formats, for example man 5 crontab vs man 1 crontab.',
    },
    {
      q: 'What does "ls /etc | wc -l" do?',
      choices: ['Lists /etc to a file named wc', 'Counts the entries in /etc by sending ls output into wc', 'Runs two commands one after another', 'Errors'],
      answer: 1,
      why: 'A pipe sends the STDOUT of the first command into the STDIN of the second.',
    },
    {
      q: 'Which key combination searches backward through your command history?',
      choices: ['Ctrl+R', 'Ctrl+H', 'Ctrl+Z', 'Ctrl+P'],
      answer: 0,
      why: 'Ctrl+R starts a reverse search. Type part of an old command and press Enter to run it.',
    },
  ],
  cards: [
    { front: 'STDIN / STDOUT / STDERR', back: '0 = input, 1 = normal output, 2 = error output.' },
    { front: '> vs >>', back: '> overwrite, >> append.' },
    { front: '2> and 2>&1', back: '2> file sends errors to a file. 2>&1 sends errors wherever STDOUT goes.' },
    { front: '&> file', back: 'Bash shortcut: send STDOUT and STDERR to the same file.' },
    { front: '| (pipe)', back: 'Feed one command\'s output into the next command\'s input.' },
    { front: '/dev/null', back: 'The "black hole". Anything written there disappears.' },
    { front: 'Single vs double quotes', back: '\'$X\' is literal. "$X" expands the variable but protects spaces.' },
    { front: 'Login vs non-login shell files', back: 'Login: /etc/profile, ~/.bash_profile. Every shell: /etc/bashrc, ~/.bashrc.' },
    { front: 'alias', back: 'alias ll=\'ls -l\'. Put it in ~/.bashrc to keep it.' },
    { front: 'sudo -i / su -', back: 'Open a root login shell. exit returns to your user.' },
    { front: 'man -k / mandb', back: 'man -k searches descriptions. If empty, run mandb as root to rebuild the index.' },
    { front: 'Ctrl+R', back: 'Reverse search through history.' },
    { front: 'echo $?', back: 'Exit status of the last command. 0 = success, anything else = failure.' },
  ],
  labs: [
    {
      id: 'R2-redirect',
      title: 'Redirection drill',
      intro: 'Exam tasks often ask you to save command output, or only the errors, to a specific file.',
      tasks: [
        {
          text: 'Save a long listing of /etc to /tmp/etc-list.txt.',
          hint: 'ls -l /etc > /tmp/etc-list.txt',
          check: (sh) => (peek(sh, '/tmp/etc-list.txt')?.content ?? '').includes('os-release'),
        },
        {
          text: 'Run "ls /etc /nonexistent" and save only the error message to /tmp/errors.txt.',
          hint: 'ls /etc /nonexistent 2> /tmp/errors.txt',
          check: (sh) => {
            const c = peek(sh, '/tmp/errors.txt')?.content ?? '';
            return c.includes('nonexistent') && !c.includes('os-release');
          },
        },
        {
          text: 'Append the current date to /tmp/etc-list.txt without overwriting it.',
          hint: 'date >> /tmp/etc-list.txt',
          check: (sh) => {
            const c = peek(sh, '/tmp/etc-list.txt')?.content ?? '';
            return c.includes('os-release') && /\d{4}/.test(c.split('\n').filter(Boolean).pop() ?? '');
          },
        },
        {
          text: 'Count the user accounts on the system using a pipe, and save the number to /tmp/usercount.',
          hint: 'cat /etc/passwd | wc -l > /tmp/usercount   (or wc -l < /etc/passwd > /tmp/usercount)',
          check: (sh) => /^\s*\d+\s*$/.test(peek(sh, '/tmp/usercount')?.content ?? ''),
        },
      ],
    },
  ],
};

const R3: Module = {
  id: 'R3',
  track: 'rhcsa',
  title: 'File management, links and archives',
  courseRef: 'Video Lesson 6 · Cert Guide Ch. 3',
  summary: 'Copying, moving and removing files, hard and soft links, and tar archives with gzip and bzip2.',
  quiz: [
    {
      q: 'An exam task says: "Create an archive /root/etc.tar.bz2 of /etc using bzip2". Which command is right?',
      choices: ['tar -czf /root/etc.tar.bz2 /etc', 'tar -cjf /root/etc.tar.bz2 /etc', 'bzip2 /etc /root/etc.tar.bz2', 'tar -xjf /root/etc.tar.bz2 /etc'],
      answer: 1,
      why: '-j selects bzip2. -z is gzip. Reading the file extension the task gives you tells you which one it wants.',
    },
    {
      q: 'Why does tar print "Removing leading `/\' from member names"?',
      choices: ['It is an error and the archive is empty', 'It stores paths relative so extracting won\'t overwrite the original locations', 'Your disk is full', 'SELinux blocked it'],
      answer: 1,
      why: 'It is just a notice. The archive stores etc/... instead of /etc/..., so it extracts into the current directory.',
    },
    {
      q: 'Which command preserves permissions, ownership and timestamps when copying a directory?',
      choices: ['cp -r', 'cp -a', 'cp -p -r --keep', 'mv -a'],
      answer: 1,
      why: 'cp -a (archive) is recursive and preserves attributes.',
    },
    {
      q: 'You run "ls -il" and see two files with the same inode number. What are they?',
      choices: ['Symbolic links', 'Hard links to the same file', 'Copies', 'Corrupted files'],
      answer: 1,
      why: 'Hard links share one inode. A symbolic link has its own inode.',
    },
    {
      q: 'Which directory listing character shows a symbolic link?',
      choices: ['d', '-', 'l', 's'],
      answer: 2,
      why: 'The first character of ls -l is the type: - file, d directory, l link.',
    },
    {
      q: 'How do you find all files owned by user anna and copy them to /root/anna-files?',
      choices: ['find / -user anna -exec cp {} /root/anna-files \\;', 'grep anna / > /root/anna-files', 'ls -R anna /root/anna-files', 'cp -u anna / /root/anna-files'],
      answer: 0,
      why: 'find -user selects by owner and -exec runs a command on every match. {} is replaced with the file name.',
    },
    {
      q: 'Which command copies all files starting with "a" in /etc to /tmp?',
      choices: ['cp /etc/a /tmp', 'cp /etc/a* /tmp', 'cp -r a /etc /tmp', 'cp /etc/[a] /tmp'],
      answer: 1,
      why: 'The * wildcard (glob) matches any characters. The shell expands it before cp runs.',
    },
    {
      q: 'What does the "-r" mean in "rm -rf /tmp/olddir"?',
      choices: ['Read only', 'Recursive', 'Root', 'Restore'],
      answer: 1,
      why: '-r recurses into the directory, -f forces removal without asking. Double-check the path first.',
    },
  ],
  cards: [
    { front: 'tar -cvf / -czvf / -cjvf', back: 'Create: plain / gzip / bzip2. v = verbose.' },
    { front: 'tar -xvf archive -C dir', back: 'Extract into dir.' },
    { front: 'tar -tvf archive', back: 'List archive contents.' },
    { front: 'cp -a', back: 'Archive copy: recursive and preserves mode, ownership and timestamps.' },
    { front: 'ln vs ln -s', back: 'ln = hard link (same inode). ln -s = symbolic link (stores a path).' },
    { front: 'find -exec', back: 'find / -user anna -exec cp {} /dest \\;\n{} = each found file, \\; ends the command.' },
    { front: 'Globbing: * ? []', back: '* any characters, ? exactly one character, [abc] one of a, b or c.' },
    { front: 'File types in ls -l', back: '- regular, d directory, l symlink, b block device, c character device.' },
    { front: 'mv across file systems', back: 'Within one file system mv just renames. Across file systems it copies and then deletes.' },
    { front: 'Brace expansion', back: 'mkdir -p /data/{web,db,logs} creates three directories at once.' },
  ],
  labs: [
    {
      id: 'R3-archive',
      title: 'Exam-style archive task',
      intro: 'As root: create an archive and restore files from it, the way exam tasks phrase it.',
      tasks: [
        { text: 'Become root.', hint: 'sudo -i', check: (sh) => sh.uid === 0 || ran(sh, /^sudo\s+-i|^sudo su/) },
        {
          text: 'Create a bzip2-compressed archive /root/etc.tar.bz2 that contains /etc.',
          hint: 'tar -cjf /root/etc.tar.bz2 /etc',
          check: (sh) => (peek(sh, '/root/etc.tar.bz2')?.content ?? '').startsWith('TAR:bzip2'),
        },
        {
          text: 'Extract the archive into the directory /restore (create it first).',
          hint: 'mkdir /restore && tar -xjf /root/etc.tar.bz2 -C /restore',
          check: (sh) => peek(sh, '/restore/etc/hosts')?.type === 'file',
        },
        {
          text: 'Create a symbolic link /root/hosts-link that points to /restore/etc/hosts.',
          hint: 'ln -s /restore/etc/hosts /root/hosts-link',
          check: (sh) => peek(sh, '/root/hosts-link', false)?.target === '/restore/etc/hosts',
        },
      ],
    },
  ],
};

const R4: Module = {
  id: 'R4',
  track: 'rhcsa',
  title: 'Text files, grep and regular expressions',
  courseRef: 'Video Lesson 7 · Cert Guide Ch. 4',
  summary: 'Analysing text with grep and regular expressions, plus cut, sort, awk and sed.',
  quiz: [
    {
      q: 'Which regular expression matches lines that start with "root"?',
      choices: ['root$', '^root', '*root', 'root^'],
      answer: 1,
      why: '^ anchors to the start of the line and $ to the end.',
    },
    {
      q: 'Which grep command finds lines containing "web" or "db"?',
      choices: ['grep web db file', 'grep -E "web|db" file', 'grep "web,db" file', 'grep -v "web|db" file'],
      answer: 1,
      why: 'With -E (extended regex) the | means OR. In basic grep you would write \\|.',
    },
    {
      q: 'In a regular expression, what does "." match?',
      choices: ['A literal dot only', 'Any single character', 'Zero or more characters', 'The end of the line'],
      answer: 1,
      why: '. is any one character. To match a real dot, escape it as \\.',
    },
    {
      q: 'Which command shows all lines in /etc/passwd for users whose shell is /bin/bash?',
      choices: ['grep "bash$" /etc/passwd', 'grep "^bash" /etc/passwd', 'cut bash /etc/passwd', 'grep -v bash /etc/passwd'],
      answer: 0,
      why: 'The shell is the last field, so anchoring with $ makes sure "bash" is at the end of the line.',
    },
    {
      q: 'An exam task: "Find all lines containing the word \'error\' in /var/log/messages and save them to /root/errors". What works?',
      choices: ['grep -i error /var/log/messages > /root/errors', 'find error /var/log/messages > /root/errors', 'cat /var/log/messages > /root/errors', 'grep -v error /var/log/messages > /root/errors'],
      answer: 0,
      why: 'grep finds the lines and > saves them. -i catches Error and ERROR too.',
    },
    {
      q: 'What does "x*" mean in a regular expression?',
      choices: ['x followed by anything', 'Zero or more x characters', 'Exactly one x', 'x at the end of the line'],
      answer: 1,
      why: 'In regex, * repeats the previous character zero or more times. This is different from shell globbing.',
    },
    {
      q: 'Which awk command prints the first and third fields of /etc/passwd?',
      choices: ["awk -F: '{ print $1, $3 }' /etc/passwd", "awk '{ print 1, 3 }' /etc/passwd", "awk -d: -f1,3 /etc/passwd", "awk print $1 $3"],
      answer: 0,
      why: '-F: sets the field separator, and $1, $3 refer to the fields.',
    },
    {
      q: 'Which sed command replaces every "rhel9" with "rhel10" in servers.txt and saves the file?',
      choices: ["sed 's/rhel9/rhel10/g' servers.txt", "sed -i 's/rhel9/rhel10/g' servers.txt", "sed -r rhel9 rhel10 servers.txt", "replace rhel9 rhel10 servers.txt"],
      answer: 1,
      why: '-i edits the file in place. Without -i sed only prints the result.',
    },
  ],
  cards: [
    { front: '^ and $', back: 'Start of line and end of line.' },
    { front: '. in regex', back: 'Any single character.' },
    { front: '* in regex', back: 'Zero or more of the previous character. .* = anything.' },
    { front: '[abc] and [^abc]', back: 'One of a, b, c. With ^ inside: anything except those.' },
    { front: 'grep -E', back: 'Extended regex: | for OR, + for one or more, ? for optional, () for groups.' },
    { front: 'grep -i -v -n -r -c', back: 'ignore case, invert, line numbers, recursive, count.' },
    { front: 'Quote your regex', back: 'Always put regular expressions in single quotes so the shell does not touch them.' },
    { front: "awk -F: '{ print $1 }'", back: 'Print field 1 with : as separator.' },
    { front: "sed -i 's/a/b/g' file", back: 'Replace a with b everywhere in file, saving the change.' },
    { front: "sed -i '/^#/d' file", back: 'Delete every line starting with #.' },
    { front: 'grep -v -e "^#" -e "^$"', back: 'Show a config file without comments and blank lines.' },
  ],
  labs: [
    {
      id: 'R4-grep',
      title: 'Find it in the logs',
      intro: 'Use grep and friends against the files on this server.',
      tasks: [
        {
          text: 'Save every line of /etc/passwd whose shell is /bin/bash to /tmp/bash-users.',
          hint: "grep 'bash$' /etc/passwd > /tmp/bash-users",
          check: (sh) => {
            const c = peek(sh, '/tmp/bash-users')?.content ?? '';
            return c.includes('root:') && c.includes('student:') && !c.includes('nologin');
          },
        },
        {
          text: 'As root, find the lines in /var/log/secure that mention "Failed password".',
          hint: 'sudo grep "Failed password" /var/log/secure',
          check: (sh) => ran(sh, /grep\b.*Failed/),
        },
        {
          text: 'Show servers.txt lines for web01 or db01 using one grep command.',
          hint: "grep -E 'web01|db01' servers.txt",
          check: (sh) => ran(sh, /grep\b.*(web01\\?\|db01|db01\\?\|web01)/),
        },
        {
          text: 'Use sed to change every "fedora" to "rhel10" in servers.txt, editing the file in place.',
          hint: "sed -i 's/fedora/rhel10/g' servers.txt",
          check: (sh) => {
            const c = peek(sh, '/home/student/servers.txt')?.content ?? '';
            return !c.includes('fedora') && c.includes('dev01 192.168.4.40 rhel10');
          },
        },
      ],
    },
  ],
};

const R5: Module = {
  id: 'R5',
  track: 'rhcsa',
  title: 'Root privileges and sudo',
  courseRef: 'Video Lesson 8 · Cert Guide Ch. 6',
  summary: 'Working as root safely, su versus sudo, and configuring privileged access. Exam objective: Configure privileged access.',
  quiz: [
    {
      q: 'On RHEL, membership of which group gives a user full sudo access by default?',
      choices: ['admin', 'sudo', 'wheel', 'root'],
      answer: 2,
      why: '/etc/sudoers contains %wheel ALL=(ALL) ALL. On Ubuntu the group is called sudo instead.',
    },
    {
      q: 'What is the safe way to edit the sudo configuration?',
      choices: ['vim /etc/sudoers', 'visudo', 'nano /etc/sudoers', 'echo >> /etc/sudoers'],
      answer: 1,
      why: 'visudo checks the syntax before saving. A broken sudoers file can lock everyone out of sudo.',
    },
    {
      q: 'Where should you put a custom sudo rule so package updates never overwrite it?',
      choices: ['/etc/sudoers.d/<name>', '/etc/sudo.conf', '~/.sudo', '/root/sudoers'],
      answer: 0,
      why: 'Drop-in files in /etc/sudoers.d are included automatically. Use visudo -f /etc/sudoers.d/name.',
    },
    {
      q: 'Which sudoers line lets members of group "operators" restart only httpd?',
      choices: ['%operators ALL=/usr/bin/systemctl restart httpd', 'operators ALL=(ALL) ALL', '%operators ALL=NOPASSWD: ALL', 'allow operators systemctl'],
      answer: 0,
      why: '% marks a group, ALL is the hosts, and then comes the exact command allowed.',
    },
    {
      q: 'Whose password does sudo ask for?',
      choices: ['root\'s', 'Your own', 'No password ever', 'The wheel group password'],
      answer: 1,
      why: 'sudo asks for your own password (unless NOPASSWD is set). su asks for the target user\'s password.',
    },
    {
      q: 'What does "su - anna" do when you are root?',
      choices: ['Deletes anna', 'Opens a login shell as anna without asking for a password', 'Changes anna\'s password', 'Locks anna'],
      answer: 1,
      why: 'root can switch to any user without a password. The - loads that user\'s login environment.',
    },
    {
      q: 'How do you add existing user lisa to the wheel group without removing her other groups?',
      choices: ['usermod -G wheel lisa', 'usermod -aG wheel lisa', 'groupadd wheel lisa', 'useradd -G wheel lisa'],
      answer: 1,
      why: '-a means append. Without -a, -G replaces all of lisa\'s supplementary groups.',
    },
  ],
  cards: [
    { front: 'wheel group', back: 'Members get full sudo rights on RHEL.' },
    { front: 'visudo', back: 'Edit /etc/sudoers safely with syntax checking.' },
    { front: '/etc/sudoers.d/', back: 'Drop-in directory for your own sudo rules.' },
    { front: 'sudoers line format', back: 'who  where=(as-whom)  what\nexample: %wheel ALL=(ALL) ALL' },
    { front: 'NOPASSWD:', back: 'In a sudoers rule, skip the password prompt. Example: anna ALL=(ALL) NOPASSWD: ALL' },
    { front: 'su vs sudo', back: 'su = become another user with their password. sudo = run one command as root with your own password.' },
    { front: 'sudo -i', back: 'Interactive root login shell.' },
    { front: 'usermod -aG wheel user', back: 'Give a user sudo rights by appending wheel.' },
    { front: '/var/log/secure', back: 'Log file where sudo and SSH logins are recorded.' },
  ],
  labs: [
    {
      id: 'R5-sudo',
      title: 'Give a user admin rights',
      intro: 'Create an administrator account the way an exam task would ask.',
      tasks: [
        { text: 'Create a user called "admin1".', hint: 'sudo useradd admin1', check: (sh) => !!userByName(sh, 'admin1') },
        { text: 'Set a password for admin1.', hint: 'sudo passwd admin1', check: (sh) => !!userByName(sh, 'admin1')?.password },
        {
          text: 'Give admin1 full sudo privileges by adding them to the right group.',
          hint: 'sudo usermod -aG wheel admin1',
          check: (sh) => inGroup(sh, 'admin1', 'wheel'),
        },
        { text: 'Check admin1\'s group membership.', hint: 'id admin1', check: (sh) => ran(sh, /^(id|groups)\s+admin1/) },
      ],
    },
  ],
};

const R6: Module = {
  id: 'R6',
  track: 'rhcsa',
  title: 'Users, groups and password aging',
  courseRef: 'Video Lesson 9 · Cert Guide Ch. 6',
  summary: 'Creating, modifying and deleting users and groups, and setting password policies. Exam objectives: Manage users and groups.',
  quiz: [
    {
      q: 'Which file holds the encrypted passwords and password aging settings?',
      choices: ['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/login.defs'],
      answer: 1,
      why: '/etc/shadow is only readable by root. /etc/passwd holds the account details but no passwords.',
    },
    {
      q: 'Which command creates user "bob" with UID 1500?',
      choices: ['useradd -u 1500 bob', 'useradd -g 1500 bob', 'usermod -u 1500 bob', 'adduser bob 1500'],
      answer: 0,
      why: '-u sets the UID. -g sets the primary group and -G supplementary groups.',
    },
    {
      q: 'Which command makes bob\'s password expire every 90 days?',
      choices: ['passwd -x 90 bob', 'chage -M 90 bob', 'Both of these', 'usermod -e 90 bob'],
      answer: 2,
      why: 'chage -M 90 and passwd -x 90 both set the maximum password age. chage -l bob shows the result.',
    },
    {
      q: 'Where do you set the default password aging for NEW users?',
      choices: ['/etc/shadow', '/etc/login.defs', '/etc/default/passwd', '~/.bashrc'],
      answer: 1,
      why: 'PASS_MAX_DAYS and friends in /etc/login.defs apply to accounts created afterwards. Existing users need chage.',
    },
    {
      q: 'Which user shell prevents interactive login?',
      choices: ['/bin/bash', '/sbin/nologin', '/bin/false only', '/usr/bin/login'],
      answer: 1,
      why: 'Service accounts use /sbin/nologin. Set it with useradd -s /sbin/nologin or usermod -s.',
    },
    {
      q: 'Which directory\'s contents are copied into every new user\'s home directory?',
      choices: ['/etc/skel', '/etc/default', '/home/template', '/usr/share/home'],
      answer: 0,
      why: 'Put a file in /etc/skel and every new user gets a copy.',
    },
    {
      q: 'What does "userdel -r linda" do that "userdel linda" does not?',
      choices: ['Removes linda from all groups', 'Also removes linda\'s home directory and mail spool', 'Locks the account first', 'Asks for confirmation'],
      answer: 1,
      why: '-r removes the home directory too. Without it the files stay behind, owned by a UID that no longer has a name.',
    },
    {
      q: 'How do you create group "sales" with GID 5000?',
      choices: ['groupadd -g 5000 sales', 'groupadd sales 5000', 'groupmod -g 5000 sales', 'addgroup -n 5000 sales'],
      answer: 0,
      why: 'groupadd -g sets the GID. groupmod -g changes the GID of an existing group.',
    },
    {
      q: 'User normal UIDs on RHEL start at which number by default?',
      choices: ['100', '500', '1000', '65534'],
      answer: 2,
      why: 'UID_MIN in /etc/login.defs is 1000. Lower numbers are reserved for system accounts.',
    },
  ],
  cards: [
    { front: '/etc/passwd fields', back: 'name:x:UID:GID:comment:home:shell' },
    { front: '/etc/shadow', back: 'Password hashes and aging. Root-only.' },
    { front: '/etc/group fields', back: 'name:x:GID:member1,member2' },
    { front: 'useradd -u -g -G -s -c', back: 'UID, primary group, supplementary groups, shell, comment.' },
    { front: 'usermod -aG group user', back: 'Add user to a group, keeping existing groups.' },
    { front: 'usermod -L / -U', back: 'Lock / unlock an account.' },
    { front: 'userdel -r', back: 'Delete user and home directory.' },
    { front: 'passwd user', back: 'Set a user\'s password (root). echo pw | passwd --stdin user for scripts.' },
    { front: 'chage -l user', back: 'Show password aging for a user.' },
    { front: 'chage -M / -m / -W', back: 'Maximum days, minimum days, warning days.' },
    { front: '/etc/login.defs', back: 'Defaults for new accounts: PASS_MAX_DAYS, UID_MIN, CREATE_HOME, UMASK.' },
    { front: '/etc/skel', back: 'Template files copied to new home directories.' },
    { front: 'Primary vs supplementary group', back: 'Primary group owns new files you create (GID in /etc/passwd). Supplementary groups give extra access.' },
    { front: 'groupadd -g / groupmod -n', back: 'Create group with a GID / rename a group.' },
  ],
  labs: [
    {
      id: 'R6-users',
      title: 'Set up a team',
      intro: 'Exam style: create a group and users with specific settings. Work as root.',
      tasks: [
        { text: 'Create the group "sales" with GID 5000.', hint: 'sudo groupadd -g 5000 sales', check: (sh) => groupByName(sh, 'sales')?.gid === 5000 },
        {
          text: 'Create user "lisa" with UID 2001 and "sales" as a supplementary group.',
          hint: 'sudo useradd -u 2001 -G sales lisa',
          check: (sh) => userByName(sh, 'lisa')?.uid === 2001 && inGroup(sh, 'lisa', 'sales'),
        },
        {
          text: 'Create user "svc-backup" that cannot log in interactively.',
          hint: 'sudo useradd -s /sbin/nologin svc-backup',
          check: (sh) => userByName(sh, 'svc-backup')?.shell === '/sbin/nologin',
        },
        {
          text: 'Make lisa\'s password expire every 60 days.',
          hint: 'sudo chage -M 60 lisa',
          check: (sh) => userByName(sh, 'lisa')?.maxDays === 60,
        },
        {
          text: 'Set lisa\'s password to "password" using a single non-interactive command.',
          hint: 'echo password | sudo passwd --stdin lisa',
          check: (sh) => userByName(sh, 'lisa')?.password === '$6$password',
        },
      ],
    },
  ],
};

const R7: Module = {
  id: 'R7',
  track: 'rhcsa',
  title: 'Permissions, special bits and umask',
  courseRef: 'Video Lesson 10 · Cert Guide Ch. 7',
  summary: 'Ownership, basic and special permissions, default permissions with umask, and fixing permission problems.',
  quiz: [
    {
      q: 'What permissions does chmod 750 give?',
      choices: ['rwxr-x---', 'rwxrwx---', 'rw-r-x---', 'rwxr-xr-x'],
      answer: 0,
      why: '7 = rwx (4+2+1) for the owner, 5 = r-x (4+1) for the group, 0 = nothing for others.',
    },
    {
      q: 'What does the execute (x) permission mean on a directory?',
      choices: ['You can run the directory', 'You can enter it (cd) and reach files inside it', 'You can list its contents', 'You can delete it'],
      answer: 1,
      why: 'On a directory, r lets you list names, w lets you create and delete files, and x lets you enter it.',
    },
    {
      q: 'A shared directory /data/sales should make new files belong to group "sales" automatically. Which permission do you set?',
      choices: ['SUID', 'SGID on the directory', 'Sticky bit', 'chmod 777'],
      answer: 1,
      why: 'SGID on a directory makes new files inherit the directory\'s group. chmod g+s /data/sales.',
    },
    {
      q: 'Which special permission stops users deleting each other\'s files in a shared directory like /tmp?',
      choices: ['SUID', 'SGID', 'Sticky bit', 'umask'],
      answer: 2,
      why: 'With the sticky bit (chmod +t or 1xxx) only the file owner, the directory owner or root can delete a file.',
    },
    {
      q: 'With umask 027, what permissions does a new FILE get?',
      choices: ['rw-r-----', 'rwxr-x---', 'rw-rw-r--', 'r--r-----'],
      answer: 0,
      why: 'Files start from 666. 666 minus 027 gives 640, which is rw-r-----. Directories start from 777, giving 750.',
    },
    {
      q: 'Which command makes anna the owner and sales the group of /data/sales and everything in it?',
      choices: ['chown -R anna:sales /data/sales', 'chmod -R anna:sales /data/sales', 'chgrp anna sales /data/sales', 'chown anna /data/sales sales'],
      answer: 0,
      why: 'chown user:group sets both at once. -R applies it recursively.',
    },
    {
      q: 'In "drwxrws---", what does the "s" in the group position mean?',
      choices: ['SUID is set', 'SGID is set and group execute is on', 'Sticky bit', 'The group is "s"'],
      answer: 1,
      why: 'A lowercase s in the group triplet means SGID + x. An uppercase S would mean SGID without x.',
    },
    {
      q: 'What octal value sets SGID and rwxrwx--- on a directory?',
      choices: ['0770', '2770', '4770', '1770'],
      answer: 1,
      why: 'The leading digit is special bits: 4 = SUID, 2 = SGID, 1 = sticky.',
    },
    {
      q: 'User linda belongs to "sales" and the file is -rw----r-- root:sales. Can linda read it?',
      choices: ['Yes, through "others"', 'No. Linux uses the first matching class (group), and the group has no permissions', 'Yes, because she is in sales', 'Only with sudo'],
      answer: 1,
      why: 'Permissions are checked owner, then group, then others, and the first class that matches is used. Linda matches group, which has ---.',
    },
  ],
  cards: [
    { front: 'r w x values', back: 'r = 4, w = 2, x = 1. Add them per class: owner, group, others.' },
    { front: 'chmod 640', back: 'rw-r----- : owner read/write, group read, others nothing.' },
    { front: 'chmod symbolic', back: 'chmod u+x file, chmod g-w file, chmod o= file, chmod a+r file.' },
    { front: 'r/w/x on a directory', back: 'r = list names, w = create/delete entries, x = enter and access files.' },
    { front: 'SUID (4)', back: 'Program runs as its owner. Example: /usr/bin/passwd. Shows as s in the owner x spot.' },
    { front: 'SGID (2) on a directory', back: 'New files inherit the directory\'s group. Perfect for shared team folders.' },
    { front: 'Sticky bit (1)', back: 'Only owners can delete their own files in the directory. Shows as t. Example: /tmp.' },
    { front: 'umask', back: 'Removes permissions from new files (666) and directories (777). umask 022 → files 644, dirs 755.' },
    { front: 'Where to set umask', back: 'For all users: /etc/profile or /etc/bashrc (or a file in /etc/profile.d). For one user: ~/.bashrc.' },
    { front: 'chown user:group file', back: 'Change owner and group. -R recursive. Only root can change the owner.' },
    { front: 'chgrp group file', back: 'Change the group only.' },
    { front: 'Permission check order', back: 'Owner? use owner bits. Else in group? use group bits. Else use others. Only one class applies.' },
  ],
  labs: [
    {
      id: 'R7-shared',
      title: 'Shared team directory',
      intro: 'Classic exam task: build a shared directory for a group. Group "sales" with members anna and linda has been created for you.',
      setup: (sh) => {
        sh.asUser(sh.state.users[0], () => {
          sh.run('groupadd sales');
          sh.run('useradd -G sales anna');
          sh.run('useradd -G sales linda');
        });
        sh.history = [];
      },
      tasks: [
        { text: 'Create the directory /data/sales.', hint: 'sudo mkdir -p /data/sales', check: (sh) => peek(sh, '/data/sales')?.type === 'dir' },
        {
          text: 'Make root the owner and sales the group owner of /data/sales.',
          hint: 'sudo chown root:sales /data/sales',
          check: (sh) => {
            const n = peek(sh, '/data/sales');
            return ownerName(sh, n) === 'root' && groupOf(sh, n) === 'sales';
          },
        },
        {
          text: 'Give owner and group full access and others none.',
          hint: 'sudo chmod 770 /data/sales',
          check: (sh) => (permBits(peek(sh, '/data/sales')) & 0o777) === 0o770,
        },
        {
          text: 'Make sure new files in /data/sales automatically belong to the sales group.',
          hint: 'sudo chmod g+s /data/sales',
          check: (sh) => (permBits(peek(sh, '/data/sales')) & 0o2000) !== 0,
        },
        {
          text: 'Make sure users can only delete files they own in /data/sales.',
          hint: 'sudo chmod +t /data/sales   (all at once: chmod 3770 /data/sales)',
          check: (sh) => (permBits(peek(sh, '/data/sales')) & 0o1000) !== 0,
        },
      ],
    },
  ],
};

export const RHCSA: Module[] = [
  R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13,
  R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26,
];

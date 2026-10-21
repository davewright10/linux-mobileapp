import { Module, groupByName, groupOf, inGroup, ownerName, peek, permBits, ran, userByName } from './types';

// Linux Fundamentals, Lessons 6–10. Original practice material.

export const F6: Module = {
  id: 'F6',
  track: 'fundamentals',
  title: 'Text processing',
  courseRef: 'Linux Fundamentals, Lesson 6',
  summary: 'Regular expressions, cut, sort, tr, and an introduction to awk and sed for reshaping text.',
  quiz: [
    {
      q: 'What is the main difference between a regular expression and a shell wildcard like *.txt?',
      choices: ['There is none', 'Wildcards match file names in the shell, regular expressions match text inside tools like grep', 'Regular expressions only work in vim', 'Wildcards are only for root'],
      answer: 1,
      why: 'The shell expands *.txt into file names before the command runs. A regular expression is handed to a tool like grep, which uses it to match text.',
    },
    {
      q: 'Which pattern matches an empty line?',
      choices: ['^$', '$^', '*', '""'],
      answer: 0,
      why: 'Start of line immediately followed by end of line means there is nothing in between.',
    },
    {
      q: 'Which command turns all lowercase letters in a file into uppercase on screen?',
      choices: ['tr a-z A-Z < file', 'upper file', 'sed upper file', 'cut -u file'],
      answer: 0,
      why: 'tr translates characters from the first set into the second. It only reads from STDIN, so use < or a pipe.',
    },
    {
      q: 'Why do you often run sort before uniq?',
      choices: ['uniq needs root', 'uniq only removes duplicates that are next to each other', 'sort makes it faster', 'There is no reason'],
      answer: 1,
      why: 'uniq compares each line with the one before it. Sorting first puts identical lines side by side.',
    },
    {
      q: "What does awk -F: '{ print $1 }' /etc/passwd print?",
      choices: ['The whole file', 'Every user name', 'The first line', 'The number of users'],
      answer: 1,
      why: 'Fields are split on colons and $1 is the first field, which is the user name.',
    },
    {
      q: "What does sed 's/cat/dog/' pets.txt do to the file on disk?",
      choices: ['Changes the first cat on each line to dog in the file', 'Nothing. It prints the changed text but leaves the file alone', 'Deletes the file', 'Changes every cat in the file'],
      answer: 1,
      why: 'Without -i, sed writes the result to the screen only. Add g to change every match on a line, and -i to save to the file.',
    },
    {
      q: 'In a regular expression, what does [0-9] match?',
      choices: ['The text "0-9"', 'Any single digit', 'Exactly nine characters', 'Ten digits in a row'],
      answer: 1,
      why: 'Square brackets match one character from the set. 0-9 is the range of digits.',
    },
    {
      q: 'Which command shows the 3 most common words in words.txt, one word per line?',
      choices: ['sort words.txt | uniq -c | sort -nr | head -n 3', 'uniq words.txt | head -3', 'head -n 3 words.txt', 'grep -c words.txt'],
      answer: 0,
      why: 'Sort to group, count with uniq -c, sort the counts numerically in reverse, then keep the top 3. This pipeline pattern comes up all the time.',
    },
  ],
  cards: [
    { front: 'Regex vs wildcard', back: 'Wildcards (*, ?) match file names in the shell. Regular expressions match text in grep, sed, awk and vim.' },
    { front: '^$', back: 'An empty line.' },
    { front: '[0-9] / [a-z] / [^0-9]', back: 'One digit / one lowercase letter / one character that is NOT a digit.' },
    { front: 'tr a-z A-Z', back: 'Translate lowercase to uppercase. tr -d x deletes every x.' },
    { front: 'sort | uniq -c | sort -nr', back: 'Count how often each line appears, most common first.' },
    { front: 'cut -c1-5', back: 'Show characters 1 to 5 of each line.' },
    { front: "awk '/pattern/ { print $2 }'", back: 'For lines matching pattern, print field 2.' },
    { front: 'sed without -i', back: 'Prints the edited text and leaves the file unchanged. Safe for testing.' },
    { front: "sed -i 's/a/b/g'", back: 'Replace every a with b and save the file.' },
    { front: 'Escaping a dot', back: '\\. matches a real dot. A plain . matches any character.' },
  ],
  labs: [
    {
      id: 'F6-text',
      title: 'Reshape a server list',
      intro: 'servers.txt holds name, IP, OS and environment for each server. Turn it into the reports your team asked for.',
      tasks: [
        {
          text: 'Show how many servers there are per OS, using sort and uniq -c.',
          hint: "awk '{ print $3 }' servers.txt | sort | uniq -c",
          check: (sh) => ran(sh, /uniq\s+-c/),
        },
        {
          text: 'Save the server names in uppercase to ~/upper.txt.',
          hint: "awk '{ print $1 }' servers.txt | tr a-z A-Z > upper.txt",
          check: (sh) => (peek(sh, '/home/student/upper.txt')?.content ?? '').startsWith('WEB01\n'),
        },
        {
          text: 'Save only the IP addresses of the test servers to ~/test-ips.txt.',
          hint: "grep test servers.txt | awk '{ print $2 }' > test-ips.txt",
          check: (sh) => (peek(sh, '/home/student/test-ips.txt')?.content ?? '') === '192.168.4.30\n192.168.4.12\n',
        },
        {
          text: 'Show servers.txt with "production" replaced by "prod", without changing the file.',
          hint: "sed 's/production/prod/' servers.txt",
          check: (sh) => ran(sh, /^sed\s+(?!.*-i).*production/) && (peek(sh, '/home/student/servers.txt')?.content ?? '').includes('production'),
        },
      ],
    },
  ],
};

export const F7: Module = {
  id: 'F7',
  track: 'fundamentals',
  title: 'Connecting to a server',
  courseRef: 'Linux Fundamentals, Lesson 7',
  summary: 'Local consoles and terminals, logging in remotely with ssh, and copying files with scp.',
  quiz: [
    {
      q: 'Which command logs you in to server2 as user anna?',
      choices: ['ssh anna@server2', 'ssh server2@anna', 'login anna server2', 'telnet anna server2'],
      answer: 0,
      why: 'ssh user@host. Without a user name, ssh uses the name you are logged in with locally.',
    },
    {
      q: 'Which TCP port does SSH use by default?',
      choices: ['21', '22', '23', '80'],
      answer: 1,
      why: 'SSH listens on port 22. Use ssh -p to connect to a different port.',
    },
    {
      q: 'The first time you connect to a server, ssh asks you to confirm its fingerprint. Why?',
      choices: ['To check your password', 'So you can confirm you are talking to the real server, which ssh then remembers', 'To install software', 'It is an error'],
      answer: 1,
      why: 'The server\'s key is saved in ~/.ssh/known_hosts. If it changes later, ssh warns you, because someone may be pretending to be that server.',
    },
    {
      q: 'Which command copies report.txt to /tmp on server2?',
      choices: ['scp report.txt server2:/tmp/', 'cp report.txt server2:/tmp', 'ssh report.txt server2', 'scp server2 report.txt'],
      answer: 0,
      why: 'scp works like cp, with host: in front of the remote path. Add -r to copy a directory.',
    },
    {
      q: 'Which command creates an SSH key pair for passwordless login?',
      choices: ['ssh-keygen', 'ssh-copy-id', 'passwd -k', 'sshd -k'],
      answer: 0,
      why: 'ssh-keygen creates the key pair in ~/.ssh. ssh-copy-id then copies the public key to the server.',
    },
    {
      q: 'Which file must NEVER be shared with anyone?',
      choices: ['~/.ssh/id_ed25519.pub', '~/.ssh/id_ed25519', '~/.ssh/known_hosts', '/etc/ssh/ssh_config'],
      answer: 1,
      why: 'The file without .pub is your private key. The .pub file is meant to be copied to servers.',
    },
    {
      q: 'How do you leave an SSH session?',
      choices: ['exit (or Ctrl+D)', 'Ctrl+C', 'quit ssh', 'Close the server'],
      answer: 0,
      why: 'exit ends the remote shell and you return to your local one.',
    },
  ],
  cards: [
    { front: 'ssh user@host', back: 'Log in to a remote server.' },
    { front: 'ssh -p 2022 host', back: 'Connect to SSH on a non-standard port.' },
    { front: 'Port 22', back: 'Default SSH port.' },
    { front: 'scp file host:/path', back: 'Copy a file to a server. scp host:/path/file . copies back. -r for directories.' },
    { front: 'ssh-keygen', back: 'Create a key pair: private key (keep secret) and .pub public key.' },
    { front: 'ssh-copy-id user@host', back: 'Install your public key on the server for key-based login.' },
    { front: '~/.ssh/known_hosts', back: 'Fingerprints of servers you have connected to.' },
    { front: '~/.ssh/authorized_keys', back: 'On the server: public keys that may log in to this account.' },
    { front: 'Console vs SSH', back: 'Console = screen and keyboard attached to the machine. SSH = remote text login over the network.' },
    { front: 'sftp host', back: 'Interactive file transfer over SSH: put, get, ls, cd.' },
  ],
  labs: [],
};

export const F8: Module = {
  id: 'F8',
  track: 'fundamentals',
  title: 'The Bash shell',
  courseRef: 'Linux Fundamentals, Lesson 8',
  summary: 'Variables, redirection, pipes, history, and the files that set up your shell.',
  quiz: [
    {
      q: 'What is the difference between COLOR=blue and export COLOR=blue?',
      choices: ['None', 'export makes the variable available to programs started from this shell', 'export saves it permanently', 'export makes it read-only'],
      answer: 1,
      why: 'A plain variable stays in the current shell. export passes it on to child processes. Neither survives logging out unless you put it in a startup file.',
    },
    {
      q: 'Where do you put an alias so it is there every time you open a shell?',
      choices: ['/tmp/aliases', '~/.bashrc', '/etc/hostname', 'It cannot be saved'],
      answer: 1,
      why: '~/.bashrc runs for every new interactive shell, so aliases and variables there are always set.',
    },
    {
      q: 'What does the pipe in "ps aux | grep sshd" do?',
      choices: ['Runs both at the same time with no connection', 'Sends the output of ps into grep', 'Saves ps output to a file called grep', 'Runs grep first'],
      answer: 1,
      why: 'The pipe connects STDOUT of the first command to STDIN of the second.',
    },
    {
      q: 'Which variable holds the list of directories bash searches for commands?',
      choices: ['$HOME', '$PATH', '$SHELL', '$PWD'],
      answer: 1,
      why: '$PATH is a colon-separated list. A program outside these directories must be run with its full path, like ./script.sh.',
    },
    {
      q: 'What does "!!" do?',
      choices: ['Runs the previous command again', 'Logs out', 'Clears the screen', 'Shows an error'],
      answer: 0,
      why: '!! repeats the last command. "sudo !!" is a handy way to rerun it with sudo.',
    },
    {
      q: 'What does "cmd1 && cmd2" mean?',
      choices: ['Run cmd2 only if cmd1 succeeded', 'Run both at the same time', 'Run cmd2 only if cmd1 failed', 'Pipe cmd1 into cmd2'],
      answer: 0,
      why: '&& continues only on success (exit status 0). || runs the next command only on failure.',
    },
    {
      q: 'How do you see the exit status of the last command?',
      choices: ['echo $?', 'echo $!', 'status', 'exit'],
      answer: 0,
      why: '0 means success, anything else means some kind of failure.',
    },
  ],
  cards: [
    { front: 'VAR=value / $VAR', back: 'Set a variable (no spaces around =) / use its value.' },
    { front: 'export VAR', back: 'Pass a variable on to child processes.' },
    { front: 'env', back: 'Show all exported environment variables.' },
    { front: '$PATH', back: 'Directories searched for commands, separated by colons.' },
    { front: '~/.bashrc', back: 'Your personal shell settings: aliases, variables, prompt.' },
    { front: 'alias ll="ls -l"', back: 'Create a shortcut command. unalias removes it.' },
    { front: '!! and !n', back: 'Rerun the last command / rerun command number n from history.' },
    { front: '&& and ||', back: '&& = only if the previous command succeeded. || = only if it failed.' },
    { front: '; (semicolon)', back: 'Run commands one after another, whatever the result.' },
    { front: '$?', back: 'Exit status of the last command. 0 = success.' },
    { front: 'Ctrl+A / Ctrl+E', back: 'Jump to the start / end of the command line.' },
  ],
  labs: [
    {
      id: 'F8-shell',
      title: 'Make the shell work for you',
      intro: 'Practise variables, command chaining and checking results.',
      tasks: [
        {
          text: 'Create a variable COURSE with the value rhcsa and export it.',
          hint: 'export COURSE=rhcsa',
          check: (sh) => sh.env.COURSE === 'rhcsa',
        },
        { text: 'Print a sentence that uses the variable, like: I am studying rhcsa', hint: 'echo "I am studying $COURSE"', check: (sh) => ran(sh, /echo.*\$\{?COURSE/) },
        {
          text: 'In one line, create ~/reports and, only if that worked, create an empty file ~/reports/today.txt.',
          hint: 'mkdir ~/reports && touch ~/reports/today.txt',
          check: (sh) => ran(sh, /mkdir.*&&\s*touch/) && peek(sh, '/home/student/reports/today.txt')?.type === 'file',
        },
        {
          text: 'Try to list /root (it will fail), then show the exit status of that command.',
          hint: 'ls /root ; echo $?',
          check: (sh) => ran(sh, /echo\s+\$\?/) && ran(sh, /ls.*\/root/),
        },
      ],
    },
  ],
};

export const F9: Module = {
  id: 'F9',
  track: 'fundamentals',
  title: 'Users and groups',
  courseRef: 'Linux Fundamentals, Lesson 9',
  summary: 'What user accounts and groups are, where they are stored, and how to manage them.',
  quiz: [
    {
      q: 'Why does Linux have user accounts for services like apache that nobody logs in with?',
      choices: ['They are leftovers', 'So each service runs with only the permissions it needs', 'For billing', 'To store passwords'],
      answer: 1,
      why: 'Running a service as its own limited user means a bug in it cannot touch the rest of the system.',
    },
    {
      q: 'What is the UID of root?',
      choices: ['0', '1', '1000', '65534'],
      answer: 0,
      why: 'UID 0 is what makes an account root. The name is just a label.',
    },
    {
      q: 'Which file lists all groups and their members?',
      choices: ['/etc/passwd', '/etc/group', '/etc/members', '/etc/shadow'],
      answer: 1,
      why: 'Each line in /etc/group is name:x:GID:member1,member2.',
    },
    {
      q: 'Which command shows which groups the user anna belongs to?',
      choices: ['id anna', 'who anna', 'group anna', 'ls anna'],
      answer: 0,
      why: 'id shows the UID, primary group and all groups. groups anna shows just the group names.',
    },
    {
      q: 'Which command creates a new user called bob?',
      choices: ['useradd bob', 'adduser --create bob', 'newuser bob', 'mkuser bob'],
      answer: 0,
      why: 'useradd creates the account and, on RHEL, also the home directory and a private group called bob.',
    },
    {
      q: 'After creating bob, why can\'t he log in yet?',
      choices: ['He has no password set yet', 'He has no home directory', 'He is not in wheel', 'The server must reboot'],
      answer: 0,
      why: 'New accounts are locked until you set a password with passwd bob.',
    },
    {
      q: 'Which command adds bob to the group "developers" without removing his other groups?',
      choices: ['usermod -aG developers bob', 'usermod -G developers bob', 'groupadd developers bob', 'chgrp developers bob'],
      answer: 0,
      why: '-a (append) is important. Without it, bob is removed from every group not listed.',
    },
  ],
  cards: [
    { front: 'UID 0', back: 'root, the all-powerful administrator.' },
    { front: 'System vs normal users', back: 'System accounts (UID below 1000) run services. Normal users start at UID 1000.' },
    { front: '/etc/passwd', back: 'One line per account: name, UID, GID, comment, home directory, shell.' },
    { front: '/etc/group', back: 'One line per group, with its members.' },
    { front: 'id user', back: 'Show UID, primary group and all groups.' },
    { front: 'useradd / passwd', back: 'Create an account / set its password.' },
    { front: 'usermod -aG group user', back: 'Add a user to an extra group.' },
    { front: 'userdel -r user', back: 'Delete an account and its home directory.' },
    { front: 'groupadd name', back: 'Create a group.' },
    { front: 'Private group', back: 'On RHEL every user gets a group with the same name as the user.' },
  ],
  labs: [
    {
      id: 'F9-users',
      title: 'Add a colleague',
      intro: 'A new colleague, bob, starts today. Set up his account. You will need sudo.',
      tasks: [
        { text: 'Create the user bob.', hint: 'sudo useradd bob', check: (sh) => !!userByName(sh, 'bob') },
        { text: 'Give bob a password.', hint: 'sudo passwd bob', check: (sh) => !!userByName(sh, 'bob')?.password },
        { text: 'Create a group called developers.', hint: 'sudo groupadd developers', check: (sh) => !!groupByName(sh, 'developers') },
        { text: 'Add bob to developers.', hint: 'sudo usermod -aG developers bob', check: (sh) => inGroup(sh, 'bob', 'developers') },
        { text: 'Find bob\'s line in /etc/passwd.', hint: 'grep bob /etc/passwd', check: (sh) => ran(sh, /grep.*bob.*\/etc\/passwd/) },
      ],
    },
  ],
};

export const F10: Module = {
  id: 'F10',
  track: 'fundamentals',
  title: 'Permissions',
  courseRef: 'Linux Fundamentals, Lesson 10',
  summary: 'File ownership, read/write/execute, and changing permissions with chmod and chown.',
  quiz: [
    {
      q: 'In -rw-r--r--, what can the group do?',
      choices: ['Read and write', 'Read only', 'Nothing', 'Everything'],
      answer: 1,
      why: 'After the type character come three sets: owner (rw-), group (r--), others (r--).',
    },
    {
      q: 'What number stands for read + write?',
      choices: ['3', '5', '6', '7'],
      answer: 2,
      why: 'read = 4, write = 2, execute = 1. 4 + 2 = 6.',
    },
    {
      q: 'Which command makes script.sh executable for its owner?',
      choices: ['chmod u+x script.sh', 'chmod +r script.sh', 'chown x script.sh', 'exec script.sh'],
      answer: 0,
      why: 'u = user (owner), + adds, x = execute.',
    },
    {
      q: 'You want notes.txt readable and writable only by you. Which command?',
      choices: ['chmod 600 notes.txt', 'chmod 644 notes.txt', 'chmod 777 notes.txt', 'chmod 006 notes.txt'],
      answer: 0,
      why: '6 (rw) for the owner, 0 for the group and 0 for others.',
    },
    {
      q: 'Who can change the owner of a file?',
      choices: ['Anyone', 'The current owner', 'Only root', 'Members of the group'],
      answer: 2,
      why: 'Only root can give a file away to another user. Owners can change the group to one they belong to.',
    },
    {
      q: 'Why is chmod 777 almost always a bad idea?',
      choices: ['It is slow', 'Everyone on the system can change or delete the file', 'It hides the file', 'It is not valid'],
      answer: 1,
      why: 'It gives every user full access. Grant only what is needed.',
    },
  ],
  cards: [
    { front: 'Reading -rwxr-x---', back: 'Owner rwx, group r-x, others nothing.' },
    { front: 'r=4 w=2 x=1', back: 'Add them up per set: 7 = rwx, 6 = rw-, 5 = r-x, 4 = r--.' },
    { front: 'chmod 755', back: 'rwxr-xr-x: typical for programs and directories.' },
    { front: 'chmod 644', back: 'rw-r--r--: typical for normal files.' },
    { front: 'chmod 600', back: 'rw-------: private files.' },
    { front: 'chmod u+x / g-w / o=', back: 'Add execute for owner / remove write for group / clear all for others.' },
    { front: 'chown user:group file', back: 'Change owner and group (root only for the owner part).' },
    { front: 'ls -l', back: 'Shows permissions, owner and group of each file.' },
  ],
  labs: [
    {
      id: 'F10-perms',
      title: 'Lock down your files',
      intro: 'Practise reading and changing permissions in your home directory.',
      tasks: [
        { text: 'Create a file ~/diary.txt.', hint: 'touch diary.txt', check: (sh) => peek(sh, '/home/student/diary.txt')?.type === 'file' },
        {
          text: 'Make diary.txt readable and writable by you only.',
          hint: 'chmod 600 diary.txt',
          check: (sh) => permBits(peek(sh, '/home/student/diary.txt')) === 0o600,
        },
        {
          text: 'Create a script ~/hello.sh that contains: echo hello',
          hint: 'echo "echo hello" > hello.sh',
          check: (sh) => (peek(sh, '/home/student/hello.sh')?.content ?? '').includes('echo hello'),
        },
        {
          text: 'Make hello.sh executable for you.',
          hint: 'chmod u+x hello.sh',
          check: (sh) => (permBits(peek(sh, '/home/student/hello.sh')) & 0o100) !== 0,
        },
        {
          text: 'As root, create /srv/shared.txt and give it to the user student and group wheel.',
          hint: 'sudo touch /srv/shared.txt && sudo chown student:wheel /srv/shared.txt',
          check: (sh) => {
            const n = peek(sh, '/srv/shared.txt');
            return ownerName(sh, n) === 'student' && groupOf(sh, n) === 'wheel';
          },
        },
      ],
    },
  ],
};

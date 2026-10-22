import type { CommandResult } from '@/shell/commands';
import { Shell } from '@/shell/shell';
import type { SystemState } from '@/shell/state';
import { Lab, peek, permBits, ran, userByName } from './types';

// Labs that write and run Bash scripts.
// Checks that grade a script run it the way an exam grader would: on a scratch copy of the
// server, in a fresh login, so the student's own system never changes because of a check.

const HOME = '/home/student';

/** The text of a regular file (links followed), or null. */
function fileText(sh: Shell, path: string): string | null {
  const n = peek(sh, path);
  return n?.type === 'file' ? (n.content ?? '') : null;
}
const lines = (text: string | null) => (text ?? '').split('\n').filter((l) => l !== '');
/** The owner of the file may execute it. */
function ownerCanRun(sh: Shell, path: string): boolean {
  const n = peek(sh, path);
  return n?.type === 'file' && (n.mode & 0o100) !== 0;
}
/** The first line starts Bash: #!/bin/bash, #!/usr/bin/bash or #!/usr/bin/env bash, maybe with options. */
const bashShebang = (text: string | null) => !!text && /^#! ?((\/usr)?\/bin\/bash|\/usr\/bin\/env bash)(\s|$)/.test(text);

/**
 * True if one of the commands typed (a line split at ;, &&, || and |) matches `re`.
 * Only the first line of a history entry counts, so the body of a here-document is not a command.
 */
const typed = (sh: Shell, re: RegExp) => sh.history.some((h) => h.split('\n')[0].split(/&&|\|\||[;|]/).some((c) => re.test(c.trim())));
/** The start of a command line that runs the script NAME from the home directory: ./NAME, ~/NAME, the full path, or bash NAME. */
const startScript = (name: string) => `(?:(?:\\./|~/|${HOME}/)${name}|(?:ba)?sh\\s+(?:\\./|~/|${HOME}/)?${name})`;

/**
 * Grade the script at `path` on a scratch copy of the server. `grade` gets a fresh login as student
 * on the copy and may run anything there. False when the file is missing or grading fails.
 */
function graded(sh: Shell, path: string, grade: (t: Shell) => boolean): boolean {
  if (fileText(sh, path) === null) return false;
  try {
    const copy: SystemState = JSON.parse(JSON.stringify(sh.state));
    return grade(new Shell(copy));
  } catch {
    return false;
  }
}
/** bash PATH ARGS on a scratch copy (only read permission is needed), as student or as root. */
function bash(t: Shell, path: string, args: string[], asRoot = false): CommandResult {
  const run = () => t.runScript(path, args, '');
  const root = t.state.users.find((u) => u.uid === 0);
  return asRoot && root ? t.asUser(root, run) : run();
}

/** Run setup commands as the student would type them, then forget them so they do not count as typed. */
function quietly(sh: Shell, cmds: string[]): void {
  for (const c of cmds) sh.run(c);
  sh.history.length = 0;
}

// ---------- R19-hello ----------

const HELLO = `${HOME}/hello.sh`;
const HELLO_BIN = `${HOME}/bin/hello`;

/** The greeting script: a Bash shebang, Hello, world without an argument and Hello, NAME with one. */
const greets = (sh: Shell, path: string) =>
  bashShebang(fileText(sh, path)) &&
  graded(sh, path, (t) => bash(t, path, []).stdout === 'Hello, world\n' && bash(t, path, ['anna']).stdout === 'Hello, anna\n');

// ---------- R19-users ----------

const USER_LIST = `${HOME}/newusers.txt`;
const MKUSERS = `${HOME}/mkusers.sh`;
const MKUSERS_LOG = `${HOME}/mkusers.log`;
const LISTED = ['lisa', 'marco', 'student', 'nina'];
const NEW_USERS = ['lisa', 'marco', 'nina'];

/**
 * mkusers.sh reads its list with while read, creates missing users, prints NAME exists or NAME created,
 * and prints created only when useradd worked. The grader uses a list of its own, so a script that
 * ignores $1 and always reads newusers.txt fails.
 */
function mkusersWorks(sh: Shell): boolean {
  const src = fileText(sh, MKUSERS);
  if (!bashShebang(src) || !/\bwhile\s+(IFS=\S*\s+)?read\b/.test(src ?? '')) return false;
  return graded(sh, MKUSERS, (t) => {
    const list = '/tmp/grader-list.txt';
    t.writeFile(list, 'oscar\nstudent\npia\n');
    const asStudent = bash(t, MKUSERS, [list]); // useradd fails: nothing may be reported as created
    if (asStudent.stdout !== 'student exists\n' || userByName(t, 'oscar')) return false;
    const first = bash(t, MKUSERS, [list], true);
    const again = bash(t, MKUSERS, [list], true);
    return (
      first.stdout === 'oscar created\nstudent exists\npia created\n' &&
      !!userByName(t, 'oscar') &&
      !!userByName(t, 'pia') &&
      again.stdout === 'oscar exists\nstudent exists\npia exists\n'
    );
  });
}
const usersCreated = (sh: Shell) => NEW_USERS.every((u) => !!userByName(sh, u));

// ---------- R19-svccheck ----------

const SVC_SRC = `${HOME}/svccheck.sh`;
const SVC_BIN = '/usr/local/bin/svccheck';

/** On the grader's copy: sshd runs and atd does not, whatever the student did to them. */
function setScene(t: Shell): void {
  const { sshd, atd } = t.state.services;
  if (sshd) sshd.active = true;
  if (atd) atd.active = false;
}
/** No arguments: only a usage message on standard error and exit status 1. One service: no usage message and status 0. */
function usageOk(t: Shell, path: string): boolean {
  const none = bash(t, path, []);
  const one = bash(t, path, ['sshd']);
  return none.code === 1 && none.stdout === '' && /^Usage: /m.test(none.stderr) && one.code === 0 && !/Usage:/.test(one.stdout + one.stderr);
}
/** The first part of svccheck: shebang and the usage test. */
function usagePartWorks(sh: Shell, path: string): boolean {
  return (
    bashShebang(fileText(sh, path)) &&
    graded(sh, path, (t) => {
      setScene(t);
      return usageOk(t, path);
    })
  );
}
/**
 * The whole svccheck: the usage test, SERVICE is STATE from $(systemctl is-active ...), and a start of
 * every service that is not active, with SERVICE started only when the start worked (as root).
 */
function svccheckWorks(sh: Shell, path: string): boolean {
  const src = fileText(sh, path);
  if (!bashShebang(src) || !/(\$\(|`)\s*systemctl\s+is-active\b/.test(src ?? '')) return false;
  return graded(sh, path, (t) => {
    setScene(t);
    if (!usageOk(t, path)) return false;
    if (bash(t, path, ['sshd', 'atd']).stdout !== 'sshd is active\natd is inactive\n') return false; // student may not start atd
    const asRoot = bash(t, path, ['sshd', 'atd'], true);
    return asRoot.stdout === 'sshd is active\natd is inactive\natd started\n' && !!t.state.services.atd?.active;
  });
}

export const R19_LABS: Lab[] = [
  {
    id: 'R19-hello',
    title: 'Your first Bash script',
    intro:
      "A Bash script is a text file with commands that Bash runs from top to bottom. Its first line, #!/bin/bash (the shebang), tells Linux which program runs the file. To write a short file without an editor, use a here-document: cat > FILE <<'EOF' starts it, you type the lines, and a line with only EOF ends it. The quotes around 'EOF' keep $1 as it is, so it ends up in the file instead of being replaced by your shell. Inside a script, $1 is the first argument, and ${1:-world} means $1, or world when there is no first argument. A new file is not executable, so give it the x permission before you run it as ./NAME.",
    tasks: [
      {
        text: 'Create /home/student/hello.sh with a here-document. Line 1 is the shebang #!/bin/bash. Line 2 is an echo that prints Hello, anna when the script gets the argument anna, and Hello, world when it gets no argument.',
        hint: ["cat > ~/hello.sh <<'EOF'", '#!/bin/bash', 'echo "Hello, ${1:-world}"', 'EOF'].join('\n'),
        check: (sh) => greets(sh, HELLO),
      },
      {
        text: 'Try to run the script as ./hello.sh. Bash refuses with Permission denied, because a new file does not have the execute permission.',
        hint: './hello.sh',
        check: (sh) => typed(sh, new RegExp(`^${startScript('hello\\.sh')}(\\s|$)`)),
      },
      {
        text: 'Give the owner of hello.sh the execute permission.',
        hint: 'chmod u+x ~/hello.sh  (ls -l ~/hello.sh now starts with -rwx)',
        check: (sh) => ownerCanRun(sh, HELLO),
      },
      {
        text: 'Run the script with the argument anna. It prints Hello, anna.',
        hint: './hello.sh anna',
        check: (sh) => ownerCanRun(sh, HELLO) && typed(sh, new RegExp(`^${startScript('hello\\.sh')}\\s+(anna|"anna"|'anna')$`)),
      },
      {
        text: 'Run it again without an argument, and save what it prints in /home/student/greeting.txt.',
        hint: './hello.sh > ~/greeting.txt  (cat ~/greeting.txt shows Hello, world)',
        check: (sh) => fileText(sh, `${HOME}/greeting.txt`) === 'Hello, world\n',
      },
      {
        text: 'Your own scripts can live in ~/bin, which is in your $PATH. Create the directory /home/student/bin and move hello.sh into it with the new name hello.',
        hint: 'mkdir -p ~/bin && mv ~/hello.sh ~/bin/hello',
        check: (sh) => !peek(sh, HELLO) && ownerCanRun(sh, HELLO_BIN) && greets(sh, HELLO_BIN),
      },
      {
        text: 'Go to /tmp and run the script by name with the argument student. Bash finds it because it searches every directory in $PATH.',
        hint: 'cd /tmp && hello student  (type hello shows where Bash found it)',
        check: (sh) => ownerCanRun(sh, HELLO_BIN) && typed(sh, /^hello(\s|$)/),
      },
    ],
  },
  {
    id: 'R19-users',
    title: 'Create users from a list',
    intro:
      'HR sent the user names of new colleagues in /home/student/newusers.txt, one name per line. Write a script that creates them all and can safely run again. A while read loop reads a file one line at a time: while read -r name; do ...; done < FILE. if runs a command and looks at its exit status: 0 means success (true), anything else means false. So if id NAME &>/dev/null asks whether a user exists, without printing anything, and useradd NAME && echo done prints done only when useradd worked. [ ... ] is a command too, called test: [ -d DIR ] is true when DIR is a directory. A script runs with the rights of the user who starts it, so a script that adds users must run as root.',
    setup: (sh) => sh.writeFile(USER_LIST, `${LISTED.join('\n')}\n`),
    tasks: [
      {
        text: 'Show the names in /home/student/newusers.txt. student is on the list, and that account exists already.',
        hint: 'cat ~/newusers.txt',
        check: (sh) => typed(sh, /^(cat|less|more|head|tail)\b.*newusers\.txt/),
      },
      {
        text: 'Every command ends with an exit status, and $? holds the status of the last one. Run id lisa, then echo $?. The status is 1, because lisa does not exist yet.',
        hint: 'id lisa; echo $?',
        check: (sh) => typed(sh, /^id\s+lisa\b/),
      },
      {
        text: 'Write /home/student/mkusers.sh. It reads the file named in its first argument with a while read loop. For a name that exists already, it prints NAME exists. Otherwise it runs useradd NAME and, only if that worked, prints NAME created.',
        hint: [
          "cat > ~/mkusers.sh <<'EOF'",
          '#!/bin/bash',
          'while read -r name; do',
          '  if id "$name" &>/dev/null; then',
          '    echo "$name exists"',
          '  else',
          '    useradd "$name" && echo "$name created"',
          '  fi',
          'done < "$1"',
          'EOF',
        ].join('\n'),
        check: mkusersWorks,
      },
      {
        text: 'Give the owner of mkusers.sh the execute permission.',
        hint: 'chmod u+x ~/mkusers.sh',
        check: (sh) => ownerCanRun(sh, MKUSERS),
      },
      {
        text: 'Run ./mkusers.sh newusers.txt as student. The script runs with your rights, so every useradd fails with Permission denied and the script prints only student exists.',
        hint: './mkusers.sh newusers.txt',
        check: (sh) => typed(sh, new RegExp(`^${startScript('mkusers\\.sh')}\\s+\\S*newusers\\.txt$`)),
      },
      {
        text: 'Run it again with sudo, so that it runs as root, and save its output in /home/student/mkusers.log.',
        hint: 'sudo ./mkusers.sh newusers.txt > ~/mkusers.log  (your own shell handles the >, so the log belongs to student)',
        check: (sh) => {
          const log = lines(fileText(sh, MKUSERS_LOG));
          return usersCreated(sh) && LISTED.every((u) => log.includes(`${u} created`) || log.includes(`${u} exists`));
        },
      },
      {
        text: 'Run it a third time with sudo and add its output to the end of mkusers.log. Thanks to the if, nobody is created twice: every name now prints NAME exists.',
        hint: 'sudo ./mkusers.sh newusers.txt >> ~/mkusers.log',
        check: (sh) => {
          const log = lines(fileText(sh, MKUSERS_LOG));
          return usersCreated(sh) && log.length > LISTED.length && log.slice(-LISTED.length).join('\n') === LISTED.map((u) => `${u} exists`).join('\n');
        },
      },
      {
        text: 'Check the new home directories with a for loop at the prompt: for lisa, marco and nina, print NAME: home OK when [ -d /home/NAME ] is true.',
        hint: 'for u in lisa marco nina; do [ -d /home/$u ] && echo "$u: home OK"; done',
        check: (sh) => usersCreated(sh) && ran(sh, /^for\s.*\bdo\b.*(\[\[?|\btest)\s+-d\s/), // a loop is one history entry
      },
    ],
  },
  {
    id: 'R19-svccheck',
    title: 'A service check script with exit codes',
    intro:
      'Someone stopped the atd service on server1. Write the script svccheck: it reports the state of the services you name and starts the ones that are not active. Install it in /usr/local/bin, so every user can run it by name. $(command) is replaced by the output of the command, as in state=$(systemctl is-active sshd). "$@" is the list of all arguments and $# is how many there are. exit N ends a script with exit status N, which the caller sees in $?. A good script that is called the wrong way prints a usage message to standard error (echo ... >&2) and exits with a status other than 0. Build the script in two steps: cat > creates the file, and cat >> adds more lines to the end.',
    setup: (sh) => quietly(sh, ['sudo systemctl stop atd', 'sudo mkdir -p /usr/local/bin']),
    tasks: [
      {
        text: 'Show whether atd is active, then the exit status of that check. inactive comes with status 3, while active would give 0.',
        hint: 'systemctl is-active atd; echo $?',
        check: (sh) => typed(sh, /^systemctl\s+is-active\s+(\S+\s+)*atd(\.service)?(\s|$)/),
      },
      {
        text: 'Start /home/student/svccheck.sh with a here-document: the shebang, and an if that prints Usage: svccheck SERVICE... to standard error and exits with status 1 when the script gets no arguments.',
        hint: [
          "cat > ~/svccheck.sh <<'EOF'",
          '#!/bin/bash',
          'if [ $# -eq 0 ]; then',
          '  echo "Usage: svccheck SERVICE..." >&2',
          '  exit 1',
          'fi',
          'EOF',
        ].join('\n'),
        check: (sh) => usagePartWorks(sh, SVC_SRC),
      },
      {
        text: 'Make svccheck.sh executable, run it without arguments, and show its exit status.',
        hint: 'chmod +x ~/svccheck.sh; ./svccheck.sh; echo $?',
        check: (sh) => ownerCanRun(sh, SVC_SRC) && typed(sh, new RegExp(`^${startScript('svccheck\\.sh')}(\\s+[0-9&]?>.*)?$`)),
      },
      {
        text: 'Add the main part with cat >>: a for loop over "$@" that stores the output of systemctl is-active SERVICE in the variable state and prints SERVICE is STATE. When the state is not active, it runs systemctl start SERVICE and, only if that worked, prints SERVICE started.',
        hint: [
          "cat >> ~/svccheck.sh <<'EOF'",
          'for svc in "$@"; do',
          '  state=$(systemctl is-active "$svc")',
          '  echo "$svc is $state"',
          '  if [ "$state" != active ]; then',
          '    systemctl start "$svc" && echo "$svc started"',
          '  fi',
          'done',
          'EOF',
        ].join('\n'),
        check: (sh) => svccheckWorks(sh, SVC_SRC),
      },
      {
        text: 'Install the script for all users as /usr/local/bin/svccheck, owned by root with mode 755.',
        hint: 'sudo cp ~/svccheck.sh /usr/local/bin/svccheck && sudo chmod 755 /usr/local/bin/svccheck',
        check: (sh) => {
          const n = peek(sh, SVC_BIN);
          return n?.type === 'file' && n.uid === 0 && permBits(n) === 0o755 && svccheckWorks(sh, SVC_BIN);
        },
      },
      {
        text: 'Starting a service needs root rights. Run the installed script with sudo for sshd and atd. sudo uses its own PATH from secure_path in /etc/sudoers, which may not include /usr/local/bin, so give the full path.',
        hint: 'sudo /usr/local/bin/svccheck sshd atd  (it prints atd is inactive, then atd started)',
        check: (sh) => !!sh.state.services.atd?.active && typed(sh, /^sudo\s+(\/usr\/local\/bin\/)?svccheck\s+(\S+\s+)*atd(\s|$)/),
      },
      {
        text: 'As student, run svccheck by name for sshd and atd, and save its output in /home/student/svccheck.txt. Both services are active now.',
        hint: 'svccheck sshd atd > ~/svccheck.txt',
        check: (sh) => fileText(sh, `${HOME}/svccheck.txt`) === 'sshd is active\natd is active\n',
      },
    ],
  },
];

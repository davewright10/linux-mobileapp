import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProgram } from '../shell/parser';
import { Shell } from '../shell/shell';
import { MODULES, getLab } from './index';
import { R19_LABS } from './labs-script';
import type { Lab } from './types';
import { peek, permBits, userByName } from './types';

const out = (sh: Shell, line: string) => sh.run(line).output;
/** The part of a hint that is typed: text after two spaces and "(" is an explanation. */
const cmdOf = (hint: string) => hint.split(/\s{2,}\(/)[0];
/** Type a hint line by line, as in the terminal, and collect what it prints. */
const typeHint = (sh: Shell, hint: string) =>
  cmdOf(hint)
    .split('\n')
    .map((l) => out(sh, l))
    .join('');
const lab = (id: string) => {
  const l = R19_LABS.find((x) => x.id === id);
  assert.ok(l, id);
  return l;
};
/** A fresh server with the lab's setup done. */
function start(id: string): { sh: Shell; l: Lab } {
  const sh = new Shell();
  const l = lab(id);
  l.setup?.(sh);
  return { sh, l };
}
/** Type the hints of tasks [from, to) in order and return what each printed. */
const solve = (sh: Shell, l: Lab, from: number, to: number) => l.tasks.slice(from, to).map((t) => typeHint(sh, t.hint));
/** Check of task n (1-based). */
const done = (sh: Shell, l: Lab, n: number) => l.tasks[n - 1].check(sh);
const passed = (sh: Shell, l: Lab) => l.tasks.map((t) => t.check(sh));
const text = (sh: Shell, path: string) => peek(sh, path)?.content;
/** Write a file as student and set its mode, as a learner would with an editor and chmod. */
function put(sh: Shell, path: string, body: string, mode = '755') {
  sh.writeFile(path, body);
  out(sh, `chmod ${mode} ${path}`);
}

test('R19 has three scripting labs with unique ids', () => {
  assert.equal(R19_LABS.length, 3);
  assert.deepEqual(
    R19_LABS.map((l) => l.id),
    ['R19-hello', 'R19-users', 'R19-svccheck'],
  );
  for (const l of R19_LABS) assert.equal(getLab(l.id)?.module.id, 'R19', `${l.id} is listed in R19`);
  const ids = MODULES.flatMap((m) => m.labs.map((x) => x.id));
  assert.equal(new Set(ids).size, ids.length, 'lab ids are unique across the app');
});

test('lab texts are plain, and script hints are short enough to type on a phone', () => {
  for (const l of R19_LABS) {
    assert.ok(l.intro.length > 200, `${l.id} explains the ideas it needs`);
    assert.ok(l.tasks.length >= 7, `${l.id} has enough tasks`);
    for (const s of [l.title, l.intro, ...l.tasks.flatMap((t) => [t.text, t.hint])]) {
      assert.doesNotMatch(s, /[–—]/, `no dashes in "${s}"`);
      assert.doesNotMatch(s, /[ \t]$/m, `no trailing spaces in "${s}"`);
      assert.doesNotMatch(s, /^\s/, `no leading space in "${s}"`);
    }
    for (const t of l.tasks) {
      assert.match(t.text, /\.$/, t.text);
      const typedPart = cmdOf(t.hint);
      if (typedPart.includes('\n')) {
        // a here-document: an explanation would be typed into the file, so there must be none
        assert.equal(typedPart, t.hint, `no explanation after a multi-line hint: ${t.hint}`);
        assert.match(typedPart, /^cat >>? ~\/\S+ <<'EOF'\n[^]*\nEOF$/, 'a quoted here-document');
        for (const line of typedPart.split('\n')) assert.ok(line.length <= 50, `short line: "${line}"`);
      }
      // student is not root: commands that need root go through sudo
      for (const c of typedPart.split('\n')[0].split(/&&|;|\|/).map((x) => x.trim())) {
        assert.doesNotMatch(c, /^(useradd|systemctl (start|stop)|cp \S+ \/usr|chmod \S+ \/usr|mkdir \S* ?\/usr)/, `${l.id}: needs sudo: ${c}`);
      }
    }
  }
});

test('setups leave no history, no task passes at the start, and checks never throw', () => {
  for (const l of R19_LABS) {
    const { sh } = start(l.id);
    assert.deepEqual(sh.history, [], l.id);
    assert.equal(sh.user.name, 'student', l.id);
    assert.equal(sh.cwd, '/home/student', l.id);
    assert.deepEqual(passed(sh, l), l.tasks.map(() => false), l.id);
    // the app calls every check after every command, also on a system without the setup
    const bare = new Shell();
    for (const t of l.tasks) assert.doesNotThrow(() => t.check(bare), `${l.id}: ${t.text}`);
  }
});

test('tasks pass one by one from their hints, and checks never change the system', () => {
  for (const l of R19_LABS) {
    const { sh } = start(l.id);
    l.tasks.forEach((t, i) => {
      const before = JSON.stringify(sh.state);
      const history = [...sh.history];
      assert.equal(t.check(sh), false, `${l.id} task ${i + 1} passes too early`);
      for (const other of l.tasks) other.check(sh);
      assert.equal(JSON.stringify(sh.state), before, `${l.id}: checks before task ${i + 1} changed the system`);
      assert.deepEqual(sh.history, history, `${l.id}: checks before task ${i + 1} changed the history`);
      const o = typeHint(sh, t.hint);
      assert.doesNotMatch(o, /command not found|syntax error|not simulated|practice terminal limit/, `${l.id} task ${i + 1}: ${o}`);
      assert.equal(sh.prompt().endsWith('> '), false, `${l.id} task ${i + 1} left the shell waiting for more input`);
      assert.ok(t.check(sh), `${l.id} task ${i + 1} not passed by its hint. Output:\n${o}`);
    });
    assert.equal(sh.user.name, 'student', `${l.id} ends as student`);
  }
});

test('the scripts the hints write are valid Bash and look as intended', () => {
  const files: Record<string, string> = {
    'R19-hello': '/home/student/bin/hello',
    'R19-users': '/home/student/mkusers.sh',
    'R19-svccheck': '/usr/local/bin/svccheck',
  };
  for (const l of R19_LABS) {
    const { sh } = start(l.id);
    solve(sh, l, 0, l.tasks.length);
    const body = text(sh, files[l.id]) ?? '';
    assert.match(body, /^#!\/bin\/bash\n/, l.id);
    assert.equal(parseProgram(body, true).error, null, `${l.id}: ${body}`);
    assert.equal(out(sh, `bash -n ${files[l.id]}; echo $?`), '0\n', l.id);
  }
  const { sh, l } = start('R19-svccheck');
  solve(sh, l, 0, 4);
  assert.equal(
    text(sh, '/home/student/svccheck.sh'),
    [
      '#!/bin/bash',
      'if [ $# -eq 0 ]; then',
      '  echo "Usage: svccheck SERVICE..." >&2',
      '  exit 1',
      'fi',
      'for svc in "$@"; do',
      '  state=$(systemctl is-active "$svc")',
      '  echo "$svc is $state"',
      '  if [ "$state" != active ]; then',
      '    systemctl start "$svc" && echo "$svc started"',
      '  fi',
      'done',
      '',
    ].join('\n'),
  );
});

// ---------- R19-hello ----------

test('R19-hello: what a beginner sees', () => {
  const { sh, l } = start('R19-hello');
  const o = solve(sh, l, 0, 7);
  assert.equal(o[0], '');
  assert.equal(text(sh, '/home/student/hello.sh') ?? text(sh, '/home/student/bin/hello'), '#!/bin/bash\necho "Hello, ${1:-world}"\n');
  assert.equal(o[1], '-bash: ./hello.sh: Permission denied\n');
  assert.equal(o[3], 'Hello, anna\n');
  assert.equal(o[4], '');
  assert.equal(text(sh, '/home/student/greeting.txt'), 'Hello, world\n');
  assert.equal(o[6], 'Hello, student\n');
  assert.equal(sh.cwd, '/tmp');
  assert.equal(out(sh, 'type hello'), 'hello is /home/student/bin/hello\n');
  // a later task moves the file, which the app does not count against earlier ones (they stay ticked)
  assert.equal(done(sh, l, 7), true);
});

test('R19-hello: the chmod hint explanation matches ls -l', () => {
  const { sh, l } = start('R19-hello');
  solve(sh, l, 0, 3);
  assert.match(out(sh, 'ls -l ~/hello.sh'), /^-rwx/);
});

test('R19-hello: the script itself is graded, not the way it was written', () => {
  const { l } = start('R19-hello');
  const attempt = (lines: string[]) => {
    const sh = new Shell();
    for (const line of lines) out(sh, line);
    return done(sh, l, 1);
  };
  // printf works as well as a here-document, and so does env bash
  assert.equal(attempt([`printf '#!/bin/bash\\necho "Hello, \${1:-world}"\\n' > ~/hello.sh`]), true);
  assert.equal(attempt(["cat > ~/hello.sh <<'EOF'", '#!/usr/bin/env bash', 'name=${1:-world}', 'echo "Hello, $name"', 'EOF']), true);
  assert.equal(attempt(["cat > ~/hello.sh <<'EOF'", '#!/bin/bash', 'if [ -n "$1" ]; then', '  echo "Hello, $1"', 'else', '  echo "Hello, world"', 'fi', 'EOF']), true);
  // without quotes around EOF the shell replaces ${1:-world} while typing, so the file always says world
  assert.equal(attempt(['cat > ~/hello.sh <<EOF', '#!/bin/bash', 'echo "Hello, ${1:-world}"', 'EOF']), false);
  assert.equal(attempt(["cat > ~/hello.sh <<'EOF'", '#!/bin/bash', 'echo "Hello, $1"', 'EOF']), false, 'no default');
  assert.equal(attempt(["cat > ~/hello.sh <<'EOF'", 'echo "Hello, ${1:-world}"', 'EOF']), false, 'no shebang');
  assert.equal(attempt(["cat > ~/hello.sh <<'EOF'", '#!/bin/sh', 'echo "Hello, ${1:-world}"', 'EOF']), false, 'the task asks for bash');
  assert.equal(attempt(["cat > ~/hello.sh <<'EOF'", '#!/bin/bash', 'echo "Hello ${1:-world}!"', 'EOF']), false, 'other text');
  assert.equal(attempt(['mkdir ~/hello.sh']), false, 'a directory');
});

test('R19-hello: running needs the x bit, and a copy is not a move', () => {
  const { sh, l } = start('R19-hello');
  solve(sh, l, 0, 2);
  out(sh, './hello.sh anna');
  assert.equal(done(sh, l, 4), false, 'not executable yet');
  out(sh, 'bash hello.sh anna');
  assert.equal(done(sh, l, 4), false);
  solve(sh, l, 2, 3);
  assert.equal(done(sh, l, 4), true, 'a run with anna and the x bit');
  out(sh, './hello.sh > ~/greeting.txt 2>&1');
  assert.equal(done(sh, l, 5), true);
  out(sh, 'mkdir -p ~/bin && cp ~/hello.sh ~/bin/hello');
  assert.equal(done(sh, l, 6), false, 'hello.sh is still in the home directory');
  out(sh, 'rm ~/hello.sh');
  assert.equal(done(sh, l, 6), true);
  out(sh, 'chmod u-x ~/bin/hello');
  assert.equal(done(sh, l, 6), false);
  assert.equal(out(sh, 'hello student'), 'bash: hello: command not found\n');
  assert.equal(done(sh, l, 7), false, 'the run failed');
  out(sh, 'chmod u+x ~/bin/hello');
  assert.equal(done(sh, l, 7), true);
});

test('R19-hello: other ways to type the commands count', () => {
  const { l } = start('R19-hello');
  const sh = new Shell();
  solve(sh, l, 0, 1);
  out(sh, 'cd ~ && ~/hello.sh 2>/dev/null');
  assert.equal(done(sh, l, 2), true);
  out(sh, 'chmod 755 hello.sh');
  assert.equal(done(sh, l, 3), true);
  out(sh, '/home/student/hello.sh "anna"');
  assert.equal(done(sh, l, 4), true);
  // a here-document body is not a command line
  const sh2 = new Shell();
  out(sh2, "cat > ~/notes.sh <<'EOF'");
  out(sh2, 'hello student');
  out(sh2, './hello.sh anna');
  out(sh2, 'EOF');
  assert.equal(done(sh2, l, 2), false);
  assert.equal(done(sh2, l, 7), false);
});

// ---------- R19-users ----------

test('R19-users: what a beginner sees', () => {
  const { sh, l } = start('R19-users');
  assert.equal(text(sh, '/home/student/newusers.txt'), 'lisa\nmarco\nstudent\nnina\n');
  assert.equal(peek(sh, '/home/student/newusers.txt')?.uid, 1000);
  const o = solve(sh, l, 0, 8);
  assert.equal(o[0], 'lisa\nmarco\nstudent\nnina\n');
  assert.equal(o[1], "id: 'lisa': no such user\n1\n");
  assert.equal(o[2], '');
  assert.equal(o[4].match(/useradd: Permission denied\./g)?.length, 3);
  assert.match(o[4], /^student exists$/m);
  assert.doesNotMatch(o[4], /created/);
  assert.equal(o[5], '');
  assert.equal(o[6], '');
  assert.equal(
    text(sh, '/home/student/mkusers.log'),
    'lisa created\nmarco created\nstudent exists\nnina created\nlisa exists\nmarco exists\nstudent exists\nnina exists\n',
  );
  assert.equal(peek(sh, '/home/student/mkusers.log')?.uid, 1000, 'the redirection is done by student');
  assert.equal(o[7], 'lisa: home OK\nmarco: home OK\nnina: home OK\n');
  assert.match(out(sh, 'tail -3 /etc/passwd'), /^lisa:x:1001:1001::\/home\/lisa:\/bin\/bash\nmarco:x:1002:.*\nnina:x:1003:/);
  assert.equal(out(sh, 'id -u student'), '1000\n');
});

test('R19-users: the grader runs mkusers.sh with a list of its own', () => {
  const { l } = start('R19-users');
  const write = (body: string[]) => {
    const { sh } = start('R19-users');
    put(sh, '/home/student/mkusers.sh', `${body.join('\n')}\n`, '644');
    return sh;
  };
  const good = ['#!/bin/bash', 'while read -r name; do', '  if id "$name" &>/dev/null; then', '    echo "$name exists"', '  else', '    useradd "$name" && echo "$name created"', '  fi', 'done < "$1"'];
  const sh = write(good);
  assert.equal(done(sh, l, 3), true, 'read permission is enough to grade it');
  assert.equal(done(sh, l, 4), false);
  // grading happened on a copy: nobody was created on the real system
  assert.equal(userByName(sh, 'oscar'), undefined);
  assert.equal(sh.exists('/tmp/grader-list.txt'), false);
  // other correct forms
  assert.equal(done(write(['#!/bin/bash', 'while IFS= read -r u; do', '  if grep -q "^$u:" /etc/passwd; then', '    echo "$u exists"', '  elif useradd "$u"; then', '    echo "$u created"', '  fi', 'done < $1']), l, 3), true);
  assert.equal(done(write(['#!/usr/bin/bash', 'file=$1', 'while read name', 'do', '  id $name &>/dev/null && echo "$name exists" && continue', '  useradd $name && echo "$name created"', 'done < "$file"']), l, 3), true);
  // wrong: a for loop where a while read loop was asked for
  assert.equal(done(write(['#!/bin/bash', 'for name in $(cat "$1"); do', '  if id "$name" &>/dev/null; then echo "$name exists"; else useradd "$name" && echo "$name created"; fi', 'done']), l, 3), false);
  // wrong: always reads newusers.txt instead of the file in $1
  assert.equal(done(write(good.map((x) => x.replace('"$1"', '/home/student/newusers.txt'))), l, 3), false);
  // wrong: says created even when useradd failed
  assert.equal(done(write(good.map((x) => x.replace('&&', ';'))), l, 3), false);
  // wrong: no test for existing users
  assert.equal(done(write(['#!/bin/bash', 'while read -r name; do', '  useradd "$name" && echo "$name created"', 'done < "$1"']), l, 3), false);
  // wrong: no shebang
  assert.equal(done(write(good.slice(1)), l, 3), false);
});

test('R19-users: the log checks allow a forgotten redirection, but not > for >>', () => {
  const { sh, l } = start('R19-users');
  solve(sh, l, 0, 5);
  assert.equal(done(sh, l, 6), false);
  out(sh, 'sudo ./mkusers.sh newusers.txt'); // output on the screen only
  assert.equal(done(sh, l, 6), false, 'no log yet');
  out(sh, 'sudo ./mkusers.sh newusers.txt > ~/mkusers.log');
  assert.equal(text(sh, '/home/student/mkusers.log'), 'lisa exists\nmarco exists\nstudent exists\nnina exists\n');
  assert.equal(done(sh, l, 6), true, 'the users exist and the log names them all');
  assert.equal(done(sh, l, 7), false);
  out(sh, 'sudo ./mkusers.sh newusers.txt > ~/mkusers.log');
  assert.equal(done(sh, l, 7), false, '> replaced the log');
  out(sh, 'sudo ./mkusers.sh newusers.txt >> ~/mkusers.log');
  assert.equal(done(sh, l, 7), true);
  // the loop task wants a test of the home directory, in a loop
  assert.equal(done(sh, l, 8), false);
  out(sh, 'ls -ld /home/lisa /home/marco /home/nina');
  assert.equal(done(sh, l, 8), false);
  out(sh, 'for u in lisa marco nina; do test -d /home/$u && echo "$u: home OK"; done');
  assert.equal(done(sh, l, 8), true);
});

test('R19-users: users made by hand do not pass the script tasks', () => {
  const { sh, l } = start('R19-users');
  out(sh, 'sudo useradd lisa; sudo useradd marco; sudo useradd nina');
  out(sh, 'echo "lisa created" > ~/mkusers.log');
  assert.equal(done(sh, l, 6), false, 'the log does not name everyone');
  assert.equal(done(sh, l, 3), false, 'there is no script');
});

// ---------- R19-svccheck ----------

test('R19-svccheck: the setup stops atd and provides /usr/local/bin', () => {
  const { sh } = start('R19-svccheck');
  assert.equal(sh.state.services.atd.active, false);
  assert.equal(sh.state.services.atd.enabled, true);
  assert.equal(sh.state.services.sshd.active, true);
  const bin = peek(sh, '/usr/local/bin');
  assert.equal(bin?.type, 'dir');
  assert.equal(bin?.uid, 0);
  assert.equal(permBits(bin), 0o755);
});

test('R19-svccheck: what a beginner sees', () => {
  const { sh, l } = start('R19-svccheck');
  const o = solve(sh, l, 0, 7);
  assert.equal(o[0], 'inactive\n3\n');
  assert.equal(o[1], '');
  assert.equal(o[2], 'Usage: svccheck SERVICE...\n1\n');
  assert.equal(o[3], '');
  assert.equal(o[4], '');
  assert.equal(o[5], 'sshd is active\natd is inactive\natd started\n');
  assert.equal(o[6], '');
  assert.equal(text(sh, '/home/student/svccheck.txt'), 'sshd is active\natd is active\n');
  assert.equal(sh.state.services.atd.active, true);
  // the usage message goes to standard error, so 2>/dev/null hides it
  assert.equal(out(sh, 'svccheck 2>/dev/null; echo $?'), '1\n');
  assert.equal(out(sh, 'svccheck sshd atd; echo $?'), 'sshd is active\natd is active\n0\n');
  assert.match(out(sh, 'ls -l /usr/local/bin/svccheck'), /^-rwxr-xr-x\. 1 root root /);
});

test('R19-svccheck: before the sudo run, the script cannot start atd as student', () => {
  const { sh, l } = start('R19-svccheck');
  solve(sh, l, 0, 5);
  const o = out(sh, 'svccheck sshd atd; echo $?');
  assert.match(o, /^sshd is active\natd is inactive\n/);
  assert.match(o, /Access denied/);
  assert.doesNotMatch(o, /atd started/);
  assert.match(o, /\n1\n$/);
  assert.equal(sh.state.services.atd.active, false);
  out(sh, 'svccheck sshd atd > ~/svccheck.txt 2>/dev/null');
  assert.equal(done(sh, l, 7), false, 'atd was not active yet');
  // starting atd by hand is not running the script
  out(sh, 'sudo systemctl start atd');
  assert.equal(done(sh, l, 6), false);
  out(sh, 'sudo systemctl stop atd');
  out(sh, 'sudo svccheck sshd atd'); // by name works in the practice terminal
  assert.equal(done(sh, l, 6), true);
  out(sh, 'svccheck sshd atd > ~/svccheck.txt');
  assert.equal(done(sh, l, 7), true);
});

test('R19-svccheck: the grader tests the usage part', () => {
  const { l } = start('R19-svccheck');
  const usage = (body: string[]) => {
    const { sh } = start('R19-svccheck');
    put(sh, '/home/student/svccheck.sh', `${body.join('\n')}\n`, '644');
    return done(sh, l, 2);
  };
  assert.equal(usage(['#!/bin/bash', 'if [ $# -eq 0 ]; then', '  echo "Usage: svccheck SERVICE..." >&2', '  exit 1', 'fi']), true);
  assert.equal(usage(['#!/bin/bash', '[ -z "$1" ] && { echo "Usage: svccheck SERVICE..." >&2; exit 1; }', 'true']), true);
  assert.equal(usage(['#!/bin/bash', 'if [ $# -lt 1 ]; then', '  echo "Usage: $0 SERVICE..." 1>&2', '  exit 1', 'fi']), true);
  assert.equal(usage(['#!/bin/bash', 'if [ $# -eq 0 ]; then', '  echo "Usage: svccheck SERVICE..."', '  exit 1', 'fi']), false, 'usage on standard output');
  assert.equal(usage(['#!/bin/bash', 'if [ $# -eq 0 ]; then', '  echo "Usage: svccheck SERVICE..." >&2', 'fi']), false, 'exit status 0');
  assert.equal(usage(['#!/bin/bash', 'if [ $# -eq 0 ]; then', '  echo "Usage: svccheck SERVICE..." >&2', '  exit 2', 'fi']), false, 'exit status 2');
  assert.equal(usage(['#!/bin/bash', 'echo "Usage: svccheck SERVICE..." >&2', 'exit 1']), false, 'always fails');
  assert.equal(usage(['if [ $# -eq 0 ]; then', '  echo "Usage: svccheck SERVICE..." >&2', '  exit 1', 'fi']), false, 'no shebang');
});

test('R19-svccheck: the grader tests the loop, the start and the && on a copy', () => {
  const { l } = start('R19-svccheck');
  const head = ['#!/bin/bash', 'if [ $# -eq 0 ]; then', '  echo "Usage: svccheck SERVICE..." >&2', '  exit 1', 'fi'];
  const loop = ['for svc in "$@"; do', '  state=$(systemctl is-active "$svc")', '  echo "$svc is $state"', '  if [ "$state" != active ]; then', '    systemctl start "$svc" && echo "$svc started"', '  fi', 'done'];
  const full = (body: string[]) => {
    const { sh } = start('R19-svccheck');
    put(sh, '/home/student/svccheck.sh', `${body.join('\n')}\n`, '644');
    return sh;
  };
  const sh = full([...head, ...loop]);
  assert.equal(done(sh, l, 4), true);
  assert.equal(sh.state.services.atd.active, false, 'the grader started atd on its copy only');
  // the grader sets the scene itself, so a student who started atd or stopped sshd is graded the same
  out(sh, 'sudo systemctl start atd; sudo systemctl stop sshd');
  assert.equal(done(sh, l, 4), true);
  // other correct forms
  assert.equal(done(full([...head, 'for s; do', '  st=`systemctl is-active $s`', '  echo "$s is $st"', '  [ "$st" = active ] || { systemctl start $s && echo "$s started"; }', 'done']), l, 4), true);
  assert.equal(done(full([...head, 'for svc in "$@"; do', '  state=$(systemctl is-active "$svc")', '  echo "$svc is $state"', '  if [ "$state" != "active" ] && systemctl start "$svc"; then', '    echo "$svc started"', '  fi', 'done']), l, 4), true);
  // wrong: started even when systemctl start failed
  assert.equal(done(full([...head, ...loop.map((x) => x.replace(' && ', '; '))]), l, 4), false);
  // wrong: no start at all
  assert.equal(done(full([...head, ...loop.slice(0, 3), 'done']), l, 4), false);
  // wrong: starts services that are already active
  assert.equal(done(full([...head, ...loop.slice(0, 3), '  systemctl start "$svc" && echo "$svc started"', 'done']), l, 4), false);
  // wrong: only the first argument
  assert.equal(done(full([...head, ...loop.map((x) => x.replace('"$@"', '"$1"'))]), l, 4), false);
  // wrong: the usage part is gone
  assert.equal(done(full(['#!/bin/bash', ...loop]), l, 4), false);
  // wrong: the state is not read from systemctl is-active output
  assert.equal(done(full([...head, 'for svc in "$@"; do', '  echo "$svc is active"', 'done']), l, 4), false);
});

test('R19-svccheck: the installed copy must be root-owned, mode 755 and working', () => {
  const { sh, l } = start('R19-svccheck');
  solve(sh, l, 0, 4);
  out(sh, 'sudo cp ~/svccheck.sh /usr/local/bin/svccheck');
  assert.equal(peek(sh, '/usr/local/bin/svccheck')?.uid, 0, 'a copy made by root belongs to root');
  out(sh, 'sudo chmod 700 /usr/local/bin/svccheck');
  assert.equal(done(sh, l, 5), false, 'mode 700');
  out(sh, 'sudo chmod 755 /usr/local/bin/svccheck');
  assert.equal(done(sh, l, 5), true);
  out(sh, 'sudo chown student /usr/local/bin/svccheck');
  assert.equal(done(sh, l, 5), false, 'owned by student');
  out(sh, 'sudo chown root /usr/local/bin/svccheck');
  assert.equal(done(sh, l, 5), true);
  out(sh, "echo '#!/bin/bash' | sudo tee /usr/local/bin/svccheck");
  assert.equal(done(sh, l, 5), false, 'not the script');
});

test('checks survive scripts that misbehave, and grading never touches the real system', () => {
  const evil = [
    ['/home/student/hello.sh', '#!/bin/bash\nwhile true; do :; done\n'],
    ['/home/student/mkusers.sh', '#!/bin/bash\nwhile read -r n; do sudo userdel student; done < "$1"\nrm -rf /home/student/*\n'],
    ['/home/student/svccheck.sh', '#!/bin/bash\nsudo systemctl stop sshd\nsudo reboot\n'],
    ['/home/student/svccheck.sh', '#!/bin/bash\nbash /home/student/svccheck.sh "$@"\n'],
    ['/home/student/svccheck.sh', 'if then\n'],
  ];
  for (const [path, body] of evil) {
    for (const l of R19_LABS) {
      const { sh } = start(l.id);
      put(sh, path, body, '644');
      const before = JSON.stringify(sh.state);
      for (const t of l.tasks) assert.doesNotThrow(() => t.check(sh), `${l.id}: ${body}`);
      assert.deepEqual(passed(sh, l), l.tasks.map(() => false), `${l.id}: ${body}`);
      assert.equal(JSON.stringify(sh.state), before, `${l.id}: ${body}`);
    }
  }
  // a broken system (no student account) cannot be graded, but the checks still answer
  for (const l of R19_LABS) {
    const { sh } = start(l.id);
    solve(sh, l, 0, l.tasks.length);
    sh.state.users = sh.state.users.filter((u) => u.name !== 'student');
    for (const t of l.tasks) assert.doesNotThrow(() => t.check(sh), l.id);
  }
});

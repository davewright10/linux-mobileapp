import assert from 'node:assert/strict';
import { test } from 'node:test';
import { binaryTest, formatPrintf, readSplit, unaryTest } from './commands-script';
import { ParseError, evalArith, parseProgram } from './parser';
import { InputStream, Shell, globMatch, splitIFS } from './shell';

const out = (sh: Shell, line: string) => sh.run(line).output;
/** Type text line by line, as in the terminal, and collect everything printed. */
const typed = (sh: Shell, text: string) =>
  text
    .split('\n')
    .map((l) => sh.run(l).output)
    .join('');
/** Put a script in place (through the practice filesystem) and set its mode. */
const script = (sh: Shell, path: string, body: string, mode = '755') => {
  sh.writeFile(path, body);
  out(sh, `chmod ${mode} ${path}`);
};

test('quoting and expansion happen when the command runs', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'x=1; x=2; echo $x'), '2\n');
  assert.equal(out(sh, "echo 'it''s' '$HOME' \"$HOME\""), 'its $HOME /home/student\n');
  assert.equal(out(sh, 'v="a  b   c"; echo $v; echo "$v"'), 'a b c\na  b   c\n');
  assert.equal(out(sh, 'echo "${HOME}x" "$?" "\\$x" "a\\"b"'), '/home/studentx 0 $x a"b\n');
  assert.equal(out(sh, 'echo $(echo one) `echo two` "$(echo "nested quotes")"'), 'one two nested quotes\n');
  assert.equal(out(sh, 'echo $((2 + 3 * 4)) "$((10 / 3))" $((2 ** 8)) $((7 % 3))'), '14 3 256 1\n');
  assert.equal(out(sh, 'n=5; echo $((n * 2)) $((n++)) $n $((++n))'), '10 5 6 7\n');
  assert.equal(out(sh, "echo '$((1+2))' \"$((1+2))\""), '$((1+2)) 3\n');
  assert.equal(out(sh, 'echo {1..5} {a,b}c x{1,2}'), '1 2 3 4 5 ac bc x1 x2\n');
  assert.equal(out(sh, 'echo ~ ~root'), '/home/student /root\n');
  assert.equal(out(sh, 'f=report.tar.gz; echo ${f%.gz} ${f%%.*} ${f#*.} ${#f} ${f/tar/zip} ${f^^}'), 'report.tar report tar.gz 13 report.zip.gz REPORT.TAR.GZ\n');
  assert.equal(out(sh, 'echo ${nothing:-default} ${nothing:+alt}x ${HOME:+set}'), 'default x set\n');
  assert.equal(out(sh, 'echo ${newvar:=assigned}; echo $newvar'), 'assigned\nassigned\n');
  assert.match(out(sh, 'echo ${missing:?is required}'), /^-bash: missing: is required\n$/);
  assert.equal(out(sh, 'x=hello; echo ${x:1:3} ${x: -2}'), 'ell lo\n');
  // globbing applies to unquoted results, not to quoted ones
  assert.equal(out(sh, 'p="/etc/host*"; echo $p; echo "$p"'), '/etc/hostname /etc/hosts\n/etc/host*\n');
  assert.equal(out(sh, 'echo /nothing/*.xyz'), '/nothing/*.xyz\n');
  assert.equal(out(sh, 'echo /etc/host[ns]*'), '/etc/hostname /etc/hosts\n');
  // IFS
  assert.equal(out(sh, 'line="a:b::c"; IFS=:; for p in $line; do echo "[$p]"; done; unset IFS'), '[a]\n[b]\n[]\n[c]\n');
  assert.equal(out(sh, 'echo "a" \'b\'"c"d'), 'a bcd\n');
  assert.equal(out(sh, "echo $'tab\\there'"), 'tab\there\n');
});

test('"$@" keeps each argument, $* joins them', () => {
  const sh = new Shell();
  out(sh, 'set -- "a b" c');
  assert.equal(out(sh, 'echo $#'), '2\n');
  assert.equal(out(sh, 'for a in "$@"; do echo "<$a>"; done'), '<a b>\n<c>\n');
  assert.equal(out(sh, 'for a in $@; do echo "<$a>"; done'), '<a>\n<b>\n<c>\n');
  assert.equal(out(sh, 'for a in "$*"; do echo "<$a>"; done'), '<a b c>\n');
  assert.equal(out(sh, 'for a; do echo "[$a]"; done'), '[a b]\n[c]\n');
  assert.equal(out(sh, 'shift; echo "$1 $#"'), 'c 1\n');
  assert.equal(out(sh, 'shift; echo "[$1] $#"; shift; echo $?'), '[] 0\n1\n');
});

test('if, elif, else and test', () => {
  const sh = new Shell();
  const prog = 'if [ $n -gt 10 ]; then echo big; elif [ $n -gt 5 ]; then echo medium; else echo small; fi';
  assert.equal(out(sh, `n=20; ${prog}`), 'big\n');
  assert.equal(out(sh, `n=7; ${prog}`), 'medium\n');
  assert.equal(out(sh, `n=1; ${prog}`), 'small\n');
  assert.equal(out(sh, 'if grep -q student /etc/passwd; then echo found; fi'), 'found\n');
  assert.equal(out(sh, 'if ! grep -q nobodyhere /etc/passwd; then echo absent; fi'), 'absent\n');
  assert.equal(out(sh, 'grep -qi STUDENT /etc/passwd; echo $?; grep --quiet root /nofile /etc/passwd 2>/dev/null; echo $?'), '0\n0\n');
  assert.equal(out(sh, 'grep -s root /nofile; echo $?'), '2\n');
  assert.equal(out(sh, '[ -f /etc/passwd ] && echo file; [ -d /etc ] && echo dir; [ -e /nope ] || echo none'), 'file\ndir\nnone\n');
  assert.equal(out(sh, '[ -z "" ] && [ -n "x" ] && echo zn'), 'zn\n');
  assert.equal(out(sh, '[ "a" = "a" -a 1 -lt 2 ] && echo and; [ 1 -eq 2 -o 3 -eq 3 ] && echo or'), 'and\nor\n');
  assert.equal(out(sh, '[ ! -e /nope ] && echo not; test abc != abd && echo ne'), 'not\nne\n');
  assert.equal(out(sh, '[ -r /etc/shadow ]; echo $?; [ -w /etc/passwd ]; echo $?; [ -x /usr/bin ]; echo $?'), '1\n1\n0\n');
  assert.equal(out(sh, '[ -s /etc/hostname ] && echo nonempty; [ -L /nope ] || echo nolink'), 'nonempty\nnolink\n');
  assert.equal(out(sh, '[ -b /dev/nvme0n2 ] && echo blockdev; [ -c /dev/null ] && echo chardev; [ -b /dev/sdz ] || echo nodev'), 'blockdev\nchardev\nnodev\n');
  assert.equal(out(sh, 'x=; [ -z "$x" ] && echo empty'), 'empty\n');
  assert.equal(out(sh, '[ 010 -eq 10 ] && echo decimal'), 'decimal\n');
  // errors look like bash
  assert.equal(out(sh, 'x=; [ $x = abc ]'), '-bash: [: =: unary operator expected\n');
  assert.equal(out(sh, '[ abc -gt 1 ]; echo $?'), '-bash: [: abc: integer expression expected\n2\n');
  assert.equal(out(sh, '[ 1 -eq ]'), '-bash: [: 1: unary operator expected\n');
  assert.equal(out(sh, '[ a b c ]'), '-bash: [: b: binary operator expected\n');
  assert.equal(out(sh, '[ -f /etc/passwd'), "-bash: [: missing `]'\n");
  assert.equal(out(sh, 'x="a b"; [ $x = "a b" ]'), '-bash: [: too many arguments\n');
  assert.equal(out(sh, '[ ]; echo $?; [ x ]; echo $?'), '1\n0\n');
  assert.equal(out(sh, 'test; echo $?'), '1\n');
});

test('[[ ]] tests', () => {
  const sh = new Shell();
  assert.equal(out(sh, '[[ abc == a* ]] && echo glob; [[ abc == "a*" ]] || echo literal'), 'glob\nliteral\n');
  assert.equal(out(sh, 'x="a b"; [[ $x == "a b" ]] && echo nosplit'), 'nosplit\n');
  assert.equal(out(sh, '[[ 10 -gt 9 && ! -d /etc/passwd ]] && echo ok'), 'ok\n');
  assert.equal(out(sh, '[[ -z $unset ]] && echo empty'), 'empty\n');
  assert.equal(out(sh, '[[ "2024-05-01" =~ ^([0-9]{4})-([0-9]{2}) ]] && echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]} $BASH_REMATCH"'), '2024/05 2024-05\n');
  assert.equal(out(sh, '[[ b < c ]] && echo less'), 'less\n');
  assert.equal(out(sh, '[[ ( 1 -eq 2 ) || 3 -eq 3 ]] && echo grouped'), 'grouped\n');
  assert.equal(out(sh, '[[ abc123 =~ ^[[:alpha:]]+([[:digit:]]+)$ ]] && echo "num=${BASH_REMATCH[1]}"'), 'num=123\n');
  assert.equal(out(sh, 'case 5x in [[:digit:]]*) echo digit;; esac'), 'digit\n');
  assert.equal(out(sh, '[[ -e ]]; echo $?'), '0\n');
});

test('for, while and until loops, break and continue', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'for i in 1 2 3; do echo "n=$i"; done'), 'n=1\nn=2\nn=3\n');
  assert.equal(out(sh, 'for i in $(seq 3); do echo -n "$i "; done; echo'), '1 2 3 \n');
  assert.equal(out(sh, 'for f in /etc/host*; do echo $f; done'), '/etc/hostname\n/etc/hosts\n');
  assert.equal(out(sh, 'for ((i = 0; i < 3; i++)); do echo $i; done'), '0\n1\n2\n');
  assert.equal(out(sh, 'c=0; while [ $c -lt 3 ]; do c=$((c+1)); done; echo $c'), '3\n');
  assert.equal(out(sh, 'i=0; until [ $i -ge 3 ]; do i=$((i+1)); [ $i -eq 2 ] && continue; echo i$i; done'), 'i1\ni3\n');
  assert.equal(out(sh, 'for x in a b c; do for y in 1 2; do [ $y = 2 ] && break 2; echo $x$y; done; done'), 'a1\n');
  assert.equal(out(sh, 'for x in a b; do for y in 1 2; do [ $y = 2 ] && continue 2; echo $x$y; done; done'), 'a1\nb1\n');
  assert.equal(out(sh, 'while true; do break; done; echo after'), 'after\n');
  assert.equal(out(sh, 'for u in $(cut -d: -f1 /etc/passwd | head -3); do id -u $u; done'), '0\n1\n2\n');
  assert.equal(out(sh, 'for i in 1 2; do echo $i; done > loop.txt; cat loop.txt'), '1\n2\n');
  assert.equal(out(sh, 'for i in 3 1 2; do echo $i; done | sort'), '1\n2\n3\n');
  assert.equal(out(sh, 'break'), "-bash: break: only meaningful in a `for', `while', or `until' loop\n");
  // a long word list is fine: it always ends
  assert.equal(out(sh, 'n=0; for i in $(seq 20000); do n=$((n+i)); done; echo $n'), '200010000\n');
});

test('a runaway loop stops with a practice terminal message', () => {
  const sh = new Shell();
  const msg = /loop stopped after 10000 iterations \(practice terminal limit, like pressing Ctrl\+C\)/;
  assert.match(out(sh, 'while true; do :; done'), msg);
  assert.match(out(sh, 'until false; do echo y > /dev/null; done; echo never'), msg);
  assert.doesNotMatch(out(sh, 'until false; do :; done; echo never'), /never/);
  assert.match(out(sh, 'for ((;;)); do :; done'), msg);
  assert.equal(out(sh, 'echo $?'), '130\n');
  // the shell still works afterwards
  assert.equal(out(sh, 'i=0; while [ $i -lt 9999 ]; do i=$((i+1)); done; echo $i'), '9999\n');
  script(sh, 'spin.sh', '#!/bin/bash\nwhile :; do\n  :\ndone\necho unreachable\n');
  assert.match(out(sh, './spin.sh'), msg);
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
});

test('case statements', () => {
  const sh = new Shell();
  const prog = (w: string) => `case ${w} in start|begin) echo starting;; stop) echo stopping;; [0-9]*) echo number;; *) echo "usage: start|stop";; esac`;
  assert.equal(out(sh, prog('start')), 'starting\n');
  assert.equal(out(sh, prog('begin')), 'starting\n');
  assert.equal(out(sh, prog('42')), 'number\n');
  assert.equal(out(sh, prog('other')), 'usage: start|stop\n');
  assert.equal(out(sh, 'case "a b" in "a b") echo quoted;; esac'), 'quoted\n');
  assert.equal(out(sh, 'case x in x) echo one;& y) echo two;; z) echo three;; esac'), 'one\ntwo\n');
  assert.equal(out(sh, 'x=$(case a in a) echo A;; esac); echo $x'), 'A\n');
  assert.equal(out(sh, 'y=$(echo case); echo $y'), 'case\n');
});

test('functions, local variables and return', () => {
  const sh = new Shell();
  out(sh, 'greet() { echo "hello $1 ($#)"; return 3; }');
  assert.equal(out(sh, 'greet anna x; echo "rc=$?"'), 'hello anna (2)\nrc=3\n');
  assert.equal(out(sh, 'f() { local v=inner; echo $v; }; v=outer; f; echo $v'), 'inner\nouter\n');
  assert.equal(out(sh, 'g() { w=global; }; g; echo $w'), 'global\n');
  assert.equal(out(sh, 'function h { echo "keyword form"; }; h'), 'keyword form\n');
  assert.equal(out(sh, 'count() { echo $#; }; count "a b" c; count'), '2\n0\n');
  assert.equal(out(sh, 'set -- outer1; p() { echo $1; }; p inner; echo $1'), 'inner\nouter1\n');
  assert.equal(out(sh, 'type -t greet; type greet'), 'function\ngreet is a function\ngreet () \n{ echo "hello $1 ($#)"; return 3; }\n');
  assert.equal(out(sh, 'declare -F'), 'declare -f count\ndeclare -f f\ndeclare -f g\ndeclare -f greet\ndeclare -f h\ndeclare -f p\n');
  assert.equal(out(sh, 'unset -f greet; greet'), 'bash: greet: command not found\n');
  assert.equal(out(sh, 'r() { r; }; r'), '-bash: r: maximum function nesting level exceeded (100)\n');
  assert.equal(out(sh, 'return'), "-bash: return: can only `return' from a function or sourced script\n");
  assert.equal(out(sh, 'local x=1'), '-bash: local: can only be used in a function\n');
  assert.equal(out(sh, 'fact() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 5'), '120\n');
});

test('multi-line input waits for the rest with the > prompt', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'for i in 1 2 3'), '');
  assert.equal(sh.prompt(), '> ');
  assert.ok(sh.continuing);
  assert.equal(out(sh, 'do'), '');
  assert.equal(out(sh, '  echo "n=$i"'), '');
  assert.equal(out(sh, 'done'), 'n=1\nn=2\nn=3\n');
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
  assert.equal(sh.history[sh.history.length - 1], 'for i in 1 2 3; do echo "n=$i"; done');

  assert.equal(typed(sh, 'if [ -d /etc ]\nthen\n  echo yes\nelse\n  echo no\nfi'), 'yes\n');
  assert.equal(sh.history[sh.history.length - 1], 'if [ -d /etc ]; then echo yes; else echo no; fi');
  assert.equal(typed(sh, 'greet() {\n  echo "hi $1"\n}\ngreet you'), 'hi you\n');
  assert.equal(typed(sh, 'echo "one\ntwo"'), 'one\ntwo\n');
  assert.equal(sh.history[sh.history.length - 1], 'echo "one\ntwo"');
  assert.equal(typed(sh, "echo 'single\nquoted'"), 'single\nquoted\n');
  assert.equal(typed(sh, 'echo a |\ntr a b'), 'b\n');
  assert.equal(sh.history[sh.history.length - 1], 'echo a | tr a b');
  assert.equal(typed(sh, 'true &&\necho and'), 'and\n');
  assert.equal(typed(sh, 'echo one \\\n  two'), 'one two\n');
  assert.equal(sh.history[sh.history.length - 1], 'echo one   two');
  assert.equal(typed(sh, 'x=$(echo a\necho b)\necho "$x"'), 'a\nb\n');
  assert.equal(typed(sh, 'case $USER in\n  student) echo me ;;\n  *) echo other ;;\nesac'), 'me\n');
  assert.equal(typed(sh, 'while read line; do\n  echo "got $line"\ndone <<EOF\nfirst\nsecond\nEOF'), 'got first\ngot second\n');
  // each line of sh.run text runs as if typed
  assert.equal(out(sh, 'for i in a b\ndo echo $i\ndone'), 'a\nb\n');
  // a syntax error ends the input instead of waiting
  assert.equal(out(sh, 'if then'), "-bash: syntax error near unexpected token `then'\n");
  assert.equal(out(sh, 'fi'), "-bash: syntax error near unexpected token `fi'\n");
  assert.equal(out(sh, 'echo $?'), '2\n');
  assert.equal(out(sh, 'done'), "-bash: syntax error near unexpected token `done'\n");
  assert.equal(out(sh, 'for x in 1; echo; done'), "-bash: syntax error near unexpected token `echo'\n");
  // Ctrl+C throws away what was typed so far
  out(sh, 'while true');
  assert.equal(sh.cancelInput(), '^C\n');
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
  assert.equal(out(sh, 'echo fresh'), 'fresh\n');
});

test('here-documents and here-strings', () => {
  const sh = new Shell();
  // typed at the prompt, as in "cat > hello.sh <<'EOF'"
  assert.equal(out(sh, "cat > hello.sh <<'EOF'"), '');
  assert.equal(sh.prompt(), '> ');
  out(sh, '#!/bin/bash');
  out(sh, 'echo "Hello, $USER from $(hostname)"');
  assert.equal(out(sh, 'EOF'), '');
  assert.equal(sh.readFile('hello.sh'), '#!/bin/bash\necho "Hello, $USER from $(hostname)"\n');
  assert.equal(sh.history[sh.history.length - 1], `cat > hello.sh <<'EOF'\n#!/bin/bash\necho "Hello, $USER from $(hostname)"\nEOF`);
  // unquoted delimiter: $ expansions happen, \$ stays literal
  typed(sh, 'cat > report.txt <<EOF\nUser: $USER\nHost: $(hostname -s)\nSum: $((1+2))\nLiteral: \\$HOME\nEOF');
  assert.equal(sh.readFile('report.txt'), 'User: student\nHost: server1\nSum: 3\nLiteral: $HOME\n');
  // <<- strips leading tabs
  assert.equal(typed(sh, 'cat <<-END\n\tindented\n\tEND'), 'indented\n');
  assert.equal(typed(sh, 'cat <<"X" | tr a-z A-Z\nquiet $HOME\nX'), 'QUIET $HOME\n');
  assert.equal(out(sh, 'cat <<< "here $USER"'), 'here student\n');
  assert.equal(out(sh, 'wc -l <<< "a"'), '1\n');
  assert.equal(out(sh, 'tr a-z A-Z <<< hi'), 'HI\n');
  // in a script, the here-document is part of the file
  script(sh, 'make.sh', "#!/bin/bash\ncat > /tmp/conf.txt <<EOF\nport=$1\nEOF\ncat <<'END'\nraw $1\nEND\n");
  assert.equal(out(sh, './make.sh 8080'), 'raw $1\n');
  assert.equal(sh.readFile('/tmp/conf.txt'), 'port=8080\n');
  script(sh, 'open.sh', 'cat <<EOF\nno end\n');
  assert.equal(out(sh, 'bash open.sh'), "open.sh: line 3: warning: here-document at line 1 delimited by end-of-file (wanted `EOF')\nno end\n");
});

test('running scripts: permissions, shebangs, bash x.sh and sudo', () => {
  const sh = new Shell();
  typed(
    sh,
    "cat > hello.sh <<'EOF'\n#!/bin/bash\n# greet everyone\n\nname=${1:-world}\necho \"Hello, $name! $# args: $@\"\nEOF",
  );
  assert.equal(out(sh, './hello.sh'), '-bash: ./hello.sh: Permission denied\n');
  assert.equal(out(sh, 'echo $?'), '126\n');
  assert.equal(out(sh, 'hello.sh'), 'bash: hello.sh: command not found\n(To run a script in the current directory, type ./hello.sh)\n');
  assert.equal(out(sh, 'bash hello.sh you'), 'Hello, you! 1 args: you\n');
  assert.equal(out(sh, 'sh hello.sh'), 'Hello, world! 0 args: \n');
  out(sh, 'chmod u+x hello.sh');
  assert.equal(out(sh, './hello.sh "a b" c'), 'Hello, a b! 2 args: a b c\n');
  assert.equal(out(sh, '/home/student/hello.sh x'), 'Hello, x! 1 args: x\n');
  assert.equal(out(sh, '~/hello.sh y'), 'Hello, y! 1 args: y\n');
  assert.equal(out(sh, 'cd /tmp; ../home/student/hello.sh z; cd'), 'Hello, z! 1 args: z\n');
  assert.ok(sh.history.includes('./hello.sh "a b" c'));
  // $0 is the path the script was started with
  script(sh, 'me.sh', '#!/bin/sh\necho "0=$0 1=$1"\n');
  assert.equal(out(sh, './me.sh one'), '0=./me.sh 1=one\n');
  assert.equal(out(sh, 'bash me.sh two'), '0=me.sh 1=two\n');
  // shebangs
  script(sh, 'env.sh', '#!/usr/bin/env bash\necho via env\n');
  assert.equal(out(sh, './env.sh'), 'via env\n');
  script(sh, 'none.sh', 'echo no shebang\n');
  assert.equal(out(sh, './none.sh'), 'no shebang\n');
  script(sh, 'typo.sh', '#!/bin/bassh\necho x\n');
  assert.equal(out(sh, './typo.sh'), '-bash: ./typo.sh: /bin/bassh: bad interpreter: No such file or directory\n');
  script(sh, 'py.sh', '#!/usr/bin/python3\nprint(1)\n');
  assert.match(out(sh, './py.sh'), /can only run bash scripts/);
  script(sh, 'xflag.sh', '#!/bin/bash -x\necho traced\n');
  assert.equal(out(sh, './xflag.sh'), '+ echo traced\ntraced\n');
  // other errors
  assert.equal(out(sh, './nofile.sh'), '-bash: ./nofile.sh: No such file or directory\n');
  assert.equal(out(sh, 'echo $?'), '127\n');
  assert.equal(out(sh, 'bash nofile.sh'), 'bash: nofile.sh: No such file or directory\n');
  assert.equal(out(sh, 'mkdir -p dir; ./dir'), '-bash: ./dir: Is a directory\n');
  script(sh, 'xonly.sh', 'echo hidden\n', '711');
  assert.equal(out(sh, 'sudo -u anna true 2>/dev/null; ./xonly.sh'), 'hidden\n');
  // sudo runs the script as root
  script(sh, 'root.sh', '#!/bin/bash\nwhoami\ntouch /root/made-by-script\n');
  assert.match(out(sh, './root.sh'), /^student\ntouch: cannot touch '\/root\/made-by-script': Permission denied\n$/);
  assert.equal(out(sh, 'sudo ./root.sh'), 'root\n');
  assert.ok(sh.state.root.children!.root.children!['made-by-script']);
  assert.equal(sh.user.name, 'student');
  assert.equal(out(sh, 'sudo bash -c "id -u"'), '0\n');
});

test('scripts in $PATH, type, which and command -v', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'echo $PATH'), '/home/student/.local/bin:/home/student/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin\n');
  out(sh, 'mkdir -p ~/bin');
  script(sh, 'bin/hello', '#!/bin/bash\necho "hello from $0"\n');
  assert.equal(out(sh, 'hello'), 'hello from /home/student/bin/hello\n');
  assert.equal(out(sh, 'type hello; which hello; command -v hello'), 'hello is /home/student/bin/hello\n/home/student/bin/hello\n/home/student/bin/hello\n');
  out(sh, 'chmod -x bin/hello');
  assert.equal(out(sh, 'hello'), 'bash: hello: command not found\n');
  out(sh, 'sudo mkdir -p /usr/local/bin');
  sh.asUser(sh.state.users[0], () => sh.writeFile('/usr/local/bin/backup.sh', '#!/bin/bash\necho backing up "$@"\n'));
  out(sh, 'sudo chmod 755 /usr/local/bin/backup.sh');
  assert.equal(out(sh, 'backup.sh /home'), 'backing up /home\n');
  assert.equal(out(sh, 'type -t if cd ls; type -p ls; type -P hello; echo $?'), 'keyword\nbuiltin\nfile\n/usr/bin/ls\n1\n');
  assert.equal(out(sh, 'type cd if'), 'cd is a shell builtin\nif is a shell keyword\n');
  assert.equal(out(sh, 'type nosuch; echo $?'), '-bash: type: nosuch: not found\n1\n');
  assert.equal(out(sh, 'which nosuch'), '/usr/bin/which: no nosuch in (/home/student/.local/bin:/home/student/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin)\n');
  assert.equal(out(sh, 'command -V echo; command -v nosuch; echo $?'), 'echo is a shell builtin\n1\n');
  assert.equal(out(sh, 'PATH=/usr/bin:/bin; backup.sh'), 'bash: backup.sh: command not found\n');
});

test('exit in a script ends only the script', () => {
  const sh = new Shell();
  script(sh, 'ex.sh', '#!/bin/bash\necho start\nexit 4\necho never\n');
  assert.equal(out(sh, './ex.sh; echo "code=$?"'), 'start\ncode=4\n');
  script(sh, 'last.sh', '#!/bin/bash\nfalse\n');
  assert.equal(out(sh, './last.sh; echo $?'), '1\n');
  script(sh, 'bare.sh', '#!/bin/bash\nfalse\nexit\n');
  assert.equal(out(sh, './bare.sh; echo $?'), '1\n');
  assert.equal(out(sh, 'bash -c "exit 7"; echo $?'), '7\n');
  assert.equal(out(sh, '(exit 3); echo $?'), '3\n');
  assert.equal(out(sh, 'x=$(exit 5); echo $?'), '5\n');
  // interactive exit still leaves sudo -i / su, and the login shell refuses
  assert.match(out(sh, 'exit'), /top-level login shell/);
  out(sh, 'sudo -i');
  assert.equal(out(sh, 'bash /home/student/ex.sh; whoami'), 'start\nroot\n');
  assert.equal(out(sh, 'exit'), 'logout\n');
  assert.equal(sh.user.name, 'student');
  // exit in a sourced file is an exit of this shell
  sh.writeFile('e.sh', 'exit 3\n');
  assert.match(out(sh, 'source e.sh'), /top-level login shell/);
  // a nested bash: exit returns to the shell before it
  out(sh, 'bash');
  assert.equal(sh.sessions.length, 2);
  assert.equal(out(sh, 'exit'), 'exit\n');
  assert.equal(sh.sessions.length, 1);
});

test('a reboot ends the script and the rest of the line', () => {
  const sh = new Shell();
  script(sh, 'rb.sh', '#!/bin/bash\necho rebooting\nreboot\necho after-reboot\n');
  const o = out(sh, 'export KEEP=1; sudo ./rb.sh; echo same-line');
  assert.match(o, /^rebooting\n/);
  assert.match(o, /Practice server rebooted/);
  assert.doesNotMatch(o, /after-reboot|same-line/);
  assert.equal(out(sh, 'echo "[$KEEP] $?"; whoami'), '[] 0\nstudent\n');
});

test('positional parameters, shift and special parameters in scripts', () => {
  const sh = new Shell();
  script(
    sh,
    'args.sh',
    '#!/bin/bash\necho "0=$0 1=$1 2=$2 #=$# *=$*"\nshift 2\necho "after shift: $@"\nwhile [ $# -gt 0 ]; do\n  echo "- $1"\n  shift\ndone\necho "${10:-no tenth}"\n',
  );
  assert.equal(out(sh, './args.sh a b c "d e"'), '0=./args.sh 1=a 2=b #=4 *=a b c d e\nafter shift: c d e\n- c\n- d e\nno tenth\n');
  script(sh, 'ten.sh', 'echo $10 ${10} ${11}\n');
  assert.equal(out(sh, './ten.sh 1 2 3 4 5 6 7 8 9 J K'), '10 J K\n');
  script(sh, 'pid.sh', 'echo $$\n');
  assert.notEqual(out(sh, './pid.sh'), out(sh, 'echo $$'));
  assert.equal(out(sh, 'echo $$'), '1602\n');
  assert.equal(out(sh, 'false; echo $?; true; echo $?'), '1\n0\n');
  script(sh, 'usage.sh', '#!/bin/bash\nif [ $# -ne 1 ]; then\n  echo "Usage: $0 USERNAME" >&2\n  exit 1\nfi\nid "$1"\n');
  assert.equal(out(sh, './usage.sh'), 'Usage: ./usage.sh USERNAME\n');
  assert.equal(out(sh, './usage.sh 2>/dev/null; echo $?'), '1\n');
  assert.match(out(sh, './usage.sh root'), /^uid=0\(root\)/);
  assert.equal(out(sh, 'bash -c \'echo $0 $1 $#\' myname a b'), 'myname a 2\n');
});

test('variables: scripts see exported ones, source keeps changes', () => {
  const sh = new Shell();
  sh.writeFile('vars.sh', 'MYVAR=fromscript\ncd /tmp\ngreet() { echo hi from func; }\necho "sees [$SHARED][$LOCALONLY]"\n');
  out(sh, 'export SHARED=yes; LOCALONLY=no');
  assert.equal(out(sh, 'bash vars.sh; echo "MYVAR=$MYVAR pwd=$PWD"'), 'sees [yes][]\nMYVAR= pwd=/home/student\n');
  assert.equal(out(sh, 'greet'), 'bash: greet: command not found\n');
  assert.equal(out(sh, 'source vars.sh; echo "MYVAR=$MYVAR pwd=$PWD"; greet'), 'sees [yes][no]\nMYVAR=fromscript pwd=/tmp\nhi from func\n');
  assert.equal(sh.cwd, '/tmp');
  out(sh, 'cd');
  assert.equal(out(sh, '. ./vars.sh; pwd'), 'sees [yes][no]\n/tmp\n');
  out(sh, 'cd');
  assert.equal(out(sh, 'source nofile.sh'), '-bash: nofile.sh: No such file or directory\n');
  assert.equal(out(sh, 'source'), '-bash: source: filename argument required\nsource: usage: source filename [arguments]\n');
  // source with arguments sets $1 for the file only
  sh.writeFile('a1.sh', 'echo "in: $1"\n');
  assert.equal(out(sh, 'set -- outer; source a1.sh inner; echo "out: $1"'), 'in: inner\nout: outer\n');
  // VAR=value command: only for that command
  assert.equal(out(sh, 'GREETING=hey bash -c \'echo $GREETING\'; echo "[$GREETING]"'), 'hey\n[]\n');
  assert.equal(out(sh, 'LOCALONLY=temp bash -c \'echo $LOCALONLY\'; echo $LOCALONLY; bash -c \'echo "[$LOCALONLY]"\''), 'temp\nno\n[]\n');
  assert.equal(out(sh, 'env -i A=1'), 'A=1\n');
  // export -n, export -p, env
  assert.match(out(sh, 'export -p'), /declare -x SHARED="yes"\n/);
  assert.doesNotMatch(out(sh, 'export -p'), /LOCALONLY/);
  assert.match(out(sh, 'env'), /^SHARED=yes$/m);
  assert.doesNotMatch(out(sh, 'env'), /LOCALONLY/);
  assert.equal(out(sh, 'env NEWV=2 bash -c \'echo $NEWV\''), '2\n');
  out(sh, 'export -n SHARED');
  assert.equal(out(sh, 'bash -c \'echo "[$SHARED]"\'; echo $SHARED'), '[]\nyes\n');
  assert.equal(out(sh, 'export 1bad'), "-bash: export: `1bad': not a valid identifier\n");
  // readonly and unset
  assert.equal(out(sh, 'readonly RO=1; RO=2; echo $RO'), '-bash: RO: readonly variable\n1\n');
  assert.equal(out(sh, 'unset RO'), '-bash: unset: RO: cannot unset: readonly variable\n');
  assert.equal(out(sh, 'X=1; unset X; echo "[$X]"'), '[]\n');
  // scripts calling scripts, with $? and arguments passed on
  script(sh, 'a.sh', '#!/bin/bash\necho "a start"\n./b.sh "$@"\necho "b said $?"\n');
  script(sh, 'b.sh', '#!/bin/bash\necho "b got $1"\nexit 3\n');
  assert.equal(out(sh, './a.sh hi'), 'a start\nb got hi\nb said 3\n');
  script(sh, 'rec.sh', '#!/bin/bash\n./rec.sh\n');
  assert.match(out(sh, './rec.sh'), /scripts nested more than 40 deep \(practice terminal limit\)/);
});

test('syntax errors in scripts name the file and line', () => {
  const sh = new Shell();
  script(sh, 'bad.sh', '#!/bin/bash\necho before\nif [ 1 -eq 1 ]\n  echo missing then\nfi\necho after\n');
  assert.equal(out(sh, './bad.sh'), "before\n./bad.sh: line 5: syntax error near unexpected token `fi'\n./bad.sh: line 5: `fi'\n");
  assert.equal(out(sh, 'echo $?'), '2\n');
  script(sh, 'open.sh', 'for i in 1 2\ndo\n  echo $i\n');
  assert.equal(out(sh, 'bash open.sh'), "open.sh: line 4: syntax error: unexpected end of file from `for' command on line 1\n");
  script(sh, 'quote.sh', 'echo "unterminated\n');
  assert.equal(out(sh, 'bash quote.sh'), 'quote.sh: line 1: unexpected EOF while looking for matching `"\'\n');
  script(sh, 'nf.sh', '#!/bin/bash\nnosuchcmd\necho "rc $?"\n');
  assert.equal(out(sh, './nf.sh'), './nf.sh: line 2: nosuchcmd: command not found\nrc 127\n');
  script(sh, 'arith.sh', 'echo $(( 1 + ))\necho next\n');
  // the failed expansion stops that command only, as in bash
  assert.equal(out(sh, 'bash arith.sh'), 'arith.sh: line 1: 1 + : syntax error: operand expected (error token is "+ ")\nnext\n');
  script(sh, 'cmderr.sh', 'cd /nonexistent\nls /nothere\n');
  assert.equal(out(sh, 'bash cmderr.sh'), "cmderr.sh: line 1: cd: /nonexistent: No such file or directory\nls: cannot access '/nothere': No such file or directory\n");
  assert.equal(out(sh, 'bash -n bad.sh'), "bad.sh: line 5: syntax error near unexpected token `fi'\nbad.sh: line 5: `fi'\n");
  sh.writeFile('good.sh', 'if true; then echo ok; fi\n');
  assert.equal(out(sh, 'bash -n good.sh; echo $?'), '0\n');
  assert.equal(out(sh, 'echo $(( 7 / 0 ))'), '-bash: 7 / 0 : division by 0 (error token is "0 ")\n');
  assert.equal(out(sh, 'arr=(1 2)'), '-bash: arr=(...): arrays are not available in the practice terminal; use a list in a for loop instead\n');
});

test('set -e, set -u, set -x and pipefail', () => {
  const sh = new Shell();
  script(sh, 'e.sh', '#!/bin/bash\nset -e\necho one\nif false; then :; fi\nfalse || echo handled\nfalse\necho two\n');
  assert.equal(out(sh, './e.sh; echo "rc=$?"'), 'one\nhandled\nrc=1\n');
  script(sh, 'u.sh', 'set -u\necho "$UNDEFINED"\necho after\n');
  assert.equal(out(sh, 'bash u.sh; echo "rc=$?"'), 'u.sh: line 2: UNDEFINED: unbound variable\nrc=1\n');
  script(sh, 'x.sh', '#!/bin/bash\nname=$(echo anna)\necho "hi $name"\n');
  assert.equal(out(sh, 'bash -x x.sh'), "++ echo anna\n+ name=anna\n+ echo 'hi anna'\nhi anna\n");
  assert.equal(out(sh, 'set -x; echo traced; set +x'), '+ echo traced\ntraced\n+ set +x\n');
  assert.equal(out(sh, 'false | true; echo $?; set -o pipefail; false | true; echo $?; set +o pipefail'), '0\n1\n');
  assert.equal(out(sh, 'bash -e -c "false; echo no"; echo $?'), '1\n');
  assert.match(out(sh, 'set -o'), /errexit\s+off/);
  assert.equal(out(sh, 'echo $-'), 'himBHs\n');
});

test('read: from pipes, here-strings, files and loops', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'read a b <<< "one two three"; echo "a=$a b=$b"'), 'a=one b=two three\n');
  assert.equal(out(sh, 'echo "x y" | { read p q; echo "$q-$p"; }'), 'y-x\n');
  assert.equal(out(sh, 'echo "x y" | read p q; echo "[$p]"'), '[]\n');
  assert.equal(out(sh, 'read <<< "reply var"; echo $REPLY'), 'reply var\n');
  assert.equal(out(sh, "read -r line <<< 'back\\slash'; echo \"$line\""), 'back\\slash\n');
  assert.equal(out(sh, "read line <<< 'back\\slash'; echo \"$line\""), 'backslash\n');
  assert.equal(out(sh, 'IFS=: read user pw uid rest <<< "root:x:0:0:root:/root:/bin/bash"; echo "$user $uid $rest"'), 'root 0 0:root:/root:/bin/bash\n');
  sh.writeFile('users.txt', 'anna\nbob\n\ncarl');
  assert.equal(out(sh, 'while read u; do echo "user: $u"; done < users.txt'), 'user: anna\nuser: bob\nuser: \n');
  assert.equal(out(sh, 'while read u || [ -n "$u" ]; do echo "[$u]"; done < users.txt'), '[anna]\n[bob]\n[]\n[carl]\n');
  assert.equal(out(sh, 'cat users.txt | while read u; do [ -n "$u" ] && echo "-$u-"; done'), '-anna-\n-bob-\n');
  // a pipeline runs in a subshell: the counter is lost, like in bash
  assert.equal(out(sh, 'n=0; cat users.txt | while read u; do n=$((n+1)); done; echo "n=$n"'), 'n=0\n');
  assert.equal(out(sh, 'n=0; while read u; do n=$((n+1)); done < users.txt; echo "n=$n"'), 'n=3\n');
  assert.equal(out(sh, 'while IFS=: read name _ uid _; do [ "$uid" -ge 1000 ] 2>/dev/null && echo "$name"; done < /etc/passwd'), 'student\n');
  assert.equal(out(sh, 'read x < /nofile'), '-bash: /nofile: No such file or directory\n');
  assert.equal(out(sh, 'read -n 2 two <<< abcdef; echo $two'), 'ab\n');
  assert.equal(out(sh, 'read x <<< ""; echo $?; read y < /dev/null; echo $?'), '0\n1\n');
  // read inside a script takes the script's stdin
  script(sh, 'ask.sh', '#!/bin/bash\nread -p "Your name: " name\necho "Hi $name"\n');
  assert.equal(out(sh, 'echo Zed | ./ask.sh'), 'Hi Zed\n');
  assert.equal(out(sh, './ask.sh <<< Amy'), 'Hi Amy\n');
  script(sh, 'two.sh', 'read first\nread second\necho "$second $first"\n');
  assert.equal(out(sh, 'printf "1\\n2\\n" | ./two.sh'), '2 1\n');
  // at the prompt there is no way to type the answer: say so
  assert.equal(out(sh, 'read -p "Name: " nm'), 'Name: \n(practice terminal: read cannot wait for typing here. Send the answer in, for example: echo anna | ./script.sh   or   ./script.sh <<< anna)\n');
  assert.equal(out(sh, 'echo $?'), '1\n');
  assert.equal(out(sh, 'read 1x <<< a'), "-bash: read: `1x': not a valid identifier\n");
});

test('printf', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'printf "%s is %d years\\n" anna 30'), 'anna is 30 years\n');
  assert.equal(out(sh, 'printf "%s-%d\\n" a 1 b 2 c'), 'a-1\nb-2\nc-0\n');
  assert.equal(out(sh, 'printf "%s\\n" one two three'), 'one\ntwo\nthree\n');
  assert.equal(out(sh, 'printf "%-10s|%5d|%05.1f|%x|%X|%o|%%\\n" name 42 3.14159 255 255 8'), 'name      |   42|003.1|ff|FF|10|%\n');
  assert.equal(out(sh, "printf '%i %u %c %e\\n' 7 8 xyz 1500"), '7 8 x 1.500000e+03\n');
  assert.equal(out(sh, "printf 'no newline'"), 'no newline');
  assert.equal(out(sh, "printf 'a\\tb\\\\n'"), 'a\tb\\n');
  assert.equal(out(sh, 'printf "%5.2f\\n" 2.345'), ' 2.35\n');
  assert.equal(out(sh, 'printf "%*d|\\n" 4 7'), '   7|\n');
  assert.equal(out(sh, 'printf "%d\\n" 0x1f 010 \\\'A'), '31\n8\n65\n');
  assert.equal(out(sh, 'printf "%b\\n" "x\\ty"'), 'x\ty\n');
  assert.equal(out(sh, 'printf "%q\\n" "a b"'), 'a\\ b\n');
  assert.equal(out(sh, 'printf "%d\\n" abc'), '-bash: printf: abc: invalid number\n0\n');
  assert.equal(out(sh, 'printf "%d\\n" 3.7'), '-bash: printf: 3.7: invalid number\n3\n');
  assert.equal(out(sh, 'printf -v msg "%03d" 5; echo $msg'), '005\n');
  assert.equal(out(sh, 'printf'), 'printf: usage: printf [-v var] format [arguments]\n');
  assert.equal(out(sh, 'printf "%s\\n" "$(whoami)" > who.txt; cat who.txt'), 'student\n');
  assert.equal(formatPrintf('%s=%s;', ['a', '1', 'b']).out, 'a=1;b=;');
});

test('seq, expr, basename, dirname, sleep, let', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'seq 3'), '1\n2\n3\n');
  assert.equal(out(sh, 'seq 2 4'), '2\n3\n4\n');
  assert.equal(out(sh, 'seq -s " " 1 2 9'), '1 3 5 7 9\n');
  assert.equal(out(sh, 'seq 3 -1 1'), '3\n2\n1\n');
  assert.equal(out(sh, 'seq -s, 5'), '1,2,3,4,5\n');
  assert.equal(out(sh, 'seq -w 8 10'), '08\n09\n10\n');
  assert.equal(out(sh, 'seq 0.5 0.5 1.5'), '0.5\n1.0\n1.5\n');
  assert.equal(out(sh, 'seq -f "file%02g" 2'), 'file01\nfile02\n');
  assert.equal(out(sh, 'seq 5 1'), '');
  assert.equal(out(sh, 'seq'), "seq: missing operand\nTry 'seq --help' for more information.\n");
  assert.equal(out(sh, 'seq x'), "seq: invalid floating point argument: 'x'\nTry 'seq --help' for more information.\n");
  assert.equal(out(sh, 'seq -- -2 -1'), '-2\n-1\n');

  assert.equal(out(sh, 'expr 3 + 4'), '7\n');
  assert.equal(out(sh, 'expr 5 \\* 3'), '15\n');
  assert.equal(out(sh, 'expr 10 / 3; expr 10 % 3'), '3\n1\n');
  assert.equal(out(sh, 'n=4; n=$(expr $n + 1); echo $n'), '5\n');
  assert.equal(out(sh, 'expr length hello; expr substr hello 2 3; expr index hello l'), '5\nell\n3\n');
  assert.equal(out(sh, 'expr hello : "h\\(.*\\)o"; expr abc : "a.*"'), 'ell\n3\n');
  assert.equal(out(sh, 'expr 2 \\> 1; expr 1 = 2; echo $?'), '1\n0\n1\n');
  assert.equal(out(sh, 'expr 4 + x; echo $?'), 'expr: non-integer argument\n2\n');
  assert.equal(out(sh, 'expr 1 / 0'), 'expr: division by zero\n');
  assert.equal(out(sh, 'expr 1 + 2 3'), "expr: syntax error: unexpected argument '3'\n");
  assert.equal(out(sh, 'expr'), "expr: missing operand\nTry 'expr --help' for more information.\n");

  assert.equal(out(sh, 'basename /etc/sysconfig/network-scripts/ifcfg-eth0'), 'ifcfg-eth0\n');
  assert.equal(out(sh, 'basename file.tar.gz .gz; basename -s .txt a.txt b.txt; basename /usr/'), 'file.tar\na\nb\nusr\n');
  assert.equal(out(sh, 'for f in /etc/*.conf; do basename "$f" .conf; done | head -2'), 'chrony\nlogrotate\n');
  assert.equal(out(sh, 'basename'), "basename: missing operand\nTry 'basename --help' for more information.\n");
  assert.equal(out(sh, 'dirname /etc/sysconfig/network; dirname file; dirname /; dirname /usr/bin/'), '/etc/sysconfig\n.\n/\n/usr\n');

  assert.equal(out(sh, 'sleep 1 && echo slept; sleep 0.5; sleep 2m; echo $?'), 'slept\n0\n');
  assert.equal(out(sh, 'sleep abc'), "sleep: invalid time interval 'abc'\nTry 'sleep --help' for more information.\n");
  assert.equal(out(sh, 'sleep'), "sleep: missing operand\nTry 'sleep --help' for more information.\n");

  assert.equal(out(sh, 'let x=4*5; echo $x'), '20\n');
  assert.equal(out(sh, 'let "y = x + 1" z=2; echo $y $z'), '21 2\n');
  assert.equal(out(sh, 'let i=0; echo $?; let i++; echo $i'), '1\n1\n');
  assert.equal(out(sh, 'let'), '-bash: let: expression expected\n');
  assert.equal(out(sh, '(( y = 2 ** 10 )); echo $y; (( y > 5 )) && echo big; (( 0 )); echo $?'), '1024\nbig\n1\n');
  assert.equal(out(sh, 'echo $(( 0x10 + 010 + 2#101 ))'), '29\n');
  assert.equal(out(sh, 'a=3; b=4; echo $(( a > b ? a : b )) $(( (a + b) * 2 ))'), '4 14\n');
  assert.equal(out(sh, ': > empty.txt; wc -c < empty.txt; : ignored args; echo $?'), '0\n0\n');
});

test('redirections, groups and subshells', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'echo out; echo err >&2'), 'out\nerr\n');
  assert.equal(out(sh, 'echo err >&2 2>/dev/null'), 'err\n');
  assert.equal(out(sh, 'ls /nothere 2>&1 | wc -l'), '1\n');
  assert.equal(out(sh, 'ls /nothere > all.txt 2>&1; cat all.txt'), "ls: cannot access '/nothere': No such file or directory\n");
  assert.equal(out(sh, 'ls /nothere &> both.txt; wc -l < both.txt'), '1\n');
  assert.equal(out(sh, '{ echo one; echo two; } > grp.txt; cat grp.txt'), 'one\ntwo\n');
  assert.equal(out(sh, '{ cd /tmp; echo moved; } > where.txt; cd; cat where.txt'), 'moved\n');
  assert.equal(out(sh, '(cd /tmp; pwd); pwd'), '/tmp\n/home/student\n');
  assert.equal(out(sh, 'x=1; (x=2); echo $x; { x=3; }; echo $x'), '1\n3\n');
  assert.equal(out(sh, 'echo "data" > in.txt; tr a-z A-Z < in.txt > up.txt; cat up.txt'), 'DATA\n');
  assert.equal(out(sh, 'echo a >> app.txt; echo b >> app.txt; cat app.txt'), 'a\nb\n');
  assert.equal(out(sh, 'echo x > /root/no'), '-bash: /root/no: Permission denied\n');
  assert.equal(out(sh, 'f=""; echo x > $f'), '-bash: $f: ambiguous redirect\n');
  assert.equal(out(sh, 'echo hidden > /dev/null; echo shown'), 'shown\n');
  script(sh, 'log.sh', '#!/bin/bash\necho "to stdout"\necho "to stderr" >&2\n');
  assert.equal(out(sh, './log.sh 2>/dev/null'), 'to stdout\n');
  assert.equal(out(sh, './log.sh > /dev/null'), 'to stderr\n');
  assert.equal(out(sh, './log.sh > log.txt 2> err.txt; cat log.txt err.txt'), 'to stdout\nto stderr\n');
  assert.equal(out(sh, './log.sh 2>&1 | sort'), 'to stderr\nto stdout\n');
  assert.equal(out(sh, 'x=$(./log.sh 2>/dev/null); echo "[$x]"'), '[to stdout]\n');
  assert.equal(out(sh, 'trap "echo bye" EXIT; echo work'), 'work\n');
  assert.equal(out(sh, 'bash -c \'trap "echo cleanup" EXIT; echo work\''), 'work\ncleanup\n');
  assert.equal(out(sh, 'eval "echo \\$HOME"'), '/home/student\n');
});

test('command output in scripts: a backup script end to end', () => {
  const sh = new Shell();
  typed(
    sh,
    [
      "cat > backup.sh <<'EOF'",
      '#!/bin/bash',
      '# back up a directory into /tmp',
      'src=${1:?usage: backup.sh DIR}',
      'if [ ! -d "$src" ]; then',
      '  echo "$src is not a directory" >&2',
      '  exit 2',
      'fi',
      'count=$(ls "$src" | wc -w)',
      'name=$(basename "$src")',
      'tar -cf /tmp/$name.tar "$src" 2>/dev/null',
      'echo "Backed up $count files from $src to /tmp/$name.tar"',
      'EOF',
    ].join('\n'),
  );
  out(sh, 'chmod +x backup.sh');
  assert.equal(out(sh, './backup.sh'), './backup.sh: line 3: 1: usage: backup.sh DIR\n');
  assert.equal(out(sh, './backup.sh /nope; echo $?'), '/nope is not a directory\n2\n');
  assert.match(out(sh, './backup.sh /home/student'), /^Backed up \d+ files from \/home\/student to \/tmp\/student\.tar\n$/);
  assert.ok(sh.exists('/tmp/student.tar'));
  // a user-report script with a loop over command output
  script(
    sh,
    'report.sh',
    '#!/bin/bash\nwhile IFS=: read user _ uid _; do\n  if [ "$uid" -ge 1000 ] && [ "$uid" -lt 60000 ]; then\n    printf "%-8s %s\\n" "$user" "$(id -gn "$user")"\n  fi\ndone < /etc/passwd\n',
  );
  assert.equal(out(sh, './report.sh'), 'student  student\n');
});

test('history keeps what was typed, so labs can check it', () => {
  const sh = new Shell();
  typed(sh, 'for i in 1 2; do\n  echo $i\ndone');
  typed(sh, "cat > s.sh <<'EOF'\necho hi\nEOF");
  out(sh, 'chmod +x s.sh && ./s.sh');
  assert.deepEqual(sh.history.slice(-3), ['for i in 1 2; do echo $i; done', "cat > s.sh <<'EOF'\necho hi\nEOF", 'chmod +x s.sh && ./s.sh']);
  // commands run inside a script are not typed history
  script(sh, 'inner.sh', 'echo from-script\n');
  out(sh, './inner.sh');
  assert.ok(!sh.history.includes('echo from-script'));
  assert.match(out(sh, 'history | tail -2'), /\.\/inner\.sh\n.*history \| tail -2\n$/);
});

test('helpers for other parts of the app', () => {
  const sh = new Shell();
  assert.equal(unaryTest(sh, '-d', '/etc'), true);
  assert.equal(unaryTest(sh, '-f', '/etc'), false);
  assert.equal(unaryTest(sh, '-z', ''), true);
  assert.equal(binaryTest(sh, '-ef', '/etc/passwd', '/etc/passwd'), true);
  assert.equal(binaryTest(sh, '-nt', '/nope', '/etc/passwd'), false);
  assert.equal(binaryTest(sh, '=', 'a', 'b'), undefined);
  assert.deepEqual(readSplit('  a  b c  ', ' \t\n', 2), ['a', 'b c']);
  assert.deepEqual(splitIFS('a:b::c', ':').fields, ['a', 'b', '', 'c']);
  assert.ok(globMatch('backup.sh', '*.sh'));
  assert.ok(!globMatch('backup.sh', '*.txt'));
  assert.ok(globMatch('file3', 'file[0-9]'));
  const s = new InputStream('one\ntwo');
  assert.deepEqual(s.readLine(), { text: 'one', eol: true });
  assert.deepEqual(s.readLine(), { text: 'two', eol: false });
  assert.equal(s.readLine(), null);
  const vars = new Map<string, string>([['x', '6']]);
  assert.equal(
    evalArith('x * 7', { get: (n) => vars.get(n) ?? '', set: (n, v) => vars.set(n, String(v)) }),
    42,
  );
  assert.equal(parseProgram('echo hi; if true; then :; fi').error, null);
  const err = parseProgram('if true; then').error;
  assert.ok(err instanceof ParseError);
  assert.equal(err.incomplete, 'construct');
  assert.equal(parseProgram('echo "open').error?.incomplete, 'quote');
  assert.equal(parseProgram('cat <<EOF').error?.incomplete, 'heredoc');
  assert.equal(parseProgram('echo a |').error?.incomplete, 'construct');
  assert.equal(parseProgram('fi').error?.incomplete, null);
  // exec and run keep working for other modules
  assert.equal(sh.exec(['echo', 'a b']).stdout, 'a b\n');
  assert.equal(sh.exec(['cat'], 'piped').stdout, 'piped');
  script(sh, 'x.sh', 'echo "args: $*"\n');
  assert.equal(sh.exec(['./x.sh', '1', '2']).stdout, 'args: 1 2\n');
  assert.equal(sh.runScript('x.sh', ['z'], '').stdout, 'args: z\n');
  assert.equal(sh.runString('echo $0-$1', 'name', ['v'], '').stdout, 'name-v\n');
});

test('broken input is reported, never thrown, and long output is cut', () => {
  const sh = new Shell();
  // a here-document body with a lone ` or an unclosed $( fails the command, like bash
  assert.equal(typed(sh, 'cat <<EOF\na `b\nEOF'), '-bash: bad substitution: no closing "`" in `b\n');
  assert.match(typed(sh, 'cat <<EOF\nx $(y\nEOF\necho $?'), /matching `\)'\n1\n$/);
  assert.equal(sh.prompt().endsWith('$ '), true);
  // deep nesting stops with a message instead of overflowing the stack
  assert.match(out(sh, 'echo ' + '$('.repeat(3000) + ')'.repeat(3000)), /practice terminal limit/);
  assert.equal(out(sh, 'echo still here'), 'still here\n');
  // the screen keeps the end of a very long output
  const long = out(sh, 'for i in $(seq 1 9000); do echo line $i; done');
  assert.ok(long.length < 60_000);
  assert.match(long, /^\[\d+ earlier lines not shown \(practice terminal limit\)\]\n/);
  assert.ok(long.endsWith('line 9000\n'));
  assert.equal(out(sh, 'seq 1 20000 | wc -l'), '20000\n');
});

test('a here-document inside $( ) may contain quotes and )', () => {
  const sh = new Shell();
  assert.equal(typed(sh, "x=$(cat <<EOF\nit's (really) done)\nEOF\n)\necho \"$x\""), "it's (really) done)\n");
  assert.equal(typed(sh, "n=$(wc -l <<-'END'\n\tone\n\ttwo\n\tEND\n); echo $n"), '2\n');
});

test('"$@" in one-word places joins the arguments with spaces', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'set -- a b c; x="$@"; y=$@; echo "$x|$y"'), 'a b c|a b c\n');
  assert.equal(out(sh, 'set -- a b; [[ "$@" == "a b" ]] && echo same'), 'same\n');
  assert.equal(out(sh, 'set -- a b; case "$@" in "a b") echo matched;; esac'), 'matched\n');
  assert.equal(typed(sh, 'set -- one two\ncat <<EOF\nargs: $@\nEOF'), 'args: one two\n');
  assert.equal(out(sh, 'set -- p q; for w in "$@"; do echo "<$w>"; done'), '<p>\n<q>\n');
});

test('return, break and continue stay inside subshells and functions', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'f() { (return 3); echo "after $?"; }; f'), 'after 3\n');
  assert.equal(out(sh, 'g() { x=$(return 4); echo "got $?"; }; g'), 'got 4\n');
  const loop = "-bash: break: only meaningful in a `for', `while', or `until' loop\n";
  assert.equal(out(sh, 'for i in 1 2; do (break); echo $i; done'), `${loop}1\n${loop}2\n`);
  assert.equal(out(sh, 'b() { break; }; for i in 1 2; do b; echo $i; done'), `${loop}1\n${loop}2\n`);
  assert.equal(out(sh, 'for i in 1 2; do echo x | while read l; do break 2; done; echo $i; done'), '1\n2\n');
  // a loop inside the function still works
  assert.equal(out(sh, 'h() { for j in a b c; do [ $j = b ] && break; echo $j; done; }; for i in 1; do h; done'), 'a\n');
});

test('aliases at the prompt, but not in scripts', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'alias'), "alias ll='ls -l'\n");
  assert.equal(out(sh, 'source ~/.bashrc && echo sourced'), 'sourced\n');
  assert.match(out(sh, 'll -d /tmp'), /^drwxrwxrwt\. .* \/tmp\n$/);
  assert.equal(out(sh, 'type ll; type -t ll; command -v ll'), "ll is aliased to `ls -l'\nalias\nalias ll='ls -l'\n");
  assert.equal(out(sh, "alias go='cd /etc; pwd'; go; cd"), '/etc\n');
  assert.equal(out(sh, "alias ls='ls -d'; ls /etc; unalias ls; ls -d /etc"), '/etc\n/etc\n');
  assert.equal(out(sh, "alias rmi='rm -i'; alias rmi"), "alias rmi='rm -i'\n");
  assert.equal(out(sh, 'unalias nope; alias nope'), '-bash: unalias: nope: not found\n-bash: alias: nope: not found\n');
  assert.equal(out(sh, "alias 'a b=1'"), "-bash: alias: `a b': invalid alias name\n");
  script(sh, '/home/student/s.sh', '#!/bin/bash\nll /\n');
  assert.equal(out(sh, './s.sh'), './s.sh: line 2: ll: command not found\n');
  assert.equal(out(sh, 'unalias -a; alias'), '');
});

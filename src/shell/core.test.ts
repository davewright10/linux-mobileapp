// Core command behaviour: sed, tr, awk, ls into pipes, journalctl, systemctl targets, sudo and su,
// host names, id and cp modes. Each case is what GNU coreutils, systemd and sudo on RHEL 10 print.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shell } from './shell';

const out = (sh: Shell, line: string) => sh.run(line).output;
const put = (sh: Shell, path: string, text: string) => sh.writeFile(path, text);

// ---------- sed ----------

test('sed: & and groups in the replacement, never JavaScript $& or $1', () => {
  const sh = new Shell();
  assert.equal(out(sh, "echo hello | sed 's/l*o/[&]/'"), 'he[llo]\n');
  assert.equal(out(sh, "echo 'a $& b $1' | sed 's/a/x/'"), 'x $& b $1\n');
  assert.equal(out(sh, "echo price | sed 's/price/$1 and $&/'"), '$1 and $price\n');
  assert.equal(out(sh, "echo 'john smith' | sed 's/\\(john\\) \\(smith\\)/\\2, \\1/'"), 'smith, john\n');
  assert.equal(out(sh, "echo 'john smith' | sed -E 's/(\\w+) (\\w+)/\\2 \\1/'"), 'smith john\n');
  assert.equal(out(sh, "echo 'john smith' | sed -r 's/(j)(o)/\\2\\1/'"), 'ojhn smith\n');
  assert.equal(out(sh, "echo 'a&b' | sed 's/&/ and /'"), 'a and b\n');
  assert.equal(out(sh, "echo ab | sed 's/b/\\&/'"), 'a&\n');
  // in a BRE ( and + are ordinary characters
  assert.equal(out(sh, "echo 'f(x)+1' | sed 's/(x)+/y/'"), 'fy1\n');
});

test('sed: delimiters, escaped slashes, flags', () => {
  const sh = new Shell();
  assert.equal(out(sh, "echo /usr/bin | sed 's/\\/usr\\/bin/\\/opt/'"), '/opt\n');
  assert.equal(out(sh, "echo /usr/bin | sed 's|/usr/bin|/opt|'"), '/opt\n');
  assert.equal(out(sh, "echo a:b | sed 's#:#/#'"), 'a/b\n');
  assert.equal(out(sh, "echo aaa | sed 's/a/b/g'"), 'bbb\n');
  assert.equal(out(sh, "echo aaa | sed 's/a/b/2'"), 'aba\n');
  assert.equal(out(sh, "echo Hello | sed 's/hello/bye/I'"), 'bye\n');
  assert.equal(out(sh, "echo Hello | sed 's/hello/bye/i'"), 'bye\n');
  assert.equal(out(sh, "echo 'x' | sed 's/x/a\\tb/'"), 'a\tb\n');
  assert.match(out(sh, "echo x | sed 's/x/y'"), /^sed: -e expression #1, char 5: unterminated `s' command\n$/);
});

test('sed: addresses, d, p, -n, several commands', () => {
  const sh = new Shell();
  put(sh, '/home/student/f', 'one\ntwo\nthree\nfour\n');
  assert.equal(out(sh, 'sed -n 2p f'), 'two\n');
  assert.equal(out(sh, "sed -n '$p' f"), 'four\n');
  assert.equal(out(sh, 'sed -n 2,3p f'), 'two\nthree\n');
  assert.equal(out(sh, "sed '/^t/d' f"), 'one\nfour\n');
  assert.equal(out(sh, "sed '1d;$d' f"), 'two\nthree\n');
  assert.equal(out(sh, "sed -n '/two/,/four/p' f"), 'two\nthree\nfour\n');
  assert.equal(out(sh, "sed '2s/two/2/' f"), 'one\n2\nthree\nfour\n');
  assert.equal(out(sh, "sed '/three/s/e/E/g' f"), 'one\ntwo\nthrEE\nfour\n');
  assert.equal(out(sh, "sed -e 's/one/1/' -e 's/two/2/' f"), '1\n2\nthree\nfour\n');
  assert.equal(out(sh, "sed 's/one/1/; s/four/4/' f"), '1\ntwo\nthree\n4\n');
  assert.equal(out(sh, "sed -n 's/o/0/p' f"), '0ne\ntw0\nf0ur\n');
  assert.equal(out(sh, "sed '2!d' f"), 'two\n');
  assert.equal(out(sh, 'sed 3q f'), 'one\ntwo\nthree\n');
  assert.equal(out(sh, "sed -n '/^#/!p' f | wc -l"), '4\n');
});

test('sed -i edits the file in place, -i.bak keeps a backup', () => {
  const sh = new Shell();
  put(sh, '/home/student/c.conf', 'Port 22\n#PermitRootLogin yes\n');
  assert.equal(out(sh, "sed -i 's/^Port 22$/Port 2222/' c.conf"), '');
  assert.equal(out(sh, 'cat c.conf'), 'Port 2222\n#PermitRootLogin yes\n');
  assert.equal(out(sh, "sed -i.bak '/^#/d' c.conf"), '');
  assert.equal(out(sh, 'cat c.conf'), 'Port 2222\n');
  assert.equal(out(sh, 'cat c.conf.bak'), 'Port 2222\n#PermitRootLogin yes\n');
});

// ---------- tr ----------

test('tr: ranges, classes, escapes, -d, -s and -c', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'echo hello | tr a-z A-Z'), 'HELLO\n');
  assert.equal(out(sh, "echo Hello | tr '[:upper:]' '[:lower:]'"), 'hello\n');
  assert.equal(out(sh, "echo hello | tr '[:lower:]' '[:upper:]'"), 'HELLO\n');
  assert.equal(out(sh, "echo 'a b c' | tr ' ' '\\n'"), 'a\nb\nc\n');
  assert.equal(out(sh, "printf 'a\\tb\\n' | tr '\\t' ,"), 'a,b\n');
  assert.equal(out(sh, "echo 'a\\b' | tr '\\\\' /"), 'a/b\n');
  assert.equal(out(sh, "echo 'abc123' | tr -d '[:digit:]'"), 'abc\n');
  assert.equal(out(sh, "echo 'abc123' | tr -d '[:alpha:]'"), '123\n');
  assert.equal(out(sh, "echo 'a   b    c' | tr -s ' '"), 'a b c\n');
  assert.equal(out(sh, "echo 'a  b' | tr -s '[:space:]' '\\n'"), 'a\nb\n');
  assert.equal(out(sh, "echo 'abc-123' | tr -cd '[:digit:]\\n'"), '123\n');
  assert.equal(out(sh, "echo 'a1b2' | tr -c '[:digit:]\\n' x"), 'x1x2\n');
  assert.equal(out(sh, 'echo aabbcc | tr -s ab'), 'abcc\n');
  assert.match(out(sh, 'echo x | tr'), /^tr: missing operand\n/);
});

// ---------- awk ----------

test('awk: -F, fields, patterns and comparisons', () => {
  const sh = new Shell();
  assert.equal(out(sh, "awk -F: '$3 >= 1000 { print $1 }' /etc/passwd"), 'student\n');
  assert.equal(out(sh, "awk -F: '$1 ~ /^ro/ { print $7 }' /etc/passwd"), '/bin/bash\n');
  assert.equal(out(sh, "awk -F ':' 'NR==1 { print $1, $NF }' /etc/passwd"), 'root /bin/bash\n');
  assert.equal(out(sh, "awk -F, '{ print $2 }' <<< 'a,b,c'"), 'b\n');
  assert.equal(out(sh, "awk 'NR>1 { print $1 }' servers.txt | head -2"), 'web02\ndb01\n');
  assert.equal(out(sh, "awk '!/rhel/ { print $1 }' servers.txt"), 'dev01\n');
  assert.equal(out(sh, "awk '$3 == \"rhel10\" && $4 != \"test\" { print $1 }' servers.txt"), 'web01\nweb02\n');
  assert.equal(out(sh, "awk '$4 == \"test\" || $3 == \"fedora\" { n++ } END { print n }' servers.txt"), '3\n');
  assert.equal(out(sh, "awk '/db/ { print $1 }' servers.txt"), 'db01\n');
  assert.equal(out(sh, "echo 'a b c' | awk '{ print $0; print NF; print $NF }'"), 'a b c\n3\nc\n');
});

test('awk: BEGIN, END, variables, printf and string functions', () => {
  const sh = new Shell();
  assert.equal(out(sh, "awk 'BEGIN { print \"start\" } END { print NR }' servers.txt"), 'start\n6\n');
  assert.equal(out(sh, "awk '{ s += length($1) } END { print s }' servers.txt"), '30\n');
  assert.equal(out(sh, "awk 'BEGIN { x = 5; x++; x += 2; print x }'"), '8\n');
  assert.equal(out(sh, "awk '{ print toupper($1) \"-\" tolower(\"ABC\") }' <<< 'web'"), 'WEB-abc\n');
  assert.equal(out(sh, "awk 'BEGIN { printf \"%-5s|%3d|%.2f\\n\", \"ab\", 7, 3.14159 }'"), 'ab   |  7|3.14\n');
  assert.equal(out(sh, "awk 'BEGIN { OFS = \"-\" } { print $1, $2 }' <<< 'a b'"), 'a-b\n');
  assert.equal(out(sh, "awk '{ print $1 $2 }' <<< 'a b'"), 'ab\n');
  assert.equal(out(sh, "awk '{ c[$3]++ } END { print c[\"rhel10\"] }' servers.txt"), '4\n');
  assert.match(out(sh, "awk '{ print $1 '"), /^awk: cmd\. line:1: /);
});

// ---------- ls into a pipe ----------

test('ls prints one name per line into a pipe, a file or $( ), and columns on the terminal', () => {
  const sh = new Shell();
  out(sh, 'mkdir d && touch d/a d/b d/c');
  assert.equal(out(sh, 'ls d'), 'a  b  c\n');
  assert.equal(out(sh, 'ls d | cat'), 'a\nb\nc\n');
  assert.equal(out(sh, 'ls d | wc -l'), '3\n');
  out(sh, 'ls d > list.txt');
  assert.equal(out(sh, 'cat list.txt'), 'a\nb\nc\n');
  assert.equal(out(sh, 'echo "$(ls d)"'), 'a\nb\nc\n');
  assert.equal(out(sh, 'ls -1 d'), 'a\nb\nc\n');
  assert.equal(out(sh, 'ls -C d | cat'), 'a  b  c\n');
  assert.equal(out(sh, 'for f in $(ls d); do echo "<$f>"; done'), '<a>\n<b>\n<c>\n');
});

// ---------- journalctl ----------

test('journalctl: priorities, units, -n, matches', () => {
  const sh = new Shell();
  const errs = out(sh, 'journalctl -p err');
  assert.match(errs, /sshd\[1520\]: error: Bind to port 2022/);
  assert.match(errs, /SELinux is preventing/);
  assert.doesNotMatch(errs, /Started Session|Failed password/);
  assert.equal(out(sh, 'journalctl -p 3 | wc -l'), '2\n');
  assert.equal(out(sh, 'journalctl -p emerg'), '-- No entries --\n');
  assert.match(out(sh, 'journalctl -p notice'), /XFS \(dm-0\): Mounting V5 Filesystem/);
  assert.match(out(sh, 'journalctl -p err..warning'), /preventing/);
  assert.equal(out(sh, 'journalctl -p loud; echo $?'), 'journalctl: Unknown log level loud\n1\n');
  const ssh = out(sh, 'journalctl -u sshd');
  assert.match(ssh, /Accepted password for student/);
  assert.match(ssh, /Bind to port 2022/);
  assert.doesNotMatch(ssh, /chronyd/);
  assert.equal(out(sh, 'journalctl -u sshd.service | wc -l'), '4\n');
  assert.equal(out(sh, 'journalctl -n 2 -o cat'), 'error: Bind to port 2022 on 0.0.0.0 failed: Permission denied.\nSELinux is preventing /usr/sbin/sshd from name_bind access on the tcp_socket port 2022.\n');
  assert.equal(out(sh, 'journalctl -n1 -o cat'), 'SELinux is preventing /usr/sbin/sshd from name_bind access on the tcp_socket port 2022.\n');
  assert.match(out(sh, 'journalctl -r -n 1'), /setroubleshoot/);
  assert.match(out(sh, 'journalctl -g makecache -o cat'), /^Starting dnf-makecache\.service - dnf makecache\.\.\.\nFinished /);
  assert.equal(out(sh, 'journalctl sshd; echo $?'), "journalctl: Failed to add match 'sshd': Invalid argument\n1\n");
  assert.match(out(sh, 'journalctl _COMM=chronyd'), /Selected source/);
  assert.match(out(sh, 'journalctl --since "2000-01-01" --until "2000-01-02"'), /^-- No entries --\n$/);
  assert.equal(out(sh, 'journalctl --since nonsense; echo $?'), 'journalctl: Failed to parse timestamp: nonsense\n1\n');
  const follow = out(sh, 'journalctl -f');
  assert.equal(follow.split('\n').filter((l) => /^Oct/.test(l)).length, 10);
  assert.match(follow, /Ctrl\+C/);
});

test('journalctl: users outside wheel, adm and systemd-journal see nothing', () => {
  const sh = new Shell();
  out(sh, 'sudo useradd bob');
  assert.equal(out(sh, 'sudo -u bob journalctl'), "Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal', 'wheel' can see all messages.\n      Pass -q to turn off this notice.\n-- No entries --\n");
  assert.equal(out(sh, 'sudo -u bob journalctl -q'), '');
  out(sh, 'sudo groupadd systemd-journal && sudo usermod -aG systemd-journal bob');
  assert.match(out(sh, 'sudo -u bob journalctl -p err'), /preventing/);
});

test('journalctl finds the errors of a boot that stopped in emergency mode', () => {
  const sh = new Shell();
  out(sh, "echo '/dev/vgdata/lvdata /data xfs defaults 0 0' | sudo tee -a /etc/fstab");
  out(sh, 'sudo mkdir /data');
  assert.match(out(sh, 'sudo reboot'), /emergency mode/);
  const errs = out(sh, 'journalctl -p err -b');
  assert.match(errs, /systemd\[1\]: Timed out waiting for device dev-vgdata-lvdata\.device - \/dev\/vgdata\/lvdata\./);
  assert.doesNotMatch(errs, /Linux version|Reached target/);
  const xb = out(sh, 'journalctl -xb');
  assert.match(xb, /kernel: Linux version /);
  assert.match(xb, /Dependency failed for data\.mount - \/data\.\n░░ Subject: A start job for unit data\.mount has failed\n░░ Defined-By: systemd\n/);
  assert.match(xb, /Dependency failed for local-fs\.target - Local File Systems\.\n░░ Subject: A start job for unit local-fs\.target has failed\n/);
  assert.match(xb, /The job identifier is \d+ and the job result is dependency\./);
  assert.match(xb, /Reached target emergency\.target - Emergency Mode\./);
  // the journal of this boot only: the older messages are gone with the volatile journal
  assert.doesNotMatch(xb, /Started Session 1 of User student/);
  assert.match(out(sh, 'journalctl -p warning -b'), /Dependency failed for local-fs\.target/);
  assert.match(out(sh, 'systemctl --failed'), /● data\.mount loaded failed failed \/data/);
  assert.equal(out(sh, 'systemctl is-failed data.mount'), 'failed\n');
});

test('journalctl -b -1 needs a persistent journal', () => {
  const sh = new Shell();
  out(sh, 'sudo reboot');
  const r = out(sh, 'journalctl -b -1');
  assert.match(r, /^Specifying boot ID or boot offset has no effect, no persistent journal was found\.\n/);
  assert.match(r, /kernel: Linux version/);
  assert.doesNotMatch(r, /Started Session 1/);
  assert.equal(out(sh, 'journalctl --list-boots | wc -l'), '2\n');
  // mkdir /var/log/journal and restart journald: from now on boots are kept
  out(sh, 'sudo mkdir /var/log/journal && sudo systemctl restart systemd-journald');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'journalctl --list-boots | wc -l'), '3\n');
  assert.match(out(sh, 'journalctl --list-boots'), /^IDX BOOT ID {26}FIRST ENTRY {17}LAST ENTRY\n -1 [0-9a-f]{32} \w{3} \d{4}-\d\d-\d\d /);
  assert.match(out(sh, 'journalctl -b -1 -o cat | head -1'), /^Linux version /);
  assert.equal(out(sh, 'journalctl -b -2; echo $?'), 'Data from the specified boot (-2) is not available: No such boot ID in journal\n1\n');
  const all = out(sh, 'journalctl');
  assert.match(all, /\n-- Boot [0-9a-f]{32} --\n/);
  // without the directory the next boot starts a volatile journal again
  out(sh, 'sudo rm -r /var/log/journal');
  assert.equal(out(sh, 'journalctl --list-boots | wc -l'), '2\n');
});

test('journalctl: Storage=persistent in a drop-in creates /var/log/journal', () => {
  const sh = new Shell();
  out(sh, 'sudo mkdir -p /etc/systemd/journald.conf.d');
  out(sh, "printf '[Journal]\\nStorage=persistent\\n' | sudo tee /etc/systemd/journald.conf.d/persist.conf");
  assert.equal(out(sh, 'ls -d /var/log/journal'), "ls: cannot access '/var/log/journal': No such file or directory\n");
  out(sh, 'sudo systemctl restart systemd-journald');
  assert.equal(out(sh, 'ls -d /var/log/journal'), '/var/log/journal\n');
  out(sh, 'sudo reboot');
  assert.doesNotMatch(out(sh, 'journalctl -b -1 2>&1'), /no persistent journal/);
});

// ---------- systemctl targets and -q ----------

test('systemctl is-active, is-enabled and is-failed with -q print nothing', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'systemctl is-active -q sshd; echo $?'), '0\n');
  assert.equal(out(sh, 'systemctl is-active --quiet nosuch; echo $?'), '3\n');
  assert.equal(out(sh, 'systemctl is-active sshd nosuch; echo $?'), 'active\ninactive\n3\n');
  assert.equal(out(sh, 'systemctl -q is-enabled fstrim.timer; echo $?'), '1\n');
  assert.equal(out(sh, 'systemctl is-enabled --quiet sshd; echo $?'), '0\n');
  assert.equal(out(sh, 'systemctl is-failed sshd; echo $?'), 'active\n1\n');
  assert.equal(out(sh, 'systemctl is-failed -q sshd; echo $?'), '1\n');
  assert.equal(out(sh, 'if systemctl is-active -q sshd; then echo up; fi'), 'up\n');
  assert.equal(out(sh, 'systemctl is-active multi-user.target graphical.target'), 'active\ninactive\n');
  assert.equal(out(sh, 'systemctl get-default'), 'multi-user.target\n');
});

test('systemctl isolate, rescue and default switch the running target', () => {
  const sh = new Shell();
  assert.match(out(sh, 'systemctl isolate rescue.target'), /^Failed to start rescue\.target: Interactive authentication required\./);
  assert.equal(out(sh, 'sudo systemctl isolate network.target'), 'Failed to start network.target: Operation refused, unit may not be isolated.\n');
  assert.equal(out(sh, 'sudo systemctl isolate nosuch.target'), 'Failed to start nosuch.target: Unit nosuch.target not found.\n');
  out(sh, 'sudo systemctl start httpd 2>/dev/null; sudo systemctl isolate graphical');
  assert.equal(sh.state.kernel.bootTarget, 'graphical.target');
  assert.equal(out(sh, 'systemctl is-active graphical.target multi-user.target'), 'active\nactive\n');
  const r = out(sh, 'sudo systemctl rescue; echo not reached');
  assert.match(r, /The system is going down to rescue mode NOW!/);
  assert.match(r, /You are in rescue mode\. After logging in, type "journalctl -xb" to view\nsystem logs/);
  assert.doesNotMatch(r, /not reached/);
  assert.equal(sh.state.kernel.bootTarget, 'rescue.target');
  assert.equal(sh.prompt(), '[root@server1 ~]# ');
  assert.equal(out(sh, 'systemctl is-active sshd; systemctl is-active rescue.target'), 'inactive\nactive\n');
  assert.equal(sh.state.kernel.boots, 0, 'no reboot');
  assert.match(out(sh, 'systemctl default'), /reached multi-user\.target/);
  assert.equal(sh.state.kernel.bootTarget, 'multi-user.target');
  assert.equal(sh.prompt(), '[student@server1 ~]$ ');
  assert.equal(out(sh, 'systemctl is-active sshd'), 'active\n');
  // exit in the rescue shell goes on to the default target
  out(sh, 'sudo systemctl isolate emergency');
  assert.equal(sh.state.kernel.emergency, true);
  out(sh, 'exit');
  assert.equal(sh.state.kernel.bootTarget, 'multi-user.target');
  assert.equal(sh.state.kernel.emergency, false);
  assert.equal(sh.user.name, 'student');
});

test('systemctl default from emergency mode needs every /etc/fstab line to mount', () => {
  const sh = new Shell();
  out(sh, "echo '/dev/vgdata/lvdata /data xfs defaults 0 0' | sudo tee -a /etc/fstab");
  out(sh, 'sudo mkdir /data && sudo reboot');
  assert.equal(sh.state.kernel.emergency, true);
  assert.equal(out(sh, 'systemctl default'), "A dependency job for multi-user.target failed. See 'journalctl -xe' for details.\n");
  assert.equal(sh.state.kernel.emergency, true);
  out(sh, "sed -i '/lvdata/d' /etc/fstab");
  assert.match(out(sh, 'systemctl default'), /logged in as student again/);
  assert.equal(sh.state.kernel.emergency, false);
  assert.equal(sh.state.kernel.bootTarget, 'multi-user.target');
});

// ---------- sudo and su ----------

test('sudo uses secure_path from /etc/sudoers, not the PATH of the caller', () => {
  const sh = new Shell();
  assert.match(out(sh, 'sudo cat /etc/sudoers'), /^Defaults {4}secure_path = \/sbin:\/bin:\/usr\/sbin:\/usr\/bin$/m);
  assert.match(out(sh, 'sudo cat /etc/sudoers'), /^%wheel\tALL=\(ALL\)\tALL$/m);
  out(sh, "printf '#!/bin/bash\\necho mycmd as $(whoami)\\n' > m.sh");
  out(sh, "sudo cp m.sh /usr/local/bin/mycmd && sudo chmod 755 /usr/local/bin/mycmd");
  assert.equal(out(sh, 'mycmd'), 'mycmd as student\n');
  assert.equal(out(sh, 'sudo mycmd; echo $?'), 'sudo: mycmd: command not found\n1\n');
  assert.equal(out(sh, 'sudo /usr/local/bin/mycmd'), 'mycmd as root\n');
  assert.equal(out(sh, 'cd /usr/local/bin && sudo ./mycmd; cd'), 'mycmd as root\n');
  assert.equal(out(sh, 'sudo bash -c \'echo $PATH\''), '/sbin:/bin:/usr/sbin:/usr/bin\n');
  assert.equal(out(sh, 'echo $PATH'), '/home/student/.local/bin:/home/student/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin\n');
  // a login shell (sudo -i) reads root's profile, whose PATH has /usr/local/bin
  assert.equal(out(sh, 'sudo -i mycmd'), 'mycmd as root\n');
  assert.equal(out(sh, 'sudo whoami; whoami'), 'root\nstudent\n');
  assert.equal(out(sh, 'sudo nosuchcommand'), 'sudo: nosuchcommand: command not found\n');
});

test('sudo -u, -i, -s and -l', () => {
  const sh = new Shell();
  out(sh, 'sudo useradd anna');
  assert.equal(out(sh, 'sudo -u anna whoami'), 'anna\n');
  assert.equal(out(sh, 'sudo -u anna id -un; whoami'), 'anna\nstudent\n');
  assert.equal(out(sh, 'sudo --user=anna whoami'), 'anna\n');
  assert.equal(out(sh, 'sudo -u nobody true; echo $?'), 'sudo: unknown user nobody\nsudo: error initializing audit plugin sudoers_audit\n1\n');
  assert.equal(out(sh, 'sudo -iu anna pwd'), '/home/anna\n');
  assert.equal(out(sh, 'cd /tmp; sudo -s pwd; cd'), '/tmp\n');
  const l = out(sh, 'sudo -l');
  assert.match(l, /^Matching Defaults entries for student on server1:\n {4}!visiblepw, always_set_home, /);
  assert.match(l, /secure_path=\/sbin\\:\/bin\\:\/usr\/sbin\\:\/usr\/bin\n\nUser student may run the following commands on server1:\n {4}\(ALL\) ALL\n$/);
  assert.equal(out(sh, 'sudo -l systemctl'), '/usr/bin/systemctl\n');
  assert.equal(out(sh, 'sudo -l -U anna'), 'User anna is not allowed to run sudo on server1.\n');
  assert.equal(out(sh, 'sudo -u anna sudo -l'), 'Sorry, user anna may not run sudo on server1.\n');
  assert.equal(out(sh, 'sudo -u anna sudo ls'), 'anna is not in the sudoers file.  This incident will be reported.\n');
  // sudo -i stays until exit, and the directory of the caller never changes
  out(sh, 'sudo -i');
  assert.equal(sh.prompt(), '[root@server1 ~]# ');
  assert.equal(out(sh, 'exit'), 'logout\n');
  assert.equal(out(sh, 'sudo cd /root; pwd'), '/home/student\n');
  assert.match(out(sh, 'sudo'), /^usage: sudo -h \| -K \| -k \| -V\n/);
});

test('sudo follows the rules in /etc/sudoers.d, and a syntax error locks sudo', () => {
  const sh = new Shell();
  out(sh, 'sudo useradd anna');
  out(sh, "echo 'anna ALL=(root) /usr/bin/systemctl status *, /usr/bin/cat' | sudo tee /etc/sudoers.d/anna");
  assert.equal(out(sh, 'sudo visudo -c'), '/etc/sudoers: parsed OK\n/etc/sudoers.d/anna: parsed OK\n');
  assert.match(out(sh, 'sudo -u anna sudo -l'), /User anna may run the following commands on server1:\n {4}\(root\) \/usr\/bin\/systemctl status \*, \/usr\/bin\/cat\n$/);
  assert.match(out(sh, 'sudo -u anna sudo systemctl status sshd'), /^● sshd\.service/);
  assert.equal(
    out(sh, 'sudo -u anna sudo systemctl stop sshd'),
    "Sorry, user anna is not allowed to execute '/usr/bin/systemctl stop sshd' as root on server1.example.com.\n",
  );
  assert.equal(sh.state.services.sshd.active, true);
  assert.equal(out(sh, 'sudo -u anna sudo cat /etc/hostname'), 'server1.example.com\n');
  // commands in sudoers must be full paths
  out(sh, "echo 'anna ALL=(ALL) systemctl' > anna.sudo");
  assert.match(out(sh, 'visudo -c -f anna.sudo; echo $?'), /syntax error near line 1 <<<\n.*\n1\n$/);
  out(sh, 'sudo cp anna.sudo /etc/sudoers.d/anna');
  assert.match(out(sh, 'sudo ls; echo $?'), /^>>> \/etc\/sudoers\.d\/anna: syntax error near line 1 <<<\nsudo: parse error in \/etc\/sudoers\.d\/anna near line 1\nsudo: no valid sudoers sources found, quitting\nsudo: error initializing audit plugin sudoers_audit\n.*Reset[^\n]*\n1\n$/s);
});

test('su - USER -c, su -c CMD USER, and su to an account without a shell', () => {
  const sh = new Shell();
  out(sh, 'sudo useradd anna');
  assert.equal(out(sh, "sudo su - anna -c 'whoami; pwd'"), 'anna\n/home/anna\n');
  assert.equal(out(sh, "sudo su -c 'whoami' anna"), 'anna\n');
  assert.equal(out(sh, "cd /tmp; sudo su anna -c pwd; cd"), '/tmp\n');
  assert.equal(out(sh, "sudo su -c 'exit 3' anna; echo $?"), '3\n');
  assert.equal(sh.user.name, 'student');
  assert.equal(out(sh, 'sudo su - apache; echo $?'), 'This account is currently not available.\n1\n');
  assert.equal(out(sh, 'sudo su nosuch'), 'su: user nosuch does not exist or the user entry does not contain all the required fields\n');
  assert.match(out(sh, 'su -'), /^su: Authentication failure\n/);
  assert.match(out(sh, 'su - anna'), /^su: Authentication failure\n/, 'anna has no password yet');
  out(sh, 'sudo su - anna');
  assert.equal(sh.prompt(), '[anna@server1 ~]$ ');
  assert.equal(out(sh, 'exit'), 'logout\n');
  assert.equal(sh.user.name, 'student');
});

// ---------- the file system and PATH ----------

test('/usr/local and the RHEL 10 PATH', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'ls /usr/local | cat'), 'bin\netc\ngames\ninclude\nlib\nlib64\nlibexec\nsbin\nshare\nsrc\n');
  assert.equal(out(sh, 'echo $PATH'), '/home/student/.local/bin:/home/student/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin\n');
  out(sh, 'sudo -i');
  assert.equal(out(sh, 'echo $PATH'), '/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin\n');
});

// ---------- host names ----------

test('hostname sets the transient name until a reboot, hostnamectl set-hostname for good', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'hostname'), 'server1.example.com\n');
  assert.equal(out(sh, 'hostname -s'), 'server1\n');
  assert.equal(out(sh, 'hostname web1'), 'hostname: you must be root to change the host name\n');
  out(sh, 'sudo hostname web1');
  assert.equal(out(sh, 'hostname; uname -n; cat /etc/hostname'), 'web1\nweb1\nserver1.example.com\n');
  assert.equal(sh.prompt(), '[student@web1 ~]$ ');
  assert.match(out(sh, 'hostnamectl'), /^ {3}Static hostname: server1\.example\.com\nTransient hostname: web1\n/);
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'hostname'), 'server1.example.com\n');
  out(sh, 'sudo hostnamectl set-hostname web2.example.com');
  assert.equal(out(sh, 'hostname; cat /etc/hostname'), 'web2.example.com\nweb2.example.com\n');
  assert.equal(sh.state.hostname, 'web2.example.com');
  out(sh, 'sudo reboot');
  assert.equal(out(sh, 'hostname'), 'web2.example.com\n');
  assert.equal(out(sh, 'hostnamectl set-hostname x'), 'Could not set static hostname: Access denied\n');
  assert.equal(out(sh, 'hostnamectl --static'), 'web2.example.com\n');
});

test('hostnamectl shows the running kernel', () => {
  const sh = new Shell();
  const st = out(sh, 'hostnamectl');
  assert.match(st, /^ Static hostname: server1\.example\.com\n {7}Icon name: computer-vm\n/);
  assert.match(st, new RegExp(`\\n {10}Kernel: Linux ${sh.state.kernel.running.replace(/\./g, '\\.')}\\n`));
  assert.match(st, /\nOperating System: Red Hat Enterprise Linux 10\.0 \(Coughlan\)\n/);
  sh.state.kernel.running = '6.12.0-99.el10.x86_64';
  assert.match(out(sh, 'hostnamectl'), /Kernel: Linux 6\.12\.0-99\.el10\.x86_64\n/);
});

// ---------- id ----------

test('id with an empty or unknown user name fails', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'id ""; echo $?'), "id: '': no such user\n1\n");
  assert.equal(out(sh, 'id nosuch; echo $?'), "id: 'nosuch': no such user\n1\n");
  assert.equal(out(sh, 'id -u ""; echo $?'), "id: '': no such user\n1\n");
  assert.equal(out(sh, 'id -un'), 'student\n');
  assert.equal(out(sh, 'id -u root'), '0\n');
});

// ---------- cp and the umask ----------

test('cp: a new file gets the source mode minus the umask; -p and -a keep it; an existing file keeps its mode', () => {
  const sh = new Shell();
  out(sh, 'touch src && chmod 777 src');
  out(sh, 'cp src new1');
  assert.match(out(sh, 'ls -l new1'), /^-rwxrwxr-x\. /, 'umask 0002');
  out(sh, 'umask 077; cp src new2; umask 002');
  assert.match(out(sh, 'ls -l new2'), /^-rwx------\. /);
  out(sh, 'cp -p src new3; cp -a src new4');
  assert.match(out(sh, 'ls -l new3'), /^-rwxrwxrwx\. /);
  assert.match(out(sh, 'ls -l new4'), /^-rwxrwxrwx\. /);
  out(sh, 'touch old && chmod 600 old && cp src old');
  assert.match(out(sh, 'ls -l old'), /^-rw-------\. /);
  out(sh, 'mkdir -m 777 dir && cp -r dir dir2');
  assert.match(out(sh, 'ls -ld dir2'), /^drwxrwxr-x\. /);
  out(sh, 'chmod 644 src && sudo cp src /tmp/byroot');
  assert.match(out(sh, 'ls -l /tmp/byroot'), /^-rw-r--r--\. 1 root root /);
});

test('echo options and escapes work like bash', () => {
  const sh = new Shell();
  const out = (l: string) => sh.run(l).output;
  assert.equal(out(String.raw`echo -e "a\tb\nc"`), 'a\tb\nc\n');
  assert.equal(out(String.raw`echo -ne "x\n"; echo -en "y"; echo`), 'x\ny\n');
  assert.equal(out(String.raw`echo -e "stop\c here"`), 'stop');
  assert.equal(out(String.raw`echo -e "\x41\0102\\"`), 'AB\\\n');
  assert.equal(out(String.raw`echo -e 'q\"\q'`), 'q\\"\\q\n');
  assert.equal(out(String.raw`echo -E "a\tb"; echo "a\tb"`), 'a\\tb\na\\tb\n');
  assert.equal(out('echo -nx hi; echo -- -n'), '-nx hi\n-- -n\n');
});

test('date prints the server clock and +FORMAT', () => {
  const sh = new Shell();
  const out = (l: string) => sh.run(l).output;
  assert.match(out('date'), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d [AP]M E[DS]T \d{4}\n$/);
  assert.match(out('date +%F'), /^\d{4}-\d\d-\d\d\n$/);
  assert.equal(out('date -u -d @0'), 'Thu Jan  1 12:00:00 AM UTC 1970\n');
  assert.equal(out('date -u -d @86399 "+%Y-%m-%d %H:%M:%S %j %a %A %b %B %e %-d %s %%"'), '1970-01-01 23:59:59 001 Thu Thursday Jan January  1 1 86399 %\n');
  assert.equal(out('date -d "2026-07-04 14:05" "+%T %R %I %p %Z %z %:z"'), '14:05:00 14:05 02 PM EDT -0400 -04:00\n');
  assert.equal(out('date -d 2026-01-05 +%D_%u_%w'), '01/05/26_1_1\n');
  assert.equal(out('date -d 2026-01-05 -I; date -u -d @0 -Iseconds'), '2026-01-05\n1970-01-01T00:00:00+00:00\n');
  assert.equal(out('date -u -d @0 -R'), 'Thu, 01 Jan 1970 00:00:00 +0000\n');
  assert.equal(out(`[ "$(date -d yesterday +%s)" -lt "$(date +%s)" ] && echo earlier`), 'earlier\n');
  assert.equal(out('date -d bogus'), 'date: invalid date ‘bogus’\n');
  out('sudo timedatectl set-timezone Europe/Amsterdam');
  assert.equal(out('date -d "2026-07-01 12:00" +%H:%Z'), '12:CEST\n');
  assert.equal(out('date -u -d "2026-07-01 12:00" +%H:%Z'), '12:UTC\n');
});

test('uptime starts again at a reboot; ls -a shows the real parent; sestatus after SELinux is disabled', () => {
  const sh = new Shell();
  const out = (l: string) => sh.run(l).output;
  assert.match(out('uptime'), /^ \d\d:\d\d:\d\d up 3 days,  4:11,  1 user,  load average: [\d., ]+\n$/);
  assert.equal(out('uptime -p'), 'up 3 days, 4 hours, 11 minutes\n');
  assert.match(out('uptime -s'), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n$/);
  assert.match(out('ls -la /home/student'), /\n\S+ \d+ student student .* \.\n\S+ \d+ root root .* \.\.\n/);
  out('sudo reboot');
  assert.match(out('uptime'), / up 0 min, /);
  assert.equal(out('uptime -p'), 'up 0 minutes\n');
  sh.state.selinux = 'Disabled';
  assert.equal(out('sestatus'), 'SELinux status:                 disabled\n');
});

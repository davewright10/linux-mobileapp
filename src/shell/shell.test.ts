import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shell } from './shell';

const out = (sh: Shell, line: string) => sh.run(line).output;

test('navigation and listing', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'pwd'), '/home/student\n');
  assert.match(out(sh, 'ls'), /notes\.txt/);
  out(sh, 'cd /etc');
  assert.equal(sh.prompt(), '[student@server1 etc]$ ');
  assert.match(out(sh, 'cat os-release'), /Red Hat Enterprise Linux 10/);
  out(sh, 'cd');
  assert.equal(sh.cwd, '/home/student');
  assert.match(out(sh, 'cd /root'), /Permission denied/);
});

test('files, redirection and pipes', () => {
  const sh = new Shell();
  out(sh, 'mkdir -p projects/a/b && echo hello > projects/a/b/f.txt');
  assert.equal(out(sh, 'cat projects/a/b/f.txt'), 'hello\n');
  out(sh, 'echo world >> projects/a/b/f.txt');
  assert.equal(out(sh, 'wc -l projects/a/b/f.txt'), '2 projects/a/b/f.txt\n');
  assert.equal(out(sh, 'grep rhel10 servers.txt | wc -l'), '4\n');
  assert.equal(out(sh, "cut -d: -f1 /etc/passwd | head -n 2"), 'root\nbin\n');
  out(sh, 'cp -r projects backup && rm -r projects');
  assert.ok(sh.exists('backup/a/b/f.txt'));
  assert.ok(!sh.exists('projects'));
  assert.match(out(sh, 'ls nothere'), /No such file or directory/);
  out(sh, 'ls nothere 2> err.txt');
  assert.match(out(sh, 'cat err.txt'), /cannot access/);
  assert.equal(out(sh, 'ls *.txt'), 'err.txt  notes.txt  servers.txt\n');
});

test('links', () => {
  const sh = new Shell();
  out(sh, 'ln notes.txt hard && ln -s notes.txt soft');
  assert.match(out(sh, 'ls -l soft'), /^l.* soft -> notes\.txt/);
  assert.match(out(sh, 'ls -l notes.txt'), /^-rw-r--r--\. 2 /);
  out(sh, 'rm notes.txt');
  assert.match(out(sh, 'cat hard'), /Welcome/);
  assert.match(out(sh, 'cat soft'), /No such file/);
});

test('users, groups and sudo', () => {
  const sh = new Shell();
  assert.match(out(sh, 'useradd anna'), /Permission denied/);
  out(sh, 'sudo useradd -u 2000 -G wheel anna');
  assert.match(out(sh, 'id anna'), /uid=2000\(anna\) gid=2000\(anna\) groups=2000\(anna\),10\(wheel\)/);
  out(sh, 'sudo groupadd sales && sudo usermod -aG sales anna');
  assert.match(out(sh, 'groups anna'), /anna : anna wheel sales/);
  out(sh, 'sudo -i');
  assert.equal(sh.prompt(), '[root@server1 ~]# ');
  assert.match(out(sh, 'cat /etc/shadow'), /^root:/);
  out(sh, 'echo secret | passwd --stdin anna && chage -M 90 anna');
  assert.match(out(sh, 'chage -l anna'), /Maximum number of days between password change\t\t: 90/);
  out(sh, 'exit');
  assert.equal(sh.user.name, 'student');
});

test('permissions', () => {
  const sh = new Shell();
  out(sh, 'touch f && chmod 640 f');
  assert.match(out(sh, 'ls -l f'), /^-rw-r-----\./);
  out(sh, 'chmod u+x,g-r,o=r f');
  assert.match(out(sh, 'ls -l f'), /^-rwx---r--\./);
  out(sh, 'sudo mkdir /data && sudo chmod 1777 /data');
  assert.match(out(sh, 'ls -ld /data'), /^drwxrwxrwt\./);
  out(sh, 'sudo chmod 2770 /data && sudo chgrp wheel /data');
  assert.match(out(sh, 'ls -ld /data'), /^drwxrws---\. 2 root wheel/);
  assert.equal(out(sh, 'umask'), '0002\n');
  assert.equal(out(sh, 'sudo umask'), '0022\n');
  out(sh, 'sudo mkdir /srv/x');
  assert.match(out(sh, 'ls -ld /srv/x'), /^drwxr-xr-x\./);
  out(sh, 'umask 027 && touch g');
  assert.match(out(sh, 'ls -l g'), /^-rw-r-----\./);
});

test('services, packages, firewall, selinux', () => {
  const sh = new Shell();
  assert.match(out(sh, 'systemctl start sshd'), /Access denied/);
  out(sh, 'sudo dnf install -y httpd');
  out(sh, 'sudo systemctl enable --now httpd');
  assert.equal(out(sh, 'systemctl is-active httpd'), 'active\n');
  out(sh, 'sudo firewall-cmd --add-service=http --permanent');
  out(sh, 'sudo firewall-cmd --reload');
  assert.match(out(sh, 'sudo firewall-cmd --list-services'), /http/);
  out(sh, 'sudo setenforce 0');
  assert.equal(out(sh, 'getenforce'), 'Permissive\n');
});

test('control operators and tar', () => {
  const sh = new Shell();
  assert.equal(out(sh, 'false && echo no || echo yes'), 'yes\n');
  assert.equal(out(sh, 'echo $USER $HOME'), 'student /home/student\n');
  assert.equal(out(sh, "echo '$USER'"), '$USER\n');
  assert.equal(out(sh, '[ -d /etc ] && echo dir'), 'dir\n');
  out(sh, 'mkdir d && touch d/x && tar czf d.tar.gz d && rm -r d');
  assert.equal(out(sh, 'tar tzf d.tar.gz'), 'd/\nd/x\n');
  out(sh, 'tar xzf d.tar.gz');
  assert.ok(sh.exists('d/x'));
});

test('tab completion', async () => {
  const { complete } = await import('./complete');
  const sh = new Shell();
  assert.equal(complete(sh, 'syst').line, 'systemctl ');
  assert.equal(complete(sh, 'cat no').line, 'cat notes.txt ');
  assert.equal(complete(sh, 'ls /et').line, 'ls /etc/');
  assert.deepEqual(complete(sh, 'cat /etc/ho').options, ['hostname', 'hosts']);
});

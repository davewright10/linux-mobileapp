import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shell } from './shell';

const out = (sh: Shell, line: string) => sh.run(line).output;

/** A small tree in /tmp/f: a/x.txt, b/y.txt and z.log. */
function tree(): Shell {
  const sh = new Shell();
  out(sh, 'mkdir -p /tmp/f/a /tmp/f/b; touch /tmp/f/a/x.txt /tmp/f/b/y.txt /tmp/f/z.log');
  return sh;
}

test('find tests: name, type, owner, size, permissions and depth', () => {
  const sh = tree();
  assert.equal(out(sh, "find /tmp/f -name '*.txt'"), '/tmp/f/a/x.txt\n/tmp/f/b/y.txt\n');
  assert.equal(out(sh, "find /tmp/f -iname 'X.*'"), '/tmp/f/a/x.txt\n');
  assert.equal(out(sh, 'find /tmp/f -type d'), '/tmp/f\n/tmp/f/a\n/tmp/f/b\n');
  assert.equal(out(sh, 'find /tmp/f ! -type d'), '/tmp/f/a/x.txt\n/tmp/f/b/y.txt\n/tmp/f/z.log\n');
  assert.equal(out(sh, "find /tmp/f -path '*/b/*'"), '/tmp/f/b/y.txt\n');
  assert.equal(out(sh, 'find /tmp/f -maxdepth 1 -type f'), '/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /tmp/f -mindepth 2'), '/tmp/f/a/x.txt\n/tmp/f/b/y.txt\n');
  assert.equal(out(sh, 'find /tmp/f \\( -name a -o -name b \\)'), '/tmp/f/a\n/tmp/f/b\n');
  assert.equal(out(sh, 'find /tmp/f -name a -prune -o -print'), '/tmp/f\n/tmp/f/b\n/tmp/f/b/y.txt\n/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /tmp/f -user student -type f -name z.log'), '/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /home -user student -name notes.txt'), '/home/student/notes.txt\n');
  // sizes are rounded up to whole units, so -size -1k only matches empty files
  out(sh, 'seq 1 500 > /tmp/f/a/x.txt');
  assert.equal(out(sh, 'find /tmp/f -type f -size +1k'), '/tmp/f/a/x.txt\n');
  assert.equal(out(sh, 'find /tmp/f -type f -size -1k'), '/tmp/f/b/y.txt\n/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /tmp/f -type f -empty'), '/tmp/f/b/y.txt\n/tmp/f/z.log\n');
  out(sh, 'chmod 4755 /tmp/f/z.log; chmod o+w /tmp/f/b/y.txt');
  assert.equal(out(sh, 'find /tmp/f -perm -4000'), '/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /tmp/f -perm -u+s'), '/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /tmp/f -type f -perm /o=w'), '/tmp/f/b/y.txt\n');
  assert.equal(out(sh, 'find /tmp/f -perm 4755'), '/tmp/f/z.log\n');
  assert.equal(out(sh, 'find /tmp/f -mmin -5 -name z.log'), '/tmp/f/z.log\n');
});

test('find actions: -exec with \\; and +, -delete', () => {
  const sh = tree();
  assert.equal(out(sh, "find /tmp/f -name '*.txt' -exec echo found {} \\;"), 'found /tmp/f/a/x.txt\nfound /tmp/f/b/y.txt\n');
  assert.equal(out(sh, "find /tmp/f -name '*.txt' -exec echo {} +"), '/tmp/f/a/x.txt /tmp/f/b/y.txt\n');
  assert.equal(out(sh, "find /tmp/f -name '*.txt' -exec cp {} /tmp \\; ; ls /tmp"), 'f  x.txt  y.txt\n');
  // -exec is a test: it is true when the command succeeds
  assert.equal(out(sh, 'find /tmp/f -type f -exec false \\; -print'), '');
  assert.equal(out(sh, "find /tmp/f -name '*.log' -delete; find /tmp/f -type f"), '/tmp/f/a/x.txt\n/tmp/f/b/y.txt\n');
  assert.equal(out(sh, 'find /tmp/f -type f -exec rm {} \\; ; find /tmp/f'), '/tmp/f\n/tmp/f/a\n/tmp/f/b\n');
});

test('the exam task: copy all files a user owns', () => {
  const sh = new Shell();
  for (const c of ['sudo useradd anna', 'echo hi | sudo tee /tmp/anna.tmp /srv/anna.txt', 'sudo chown anna /tmp/anna.tmp /srv/anna.txt', 'sudo -i', 'mkdir /root/found']) out(sh, c);
  assert.equal(out(sh, 'find / -user anna -type f -exec cp {} /root/found \\;'), '');
  assert.deepEqual(out(sh, 'ls -A /root/found').trim().split(/\s+/).sort(), ['.bashrc', 'anna.tmp', 'anna.txt']);
});

test('find errors look like GNU find', () => {
  const sh = tree();
  assert.equal(out(sh, 'find /nope'), 'find: ‘/nope’: No such file or directory\n');
  assert.equal(out(sh, 'find /root'), '/root\nfind: ‘/root’: Permission denied\n');
  assert.equal(out(sh, 'find / -user nobodyhere'), 'find: ‘nobodyhere’ is not the name of a known user\n');
  assert.equal(out(sh, 'find /tmp -foo'), "find: unknown predicate `-foo'\n");
  assert.equal(out(sh, 'find /tmp -exec echo {}'), "find: missing argument to `-exec'\n");
  assert.equal(out(sh, 'find /tmp -type q'), 'find: Unknown argument to -type: q\n');
  assert.equal(out(sh, 'find /tmp -o'), "find: invalid expression; you have used a binary operator '-o' with nothing before it.\n");
  assert.match(out(sh, 'find /tmp/f -name x.txt -maxdepth 3'), /^find: warning: you have specified the global option -maxdepth after the argument -name.*\n\/tmp\/f\/a\/x.txt\n$/s);
  assert.equal(out(sh, 'find /tmp/f -name z.log 2>/dev/null; echo $?'), '/tmp/f/z.log\n0\n');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Shell } from '../shell/shell';
import { MODULES } from './index';

test('quiz answers point at a real choice', () => {
  for (const m of MODULES) {
    for (const q of m.quiz) {
      assert.ok(q.answer >= 0 && q.answer < q.choices.length, `${m.id}: ${q.q}`);
    }
  }
});

test('module ids are unique', () => {
  const ids = MODULES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

// Every lab must be solvable by typing its hints, and no task may pass before it is done.
for (const m of MODULES) {
  for (const lab of m.labs) {
    test(`lab ${lab.id} is solvable from its hints`, () => {
      const sh = new Shell();
      lab.setup?.(sh);
      lab.tasks.forEach((t, i) => {
        assert.equal(t.check(sh), false, `task ${i + 1} passes before it is attempted: ${t.text}`);
        const cmd = t.hint.split(/\s{2,}\(/)[0];
        const out = sh.run(cmd).output;
        assert.ok(t.check(sh), `task ${i + 1} "${t.text}" not passed by "${cmd}". Output:\n${out}`);
      });
    });
  }
}

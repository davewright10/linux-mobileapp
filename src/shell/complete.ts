import { COMMANDS } from './commands';
import type { Shell } from './shell';

/** Bash-style Tab completion for the last word of `line`. Returns the new line. */
export function complete(sh: Shell, line: string): { line: string; options: string[] } {
  const m = /^(.*?)(\S*)$/.exec(line)!;
  const before = m[1];
  const word = m[2];
  const isCommand = !before.trim() || /(\||&&|;|sudo)\s*$/.test(before);

  let candidates: string[];
  let prefix = '';
  if (isCommand && !word.includes('/')) {
    candidates = Object.keys(COMMANDS).filter((c) => c.startsWith(word)).sort();
  } else {
    const slash = word.lastIndexOf('/');
    prefix = slash >= 0 ? word.slice(0, slash + 1) : '';
    const partial = word.slice(slash + 1);
    try {
      const dir = sh.resolve(prefix || '.');
      if (dir.node.type !== 'dir') return { line, options: [] };
      candidates = Object.entries(dir.node.children!)
        .filter(([n]) => n.startsWith(partial) && (partial.startsWith('.') || !n.startsWith('.')))
        .map(([n, c]) => n + (c.type === 'dir' ? '/' : ''))
        .sort();
    } catch {
      return { line, options: [] };
    }
  }

  if (!candidates.length) return { line, options: [] };
  if (candidates.length === 1) {
    const done = prefix + candidates[0];
    return { line: before + done + (done.endsWith('/') ? '' : ' '), options: [] };
  }
  // extend to the longest common prefix
  let common = candidates[0];
  for (const c of candidates) while (!c.startsWith(common)) common = common.slice(0, -1);
  return { line: before + prefix + common, options: candidates };
}

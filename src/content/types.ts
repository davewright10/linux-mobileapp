import type { FsNode } from '@/shell/fs';
import type { Shell } from '@/shell/shell';

export type TrackId = 'fundamentals' | 'rhcsa';

export interface QuizQuestion {
  q: string;
  choices: string[];
  answer: number; // index into choices
  why: string; // short, plain-language explanation shown after answering
}

export interface Flashcard {
  front: string;
  back: string;
}

export interface LabTask {
  text: string;
  hint: string; // shown on request; usually the command to run
  check: (sh: Shell) => boolean;
}

export interface Lab {
  id: string;
  title: string;
  intro: string;
  setup?: (sh: Shell) => void; // runs on a fresh system before the lab starts
  tasks: LabTask[];
}

export interface Module {
  id: string; // e.g. "F3" or "R7"
  track: TrackId;
  title: string;
  courseRef: string; // which lesson/chapter in Sander's material it follows
  summary: string;
  quiz: QuizQuestion[];
  cards: Flashcard[];
  labs: Lab[];
}

export interface Track {
  id: TrackId;
  title: string;
  subtitle: string;
  course: string;
}

/** Look at a path as root, so lab checks are not blocked by permissions. */
export function peek(sh: Shell, path: string, follow = true): FsNode | null {
  const root = sh.state.users.find((u) => u.uid === 0)!;
  try {
    return sh.asUser(root, () => sh.resolve(path, follow).node);
  } catch {
    return null;
  }
}

export const userByName = (sh: Shell, name: string) => sh.state.users.find((u) => u.name === name);
export const groupByName = (sh: Shell, name: string) => sh.state.groups.find((g) => g.name === name);
export const inGroup = (sh: Shell, user: string, group: string) => {
  const g = groupByName(sh, group);
  const u = userByName(sh, user);
  return !!g && !!u && (g.members.includes(user) || u.gid === g.gid);
};
export const permBits = (n: FsNode | null) => (n ? n.mode & 0o7777 : -1);
export const ownerName = (sh: Shell, n: FsNode | null) => sh.state.users.find((u) => u.uid === n?.uid)?.name;
export const groupOf = (sh: Shell, n: FsNode | null) => sh.state.groups.find((g) => g.gid === n?.gid)?.name;
/** True if the user typed a command starting with `prefix` at some point. */
/** The commands of one history entry: its first line split at ; && || and |, each also without a leading sudo. */
function commandsOf(entry: string): string[] {
  return entry
    .split('\n')[0]
    .split(/&&|\|\||[;|]/)
    .map((c) => c.trim())
    .flatMap((c) => {
      const bare = c.replace(/^sudo\s+(?=[^-\s])/, '');
      return bare === c ? [c] : [c, bare];
    });
}

/** True if something typed matches `re`: a whole history entry, or one command in it, with or without sudo. */
export const ran = (sh: Shell, re: RegExp) => sh.history.some((h) => re.test(h) || commandsOf(h).some((c) => re.test(c)));

/** Like ran, but only what was typed after the last entry that matches `after`. */
export function ranAfter(sh: Shell, after: RegExp, re: RegExp): boolean {
  let last = -1;
  sh.history.forEach((h, i) => {
    if (after.test(h) || commandsOf(h).some((c) => after.test(c))) last = i;
  });
  return last >= 0 && sh.history.slice(last + 1).some((h) => re.test(h) || commandsOf(h).some((c) => re.test(c)));
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// Learner progress, stored on the device.
// Flashcards use a simple Leitner system: a correct answer moves a card up a box,
// and higher boxes come back less often.

const KEY = 'progress-v1';
const BOX_DAYS = [0, 1, 3, 7, 14, 30];
const DAY = 24 * 60 * 60 * 1000;

export interface CardState {
  box: number;
  due: number;
}

export interface Progress {
  quizBest: Record<string, { score: number; total: number }>;
  cards: Record<string, Record<number, CardState>>; // moduleId -> card index -> state
  labsDone: Record<string, boolean>;
}

const empty: Progress = { quizBest: {}, cards: {}, labsDone: {} };

interface Ctx {
  progress: Progress;
  recordQuiz: (moduleId: string, score: number, total: number) => void;
  recordCard: (moduleId: string, index: number, knewIt: boolean) => void;
  recordLab: (labId: string) => void;
  dueCards: (moduleId: string, count: number) => number[];
  reset: () => void;
}

const ProgressContext = createContext<Ctx | null>(null);

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<Progress>(empty);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => raw && setProgress({ ...empty, ...JSON.parse(raw) }))
      .catch(() => {});
  }, []);

  const update = useCallback((fn: (p: Progress) => Progress) => {
    setProgress((prev) => {
      const next = fn(prev);
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      progress,
      recordQuiz: (moduleId, score, total) =>
        update((p) => {
          const best = p.quizBest[moduleId];
          if (best && best.score / best.total >= score / total) return p;
          return { ...p, quizBest: { ...p.quizBest, [moduleId]: { score, total } } };
        }),
      recordCard: (moduleId, index, knewIt) =>
        update((p) => {
          const mod = { ...(p.cards[moduleId] ?? {}) };
          const cur = mod[index]?.box ?? 0;
          const box = knewIt ? Math.min(cur + 1, BOX_DAYS.length - 1) : 0;
          mod[index] = { box, due: Date.now() + BOX_DAYS[box] * DAY };
          return { ...p, cards: { ...p.cards, [moduleId]: mod } };
        }),
      recordLab: (labId) => update((p) => ({ ...p, labsDone: { ...p.labsDone, [labId]: true } })),
      dueCards: (moduleId, count) => {
        const mod = progress.cards[moduleId] ?? {};
        const now = Date.now();
        return Array.from({ length: count }, (_, i) => i).filter((i) => !mod[i] || mod[i].due <= now);
      },
      reset: () => update(() => empty),
    }),
    [progress, update],
  );

  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>;
}

export function useProgress() {
  const ctx = useContext(ProgressContext);
  if (!ctx) throw new Error('useProgress must be used inside ProgressProvider');
  return ctx;
}

/** Cards in box 3 or higher count as learned. */
export function learnedCount(p: Progress, moduleId: string) {
  return Object.values(p.cards[moduleId] ?? {}).filter((c) => c.box >= 3).length;
}

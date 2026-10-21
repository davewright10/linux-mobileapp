import { FUNDAMENTALS } from './fundamentals';
import { RHCSA } from './rhcsa';
import { Lab, Module, Track, TrackId } from './types';

export * from './types';

export const TRACKS: Track[] = [
  {
    id: 'fundamentals',
    title: 'Linux Fundamentals',
    subtitle: 'Start here if you are new to Linux',
    course: "Follows Sander van Vugt's Linux Fundamentals, 2nd Edition",
  },
  {
    id: 'rhcsa',
    title: 'RHCSA (RHEL 10)',
    subtitle: 'Prepare for the EX200 exam',
    course: "Follows Sander van Vugt's RHCSA RHEL 10 course and Cert Guide",
  },
];

export const MODULES: Module[] = [...FUNDAMENTALS, ...RHCSA];

export const modulesFor = (track: TrackId) => MODULES.filter((m) => m.track === track);
export const getModule = (id: string) => MODULES.find((m) => m.id === id);
export const getTrack = (id: string) => TRACKS.find((t) => t.id === id);
export const getLab = (id: string): { lab: Lab; module: Module } | undefined => {
  for (const m of MODULES) {
    const lab = m.labs.find((l) => l.id === id);
    if (lab) return { lab, module: m };
  }
  return undefined;
};
export const isReady = (m: Module) => m.quiz.length > 0 || m.cards.length > 0;

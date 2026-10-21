import { Platform } from 'react-native';

export const colors = {
  bg: '#0f1419',
  card: '#1a2129',
  cardPressed: '#232c36',
  border: '#2b3540',
  text: '#e6edf3',
  muted: '#8b98a5',
  accent: '#ee0000', // Red Hat red
  accentSoft: '#3a1515',
  green: '#3fb950',
  greenSoft: '#12261a',
  yellow: '#d29922',
  blue: '#58a6ff',
  terminalBg: '#0b0e11',
  terminalText: '#d1d9e0',
  prompt: '#3fb950',
};

export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Menlo, Consolas, monospace' });

export const space = (n: number) => n * 4;

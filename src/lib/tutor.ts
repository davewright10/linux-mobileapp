import AsyncStorage from '@react-native-async-storage/async-storage';
import { MODULES } from '@/content';
import { MAN_PAGES } from '@/shell/manpages';

// Talks to the tutor backend (backend/ in this repo). Set EXPO_PUBLIC_TUTOR_URL to the
// deployed Worker URL. Without it the tutor answers offline from the app's own cards.

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const TUTOR_URL = process.env.EXPO_PUBLIC_TUTOR_URL;
const APP_TOKEN = process.env.EXPO_PUBLIC_TUTOR_TOKEN;

export const tutorOnline = !!TUTOR_URL;

async function deviceId(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem('device-id');
    if (existing) return existing;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    await AsyncStorage.setItem('device-id', id);
    return id;
  } catch {
    return 'anonymous';
  }
}

export async function askTutor(messages: ChatMessage[], context?: string): Promise<string> {
  if (!TUTOR_URL) return offlineAnswer(messages[messages.length - 1]?.content ?? '');
  try {
    const res = await fetch(TUTOR_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(APP_TOKEN ? { 'x-app-token': APP_TOKEN } : {}) },
      body: JSON.stringify({ deviceId: await deviceId(), messages, context }),
    });
    const data = (await res.json()) as { reply?: string };
    return data.reply ?? 'The tutor did not answer. Please try again.';
  } catch {
    return 'I could not reach the tutor. Check your connection and try again.\n\n' + offlineAnswer(messages[messages.length - 1]?.content ?? '');
  }
}

/** Find the most relevant flashcards and command summaries for a question. */
export function offlineAnswer(question: string): string {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\-_/. ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) return 'Ask me about a command or topic, for example "what does chmod 750 do?"';

  const hits: { score: number; text: string }[] = [];
  for (const m of MODULES) {
    for (const c of m.cards) {
      const hay = `${c.front} ${c.back}`.toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? (c.front.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
      if (score) hits.push({ score, text: `**${c.front}** (${m.id})\n${c.back}` });
    }
  }
  for (const [cmd, desc] of Object.entries(MAN_PAGES)) {
    if (words.includes(cmd)) hits.push({ score: 5, text: `**${cmd}**\n${desc}` });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 3).map((h) => h.text);
  const note = '\n\n_Offline mode: these come from the app\'s flashcards. The full AI tutor answers any question once it is connected._';
  if (!top.length) return "I don't have a card about that yet." + note;
  return 'Here is what I found:\n\n' + top.join('\n\n') + note;
}

const STOP = new Set(['what', 'does', 'the', 'how', 'can', 'and', 'for', 'with', 'why', 'when', 'which', 'this', 'that', 'use', 'mean', 'means', 'difference', 'between', 'are', 'you', 'linux', 'command', 'explain', 'simply']);

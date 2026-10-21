// Linux Study tutor backend: a Cloudflare Worker that keeps the Anthropic API key off the
// phone, adds the tutor instructions, and caps how many questions each device can ask per day.

import Anthropic from '@anthropic-ai/sdk';

export interface Env {
  ANTHROPIC_API_KEY: string; // wrangler secret put ANTHROPIC_API_KEY
  APP_TOKEN?: string; // optional shared secret the app sends as x-app-token
  MODEL?: string; // defaults to claude-opus-5-5
  DAILY_LIMIT?: string; // questions per device per day, default 50
  RATE?: KVNamespace; // optional KV binding for the daily cap
}

const SYSTEM_PROMPT = `You are the tutor inside "Linux Study", an iPhone app for people learning Linux and preparing for the Red Hat Certified System Administrator (RHCSA, exam EX200) on Red Hat Enterprise Linux 10. Learners use the app alongside Sander van Vugt's Linux Fundamentals and RHCSA courses.

How to answer:
- Explain simply first, like you are talking to a smart beginner. Use an everyday analogy when it genuinely helps, then give the precise version.
- Keep it short enough to read on a phone: a few short paragraphs or a small list. Put commands in backticks or short code blocks.
- Use RHEL 10 tools and paths (dnf, systemctl, nmcli, firewall-cmd, SELinux tools, xfs). Mention when another distribution does it differently only if it matters.
- When the learner is working on a lab, guide them toward the answer with a hint or a question before giving the full command, unless they ask for the answer directly.
- If they paste terminal output, read it carefully and explain what it means and what to try next.
- For exam topics, say how the task is typically phrased on the exam and how to verify the result, since the exam is hands-on and checks the final system state.
- The app's practice terminal is a simulated RHEL 10 server, not a real one. Full-screen editors (vim, nano) are not available there.
- If you are not sure about something, say so rather than guessing.
- You may answer any question the learner asks, but keep coming back to helping them learn Linux.`;

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface TutorRequest {
  deviceId: string;
  messages: ChatTurn[];
  context?: string; // what the learner is looking at: module, lab task, recent terminal output
}

const MAX_TURNS = 20;
const MAX_CHARS = 6000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-app-token',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

function parseRequest(body: unknown): TutorRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== 'string' || !Array.isArray(b.messages) || !b.messages.length) return null;
  const messages: ChatTurn[] = [];
  for (const m of b.messages.slice(-MAX_TURNS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    messages.push({ role: m.role, content: m.content.slice(0, MAX_CHARS) });
  }
  // the conversation sent to the API must start and end with the learner
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;
  const context = typeof b.context === 'string' ? b.context.slice(0, MAX_CHARS) : undefined;
  return { deviceId: b.deviceId.slice(0, 100), messages, context };
}

async function overLimit(env: Env, deviceId: string): Promise<boolean> {
  if (!env.RATE) return false;
  const key = `${deviceId}:${new Date().toISOString().slice(0, 10)}`;
  const used = parseInt((await env.RATE.get(key)) ?? '0', 10);
  if (used >= parseInt(env.DAILY_LIMIT ?? '50', 10)) return true;
  await env.RATE.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
    if (env.APP_TOKEN && request.headers.get('x-app-token') !== env.APP_TOKEN) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const req = parseRequest(await request.json().catch(() => null));
    if (!req) return json({ error: 'Bad request' }, 400);
    if (await overLimit(env, req.deviceId)) {
      return json({ error: 'limit', reply: "You've reached today's question limit. It resets tomorrow." }, 429);
    }

    // Context goes into the latest learner turn, so the cached system prompt never changes.
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m, i) => {
      const last = i === req.messages.length - 1;
      if (!last || !req.context) return { role: m.role, content: m.content };
      return {
        role: 'user',
        content: [
          { type: 'text', text: `<app_context>\n${req.context}\n</app_context>` },
          { type: 'text', text: m.content },
        ],
      };
    });

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const response = await client.beta.messages.create({
        model: env.MODEL ?? 'claude-opus-5-5',
        max_tokens: 16000,
        output_config: { effort: 'low' }, // chat answers do well at low effort and keep cost down
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
      });

      if (response.stop_reason === 'refusal') {
        return json({ reply: "I can't help with that one. Try asking it a different way, or ask me about a Linux topic." });
      }
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return json({ reply: reply || 'Sorry, I could not come up with an answer. Please try again.' });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        return json({ error: 'busy', reply: 'The tutor is busy right now. Please try again in a minute.' }, 503);
      }
      if (error instanceof Anthropic.AuthenticationError) {
        return json({ error: 'config', reply: 'The tutor is not set up correctly (API key).' }, 500);
      }
      if (error instanceof Anthropic.APIError) {
        return json({ error: 'upstream', reply: 'The tutor hit a problem. Please try again.' }, 502);
      }
      return json({ error: 'network', reply: 'Could not reach the tutor. Please try again.' }, 502);
    }
  },
};

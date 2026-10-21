# Linux Study

An iPhone app (Expo / React Native) for learning Linux and preparing for the RHCSA (EX200, RHEL 10).
It follows the lesson order of Sander van Vugt's *Linux Fundamentals, 2nd Edition* and his
*Red Hat RHCSA RHEL 10* video course and *RHCSA 10 Cert Guide*. All quiz, flashcard and lab
content is original and mapped to the public course outlines and Red Hat's EX200 objectives.

## What's in it

- **Two tracks**: Linux Fundamentals (F1–F19) and RHCSA (R1–R26). Modules F1–F19 and R2–R12 have
  full content so far; the rest show as "coming soon".
- **Quizzes** with an explanation for every answer. 80% passes a module.
- **Flashcards** with simple spaced repetition (Leitner boxes), stored on the device.
- **Practice terminal**: a simulated RHEL 10 server (`src/shell/`) that runs fully offline, with
  ~120 commands, pipes, redirection, users/groups, permissions, sudo, systemctl (incl. timers), dnf,
  Flatpak, nmcli, ps/kill/renice, tuned-adm, cron and at, firewall-cmd, SELinux mode, tar and more. **Labs** give exam-style tasks and check the system state as you go.
- **AI tutor** powered by Claude through a small backend (`backend/`), so the API key never ships
  in the app. Without a backend configured, the tutor answers offline from the app's flashcards.

## Try it on your iPhone

1. Install **Expo Go** from the App Store.
2. On a computer with Node.js 20+:
   ```bash
   npm install
   npx expo start
   ```
3. Scan the QR code with the iPhone camera. The app opens in Expo Go.

## Connect the AI tutor

1. Create an API key at https://console.anthropic.com and a free Cloudflare account.
2. Deploy the backend:
   ```bash
   cd backend
   npm install
   npx wrangler login
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put APP_TOKEN        # any random string
   npx wrangler deploy
   ```
   Optional daily cap per device: create a KV namespace (`npx wrangler kv namespace create RATE`)
   and uncomment the binding in `backend/wrangler.toml`.
3. Create `.env` in the project root:
   ```
   EXPO_PUBLIC_TUTOR_URL=https://linux-study-tutor.<your-subdomain>.workers.dev
   EXPO_PUBLIC_TUTOR_TOKEN=<same APP_TOKEN>
   ```
4. Restart `npx expo start`.

The backend uses `claude-opus-5-5` at low effort by default (change `MODEL` in `wrangler.toml`).

## Development

```bash
npm test          # shell engine tests + checks that every lab is solvable from its hints
npm run typecheck
npx eslint src
```

Content lives in `src/content/` (`fundamentals*.ts` and `rhcsa*.ts`). Each lab task has a
`hint` (the command that solves it) and a `check` that inspects the simulated system; the content
test runs every hint and asserts the check passes.

## Project layout

```
src/app/        screens (Expo Router)
src/content/    tracks, modules, quizzes, flashcards, labs
src/shell/      the simulated RHEL 10 shell
src/lib/        progress storage, tutor client, theme
backend/        Cloudflare Worker that proxies the tutor to the Claude API
```

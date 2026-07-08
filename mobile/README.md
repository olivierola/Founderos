# FounderOS Agents — mobile app

Expo + React Native (TypeScript, expo-router) companion app. Register an agent
created in FounderOS with its **id + secret**, then chat with it.

## Run

```bash
cd mobile
npm install          # or: npx expo install   (aligns native deps to the SDK)
npx expo start       # press i / a, or scan the QR with Expo Go
```

> The real backend is wired (`lib/config.ts` → `mock: false`). Set `mock: true`
> to demo the register → chat flow with canned replies and no network.

## Flow

1. **Mes agents** (`app/index.tsx`) — the agents registered on this device.
2. **Enregistrer un agent** (`app/register.tsx`) — paste the agent **id** and
   **secret** (+ optional display name). Credentials are stored encrypted via
   `expo-secure-store`.
3. **Chat** (`app/chat/[id].tsx`) — talk to the agent.

## Structure

```
mobile/
  app/
    _layout.tsx        Stack navigator + providers + dark theme
    index.tsx          Registered agents list
    register.tsx       Register by id + secret
    chat/[id].tsx      Chat screen
  components/
    MessageBubble.tsx
  lib/
    config.ts          Supabase URL / anon key / function name / mock flag
    theme.ts           Palette
    storage.ts         SecureStore CRUD for registered agents
    agents-context.tsx App-wide agents state
    api.ts             Chat API client (+ mock)
```

## Backend (implemented)

The client calls `internal-agent-run` with `mode: "mobile_chat"` — a synchronous
path that authenticates the agent by `(agent_id, secret)` and returns a reply.
Folded into the existing function to stay under the Supabase 100-function cap.

```
POST {SUPABASE_URL}/functions/v1/internal-agent-run
headers: apikey: <anon>, Authorization: Bearer <anon>, Content-Type: application/json
body:    { "agent_id": "...", "mode": "mobile_chat", "secret": "...", "message": "...", "conversation_id": "..."? }
200:     { "reply": "...", "conversation_id": "..." }
4xx:     { "error": "invalid secret" | "unknown agent" | "mobile access is disabled ..." }

# registration verify ping:
body:    { "agent_id": "...", "mode": "mobile_chat", "secret": "...", "verify": true }  → 200 / 4xx
```

Notes:
- `mobile_chat` is single-turn (agent persona/instructions + recent history, one
  LLM call, no tools/missions). Messages are stored in the same conversation
  tables as the web chat, so they show up there too.

### To go live

1. **Apply migration** `supabase/migrations/0105_agent_mobile_secret.sql`
   (`mobile_secret_hash`, `mobile_enabled` on `internal_agents`).
2. **Deploy** the `internal-agent-run` function (now contains `mobile_chat`).
3. In the FounderOS web app, open an agent → **Settings → Mobile**, enable mobile
   access and **Generate secret**. Copy the agent **ID** and **secret**.
4. In this app, **Enregistrer un agent** with that ID + secret, then chat.

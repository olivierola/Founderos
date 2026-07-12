# FounderOS Agents — mobile app

Expo + React Native (TypeScript, expo-router) companion app. Sign in with your
**FounderOS account** and chat with every agent you can access — synced with the
web app. Protected by an optional **PIN + biometric** app-lock.

## Run

```bash
cd mobile
npm install          # or: npx expo install   (aligns native deps to the SDK)
npx expo start       # press i / a, or scan the QR with Expo Go
```

## Flow

1. **Auth** (`components/AuthScreen.tsx`) — sign in / sign up with your FounderOS
   account (email + password). The session is stored encrypted (`expo-secure-store`)
   and refreshed silently.
2. **App-lock** (`components/LockScreen.tsx`, optional) — set a 4-digit code in
   **Réglages**; unlock with the code or Face ID / fingerprint. Re-locks when the
   app returns to the foreground.
3. **Mes agents** (`app/index.tsx`) — every agent the account can access, fetched
   from the backend (no manual registration).
4. **Conversations** (`app/agent/[id].tsx`) → **Chat** (`app/chat/[id].tsx`) — the
   real agentic chat loop (tools/memory), shared with the web.

## Structure

```
mobile/
  app/
    _layout.tsx        Stack + providers + <Gate> (auth → lock → app)
    index.tsx          Account agents list (custom premium header)
    agent/[id].tsx     Conversations of an agent
    chat/[id].tsx      Chat screen
    settings.tsx       Account + security (PIN/biometric) + sign out
    set-pin.tsx        Create / change the lock code
  components/
    AuthScreen.tsx  LockScreen.tsx  PinKeypad.tsx
    MessageBubble.tsx  Composer.tsx  ui.tsx   (GlowBackdrop/PrimaryButton/AgentAvatar…)
  lib/
    config.ts          Supabase URL / anon key / function name
    theme.ts           Premium dark design tokens
    session.ts         Supabase auth REST + session persistence
    session-context.tsx / lock-context.tsx / agents-context.tsx
    security.ts        PIN (hashed) + biometric helpers
    api.ts             Mobile chat API client (token-based)
```

## Backend

The client calls `internal-agent-run` with `mode: "mobile"`, authenticated by the
**user account JWT** (legacy per-agent `secret` still accepted). Folded into the
existing function to stay under the Supabase 100-function cap.

```
POST {SUPABASE_URL}/functions/v1/internal-agent-run
headers: apikey: <anon>, Authorization: Bearer <access_token>, Content-Type: application/json
body:    { "mode": "mobile", "action": "list_agents" }
                                     | "list_conversations", agent_id
                                     | "get_messages", agent_id, conversation_id
                                     | "send", agent_id, message, conversation_id?
```

`send` inserts the user message and runs the real agentic loop in the background;
the client polls `get_messages` (which reports `running`) until the reply lands.

### To go live

1. **Deploy** the `internal-agent-run` function (account mode + `list_agents`).
   No new migration — it reuses the existing RLS + `has_internal_agent_access`.
   (Migration `0105_agent_mobile_secret.sql` is only needed for the legacy
   secret path.)
2. Open the app, **sign in** with a FounderOS account, and your agents appear.

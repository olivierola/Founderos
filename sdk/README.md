# FounderOS Analytics SDKs

Send product events (and browser session replays) into FounderOS → **SaaS
Analytics**. Events power the Events catalog, Funnels, Cohorts & Retention and
the activation/engagement metrics; session replays power **Session Replay**.

Everything ends up in two edge functions:

| Endpoint | Purpose | Auth |
| --- | --- | --- |
| `POST {host}/functions/v1/track-event` | product events (single or batch) | API key **or** workspace+anon (browser) |
| `POST {host}/functions/v1/ingest-session-replay` | rrweb replay batches | workspace + anon (browser) |

`{host}` is your Supabase project URL, e.g. `https://xxxx.supabase.co`.

## Auth

- **Server SDKs (Node, Python, PHP, Go)** — use an **API key**. Create one in
  **Integrations → API Keys** (it looks like `fos_…`, shown once). Pass it as
  `Authorization: Bearer fos_…`. The workspace is resolved from the key, so you
  only supply the `project_id`. Never ship an API key to a browser.
- **Browser SDK** — use your Supabase **anon key** + `workspaceId`. The anon key
  is public by design; the function only accepts inserts, never reads.

### Identifying users

Every event may carry a `distinct_id`. If it contains `@` it is stored as the
user's email, otherwise as a `customer_external_id`. Funnels and cohorts group
by `coalesce(user_email, customer_external_id)`, so be consistent per user.

---

## JavaScript / TypeScript (`sdk/js`)

Browser **and** Node. Optional rrweb session replay in the browser.

```ts
import { createClient } from "@founderos/analytics";

// Browser
const fos = createClient({
  host: "https://xxxx.supabase.co",
  workspaceId: "<workspace-uuid>",
  projectId: "<project-uuid>",
  anonKey: "<supabase-anon-key>",
});
fos.identify("user@example.com");
fos.track("feature_used", { properties: { feature: "export" } });

// Server (Node) — use an API key instead of workspace+anon
const server = createClient({
  host: "https://xxxx.supabase.co",
  projectId: "<project-uuid>",
  apiKey: process.env.FOUNDEROS_API_KEY,
});
server.track("invoice_paid", { distinctId: "user@example.com", properties: { cents: 4900 } });
await server.shutdown(); // flush on exit
```

### Session replay (browser)

```ts
import { record } from "rrweb"; // peer dependency

const stop = fos.startSessionRecording(record, { maskAllInputs: true });
// … later
stop();
```

Inputs are masked by default. Add `.ph-no-capture` / `data-rr-block` per rrweb
to redact specific elements. Rage clicks and JS errors are counted automatically.

---

## Python (`sdk/python`)

```python
from founderos import FounderOS

fos = FounderOS(
    host="https://xxxx.supabase.co",
    project_id="<project-uuid>",
    api_key="fos_...",
)
fos.identify("user@example.com")
fos.track("signup", properties={"plan": "pro"})
fos.track("feature_used", distinct_id="user@example.com", properties={"feature": "export"})
fos.flush()          # or rely on the background flusher
fos.shutdown()       # flush + stop worker (also runs atexit)
```

Standard library only. A daemon thread flushes every 5s; `shutdown()` is
registered with `atexit`.

---

## PHP (`sdk/php`)

```php
require 'FounderOS.php';

$fos = new \FounderOS\FounderOS([
    'host'       => 'https://xxxx.supabase.co',
    'project_id' => '<project-uuid>',
    'api_key'    => getenv('FOUNDEROS_API_KEY'),
]);
$fos->identify('user@example.com');
$fos->track('signup', 'user@example.com', ['plan' => 'pro']);
$fos->flush(); // also auto-flushed on script shutdown
```

Requires `ext-curl`. PHP is request-scoped, so the buffer is flushed on
`register_shutdown_function`.

---

## Go (`sdk/go`)

```go
import (
    "context"
    founderos "github.com/founderos/analytics-go"
)

fos := founderos.New(founderos.Config{
    Host:      "https://xxxx.supabase.co",
    ProjectID: "<project-uuid>",
    APIKey:    os.Getenv("FOUNDEROS_API_KEY"),
})
defer fos.Shutdown(context.Background())

fos.Track("signup", founderos.Event{
    DistinctID: "user@example.com",
    Properties: map[string]any{"plan": "pro"},
})
```

Standard library only; safe for concurrent use; background flusher every 5s.

---

## Any language — raw REST

No SDK for your stack? Hit the endpoint directly.

### Single event (server, API key)

```bash
curl -X POST "https://xxxx.supabase.co/functions/v1/track-event" \
  -H "Authorization: Bearer fos_..." \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "<project-uuid>",
    "event_name": "signup",
    "distinct_id": "user@example.com",
    "properties": { "plan": "pro" }
  }'
```

### Batch (up to 500 events / request)

```bash
curl -X POST "https://xxxx.supabase.co/functions/v1/track-event" \
  -H "Authorization: Bearer fos_..." \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "<project-uuid>",
    "batch": [
      { "event_name": "signup", "distinct_id": "user@example.com" },
      { "event_name": "feature_used", "distinct_id": "user@example.com",
        "properties": { "feature": "export" } }
    ]
  }'
```

### Browser (no API key — anon + workspace)

```js
fetch("https://xxxx.supabase.co/functions/v1/track-event", {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: "<anon-key>" },
  body: JSON.stringify({
    workspace_id: "<workspace-uuid>",
    project_id: "<project-uuid>",
    event_name: "page_view",
    distinct_id: "user@example.com",
  }),
});
```

### Event payload reference

| Field | Type | Notes |
| --- | --- | --- |
| `project_id` | string (uuid) | **required** |
| `workspace_id` | string (uuid) | required only without an API key |
| `event_name` | string | **required**, ≤120 chars |
| `distinct_id` | string | email → `user_email`, else `customer_external_id` |
| `user_email` / `customer_external_id` | string | set explicitly instead of `distinct_id` |
| `properties` | object | arbitrary JSON |
| `occurred_at` | string (ISO 8601) | defaults to server now |
| `batch` | array | up to 500 events; replaces the single-event fields |

Response: `{ "ok": true, "ingested": <n> }`.

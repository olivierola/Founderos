// Microsoft Teams / Bot Framework helper — proactive messaging into a Teams
// conversation. Auth is the bot's Azure app (client-credentials → an AAD token
// for the Bot Framework connector API). Requires the MICROSOFT_APP_ID and
// MICROSOFT_APP_PASSWORD secrets. Used by internal-agent-run to post an agent's
// reply / mission report back into the Teams thread, and by teams-gateway for
// the immediate mission ack.

let cachedToken: { token: string; exp: number } | null = null;

export async function getBotFrameworkToken(): Promise<string | null> {
  const id = Deno.env.get("MICROSOFT_APP_ID");
  const secret = Deno.env.get("MICROSOFT_APP_PASSWORD");
  if (!id || !secret) return null;
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  try {
    const res = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
        scope: "https://api.botframework.com/.default",
      }),
    });
    const j = await res.json().catch(() => ({} as any));
    if (!j.access_token) return null;
    cachedToken = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return j.access_token;
  } catch {
    return null;
  }
}

// Post a message into an existing Teams conversation (proactive). `serviceUrl` is
// the Bot Framework serviceUrl captured from the inbound activity; `conversationId`
// is activity.conversation.id. Returns true on success.
export async function teamsSendMessage(
  serviceUrl: string | null | undefined,
  conversationId: string | null | undefined,
  text: string,
): Promise<boolean> {
  if (!serviceUrl || !conversationId || !text) return false;
  const token = await getBotFrameworkToken();
  if (!token) return false;
  try {
    const url = `${serviceUrl.replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message", textFormat: "markdown", text: text.slice(0, 28000) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

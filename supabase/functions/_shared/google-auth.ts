// Mint a Google OAuth2 access token from a service-account JSON, using a signed
// JWT (RS256) → token exchange. Used to call Firestore / Identity Toolkit REST
// APIs with admin privileges. Pure Web Crypto, no external deps.

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// PEM (PKCS#8) → CryptoKey for RS256 signing.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw);
  } catch {
    throw new Error("Service account is not valid JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("Service account JSON must include client_email and private_key");
  }
  // Handle keys pasted with escaped newlines.
  sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  return sa;
}

// Exchange a service account for an access token scoped to the given scopes.
export async function getGoogleAccessToken(
  serviceAccountJson: string,
  scopes: string[],
): Promise<{ token: string; projectId: string }> {
  const sa = parseServiceAccount(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: scopes.join(" "),
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed (HTTP ${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("No access_token returned by Google");
  return { token: json.access_token as string, projectId: sa.project_id ?? "" };
}

export const FIRESTORE_SCOPES = ["https://www.googleapis.com/auth/datastore"];
export const IDENTITY_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

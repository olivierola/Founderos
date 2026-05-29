// AES-GCM encryption of connector credentials using CREDENTIAL_ENCRYPTION_KEY.
// Key must be a 32-byte base64 string (256 bits).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("CREDENTIAL_ENCRYPTION_KEY");
  if (!raw) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not set");
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer) };
}

export async function decryptSecret(ciphertext: string, iv: string): Promise<string> {
  const key = await importKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) },
    key,
    fromBase64(ciphertext),
  );
  return decoder.decode(plain);
}

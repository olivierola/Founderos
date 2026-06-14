// Minimal AWS Signature V4 signer for service REST calls (Athena, S3) from Deno.
// Pure Web Crypto, no SDK. Supports the common "POST JSON to a service endpoint"
// shape used by Athena (and a GET for S3 listing).

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}
async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface AwsCreds { accessKeyId: string; secretAccessKey: string; region: string; }

// Sign + send a request to an AWS service. `service` e.g. "athena", "s3".
export async function awsFetch(
  creds: AwsCreds,
  opts: { service: string; host: string; method?: string; path?: string; query?: string; target?: string; body?: string; contentType?: string },
): Promise<Response> {
  const method = opts.method ?? "POST";
  const path = opts.path ?? "/";
  const query = opts.query ?? "";
  const body = opts.body ?? "";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const headers: Record<string, string> = {
    host: opts.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (opts.target) headers["x-amz-target"] = opts.target;
  if (opts.contentType) headers["content-type"] = opts.contentType;

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${creds.region}/${opts.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac(new TextEncoder().encode("AWS4" + creds.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, creds.region);
  const kService = await hmac(kRegion, opts.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${opts.host}${path}${query ? `?${query}` : ""}`, {
    method,
    headers: { ...headers, Authorization: authorization },
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

import { supabase } from "@/lib/supabase";

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function callEdge<T = unknown>(name: string, body: unknown): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    ...(await authHeader()),
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = (data as { error?: string; detail?: string }) ?? {};
    const parts = [err.error, err.detail].filter(Boolean);
    throw new Error(parts.length ? parts.join(" — ") : `Edge function ${name} failed (${res.status})`);
  }
  return data as T;
}

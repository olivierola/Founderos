// Empreinte des paramètres d'un appel. Elle lie une approbation à l'action
// EXACTE qui a été validée : FounderOS la calcule à l'identique quand il signe le
// jeton d'approbation (docs/openshift-implementation.md, D6).
//
// Canonisation : JSON sans espaces, clés d'objet triées récursivement, tableaux
// dans leur ordre ; puis SHA-256 en hexadécimal minuscule.

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function paramsHash(params: unknown): string {
  return createHash("sha256").update(canonicalJson(params)).digest("hex");
}

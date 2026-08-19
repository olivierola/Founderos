#!/usr/bin/env node
// stripe-setup-prices.mjs — crée dans Stripe les produits et tarifs qui
// correspondent au catalogue en base, puis renseigne les `stripe_price_id`.
//
// POURQUOI CE SCRIPT
// Le catalogue vit en base (`billing_plans`, `credit_packs`, migration 0194) :
// c'est lui qui porte les crédits inclus et les limites. Stripe, lui, a besoin
// de ses propres objets Product/Price pour encaisser. Recopier la grille à la
// main dans le Dashboard Stripe, c'est se garantir qu'un jour les deux ne
// diront plus le même prix — et un écart de prix entre l'écran et le débit est
// le genre d'erreur qu'on découvre par un client mécontent.
//
// Le script ne décide de rien : Stripe reçoit ce que la base contient déjà.
//
// USAGE
//   $env:STRIPE_SECRET_KEY = "sk_test_…"          # jamais commité
//   node scripts/stripe-setup-prices.mjs          # aperçu + écriture Stripe
//   node scripts/stripe-setup-prices.mjs --dry-run
//
// La réécriture des `stripe_price_id` en base a besoin du service role :
//   $env:SUPABASE_SERVICE_ROLE_KEY = "eyJ…"
// Sans lui, le script imprime le SQL à passer dans l'éditeur SQL Supabase.
//
// IDEMPOTENT : relancer ne duplique rien. Les produits sont retrouvés par
// `metadata.founderos_code`, les tarifs par `lookup_key`. Si un prix a changé
// en base, un NOUVEAU tarif Stripe est créé et la clé de recherche lui est
// transférée — les abonnements en cours gardent l'ancien, c'est le
// comportement voulu : on ne change pas le prix d'un client déjà engagé.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");
const ALLOW_LIVE = process.argv.includes("--live");

// ── Configuration ────────────────────────────────────────────────────────────
function loadEnvFile() {
  try {
    const out = {};
    for (const line of readFileSync(resolve(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = loadEnvFile();
const env = (name, ...fallbacks) =>
  process.env[name] || fileEnv[name] || fallbacks.map((f) => process.env[f] || fileEnv[f]).find(Boolean) || "";

const STRIPE_KEY = env("STRIPE_SECRET_KEY", "FOUNDEROS_STRIPE_SECRET_KEY");
const SUPABASE_URL = env("SUPABASE_URL", "VITE_SUPABASE_URL");
const SUPABASE_ANON = env("SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY");
const SERVICE_ROLE = env("SUPABASE_SERVICE_ROLE_KEY");

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!STRIPE_KEY) die("STRIPE_SECRET_KEY manquante. Exportez la clé secrète (sk_test_… en test).");
if (!SUPABASE_URL || !SUPABASE_ANON) die("VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquantes (.env).");

const LIVE = STRIPE_KEY.startsWith("sk_live_");
if (LIVE && !ALLOW_LIVE) {
  // Garde-fou : ce script crée des objets facturables. En production, l'erreur
  // ne se répare pas d'un clic — on exige une intention explicite.
  die("Clé LIVE détectée. Relancez avec --live si c'est bien l'intention.");
}
if (STRIPE_KEY.startsWith("pk_")) {
  die("C'est une clé PUBLIABLE (pk_…). Ce script a besoin de la clé secrète (sk_…) — la clé publiable ne sert qu'à Stripe.js côté navigateur, que ce produit n'utilise pas.");
}

// ── Clients HTTP ─────────────────────────────────────────────────────────────
async function stripe(path, { method = "GET", form } = {}) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-06-20",
    },
    body: form ? String(form) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status} ${path}: ${data?.error?.message ?? "erreur"}`);
  return data;
}

async function supa(path, { method = "GET", body, serviceRole = false } = {}) {
  const key = serviceRole ? SERVICE_ROLE : SUPABASE_ANON;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: method === "PATCH" ? "return=minimal" : "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

// ── Recherche / création idempotente ─────────────────────────────────────────
let productCache = null;
async function findProduct(code, kind) {
  if (!productCache) {
    // On liste plutôt qu'on utilise l'API de recherche : celle-ci est indexée en
    // différé, et un script relancé dans la minute recréerait des doublons.
    const page = await stripe("products?limit=100&active=true");
    productCache = page.data ?? [];
  }
  return productCache.find(
    (p) => p.metadata?.founderos_code === code && p.metadata?.founderos_kind === kind,
  );
}

async function ensureProduct({ code, kind, name, description }) {
  const existing = await findProduct(code, kind);
  if (existing) return { product: existing, created: false };
  if (DRY_RUN) return { product: { id: `prod_dryrun_${code}` }, created: true };

  const form = new URLSearchParams({ name });
  if (description) form.set("description", description.slice(0, 350));
  form.set("metadata[founderos_code]", code);
  form.set("metadata[founderos_kind]", kind);
  const product = await stripe("products", { method: "POST", form });
  productCache.push(product);
  return { product, created: true };
}

async function ensurePrice({ lookupKey, productId, amountCents, interval }) {
  const found = await stripe(`prices?lookup_keys[0]=${encodeURIComponent(lookupKey)}&limit=1&active=true`);
  const current = found.data?.[0];

  const sameInterval = interval
    ? current?.recurring?.interval === interval
    : !current?.recurring;
  if (current && current.unit_amount === amountCents && current.currency === "eur" && sameInterval) {
    return { price: current, created: false };
  }
  if (DRY_RUN) return { price: { id: `price_dryrun_${lookupKey}` }, created: true };

  const form = new URLSearchParams({
    product: productId,
    currency: "eur",
    unit_amount: String(amountCents),
    lookup_key: lookupKey,
    // Les prix du catalogue sont HT (cf. docs/billing-limits.md).
    tax_behavior: "exclusive",
  });
  // Reprend la clé au tarif précédent : le tarif d'hier reste actif pour les
  // abonnements en cours, mais ce script ne le retrouvera plus.
  if (current) form.set("transfer_lookup_key", "true");
  if (interval) form.set("recurring[interval]", interval);

  const price = await stripe("prices", { method: "POST", form });
  return { price, created: true, replaced: current?.id ?? null };
}

// ── Programme ────────────────────────────────────────────────────────────────
const euros = (cents) => `${(cents / 100).toLocaleString("fr-FR")} €`;

async function main() {
  console.log(`\n▸ Stripe : mode ${LIVE ? "LIVE ⚠" : "TEST"}${DRY_RUN ? " — simulation (--dry-run)" : ""}`);
  console.log(`▸ Catalogue lu depuis ${SUPABASE_URL}\n`);

  // `free` n'a pas de tarif (0 €, non commercialisée) et `enterprise` se vend
  // sur devis : ni l'une ni l'autre n'a d'objet Stripe à créer.
  const plans = (await supa(
    "billing_plans?select=code,name,tagline,price_cents_eur,annual_price_cents_eur,is_quote,stripe_price_id,stripe_price_id_annual&is_active=eq.true&order=sort_order",
  )).filter((p) => !p.is_quote && p.price_cents_eur > 0);

  const packs = await supa(
    "credit_packs?select=code,name,credits,price_cents_eur,stripe_price_id&is_active=eq.true&order=sort_order",
  );

  if (!plans.length && !packs.length) {
    die("Aucune offre lisible. La migration 0194 est-elle appliquée sur ce projet ?");
  }

  const updates = { billing_plans: [], credit_packs: [] };

  for (const plan of plans) {
    const { product, created } = await ensureProduct({
      code: plan.code, kind: "plan",
      name: `FounderOS ${plan.name}`,
      description: plan.tagline,
    });
    console.log(`${created ? "＋" : "＝"} produit  ${plan.code.padEnd(12)} ${product.id}`);

    const monthly = await ensurePrice({
      lookupKey: `founderos_plan_${plan.code}_monthly`,
      productId: product.id,
      amountCents: plan.price_cents_eur,
      interval: "month",
    });
    console.log(`  ${monthly.created ? "＋" : "＝"} tarif   mensuel ${euros(plan.price_cents_eur).padEnd(10)} ${monthly.price.id}`);

    const patch = { stripe_price_id: monthly.price.id };

    if (plan.annual_price_cents_eur > 0) {
      const annual = await ensurePrice({
        lookupKey: `founderos_plan_${plan.code}_annual`,
        productId: product.id,
        amountCents: plan.annual_price_cents_eur,
        interval: "year",
      });
      console.log(`  ${annual.created ? "＋" : "＝"} tarif   annuel  ${euros(plan.annual_price_cents_eur).padEnd(10)} ${annual.price.id}`);
      patch.stripe_price_id_annual = annual.price.id;
    }

    updates.billing_plans.push({ code: plan.code, ...patch });
  }

  for (const pack of packs) {
    const { product, created } = await ensureProduct({
      code: pack.code, kind: "pack",
      name: `FounderOS — ${pack.name}`,
      description: `${pack.credits.toLocaleString("fr-FR")} crédits IA, sans expiration.`,
    });
    console.log(`${created ? "＋" : "＝"} produit  ${pack.code.padEnd(12)} ${product.id}`);

    const price = await ensurePrice({
      lookupKey: `founderos_${pack.code}`,
      productId: product.id,
      amountCents: pack.price_cents_eur,
      interval: null,
    });
    console.log(`  ${price.created ? "＋" : "＝"} tarif   unique  ${euros(pack.price_cents_eur).padEnd(10)} ${price.price.id}`);
    updates.credit_packs.push({ code: pack.code, stripe_price_id: price.price.id });
  }

  // ── Écriture en base ───────────────────────────────────────────────────────
  console.log("");
  if (DRY_RUN) {
    console.log("▸ Simulation : rien n'a été créé ni écrit.\n");
    return;
  }

  if (SERVICE_ROLE) {
    for (const [table, rows] of Object.entries(updates)) {
      for (const { code, ...patch } of rows) {
        await supa(`${table}?code=eq.${encodeURIComponent(code)}`, {
          method: "PATCH", body: patch, serviceRole: true,
        });
      }
    }
    console.log("✔ `stripe_price_id` renseignés en base.\n");
  } else {
    // `billing_plans` n'a pas de policy d'écriture (et c'est très bien) : sans
    // service role, on rend le SQL plutôt que d'échouer.
    console.log("▸ SUPABASE_SERVICE_ROLE_KEY absente — SQL à passer dans l'éditeur SQL Supabase :\n");
    for (const p of updates.billing_plans) {
      const annual = p.stripe_price_id_annual
        ? `, stripe_price_id_annual = '${p.stripe_price_id_annual}'` : "";
      console.log(`update public.billing_plans set stripe_price_id = '${p.stripe_price_id}'${annual} where code = '${p.code}';`);
    }
    for (const p of updates.credit_packs) {
      console.log(`update public.credit_packs set stripe_price_id = '${p.stripe_price_id}' where code = '${p.code}';`);
    }
    console.log("");
  }

  console.log("Prochaine étape : le webhook.");
  console.log("  stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook");
  console.log("  → puis `supabase secrets set FOUNDEROS_STRIPE_WEBHOOK_SECRET=whsec_…`\n");
}

main().catch((err) => die(err.message));

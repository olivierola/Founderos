// Le cron : le calculer, le décrire, et le construire sans l'écrire.
//
// Ce module est DÉPENDANCE-ZÉRO — pas de client Supabase, pas de React. C'est
// ce qui lui permet de servir les deux côtés : le planificateur, qui doit
// savoir quand une automatisation repart, et l'éditeur, qui doit montrer la
// prochaine échéance AVANT qu'on enregistre. La fonction vivait dans
// workflow-engine.ts, inatteignable depuis le navigateur ; l'écran affichait
// donc une expression brute sans jamais dire ce qu'elle allait déclencher.
//
// Tout est évalué en UTC, y compris `nextCronRun`. C'est le contrat du
// planificateur, et le mentir localement serait pire : une expression qui
// s'affiche « 9 h » et part à 10 h est plus déroutante qu'une expression qui
// dit clairement 9 h UTC et montre l'heure locale correspondante.

/**
 * La prochaine occurrence STRICTEMENT après `from`, ou null si l'expression
 * est invalide.
 *
 * Une marche minute par minute plutôt qu'un calcul de champ : c'est lent sur le
 * papier (au pire deux ans de minutes) et parfaitement suffisant en pratique,
 * là où l'arithmétique de champs se trompe sur les cas tordus — le 31 d'un mois
 * de 30 jours, un 29 février, une expression qui contraint à la fois le jour du
 * mois et le jour de la semaine.
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parse = (f: string, min: number, max: number): number[] | null => {
    const out = new Set<number>();
    for (const part of f.split(",")) {
      const [range, stepRaw] = part.split("/");
      const step = stepRaw ? Number(stepRaw) : 1;
      if (!Number.isFinite(step) || step < 1) return null;
      let lo = min, hi = max;
      if (range !== "*") {
        const [a, b] = range.split("-");
        lo = Number(a); hi = b === undefined ? Number(a) : Number(b);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
  };

  const minutes = parse(fields[0], 0, 59);
  const hours = parse(fields[1], 0, 23);
  const doms = parse(fields[2], 1, 31);
  const months = parse(fields[3], 1, 12);
  const dowsRaw = parse(fields[4], 0, 7); // cron accepte 0 et 7 pour dimanche
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null;
  const dows = [...new Set(dowsRaw.map((d) => (d === 7 ? 0 : d)))];

  const anyDom = fields[2] === "*";
  const anyDow = fields[4] === "*";

  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // strictement après

  // Cinq ans de minutes est le plafond. Deux ne suffisaient pas : `0 9 29 2 *`
  // (le 29 février) peut être à plus de trois ans de distance, et la marche
  // s'arrêtait avant de le trouver — l'expression passait alors pour invalide.
  // Le plafond existe pour qu'une expression qui ne tombe JAMAIS s'arrête au
  // lieu de tourner ; c'est le seul cas qui paie le prix des cinq ans.
  for (let i = 0; i < 366 * 5 * 24 * 60; i++) {
    if (
      months.includes(d.getUTCMonth() + 1) &&
      hours.includes(d.getUTCHours()) &&
      minutes.includes(d.getUTCMinutes()) &&
      // Cron standard : quand les DEUX champs de jour sont contraints, l'un ou
      // l'autre suffit.
      (anyDom && anyDow ? true
        : anyDom ? dows.includes(d.getUTCDay())
        : anyDow ? doms.includes(d.getUTCDate())
        : doms.includes(d.getUTCDate()) || dows.includes(d.getUTCDay()))
    ) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

export const isValidCron = (expr: string): boolean => nextCronRun(expr) !== null;

// ── La forme qu'on manipule dans un écran ───────────────────────────────────
//
// Personne ne pense « 0 9 * * 1 ». On pense « tous les lundis à 9 h ». Ces deux
// fonctions font l'aller-retour entre les deux, pour que l'écran offre des
// choix et que le stockage reste une expression cron — le format que le
// planificateur lit déjà, et que quelqu'un qui sait l'écrire peut toujours
// saisir à la main.

export type CronFrequency = "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface CronSpec {
  frequency: CronFrequency;
  /** 0–23, UTC. Ignoré pour `hourly`. */
  hour: number;
  /** 0–59. */
  minute: number;
  /** 0 = dimanche … 6 = samedi. `weekly` uniquement. */
  weekday: number;
  /** 1–28. `monthly` uniquement — au-delà de 28, un mois court saute le mois. */
  day: number;
  /** L'expression telle quelle, quand la fréquence est « custom ». */
  expression: string;
}

export const DEFAULT_CRON_SPEC: CronSpec = {
  frequency: "weekly", hour: 9, minute: 0, weekday: 1, day: 1, expression: "0 9 * * 1",
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v) || lo));

/** La spécification → l'expression. */
export function buildCron(spec: CronSpec): string {
  const m = clamp(spec.minute, 0, 59);
  const h = clamp(spec.hour, 0, 23);
  switch (spec.frequency) {
    case "hourly": return `${m} * * * *`;
    case "daily": return `${m} ${h} * * *`;
    case "weekly": return `${m} ${h} * * ${clamp(spec.weekday, 0, 6)}`;
    // Plafonné à 28 : un « le 31 » saute février, avril, juin… et donne une
    // planification qui a l'air mensuelle sans l'être.
    case "monthly": return `${m} ${h} ${clamp(spec.day, 1, 28)} * *`;
    default: return spec.expression.trim();
  }
}

/**
 * L'expression → la spécification, quand elle correspond à l'un des cas
 * simples. Sinon « custom », et l'écran montre le champ brut : mieux vaut
 * avouer qu'on ne sait pas représenter une expression que la déformer en
 * l'ouvrant.
 */
export function parseCron(expr: string): CronSpec {
  const f = (expr ?? "").trim().split(/\s+/);
  const custom = (): CronSpec => ({ ...DEFAULT_CRON_SPEC, frequency: "custom", expression: (expr ?? "").trim() });
  if (f.length !== 5) return custom();
  const [min, hr, dom, mon, dow] = f;
  const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);
  const m = num(min);
  if (m === null || mon !== "*") return custom();

  if (hr === "*" && dom === "*" && dow === "*") {
    return { ...DEFAULT_CRON_SPEC, frequency: "hourly", minute: m, expression: expr };
  }
  const h = num(hr);
  if (h === null) return custom();
  if (dom === "*" && dow === "*") {
    return { ...DEFAULT_CRON_SPEC, frequency: "daily", hour: h, minute: m, expression: expr };
  }
  if (dom === "*") {
    const w = num(dow);
    if (w === null || w > 7) return custom();
    return { ...DEFAULT_CRON_SPEC, frequency: "weekly", hour: h, minute: m, weekday: w === 7 ? 0 : w, expression: expr };
  }
  if (dow === "*") {
    const day = num(dom);
    if (day === null || day < 1 || day > 31) return custom();
    return { ...DEFAULT_CRON_SPEC, frequency: "monthly", hour: h, minute: m, day, expression: expr };
  }
  return custom();
}

const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/**
 * L'expression, en français.
 *
 * Rendue depuis l'EXPRESSION et non depuis la spécification : c'est
 * l'expression qui est enregistrée et exécutée, et une phrase calculée à partir
 * d'autre chose finirait par décrire une planification différente de celle qui
 * tourne.
 */
export function describeCron(expr: string): string {
  const spec = parseCron(expr);
  switch (spec.frequency) {
    case "hourly":
      return spec.minute === 0 ? "toutes les heures, à l'heure pile (UTC)" : `toutes les heures, à H+${spec.minute} (UTC)`;
    case "daily": return `tous les jours à ${hhmm(spec.hour, spec.minute)} (UTC)`;
    case "weekly": return `tous les ${WEEKDAYS[spec.weekday]}s à ${hhmm(spec.hour, spec.minute)} (UTC)`;
    case "monthly": return `le ${spec.day === 1 ? "1er" : spec.day} de chaque mois à ${hhmm(spec.hour, spec.minute)} (UTC)`;
    default: return isValidCron(expr) ? `selon « ${expr.trim()} » (UTC)` : "expression invalide";
  }
}

export const CRON_FREQUENCIES: Array<{ id: CronFrequency; label: string }> = [
  { id: "hourly", label: "Chaque heure" },
  { id: "daily", label: "Chaque jour" },
  { id: "weekly", label: "Chaque semaine" },
  { id: "monthly", label: "Chaque mois" },
  { id: "custom", label: "Expression cron" },
];

export const CRON_WEEKDAYS: Array<{ id: number; label: string; short: string }> =
  WEEKDAYS.map((label, id) => ({ id, label, short: label.slice(0, 3) }));

// ── Écrire une planification en français ────────────────────────────────────
//
// Les pastilles de fréquence couvrent les cas courants, et rien d'autre :
// « du lundi au vendredi à 18 h » ou « toutes les 15 minutes » n'y entrent pas,
// et il ne reste alors que l'expression brute — c'est-à-dire rien, pour qui ne
// connaît pas la syntaxe. Cette lecture-ci accepte la phrase telle qu'on la
// dit, et rend du cron.
//
// Elle est DÉLIBÉRÉMENT stricte : elle rend `null` dès qu'elle n'est pas sûre.
// Une planification devinée de travers est pire qu'une planification refusée —
// personne ne relit un cron qu'on lui a rempli tout seul.

const NAT_DAYS: Array<[RegExp, number]> = [
  [/\blundis?\b/, 1], [/\bmardis?\b/, 2], [/\bmercredis?\b/, 3], [/\bjeudis?\b/, 4],
  [/\bvendredis?\b/, 5], [/\bsamedis?\b/, 6], [/\bdimanches?\b/, 0],
];

/** Sans accents ni majuscules : « Tous les Lundis » et « tous les lundis » sont
 *  la même phrase, et personne n'accentue en tapant vite. */
const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();

/**
 * Une phrase → une expression cron, ou `null` si la phrase ne se laisse pas
 * lire sans deviner.
 *
 * Reconnaît : « toutes les 15 minutes », « toutes les 2 heures », « chaque
 * heure », « tous les jours à 18h30 », « tous les lundis à 9h », « lundi et
 * jeudi à midi », « en semaine à 8h », « le 1er de chaque mois à 7h ».
 */
export function parseNaturalCron(input: string): string | null {
  const t = fold(input);
  if (!t) return null;

  // 1. Les intervalles, d'abord : « toutes les 15 minutes » contient un nombre
  //    qui n'est pas une heure, et le confondre donnerait 15 h.
  const everyMin = t.match(/\b(?:toutes?|tous)\s+les\s+(\d{1,2})\s*(?:min|minutes?)\b/);
  if (everyMin) {
    const n = Number(everyMin[1]);
    return n >= 1 && n <= 59 ? `*/${n} * * * *` : null;
  }
  const everyHour = t.match(/\b(?:toutes?|tous)\s+les\s+(\d{1,2})\s*(?:h|heures?)\b/);
  if (everyHour) {
    const n = Number(everyHour[1]);
    return n >= 1 && n <= 23 ? `0 */${n} * * *` : null;
  }

  // 2. L'heure. Le marqueur (h, :, « heures ») est OBLIGATOIRE — sans lui, le
  //    12 de « le 12 de chaque mois » passerait pour midi.
  let hour: number | null = null;
  let minute = 0;
  if (/\bmidi\b/.test(t)) hour = 12;
  else if (/\bminuit\b/.test(t)) hour = 0;
  else {
    const time = t.match(/\b(\d{1,2})\s*(?:h|:|heures?)\s*(\d{1,2})?\b/);
    if (time) {
      const h = Number(time[1]);
      const m = time[2] === undefined ? 0 : Number(time[2]);
      if (h > 23 || m > 59) return null;
      hour = h; minute = m;
    }
  }

  // 3. Les jours de semaine nommés, dans l'ordre du calendrier.
  const days = NAT_DAYS.filter(([re]) => re.test(t)).map(([, d]) => d).sort((a, b) => a - b);

  const weekdays = /\b(?:en\s+semaine|jours?\s+ouvres?|ouvrables?)\b/.test(t)
    || /\bdu\s+lundi\s+au\s+vendredi\b/.test(t);
  const weekend = /\b(?:week[\s-]?end|weekend)\b/.test(t);

  const h = hour ?? 9; // Une planification sans heure dite part le matin.
  if (weekdays) return `${minute} ${h} * * 1-5`;
  if (weekend) return `${minute} ${h} * * 0,6`;
  if (days.length) return `${minute} ${h} * * ${days.join(",")}`;

  // 4. Le jour du mois — seulement si le mois est nommé, sinon « le 3 » tout
  //    seul ne dit pas de quel cycle il parle.
  if (/\bmois\b/.test(t) || /\bmensuel/.test(t)) {
    const dom = t.match(/\ble\s+(\d{1,2})\s*(?:er)?\b/) ?? t.match(/\b(\d{1,2})\s*(?:er)?\s+de\s+chaque\s+mois\b/);
    const day = dom ? Number(dom[1]) : 1;
    if (day < 1 || day > 28) return null; // au-delà de 28, le mois court saute
    return `${minute} ${h} ${day} * *`;
  }

  if (/\b(?:chaque|toutes?\s+les)\s+heures?\b/.test(t)) return `${minute} * * * *`;
  if (/\b(?:chaque\s+jour|tous\s+les\s+jours|quotidien|journalier)\b/.test(t)) return `${minute} ${h} * * *`;

  // Une heure seule (« à 18h ») veut dire tous les jours : c'est la lecture la
  // plus courante, et la description affichée juste après la corrige d'un coup
  // d'œil si ce n'était pas ça.
  if (hour !== null) return `${minute} ${hour} * * *`;

  return null;
}

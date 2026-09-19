// Politique d'exécution du runner — correctif FOS-07.
//
// CE QUI N'ALLAIT PAS
// `shell_exec` lance des commandes sur la machine RÉELLE de l'opérateur, pas
// dans un conteneur jetable. Le seul garde-fou était une phrase adressée au
// modèle dans le prompt système :
//
//   « NEVER run destructive or system-wide commands … never read or exfiltrate
//     credentials or personal files unrelated to the task. »
//
// Or ces agents lisent des sources qu'ils ne contrôlent pas — pages web, tickets
// de support, messages Slack, documents déposés par des tiers. Une instruction
// hostile glissée dans l'une d'elles est traitée comme n'importe quelle autre
// consigne. Une consigne n'est pas un contrôle : elle se négocie.
//
// CE QUE FAIT CE MODULE, ET CE QU'IL NE FAIT PAS
// Trois barrières, de la plus solide à la plus faible :
//
//   1. RUNNER_ALLOWED_BINARIES — liste blanche de binaires. C'est la SEULE
//      barrière réellement solide : ce qui n'est pas listé ne part pas. Elle est
//      optionnelle parce qu'elle demande de connaître son besoin, mais toute
//      installation qui traite des données sensibles devrait la définir.
//
//   2. La liste de refus ci-dessous, toujours active. Elle attrape les gestes
//      catastrophiques et les chemins d'exfiltration connus. Une liste de refus
//      sur une ligne de commande shell est contournable par construction
//      (encodage, variables, `eval`, chemins alternatifs) : elle réduit le
//      risque d'un dérapage, elle n'arrête pas un attaquant décidé.
//
//   3. Le cantonnement au répertoire de travail, dont le défaut passe de
//      « désactivé » à « activé » (voir machine.js).
//
// Autrement dit : sans liste blanche, ce runner reste une surface d'exécution de
// code sur le poste de l'opérateur. Le module rend ce fait explicite au
// démarrage plutôt que de laisser croire à une protection qui n'existe pas.

const ALLOWLIST = String(process.env.RUNNER_ALLOWED_BINARIES || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const ALLOWLIST_ACTIVE = ALLOWLIST.length > 0;

// Gestes irréversibles sur la machine ou son état système.
const DESTRUCTIVE = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, why: "suppression récursive forcée" },
  { re: /\b(mkfs|fdisk|parted|diskpart|format)\b/i, why: "formatage / partitionnement" },
  { re: /\bdd\s+[^|]*of=\/dev\//i, why: "écriture brute sur un périphérique" },
  { re: /\b(shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\b/i, why: "arrêt ou redémarrage de la machine" },
  // Piège : `\b` ne crée PAS de frontière entre une espace et un tiret (deux
  // caractères non-mot), donc `\b-Recurse` ne matchait jamais. On ancre sur
  // l'espace qui précède le drapeau.
  { re: /\b(Remove-Item|del|erase)\b[^|]*\s(-Recurse|\/s)\b[^|]*\s(-Force|\/q)\b/i, why: "suppression récursive forcée (Windows)" },
  { re: /\b(reg|regedit|Set-ItemProperty)\b[^|]*\bHK(LM|CU|CR|U|CC)\b/i, why: "modification du registre Windows" },
  { re: /\bchmod\s+(-R\s+)?777\s+\//, why: "ouverture des droits à la racine" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, why: "fork bomb" },
  { re: /\b(userdel|net\s+user\s+\S+\s+\/delete|Remove-LocalUser)\b/i, why: "suppression de compte utilisateur" },
  { re: /\bgit\s+push\b[^|]*--force/i, why: "réécriture forcée d'un dépôt distant" },
];

// Chemins dont la lecture n'a jamais de rapport avec une tâche légitime, et
// dont la sortie remonte dans le contexte du modèle — donc, potentiellement,
// vers l'extérieur.
const SECRET_PATHS = [
  // Les deux séparateurs : une commande Windows écrit `C:\Users\me\.aws\credentials`.
  { re: /\.ssh[\\/](id_[a-z0-9]+|identity)\b/i, why: "clé SSH privée" },
  { re: /\.aws[\\/](credentials|config)\b/i, why: "identifiants AWS" },
  { re: /\.(env|npmrc|pypirc|netrc|pgpass)\b/i, why: "fichier de secrets" },
  { re: /\.config[\\/]gcloud|\.kube[\\/]config\b/i, why: "identifiants cloud / Kubernetes" },
  { re: /\.docker[\\/]config\.json/i, why: "identifiants de registre Docker" },
  { re: /(Login Data|Cookies|Local State|key[34]\.db|logins\.json)/i, why: "base de mots de passe ou cookies de navigateur" },
  { re: /[\\/]etc[\\/](shadow|sudoers)\b/i, why: "fichier système protégé" },
  { re: /(Keychains|login\.keychain|SecurityAgent)/i, why: "trousseau macOS" },
];

// Exécution de code téléchargé à la volée : le motif qui transforme n'importe
// quelle injection en installation de charge utile.
const REMOTE_EXEC = [
  { re: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[\s\S]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/i, why: "exécution directe d'un script téléchargé" },
  // Les deux sens comptent : `iex (iwr …)` et `iwr … | iex` sont le même geste.
  { re: /\b(iex|Invoke-Expression)\b[\s\S]*\b(DownloadString|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i, why: "exécution directe d'un script téléchargé (PowerShell)" },
  { re: /\b(DownloadString|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b[\s\S]*\|\s*(iex|Invoke-Expression)\b/i, why: "exécution directe d'un script téléchargé (PowerShell)" },
  { re: /\bbash\s+<\(\s*curl/i, why: "exécution directe d'un script téléchargé" },
];

/** Premier mot exécutable d'une commande, sans chemin ni extension. */
function leadingBinary(command) {
  // On saute les affectations d'environnement en tête (`FOO=bar cmd …`) et les
  // élévations de privilège, qui masqueraient le vrai binaire.
  const tokens = String(command).trim().split(/\s+/);
  for (const raw of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    const bare = raw.replace(/^["']|["']$/g, "");
    const base = bare.split(/[\\/]/).pop() || bare;
    const name = base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
    if (name === "sudo" || name === "doas" || name === "runas") continue;
    return name;
  }
  return "";
}

/** Chaque segment d'une commande composée : `a && b | c ; d`. */
function segments(command) {
  return String(command)
    .split(/&&|\|\||[|;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * La commande est-elle autorisée ?
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkCommand(command) {
  const cmd = String(command || "");
  if (!cmd.trim()) return { ok: false, reason: "commande vide" };

  for (const { re, why } of [...DESTRUCTIVE, ...SECRET_PATHS, ...REMOTE_EXEC]) {
    if (re.test(cmd)) {
      return {
        ok: false,
        reason:
          `refusée par la politique du runner — ${why}. ` +
          `Si ce geste est vraiment nécessaire, un humain doit le faire lui-même : ` +
          `l'agent n'a pas de moyen de prouver qu'il n'agit pas sur instruction d'un tiers.`,
      };
    }
  }

  // Liste blanche : appliquée à CHAQUE segment, sinon `ls && rm -rf x` passerait
  // sur la foi de son premier mot.
  if (ALLOWLIST_ACTIVE) {
    for (const seg of segments(cmd)) {
      const bin = leadingBinary(seg);
      if (bin && !ALLOWLIST.includes(bin)) {
        return {
          ok: false,
          reason:
            `« ${bin} » n'est pas dans RUNNER_ALLOWED_BINARIES. ` +
            `Binaires autorisés : ${ALLOWLIST.join(", ")}.`,
        };
      }
    }
  }

  return { ok: true };
}

/** Journal de démarrage : dire ce qui protège réellement, et ce qui ne protège pas. */
export function describePolicy() {
  const lines = [];
  if (ALLOWLIST_ACTIVE) {
    lines.push(`  policy:    liste blanche active (${ALLOWLIST.length} binaires)`);
  } else {
    lines.push("  policy:    AUCUNE liste blanche — ce runner peut exécuter n'importe quel");
    lines.push("             binaire sur cette machine. Définissez RUNNER_ALLOWED_BINARIES");
    lines.push("             pour restreindre, ou RUNNER_DISABLE_EXEC=1 pour couper l'exécution.");
  }
  return lines;
}

// L'export d'un agent embarqué : sa machine, prête à construire et à lancer.
//
//   Dockerfile       l'image de l'agent : le moteur (image de base
//                    founderos/agent-runtime), son manifeste, ses fichiers
//                    d'amorce, les paquets demandés, un utilisateur non root
//   compose.yaml     le conteneur : ressources, volumes /data et /workspace,
//                    redémarrage, variables d'environnement
//   .env.example     FOUNDEROS_URL et FOUNDEROS_API_KEY (et la clé du modèle en
//                    accès direct) : les secrets restent hors de l'image
//   manifest.json    la configuration figée (sans secret)
//   workspace/       les fichiers d'amorce de son dossier de travail
//   README.md        comment construire, lancer, superviser

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { EmbeddedConfig, EmbeddedManifest } from "./manifest.ts";

export const RUNTIME_IMAGE = "founderos/agent-runtime";

export const slugOf = (name: string) =>
  name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

export const imageTag = (manifest: EmbeddedManifest, version: number) => `founderos/embedded-${slugOf(manifest.agent.name)}:v${version}`;

/** Un chemin d'amorce sûr : relatif, sans remontée. */
/** Un chemin sous /workspace ; celui qui cherche à en sortir (..) est écarté, pas renommé. */
const safePath = (p: string) => {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  return parts.includes("..") ? "" : parts.join("/");
};

const shellList = (xs: string[]) => xs.map((x) => x.replace(/[^A-Za-z0-9._=@+\-/:<>]/g, "")).filter(Boolean).join(" ");

export function dockerfile(manifest: EmbeddedManifest, config: EmbeddedConfig): string {
  const m = manifest.machine;
  return [
    `# L'agent embarqué « ${manifest.agent.name} » : son moteur (OpenCode et les plugins FounderOS),`,
    "# sa configuration (manifest.json) et sa machine (ce conteneur). Aucun secret dans l'image :",
    "# FOUNDEROS_API_KEY (et LLM_API_KEY en accès direct) arrivent par l'environnement.",
    `ARG RUNTIME_IMAGE=${RUNTIME_IMAGE}:${config.runtime_version}`,
    "FROM ${RUNTIME_IMAGE}",
    "USER root",
    ...(m.apt.length ? [`RUN apt-get update && apt-get install -y --no-install-recommends ${shellList(m.apt)} && rm -rf /var/lib/apt/lists/*`] : []),
    ...(m.pip.length ? [`RUN pip3 install --no-cache-dir --break-system-packages ${shellList(m.pip)}`] : []),
    ...(m.npm.length ? [`RUN npm install -g ${shellList(m.npm)}`] : []),
    "COPY manifest.json /app/manifest.json",
    "COPY workspace/ /workspace/",
    "RUN chown -R agent:agent /workspace /data",
    "USER agent",
    "ENV MANIFEST=/app/manifest.json WORKSPACE_DIR=/workspace DATA_DIR=/data",
    "VOLUME [\"/data\", \"/workspace\"]",
    "",
  ].join("\n");
}

export function composeFile(manifest: EmbeddedManifest, version: number): string {
  const slug = slugOf(manifest.agent.name);
  const m = manifest.machine;
  return [
    `# docker compose up -d --build : lance « ${manifest.agent.name} » (version ${version}).`,
    "services:",
    `  ${slug}:`,
    `    image: ${imageTag(manifest, version)}`,
    "    build: .",
    `    container_name: founderos-agent-${slug}`,
    "    restart: unless-stopped",
    "    env_file: .env",
    "    environment:",
    `      INSTANCE_NAME: \${INSTANCE_NAME:-${slug}}`,
    `    cpus: ${m.cpus}`,
    `    mem_limit: ${m.memory_mb}m`,
    "    volumes:",
    `      - ${slug}-data:/data`,
    `      - ${slug}-workspace:/workspace`,
    "volumes:",
    `  ${slug}-data: {}`,
    `  ${slug}-workspace: {}`,
    "",
  ].join("\n");
}

export function envExample(manifest: EmbeddedManifest, founderosUrl: string): string {
  return [
    "# L'adresse de FounderOS, telle que le conteneur la joint.",
    `FOUNDEROS_URL=${founderosUrl}`,
    "# La clé d'API de cette instance (onglet Agents embarqués, Clés). Montrée une seule fois.",
    "FOUNDEROS_API_KEY=",
    ...(manifest.llm.route === "direct"
      ? ["# Accès direct au modèle : la clé de votre point d'accès (le manifeste porte son adresse).", "LLM_API_KEY="]
      : []),
    "",
  ].join("\n");
}

export function readme(manifest: EmbeddedManifest, version: number, sha: string): string {
  const slug = slugOf(manifest.agent.name);
  return [
    `# ${manifest.agent.name} : agent embarqué (version ${version})`,
    "",
    `Empreinte du manifeste : \`${sha.slice(0, 16)}\`. FounderOS la compare à celle que l'instance annonce : une instance qui ne tourne plus la configuration attendue est signalée.`,
    "",
    "## Lancer",
    "",
    "1. L'image du moteur, une fois par version, depuis le dépôt FounderOS :",
    "   ```",
    `   docker build -f embedded/Dockerfile -t ${RUNTIME_IMAGE}:${manifest.runtime_version} .`,
    "   ```",
    "2. Une clé d'API pour cette instance : FounderOS, service, Agents embarqués, cet agent, Clés. Copiez `.env.example` en `.env` et collez-la.",
    "3. ```",
    "   docker compose up -d --build",
    "   ```",
    "",
    "L'instance apparaît dans FounderOS dès son premier battement de cœur, avec son état, ses runs et ses coûts. On la met en pause, on la relance ou on l'arrête depuis l'onglet.",
    "",
    "## Ce que fait le conteneur",
    "",
    "- Le moteur OpenCode et les plugins FounderOS tournent dans ce conteneur ; `/workspace` est le dossier de travail de l'agent, `/data` l'état de ses sessions.",
    `- Le modèle : ${manifest.llm.route === "founderos" ? "par la passerelle FounderOS (clés et crédits de la plateforme)" : `en direct sur ${manifest.llm.base_url} (clé LLM_API_KEY)`}.`,
    `- Les outils de la plateforme (${manifest.tools.length} : connecteurs, livrables, mémoire, recherche…) passent par la passerelle avec la clé de l'instance, dans les pools de l'agent (${manifest.pools.join(", ") || "aucun"}). Aucun secret de connecteur n'entre dans le conteneur.`,
    `- Les conversations remontent : ${manifest.sync_level === "full" ? "en entier" : manifest.sync_level === "summary" ? "en résumé" : "statuts et coûts seulement"}.`,
    ...(manifest.machine.egress.length
      ? [`- Sortie réseau prévue : FounderOS, le modèle, et ${manifest.machine.egress.join(", ")}. À appliquer au réseau de l'hôte (pare-feu, NetworkPolicy).`]
      : []),
    "",
    "## Mettre à jour",
    "",
    "Les consignes et les règles se relisent à chaud (« Recharger » dans FounderOS). Un changement d'outils, de skills ou de version du moteur demande un nouvel export.",
    "",
    `Volumes : \`${slug}-data\`, \`${slug}-workspace\`.`,
    "",
  ].join("\n");
}

/** L'archive à télécharger : la machine de l'agent, prête à construire. */
export async function makeBundle(input: {
  manifest: EmbeddedManifest; sha: string; version: number; config: EmbeddedConfig; founderosUrl: string;
}): Promise<Uint8Array> {
  const { manifest, sha, version, config } = input;
  const root = `${slugOf(manifest.agent.name)}-v${version}`;
  const zip = new ZipWriter(new Uint8ArrayWriter());
  const add = (name: string, text: string) => zip.add(`${root}/${name}`, new TextReader(text));
  await add("Dockerfile", dockerfile(manifest, config));
  await add("compose.yaml", composeFile(manifest, version));
  await add(".env.example", envExample(manifest, input.founderosUrl));
  await add("manifest.json", JSON.stringify({ ...manifest, version, sha }, null, 2));
  await add("README.md", readme(manifest, version, sha));
  await add("workspace/.keep", "");
  for (const f of config.seed_files) {
    const p = safePath(f.path);
    if (p) await add(`workspace/${p}`, String(f.content ?? ""));
  }
  return zip.close();
}

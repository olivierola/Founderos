// Le catalogue des outils des machines (custom machines).
//
// On part d'une machine de base (team-machine : un compte Linux par agent, un
// dossier par équipe, isolement, navigateur, shell, Node, Python) et on choisit
// les outils qu'on y met, pris dans ce catalogue, par catégorie. La même
// sélection sert deux fois :
//
//   - une machine d'équipe créée à la demande (onglet Machines) reçoit ces
//     outils dans son image ;
//   - un agent embarqué part de la même sélection : ses outils entrent dans le
//     conteneur de l'agent.
//
// Un PRESET est une sélection toute faite (« Analyste data », « Réponse à
// incident »…) : il coche des outils, qu'on ajuste ensuite.
//
// Les noms de paquets sont ceux de Debian bookworm (apt), de PyPI (pip) et de
// npm, les mêmes que les deux images de base. Un identifiant d'outil ou de
// preset ne change jamais de sens : on en ajoute, on n'en retire pas (une
// machine garde sa sélection).

import { createHash } from "node:crypto";

export const TOOL_CATEGORIES = [
  { id: "dev", label: "Développement", summary: "Langages, gestionnaires de paquets, tests, clients de bases." },
  { id: "data", label: "Data", summary: "Analyse, ingénierie et visualisation de données." },
  { id: "ia", label: "IA et ML", summary: "Apprentissage automatique classique et notebooks." },
  { id: "web", label: "Web et collecte", summary: "Extraction, veille et appels d'API sur le web." },
  { id: "ops", label: "Ops et cloud", summary: "Administrer, automatiser, se brancher aux bases et aux clouds." },
  { id: "docs", label: "Documents", summary: "Convertir, lire et produire des documents (PDF, OCR, bureautique)." },
  { id: "defsec", label: "Sécurité défensive", summary: "Veille, analyse de fichiers et de journaux, audit de code et de dépendances, durcissement." },
  { id: "netsec", label: "Audit réseau (autorisé)", summary: "Cartographier et éprouver un périmètre que vous êtes autorisé à tester." },
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number]["id"];

export interface Tool {
  /** Stable : il est enregistré sur les machines et les agents. */
  id: string;
  category: ToolCategory;
  name: string;
  summary: string;
  apt: string[];
  pip: string[];
  npm: string[];
  /** Une précaution à montrer (usage autorisé, image lourde…). */
  note?: string;
}

export const TOOLS: Tool[] = [
  // ── Développement ──
  { id: "dev-node", category: "dev", name: "Node et TypeScript", summary: "TypeScript, pnpm, tsx, eslint, prettier, vitest.", apt: [], pip: [], npm: ["typescript", "tsx", "pnpm", "eslint", "prettier", "vitest"] },
  { id: "dev-python", category: "dev", name: "Python (outillage)", summary: "uv, poetry, pytest, ruff, mypy, ipython.", apt: [], pip: ["uv", "poetry", "pytest", "pytest-cov", "ruff", "mypy", "black", "ipython"], npm: [] },
  { id: "dev-go", category: "dev", name: "Go", summary: "Le compilateur Go et ses outils.", apt: ["golang-go"], pip: [], npm: [] },
  { id: "dev-java", category: "dev", name: "Java et Maven", summary: "JDK 17 sans interface et Maven.", apt: ["default-jdk-headless", "maven"], pip: [], npm: [], note: "Image plus lourde." },
  { id: "dev-rust", category: "dev", name: "Rust", summary: "rustc et cargo.", apt: ["rustc", "cargo"], pip: [], npm: [], note: "Image plus lourde." },
  { id: "dev-db-clients", category: "dev", name: "Clients de bases", summary: "Lignes de commande PostgreSQL, MySQL, SQLite, Redis.", apt: ["postgresql-client", "default-mysql-client", "sqlite3", "redis-tools"], pip: [], npm: [] },

  // ── Data ──
  { id: "data-analysis", category: "data", name: "Analyse de données", summary: "pandas, polars, duckdb, numpy, scipy, matplotlib, Excel.", apt: [], pip: ["pandas", "polars", "duckdb", "pyarrow", "numpy", "scipy", "statsmodels", "matplotlib", "seaborn", "openpyxl", "xlsxwriter"], npm: [] },
  { id: "data-dbt", category: "data", name: "dbt (transformations)", summary: "dbt sur PostgreSQL et DuckDB.", apt: [], pip: ["dbt-core", "dbt-postgres", "dbt-duckdb"], npm: [] },
  { id: "data-sql", category: "data", name: "Accès SQL (Python)", summary: "SQLAlchemy et pilotes PostgreSQL et MySQL.", apt: [], pip: ["sqlalchemy", "psycopg[binary]", "pymysql"], npm: [] },

  // ── IA et ML ──
  { id: "ia-ml", category: "ia", name: "Apprentissage automatique", summary: "scikit-learn, XGBoost, LightGBM, Optuna.", apt: ["libgomp1"], pip: ["scikit-learn", "xgboost", "lightgbm", "optuna", "joblib"], npm: [] },
  { id: "ia-notebooks", category: "ia", name: "Notebooks", summary: "JupyterLab, nbconvert, papermill.", apt: [], pip: ["jupyterlab", "nbconvert", "papermill", "ipykernel", "plotly"], npm: [] },

  // ── Web et collecte ──
  { id: "web-scraping", category: "web", name: "Collecte web", summary: "Scrapy, BeautifulSoup, trafilatura, httpx, flux RSS.", apt: [], pip: ["scrapy", "beautifulsoup4", "lxml", "trafilatura", "httpx", "feedparser"], npm: [], note: "Respectez les conditions d'utilisation des sites." },

  // ── Ops et cloud ──
  { id: "ops-ansible", category: "ops", name: "Ansible", summary: "Automatiser des serveurs.", apt: [], pip: ["ansible"], npm: [] },
  { id: "ops-aws", category: "ops", name: "AWS", summary: "AWS CLI et boto3.", apt: [], pip: ["awscli", "boto3"], npm: [] },
  { id: "ops-k8s", category: "ops", name: "Kubernetes et conteneurs", summary: "kubectl, helm, le client Docker.", apt: ["kubernetes-client", "helm", "docker.io"], pip: [], npm: [], note: "Le client seul : pas de démon dans le conteneur." },
  { id: "ops-net", category: "ops", name: "Réseau et transfert", summary: "rsync, SSH, curl, wget.", apt: ["rsync", "openssh-client", "curl", "wget"], pip: [], npm: [] },

  // ── Documents ──
  { id: "docs-convert", category: "docs", name: "Conversion de documents", summary: "pandoc, poppler, qpdf, ghostscript ; lecture et écriture Office.", apt: ["pandoc", "poppler-utils", "qpdf", "ghostscript"], pip: ["pypdf", "pdfplumber", "python-docx", "openpyxl", "python-pptx"], npm: [] },
  { id: "docs-ocr", category: "docs", name: "OCR", summary: "Tesseract (français, anglais) et OCRmyPDF.", apt: ["tesseract-ocr", "tesseract-ocr-fra", "tesseract-ocr-eng"], pip: ["ocrmypdf"], npm: [] },

  // ── Sécurité défensive ──
  { id: "defsec-dfir", category: "defsec", name: "Analyse de fichiers (DFIR)", summary: "Signatures, métadonnées, extraction : yara, binwalk, exiftool, sleuthkit.", apt: ["yara", "binwalk", "libimage-exiftool-perl", "foremost", "sleuthkit", "xxd"], pip: ["yara-python", "pefile", "python-evtx"], npm: [] },
  { id: "defsec-memory", category: "defsec", name: "Analyse mémoire", summary: "Examiner une capture mémoire (Volatility 3).", apt: [], pip: ["volatility3"], npm: [] },
  { id: "defsec-capture", category: "defsec", name: "Captures réseau", summary: "Lire et filtrer des captures : tshark, tcpdump.", apt: ["tshark", "tcpdump"], pip: ["scapy"], npm: [] },
  { id: "defsec-sast", category: "defsec", name: "Audit de code", summary: "Analyse statique : Semgrep, Bandit.", apt: [], pip: ["semgrep", "bandit"], npm: [] },
  { id: "defsec-deps", category: "defsec", name: "Audit de dépendances", summary: "Vulnérabilités connues : pip-audit, Trivy.", apt: ["trivy"], pip: ["pip-audit"], npm: [], note: "Trivy vient du dépôt apt d'Aqua Security." },
  { id: "defsec-logs", category: "defsec", name: "Analyse de journaux", summary: "Parcourir et agréger des journaux : ripgrep, jq, Python.", apt: ["ripgrep", "jq"], pip: ["pandas", "python-dateutil"], npm: [] },

  // ── Audit réseau (autorisé) ──
  { id: "netsec-recon", category: "netsec", name: "Cartographie réseau", summary: "Ports, services, DNS, sous-domaines : nmap, dnsutils, whois.", apt: ["nmap", "whois", "dnsutils", "netcat-openbsd", "traceroute"], pip: ["dnspython"], npm: [], note: "À n'utiliser que sur des systèmes que vous êtes autorisé à tester." },
  { id: "netsec-webaudit", category: "netsec", name: "Audit d'application web", summary: "Scanner de configuration et de contenu : nikto, gobuster.", apt: ["nikto", "gobuster"], pip: ["requests", "httpx"], npm: [], note: "À n'utiliser que dans le cadre d'une mission autorisée." },
];

export interface MachinePreset {
  id: string;
  category: ToolCategory;
  name: string;
  summary: string;
  /** Les outils que ce preset coche. */
  tools: string[];
  cpus: number;
  memory_mb: number;
  disk_mb: number;
}

export const PRESETS: MachinePreset[] = [
  { id: "preset-dev-web", category: "dev", name: "Développement web", summary: "Node, TypeScript et des clients de bases.", tools: ["dev-node", "dev-db-clients"], cpus: 4, memory_mb: 8192, disk_mb: 16384 },
  { id: "preset-dev-python", category: "dev", name: "Développement Python", summary: "Outillage Python et clients de bases.", tools: ["dev-python", "dev-db-clients"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
  { id: "preset-data", category: "data", name: "Analyste data", summary: "Analyse, SQL et notebooks.", tools: ["data-analysis", "data-sql", "ia-notebooks"], cpus: 4, memory_mb: 8192, disk_mb: 16384 },
  { id: "preset-data-eng", category: "data", name: "Ingénierie de données", summary: "dbt, SQL et clients de bases.", tools: ["data-dbt", "data-sql", "dev-db-clients"], cpus: 4, memory_mb: 8192, disk_mb: 32768 },
  { id: "preset-ml", category: "ia", name: "Apprentissage automatique", summary: "ML classique et notebooks.", tools: ["ia-ml", "ia-notebooks", "data-analysis"], cpus: 8, memory_mb: 16384, disk_mb: 32768 },
  { id: "preset-ops", category: "ops", name: "Ops et cloud", summary: "Ansible, AWS, réseau et clients de bases.", tools: ["ops-ansible", "ops-aws", "ops-net", "dev-db-clients"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
  { id: "preset-docs", category: "docs", name: "Documents et OCR", summary: "Conversion, OCR, lecture de PDF.", tools: ["docs-convert", "docs-ocr"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
  { id: "preset-blueteam", category: "defsec", name: "Réponse à incident", summary: "Analyse de fichiers, mémoire, captures et journaux.", tools: ["defsec-dfir", "defsec-memory", "defsec-capture", "defsec-logs"], cpus: 2, memory_mb: 6144, disk_mb: 24576 },
  { id: "preset-appsec", category: "defsec", name: "Sécurité applicative", summary: "Audit de code et de dépendances.", tools: ["defsec-sast", "defsec-deps", "dev-python"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
  { id: "preset-recon", category: "netsec", name: "Audit réseau (autorisé)", summary: "Cartographie et audit web d'un périmètre autorisé.", tools: ["netsec-recon", "netsec-webaudit"], cpus: 2, memory_mb: 2048, disk_mb: 8192 },
];

export const toolById = (id: string | null | undefined): Tool | null => (id ? TOOLS.find((t) => t.id === id) : null) ?? null;
export const presetById = (id: string | null | undefined): MachinePreset | null => (id ? PRESETS.find((p) => p.id === id) : null) ?? null;

/** Les outils d'une sélection, dans l'ordre du catalogue, sans doublon ni identifiant inconnu. */
export function resolveTools(ids: readonly string[] | null | undefined): Tool[] {
  const want = new Set(ids ?? []);
  return TOOLS.filter((t) => want.has(t.id));
}

/** Les notes à montrer pour une sélection (usage autorisé…). */
export const toolNotes = (ids: readonly string[]): string[] =>
  [...new Set(resolveTools(ids).map((t) => t.note).filter((n): n is string => !!n))];

// Un paquet passe tel quel dans une commande : rien d'autre que des noms et des contraintes de version.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._+\-[\]=<>~!,:@/]*$/;
const list = (xs: string[]) => [...new Set(xs)].filter((x) => SAFE.test(x)).map((x) => `'${x}'`).join(" ");

/** Les lignes Dockerfile qui installent une sélection d'outils (image Debian bookworm, en root). */
export function selectionLayer(ids: readonly string[]): string[] {
  const tools = resolveTools(ids);
  const apt = tools.flatMap((t) => t.apt);
  const pip = tools.flatMap((t) => t.pip);
  const npm = tools.flatMap((t) => t.npm);
  return [
    ...(apt.length ? [`RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${list(apt)} && rm -rf /var/lib/apt/lists/*`] : []),
    ...(pip.length ? [`RUN pip3 install --no-cache-dir --break-system-packages ${list(pip)}`] : []),
    ...(npm.length ? [`RUN npm install -g --no-audit --no-fund ${list(npm)} && npm cache clean --force`] : []),
  ];
}

/**
 * L'image d'une machine d'équipe avec une sélection d'outils : team-machine et
 * la couche des outils. Les binaires setuid que les paquets ajoutent sont
 * désarmés comme dans l'image de base (aucun agent ne redevient root).
 */
export function selectionDockerfile(ids: readonly string[], baseImage: string): string {
  const layer = selectionLayer(ids);
  return [
    `# Machine d'équipe avec ${resolveTools(ids).length} outil(s) du catalogue.`,
    `FROM ${baseImage}`,
    ...(layer.length ? ["USER root", ...layer, "RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true", "USER agent"] : []),
    `LABEL founderos.tools="${selectionKey(ids)}"`,
    "",
  ].join("\n");
}

/** La clé d'une sélection : ses outils triés, pour nommer et comparer les images. */
export const selectionKey = (ids: readonly string[]): string => resolveTools(ids).map((t) => t.id).join(",");

/** Le nom de l'image d'une sélection, d'après l'image de base (même version). Vide : l'image de base. */
export function selectionImage(baseImage: string, ids: readonly string[]): string {
  const tools = resolveTools(ids);
  if (!tools.length) return baseImage;
  const [repo, tag = "latest"] = baseImage.split(/:(?=[^/]+$)/);
  const hash = createHash("sha256").update(selectionKey(ids)).digest("hex").slice(0, 10);
  return `${repo}-tools-${hash}:${tag}`;
}

/** Ce que le front montre : les catégories, les outils et les presets. */
export const catalog = () => ({ categories: TOOL_CATEGORIES, tools: TOOLS, presets: PRESETS });

// Le catalogue des machines taillées par métier (custom machines).
//
// Une machine du catalogue, c'est une machine d'équipe (team-machine : un
// compte Linux par agent, un dossier par équipe, isolement, navigateur) avec
// une couche de plus : les outils de son métier, et des ressources à sa
// mesure. Elle sert deux fois :
//
//   - créée à la demande dans l'onglet Machines, elle reçoit des équipes et des
//     agents comme toute machine d'équipe ;
//   - choisie pour un agent embarqué, ses paquets et ses ressources entrent dans
//     le conteneur de l'agent (même distribution : Debian bookworm).
//
// Les noms de paquets sont ceux de Debian bookworm (apt), de PyPI (pip) et de
// npm. Un modèle ne change jamais de sens : on en ajoute, on n'en retire pas
// (une machine créée garde son modèle).

export const CATEGORIES = [
  { id: "cyber", label: "Cybersécurité", summary: "Reconnaissance, tests d'intrusion autorisés, analyse de fichiers et de journaux." },
  { id: "data", label: "Data", summary: "Analyse, ingénierie et visualisation de données." },
  { id: "dev", label: "Développement", summary: "Construire, tester et livrer du code." },
  { id: "ia", label: "IA et ML", summary: "Apprentissage automatique classique et notebooks." },
  { id: "web", label: "Web et collecte", summary: "Navigation, extraction et veille sur le web." },
  { id: "ops", label: "Ops et cloud", summary: "Administrer, automatiser, se brancher aux bases et aux clouds." },
  { id: "docs", label: "Documents", summary: "Convertir, lire et produire des documents (PDF, OCR, bureautique)." },
] as const;

export type MachineCategory = (typeof CATEGORIES)[number]["id"];

export interface MachineTemplate {
  /** Stable : il est enregistré sur les machines et les agents embarqués. */
  id: string;
  category: MachineCategory;
  name: string;
  summary: string;
  /** Ce que la machine apporte, en clair (montré sur la carte). */
  highlights: string[];
  apt: string[];
  pip: string[];
  npm: string[];
  cpus: number;
  memory_mb: number;
  disk_mb: number;
  /** Une précaution à montrer (usage autorisé, poids de l'image…). */
  note?: string;
}

export const TEMPLATES: MachineTemplate[] = [
  // ── Cybersécurité ──
  {
    id: "cyber-recon", category: "cyber", name: "Reconnaissance réseau",
    summary: "Cartographier un périmètre autorisé : ports, services, DNS, sous-domaines, répertoires web.",
    highlights: ["nmap", "masscan", "gobuster", "whois", "dig", "netcat"],
    apt: ["nmap", "masscan", "gobuster", "whois", "netcat-openbsd", "dnsutils", "traceroute"],
    pip: ["python-nmap", "dnspython", "shodan"],
    npm: [],
    cpus: 2, memory_mb: 2048, disk_mb: 8192,
    note: "À n'utiliser que sur des systèmes que vous êtes autorisé à tester.",
  },
  {
    id: "cyber-pentest", category: "cyber", name: "Test d'intrusion web",
    summary: "Éprouver une application web autorisée : injections, authentification, configuration.",
    highlights: ["sqlmap", "hydra", "john", "nmap", "playwright"],
    apt: ["sqlmap", "hydra", "john", "nmap", "whois", "netcat-openbsd"],
    pip: ["requests", "httpx", "pwntools"],
    npm: [],
    cpus: 2, memory_mb: 4096, disk_mb: 8192,
    note: "À n'utiliser que dans le cadre d'une mission autorisée.",
  },
  {
    id: "cyber-forensics", category: "cyber", name: "Analyse et réponse à incident",
    summary: "Examiner des fichiers, des captures et des journaux : signatures, métadonnées, artefacts.",
    highlights: ["yara", "binwalk", "exiftool", "tshark", "volatility3"],
    apt: ["yara", "binwalk", "libimage-exiftool-perl", "tshark", "foremost", "sleuthkit", "xxd"],
    pip: ["yara-python", "volatility3", "pefile", "python-evtx"],
    npm: [],
    cpus: 2, memory_mb: 4096, disk_mb: 16384,
  },
  // ── Data ──
  {
    id: "data-analysis", category: "data", name: "Analyse de données",
    summary: "Explorer, nettoyer et croiser des jeux de données ; produire des tableaux et des graphiques.",
    highlights: ["pandas", "polars", "duckdb", "matplotlib", "openpyxl"],
    apt: [],
    pip: ["pandas", "polars", "duckdb", "pyarrow", "numpy", "scipy", "statsmodels", "matplotlib", "seaborn", "openpyxl", "xlsxwriter"],
    npm: [],
    cpus: 4, memory_mb: 8192, disk_mb: 16384,
  },
  {
    id: "data-engineering", category: "data", name: "Ingénierie de données",
    summary: "Extraire, transformer et charger : bases SQL, fichiers colonnes, modèles dbt.",
    highlights: ["dbt", "SQLAlchemy", "psql", "duckdb", "pyarrow"],
    apt: ["postgresql-client", "default-mysql-client"],
    pip: ["dbt-core", "dbt-postgres", "dbt-duckdb", "sqlalchemy", "psycopg[binary]", "pymysql", "duckdb", "pyarrow", "pandas"],
    npm: [],
    cpus: 4, memory_mb: 8192, disk_mb: 32768,
  },
  // ── Développement ──
  {
    id: "dev-web", category: "dev", name: "Développement web (Node, TypeScript)",
    summary: "Construire et tester des applications JavaScript et TypeScript.",
    highlights: ["TypeScript", "pnpm", "tsx", "eslint", "prettier", "vitest"],
    apt: [],
    pip: [],
    npm: ["typescript", "tsx", "pnpm", "eslint", "prettier", "vitest"],
    cpus: 4, memory_mb: 8192, disk_mb: 16384,
  },
  {
    id: "dev-python", category: "dev", name: "Développement Python",
    summary: "Écrire, tester et empaqueter du Python.",
    highlights: ["uv", "poetry", "pytest", "ruff", "mypy"],
    apt: [],
    pip: ["uv", "poetry", "pytest", "pytest-cov", "ruff", "mypy", "black", "ipython"],
    npm: [],
    cpus: 2, memory_mb: 4096, disk_mb: 16384,
  },
  {
    id: "dev-polyglot", category: "dev", name: "Développement polyglotte",
    summary: "Go, Java et Rust en plus de Node et Python.",
    highlights: ["Go", "Java 17", "Maven", "Rust", "cargo"],
    apt: ["golang-go", "default-jdk-headless", "maven", "rustc", "cargo"],
    pip: [],
    npm: [],
    cpus: 4, memory_mb: 8192, disk_mb: 32768,
    note: "Image plus lourde (compilateurs).",
  },
  // ── IA et ML ──
  {
    id: "ia-ml", category: "ia", name: "Apprentissage automatique",
    summary: "Entraîner et évaluer des modèles classiques sur processeur.",
    highlights: ["scikit-learn", "XGBoost", "LightGBM", "Optuna", "pandas"],
    apt: ["libgomp1"],
    pip: ["scikit-learn", "xgboost", "lightgbm", "optuna", "pandas", "numpy", "matplotlib", "joblib"],
    npm: [],
    cpus: 8, memory_mb: 16384, disk_mb: 32768,
  },
  {
    id: "ia-notebooks", category: "ia", name: "Notebooks et exploration",
    summary: "Exécuter des notebooks Jupyter et rendre leurs résultats.",
    highlights: ["JupyterLab", "nbconvert", "papermill", "pandas", "plotly"],
    apt: [],
    pip: ["jupyterlab", "nbconvert", "papermill", "ipykernel", "pandas", "plotly", "matplotlib"],
    npm: [],
    cpus: 4, memory_mb: 8192, disk_mb: 16384,
  },
  // ── Web et collecte ──
  {
    id: "web-scraping", category: "web", name: "Collecte web",
    summary: "Extraire des pages et des API, à l'échelle, en respectant les conditions des sites.",
    highlights: ["Scrapy", "BeautifulSoup", "trafilatura", "httpx", "Playwright"],
    apt: [],
    pip: ["scrapy", "beautifulsoup4", "lxml", "trafilatura", "httpx", "feedparser"],
    npm: [],
    cpus: 2, memory_mb: 4096, disk_mb: 16384,
  },
  // ── Ops et cloud ──
  {
    id: "ops-cloud", category: "ops", name: "Ops et cloud",
    summary: "Automatiser des serveurs et des comptes cloud ; interroger des bases.",
    highlights: ["Ansible", "AWS CLI", "psql", "redis-cli", "rsync"],
    apt: ["postgresql-client", "redis-tools", "rsync", "openssh-client"],
    pip: ["ansible", "awscli", "boto3"],
    npm: [],
    cpus: 2, memory_mb: 4096, disk_mb: 16384,
  },
  // ── Documents ──
  {
    id: "docs-office", category: "docs", name: "Documents et OCR",
    summary: "Convertir, découper et lire des documents ; reconnaître le texte des scans.",
    highlights: ["pandoc", "Tesseract (fra, eng)", "OCRmyPDF", "poppler", "qpdf"],
    apt: ["pandoc", "poppler-utils", "tesseract-ocr", "tesseract-ocr-fra", "tesseract-ocr-eng", "ghostscript", "qpdf"],
    pip: ["ocrmypdf", "pypdf", "pdfplumber", "python-docx", "openpyxl", "python-pptx"],
    npm: [],
    cpus: 2, memory_mb: 4096, disk_mb: 16384,
  },
];

export const templateById = (id: string | null | undefined): MachineTemplate | null =>
  (id ? TEMPLATES.find((t) => t.id === id) : null) ?? null;

/** Ce que le front montre : les catégories et les modèles, sans rien de plus. */
export const catalog = () => ({ categories: CATEGORIES, templates: TEMPLATES });

// Un paquet passe tel quel dans une commande : rien d'autre que des noms et des contraintes de version.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._+\-[\]=<>~!,:@/]*$/;
const list = (xs: string[]) => xs.filter((x) => SAFE.test(x)).map((x) => `'${x}'`).join(" ");

/** Les lignes Dockerfile qui ajoutent les outils d'un modèle (pour une image Debian bookworm, en root). */
export function templateLayer(t: MachineTemplate): string[] {
  return [
    ...(t.apt.length ? [`RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${list(t.apt)} && rm -rf /var/lib/apt/lists/*`] : []),
    ...(t.pip.length ? [`RUN pip3 install --no-cache-dir --break-system-packages ${list(t.pip)}`] : []),
    ...(t.npm.length ? [`RUN npm install -g --no-audit --no-fund ${list(t.npm)} && npm cache clean --force`] : []),
  ];
}

/**
 * L'image d'une machine d'équipe du catalogue : team-machine et la couche du
 * modèle. Les binaires setuid que les paquets ajoutent sont désarmés comme dans
 * l'image de base (aucun agent ne redevient root).
 */
export function machineDockerfile(t: MachineTemplate, baseImage: string): string {
  return [
    `# Machine « ${t.name} » (${t.id}) : team-machine et les outils de son métier.`,
    `FROM ${baseImage}`,
    "USER root",
    ...templateLayer(t),
    "RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true",
    `LABEL founderos.template="${t.id}"`,
    "",
  ].join("\n");
}

/** Le nom de l'image d'un modèle, d'après celui de la machine d'équipe (même version). */
export function templateImage(baseImage: string, t: MachineTemplate): string {
  const [repo, tag = "latest"] = baseImage.split(/:(?=[^/]+$)/);
  return `${repo}-${t.id}:${tag}`;
}

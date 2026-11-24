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
  /**
   * Avant l'installation apt : ajouter le dépôt d'un éditeur (paquet absent de
   * Debian). Des commandes FIXES, écrites ici (SETUP), jamais venues d'un
   * utilisateur ; gnupg, curl et /etc/apt/keyrings sont prêts avant elles.
   */
  setup?: string[];
  /** Après les paquets : ce qui ne s'installe pas par apt, pip ou npm (une version figée). Même règle. */
  after?: string[];
}

/** Les étapes fixes des outils qui ne sont pas dans Debian bookworm `main`. */
const SETUP = {
  // https://trivy.dev/docs/latest/getting-started/installation/ (dépôt apt, suite « generic »)
  trivyRepo: [
    "curl -fsSL https://aquasecurity.github.io/trivy-repo/deb/public.key | gpg --dearmor -o /etc/apt/keyrings/trivy.gpg",
    "echo 'deb [signed-by=/etc/apt/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb generic main' > /etc/apt/sources.list.d/trivy.list",
  ],
  // https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/ (pkgs.k8s.io, version mineure figée)
  kubernetesRepo: [
    "curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes.gpg",
    "echo 'deb [signed-by=/etc/apt/keyrings/kubernetes.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' > /etc/apt/sources.list.d/kubernetes.list",
  ],
  // nikto est dans la section non-free de Debian : on l'active (images bookworm, sources au format deb822).
  debianNonFree: [
    "sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources",
  ],
  // helm : l'archive officielle d'une version figée, pour l'architecture de la machine.
  helm: [
    "ARCH=$(dpkg --print-architecture) && curl -fsSL https://get.helm.sh/helm-v3.16.2-linux-${ARCH}.tar.gz | tar -xz -C /tmp && install -m 0755 /tmp/linux-${ARCH}/helm /usr/local/bin/helm && rm -rf /tmp/linux-${ARCH}",
  ],
} as const;

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
  { id: "ops-k8s", category: "ops", name: "Kubernetes et conteneurs", summary: "kubectl, helm, les commandes Docker.", apt: ["kubectl", "docker.io"], pip: [], npm: [], note: "Les commandes seules : aucun démon Docker ne tourne dans la machine.", setup: [...SETUP.kubernetesRepo], after: [...SETUP.helm] },
  { id: "ops-net", category: "ops", name: "Réseau et transfert", summary: "rsync, SSH, curl, wget.", apt: ["rsync", "openssh-client", "curl", "wget"], pip: [], npm: [] },

  // ── Documents ──
  { id: "docs-convert", category: "docs", name: "Conversion de documents", summary: "pandoc, poppler, qpdf, ghostscript ; lecture et écriture Office.", apt: ["pandoc", "poppler-utils", "qpdf", "ghostscript"], pip: ["pypdf", "pdfplumber", "python-docx", "openpyxl", "python-pptx"], npm: [] },
  { id: "docs-ocr", category: "docs", name: "OCR", summary: "Tesseract (français, anglais) et OCRmyPDF.", apt: ["tesseract-ocr", "tesseract-ocr-fra", "tesseract-ocr-eng"], pip: ["ocrmypdf"], npm: [] },

  // ── Sécurité défensive ──
  { id: "defsec-dfir", category: "defsec", name: "Analyse de fichiers (DFIR)", summary: "Signatures, métadonnées, extraction : yara, binwalk, exiftool, sleuthkit.", apt: ["yara", "binwalk", "libimage-exiftool-perl", "foremost", "sleuthkit", "xxd"], pip: ["yara-python", "pefile", "python-evtx"], npm: [] },
  { id: "defsec-memory", category: "defsec", name: "Analyse mémoire", summary: "Examiner une capture mémoire (Volatility 3).", apt: [], pip: ["volatility3"], npm: [] },
  { id: "defsec-capture", category: "defsec", name: "Captures réseau", summary: "Lire et filtrer des captures : tshark, tcpdump.", apt: ["tshark", "tcpdump"], pip: ["scapy"], npm: [] },
  { id: "defsec-sast", category: "defsec", name: "Audit de code", summary: "Analyse statique : Semgrep, Bandit.", apt: [], pip: ["semgrep", "bandit"], npm: [] },
  { id: "defsec-deps", category: "defsec", name: "Audit de dépendances", summary: "Vulnérabilités connues : pip-audit, Trivy.", apt: ["trivy"], pip: ["pip-audit"], npm: [], setup: [...SETUP.trivyRepo] },
  { id: "defsec-logs", category: "defsec", name: "Analyse de journaux", summary: "Parcourir et agréger des journaux : ripgrep, jq, Python.", apt: ["ripgrep", "jq"], pip: ["pandas", "python-dateutil"], npm: [] },

  // ── Audit réseau (autorisé) ──
  { id: "netsec-recon", category: "netsec", name: "Cartographie réseau", summary: "Ports, services, DNS, sous-domaines : nmap, dnsutils, whois.", apt: ["nmap", "whois", "dnsutils", "netcat-openbsd", "traceroute"], pip: ["dnspython"], npm: [], note: "À n'utiliser que sur des systèmes que vous êtes autorisé à tester." },
  { id: "netsec-webaudit", category: "netsec", name: "Audit d'application web", summary: "Scanner de configuration et de contenu : nikto, gobuster.", apt: ["nikto", "gobuster"], pip: ["requests", "httpx"], npm: [], note: "À n'utiliser que dans le cadre d'une mission autorisée.", setup: [...SETUP.debianNonFree] },

  // ── Développement (suite) ──
  { id: "dev-cpp", category: "dev", name: "C et C++", summary: "cmake, clang, gdb, valgrind.", apt: ["cmake", "clang", "gdb", "valgrind"], pip: [], npm: [] },
  { id: "dev-php", category: "dev", name: "PHP et Composer", summary: "PHP en ligne de commande et Composer.", apt: ["php-cli", "php-curl", "php-mbstring", "php-xml", "composer"], pip: [], npm: [] },
  { id: "dev-ruby", category: "dev", name: "Ruby", summary: "Ruby, ses en-têtes et Bundler.", apt: ["ruby", "ruby-dev", "bundler"], pip: [], npm: [] },
  { id: "dev-containers", category: "dev", name: "Images de conteneurs", summary: "Construire et copier des images sans démon : buildah, skopeo.", apt: ["buildah", "skopeo"], pip: [], npm: [] },
  { id: "dev-proto", category: "dev", name: "Protocol Buffers et gRPC", summary: "Le compilateur protobuf et les outils gRPC Python.", apt: ["protobuf-compiler"], pip: ["grpcio-tools"], npm: [] },
  { id: "dev-shell", category: "dev", name: "Scripts shell", summary: "Analyse statique de scripts : shellcheck.", apt: ["shellcheck"], pip: [], npm: [] },

  // ── Data (suite) ──
  { id: "data-viz", category: "data", name: "Visualisation", summary: "Graphiques riches : plotly, altair, bokeh.", apt: [], pip: ["plotly", "altair", "bokeh", "kaleido"], npm: [] },
  { id: "data-bigdata", category: "data", name: "Gros volumes", summary: "Traitement distribué : PySpark et Dask.", apt: [], pip: ["pyspark", "dask[complete]"], npm: [], note: "PySpark a besoin d'un Java (outil « Java et Maven »)." },
  { id: "data-geo", category: "data", name: "Données géospatiales", summary: "Cartes et géométries : geopandas, shapely, folium.", apt: [], pip: ["geopandas", "shapely", "folium", "pyproj"], npm: [] },
  { id: "data-formats", category: "data", name: "Fichiers tabulaires", summary: "Manipuler CSV, TSV et tableaux en ligne de commande.", apt: ["miller"], pip: ["csvkit", "visidata"], npm: [] },

  // ── IA et ML (suite) ──
  { id: "ia-deep", category: "ia", name: "Apprentissage profond (CPU)", summary: "PyTorch et torchvision, sur processeur.", apt: [], pip: ["torch", "torchvision"], npm: [], note: "Image lourde ; sur processeur, sans carte graphique." },
  { id: "ia-nlp", category: "ia", name: "Traitement du langage", summary: "transformers, sentence-transformers, spaCy.", apt: [], pip: ["transformers", "sentence-transformers", "spacy"], npm: [], note: "Les modèles se téléchargent au premier usage." },
  { id: "ia-llm", category: "ia", name: "Applications LLM", summary: "LangChain et les SDK des fournisseurs.", apt: [], pip: ["langchain", "langchain-community", "openai", "anthropic", "tiktoken"], npm: [] },
  { id: "ia-cv", category: "ia", name: "Vision par ordinateur", summary: "OpenCV (sans écran), scikit-image, Pillow.", apt: [], pip: ["opencv-python-headless", "scikit-image", "pillow"], npm: [] },
  { id: "ia-vector", category: "ia", name: "Bases vectorielles", summary: "Recherche de similarité : FAISS, Chroma.", apt: [], pip: ["faiss-cpu", "chromadb"], npm: [] },

  // ── Web et collecte (suite) ──
  { id: "web-automation", category: "web", name: "Navigation pilotée", summary: "Playwright et Selenium (Python).", apt: [], pip: ["playwright", "selenium"], npm: [], note: "Les navigateurs s'installent au premier usage (playwright install)." },
  { id: "web-download", category: "web", name: "Téléchargement de médias", summary: "yt-dlp et gallery-dl.", apt: ["yt-dlp"], pip: ["gallery-dl"], npm: [], note: "Respectez les conditions d'utilisation et les droits des contenus." },
  { id: "web-http", category: "web", name: "Appels HTTP", summary: "HTTPie en ligne de commande.", apt: ["httpie"], pip: [], npm: [] },

  // ── Ops et cloud (suite) ──
  { id: "ops-azure", category: "ops", name: "Azure", summary: "L'interface en ligne de commande Azure.", apt: [], pip: ["azure-cli"], npm: [] },
  { id: "ops-gcp", category: "ops", name: "Google Cloud (stockage)", summary: "gsutil et la bibliothèque de stockage.", apt: [], pip: ["gsutil", "google-cloud-storage"], npm: [] },
  { id: "ops-db-tui", category: "ops", name: "Consoles de bases", summary: "pgcli, mycli, litecli, avec complétion.", apt: [], pip: ["pgcli", "mycli", "litecli"], npm: [] },
  { id: "ops-shell", category: "ops", name: "Confort du terminal", summary: "tmux, htop, ncdu.", apt: ["tmux", "htop", "ncdu"], pip: [], npm: [] },
  { id: "ops-serve", category: "ops", name: "Servir un dossier", summary: "Un petit serveur HTTP statique.", apt: [], pip: [], npm: ["http-server", "serve"] },

  // ── Documents (suite) ──
  { id: "docs-latex", category: "docs", name: "LaTeX", summary: "Composer des PDF avec LaTeX (XeLaTeX, latexmk).", apt: ["texlive-latex-recommended", "texlive-fonts-recommended", "texlive-xetex", "latexmk"], pip: [], npm: [], note: "Image lourde." },
  { id: "docs-images", category: "docs", name: "Traitement d'images", summary: "ImageMagick et optimisation (PNG, JPEG, WebP).", apt: ["imagemagick", "optipng", "jpegoptim", "webp"], pip: [], npm: [] },
  { id: "docs-diagrams", category: "docs", name: "Diagrammes", summary: "Graphviz et Mermaid en ligne de commande.", apt: ["graphviz"], pip: [], npm: ["@mermaid-js/mermaid-cli"], note: "Mermaid rend avec le Chromium de la machine de base." },
  { id: "docs-markdown", category: "docs", name: "Markdown", summary: "Vérifier et rendre du Markdown.", apt: [], pip: [], npm: ["markdownlint-cli", "markdown-it"] },

  // ── Sécurité défensive (suite) ──
  { id: "defsec-secrets", category: "defsec", name: "Recherche de secrets", summary: "Repérer des secrets commis par erreur.", apt: [], pip: ["detect-secrets"], npm: [] },
  { id: "defsec-crypto", category: "defsec", name: "Chiffrement et signatures", summary: "GnuPG, OpenSSL et les bibliothèques Python.", apt: ["gnupg", "openssl"], pip: ["cryptography", "pyOpenSSL"], npm: [] },
  { id: "defsec-av", category: "defsec", name: "Analyse antivirus", summary: "ClamAV et empreintes floues (ssdeep).", apt: ["clamav", "ssdeep"], pip: [], npm: [], note: "La base de signatures se met à jour au premier usage (freshclam)." },
  { id: "defsec-netmon", category: "defsec", name: "Surveillance réseau", summary: "Détection et inspection : Suricata, ngrep, tcpflow.", apt: ["suricata", "ngrep", "tcpflow"], pip: [], npm: [] },
  { id: "defsec-hardening", category: "defsec", name: "Durcissement et audit système", summary: "Lynis, AIDE, auditd.", apt: ["lynis", "aide", "auditd"], pip: [], npm: [] },
  { id: "defsec-iac", category: "defsec", name: "Audit d'infrastructure", summary: "Analyser Terraform, Kubernetes et Dockerfile (Checkov).", apt: [], pip: ["checkov"], npm: [] },
  { id: "defsec-intel", category: "defsec", name: "Renseignement sur les menaces", summary: "STIX, TAXII et MISP.", apt: [], pip: ["stix2", "taxii2-client", "pymisp"], npm: [] },

  // ── Audit réseau (autorisé, suite) ──
  { id: "netsec-tls", category: "netsec", name: "Posture TLS", summary: "Vérifier les configurations TLS/SSL : sslscan.", apt: ["sslscan"], pip: [], npm: [], note: "À n'utiliser que sur des systèmes que vous êtes autorisé à tester." },
  { id: "netsec-smb", category: "netsec", name: "Partages SMB", summary: "Inventorier des partages de fichiers Windows.", apt: ["smbclient"], pip: [], npm: [], note: "À n'utiliser que sur des systèmes que vous êtes autorisé à inventorier." },
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
  { id: "preset-recon", category: "netsec", name: "Audit réseau (autorisé)", summary: "Cartographie et audit web d'un périmètre autorisé.", tools: ["netsec-recon", "netsec-webaudit", "netsec-tls"], cpus: 2, memory_mb: 2048, disk_mb: 8192 },
  { id: "preset-fullstack", category: "dev", name: "Développeur full-stack", summary: "Node, Python, C/C++ et clients de bases.", tools: ["dev-node", "dev-python", "dev-cpp", "dev-db-clients"], cpus: 4, memory_mb: 8192, disk_mb: 24576 },
  { id: "preset-deep", category: "ia", name: "Apprentissage profond", summary: "PyTorch, NLP et notebooks (processeur).", tools: ["ia-deep", "ia-nlp", "ia-notebooks", "data-analysis"], cpus: 8, memory_mb: 16384, disk_mb: 49152 },
  { id: "preset-llm", category: "ia", name: "Applications LLM", summary: "LangChain, bases vectorielles et notebooks.", tools: ["ia-llm", "ia-vector", "ia-notebooks"], cpus: 4, memory_mb: 8192, disk_mb: 24576 },
  { id: "preset-geo", category: "data", name: "Data géospatiale", summary: "Cartes, géométries et analyse.", tools: ["data-geo", "data-analysis", "ia-notebooks"], cpus: 4, memory_mb: 8192, disk_mb: 24576 },
  { id: "preset-collect", category: "web", name: "Collecte et veille web", summary: "Extraction, navigation pilotée et HTTP.", tools: ["web-scraping", "web-automation", "web-http"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
  { id: "preset-publishing", category: "docs", name: "Édition et PDF", summary: "Conversion, LaTeX, images et diagrammes.", tools: ["docs-convert", "docs-latex", "docs-images", "docs-diagrams"], cpus: 2, memory_mb: 4096, disk_mb: 32768 },
  { id: "preset-threat-hunting", category: "defsec", name: "Chasse aux menaces", summary: "Fichiers, surveillance réseau, journaux, renseignement.", tools: ["defsec-dfir", "defsec-netmon", "defsec-logs", "defsec-intel"], cpus: 4, memory_mb: 8192, disk_mb: 32768 },
  { id: "preset-hardening", category: "defsec", name: "Durcissement", summary: "Audit système, chiffrement, antivirus.", tools: ["defsec-hardening", "defsec-crypto", "defsec-av"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
  { id: "preset-secreview", category: "defsec", name: "Revue de sécurité du code", summary: "Code, dépendances, secrets et infrastructure.", tools: ["defsec-sast", "defsec-deps", "defsec-secrets", "defsec-iac"], cpus: 2, memory_mb: 4096, disk_mb: 16384 },
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
  // Deux outils peuvent partager une étape (un même dépôt) : une fois suffit.
  const setup = [...new Set(tools.flatMap((t) => t.setup ?? []))];
  const after = [...new Set(tools.flatMap((t) => t.after ?? []))];
  return [
    ...(setup.length ? [
      "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gnupg curl ca-certificates && install -m 0755 -d /etc/apt/keyrings",
      ...setup.map((s) => `RUN ${s}`),
    ] : []),
    ...(apt.length ? [`RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${list(apt)} && rm -rf /var/lib/apt/lists/*`] : []),
    ...(pip.length ? [`RUN pip3 install --no-cache-dir --break-system-packages ${list(pip)}`] : []),
    ...(npm.length ? [`RUN npm install -g --no-audit --no-fund ${list(npm)} && npm cache clean --force`] : []),
    ...after.map((s) => `RUN ${s}`),
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
    // Le superviseur de team-machine tourne en root (il abaisse les droits agent par agent) :
    // pas de USER à la fin, l'image garde l'utilisateur de son image de base.
    ...(layer.length ? ["USER root", ...layer, "RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true"] : []),
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

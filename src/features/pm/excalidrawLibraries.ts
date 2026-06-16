// Curated, high-business-value Excalidraw libraries, grouped by domain. Loaded
// on demand from the official library host (no heavy JSON bundled in the repo).
// URLs follow https://libraries.excalidraw.com/libraries/<author>/<slug>.excalidrawlib
const HOST = "https://libraries.excalidraw.com/libraries";

export interface LibDef { name: string; author: string; slug: string; items?: string }
export interface LibGroup { label: string; libs: LibDef[] }

export const EXCALIDRAW_LIBRARY_GROUPS: LibGroup[] = [
  {
    label: "Architecture & system",
    libs: [
      { name: "Software Architecture", author: "youritjang", slug: "software-architecture", items: "microservice, database, cache, event bus, browser, mobile" },
      { name: "System Design Components", author: "rohanp", slug: "system-design", items: "high-level system diagrams" },
      { name: "Architecture diagram components", author: "childishgirl", slug: "architecture-diagram-components", items: "Slack, Docker, GitHub, VPC, subnets, server" },
      { name: "Software Logos", author: "drwnio", slug: "software-logos", items: "Postgres, Redis, Nginx, Kubernetes, RabbitMQ" },
      { name: "C4 Architecture", author: "burnyshev", slug: "c4-architecture", items: "Person, Web/Mobile App, System, Database" },
      { name: "Hexagonal Architecture", author: "corlaez", slug: "hexagonal-architecture", items: "ports & adapters" },
    ],
  },
  {
    label: "Cloud & DevOps",
    libs: [
      { name: "AWS Architecture Icons", author: "childishgirl", slug: "aws-architecture-icons", items: "Lambda, S3, Kinesis, Glue, Redshift…" },
      { name: "Google Cloud Icons", author: "marcus-guidoti", slug: "google-icons", items: "all GCP & Workspace products" },
      { name: "Microsoft Azure cloud icons", author: "ssethuramaswamy", slug: "azure-cloud-icons", items: "Event Hubs, Cosmos DB, SQL, Redis…" },
      { name: "Dev Ops Icons", author: "marksharpley", slug: "dev-ops-icons", items: "Nomad, Consul, Vault, Ansible, Docker, Terraform" },
      { name: "Cloud", author: "rfranzke", slug: "cloud", items: "Kubernetes, AWS, Azure, GCP" },
      { name: "Kubernetes Icons Set", author: "lowess", slug: "kubernetes", items: "pod, deployment, service, ingress, secret…" },
      { name: "Network topology icons", author: "dwelle", slug: "network-topology-icons", items: "VPN, firewall, server, router, switch" },
    ],
  },
  {
    label: "UML & diagrams",
    libs: [
      { name: "Shapes for UML & ER Diagrams", author: "bjoernkw", slug: "shapes-for-uml-er", items: "UML & ER shapes" },
      { name: "UML — Activity Diagram", author: "krzysztof-koper", slug: "uml-activity-diagram", items: "states, actions, decisions, swimlanes" },
      { name: "Decision flow control", author: "jameswiens", slug: "decision-flow-control", items: "yes/no condition boxes" },
      { name: "Data Flow", author: "wilian-martinez", slug: "data-flow", items: "process, data store, external entity" },
      { name: "BPMN", author: "aoustin-frederic", slug: "bpmn", items: "tasks, events, gateways" },
      { name: "Information Architecture", author: "inwardmovement", slug: "information-architecture", items: "page, flow, decision, area" },
    ],
  },
  {
    label: "Product & UX",
    libs: [
      { name: "Basic UX / wireframing elements", author: "gabi-macakova", slug: "basic-ux-wireframing", items: "buttons, inputs, toggles, dropdowns" },
      { name: "Lo-Fi Wireframing Kit", author: "aleksandra-lazovic", slug: "lo-fi-wireframing-kit", items: "lo-fi components" },
      { name: "Web Kit", author: "sunit-shirke", slug: "web-kit", items: "common web components" },
      { name: "Mobile Kit", author: "sunit-shirke", slug: "mobile-kit", items: "common mobile screens" },
      { name: "Universal UI kit", author: "manuelernesto", slug: "universal-ui-kit", items: "tooltips, charts, inputs, calendars" },
      { name: "Webpage frames", author: "dhaval-godwani", slug: "webpage-frames", items: "loading / viewable / interactive states" },
    ],
  },
  {
    label: "Business & workshop",
    libs: [
      { name: "Business Model Templates", author: "stephan-hellerbrand", slug: "business-model-templates", items: "Business Model Canvas, Value Proposition" },
      { name: "Customer Journey Map", author: "braweria", slug: "customer-journey-map", items: "journey map templates" },
      { name: "Sticky Notes", author: "ferminrp", slug: "sticky-notes", items: "post-its in every color" },
      { name: "Event Storming", author: "fidil", slug: "event-storming", items: "aggregate, command, domain event, actor" },
      { name: "Wardley Maps Symbols", author: "aleksandar-simovic", slug: "wardley-maps", items: "component, customer, pipeline" },
      { name: "Team Topologies", author: "nikordaris", slug: "team-topologies", items: "team interaction shapes" },
      { name: "Scrum board", author: "daniel-cortes-pichardo", slug: "scrum-board", items: "agile board" },
    ],
  },
  {
    label: "Data & charts",
    libs: [
      { name: "Data Viz", author: "dbs-sticky", slug: "data-viz", items: "common charts" },
      { name: "Charts", author: "nicolas-goudry", slug: "charts", items: "bar, column, line, pie" },
      { name: "Data Platform", author: "chu-quang-bach", slug: "data-platform", items: "Kafka, Spark, Airflow, dbt, Snowflake…" },
      { name: "Data sources", author: "kishore", slug: "data-sources", items: "GraphQL, Kafka, USB, Email, FTP" },
      { name: "Data Science logos", author: "fares-hasan", slug: "data-science-logos", items: "Airflow, Jupyter, Pandas, TensorFlow…" },
      { name: "Deep learning", author: "yuelfei-wu", slug: "deep-learning", items: "CNN, RNN, LSTM, Transformer, Attention" },
    ],
  },
  {
    label: "People & extras",
    libs: [
      { name: "Stick Figures", author: "youritjang", slug: "stick-figures", items: "stick people in poses" },
      { name: "Stick Figures Collaboration", author: "dwelle", slug: "stick-figures-collaboration", items: "communication, ideation, listening" },
      { name: "Awesome Icons", author: "ferminrp", slug: "awesome-icons", items: "general-purpose icons" },
      { name: "IT Logos", author: "pclainchard", slug: "it-logos", items: "React, Vue, GitLab, Kafka, Docker, k8s…" },
      { name: "Comms Platform Icons", author: "adamkdean", slug: "comms-platform-icons", items: "Email, Slack, Discord" },
      { name: "Gadgets", author: "morgemoensch", slug: "gadgets", items: "phone, tablet, laptop, smartwatch" },
    ],
  },
];

export function libraryUrl(lib: LibDef): string {
  return `${HOST}/${lib.author}/${lib.slug}.excalidrawlib`;
}

// Curated, high-business-value Excalidraw libraries, grouped by domain. Loaded
// on demand from the official library host. `source` is the EXACT relative path
// from libraries.excalidraw.com's index (libraries.json) — do not guess these.
const HOST = "https://libraries.excalidraw.com/libraries";

export interface LibDef { name: string; source: string; items?: string }
export interface LibGroup { label: string; libs: LibDef[] }

export const EXCALIDRAW_LIBRARY_GROUPS: LibGroup[] = [
  {
    label: "Architecture & system",
    libs: [
      { name: "Software Architecture", source: "youritjang/software-architecture.excalidrawlib", items: "microservice, database, cache, event bus, browser, mobile" },
      { name: "System Design Components", source: "rohanp/system-design.excalidrawlib", items: "high-level system diagrams" },
      { name: "Architecture diagram components", source: "anna-pastushko/architecture-diagram-components.excalidrawlib", items: "Slack, Docker, GitHub, VPC, subnets, server" },
      { name: "Software Logos", source: "drwnio/drwnio.excalidrawlib", items: "Postgres, Redis, Nginx, Kubernetes, RabbitMQ" },
      { name: "C4 Architecture", source: "dmitry-burnyshev/c4-architecture.excalidrawlib", items: "Person, Web/Mobile App, System, Database" },
      { name: "Hexagonal Architecture", source: "corlaez/hexagonal-architecture.excalidrawlib", items: "ports & adapters" },
    ],
  },
  {
    label: "Cloud & DevOps",
    libs: [
      { name: "AWS Architecture Icons", source: "narhari-motivaras/aws-architecture-icons.excalidrawlib", items: "Lambda, EC2, ELB, S3…" },
      { name: "Google Cloud Icons", source: "mguidoti/google-icons.excalidrawlib", items: "all GCP & Workspace products" },
      { name: "Microsoft Azure cloud icons", source: "rockssk/microsoft-azure-cloud-icons.excalidrawlib", items: "Event Hubs, Cosmos DB, SQL, Redis…" },
      { name: "Dev Ops Icons", source: "markopolo123/dev_ops.excalidrawlib", items: "Nomad, Consul, Vault, Ansible, Docker, Terraform" },
      { name: "Cloud", source: "cloud/cloud.excalidrawlib", items: "Kubernetes, AWS, Azure, GCP" },
      { name: "Kubernetes Icons Set", source: "lowess/kubernetes-icons-set.excalidrawlib", items: "pod, deployment, service, ingress, secret…" },
      { name: "Network topology icons", source: "dwelle/network-topology-icons.excalidrawlib", items: "VPN, firewall, server, router, switch" },
    ],
  },
  {
    label: "UML & diagrams",
    libs: [
      { name: "Shapes for UML & ER Diagrams", source: "BjoernKW/UML-ER-library.excalidrawlib", items: "UML & ER shapes" },
      { name: "UML — Activity Diagram", source: "https-github-com-papacrispy/uml-library-activity-diagram.excalidrawlib", items: "states, actions, decisions, swimlanes" },
      { name: "Decision flow control", source: "aretecode/decision-flow-control.excalidrawlib", items: "yes/no condition boxes" },
      { name: "Data Flow", source: "wmartzh/data-flow.excalidrawlib", items: "process, data store, external entity" },
      { name: "BPMN", source: "fraoustin/bpmn.excalidrawlib", items: "tasks, events, gateways" },
      { name: "Information Architecture", source: "inwardmovement/information-architecture.excalidrawlib", items: "page, flow, decision, area" },
    ],
  },
  {
    label: "Product & UX",
    libs: [
      { name: "Basic UX / wireframing elements", source: "gabrielamacakova/basic-ux-wireframing-elements.excalidrawlib", items: "buttons, inputs, toggles, dropdowns" },
      { name: "Lo-Fi Wireframing Kit", source: "spfr/lo-fi-wireframing-kit.excalidrawlib", items: "lo-fi components" },
      { name: "Web Kit", source: "excacomp/web-kit.excalidrawlib", items: "common web components" },
      { name: "Mobile Kit", source: "excacomp/mobile-kit.excalidrawlib", items: "common mobile screens" },
      { name: "Universal UI kit", source: "manuelernestog/universal-ui-kit.excalidrawlib", items: "tooltips, charts, inputs, calendars" },
      { name: "Webpage frames", source: "dhaval_godwani/webpage-frames.excalidrawlib", items: "loading / viewable / interactive states" },
    ],
  },
  {
    label: "Business & workshop",
    libs: [
      { name: "Business Model Templates", source: "shellerbrand/canvases.excalidrawlib", items: "Business Model Canvas, Value Proposition" },
      { name: "Customer Journey Map", source: "braweria/customer-journey-map.excalidrawlib", items: "journey map templates" },
      { name: "Sticky Notes", source: "ferminrp/post-it.excalidrawlib", items: "post-its in every color" },
      { name: "Event Storming", source: "tylerkron/event-storming.excalidrawlib", items: "aggregate, command, domain event, actor" },
      { name: "Wardley Maps Symbols", source: "simalexan/wardley-maps-symbols.excalidrawlib", items: "component, customer, pipeline" },
      { name: "Team Topologies", source: "nikordaris/team-topologies.excalidrawlib", items: "team interaction shapes" },
      { name: "Scrum board", source: "danimaniarqsoft/scrum-board.excalidrawlib", items: "agile board" },
    ],
  },
  {
    label: "Data & charts",
    libs: [
      { name: "Data Viz", source: "dbssticky/data-viz.excalidrawlib", items: "common charts" },
      { name: "Charts", source: "g-script/charts.excalidrawlib", items: "bar, column, line, pie" },
      { name: "Data Platform", source: "chuqbach/data-platform.excalidrawlib", items: "Kafka, Spark, Airflow, dbt, Snowflake…" },
      { name: "Data sources", source: "kvchitrapu/data-sources.excalidrawlib", items: "GraphQL, Kafka, USB, Email, FTP" },
      { name: "Data Science logos", source: "farisology/data-science.excalidrawlib", items: "Airflow, Jupyter, Pandas, TensorFlow…" },
      { name: "Deep learning", source: "yuelfei/deep-learning.excalidrawlib", items: "CNN, RNN, LSTM, Transformer, Attention" },
    ],
  },
  {
    label: "People & extras",
    libs: [
      { name: "Stick Figures", source: "youritjang/stick-figures.excalidrawlib", items: "stick people in poses" },
      { name: "Stick Figures Collaboration", source: "gianpaima/stick-figures-collaboration.excalidrawlib", items: "communication, ideation, listening" },
      { name: "Awesome Icons", source: "ferminrp/awesome-icons.excalidrawlib", items: "general-purpose icons" },
      { name: "IT Logos", source: "pclainchard/it-logos.excalidrawlib", items: "React, Vue, GitLab, Kafka, Docker, k8s…" },
      { name: "Comms Platform Icons", source: "adamkdean/comms-platform-icons.excalidrawlib", items: "Email, Slack, Discord" },
      { name: "Gadgets", source: "morgemoensch/gadgets.excalidrawlib", items: "phone, tablet, laptop, smartwatch" },
    ],
  },
];

export function libraryUrl(lib: LibDef): string {
  return `${HOST}/${lib.source}`;
}

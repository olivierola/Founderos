// Importer une spec OpenAPI (3.x) ou Swagger (2.0), en JSON ou en YAML, et en
// tirer des opérations de connecteur. L'import propose, la personne choisit :
// une API interne expose souvent des centaines de routes, un collaborateur
// n'en a besoin que de quelques-unes.
import yaml from "js-yaml";
import {
  type AuthConfig, type AuthScheme, type ConnectorOperation, type OpParam,
  defaultRisk, normalizeOperation, toOpName,
} from "./api";

export interface OpenApiImport {
  title: string;
  baseUrl: string;
  operations: ConnectorOperation[];
  auth: { scheme: AuthScheme; config: AuthConfig } | null;
}

const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;

type Obj = Record<string, any>;

function resolveRef(doc: Obj, v: Obj | undefined): Obj | undefined {
  if (!v || typeof v !== "object" || typeof v.$ref !== "string") return v;
  const path = v.$ref.replace(/^#\//, "").split("/");
  return path.reduce<Obj | undefined>((acc, k) => (acc ? acc[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), doc);
}

function paramType(schema: Obj | undefined): OpParam["type"] {
  const t = schema?.type;
  if (t === "integer" || t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "object" || t === "array") return "object";
  return "string";
}

function detectAuth(doc: Obj): OpenApiImport["auth"] {
  const schemes: Obj = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  for (const raw of Object.values(schemes)) {
    const s = raw as Obj;
    if (s.type === "http" && String(s.scheme).toLowerCase() === "bearer") {
      return { scheme: "bearer", config: { header: "Authorization", prefix: "Bearer " } };
    }
    if ((s.type === "http" && String(s.scheme).toLowerCase() === "basic") || s.type === "basic") {
      return { scheme: "basic", config: { username: "" } };
    }
    if (s.type === "apiKey" && (s.in === "header" || s.in === "query")) {
      return { scheme: "api_key", config: { in: s.in, name: s.name } };
    }
    if (s.type === "oauth2") {
      const flows = s.flows ?? {};
      if (flows.clientCredentials?.tokenUrl || s.flow === "application") {
        return { scheme: "oauth2_client_credentials", config: { token_url: flows.clientCredentials?.tokenUrl ?? s.tokenUrl, client_id: "" } };
      }
      if (flows.authorizationCode || s.flow === "accessCode") {
        const f = flows.authorizationCode ?? s;
        return {
          scheme: "oauth2_authorization_code",
          config: { authorize_url: f.authorizationUrl, token_url: f.tokenUrl, client_id: "", scope: Object.keys(f.scopes ?? {}).join(" ") },
        };
      }
    }
    if (s.type === "openIdConnect" && s.openIdConnectUrl) {
      return { scheme: "oauth2_client_credentials", config: { issuer: String(s.openIdConnectUrl).replace(/\/\.well-known\/openid-configuration$/, ""), client_id: "" } };
    }
  }
  return null;
}

export function parseOpenApi(text: string): OpenApiImport {
  let doc: Obj;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = yaml.load(text) as Obj;
  }
  if (!doc || typeof doc !== "object" || !doc.paths) throw new Error("Pas de spec OpenAPI reconnue (champ « paths » absent).");

  let baseUrl = "";
  if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
    baseUrl = String(doc.servers[0].url).replace(/\{[^}]+\}/g, (m) => {
      const name = m.slice(1, -1);
      return String(doc.servers[0].variables?.[name]?.default ?? m);
    });
  } else if (doc.host) {
    baseUrl = `${(doc.schemes?.[0] ?? "https")}://${doc.host}${doc.basePath ?? ""}`;
  }

  const ops: ConnectorOperation[] = [];
  const used = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths as Obj)) {
    const shared: Obj[] = Array.isArray((item as Obj).parameters) ? (item as Obj).parameters : [];
    for (const m of METHODS) {
      const op = (item as Obj)[m] as Obj | undefined;
      if (!op) continue;
      let name = toOpName(op.operationId || `${m}_${path.replace(/[{}]/g, "")}`);
      for (let i = 2; used.has(name); i++) name = `${toOpName(op.operationId || `${m}_${path}`).slice(0, 44)}_${i}`;
      used.add(name);

      const params: OpParam[] = [];
      const query: Record<string, string> = {};
      for (const pr of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((x) => resolveRef(doc, x))) {
        if (!pr?.name || !["path", "query"].includes(pr.in)) continue;
        const pname = String(pr.name).replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "p_$1");
        if (params.some((x) => x.name === pname)) continue;
        params.push({
          name: pname,
          type: paramType(pr.schema ?? pr),
          description: String(pr.description ?? "").slice(0, 200) || undefined,
          required: pr.in === "path" ? true : !!pr.required,
          ...(Array.isArray(pr.schema?.enum ?? pr.enum) ? { enum: (pr.schema?.enum ?? pr.enum).map(String).slice(0, 50) } : {}),
        });
        if (pr.in === "query") query[pr.name] = `{${pname}}`;
      }
      const opPath = path.replace(/\{([^}]+)\}/g, (_x, n: string) => `{${n.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "p_$1")}}`);
      const hasBody = !!(op.requestBody || (Array.isArray(op.parameters) && op.parameters.some((x: Obj) => resolveRef(doc, x)?.in === "body")));
      if (hasBody) params.push({ name: "body", type: "object", description: "Corps JSON de la requête.", required: !!op.requestBody?.required });

      const normalized = normalizeOperation({
        name,
        description: String(op.summary || op.description || `${m.toUpperCase()} ${path}`).slice(0, 300),
        method: m.toUpperCase(),
        path: opPath,
        query,
        ...(hasBody ? { body: "{body}" } : {}),
        params,
        risk: defaultRisk(m),
      });
      if (normalized) ops.push(normalized);
    }
  }
  return { title: String(doc.info?.title ?? "API"), baseUrl, operations: ops, auth: detectAuth(doc) };
}

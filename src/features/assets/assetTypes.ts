// Registry of the app objects that can become nodes on the Asset canvas.
// Each node references a real row via (asset_type, ref_id); the canvas reads
// live data through these definitions so the map reflects the true state.
import {
  Users, Handshake, FileText, Receipt, FolderKanban, ListChecks, Bot, Library,
  UserRound, UserPlus, LifeBuoy, Package, Truck, FileSignature, type LucideIcon,
  MessageSquare, Server, GitBranch, Plug, Phone, Globe,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

export interface AssetTypeDef {
  type: string;                 // stable key stored in asset_nodes.asset_type
  label: string;                // singular human label
  plural: string;
  table: string;                // source table
  labelCol: string;             // column used as the node title
  subCol?: string;              // optional secondary line
  icon: LucideIcon;
  color: string;                // tailwind text color for the node accent
  group: string;                // library section
}

export const ASSET_TYPES: AssetTypeDef[] = [
  { type: "crm_contact", label: "Contact", plural: "Contacts", table: "crm_contacts", labelCol: "full_name", subCol: "email", icon: Users, color: "text-emerald-500", group: "People & CRM" },
  { type: "crm_deal", label: "Deal", plural: "Deals", table: "crm_deals", labelCol: "title", icon: Handshake, color: "text-emerald-500", group: "People & CRM" },
  { type: "employee", label: "Employee", plural: "Employees", table: "hr_employees", labelCol: "full_name", subCol: "job_title", icon: UserRound, color: "text-teal-500", group: "People & CRM" },
  { type: "candidate", label: "Candidate", plural: "Candidates", table: "hr_candidates", labelCol: "full_name", subCol: "email", icon: UserPlus, color: "text-teal-500", group: "People & CRM" },

  { type: "invoice", label: "Invoice", plural: "Invoices", table: "fin_invoices", labelCol: "client_name", subCol: "number", icon: Receipt, color: "text-amber-500", group: "Finance" },
  { type: "bill", label: "Bill (AP)", plural: "Bills", table: "fin_bills", labelCol: "number", icon: FileSignature, color: "text-amber-500", group: "Finance" },

  { type: "inbox", label: "Inbox / Channel", plural: "Channels", table: "project_channels", labelCol: "name", subCol: "description", icon: MessageSquare, color: "text-violet-500", group: "Communication" },
  { type: "phone_line", label: "Phone line", plural: "Phone lines", table: "support_voice_lines", labelCol: "label", icon: Phone, color: "text-emerald-500", group: "Communication" },

  { type: "project", label: "Project", plural: "Projects", table: "pm_projects", labelCol: "name", icon: FolderKanban, color: "text-blue-500", group: "Delivery" },
  { type: "task", label: "Task", plural: "Tasks", table: "pm_tasks", labelCol: "title", icon: ListChecks, color: "text-blue-500", group: "Delivery" },

  { type: "ticket", label: "Ticket", plural: "Support tickets", table: "support_tickets", labelCol: "subject", subCol: "requester_email", icon: LifeBuoy, color: "text-sky-500", group: "Support" },

  { type: "server", label: "Server", plural: "Servers", table: "ops_servers", labelCol: "name", subCol: "ip_address", icon: Server, color: "text-red-500", group: "Infrastructure" },
  { type: "repo", label: "Repository", plural: "Repositories", table: "repositories", labelCol: "name", subCol: "full_name", icon: GitBranch, color: "text-indigo-500", group: "Infrastructure" },
  { type: "connector", label: "Integration", plural: "Integrations", table: "connectors", labelCol: "provider", icon: Plug, color: "text-pink-500", group: "Infrastructure" },
  { type: "website", label: "Website", plural: "Websites", table: "app_health_monitors", labelCol: "url", icon: Globe, color: "text-amber-500", group: "Infrastructure" },

  { type: "agent", label: "Agent", plural: "Agents", table: "internal_agents", labelCol: "name", icon: Bot, color: "text-fuchsia-500", group: "AI & Knowledge" },
  { type: "rag_collection", label: "RAG collection", plural: "RAG collections", table: "rag_collections", labelCol: "name", icon: Library, color: "text-violet-500", group: "AI & Knowledge" },
  { type: "document", label: "Document", plural: "Documents", table: "office_documents", labelCol: "title", icon: FileText, color: "text-zinc-400", group: "AI & Knowledge" },

  { type: "inventory_item", label: "Good / SKU", plural: "Inventory", table: "sc_inventory_items", labelCol: "name", subCol: "sku", icon: Package, color: "text-orange-500", group: "Supply chain" },
  { type: "supplier", label: "Supplier", plural: "Suppliers", table: "sc_suppliers", labelCol: "name", subCol: "contact_name", icon: Truck, color: "text-orange-500", group: "Supply chain" },
];

export const ASSET_BY_TYPE: Record<string, AssetTypeDef> = Object.fromEntries(ASSET_TYPES.map((a) => [a.type, a]));

export const ASSET_GROUPS: { group: string; types: AssetTypeDef[] }[] = (() => {
  const order: string[] = [];
  const map: Record<string, AssetTypeDef[]> = {};
  for (const a of ASSET_TYPES) { if (!map[a.group]) { map[a.group] = []; order.push(a.group); } map[a.group].push(a); }
  return order.map((group) => ({ group, types: map[group] }));
})();

export interface AssetOption { ref_id: string; label: string; sub?: string }

// List selectable rows of a given asset type for the library picker.
export async function fetchAssetOptions(def: AssetTypeDef, projectId: string, search: string): Promise<AssetOption[]> {
  const cols = ["id", def.labelCol, def.subCol].filter(Boolean).join(", ");
  let q = supabase.from(def.table).select(cols).eq("project_id", projectId).limit(50);
  if (search.trim()) q = q.ilike(def.labelCol, `%${search.trim()}%`);
  const { data } = await q;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
    ref_id: String(r.id),
    label: String(r[def.labelCol] ?? "Untitled"),
    sub: def.subCol ? (r[def.subCol] != null ? String(r[def.subCol]) : undefined) : undefined,
  }));
}

// Semantic relation types for edges.
export const RELATIONS = ["relates_to", "owns", "billed_to", "assigned_to", "depends_on", "supplies", "manages", "part_of"] as const;

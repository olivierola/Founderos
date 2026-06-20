import { supabase } from "@/lib/supabase";
import type { CrmObject } from "./objectModel";

// Catalog of module classes that can be added to the CRM as live-synced objects.
// Keep slugs/icons in sync with crm_source_catalog (migration 0074).
export interface ObjectTemplate {
  slug: string;
  label: string;
  label_plural: string;
  icon: string;      // crmIcons name
  color: string;
  description: string;
}

export const OBJECT_TEMPLATES: ObjectTemplate[] = [
  { slug: "documents", label: "Document", label_plural: "Documents", icon: "FileText", color: "text-zinc-400", description: "Docs, spreadsheets & presentations from Création." },
  { slug: "discussions", label: "Discussion", label_plural: "Discussions", icon: "MessageSquare", color: "text-sky-500", description: "Project inbox channels." },
  { slug: "simulations", label: "Simulation", label_plural: "Simulations", icon: "FlaskConical", color: "text-purple-500", description: "Persona simulations." },
  { slug: "autonomous_agents", label: "Autonomous agent", label_plural: "Autonomous agents", icon: "Bot", color: "text-fuchsia-500", description: "Internal autonomous agents." },
  { slug: "public_agents", label: "Public agent", label_plural: "Public agents", icon: "Bot", color: "text-emerald-500", description: "RAG / public-facing agents." },
  { slug: "missions", label: "Mission", label_plural: "Missions", icon: "Target", color: "text-amber-500", description: "Agent & employee missions, with deliverables." },
  { slug: "projects", label: "Project", label_plural: "Projects", icon: "FolderKanban", color: "text-blue-500", description: "Delivery projects (status, tasks)." },
  { slug: "tasks_pm", label: "Task", label_plural: "Tasks", icon: "CheckSquare", color: "text-emerald-500", description: "Project tasks — linked to their project." },
  { slug: "employees", label: "Team member", label_plural: "Team members", icon: "Users", color: "text-teal-500", description: "Employees, with manager relations." },
  { slug: "whiteboards", label: "Whiteboard", label_plural: "Whiteboards", icon: "PenSquare", color: "text-orange-500", description: "Collaborative whiteboards." },
  { slug: "inventory", label: "Good", label_plural: "Inventory", icon: "Package", color: "text-amber-600", description: "Stock items — linked to suppliers." },
  { slug: "suppliers", label: "Supplier", label_plural: "Suppliers", icon: "Truck", color: "text-orange-500", description: "Supply-chain suppliers." },
  { slug: "invoices", label: "Invoice", label_plural: "Invoices", icon: "Receipt", color: "text-amber-500", description: "AR invoices — linked to projects." },
  { slug: "bills", label: "Bill", label_plural: "Bills", icon: "FileSignature", color: "text-amber-600", description: "AP bills from vendors." },
  { slug: "tickets", label: "Ticket", label_plural: "Tickets", icon: "LifeBuoy", color: "text-sky-500", description: "Support tickets." },
  { slug: "integrations", label: "Integration", label_plural: "Integrations", icon: "Plug", color: "text-fuchsia-500", description: "Connected third-party integrations." },
  // Wave 2 — Finance + Supply
  { slug: "bank_accounts", label: "Bank account", label_plural: "Bank accounts", icon: "Wallet", color: "text-emerald-500", description: "Treasury bank accounts." },
  { slug: "journal_entries", label: "Journal entry", label_plural: "Journal entries", icon: "FileText", color: "text-amber-500", description: "Double-entry journal." },
  { slug: "purchase_orders", label: "Purchase order", label_plural: "Purchase orders", icon: "Receipt", color: "text-orange-500", description: "POs — linked to suppliers." },
  { slug: "shipments", label: "Shipment", label_plural: "Shipments", icon: "Truck", color: "text-orange-500", description: "Shipments — linked to POs." },
  { slug: "sales_orders", label: "Sales order", label_plural: "Sales orders", icon: "Receipt", color: "text-blue-500", description: "Customer sales orders." },
  { slug: "warehouses", label: "Warehouse", label_plural: "Warehouses", icon: "Package", color: "text-amber-600", description: "Stock locations." },
  { slug: "returns", label: "Return", label_plural: "Returns", icon: "Package", color: "text-rose-500", description: "RMA returns." },
  // Wave 3 — HR + PSA
  { slug: "candidates", label: "Candidate", label_plural: "Candidates", icon: "UserPlus", color: "text-teal-500", description: "Applicants — linked to openings." },
  { slug: "job_openings", label: "Job opening", label_plural: "Job openings", icon: "Briefcase", color: "text-teal-500", description: "Open roles." },
  { slug: "onboardings", label: "Onboarding", label_plural: "Onboardings", icon: "UserPlus", color: "text-teal-500", description: "New-hire onboardings." },
  { slug: "resources", label: "Resource", label_plural: "Resources", icon: "Users", color: "text-blue-500", description: "PSA resources." },
  { slug: "timesheets", label: "Timesheet", label_plural: "Timesheets", icon: "Clock", color: "text-blue-500", description: "Logged hours — linked to project & resource." },
  { slug: "allocations", label: "Allocation", label_plural: "Allocations", icon: "Calendar", color: "text-blue-500", description: "Capacity allocations per week." },
  // Waves 4+5 — AI / Code / Assets
  { slug: "rag_collections", label: "RAG collection", label_plural: "RAG collections", icon: "Library", color: "text-violet-500", description: "Knowledge collections." },
  { slug: "repositories", label: "Repository", label_plural: "Repositories", icon: "GitBranch", color: "text-zinc-400", description: "Connected code repos." },
  { slug: "servers", label: "Server", label_plural: "Servers", icon: "AppWindow", color: "text-sky-500", description: "Ops servers." },
  { slug: "asset_canvases", label: "Asset map", label_plural: "Asset maps", icon: "Shapes", color: "text-indigo-500", description: "Asset canvases." },
  // Wave 6 — Support / AI / Code / Ops
  { slug: "support_channels", label: "Channel", label_plural: "Channels", icon: "MessageSquare", color: "text-sky-500", description: "Support channels (email/chat/voice…)." },
  { slug: "kb_articles", label: "KB article", label_plural: "KB articles", icon: "FileText", color: "text-sky-500", description: "Help-center articles." },
  { slug: "voice_calls", label: "Voice call", label_plural: "Voice calls", icon: "Phone", color: "text-emerald-500", description: "Call-center calls — linked to tickets." },
  { slug: "agent_runs", label: "Agent run", label_plural: "Agent runs", icon: "Bot", color: "text-fuchsia-500", description: "Agent executions — linked to missions." },
  { slug: "code_scans", label: "Code scan", label_plural: "Code scans", icon: "GitBranch", color: "text-zinc-400", description: "Repo scans — linked to repositories." },
  { slug: "ops_jobs", label: "Ops job", label_plural: "Ops jobs", icon: "AppWindow", color: "text-sky-500", description: "Infra jobs — linked to servers." },
];

// Instantiate a template as a live-synced CRM object (+ backfill existing rows).
export async function addObjectFromTemplate(workspaceId: string, projectId: string, slug: string, userId: string | null): Promise<CrmObject | null> {
  const { error } = await supabase.rpc("crm_add_from_catalog", {
    p_workspace: workspaceId, p_project: projectId, p_slug: slug, p_user: userId,
  });
  if (error) throw new Error(error.message);
  const { data } = await supabase.from("crm_objects").select("*").eq("project_id", projectId).eq("slug", slug).maybeSingle();
  return (data as CrmObject) ?? null;
}

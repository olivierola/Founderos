// SkillEditor — full-page multi-file skill authoring surface (Agent-Skills
// format). A skill = a name + description + SKILL.md (the main playbook, stored
// in agent_skills.system_prompt_extension) + optional bundled resource files
// (agent_skill_files) the agent pulls on demand at runtime via read_skill_file.
//
// Routes: agent/skills/new  and  agent/skills/:skillId/edit
import { useState, useMemo, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, Plus, FolderPlus, FileText, FileCode, MoreVertical,
  Loader2, Trash2, Pencil, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

const SKILL_MD = "SKILL.md";

interface SkillFile {
  path: string;
  content: string;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function fileIcon(path: string) {
  const cls = "h-4 w-4 text-muted-foreground shrink-0";
  if (/\.(py|js|ts|sh|rb|go|json|ya?ml)$/i.test(path)) return <FileCode className={cls} />;
  return <FileText className={cls} />;
}

export function SkillEditorPage() {
  const { skillId, workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { workspaceId } = useCurrentContext();
  const isEdit = !!skillId;
  const skillsHome = `/app/${workspaceSlug}/${projectSlug}/agent/skills`;

  // Editable fields.
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [skillMd, setSkillMd] = useState("");           // SKILL.md body → system_prompt_extension
  const [files, setFiles] = useState<SkillFile[]>([]);    // additional bundled files
  const [active, setActive] = useState<string>(SKILL_MD); // active file path (or SKILL.md)
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const slug = useMemo(() => slugify(name), [name]);

  // Load an existing skill (+ its files) when editing.
  const { data: existing } = useQuery({
    queryKey: ["agent_skill_edit", skillId],
    enabled: isEdit,
    queryFn: async () => {
      const [{ data: sk }, { data: fs }] = await Promise.all([
        supabase.from("agent_skills").select("*").eq("id", skillId).maybeSingle(),
        supabase.from("agent_skill_files").select("path, content, sort").eq("skill_id", skillId).order("sort"),
      ]);
      return { skill: sk, files: (fs ?? []) as Array<{ path: string; content: string; sort: number }> };
    },
  });

  useEffect(() => {
    if (!existing?.skill || loaded) return;
    const s = existing.skill as any;
    setName(s.name ?? "");
    setDescription(s.description ?? "");
    setSkillMd(s.system_prompt_extension ?? "");
    setFiles(existing.files.map((f) => ({ path: f.path, content: f.content ?? "" })));
    setLoaded(true);
  }, [existing, loaded]);

  const isSystem = isEdit && (existing?.skill as any)?.is_system === true;
  const readOnly = isSystem; // system skills are seeded — don't overwrite them here

  // ── File operations ──
  function uniquePath(base: string): string {
    const taken = new Set([SKILL_MD, ...files.map((f) => f.path)]);
    if (!taken.has(base)) return base;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let i = 1;
    while (taken.has(`${stem}-${i}${ext}`)) i++;
    return `${stem}-${i}${ext}`;
  }
  function addFile(prefix = "") {
    const path = uniquePath(`${prefix}untitled.md`);
    setFiles((f) => [...f, { path, content: "" }]);
    setActive(path);
  }
  function addFolder() {
    const folder = prompt("Nom du dossier (ex. references)")?.trim().replace(/^\/+|\/+$/g, "");
    if (!folder) return;
    addFile(`${folder}/`);
  }
  function renameFile(oldPath: string) {
    const next = prompt("Nouveau nom du fichier", oldPath)?.trim().replace(/^\/+/, "");
    if (!next || next === oldPath) return;
    if (next === SKILL_MD || files.some((f) => f.path === next)) {
      alert("Ce nom de fichier est déjà utilisé.");
      return;
    }
    setFiles((f) => f.map((x) => (x.path === oldPath ? { ...x, path: next } : x)));
    setActive((a) => (a === oldPath ? next : a));
  }
  function deleteFile(path: string) {
    if (!confirm(`Supprimer « ${path} » ?`)) return;
    setFiles((f) => f.filter((x) => x.path !== path));
    setActive((a) => (a === path ? SKILL_MD : a));
  }

  const activeContent = active === SKILL_MD ? skillMd : (files.find((f) => f.path === active)?.content ?? "");
  function setActiveContent(v: string) {
    if (active === SKILL_MD) setSkillMd(v);
    else setFiles((f) => f.map((x) => (x.path === active ? { ...x, content: v } : x)));
  }

  // ── Save ──
  async function save() {
    if (!name.trim() || !workspaceId || readOnly) return;
    setSaving(true);
    try {
      let id = skillId;
      if (isEdit) {
        const { error } = await supabase.from("agent_skills").update({
          name: name.trim(),
          description: description.trim() || null,
          system_prompt_extension: skillMd.trim() || null,
        }).eq("id", skillId);
        if (error) { alert(error.message); return; }
      } else {
        const { data, error } = await supabase.from("agent_skills").insert({
          workspace_id: workspaceId,
          name: name.trim(),
          slug: slug || `skill-${Date.now()}`,
          description: description.trim() || null,
          system_prompt_extension: skillMd.trim() || null,
          is_system: false,
        }).select("id").single();
        if (error) { alert(error.message); return; }
        id = (data as { id: string }).id;
      }
      // Replace the bundled files (small counts → wipe + reinsert is simplest).
      if (id) {
        await supabase.from("agent_skill_files").delete().eq("skill_id", id);
        const rows = files
          .filter((f) => f.path.trim())
          .map((f, i) => ({ skill_id: id, path: f.path.trim(), content: f.content, sort: i }));
        if (rows.length) {
          const { error } = await supabase.from("agent_skill_files").insert(rows);
          if (error) { alert(error.message); return; }
        }
      }
      queryClient.invalidateQueries({ queryKey: ["agent_skills_all"] });
      queryClient.invalidateQueries({ queryKey: ["agent_skill_edit", id] });
      goBack();
    } finally {
      setSaving(false);
    }
  }

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate(skillsHome);
  }

  const allFiles: string[] = [SKILL_MD, ...files.map((f) => f.path)];

  return (
    // Fills the whole tab content area (the route is registered full-bleed in
    // AppShell → no app padding/max-width), while keeping the sidebar & topbar.
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top bar: breadcrumb + save */}
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-1.5 text-sm">
          <button onClick={goBack} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" /> Skills
          </button>
          <span className="text-muted-foreground/50">/</span>
          <span className="font-medium text-foreground">{isEdit ? (name || "Skill") : "Nouveau skill"}</span>
        </div>
        <Button size="sm" onClick={save} disabled={saving || !name.trim() || readOnly}>
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          {isEdit ? "Enregistrer" : "Créer"}
        </Button>
      </div>

      {readOnly && (
        <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-5 py-2 text-xs text-amber-700 dark:text-amber-400">
          <Lock className="h-3.5 w-3.5" /> Ce skill système est en lecture seule. Duplique-le pour l'adapter.
        </div>
      )}

      {/* Name + description */}
      <div className="border-b border-border px-5 py-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly}
          placeholder="new-skill"
          className="w-full bg-transparent text-2xl font-semibold tracking-tight text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-70"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
          rows={1}
          placeholder="Utilisez cette compétence lorsque l'utilisateur demande de…"
          className="mt-1 w-full resize-none bg-transparent text-sm text-muted-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-70"
        />
        {slug && !isEdit && (
          <p className="mt-1 text-[10px] text-muted-foreground">slug : <span className="font-mono">{slug}</span></p>
        )}
      </div>

      {/* Files + editor */}
      <div className="flex min-h-0 flex-1">
        {/* File tree */}
        <div className="flex w-64 shrink-0 flex-col border-r border-border">
          <div className="flex items-center justify-between px-4 py-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fichiers</span>
            {!readOnly && (
              <div className="flex items-center gap-1">
                <button onClick={() => addFile()} title="Nouveau fichier" className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <Plus className="h-4 w-4" />
                </button>
                <button onClick={addFolder} title="Nouveau dossier" className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
                  <FolderPlus className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {allFiles.map((path) => {
              const isSkillMd = path === SKILL_MD;
              return (
                <div
                  key={path}
                  onClick={() => setActive(path)}
                  className={cn(
                    "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    active === path ? "bg-secondary text-foreground" : "text-foreground/80 hover:bg-secondary/50",
                  )}
                >
                  {fileIcon(path)}
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                  {!isSkillMd && !readOnly && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-foreground group-hover:opacity-100"
                          aria-label="Actions"
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => renameFile(path)}>
                          <Pencil className="mr-2 h-3.5 w-3.5" /> Renommer
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => deleteFile(path)}>
                          <Trash2 className="mr-2 h-3.5 w-3.5" /> Supprimer
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* File editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-5 py-2.5 text-sm font-medium text-foreground">{active}</div>
          <textarea
            value={activeContent}
            onChange={(e) => setActiveContent(e.target.value)}
            disabled={readOnly}
            placeholder={active === SKILL_MD
              ? "# " + (name || "Skill") + "\n\nDécrivez ici la méthodologie / le playbook de ce skill…"
              : "Écrivez ici le contenu de votre fichier."}
            className="min-h-0 flex-1 resize-none bg-transparent px-5 py-4 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:outline-none disabled:opacity-70"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}

// delete-workspace — destructive deletion of a workspace and ALL related data.
// Body: { workspace_id, confirm_slug }

import type { Request, Response } from "express";
import { requireUser } from "../shared/authz.ts";
import { HttpError } from "../shared/http.ts";
import { createServiceClient } from "../shared/supabase.ts";

export async function deleteWorkspace(req: Request, res: Response): Promise<void> {
  const userId = await requireUser(req);

  const { workspace_id, confirm_slug } = req.body;
  if (!workspace_id || !confirm_slug) {
    throw new HttpError(400, "workspace_id, confirm_slug required");
  }

  const admin = createServiceClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("slug, owner_id")
    .eq("id", workspace_id)
    .maybeSingle();
  if (!ws) throw new HttpError(404, "Workspace not found");
  if (ws.owner_id !== userId) {
    throw new HttpError(403, "Only the workspace owner can delete it");
  }
  if (ws.slug !== confirm_slug) {
    throw new HttpError(400, `confirm_slug must equal '${ws.slug}'`);
  }

  // Cascades handle most child rows
  const { error } = await admin.from("workspaces").delete().eq("id", workspace_id);
  if (error) throw new HttpError(500, error.message);

  res.json({ ok: true });
}

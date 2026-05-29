-- Allow workspace owners/admins to delete scan jobs and scan results.
-- Without these, RLS silently blocks client-side deletes.

create policy "Workspace admins delete scan_jobs"
on public.scan_jobs for delete
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = scan_jobs.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

create policy "Workspace admins delete scan_results"
on public.scan_results for delete
using (
  exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = scan_results.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner','admin')
  )
);

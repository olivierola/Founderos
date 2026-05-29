import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, UserCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export function SettingsProfilePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { data: profile, isLoading } = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    setFullName(profile?.full_name ?? "");
  }, [profile]);

  async function handleSave() {
    if (!user) return;
    setSaving(true);
    setSaved(false);
    await supabase.from("profiles").upsert({ id: user.id, full_name: fullName });
    await queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    setSaving(false);
    setSaved(true);
  }

  return (
    <div>
      <PageHeader title="Profile" description="Your personal account details." />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCircle className="h-4 w-4" /> Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Email</label>
                <Input value={user?.email ?? ""} disabled />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Full name</label>
                <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" />
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save profile
                </Button>
                {saved && <span className="text-xs text-emerald-400">Saved.</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

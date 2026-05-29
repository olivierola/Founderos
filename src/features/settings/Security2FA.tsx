import { useEffect, useState } from "react";
import { Loader2, Shield, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";

interface Factor {
  id: string;
  factor_type: string;
  status: string;
  friendly_name?: string;
}

export function SettingsSecurityPage() {
  const [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [enroll, setEnroll] = useState<{ qr: string; secret: string; factorId: string } | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (!error && data) setFactors(data.all ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function startEnroll() {
    setEnrolling(true);
    setError(null);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Authenticator app" });
    setEnrolling(false);
    if (error || !data) {
      setError(error?.message ?? "Failed to start enrollment");
      return;
    }
    setEnroll({ qr: data.totp.qr_code, secret: data.totp.secret, factorId: data.id });
  }

  async function verify() {
    if (!enroll) return;
    setVerifying(true);
    setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId: enroll.factorId });
    if (challenge.error || !challenge.data) {
      setError(challenge.error?.message ?? "Challenge failed");
      setVerifying(false);
      return;
    }
    const res = await supabase.auth.mfa.verify({
      factorId: enroll.factorId,
      challengeId: challenge.data.id,
      code,
    });
    setVerifying(false);
    if (res.error) {
      setError(res.error.message);
      return;
    }
    setEnroll(null);
    setCode("");
    await load();
  }

  async function unenroll(factorId: string) {
    if (!confirm("Remove this 2FA factor?")) return;
    await supabase.auth.mfa.unenroll({ factorId });
    await load();
  }

  const verified = factors.filter((f) => f.status === "verified");

  return (
    <div>
      <PageHeader title="Security" description="Account-level security: two-factor authentication and encryption." />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" /> Two-factor authentication (TOTP)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : verified.length > 0 ? (
            <div className="space-y-2">
              {verified.map((f) => (
                <div key={f.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    <span>{f.friendly_name ?? "Authenticator"}</span>
                    <Badge variant="success">enabled</Badge>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => unenroll(f.id)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : enroll ? (
            <div className="space-y-3">
              <img src={enroll.qr} alt="QR code" className="rounded-lg border border-border bg-white p-2" />
              <div className="text-xs text-muted-foreground">
                Or enter this secret manually: <code className="text-foreground">{enroll.secret}</code>
              </div>
              <Input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
              <div className="flex gap-2">
                <Button onClick={verify} disabled={verifying || code.length !== 6}>
                  {verifying && <Loader2 className="h-4 w-4 animate-spin" />} Verify & enable
                </Button>
                <Button variant="ghost" onClick={() => setEnroll(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button onClick={startEnroll} disabled={enrolling}>
              {enrolling && <Loader2 className="h-4 w-4 animate-spin" />} Enable 2FA
            </Button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="text-sm font-medium">Security features active</div>
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Credentials encrypted at rest (AES-GCM 256)
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Row-Level Security on every workspace table
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Audit log for every admin action
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              High-risk actions require confirmation phrase
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import type { ReactNode } from "react";
import {
  ChartBarIcon as BarChart3,
  CalendarBlankIcon as Calendar,
  CalendarCheckIcon as CalendarCheck2,
  CheckCircleIcon as CheckCircle2,
  ClipboardTextIcon as ClipboardCheck,
  CodeIcon as Code2,
  DatabaseIcon as Database,
  FileTextIcon as FileText,
  FingerprintIcon as Fingerprint,
  GaugeIcon as Gauge,
  GlobeIcon as Globe,
  HandshakeIcon as Handshake,
  HeadphonesIcon as Headphones,
  StackIcon as Layers,
  ChatCircleIcon as MessageCircle,
  ChartPieIcon as PieChart,
  ArrowsClockwiseIcon as RefreshCw,
  GearSixIcon as Settings,
  ShieldIcon as Shield,
  ShieldCheckIcon as ShieldCheck,
  SparkleIcon as Sparkles,
  ArrowSquareOutIcon as SquareArrowOutUpRight,
  TrendUpIcon as TrendingUp,
  UserIcon as User,
  UserGearIcon as UserCog,
  UsersIcon as Users,
} from "@phosphor-icons/react";

/* Read from CSS vars so a single class on the card re-tints the whole diagram
   (see .amp-viz / .amp-viz-orange / .amp-viz-lime in globals.css). */
const ACCENT = "var(--vz-accent)";
const NEON = "var(--vz-neon)";
const LINE = "var(--vz-line)";
const FILL = "var(--vz-fill)";
const TILE = "var(--vz-tile)";

/* ── Shared chrome ─────────────────────────────────────────────────────────
   Every solution visual sits in a black inner panel at the top of its card. */
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`relative aspect-[4/4.5] w-full overflow-hidden rounded-xl border border-white/[0.08] bg-black ${className}`}
    >
      {children}
    </div>
  );
}

/* Neon-outlined header chip that titles each diagram. */
function Chip({
  icon: Icon,
  title,
  sub,
  className = "",
}: {
  icon: typeof Shield;
  title: string;
  sub?: string;
  className?: string;
}) {
  return (
    <div
      className={`inline-flex items-center gap-2.5 rounded-xl border px-3 py-2 ${className}`}
      style={{ borderColor: LINE, background: FILL }}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
        style={{ borderColor: LINE, background: TILE }}
      >
        <Icon className="h-3.5 w-3.5" style={{ color: NEON }} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[11.5px] font-medium leading-tight text-white">{title}</span>
        {sub && <span className="block truncate text-[9.5px] leading-tight text-white/40">{sub}</span>}
      </span>
    </div>
  );
}

/* ══ 1. AI readiness scan ═══════════════════════════════════════════════════ */
const MODULES = [
  { icon: PieChart, name: "Finance", level: "L3" },
  { icon: Settings, name: "Operations", level: "L4" },
  { icon: Headphones, name: "Support", level: "L3" },
  { icon: ShieldCheck, name: "Compliance", level: "L3" },
  { icon: Handshake, name: "Onboarding", level: "L2" },
  { icon: Fingerprint, name: "KYC / AML", level: "L4" },
];

const SNAPSHOT = [
  { name: "KYC / AML", pct: 82, level: "L4" },
  { name: "Support", pct: 64, level: "L3" },
  { name: "Operations", pct: 44, level: "L2" },
  { name: "Sales", pct: 24, level: "L1" },
];

export function ReadinessScan() {
  return (
    <Panel>
      <div className="flex h-full flex-col items-center gap-3 p-4">
        <Chip icon={Shield} title="AI Readiness Scan" />

        {/* Module grid with a sweeping scan line */}
        <div
          className="relative w-full rounded-xl border p-2.5"
          style={{ borderColor: "rgba(255,255,255,0.09)" }}
        >
          <div className="grid grid-cols-3 gap-2">
            {MODULES.map((m) => {
              const Icon = m.icon;
              return (
                <div
                  key={m.name}
                  className="flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2"
                  style={{ borderColor: "rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.02)" }}
                >
                  <Icon className="h-3.5 w-3.5 text-white/70" />
                  <span className="text-[8.5px] leading-none text-white/70">{m.name}</span>
                  <span className="rounded border border-white/[0.12] px-1 text-[7.5px] leading-[1.4] text-white/50">
                    {m.level}
                  </span>
                </div>
              );
            })}
          </div>
          <span
            className="amp-scan amp-neon pointer-events-none absolute inset-x-2 h-px"
            style={{ background: `linear-gradient(90deg, transparent, ${NEON}, transparent)` }}
          />
        </div>

        {/* Maturity snapshot */}
        <div
          className="w-full flex-1 rounded-xl border p-2.5"
          style={{ borderColor: "rgba(255,255,255,0.09)" }}
        >
          <div className="mb-2 flex items-center gap-1.5">
            <BarChart3 className="h-3 w-3" style={{ color: NEON }} />
            <span className="text-[9.5px] text-white/70">Maturity Snapshot</span>
          </div>
          <div className="space-y-1.5">
            {SNAPSHOT.map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-[8px] text-white/45">{s.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.08]">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${s.pct}%`, background: `linear-gradient(90deg, ${ACCENT}, ${NEON})` }}
                  />
                </span>
                <span className="rounded border border-white/[0.12] px-1 text-[7.5px] leading-[1.4] text-white/50">
                  {s.level}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/* ══ 2. Secured agents — concentric governance shield ═══════════════════════ */
const RINGS = [
  { label: "Identity", icon: User },
  { label: "Network", icon: Globe },
  { label: "Data", icon: Database },
  { label: "Policy", icon: ShieldCheck },
  { label: "Audit", icon: ClipboardCheck },
];

/* A flat-top shield inset by `i` steps, in a 500 × 700 viewBox. The sides run
   straight down then angle in to a shared apex — an angular chevron, not the
   rounded U a quadratic curve gives. */
function shieldPath(i: number) {
  const left = 40 + i * 46;
  const right = 460 - i * 46;
  const top = 40 + i * 62;
  const apexY = 646 - i * 12;
  const shoulder = top + (apexY - top) * 0.42;
  const r = 14;
  return [
    `M ${left + r} ${top}`,
    `H ${right - r}`,
    `A ${r} ${r} 0 0 1 ${right} ${top + r}`,
    `V ${shoulder}`,
    `L 250 ${apexY}`,
    `L ${left} ${shoulder}`,
    `V ${top + r}`,
    `A ${r} ${r} 0 0 1 ${left + r} ${top}`,
    "Z",
  ].join(" ");
}

export function SecurityShield({
  dense = false,
  className = "w-full max-w-[330px]",
}: {
  dense?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative mx-auto aspect-[500/700] ${className}`}>
      <svg viewBox="0 0 500 700" className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <radialGradient id="ampCore" cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="#dff1ff" />
            <stop offset="45%" stopColor={NEON} />
            <stop offset="100%" stopColor={ACCENT} />
          </radialGradient>
        </defs>
        {RINGS.map((_, i) => (
          <path
            key={i}
            d={shieldPath(i)}
            fill="none"
            stroke={NEON}
            strokeWidth={2.6}
            strokeLinejoin="round"
            // The pulse runs outside-in: the outer ring lights first.
            className="amp-neon amp-ring"
            style={{ animationDelay: `${i * 0.26}s` }}
          />
        ))}
        {/* Core sitting just above the shared apex */}
        <circle cx="250" cy="470" r="34" fill="url(#ampCore)" opacity="0.95" />
        <circle cx="250" cy="470" r="50" fill="none" stroke={NEON} strokeWidth="0.9" strokeOpacity="0.3" />
      </svg>

      {/* Ring labels punched through the strokes */}
      {RINGS.map((r, i) => {
        const Icon = r.icon;
        const top = ((40 + i * 62) / 700) * 100;
        return (
          <div
            key={r.label}
            className="absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 bg-black px-2"
            style={{ top: `${top}%` }}
          >
            <Icon className="h-3 w-3 text-white/70" />
            <span className="text-[10px] leading-none text-white/80">{r.label}</span>
          </div>
        );
      })}

      {/* Audit trail */}
      {!dense && (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-1.5">
          <div className="flex items-center gap-2.5">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: i === 4 ? "#fff" : NEON,
                  boxShadow: `0 0 ${i === 4 ? 10 : 5}px ${i === 4 ? "#fff" : NEON}`,
                }}
              />
            ))}
          </div>
          <span className="text-[9px] text-white/45">Audit Trail</span>
        </div>
      )}
    </div>
  );
}

export function SecuredAgents() {
  return (
    <Panel>
      <div className="flex h-full flex-col items-center gap-2 p-4">
        <Chip icon={Sparkles} title="Secured AI Agents" sub="Inside your tenant" />
        {/* Height-driven: the 3D shield icon displays at optimal size */}
        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
          <img 
            src="/landing/secure.jpg" 
            alt="Secured AI Agents Shield" 
            className="h-full w-auto max-w-xs rounded-lg drop-shadow-lg object-contain"
          />
        </div>
      </div>
    </Panel>
  );
}

/* ══ 3. Foundation — a command resolving into structured actions ════════════ */
const RESOLVED = [
  { icon: CalendarCheck2, label: "Cancel Meeting", tint: "#5b8def" },
  { icon: FileText, label: "Report Scheduled", tint: ACCENT },
  { icon: Database, label: "Data Compiled", tint: "#8b5cf6" },
  { icon: MessageCircle, label: "Send WhatsApp", tint: "#25d366" },
];

export function FoundationFlow() {
  return (
    <Panel>
      <div
        className="absolute inset-0"
        style={{ background: `radial-gradient(ellipse at 70% 90%, ${TILE}, transparent 62%)` }}
      />
      <div className="relative flex h-full flex-col justify-center gap-3 p-5">
        <div
          className="flex items-center rounded-lg border px-3 py-2.5"
          style={{ borderColor: ACCENT, background: "rgba(0,0,0,0.6)" }}
        >
          <span className="text-[12px] text-white/90">Schedule We</span>
          <span className="ml-px h-3.5 w-px animate-pulse bg-white" />
        </div>

        <div
          className="rounded-xl border p-2"
          style={{ borderColor: "rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.02)" }}
        >
          {RESOLVED.map((r, i) => {
            const Icon = r.icon;
            return (
              <div
                key={r.label}
                // Rows resolve one after another, as if the command were being
                // executed rather than listed.
                className="amp-seq flex items-center gap-2.5 rounded-lg px-2 py-2"
                style={{ animationDelay: `${i * 0.42}s` }}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{ background: `${r.tint}26` }}
                >
                  <Icon className="h-3.5 w-3.5" style={{ color: r.tint }} />
                </span>
                <span className="text-[11.5px] text-white/85">{r.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

/* ══ 4. Adoption — champions lighting up across the org chart ═══════════════ */
const SEATS = [
  { champion: false, badge: MessageCircle },
  { champion: true, badge: Sparkles },
  { champion: true, badge: MessageCircle },
  { champion: false, badge: BarChart3 },
  { champion: true, badge: CheckCircle2 },
  { champion: true, badge: Users },
  { champion: false, badge: FileText },
  { champion: false, badge: Sparkles },
  { champion: false, badge: Calendar },
];

export function AdoptionGrid() {
  return (
    <Panel>
      <div className="flex h-full flex-col items-center gap-3 p-4">
        <Chip icon={UserCog} title="Adoption & Change Enablement" sub="Human-led adoption" />

        <div className="flex w-full flex-1 items-center gap-2.5">
          <div
            className="grid flex-1 grid-cols-3 gap-2 rounded-xl border p-2.5"
            style={{ borderColor: "rgba(255,255,255,0.09)" }}
          >
            {SEATS.map((s, i) => {
              const Badge = s.badge;
              return (
                <div
                  key={i}
                  // Champions light up one after another — adoption spreading
                  // through the org rather than a frozen snapshot.
                  className={`relative flex h-10 items-center justify-center rounded-lg border ${s.champion ? "amp-seq" : ""}`}
                  style={{
                    borderColor: s.champion ? "var(--vz-line)" : "rgba(255,255,255,0.1)",
                    background: s.champion ? "var(--vz-fill)" : "rgba(255,255,255,0.02)",
                    boxShadow: s.champion ? `0 0 12px var(--vz-glow)` : "none",
                    animationDelay: `${i * 0.3}s`,
                  }}
                >
                  <User className="h-4 w-4" style={{ color: s.champion ? NEON : "rgba(255,255,255,0.45)" }} />
                  <span
                    className="absolute -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded border bg-black"
                    style={{ borderColor: s.champion ? LINE : "rgba(255,255,255,0.12)" }}
                  >
                    <Badge className="h-2 w-2" style={{ color: s.champion ? NEON : "rgba(255,255,255,0.4)" }} />
                  </span>
                </div>
              );
            })}
          </div>

          {/* Adoption meter */}
          <div
            className="flex h-full w-8 shrink-0 flex-col gap-1 rounded-lg border p-1"
            style={{ borderColor: "rgba(255,255,255,0.09)" }}
          >
            <span className="text-center text-[7px] leading-none text-white/40">Adopt.</span>
            {[0.95, 0.75, 1, 0.5, 0.28, 0.14, 0.08, 0.05].map((o, i) => (
              <span
                key={i}
                className="block flex-1 rounded-sm"
                style={{ background: i === 2 ? "#fff" : `color-mix(in srgb, var(--vz-accent) ${Math.round(o*100)}%, transparent)` }}
              />
            ))}
          </div>
        </div>

        <Chip icon={TrendingUp} title="Adoption grows through champions" sub="Enable, coach, reinforce" className="w-full" />
      </div>
    </Panel>
  );
}

/* ══ 5. Governance — controls checked off, resolving to one verdict ═════════ */
const CONTROLS = [
  { icon: ShieldCheck, label: "Permissions" },
  { icon: Fingerprint, label: "MFA" },
  { icon: FileText, label: "DLP Policy" },
  { icon: ClipboardCheck, label: "Compliance" },
  { icon: SquareArrowOutUpRight, label: "Private Endpoints" },
  { icon: User, label: "Owner" },
  { icon: Layers, label: "Center of Excellence" },
  { icon: Calendar, label: "Review" },
];

export function GovernanceCloud() {
  return (
    <Panel>
      <div className="flex h-full flex-col items-center justify-between p-4">
        <Chip icon={Shield} title="Agent & AI Governance" />
        <span className="h-3 w-px" style={{ background: NEON }} />

        <div
          className="grid w-full grid-cols-2 gap-1.5 rounded-xl border p-2"
          style={{ borderColor: LINE, background: FILL }}
        >
          {CONTROLS.map((c, i) => {
            const Icon = c.icon;
            return (
              <div
                key={c.label}
                // Controls clear one by one, like a review pass running.
                className="amp-seq flex items-center gap-1.5 rounded-lg border px-2 py-1.5"
                style={{
                  borderColor: "rgba(255,255,255,0.1)",
                  background: "rgba(0,0,0,0.5)",
                  animationDelay: `${i * 0.26}s`,
                }}
              >
                <Icon className="h-3 w-3 shrink-0 text-white/60" />
                <span className="min-w-0 flex-1 truncate text-[9.5px] text-white/80">{c.label}</span>
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
              </div>
            );
          })}
        </div>

        <span className="h-3 w-px" style={{ background: NEON }} />
        <Chip icon={ShieldCheck} title="Governed. Trusted. Aligned." />
      </div>
    </Panel>
  );
}

/* ══ 6. Managed run — request → team → evolving platform ════════════════════ */
const TEAM = [
  { icon: UserCog, label: "Architect", on: false },
  { icon: User, label: "Consultant", on: true },
  { icon: Code2, label: "Developer", on: false },
];

const LOOP = [
  { icon: Settings, label: "Operate" },
  { icon: RefreshCw, label: "Evolve" },
  { icon: Shield, label: "Govern" },
  { icon: User, label: "Adopt" },
];

export function ManagedRun() {
  return (
    <Panel>
      <div className="flex h-full flex-col items-center justify-between gap-1.5 p-4">
        <Chip icon={Layers} title="Managed Run & Evolution" sub="Ongoing care" className="w-full" />
        <Chip icon={MessageCircle} title="Your Request" sub="one channel, one ticket" />

        <div
          className="w-full rounded-xl border p-2"
          style={{ borderColor: "rgba(255,255,255,0.1)" }}
        >
          <div className="mb-1.5 text-center text-[8px] uppercase tracking-[0.16em] text-white/40">Team</div>
          <div className="grid grid-cols-3 gap-1.5">
            {TEAM.map((t) => {
              const Icon = t.icon;
              return (
                <div
                  key={t.label}
                  className="flex flex-col items-center gap-1 rounded-lg border py-2"
                  style={{
                    borderColor: t.on ? "var(--vz-line)" : "rgba(255,255,255,0.1)",
                    background: t.on ? "var(--vz-fill)" : "transparent",
                    boxShadow: t.on ? "0 0 12px var(--vz-glow)" : "none",
                  }}
                >
                  <Icon className="h-3.5 w-3.5" style={{ color: t.on ? NEON : "rgba(255,255,255,0.6)" }} />
                  <span className="text-[8px] text-white/65">{t.label}</span>
                  <span
                    className="h-1 w-1 rounded-full"
                    style={{ background: t.on ? "var(--vz-accent)" : "rgba(255,255,255,0.25)" }}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <Chip icon={Gauge} title="Your Platform, Evolving" />

        <div
          className="flex w-full items-center justify-between rounded-xl border px-2.5 py-2"
          style={{ borderColor: "rgba(255,255,255,0.1)" }}
        >
          {LOOP.map((l, i) => {
            const Icon = l.icon;
            return (
              <span
                key={l.label}
                // The loop cycles Operate → Evolve → Govern → Adopt, forever.
                className="amp-seq flex items-center gap-1.5"
                style={{ animationDelay: `${i * 0.5}s` }}
              >
                {i > 0 && <span className="mr-1.5 h-1 w-1 rounded-full bg-white/25" />}
                <Icon className="h-3 w-3" style={{ color: NEON }} />
                <span className="text-[8.5px] text-white/70">{l.label}</span>
              </span>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

/* ══ Challenge illustrations — flat, on the light band ══════════════════════ */
const INK = "#102a3f";
const TEAL = "#3f8f8c";

export function ShadowAiArt() {
  return (
    <svg viewBox="0 0 240 180" className="h-full w-full" role="img" aria-label="A cracked wall with a chat bubble">
      {/* wall */}
      <rect x="46" y="86" width="148" height="76" rx="3" fill={INK} />
      <g stroke="#fff" strokeOpacity="0.14" strokeWidth="2">
        <path d="M46 111h148M46 137h148M84 86v25M150 86v25M64 111v26M120 111v26M176 111v26M100 137v25M160 137v25" />
      </g>
      {/* crack */}
      <path d="M118 86l-6 18 10 10-8 16 7 12-5 20" stroke="#fff" strokeOpacity="0.55" strokeWidth="2.5" fill="none" />
      {/* bubble */}
      <ellipse cx="112" cy="62" rx="38" ry="25" fill={ACCENT} opacity="0.85" />
      <path d="M96 82l-6 16 20-11z" fill={ACCENT} opacity="0.85" />
      <g fill="#fff">
        <circle cx="99" cy="62" r="4" />
        <circle cx="112" cy="62" r="4" />
        <circle cx="125" cy="62" r="4" />
      </g>
      {/* leak */}
      <circle cx="158" cy="52" r="7" fill={TEAL} className="amp-float" style={{ animationDelay: "0.2s" }} />
      <circle cx="176" cy="34" r="5" fill={TEAL} opacity="0.65" className="amp-float" style={{ animationDelay: "1.1s" }} />
      <path d="M150 60l-8 6" stroke={TEAL} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function NoFoundationArt() {
  return (
    <svg viewBox="0 0 240 180" className="h-full w-full" role="img" aria-label="A star balanced on a collapsing platform">
      <path d="M60 132h58l6-20 14 20h42v30H60z" fill={INK} />
      <path d="M118 132l6-20 14 20" fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="2.5" />
      <circle cx="120" cy="58" r="30" fill={ACCENT} opacity="0.9" />
      <path d="M120 40l6.6 13.4 14.8 2.1-10.7 10.4 2.5 14.7-13.2-7-13.2 7 2.5-14.7-10.7-10.4 14.8-2.1z" fill={TEAL} />
      <circle cx="162" cy="42" r="13" fill={ACCENT} />
      <path d="M162 35v9" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <circle cx="162" cy="49" r="2" fill="#fff" />
      <path
        className="amp-crawl"
        d="M108 92l-6 8M100 106l-5 7"
        stroke={TEAL}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="1 7"
      />
    </svg>
  );
}

export function NoGovernanceArt() {
  return (
    <svg viewBox="0 0 240 180" className="h-full w-full" role="img" aria-label="A bot surrounded by question marks">
      <rect x="88" y="72" width="64" height="44" rx="10" fill={INK} />
      <circle cx="106" cy="94" r="7" fill={TEAL} />
      <circle cx="134" cy="94" r="7" fill={TEAL} />
      <g className="amp-crawl" stroke="#9b8ea3" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 8">
        <path d="M92 76L66 50M148 76l26-26M120 118v22" />
      </g>
      {[
        { x: 58, y: 42 },
        { x: 182, y: 42 },
        { x: 120, y: 152 },
      ].map((p) => (
        <g key={`${p.x}-${p.y}`}>
          <circle cx={p.x} cy={p.y} r="17" fill={ACCENT} />
          <text
            x={p.x}
            y={p.y + 7}
            textAnchor="middle"
            fill="#fff"
            fontSize="20"
            fontWeight="700"
            fontFamily="Geist, sans-serif"
          >
            ?
          </text>
        </g>
      ))}
    </svg>
  );
}

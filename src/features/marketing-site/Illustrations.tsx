/* SVG illustrations used across the marketing site.
 * Hand-rolled, inline, no external assets. Animated via the keyframes
 * defined in globals.css (.mkt-*).
 */

export function CockpitMockup({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 640 420" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="cm-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--card))" />
          <stop offset="100%" stopColor="hsl(var(--background))" />
        </linearGradient>
        <linearGradient id="cm-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(var(--primary-soft))" stopOpacity="0.9" />
          <stop offset="100%" stopColor="hsl(var(--accent-2))" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id="cm-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary-soft))" stopOpacity="0.35" />
          <stop offset="100%" stopColor="hsl(var(--primary-soft))" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="640" height="420" rx="16" fill="url(#cm-bg)" stroke="hsl(var(--border))" />

      {/* Sidebar */}
      <rect x="14" y="14" width="44" height="392" rx="10" fill="hsl(var(--secondary))" />
      {[40, 80, 120, 160, 200, 240, 280, 320].map((y, i) => (
        <circle key={y} cx="36" cy={y} r="4" fill={i === 1 ? "hsl(var(--primary-soft))" : "hsl(var(--muted-foreground))"} opacity={i === 1 ? 1 : 0.5} />
      ))}

      {/* Topbar */}
      <rect x="72" y="14" width="554" height="36" rx="8" fill="hsl(var(--secondary))" />
      <circle cx="92" cy="32" r="4" fill="hsl(var(--accent-2))" />
      <rect x="108" y="27" width="110" height="10" rx="3" fill="hsl(var(--border))" />
      <rect x="500" y="22" width="110" height="20" rx="6" fill="hsl(var(--background))" />

      {/* KPI tiles */}
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={72 + i * 140} y={66} width={130} height={70} rx="10" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
          <rect x={82 + i * 140} y={78} width={50} height={6} rx="2" fill="hsl(var(--muted-foreground))" opacity="0.5" />
          <rect x={82 + i * 140} y={96} width={80} height={14} rx="3" fill="hsl(var(--foreground))" />
          <rect x={82 + i * 140} y={118} width={40} height={6} rx="2" fill="hsl(var(--accent-2))" opacity="0.7" />
        </g>
      ))}

      {/* Big chart */}
      <rect x="72" y="152" width="408" height="240" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <rect x="86" y="166" width="100" height="8" rx="3" fill="hsl(var(--muted-foreground))" opacity="0.6" />
      <rect x="86" y="186" width="60" height="14" rx="3" fill="hsl(var(--foreground))" />

      {/* Sparkline path */}
      <path
        d="M86 340 L130 320 L170 300 L210 285 L250 295 L290 260 L330 240 L370 215 L410 200 L450 180 L470 175"
        stroke="url(#cm-line)"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M86 340 L130 320 L170 300 L210 285 L250 295 L290 260 L330 240 L370 215 L410 200 L450 180 L470 175 L470 380 L86 380 Z"
        fill="url(#cm-area)"
      />
      {/* End dot with pulse */}
      <circle cx="470" cy="175" r="4" fill="hsl(var(--accent-2))" />
      <circle cx="470" cy="175" r="4" fill="hsl(var(--accent-2))" className="mkt-pulse-ring" style={{ transformOrigin: "470px 175px" }} />

      {/* Right column small cards */}
      <rect x="494" y="152" width="132" height="74" rx="10" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <rect x="504" y="166" width="60" height="6" rx="2" fill="hsl(var(--muted-foreground))" opacity="0.5" />
      <rect x="504" y="182" width="60" height="14" rx="3" fill="hsl(var(--foreground))" />
      <rect x="504" y="206" width="100" height="6" rx="2" fill="hsl(var(--primary-soft))" />
      <rect x="504" y="206" width="62" height="6" rx="2" fill="hsl(var(--accent-2))" />

      <rect x="494" y="240" width="132" height="74" rx="10" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <rect x="504" y="254" width="40" height="6" rx="2" fill="hsl(var(--muted-foreground))" opacity="0.5" />
      <rect x="504" y="270" width="50" height="14" rx="3" fill="hsl(var(--foreground))" />
      <circle cx="608" cy="277" r="10" stroke="hsl(var(--accent-2))" strokeWidth="2.5" fill="none" />

      <rect x="494" y="328" width="132" height="64" rx="10" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <rect x="504" y="342" width="80" height="6" rx="2" fill="hsl(var(--muted-foreground))" opacity="0.5" />
      <rect x="504" y="358" width="100" height="6" rx="2" fill="hsl(var(--border))" />
      <rect x="504" y="372" width="70" height="6" rx="2" fill="hsl(var(--border))" />
    </svg>
  );
}

export function ArchitectureDiagram({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 560 320" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="ad-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="hsl(var(--primary-soft))" stopOpacity="0.4" />
          <stop offset="100%" stopColor="hsl(var(--primary-soft))" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Glow behind center */}
      <ellipse cx="280" cy="160" rx="220" ry="110" fill="url(#ad-glow)" />

      {/* Central node — FounderOS */}
      <rect x="220" y="130" width="120" height="60" rx="10" fill="hsl(var(--card))" stroke="hsl(var(--primary-soft))" strokeWidth="1.5" />
      <text x="280" y="156" textAnchor="middle" fontSize="12" fontWeight="600" fill="hsl(var(--foreground))">FounderOS</text>
      <text x="280" y="172" textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))">cockpit</text>

      {/* External nodes */}
      {[
        { x: 40, y: 50, label: "Stripe", color: "#635BFF" },
        { x: 40, y: 150, label: "Supabase", color: "#3ecf8e" },
        { x: 40, y: 250, label: "GitHub", color: "hsl(var(--accent-2))" },
        { x: 460, y: 50, label: "Vercel", color: "hsl(var(--primary-soft))" },
        { x: 460, y: 150, label: "Sentry", color: "#f6651a" },
        { x: 460, y: 250, label: "Slack", color: "#4a154b" },
      ].map((n) => (
        <g key={n.label}>
          <rect x={n.x} y={n.y - 14} width="80" height="28" rx="6" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
          <circle cx={n.x + 14} cy={n.y} r="4" fill={n.color} />
          <text x={n.x + 26} y={n.y + 4} fontSize="10" fill="hsl(var(--foreground))">{n.label}</text>
        </g>
      ))}

      {/* Connector lines */}
      {[
        { x1: 120, y1: 50, x2: 220, y2: 145 },
        { x1: 120, y1: 150, x2: 220, y2: 160 },
        { x1: 120, y1: 250, x2: 220, y2: 175 },
        { x1: 460, y1: 50, x2: 340, y2: 145 },
        { x1: 460, y1: 150, x2: 340, y2: 160 },
        { x1: 460, y1: 250, x2: 340, y2: 175 },
      ].map((l, i) => (
        <line
          key={i}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke="hsl(var(--primary-soft))"
          strokeOpacity="0.55"
          strokeWidth="1.5"
          className="mkt-dash"
        />
      ))}
    </svg>
  );
}

export function FlowDiagram({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 560 220" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      {["Sign up", "Activate", "Convert", "Retain"].map((label, i) => {
        const x = 60 + i * 140;
        return (
          <g key={label}>
            <rect x={x - 50} y="80" width="100" height="60" rx="10" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
            <text x={x} y="106" textAnchor="middle" fontSize="11" fontWeight="600" fill="hsl(var(--foreground))">{label}</text>
            <text x={x} y="124" textAnchor="middle" fontSize="9" fill="hsl(var(--muted-foreground))">
              {[1240, 880, 412, 354][i]} users
            </text>
            {i < 3 && (
              <>
                <line x1={x + 50} y1="110" x2={x + 90} y2="110" stroke="hsl(var(--primary-soft))" strokeOpacity="0.6" strokeWidth="1.5" className="mkt-dash" />
                <text x={x + 70} y="100" textAnchor="middle" fontSize="9" fill="hsl(var(--accent-2))">
                  {["71%", "47%", "86%"][i]}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function GradientOrb({ className, color = "hsl(var(--primary-soft))" }: { className?: string; color?: string }) {
  return (
    <div className={className}>
      <div
        className="absolute inset-0 mkt-blob rounded-full blur-3xl opacity-30"
        style={{ background: color }}
      />
    </div>
  );
}

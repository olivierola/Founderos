import {
  ArrowsClockwiseIcon,
  ChartLineUpIcon,
  FileTextIcon,
  GaugeIcon,
  HeadsetIcon,
  ReceiptIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SparkleIcon,
  TreeStructureIcon,
  TruckIcon,
  UserFocusIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/* ── The agent badge ────────────────────────────────────────────────────────
   On the marketing pages an agent is shown by its ROLE, not by a mascot: a
   tinted square with the role's icon. The product keeps its animated bots;
   next to enterprise copy they read as playful, and a buyer comparing
   vendors reads playful as unfinished. */

type Role = { match: RegExp; icon: typeof SparkleIcon; tint: string; ink: string };

const ROLES: Role[] = [
  { match: /financ|ledger|invoice/i, icon: ReceiptIcon, tint: "#eaf2ff", ink: "#0b5ed7" },
  { match: /recruit|hr\b|hiring/i, icon: UserFocusIcon, tint: "#eef0ff", ink: "#4447d6" },
  { match: /support|help/i, icon: HeadsetIcon, tint: "#e6f7fa", ink: "#0b7285" },
  { match: /report|writer/i, icon: FileTextIcon, tint: "#f1f3f7", ink: "#344054" },
  { match: /sales|crm/i, icon: ChartLineUpIcon, tint: "#fff3e8", ink: "#c2510c" },
  { match: /ops|operation|supply/i, icon: TruckIcon, tint: "#e6f7fa", ink: "#0b7285" },
  { match: /legal|contract/i, icon: ScalesIcon, tint: "#f1f3f7", ink: "#344054" },
  { match: /govern|audit|policy/i, icon: ShieldCheckIcon, tint: "#eef0ff", ink: "#4447d6" },
  { match: /readiness|assess/i, icon: GaugeIcon, tint: "#eaf2ff", ink: "#0b5ed7" },
  { match: /foundation|data/i, icon: TreeStructureIcon, tint: "#e6f7fa", ink: "#0b7285" },
  { match: /adoption|champion/i, icon: UsersThreeIcon, tint: "#fff3e8", ink: "#c2510c" },
  { match: /run|managed/i, icon: ArrowsClockwiseIcon, tint: "#f1f3f7", ink: "#344054" },
];

export function AgentBadge({
  name,
  size = 32,
  tone = "light",
  className,
}: {
  name: string;
  size?: number;
  /** `glass` for badges sitting on artwork. */
  tone?: "light" | "glass";
  className?: string;
}) {
  const role = ROLES.find((r) => r.match.test(name));
  const Icon = role?.icon ?? SparkleIcon;
  const glass = tone === "glass";
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center",
        glass ? "border border-white/40 bg-white/20 text-white backdrop-blur-md" : "",
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, Math.round(size * 0.32)),
        ...(glass ? {} : { background: role?.tint ?? "#eaf2ff", color: role?.ink ?? "#0b5ed7" }),
      }}
    >
      <Icon weight="duotone" style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

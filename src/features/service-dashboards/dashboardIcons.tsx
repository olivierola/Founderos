import {
  CubeIcon as Boxes,
  MegaphoneIcon as Megaphone,
  HeadphonesIcon as Headphones,
  WalletIcon as Wallet,
  CodeIcon as Code2,
  UsersIcon as Users,
  ShoppingCartIcon as ShoppingCart,
  TruckIcon as Truck,
  ScalesIcon as Scale,
  PaletteIcon as Palette,
  ChartLineIcon as LineChart,
  ShieldCheckIcon as ShieldCheck,
  RocketLaunchIcon as Rocket,
  BookOpenIcon as BookOpen,
  BuildingsIcon as Building2,
  SparkleIcon as Sparkles,
  type Icon as LucideIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * The identity a service dashboard shows everywhere it appears (switcher,
 * settings header, sidebar). `service_dashboards.icon` stores one of these
 * keys; anything unknown falls back to the generic Boxes tile.
 */
export const DASHBOARD_ICONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: "Squares", label: "Générique", icon: Boxes },
  { key: "Megaphone", label: "Marketing", icon: Megaphone },
  { key: "Headphones", label: "Support", icon: Headphones },
  { key: "Wallet", label: "Finance", icon: Wallet },
  { key: "Code", label: "Produit / Dev", icon: Code2 },
  { key: "Users", label: "RH", icon: Users },
  { key: "Cart", label: "Ventes", icon: ShoppingCart },
  { key: "Truck", label: "Logistique", icon: Truck },
  { key: "Scale", label: "Juridique", icon: Scale },
  { key: "Palette", label: "Design", icon: Palette },
  { key: "Chart", label: "Data", icon: LineChart },
  { key: "Shield", label: "Sécurité", icon: ShieldCheck },
  { key: "Rocket", label: "Growth", icon: Rocket },
  { key: "Book", label: "Connaissance", icon: BookOpen },
  { key: "Building", label: "Opérations", icon: Building2 },
  { key: "Sparkles", label: "Innovation", icon: Sparkles },
];

export const DASHBOARD_COLORS = [
  "bg-indigo-500", "bg-violet-500", "bg-fuchsia-500", "bg-rose-500",
  "bg-orange-500", "bg-amber-500", "bg-emerald-500", "bg-teal-500",
  "bg-sky-500", "bg-slate-600",
];

export function dashboardIcon(key: string | null | undefined): LucideIcon {
  return DASHBOARD_ICONS.find((i) => i.key === key)?.icon ?? Boxes;
}

/** The coloured rounded tile used for a dashboard, at any size. */
export function DashboardTile({
  icon, color, size = 24, className,
}: { icon: string | null | undefined; color: string; size?: number; className?: string }) {
  const Icon = dashboardIcon(icon);
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center rounded-lg text-white", color, className)}
      style={{ width: size, height: size, borderRadius: Math.max(6, size * 0.28) }}
    >
      <Icon style={{ width: size * 0.58, height: size * 0.58 }} />
    </span>
  );
}

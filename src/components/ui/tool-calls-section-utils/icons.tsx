// Icon shim for tool-calls-section.tsx.
//
// The upstream component is written against Hugeicons (`HugeiconsIcon` +
// named icon objects). This project uses Phosphor everywhere and does not
// need a second icon pack for two glyphs, so the same three exports are
// re-implemented over Phosphor. Keeping the upstream names means
// tool-calls-section.tsx stays byte-identical to its source and can be
// re-pasted when it is updated.
import type { Icon as LucideIcon } from "@phosphor-icons/react";
import { CaretDownIcon as ChevronDown, WrenchIcon as Wrench } from "@phosphor-icons/react";

export const ArrowDown01Icon: LucideIcon = ChevronDown;
export const ToolsIcon: LucideIcon = Wrench;

export function HugeiconsIcon({
  icon: Icon,
  size = 20,
  className,
}: {
  icon: LucideIcon;
  size?: number;
  className?: string;
}) {
  return <Icon width={size} height={size} className={className} />;
}

import { CloudIcon, CubeIcon, DesktopTowerIcon, HardDrivesIcon, type Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { MachineKind } from "./api";

export const KIND_ICON: Record<MachineKind, PhosphorIcon> = {
  docker: CubeIcon, vm: DesktopTowerIcon, cloud: CloudIcon, platform: HardDrivesIcon,
};

// Minimal lucide icon registry for CRM objects + property types (names stored as
// strings in the DB). Falls back to Boxes when a name isn't mapped.
import {
  Boxes, Users, Building2, Target, CheckSquare, StickyNote, AppWindow, Briefcase,
  Package, Truck, Receipt, FileText, Bot, Library, Handshake, Star, Mail, Phone,
  Link as LinkIcon, Hash, DollarSign, Percent, Calendar, Clock, Type, AlignLeft,
  Tags, ChevronDownCircle, GitBranch, User, LayoutDashboard, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  Boxes, Users, Building2, Target, CheckSquare, StickyNote, AppWindow, Briefcase,
  Package, Truck, Receipt, FileText, Bot, Library, Handshake, Star, Mail, Phone,
  Link: LinkIcon, Hash, DollarSign, Percent, Calendar, Clock, Type, AlignLeft,
  Tags, ChevronDownCircle, GitBranch, User, LayoutDashboard,
};

export function iconByName(name: string | null | undefined): LucideIcon {
  return (name && ICONS[name]) || Boxes;
}

// Icons offered when creating a custom object.
export const OBJECT_ICON_CHOICES = [
  "Boxes", "Users", "Building2", "Target", "CheckSquare", "StickyNote", "AppWindow",
  "Briefcase", "Package", "Truck", "Receipt", "FileText", "Bot", "Library", "Handshake",
];
export const OBJECT_COLOR_CHOICES = [
  "text-violet-500", "text-blue-500", "text-rose-500", "text-emerald-500",
  "text-amber-500", "text-cyan-500", "text-fuchsia-500", "text-orange-500", "text-teal-500",
];

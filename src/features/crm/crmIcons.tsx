// Minimal Phosphor icon registry for CRM objects + property types (names stored as
// strings in the DB). Falls back to Boxes when a name isn't mapped.
import {
  CubeIcon as Boxes,
  UsersIcon as Users,
  BuildingsIcon as Building2,
  TargetIcon as Target,
  CheckSquareIcon as CheckSquare,
  NoteIcon as StickyNote,
  AppWindowIcon as AppWindow,
  BriefcaseIcon as Briefcase,
  PackageIcon as Package,
  TruckIcon as Truck,
  ReceiptIcon as Receipt,
  FileTextIcon as FileText,
  RobotIcon as Bot,
  BooksIcon as Library,
  HandshakeIcon as Handshake,
  StarIcon as Star,
  EnvelopeSimpleIcon as Mail,
  PhoneIcon as Phone,
  LinkIcon,
  HashIcon as Hash,
  CurrencyDollarIcon as DollarSign,
  PercentIcon as Percent,
  CalendarBlankIcon as Calendar,
  ClockIcon as Clock,
  TextTIcon as Type,
  TextAlignLeftIcon as AlignLeft,
  TagIcon as Tags,
  CaretCircleDownIcon as ChevronDownCircle,
  GitBranchIcon as GitBranch,
  UserIcon as User,
  SquaresFourIcon as LayoutDashboard,
  ChatIcon as MessageSquare,
  FlaskIcon as FlaskConical,
  KanbanIcon as FolderKanban,
  NotePencilIcon as PenSquare,
  SignatureIcon as FileSignature,
  LifebuoyIcon as LifeBuoy,
  PlugIcon as Plug,
  WalletIcon as Wallet,
  UserPlusIcon as UserPlus,
  ShapesIcon as Shapes,
  type Icon as LucideIcon,
} from "@phosphor-icons/react";

const ICONS: Record<string, LucideIcon> = {
  Boxes, Users, Building2, Target, CheckSquare, StickyNote, AppWindow, Briefcase,
  Package, Truck, Receipt, FileText, Bot, Library, Handshake, Star, Mail, Phone,
  Link: LinkIcon, Hash, DollarSign, Percent, Calendar, Clock, Type, AlignLeft,
  Tags, ChevronDownCircle, GitBranch, User, LayoutDashboard, MessageSquare, FlaskConical,
  FolderKanban, PenSquare, FileSignature, LifeBuoy, Plug, Wallet, UserPlus, Shapes,
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

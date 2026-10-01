import type { PdfcnTheme } from "@/components/pdf/theme-types";
import { professionalTheme } from "@/components/pdf/theme-professional";
import { modernTheme } from "@/components/pdf/theme-modern";
import { corporateTheme } from "@/components/pdf/theme-corporate";
import { minimalTheme } from "@/components/pdf/theme-minimal";
import { executiveTheme } from "@/components/pdf/theme-executive";
import { elegantTheme } from "@/components/pdf/theme-elegant";
import { forestTheme } from "@/components/pdf/theme-forest";
import type { PdfThemeName } from "@/lib/pdf/types";

export const THEMES: Record<PdfThemeName, PdfcnTheme> = {
  professional: professionalTheme,
  modern: modernTheme,
  corporate: corporateTheme,
  minimal: minimalTheme,
  executive: executiveTheme,
  elegant: elegantTheme,
  forest: forestTheme,
};

export const THEME_LABELS: Record<PdfThemeName, string> = {
  professional: "Classique",
  modern: "Moderne",
  corporate: "Corporate",
  minimal: "Minimal",
  executive: "Exécutif",
  elegant: "Élégant",
  forest: "Forêt",
};

export const themeOf = (name?: PdfThemeName): PdfcnTheme => THEMES[name ?? "modern"] ?? modernTheme;

/**
 * A spec, ready for Takumi: the element to draw and the page options around it.
 *
 * Margins come from the theme and are handed to Takumi rather than drawn as
 * padding, so long content flows onto as many pages as it needs, each with the
 * same margins and the same footer band. Takumi measures in CSS px, pdfcn themes
 * in PDF points — pointToCssPixel bridges the two.
 */
import type { ReactElement } from "react";
import type { RenderOptions } from "takumi-pdf/no-init";
import { PageNumber, TotalPages } from "takumi-pdf/primitives";
import { PdfcnThemeProvider } from "@/components/pdf/theme-provider";
import { pointToCssPixel } from "@/lib/pdf-primitives";
import type { PdfRenderOptions, PdfSpec } from "@/lib/pdf/types";
import { themeOf } from "../themes";
import { DocumentPdf } from "./DocumentPdf";
import { InvoicePdf } from "./InvoicePdf";

const A4_POINTS = { width: 595, height: 842 };

export function buildPdf(spec: PdfSpec, options: PdfRenderOptions = {}): { element: ReactElement; render: RenderOptions } {
  const theme = themeOf(options.theme);
  const locale = options.locale || "fr-FR";
  const landscape = spec.kind === "document" && !!options.landscape;
  const m = theme.spacing.page;
  const c = theme.colors;

  const title = spec.kind === "document" ? spec.doc.title : `Facture ${spec.invoice.number}`;
  const footerText = spec.kind === "document"
    ? (spec.doc.footer ?? spec.doc.title)
    : spec.invoice.seller.name;

  const footer = (
    <div
      style={{
        display: "flex", flexDirection: "row", justifyContent: "space-between", width: "100%",
        paddingLeft: pointToCssPixel(m.marginLeft), paddingRight: pointToCssPixel(m.marginRight),
        paddingBottom: pointToCssPixel(18), color: c.mutedForeground, fontSize: pointToCssPixel(7.5),
      }}
    >
      <span>{footerText}</span>
      <span>
        <PageNumber /> / <TotalPages />
      </span>
    </div>
  );

  const element = (
    <PdfcnThemeProvider theme={theme}>
      {spec.kind === "document"
        ? <DocumentPdf doc={spec.doc} page={{ width: landscape ? A4_POINTS.height : A4_POINTS.width }} />
        : <InvoicePdf invoice={spec.invoice} locale={locale} />}
    </PdfcnThemeProvider>
  );

  return {
    element,
    render: {
      size: "a4",
      landscape,
      margin: {
        top: pointToCssPixel(m.marginTop),
        right: pointToCssPixel(m.marginRight),
        bottom: "auto",
        left: pointToCssPixel(m.marginLeft),
      },
      footer,
      backgroundColor: c.background,
      lang: locale.split("-")[0],
      metadata: { title, creator: "FounderOS · pdfcn" },
      outline: spec.kind === "document",
      // A glyph the embedded font lacks must not fail a whole export; it prints
      // as the font's placeholder box instead, which a reader can report.
      uncoveredText: "placeholder",
    },
  };
}

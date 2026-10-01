/**
 * An invoice, on pdfcn's `invoice-modern` block.
 *
 * The block as installed (components/pdf/blocks/invoice-modern) carries sample
 * data, dollar signs and English labels. This is the same layout driven by a
 * PdfInvoice: totals computed here rather than trusted from the caller, amounts
 * formatted by Intl in the invoice's currency and the reader's locale.
 *
 * Same rule as DocumentPdf: no hooks — Takumi calls these as plain functions.
 */
import { usePdfcnTheme } from "@/components/pdf/theme-provider";
import { Document, Page, View } from "@/lib/pdf-primitives";
import { Text } from "@/components/pdf/text/text";
import { KeyValue } from "@/components/pdf/key-value/key-value";
import { PageHeader } from "@/components/pdf/page-header/page-header";
import { Section } from "@/components/pdf/section/section";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/pdf/table/table";
import type { PdfInvoice } from "@/lib/pdf/types";

export interface InvoiceTotals { subtotal: number; tax: number; total: number }

export function invoiceTotals(inv: PdfInvoice): InvoiceTotals {
  const cents = (n: number) => Math.round(n * 100);
  const subtotal = inv.lines.reduce((s, l) => s + cents((l.quantity || 0) * (l.unitPrice || 0)), 0) / 100;
  const tax = inv.taxRate ? Math.round(subtotal * inv.taxRate) / 100 : 0;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "";
  // Only a bare ISO date is reformatted; anything else was written for a human.
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return value;
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}

export function InvoicePdf({ invoice, locale }: { invoice: PdfInvoice; locale: string }) {
  const theme = usePdfcnTheme();
  const c = theme.colors;
  const money = (n: number) => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: invoice.currency || "EUR" }).format(n);
    } catch {
      return `${n.toFixed(2)} ${invoice.currency || "EUR"}`;
    }
  };
  const t = invoiceTotals(invoice);
  const label = {
    color: c.mutedForeground, fontSize: 8, fontWeight: "bold", letterSpacing: 0.5, marginBottom: 3, textTransform: "uppercase",
  };
  const value = { color: c.foreground, fontSize: 9 };
  const muted = { ...value, color: c.mutedForeground };
  const seller = invoice.seller;
  const sellerLine = [seller.tagline, seller.address, seller.email].filter(Boolean).join("  ·  ");

  return (
    <Document title={`Facture ${invoice.number}`}>
      <Page style={{ backgroundColor: c.background }}>
        <PageHeader variant="branded" title={seller.name} subtitle={sellerLine || undefined} />
        <View style={{ flexDirection: "row", marginBottom: theme.spacing.sectionGap }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={label} noMargin>Facture n°</Text>
            <Text style={{ ...value, fontSize: 11, fontWeight: "bold" }} noMargin>{invoice.number}</Text>
          </View>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={label} noMargin>Date d'émission</Text>
            <Text style={value} noMargin>{formatDate(invoice.issueDate, locale)}</Text>
          </View>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={label} noMargin>Échéance</Text>
            <Text style={value} noMargin>{formatDate(invoice.dueDate, locale) || "À réception"}</Text>
          </View>
          <View style={{ backgroundColor: c.border, marginRight: 12, width: 1 }} />
          <View style={{ flex: 2 }}>
            <Text style={label} noMargin>Facturé à</Text>
            <Text style={{ ...value, fontWeight: "bold" }} noMargin>{invoice.buyer.name}</Text>
            {invoice.buyer.address && <Text style={muted} noMargin>{invoice.buyer.address}</Text>}
            {invoice.buyer.email && <Text style={muted} noMargin>{invoice.buyer.email}</Text>}
            {invoice.buyer.phone && <Text style={muted} noMargin>{invoice.buyer.phone}</Text>}
          </View>
        </View>

        <Table variant="primary-header">
          <TableHeader>
            <TableRow header>
              <TableCell>Désignation</TableCell>
              <TableCell align="center">Qté</TableCell>
              <TableCell align="right">Prix unitaire</TableCell>
              <TableCell align="right">Montant</TableCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoice.lines.map((line, i) => (
              <TableRow key={i}>
                <TableCell>{line.description}</TableCell>
                <TableCell align="center">{String(line.quantity)}</TableCell>
                <TableCell align="right">{money(line.unitPrice)}</TableCell>
                <TableCell align="right">{money(line.quantity * line.unitPrice)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Section noWrap style={{ flexDirection: "row", marginTop: 16 }}>
          <View style={{ flex: 1, paddingRight: 20 }}>
            {(invoice.paymentMethod || invoice.paymentDetails) && (
              <>
                <Text style={label} noMargin>Règlement</Text>
                {invoice.paymentMethod && <Text variant="xs" noMargin>{invoice.paymentMethod}</Text>}
                {invoice.paymentDetails && <Text variant="xs" noMargin color="mutedForeground">{invoice.paymentDetails}</Text>}
              </>
            )}
            {seller.taxId && <Text variant="xs" noMargin color="mutedForeground" style={{ marginTop: 6 }}>{seller.taxId}</Text>}
          </View>
          <View style={{ width: 220 }}>
            <KeyValue
              size="sm"
              dividerThickness={1}
              divided
              items={[
                { key: "Sous-total HT", value: money(t.subtotal) },
                ...(invoice.taxRate ? [{ key: `TVA (${invoice.taxRate} %)`, value: money(t.tax) }] : []),
                {
                  key: invoice.taxRate ? "Total TTC" : "Total",
                  keyStyle: { fontSize: 12, fontWeight: "bold" },
                  value: money(t.total),
                  valueStyle: { fontSize: 12, fontWeight: "bold" },
                },
              ]}
            />
          </View>
        </Section>

        {invoice.notes && (
          <Text variant="xs" color="mutedForeground" style={{ marginTop: theme.spacing.sectionGap }}>{invoice.notes}</Text>
        )}
      </Page>
    </Document>
  );
}

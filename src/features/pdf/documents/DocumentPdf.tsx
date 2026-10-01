/**
 * A PdfDoc drawn with pdfcn components.
 *
 * Takumi calls these as plain functions while it walks the tree — there is no
 * React renderer behind them. So: no hooks (useState/useMemo would throw), and
 * the theme is read with usePdfcnTheme(), which is a getter on the value
 * PdfcnThemeProvider set just before, not a context.
 *
 * Page margins are NOT drawn here: they are render options (see pdfRoot.tsx),
 * which is what lets content flow across pages with a repeated footer band.
 */
import { Fragment } from "react";
import { usePdfcnTheme } from "@/components/pdf/theme-provider";
import { Document, Page, View, Text as RawText } from "@/lib/pdf-primitives";
import { Svg, Path } from "@/lib/pdf-svg";
import { Text } from "@/components/pdf/text/text";
import { Heading } from "@/components/pdf/heading/heading";
import { DataTable } from "@/components/pdf/data-table/data-table";
import { KeyValue } from "@/components/pdf/key-value/key-value";
import { PdfAlert } from "@/components/pdf/alert/alert";
import { Divider } from "@/components/pdf/divider/divider";
import { PdfGraph as Graph } from "@/components/pdf/graph/graph";
import { getGraphWidth } from "@/components/pdf/graph/graph.utils";
import { PdfList } from "@/components/pdf/list/list";
import { Section } from "@/components/pdf/section/section";
import { PdfImage } from "@/components/pdf/pdf-image/pdf-image";
import { KeepTogether } from "@/components/pdf/keep-together/keep-together";
import { PageBreak } from "@/components/pdf/page-break/page-break";
import type { ListItem } from "@/components/pdf/list/list.types";
import type { PdfBlock, PdfDoc, PdfKpi, PdfListItem } from "@/lib/pdf/types";

/** Page geometry the charts need to size themselves (PDF points). */
export interface PdfPageGeometry { width: number }

const toListItems = (items: PdfListItem[]): ListItem[] =>
  items.map((it) => ({ text: it.text, children: it.children?.length ? toListItems(it.children) : undefined }));

function Cover({ doc }: { doc: PdfDoc }) {
  const theme = usePdfcnTheme();
  const c = theme.colors;
  return (
    <View style={{ marginBottom: theme.spacing.sectionGap }}>
      {doc.eyebrow && (
        <RawText style={{ color: c.primary, fontSize: 8, fontWeight: 700, letterSpacing: 1, marginBottom: 6, textTransform: "uppercase" }}>
          {doc.eyebrow}
        </RawText>
      )}
      <Heading level={1} noMargin>{doc.title}</Heading>
      {doc.subtitle && (
        <Text variant="base" color="mutedForeground" style={{ marginTop: 6 }} noMargin>{doc.subtitle}</Text>
      )}
      {doc.meta && doc.meta.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 18, marginTop: 14 }}>
          {doc.meta.map((m, i) => (
            <View key={i} style={{ flexDirection: "column" }}>
              <RawText style={{ color: c.mutedForeground, fontSize: 7, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>
                {m.label}
              </RawText>
              <RawText style={{ color: c.foreground, fontSize: 9, marginTop: 2 }}>{m.value}</RawText>
            </View>
          ))}
        </View>
      )}
      <Divider spacing="md" />
    </View>
  );
}

/** The trend mark, drawn: ▲ and ▼ are not in the embedded font, and a missing
 *  glyph prints as an empty box. */
function TrendMark({ trend, color }: { trend?: PdfKpi["trend"]; color: string }) {
  if (trend !== "up" && trend !== "down") return null;
  return (
    <Svg width={6} height={5} style={{ marginRight: 3 }}>
      <Path d={trend === "up" ? "M3 0 L6 5 L0 5 Z" : "M0 0 L6 0 L3 5 Z"} fill={color} />
    </Svg>
  );
}

function KpiRow({ items }: { items: PdfKpi[] }) {
  const theme = usePdfcnTheme();
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", gap: 10, marginBottom: theme.spacing.componentGap }} wrap={false}>
      {items.slice(0, 4).map((k, i) => {
        const tone = k.good === undefined
          ? (k.trend === "down" ? c.destructive : k.trend === "up" ? c.success : c.mutedForeground)
          : (k.good ? c.success : c.destructive);
        return (
          <View
            key={i}
            style={{
              flex: 1, borderColor: c.border, borderRadius: 6, borderWidth: 1,
              backgroundColor: c.muted, paddingHorizontal: 12, paddingVertical: 10,
            }}
          >
            <RawText style={{ color: c.mutedForeground, fontSize: 7.5, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase" }}>
              {k.label}
            </RawText>
            <RawText style={{ color: c.foreground, fontSize: 18, fontWeight: 700, marginTop: 4 }}>{k.value}</RawText>
            {k.delta && (
              <View style={{ alignItems: "center", flexDirection: "row", marginTop: 3 }}>
                <TrendMark trend={k.trend} color={tone} />
                <RawText style={{ color: tone, fontSize: 8, fontWeight: 600 }}>{k.delta}</RawText>
              </View>
            )}
            {k.note && <RawText style={{ color: c.mutedForeground, fontSize: 7.5, marginTop: 2 }}>{k.note}</RawText>}
          </View>
        );
      })}
    </View>
  );
}

function ChartBlock({ block, page }: { block: Extract<PdfBlock, { type: "chart" }>; page: PdfPageGeometry }) {
  const theme = usePdfcnTheme();
  const width = getGraphWidth(theme, { pageWidth: page.width });
  const round = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100);
  const pie = block.variant === "pie" || block.variant === "donut";
  // pdfcn takes one flat series for pies and named series for everything else.
  const data = pie
    ? block.categories.map((label, i) => ({ label, value: round(block.series[0]?.data[i] ?? 0) }))
    : block.series.map((s) => ({
      name: s.name,
      data: block.categories.map((label, i) => ({ label, value: round(s.data[i] ?? 0) })),
    }));
  const total = pie ? (block.series[0]?.data ?? []).reduce((a, b) => a + b, 0) : 0;
  return (
    <KeepTogether>
      <View style={{ marginBottom: theme.spacing.componentGap }}>
        <Graph
          variant={block.variant}
          data={data}
          title={block.title}
          subtitle={block.subtitle}
          width={width}
          height={block.variant === "horizontal-bar" ? Math.max(140, 26 * block.categories.length + 40) : 230}
          legend={block.series.length > 1 || pie ? "bottom" : "none"}
          showValues={block.categories.length <= 12 && block.series.length === 1}
          centerLabel={block.variant === "donut" ? `${round(total)}${block.unit ?? ""}` : undefined}
          smooth={block.variant === "line" || block.variant === "area"}
          showDots={block.categories.length <= 16}
        />
        {block.caption && <Text variant="xs" color="mutedForeground" italic noMargin style={{ marginTop: 4 }}>{block.caption}</Text>}
      </View>
    </KeepTogether>
  );
}

function Block({ block, page }: { block: PdfBlock; page: PdfPageGeometry }) {
  const theme = usePdfcnTheme();
  const c = theme.colors;
  switch (block.type) {
    case "heading": {
      const level = block.level ?? 2;
      return <Heading level={level === 1 ? 2 : level === 2 ? 3 : 4} keepWithNext>{block.text}</Heading>;
    }
    case "paragraph":
      return block.lead
        ? <Text variant="lg" color="mutedForeground">{block.text}</Text>
        : <Text>{block.text}</Text>;
    case "list":
      return <PdfList items={toListItems(block.items)} variant={block.ordered ? "numbered" : "bullet"} style={{ marginBottom: theme.spacing.componentGap }} />;
    case "checklist":
      return (
        <PdfList
          items={block.items.map((i) => ({ text: i.text, checked: !!i.checked }))}
          variant="checklist"
          style={{ marginBottom: theme.spacing.componentGap }}
        />
      );
    case "table": {
      const columns = block.columns.map((header, i) => ({
        key: `c${i}`,
        header,
        // A column of figures reads right-aligned, like every financial table.
        align: block.rows.length > 0 && block.rows.every((r) => /^[\s\d.,%€$£+\-−–()kKmM]*$/.test(r[i] ?? "") && /\d/.test(r[i] ?? ""))
          ? "right" as const
          : "left" as const,
      }));
      const data = block.rows.map((r) => Object.fromEntries(columns.map((col, i) => [col.key, r[i] ?? ""])));
      return (
        <View style={{ marginBottom: theme.spacing.componentGap }}>
          <DataTable columns={columns} data={data} variant="primary-header" size={block.columns.length > 5 ? "compact" : "default"} stripe />
          {block.caption && <Text variant="xs" color="mutedForeground" italic noMargin style={{ marginTop: 4 }}>{block.caption}</Text>}
        </View>
      );
    }
    case "kpis":
      return <KpiRow items={block.items} />;
    case "chart":
      return <ChartBlock block={block} page={page} />;
    case "callout":
      return (
        <PdfAlert variant={block.tone ?? "info"} title={block.title} style={{ marginBottom: theme.spacing.componentGap }}>
          {block.text}
        </PdfAlert>
      );
    case "quote":
      return (
        <Section variant="callout" accentColor={c.primary} padding="md" noWrap>
          <Text variant="base" italic noMargin>« {block.text} »</Text>
          {block.caption && <Text variant="xs" color="mutedForeground" noMargin style={{ marginTop: 4 }}>— {block.caption}</Text>}
        </Section>
      );
    case "code":
      return (
        <View style={{ backgroundColor: c.muted, borderRadius: 4, marginBottom: theme.spacing.componentGap, padding: 10 }}>
          <RawText style={{ color: c.foreground, fontFamily: "monospace", fontSize: 8, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
            {block.code}
          </RawText>
        </View>
      );
    case "image":
      return (
        <View style={{ marginBottom: theme.spacing.componentGap }}>
          <PdfImage src={block.src} fit="contain" width="100%" caption={block.caption} />
        </View>
      );
    case "keyValue":
      return <KeyValue items={block.items} divided size="sm" style={{ marginBottom: theme.spacing.componentGap }} />;
    case "sources":
      return (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginBottom: theme.spacing.paragraphGap }}>
          <RawText style={{ color: c.mutedForeground, fontSize: 7.5 }}>Sources :</RawText>
          {block.items.map((s, i) => (
            <RawText
              key={i}
              href={s.url}
              style={{ color: s.url ? c.primary : c.mutedForeground, fontSize: 7.5, textDecoration: s.url ? "underline" : "none" }}
            >
              {s.name}{i < block.items.length - 1 ? "," : ""}
            </RawText>
          ))}
        </View>
      );
    case "divider":
      return <Divider spacing="md" />;
    case "pageBreak":
      return <PageBreak />;
    default:
      return null;
  }
}

export function DocumentPdf({ doc, page }: { doc: PdfDoc; page: PdfPageGeometry }) {
  const theme = usePdfcnTheme();
  return (
    <Document title={doc.title}>
      <Page style={{ backgroundColor: theme.colors.background }}>
        <Cover doc={doc} />
        {doc.blocks.map((b, i) => (
          <Fragment key={i}><Block block={b} page={page} /></Fragment>
        ))}
      </Page>
    </Document>
  );
}

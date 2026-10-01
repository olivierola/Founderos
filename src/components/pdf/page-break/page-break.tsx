import { View } from "@/lib/pdf-primitives";
import type { PDFComponentProps } from "@/components/pdf/pdf-components";

export interface PageBreakProps extends Omit<PDFComponentProps, "children"> {
  children?: never;
}

export const PageBreak = ({ style }: PageBreakProps) => (
  <View style={[{ breakBefore: "page" }, style].filter(Boolean) as never} />
);

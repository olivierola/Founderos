import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

// Capture a dashboard DOM node and save it as a multi-page A4 PDF.
export async function exportDashboardPdf(node: HTMLElement, name: string) {
  const canvas = await html2canvas(node, {
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#18181b",
    scale: 2,
    useCORS: true,
    logging: false,
  });

  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const headerH = 12;

  const imgW = pageW - margin * 2;
  const imgH = (canvas.height * imgW) / canvas.width;

  pdf.setFontSize(14);
  pdf.text(name || "Dashboard", margin, headerH - 3);
  pdf.setFontSize(9);
  pdf.setTextColor(120);
  pdf.text(new Date().toLocaleString(), pageW - margin, headerH - 3, { align: "right" });
  pdf.setTextColor(0);

  const availH = pageH - headerH - margin;
  if (imgH <= availH) {
    pdf.addImage(canvas, "PNG", margin, headerH, imgW, imgH);
  } else {
    // Slice the tall canvas into page-height chunks.
    const pxPerMm = canvas.width / imgW;
    const sliceHpx = availH * pxPerMm;
    let y = 0;
    let first = true;
    while (y < canvas.height) {
      const hpx = Math.min(sliceHpx, canvas.height - y);
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = hpx;
      const ctx = slice.getContext("2d");
      if (ctx) ctx.drawImage(canvas, 0, y, canvas.width, hpx, 0, 0, canvas.width, hpx);
      if (!first) {
        pdf.addPage();
        pdf.setFontSize(9);
        pdf.setTextColor(120);
        pdf.text(name || "Dashboard", margin, headerH - 4);
        pdf.setTextColor(0);
      }
      pdf.addImage(slice, "PNG", margin, first ? headerH : margin, imgW, hpx / pxPerMm);
      y += hpx;
      first = false;
    }
  }

  const safe = (name || "dashboard").replace(/[^\w-]+/g, "_").toLowerCase();
  pdf.save(`${safe}.pdf`);
}

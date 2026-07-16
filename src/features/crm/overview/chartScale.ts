// Shared continuous y-scale for the line / area / bar trend views. The waffle
// uses its own square-quantised scale; these forms plot on a continuous axis but
// keep the SAME integer discipline: record counts can't be fractional, so the
// ticks stay whole numbers (never "0.8 / 1.6 / 2.4 enregistrements").

export interface Scale {
  max: number;
  ticks: number[];
  integral: boolean;
}

/** A "nice" axis (round steps 1/2/2.5/5 × 10ⁿ) with ~`tickCount` ticks that
 *  covers [0, maxV]. Integral data snaps the step to a whole number. */
export function niceScale(maxV: number, integral: boolean, tickCount = 4): Scale {
  const v = Math.max(1, maxV);
  const rawStep = v / tickCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integral) step = Math.max(1, Math.ceil(step));
  const max = step * tickCount;
  const ticks: number[] = [];
  for (let i = 1; i <= tickCount; i++) ticks.push(step * i);
  return { max, ticks, integral };
}

export function fmtAxis(v: number, integral: boolean): string {
  if (integral || Number.isInteger(v)) return String(Math.round(v));
  return v < 1 ? v.toFixed(2) : v.toFixed(1);
}

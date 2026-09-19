// Fetch the gold 3dicons renders and key out their white matte.
//
// The CDN only serves opaque WebP (VP8, no alpha channel): every icon arrives
// composited over white, with a soft grey drop shadow. On a dark card that
// reads as a white tile. So: flood-fill the *neutral bright* region connected
// to the border — background plus its shadow — and turn it into alpha, then
// unpremultiply the colour back off white. Interior specular highlights are
// enclosed by gold, never reachable from the border, so they survive.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const CDN = "https://bvconuycpdvgzbvbkijl.supabase.co/storage/v1/object/public/sizes";
const OUT = path.resolve("public/icons3d");
const SRC_PX = 500;   // largest size the CDN publishes
const OUT_PX = 256;   // ~3.5x the 72px card render

// The slug map is the single source of truth in icons3d.tsx; parse it rather
// than duplicating 39 opaque ids here.
const SRC = fs.readFileSync("src/features/internal-agents/icons3d.tsx", "utf8");
const SLUGS = Object.fromEntries(
  [...SRC.matchAll(/^  ([a-zA-Z]+): "([a-z0-9-]+)",$/gm)].map((m) => [m[1], m[2]]),
);

// A pixel belongs to the matte if it is bright and near-neutral: white paper
// and its grey shadow qualify, saturated gold never does.
const isMatte = (r, g, b) => {
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  return min > 150 && max - min < 28;
};

function keyOutWhite(data, w, h) {
  const n = w * h;
  const inRegion = new Uint8Array(n);
  const stack = [];

  const push = (i) => {
    if (inRegion[i]) return;
    const o = i * 4;
    if (!isMatte(data[o], data[o + 1], data[o + 2])) return;
    inRegion[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  // Grow one ring outward to catch the anti-aliased fringe where gold meets
  // paper: those pixels are too saturated for isMatte but still mostly white.
  const fringe = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inRegion[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || inRegion[j] || fringe[j]) continue;
      const o = j * 4;
      if (Math.min(data[o], data[o + 1], data[o + 2]) > 205) fringe[j] = 1;
    }
  }

  let cleared = 0;
  for (let i = 0; i < n; i++) {
    if (!inRegion[i] && !fringe[i]) continue;
    const o = i * 4;
    // Whiteness → transparency. Pure white vanishes; the shadow keeps the
    // little alpha its darkness earns, so the icon still sits on something.
    const a = 255 - Math.min(data[o], data[o + 1], data[o + 2]);
    if (a === 0) cleared++;
    if (a === 0) { data[o + 3] = 0; continue; }
    // Undo the composite over white so the recovered colour is not milky.
    for (let c = 0; c < 3; c++) {
      data[o + c] = Math.max(0, Math.min(255, Math.round((data[o + c] - (255 - a)) * 255 / a)));
    }
    data[o + 3] = a;
  }
  return cleared / n;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [key, slug] of Object.entries(SLUGS)) {
    const url = `${CDN}/${slug}/dynamic/${SRC_PX}/premium.webp`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`FAIL ${key} ${res.status}`); process.exit(1); }
    const buf = Buffer.from(await res.arrayBuffer());

    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ratio = keyOutWhite(data, info.width, info.height);

    const dest = path.join(OUT, `${key}.webp`);
    await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .resize(OUT_PX, OUT_PX, { fit: "inside", kernel: "lanczos3" })
      .webp({ quality: 88, alphaQuality: 100, effort: 6 })
      .toFile(dest);

    const kb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(`${key.padEnd(12)} ${(ratio * 100).toFixed(1).padStart(5)}% cleared   ${kb} KB`);
  }
})();

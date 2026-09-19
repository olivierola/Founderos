// Gold 3D icons for the agent templates — sourced from the free, open-source
// 3dicons library (https://3dicons.co, free for commercial use).
//
// Why images and not a glyph font: these are rendered 3D objects shot in a 3/4
// ("dynamic") perspective, so a template card reads as a physical object on a
// shelf rather than one more flat pictogram. The "premium" style is the gold
// render — the one this product uses everywhere for templates.
//
// Why the files are vendored instead of hot-linked: the library's CDN only
// publishes opaque WebP (VP8, no alpha channel). Every icon arrives composited
// over a white card with a soft grey shadow, which on our dark surfaces shows
// up as a white tile. scripts/vendor-3dicons.mjs downloads each render, keys
// the white matte out into real transparency and writes public/icons3d/. That
// also drops a third-party CDN from the render path.
//
// The `{id}-{name}` slugs below are the CDN's own opaque identifiers — they
// cannot be derived from the icon name, and the vendoring script reads them
// straight out of this map, so this is the one place they are written down.
// Run `node scripts/vendor-3dicons.mjs` after adding an entry.

export const ICON_3D_SLUGS = {
  at: "a0f7a1-at",
  bag: "f71a3e-bag",
  battery: "8510e2-battery",
  bell: "ef4a90-bell",
  bucket: "ecf873-bucket",
  bulb: "ddbd61-bulb",
  calculator: "dd7474-calculator",
  calendar: "781f28-calendar",
  callOut: "87c2c5-call-out",
  camera: "5656e5-camera",
  chart: "4a4275-chart",
  chatBubble: "eec43d-chat-bubble",
  chess: "616eaf-chess",
  computer: "5f20be-computer",
  copy: "d3d0c8-copy",
  crown: "634b4b-crown",
  cube: "4f52f8-cube",
  dollar: "421bcd-dollar",
  explorer: "a0330a-explorer",
  fileText: "65d841-file-text",
  fire: "6bfe8c-fire",
  flag: "e9828b-flag",
  flash: "637858-flash",
  glass: "f1cab8-glass",
  headphone: "b81ead-headphone",
  heart: "1acc3d-heart",
  lab: "56180e-lab",
  link: "2d9fa2-link",
  lock: "457612-lock",
  locker: "e67951-locker",
  magic: "5cc402-magic-trick",
  medal: "39121b-medal",
  megaphone: "313578-megaphone",
  mobile: "1fded0-mobile",
  notebook: "628100-notebook",
  palette: "82db59-color-palette",
  pencil: "66b0f8-pencil",
  potion: "af03f3-potion",
  puzzle: "a68576-puzzle",
  rocket: "744cc0-rocket",
  setting: "7e47be-setting",
  shield: "b91186-shield",
  sphere: "8034f3-sphere",
  target: "49b6f4-target",
  thumbUp: "4e7918-thumb-up",
  tick: "1b714e-tick",
  toggle: "6d3198-toggle",
  tools: "ff5be0-tools",
  travel: "fa6099-travel",
  trophy: "49654f-trophy",
  wallet: "7d956f-wallet",
  wifi: "16f789-wifi",
  zoom: "b4a0af-zoom",
} as const;

export type Icon3dKey = keyof typeof ICON_3D_SLUGS;

/** Vendored asset path. One 256px master per icon — ~3.5x the largest place
 *  it is rendered, so there is nothing to pick per call site. */
export function icon3dUrl(key: Icon3dKey): string {
  return `/icons3d/${key}.webp`;
}

/**
 * A template's gold icon. No plate or tint behind it: these renders carry
 * their own light and shadow, and a coloured square flattens them back into
 * the pictogram they are trying not to be.
 */
export function Icon3D({ icon, px = 64, className }: {
  icon: Icon3dKey;
  px?: number;
  className?: string;
}) {
  return (
    <img
      src={icon3dUrl(icon)}
      alt=""
      width={px}
      height={px}
      loading="lazy"
      draggable={false}
      className={className}
      style={{ width: px, height: px, objectFit: "contain" }}
    />
  );
}

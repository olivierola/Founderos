import {
  siConfluence,
  siGithub,
  siGitlab,
  siGooglebigquery,
  siGoogledrive,
  siHubspot,
  siJira,
  siLinear,
  siNotion,
  siOkta,
  siPostgresql,
  siSage,
  siSap,
  siSnowflake,
} from "simple-icons";

/* ══ The connector catalogue ═════════════════════════════════════════════════
   One list, with each tool's real mark and its real brand colour. This is the
   only place on the site where colour is not ours: the whole claim of the
   section it feeds is "it runs on what you already have", and a wall of names
   set in the same grey is exactly the picture of a platform that does not.
   Seeing your own logo in your own colour is the argument.

   Marks come from simple-icons where the brand is in it. Several are not —
   Slack, Salesforce and every Microsoft product were pulled from the set over
   trademark, and vendoring their artwork ourselves is precisely the permission
   we do not have. Those fall back to a monogram in the brand's colour, which is
   why `path` is optional: the tile is designed to work either way rather than
   having a hole where a logo should be. */

export type Tool = {
  name: string;
  /** The brand's own hex, without the #. */
  hex: string;
  /** simple-icons path data, when the brand ships one. */
  path?: string;
  /** Overrides the initial for the monogram fallback. */
  mono?: string;
};

export type ToolGroup = { title: string; items: Tool[] };

const si = (icon: { hex: string; path: string }, name: string): Tool => ({
  name,
  hex: icon.hex,
  path: icon.path,
});

/* Grouped rather than alphabetised: a reader scans for their own category
   first, and the group headers are what make a wall of names navigable. */
export const TOOL_GROUPS: ToolGroup[] = [
  {
    title: "Work & identity",
    items: [
      { name: "Microsoft 365", hex: "D83B01", mono: "M" },
      { name: "Google Workspace", hex: "4285F4", mono: "G" },
      { name: "Entra ID", hex: "0078D4", mono: "E" },
      si(siOkta, "Okta"),
      { name: "Slack", hex: "611F69", mono: "S" },
      { name: "Teams", hex: "6264A7", mono: "T" },
    ],
  },
  {
    title: "Business systems",
    items: [
      { name: "Salesforce", hex: "00A1E0", mono: "S" },
      si(siHubspot, "HubSpot"),
      si(siSap, "SAP"),
      si(siSage, "Sage"),
      { name: "NetSuite", hex: "125C9E", mono: "N" },
      { name: "Pennylane", hex: "1B39D9", mono: "P" },
    ],
  },
  {
    title: "Delivery & code",
    items: [
      si(siJira, "Jira"),
      si(siGithub, "GitHub"),
      si(siGitlab, "GitLab"),
      si(siLinear, "Linear"),
      si(siNotion, "Notion"),
      si(siConfluence, "Confluence"),
    ],
  },
  {
    title: "Data & storage",
    items: [
      si(siSnowflake, "Snowflake"),
      si(siGooglebigquery, "BigQuery"),
      si(siPostgresql, "PostgreSQL"),
      { name: "SharePoint", hex: "038387", mono: "S" },
      { name: "S3", hex: "569A31", mono: "S3" },
      si(siGoogledrive, "Drive"),
    ],
  },
];

/* The grouping is how the list is AUTHORED — it is what stops a tool being
   added twice or landing in the wrong half of the catalogue. Nothing renders
   the categories any more: the section they feed shows one flat grid, because
   with the marks visible you scan for a shape rather than read a taxonomy. */

/** Flat, and what the page actually consumes. */
export const ALL_TOOLS: Tool[] = TOOL_GROUPS.flatMap((g) => g.items);

/* ── The mark ───────────────────────────────────────────────────────────────
   Drawn in `currentColor`, never in its own hex. The colour decision belongs to
   the cell around it, which knows what ground it is on and whether it is being
   hovered; a mark that hard-codes its brand colour cannot be asked to go quiet.
   The brand hue reaches it through the `--brand` custom property instead. */
export function ToolMark({ tool, size = 18 }: { tool: Tool; size?: number }) {
  if (!tool.path) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center font-semibold leading-none"
        style={{ width: size, height: size, fontSize: size * (tool.mono?.length === 2 ? 0.5 : 0.68) }}
      >
        {tool.mono ?? tool.name[0]}
      </span>
    );
  }

  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
      <path d={tool.path} />
    </svg>
  );
}

/* ── The card ───────────────────────────────────────────────────────────────
   One tool, on its own surface: a white plate with a hairline, the mark at
   display size, the name under it. Grey at rest, the brand's colour under the
   pointer — every logo coloured at once is a sticker sheet, none of them
   coloured is the grey wall this section started as, and one at a time is how
   the thing is actually used. You are hunting for yours, and yours answers. */
function ToolCard({ tool }: { tool: Tool }) {
  return (
    <div
      className="group/card flex items-center gap-4 rounded-[14px] border border-black/[0.07] bg-white px-5 py-4 text-[#9A9A9A] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[color,border-color,box-shadow] duration-200 hover:border-[var(--brand)]/35 hover:text-[var(--brand)] hover:shadow-[0_10px_24px_-14px_rgba(0,0,0,0.30)]"
      style={{ ["--brand" as string]: `#${tool.hex}` }}
    >
      <ToolMark tool={tool} size={28} />
      <span className="truncate text-[15.5px] tracking-[-0.01em] text-[#2A2A2A] transition-colors duration-200 group-hover/card:text-[#0E0E0E]">
        {tool.name}
      </span>
    </div>
  );
}

/* ── The columns ────────────────────────────────────────────────────────────
   Cards stacked into columns that drift vertically, adjacent columns travelling
   against each other. Three things make it work rather than fidget:

   · opposed directions, so the block reads as a field rather than as one tall
     slab sliding past;
   · different speeds per column, so the three never sync into a visible pattern;
   · it stops under the pointer. A name you cannot catch is worse than a name
     that never moved.

   Each column is duplicated once and the track travels -50%: the loop is only
   seamless if the second half repeats the first exactly.

   The rail is `overflow-hidden` with a fixed height and the track is free to be
   as tall as it likes. The horizontal equivalent of this is what broke an
   earlier cut of this section — a `w-max` track inside a grid column sized the
   column to the whole track — so the rail here is also `w-full min-w-0`, and
   the growth axis is one the page does not scroll. */
const COLUMN_SPEEDS = ["34s", "44s", "39s"];

/** Fades top and bottom, so cards dissolve at the rails instead of being cut. */
const RAIL_FADE = "linear-gradient(180deg, transparent, #000 9%, #000 91%, transparent)";

export function ToolMarquee({ columns = 3 }: { columns?: number }) {
  // Dealt round-robin rather than sliced: consecutive entries in the catalogue
  // are from the same category, so slicing would put all six identity tools in
  // one column and all six databases in another — the grouping we just removed,
  // reintroduced by the layout.
  const cols = Array.from({ length: columns }, (_, c) =>
    ALL_TOOLS.filter((_, i) => i % columns === c),
  );

  return (
    <div className="grid w-full min-w-0 grid-cols-2 gap-4 sm:grid-cols-3">
      {cols.map((slice, c) => {
        const track = [...slice, ...slice];
        return (
          <div
            key={c}
            /* The third column is one card's worth of information more than a
               phone needs beside the text, so it only appears from `sm`. */
            className={`relative h-[440px] overflow-hidden ${c === 2 ? "hidden sm:block" : ""}`}
            style={{ WebkitMaskImage: RAIL_FADE, maskImage: RAIL_FADE }}
          >
            <div
              className={`flex flex-col gap-4 hover:[animation-play-state:paused] ${
                c % 2 ? "amp-ticker-reverse" : "amp-ticker"
              }`}
              style={{ animationDuration: COLUMN_SPEEDS[c % COLUMN_SPEEDS.length] }}
            >
              {track.map((t, i) => (
                <ToolCard key={`${t.name}-${i}`} tool={t} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

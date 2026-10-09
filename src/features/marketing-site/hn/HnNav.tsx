import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { CaretDownIcon as CaretDown, ListIcon as Menu, XIcon as X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { SOLUTIONS } from "../solutions";
import { Brand, Btn } from "./HnKit";
import { PRODUCTS, RESOURCES, SOLUTION_ART } from "./site";

/* ── The bar ────────────────────────────────────────────────────────────────
   White, edge to edge, a hairline under it, sticky. Logo, four menus, and the
   blue button on the far right — the reference's layout. We add a plain
   "Sign in" beside the button: a SaaS needs one, the reference does not. */

type MenuKey = "solutions" | "product" | "resources";

const ITEMS: { label: string; to?: string; menu?: MenuKey }[] = [
  { label: "Solutions", menu: "solutions" },
  { label: "Product", menu: "product" },
  { label: "Use cases", to: "/use-cases" },
  { label: "Pricing", to: "/pricing" },
  { label: "Resources", menu: "resources" },
];

export const HN_NAV_H = 72;

function MenuPanel({ menu, close }: { menu: MenuKey; close: () => void }) {
  if (menu === "solutions") {
    return (
      <div className="grid w-[640px] grid-cols-2 gap-1 p-2">
        {SOLUTIONS.map((s) => (
          <Link
            key={s.slug}
            to={`/solutions/${s.slug}`}
            onClick={close}
            className="flex gap-3 rounded-[12px] p-3 transition-colors hover:bg-[#f7f8fb]"
          >
            <span className={`hn-art hn-art-${SOLUTION_ART[s.slug] ?? "blue"} mt-0.5 h-9 w-9 shrink-0 rounded-[14px]`} />
            <span className="min-w-0">
              <span className="block text-[15px] font-medium tracking-[-0.01em] text-[#0f1728]">{s.menu.label}</span>
              <span className="mt-0.5 block text-[13.5px] leading-snug text-[#4b5567]">{s.menu.blurb}</span>
            </span>
          </Link>
        ))}
        <Link
          to="/solutions"
          onClick={close}
          className="col-span-2 mt-1 rounded-[12px] border-t border-[#e6e9ef] px-3 pb-1 pt-3 text-[14px] font-medium text-[#006edd] hover:text-[#0057c2]"
        >
          All solutions →
        </Link>
      </div>
    );
  }
  if (menu === "product") {
    return (
      <div className="grid w-[560px] grid-cols-2 gap-2 p-2">
        {PRODUCTS.map((p) => (
          <Link key={p.slug} to={`/product/${p.slug}`} onClick={close} className="rounded-[12px] p-2 transition-colors hover:bg-[#f7f8fb]">
            <span className={`hn-art hn-art-${p.art} block h-24 rounded-[14px]`} />
            <span className="mt-3 block px-1 text-[15px] font-medium tracking-[-0.01em] text-[#0f1728]">{p.name}</span>
            <span className="mt-1 block px-1 pb-1 text-[13.5px] leading-snug text-[#4b5567]">{p.blurb}</span>
          </Link>
        ))}
      </div>
    );
  }
  return (
    <div className="grid w-[460px] grid-cols-2 gap-1 p-2">
      {RESOURCES.map((r) => (
        <Link key={r.to} to={r.to} onClick={close} className="rounded-[12px] p-3 transition-colors hover:bg-[#f7f8fb]">
          <span className="block text-[15px] font-medium tracking-[-0.01em] text-[#0f1728]">{r.label}</span>
          <span className="mt-0.5 block text-[13.5px] leading-snug text-[#4b5567]">{r.blurb}</span>
        </Link>
      ))}
    </div>
  );
}

export function HnNav() {
  const [menu, setMenu] = useState<MenuKey | null>(null);
  const [mobile, setMobile] = useState(false);
  const { pathname } = useLocation();
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setMenu(null);
    setMobile(false);
  }, [pathname]);

  const openMenu = (m: MenuKey) => {
    if (timer.current) window.clearTimeout(timer.current);
    setMenu(m);
  };
  const closeSoon = () => {
    timer.current = window.setTimeout(() => setMenu(null), 120);
  };

  const current = (to?: string, m?: MenuKey) => {
    if (to) return pathname === to || pathname.startsWith(to + "/");
    if (m === "solutions") return pathname.startsWith("/solutions");
    if (m === "product") return pathname.startsWith("/product");
    if (m === "resources") return RESOURCES.some((r) => pathname.startsWith(r.to));
    return false;
  };

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-[#e6e9ef] bg-white/95 backdrop-blur-md" style={{ height: HN_NAV_H }}>
        <div className="flex h-full w-full items-center gap-14 px-5 sm:px-8 lg:px-12">
          <Link to="/" aria-label="Anduran, home" className="shrink-0">
            <Brand />
          </Link>

          <nav className="hidden items-center gap-12 lg:flex">
            {ITEMS.map((it) =>
              it.menu ? (
                <div
                  key={it.label}
                  className="relative"
                  onMouseEnter={() => openMenu(it.menu!)}
                  onMouseLeave={closeSoon}
                >
                  <button
                    type="button"
                    aria-expanded={menu === it.menu}
                    onClick={() => setMenu(menu === it.menu ? null : it.menu!)}
                    className={cn(
                      "flex items-center gap-1 py-2 text-[16px] font-medium tracking-[-0.02em] transition-colors",
                      current(undefined, it.menu) ? "text-[#006edd]" : "text-[#0f1728] hover:text-[#006edd]",
                    )}
                  >
                    {it.label}
                    <CaretDown className={cn("h-3.5 w-3.5 transition-transform", menu === it.menu && "rotate-180")} />
                  </button>
                  {menu === it.menu && (
                    <div className="absolute left-0 top-full pt-3">
                      <div className="rounded-[24px] border border-[#e6e9ef] bg-white shadow-[0_24px_60px_-28px_rgba(18,18,18,0.35)]">
                        <MenuPanel menu={it.menu} close={() => setMenu(null)} />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  key={it.label}
                  to={it.to!}
                  className={cn(
                    "py-2 text-[16px] font-medium tracking-[-0.02em] transition-colors",
                    current(it.to) ? "text-[#006edd]" : "text-[#0f1728] hover:text-[#006edd]",
                  )}
                >
                  {it.label}
                </Link>
              ),
            )}
          </nav>

          <div className="ml-auto flex items-center gap-5">
            <Link to="/login" className="hidden text-[16px] font-medium tracking-[-0.02em] text-[#0f1728] hover:text-[#006edd] sm:block">
              Sign in
            </Link>
            <Btn to="/contact" variant="liquid" className="hidden sm:inline-flex">
              Book a demo
            </Btn>
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setMobile(true)}
              className="grid h-11 w-11 place-items-center rounded-full border border-[#e6e9ef] text-[#0f1728] lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      {mobile && (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-white px-5 pb-10 pt-5 text-[#0f1728] lg:hidden">
          <div className="flex items-center justify-between">
            <Brand />
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMobile(false)}
              className="grid h-11 w-11 place-items-center rounded-full border border-[#e6e9ef]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-8 space-y-8">
            <MobileGroup title="Solutions" links={SOLUTIONS.map((s) => ({ label: s.menu.label, to: `/solutions/${s.slug}` }))} />
            <MobileGroup title="Product" links={PRODUCTS.map((p) => ({ label: p.name, to: `/product/${p.slug}` }))} />
            <MobileGroup
              title="Company"
              links={[{ label: "Use cases", to: "/use-cases" }, { label: "Pricing", to: "/pricing" }, ...RESOURCES.map((r) => ({ label: r.label, to: r.to }))]}
            />
          </div>
          <div className="mt-10 flex flex-col gap-3">
            <Btn to="/contact" variant="liquid" className="justify-center">Book a demo</Btn>
            <Btn to="/login" variant="secondary" className="justify-center">Sign in</Btn>
          </div>
        </div>
      )}
    </>
  );
}

function MobileGroup({ title, links }: { title: string; links: { label: string; to: string }[] }) {
  return (
    <div>
      <div className="text-[14px] text-[#4b5567]">{title}</div>
      <div className="mt-2 flex flex-col">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="border-b border-[#e6e9ef] py-3 text-[18px] tracking-[-0.015em]">
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

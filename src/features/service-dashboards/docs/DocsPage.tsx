import { useMemo, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, BookOpenIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { DOC_SECTIONS, findArticle, neighbours, searchArticles } from "./content";
import type { DocArticle } from "./types";

/**
 * La documentation du tableau de service.
 *
 * Deux écrans en un : un SOMMAIRE quand aucun article n'est choisi, l'article
 * lui-même sinon. Ouvrir directement sur le premier article aurait privé le
 * lecteur de la seule vue qui montre l'étendue de ce qui est documenté — et
 * c'est justement ce qu'on cherche en ouvrant un manuel qu'on ne connaît pas.
 */
export function DocsPage({
  article: slug, onSelect,
}: { article?: string | null; onSelect: (slug: string | null) => void }) {
  const article = findArticle(slug);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {article ? <Article article={article} onSelect={onSelect} /> : <Contents onSelect={onSelect} />}
    </div>
  );
}

// ── Sommaire ────────────────────────────────────────────────────────────────

function Contents({ onSelect }: { onSelect: (slug: string) => void }) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchArticles(query), [query]);
  const searching = query.trim().length > 0;

  return (
    <>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-tertiary">
          <BookOpenIcon className="h-4 w-4" />
          <span className="text-12 font-medium uppercase tracking-wide">Documentation</span>
        </div>
        <h1 className="mt-1.5 text-2xl font-medium">Le tableau de service</h1>
        <p className="mt-1.5 text-14 leading-relaxed text-muted-foreground">
          Chaque écran du tableau, ce qu&apos;il sert à faire et comment s&apos;en
          servir. Pour suivre ce manuel avec de vraies données, commencez par{" "}
          <button
            type="button"
            onClick={() => onSelect("demo")}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            créer le projet de démonstration
          </button>.
        </p>
      </header>

      {/* La recherche porte sur les titres et les mots-clés : on cherche un
          SUJET, pas une occurrence. */}
      <div className="relative mb-6">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Chercher un écran, une notion…"
          className="h-10 w-full rounded-lg border-[0.5px] border-border bg-muted/30 pl-9 pr-3 text-14 outline-none transition-colors placeholder:text-placeholder focus:border-primary/60"
        />
      </div>

      {searching ? (
        hits.length ? (
          <ul className="space-y-1.5">
            {hits.map((a) => <ArticleRow key={a.slug} article={a} onSelect={onSelect} />)}
          </ul>
        ) : (
          <p className="py-10 text-center text-14 text-placeholder">
            Aucun article ne correspond à « {query.trim()} ».
          </p>
        )
      ) : (
        <div className="space-y-8">
          {DOC_SECTIONS.map((s) => (
            <section key={s.key}>
              <div className="mb-2.5 flex items-center gap-2">
                <s.icon className="h-4 w-4 text-tertiary" />
                <h2 className="text-14 font-medium">{s.label}</h2>
                <span className="text-12 tabular-nums text-placeholder">{s.articles.length}</span>
              </div>
              <ul className="space-y-1.5">
                {s.articles.map((a) => <ArticleRow key={a.slug} article={a} onSelect={onSelect} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function ArticleRow({
  article, onSelect,
}: { article: DocArticle; onSelect: (slug: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(article.slug)}
        className={cn(
          "group flex w-full items-start gap-3 rounded-lg border border-border/70 bg-card px-3.5 py-3 text-left",
          "transition-colors hover:border-border hover:bg-muted/40",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-14 font-medium">{article.title}</span>
          <span className="mt-0.5 block text-13 leading-snug text-muted-foreground">
            {article.summary}
          </span>
        </span>
        <ArrowRightIcon className="mt-0.5 h-4 w-4 shrink-0 text-placeholder transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </button>
    </li>
  );
}

// ── Article ─────────────────────────────────────────────────────────────────

function Article({
  article, onSelect,
}: { article: DocArticle; onSelect: (slug: string | null) => void }) {
  const { prev, next } = neighbours(article.slug);

  return (
    <article>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className="mb-5 flex items-center gap-1.5 text-12 text-tertiary transition-colors hover:text-foreground"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" /> Sommaire
      </button>

      <h1 className="text-2xl font-medium">{article.title}</h1>

      <div className="mt-5">{article.body()}</div>

      {/* La lecture au fil : la documentation se parcourt aussi de bout en
          bout, et remonter au sommaire entre chaque article rend ce parcours
          pénible pour rien. */}
      {(prev || next) && (
        <nav className="mt-10 grid gap-2 border-t border-border pt-5 sm:grid-cols-2">
          {prev ? (
            <button
              type="button"
              onClick={() => onSelect(prev.slug)}
              className="rounded-lg border border-border/70 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40"
            >
              <span className="block text-11 text-tertiary">Précédent</span>
              <span className="block truncate text-13 font-medium">{prev.title}</span>
            </button>
          ) : <span />}
          {next && (
            <button
              type="button"
              onClick={() => onSelect(next.slug)}
              className="rounded-lg border border-border/70 px-3.5 py-2.5 text-right transition-colors hover:bg-muted/40 sm:col-start-2"
            >
              <span className="block text-11 text-tertiary">Suivant</span>
              <span className="block truncate text-13 font-medium">{next.title}</span>
            </button>
          )}
        </nav>
      )}
    </article>
  );
}

// ── Le panneau (table des matières dans la barre latérale) ───────────────────

export function DocsPanel({
  active, onSelect,
}: { active?: string | null; onSelect: (slug: string | null) => void }) {
  return (
    <div className="space-y-4 px-2.5 py-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-13 transition-colors",
          !active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60",
        )}
      >
        <BookOpenIcon className="h-4 w-4" /> Sommaire
      </button>

      {DOC_SECTIONS.map((s) => (
        <div key={s.key}>
          <div className="px-2 pb-1 text-[12px] text-muted-foreground">{s.label}</div>
          <nav className="space-y-0.5">
            {s.articles.map((a) => (
              <button
                key={a.slug}
                type="button"
                onClick={() => onSelect(a.slug)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 transition-colors",
                  active === a.slug
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <span className="min-w-0 truncate">{a.title}</span>
              </button>
            ))}
          </nav>
        </div>
      ))}
    </div>
  );
}

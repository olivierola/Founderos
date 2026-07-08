# Elms Sans font files

The app uses **Elms Sans** as its primary typeface (see `src/styles/globals.css`
`@font-face` + `tailwind.config.ts` → `fontFamily.sans`). It isn't a Google font,
so the files are **not** committed.

Drop the web font files here with these exact names and the app picks them up
automatically (no rebuild needed in dev):

```
public/fonts/ElmsSans-Regular.woff2   (weight 400)
public/fonts/ElmsSans-Medium.woff2    (weight 500)
public/fonts/ElmsSans-SemiBold.woff2  (weight 600)
public/fonts/ElmsSans-Bold.woff2      (weight 700)
```

`.woff` fallbacks with the same base names are also referenced if present.

Until the files are added (or unless Elms Sans is installed as a system font),
the type stack falls back to **Vend Sans**.

> Tip: if you only have `.ttf`/`.otf`, convert to `.woff2` (e.g. `npx
> ttf2woff2 ElmsSans-Regular.ttf > ElmsSans-Regular.woff2`) or just rename the
> `@font-face` `src` formats to match what you have.

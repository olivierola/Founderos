// L'entrée du conteneur d'un agent embarqué : relié à FounderOS (runtime.ts),
// ou isolé (isolated.ts) quand sa configuration figée le demande.

import { readFile } from "node:fs/promises";

const built = await readFile(process.env.MANIFEST || "/app/manifest.json", "utf8")
  .then((t) => JSON.parse(t) as { connectivity?: string })
  .catch(() => null);

if (built?.connectivity === "isolated") await import("./isolated.ts");
else await import("./runtime.ts");

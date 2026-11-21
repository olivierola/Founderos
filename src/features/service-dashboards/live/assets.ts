import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";

// Les modèles 3D du Live Space — tous sous licence CC0 (voir public/live/CREDITS.md).
//
//   · le Furniture Pack de Kenney : bureaux, écrans, chaises de bureau, cuisine ;
//   · KayKit Furniture Bits : canapés, fauteuils, lampes, étagères, tapis.
//
// Chargés UNE fois, au premier Live Space ouvert, puis gardés en mémoire :
// chaque bureau en pose des clones, qui partagent géométrie et matériaux.
// Chaque modèle est NORMALISÉ à l'arrivée — centré en x/z, posé au sol, mis à
// l'échelle de la scène — pour que la mise en place parle en unités de la
// scène (1 = une dalle ≈ 1 m) plutôt qu'en unités de chaque pack.

const BASE = `${import.meta.env.BASE_URL}live/`;

export const KENNEY = [
  "desk", "chairDesk", "computerScreen", "computerKeyboard", "computerMouse", "laptop", "lampSquareTable",
  "pottedPlant", "plantSmall1", "plantSmall2", "plantSmall3", "kitchenCoffeeMachine", "kitchenBar",
  "kitchenFridgeSmall", "stoolBar", "bookcaseOpen", "books", "trashcan", "speaker", "televisionModern",
  "coatRackStanding", "tableCoffee", "loungeSofa", "loungeChair", "rugRounded", "lampRoundFloor",
  "cardboardBoxClosed", "radio", "bench", "benchCushion", "lampSquareFloor",
  "table", "tableRound", "chairRounded", "chairCushion", "chair", "deskCorner", "lampRoundTable",
  "bookcaseClosedWide", "loungeChairRelax", "tableGlass", "sideTable", "cabinetTelevision", "rugRound", "rugRectangle",
  "loungeSofaCorner", "loungeSofaLong", "loungeSofaOttoman", "tableCoffeeGlass", "tableCoffeeSquare", "bookcaseOpenLow",
  "kitchenCabinet", "kitchenSink", "kitchenFridge", "kitchenMicrowave", "kitchenCabinetUpper", "speakerSmall",
  "sideTableDrawers", "rugSquare", "pillow", "stoolBarSquare", "kitchenBarEnd", "coatRack", "televisionVintage",
  "benchCushionLow", "lampSquareCeiling",
] as const;

export const KAYKIT = [
  "couch_pillows", "armchair_pillows", "lamp_standing", "shelf_B_large_decorated", "cabinet_medium_decorated",
  "cactus_medium_A", "cactus_small_A", "pictureframe_large_A", "pictureframe_large_B", "rug_oval_A",
  "rug_rectangle_stripes_A", "table_low", "book_set", "pillow_A",
  "couch", "armchair", "lamp_table", "pictureframe_medium", "pictureframe_small_A", "pictureframe_small_B",
  "pictureframe_standing_A", "shelf_A_big", "shelf_B_small_decorated", "cabinet_small_decorated", "cactus_medium_B",
  "table_medium", "table_medium_long", "rug_rectangle_A", "rug_rectangle_B", "rug_oval_B", "rug_rectangle_stripes_B",
  "pillow_B", "chair_A_wood",
] as const;

export type PropName = (typeof KENNEY)[number] | (typeof KAYKIT)[number];

export interface LiveAssets {
  /** Le gabarit de chaque meuble, normalisé. À cloner, jamais à poser tel quel. */
  props: Map<PropName, THREE.Group>;
}

/** La largeur d'un bureau Kenney dans la scène. Tout le pack suit la même
 *  échelle, pour que l'écran garde sa taille par rapport au bureau. */
const DESK_WIDTH = 1.5;
/** Un canapé KayKit fait environ deux mètres. */
const COUCH_WIDTH = 2.1;

function bbox(o: THREE.Object3D) {
  o.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(o);
}

/** Pose un modèle dans un groupe pivot : centré en x/z, au sol, à l'échelle. */
function normalize(model: THREE.Object3D, scale: number): THREE.Group {
  model.scale.setScalar(scale);
  const b = bbox(model);
  const c = b.getCenter(new THREE.Vector3());
  model.position.set(-c.x, -b.min.y, -c.z);
  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  return pivot;
}

/** Les OBJ de Kenney arrivent en Phong : on les passe en matériau PBR, pour
 *  qu'ils prennent la même lumière que le reste — l'environnement, les ombres
 *  douces. Un « verre » reste translucide. */
function toStandard(root: THREE.Object3D) {
  const cache = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material) => {
      const hit = cache.get(m);
      if (hit) return hit;
      const p = m as THREE.MeshPhongMaterial;
      const name = (p.name || "").toLowerCase();
      const s = new THREE.MeshStandardMaterial({
        color: p.color ?? new THREE.Color("#cccccc"),
        roughness: name.includes("metal") ? 0.45 : name.includes("glass") ? 0.1 : 0.78,
        metalness: name.includes("metal") ? 0.35 : 0,
        transparent: name.includes("glass"),
        opacity: name.includes("glass") ? 0.45 : 1,
        name: p.name,
      });
      cache.set(m, s);
      return s;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

async function loadKenney(name: string): Promise<THREE.Group> {
  const mtl = await new MTLLoader().setPath(`${BASE}kenney/`).loadAsync(`${name}.mtl`);
  mtl.preload();
  const obj = await new OBJLoader().setMaterials(mtl).setPath(`${BASE}kenney/`).loadAsync(`${name}.obj`);
  toStandard(obj);
  return obj;
}

let pending: Promise<LiveAssets> | null = null;

export function loadLiveAssets(): Promise<LiveAssets> {
  if (pending) return pending;
  pending = (async () => {
    const kk = new GLTFLoader().setPath(`${BASE}kaykit/`);
    const [kenney, kaykit] = await Promise.all([
      Promise.all(KENNEY.map(async (n) => [n, await loadKenney(n)] as const)),
      Promise.all(KAYKIT.map(async (n) => [n, (await kk.loadAsync(`${n}.gltf`)).scene] as const)),
    ]);

    // Une échelle par pack, mesurée sur un meuble de référence.
    const kDesk = kenney.find(([n]) => n === "desk")![1];
    const kScale = DESK_WIDTH / bbox(kDesk).getSize(new THREE.Vector3()).x;
    const kkCouch = kaykit.find(([n]) => n === "couch_pillows")![1];
    const kkScale = COUCH_WIDTH / bbox(kkCouch).getSize(new THREE.Vector3()).x;

    const props = new Map<PropName, THREE.Group>();
    for (const [n, o] of kenney) props.set(n, normalize(o, kScale));
    for (const [n, o] of kaykit) props.set(n, normalize(o, kkScale));

    return { props };
  })();
  // Un échec (réseau, fichier manquant) ne doit pas condamner les ouvertures
  // suivantes à la même promesse rejetée.
  pending.catch(() => { pending = null; });
  return pending;
}

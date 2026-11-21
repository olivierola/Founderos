import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Layout, Zone, Seat, Spot, Fixture, WallSeg, WallArt, FloorKind } from "./layout";
import { findPath, isFree, type NavGrid, type P } from "./nav";
import { KAYKIT, loadLiveAssets, type LiveAssets, type PropName } from "./assets";
import { avatarColor, buildAgentFigure, describeAvatar, type AvatarSpec } from "./figures";

// La scène du Live Space : les locaux du service, comme une maquette éclairée
// posée sur une petite île.
//
// Elle DESSINE le plan (layout.ts) — pièces, murs, mobilier, sièges — et ses
// agents s'y déplacent sur la grille de navigation tirée du même plan
// (nav.ts) : ils contournent les murs, les meubles, et s'écartent les uns des
// autres. On peut aussi y ENTRER : un personnage à soi, au clavier, et l'on
// parle aux agents qu'on croise.
//
// Modèles CC0 : Kenney et KayKit (voir assets.ts). Les agents ont le visage de
// leur avatar (voir figures.ts).

export type AgentState = "working" | "waiting" | "error" | "idle";

export interface SceneAgent {
  id: string;
  name: string;
  color: string;
  state: AgentState;
  /** Son avatar (`bot:…`, `human:…` ou un portrait) : le personnage en découle. */
  avatarUrl?: string | null;
}

export interface SkillItem { id: string; name: string; category: string | null }

export interface SceneCommand { kind: "zoom-in" | "zoom-out" | "fit"; n: number }

export interface LiveSceneProps {
  layout: Layout;
  agents: SceneAgent[];
  selectedId: string | null;
  hoveredId: string | null;
  /** L'équipe qu'on compose : ses membres portent un anneau à sa couleur. */
  highlight: { color: string; ids: Set<string> } | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  /** Quarts de tour de la caméra autour des locaux. */
  angle: number;
  command: SceneCommand | null;
  dark: boolean;
  /** Les étiquettes DOM posées au-dessus du canevas, par clé
   *  (`agent:<id>`, `zone:<clé>`, `player`) : la scène les déplace à chaque image. */
  labels: React.MutableRefObject<Map<string, HTMLElement>>;
  /** Le nombre de souvenirs de la mémoire partagée : le silo s'en remplit. */
  memoryCount?: number;
  /** Par agent, un compteur qui monte à chaque souvenir qu'il vient d'écrire. */
  storeSignals?: Map<string, number>;
  onOpenMemory?: () => void;
  /** Par agent, la dernière visite à rendre : à qui il vient d'écrire (A2A),
   *  et un compteur qui monte à chaque nouveau message. */
  visitSignals?: Map<string, { to: string; n: number }>;
  /** Les agents qui parlent en ce moment (une bulle est à l'écran). */
  speaking?: Set<string>;
  /** Les agents en réunion : l'index de leur chaise en salle de réunion. */
  meetings?: Map<string, number>;
  /** Le mode « dans l'espace » : un personnage à soi, au clavier. */
  game?: { avatar: AvatarSpec; talkingTo: string | null } | null;
  /** L'agent le plus proche du joueur (à portée de voix), ou personne. */
  onNearAgent?: (id: string | null) => void;
  /** Le joueur a demandé à parler à cet agent. */
  onInteract?: (id: string) => void;
  /** Les skills du service : l'armoire d'Utilities en porte une cartouche
   *  chacun ; un clic l'ouvre. */
  skills?: { list: SkillItem[]; onOpen?: () => void };
  /** Par agent, un compteur qui monte à chaque skill qu'il vient d'acquérir :
   *  il va le chercher à l'armoire. */
  skillSignals?: Map<string, number>;
  /** La vue 3D ne tient pas (contexte WebGL perdu à répétition) : l'hôte
   *  passe au plan 2D plutôt que d'afficher un écran mort. */
  onFatal?: (reason: "lost") => void;
}

// ── Matière ──────────────────────────────────────────────────────────────────

const UNIT = new THREE.BoxGeometry(1, 1, 1);
const std = new Map<string, THREE.MeshStandardMaterial>();
const mat = (c: string, rough = 0.85, flat = false) => {
  const k = `${c}:${rough}:${flat}`;
  let m = std.get(k);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, flatShading: flat }); std.set(k, m); }
  return m;
};
const GLASS = new THREE.MeshPhysicalMaterial({ color: "#cfe6f5", roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.28, depthWrite: false });
const HIT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

/** La hauteur du socle du bâtiment au-dessus du jardin. */
const PLINTH = 0.42;
/** Le dessus du sol des pièces, au-dessus du socle. */
const FLOOR_Y = 0.12;

function palette(dark: boolean) {
  return {
    plinth: dark ? "#d4c8b8" : "#e2d7c7",
    plinthSide: dark ? "#9c8f80" : "#b9ab98",
    runner: "#b98a6a",
    wall: "#f1e9de",
    wallCap: "#d9cbb8",
    frame: "#ffffff",
    glass: dark ? "#8fb7e0" : "#cfe8ff",
    screenOff: "#1c2430",
    soil: "#8a6247",
    rock: dark ? "#5d5963" : "#7d7882",
    stone: "#d6d1c8",
    water: "#6cb4dd",
    metal: "#8d96a6",
  };
}
type Pal = ReturnType<typeof palette>;

/** Mélange deux couleurs en sRGB — comme l'œil les lit. */
function mix(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (v: number, sh: number) => (v >> sh) & 255;
  const out = [16, 8, 0].map((sh) => Math.round(ch(pa, sh) + (ch(pb, sh) - ch(pa, sh)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Un meuble du catalogue, cloné (géométrie et matériaux partagés). */
function Prop({ assets, name, p, r = 0, s = 1 }: {
  assets: LiveAssets; name: PropName; p: [number, number, number]; r?: number; s?: number;
}) {
  const obj = useMemo(() => assets.props.get(name)?.clone() ?? new THREE.Group(), [assets, name]);
  return <primitive object={obj} position={p} rotation={[0, r, 0]} scale={s} />;
}

// Les deux packs ne regardent pas du même côté : la façade d'un meuble Kenney
// est vers −z, celle d'un meuble KayKit vers +z. Le plan donne la direction de
// FAÇADE voulue ; on convertit au moment de poser.
const KAYKIT_SET = new Set<string>(KAYKIT);
const facing = (name: string, rot: number) => (KAYKIT_SET.has(name) ? rot : rot + Math.PI);

const V2 = (x: number, z: number) => new THREE.Vector2(x, z);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// ── Ce que partagent les éléments de la scène ────────────────────────────────

interface SiloState {
  pulse: React.MutableRefObject<number>;
  plugged: React.MutableRefObject<number>;
  count: number;
  onOpen?: () => void;
}
const SiloCtx = createContext<SiloState | null>(null);

/** Où se trouve chacun, à chaque image : de quoi s'écarter les uns des autres.
 *  Le joueur y figure sous la clé `!player`. */
type Crowd = Map<string, { x: number; z: number; moving: boolean }>;
const CrowdCtx = createContext<React.MutableRefObject<Crowd> | null>(null);

/** Les places prises : clé de la place → l'agent qui s'y rend ou s'y trouve. */
type Claims = Map<string, { id: string; x: number; z: number }>;
const ClaimsCtx = createContext<React.MutableRefObject<Claims> | null>(null);
const spotKey = (x: number, z: number) => `${x.toFixed(2)}:${z.toFixed(2)}`;

/** Les voyants des baies : une poignée de matériaux partagés, animés une fois. */
const LED_COLORS = ["#4ade80", "#60a5fa", "#fbbf24", "#a78bfa"];
const LedCtx = createContext<THREE.MeshBasicMaterial[]>([]);

// ── La scène ─────────────────────────────────────────────────────────────────

export default function LiveScene(props: LiveSceneProps) {
  const [assets, setAssets] = useState<LiveAssets | null>(null);
  const [failed, setFailed] = useState(false);
  const moved = useRef(false);
  // Un contexte WebGL peut se perdre (pilote qui redémarre, onglet en veille,
  // trop de contextes ouverts) : on repart alors sur un canevas neuf, sans
  // rien demander. Trois pertes en une minute : on rend la main à l'hôte.
  const [gen, setGen] = useState(0);
  const [lost, setLost] = useState(false);
  const losses = useRef<number[]>([]);
  const onFatal = useRef(props.onFatal);
  onFatal.current = props.onFatal;
  const watchContext = (canvas: HTMLCanvasElement) => {
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      const now = Date.now();
      losses.current = [...losses.current.filter((t) => now - t < 60_000), now];
      setLost(true);
      if (losses.current.length >= 3) { onFatal.current?.("lost"); return; }
      window.setTimeout(() => { setGen((g) => g + 1); setLost(false); }, 900);
    }, { once: true });
  };
  useEffect(() => {
    let alive = true;
    loadLiveAssets().then((a) => { if (alive) setAssets(a); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        Les modèles 3D n'ont pas pu être chargés. Rechargez la page.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Canvas
        key={gen}
        shadows
        dpr={[1, 1.75]}
        // « default » plutôt que « high-performance » : sur un portable à deux
        // GPU, forcer le gros déclenche des bascules, et des pertes de contexte.
        gl={{ antialias: true, alpha: true, powerPreference: "default" }}
        camera={{ fov: 30, position: [24, 20, 24], near: 0.3, far: 600 }}
        onCreated={({ gl }) => watchContext(gl.domElement)}
        onPointerMissed={() => { if (!moved.current) props.onSelect(null); }}
      >
        {assets && <SceneContent {...props} assets={assets} moved={moved} />}
      </Canvas>
      {(!assets || lost) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-background/80 px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm ring-1 ring-border/60 backdrop-blur">
            {lost ? "Reprise de la vue 3D…" : "On installe les bureaux…"}
          </span>
        </div>
      )}
    </div>
  );
}

function Environment({ intensity }: { intensity: number }) {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => { scene.environment = null; env.dispose(); pm.dispose(); };
  }, [gl, scene]);
  useEffect(() => { scene.environmentIntensity = intensity; }, [scene, intensity]);
  return null;
}

function LedTicker({ mats }: { mats: THREE.MeshBasicMaterial[] }) {
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    mats.forEach((m, i) => { m.color.set(LED_COLORS[i]).multiplyScalar(Math.sin(t * (2.5 + i * 1.7) + i) > 0 ? 1 : 0.3); });
  });
  return null;
}

function SceneContent({
  layout, agents, selectedId, hoveredId, highlight, onSelect, onHover, angle, command, dark, labels, moved, assets,
  memoryCount = 0, storeSignals, onOpenMemory, visitSignals, speaking, meetings, game, onNearAgent, onInteract,
  skills, skillSignals,
}: LiveSceneProps & { moved: React.MutableRefObject<boolean>; assets: LiveAssets }) {
  const pal = useMemo(() => palette(dark), [dark]);
  const objects = useRef(new Map<string, THREE.Object3D>());
  const crowd = useRef<Crowd>(new Map());
  const claims = useRef<Claims>(new Map());
  const pulse = useRef(0);
  const plugged = useRef(0);
  const silo = useMemo<SiloState>(() => ({ pulse, plugged, count: memoryCount, onOpen: onOpenMemory }), [memoryCount, onOpenMemory]);
  const skillPulse = useRef(0);
  const skillState = useMemo<SkillsState>(
    () => ({ list: skills?.list ?? [], onOpen: skills?.onOpen, pulse: skillPulse }),
    [skills?.list, skills?.onOpen],
  );
  const leds = useMemo(() => LED_COLORS.map((c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false })), []);
  useEffect(() => () => leds.forEach((m) => m.dispose()), [leds]);
  const playerPos = useRef<P | null>(null);
  const az = useRef(Math.PI / 4);

  const stateOf = new Map(agents.map((a) => [a.id, a.state]));
  // L'écran d'un poste s'allume à la couleur de l'avatar de son agent.
  const colorOf = useMemo(
    () => new Map(agents.map((a) => [a.id, avatarColor(describeAvatar(a.avatarUrl, a.name))])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents.map((a) => `${a.id}:${a.avatarUrl ?? ""}:${a.name}`).join("|")],
  );
  const { bounds } = layout;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const agentPos = (id: string) => crowd.current.get(id) ?? null;

  return (
    <SiloCtx.Provider value={silo}>
    <SkillsCtx.Provider value={skillState}>
    <CrowdCtx.Provider value={crowd}>
    <ClaimsCtx.Provider value={claims}>
    <LedCtx.Provider value={leds}>
      <LedTicker mats={leds} />
      <Environment intensity={dark ? 0.42 : 0.5} />
      <hemisphereLight args={["#ffeedd", dark ? "#3a2f2a" : "#6b5848", dark ? 0.5 : 0.62]} />
      <WarmLights layout={layout} />
      <directionalLight
        position={[-span * 0.45, span * 0.95, span * 0.6]}
        intensity={dark ? 2.1 : 2.5}
        color="#ffe0bd"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span * 0.75}
        shadow-camera-right={span * 0.75}
        shadow-camera-top={span * 0.75}
        shadow-camera-bottom={-span * 0.75}
        shadow-camera-near={0.5}
        shadow-camera-far={span * 4}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />

      <CameraRig layout={layout} angle={angle} command={command} moved={moved} follow={game ? playerPos : null} azOut={az} />
      <LabelSync labels={labels} objects={objects} layout={layout} playerPos={game ? playerPos : null} />

      <AssetsCtx.Provider value={assets}>
      <Island layout={layout} pal={pal} assets={assets} />

      {/* Le bâtiment, posé sur son socle : tout ce qui est dedans se mesure
          depuis le dessus du socle. */}
      <group position={[0, PLINTH, 0]}>
        <OpenFloor layout={layout} pal={pal} assets={assets} />
        {layout.zones.map((z) => (
          <ZoneView key={z.key} zone={z} pal={pal} assets={assets} stateOf={stateOf} colorOf={colorOf} />
        ))}

        {agents.map((a) => {
          const home = layout.seatOf.get(a.id);
          if (!home) return null;
          const ring = highlight?.ids.has(a.id) ? highlight.color
            : selectedId === a.id ? "#9d8cf0"
            : hoveredId === a.id ? "#ffffff"
            : null;
          return (
            <Agent
              key={a.id}
              agent={a} seat={home.seat} zone={home.zone} layout={layout}
              storeSignal={storeSignals?.get(a.id) ?? 0}
              skillSignal={skillSignals?.get(a.id) ?? 0}
              visit={visitSignals?.get(a.id) ?? null}
              speaking={!!speaking?.has(a.id)}
              meetSeat={meetings?.get(a.id) ?? null}
              talkingToPlayer={game?.talkingTo === a.id}
              agentPos={agentPos}
              ring={ring}
              onSelect={onSelect} onHover={onHover}
              register={(o) => { if (o) objects.current.set(a.id, o); else objects.current.delete(a.id); }}
            />
          );
        })}

        {game && (
          <Player
            spec={game.avatar} nav={layout.nav} hall={layout.hall} posOut={playerPos} az={az}
            onNear={onNearAgent} onInteract={onInteract}
          />
        )}
      </group>
      </AssetsCtx.Provider>
    </LedCtx.Provider>
    </ClaimsCtx.Provider>
    </CrowdCtx.Provider>
    </SkillsCtx.Provider>
    </SiloCtx.Provider>
  );
}

// ── Caméra : maquette (orbite) ou à la suite du joueur ───────────────────────

function CameraRig({ layout, angle, command, moved, follow, azOut }: {
  layout: Layout; angle: number; command: SceneCommand | null; moved: React.MutableRefObject<boolean>;
  /** En mode jeu : la position du joueur, que la caméra suit. */
  follow: React.MutableRefObject<P | null> | null;
  /** L'azimut courant, que lit le joueur pour avancer « devant lui ». */
  azOut: React.MutableRefObject<number>;
}) {
  const { camera, size, gl } = useThree();
  const cam = camera as THREE.PerspectiveCamera;
  const target = useRef(new THREE.Vector3());
  const az = useRef(Math.PI / 4 + angle * (Math.PI / 2));
  const goalAz = useRef(az.current);
  const elev = useRef(0.66);
  const dist = useRef(40);
  const goalDist = useRef(40);
  const userZoomed = useRef(false);
  const followRef = useRef(follow);
  followRef.current = follow;
  const b = layout.building;
  const boundsKey = `${b.minX}:${b.maxX}:${b.minZ}:${b.maxZ}`;

  const place = () => {
    cam.position.set(
      target.current.x + Math.sin(az.current) * Math.cos(elev.current) * dist.current,
      target.current.y + Math.sin(elev.current) * dist.current,
      target.current.z + Math.cos(az.current) * Math.cos(elev.current) * dist.current,
    );
    cam.lookAt(target.current);
    azOut.current = az.current;
  };

  const fitDist = () => {
    const r = Math.hypot(b.maxX - b.minX + 3, b.maxZ - b.minZ + 3) / 2;
    const v = THREE.MathUtils.degToRad(cam.fov);
    const h = 2 * Math.atan(Math.tan(v / 2) * (size.width / Math.max(1, size.height)));
    return THREE.MathUtils.clamp((r / Math.sin(Math.min(v, h) / 2)) * 0.78, 8, 260);
  };

  useEffect(() => {
    if (followRef.current) return;
    target.current.set((b.minX + b.maxX) / 2, PLINTH, (b.minZ + b.maxZ) / 2);
    goalDist.current = fitDist();
    if (!userZoomed.current) dist.current = goalDist.current;
    place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  // Entrer et sortir de l'espace : la caméra descend derrière le joueur, ou
  // remonte au-dessus de la maquette.
  const inGame = !!follow;
  useEffect(() => {
    if (inGame) {
      goalDist.current = 7;
      elev.current = 0.5;
    } else {
      elev.current = 0.66;
      userZoomed.current = false;
      target.current.set((b.minX + b.maxX) / 2, PLINTH, (b.minZ + b.maxZ) / 2);
      goalDist.current = fitDist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inGame]);

  useEffect(() => {
    if (!userZoomed.current && !followRef.current) goalDist.current = fitDist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  useEffect(() => { goalAz.current = Math.PI / 4 + angle * (Math.PI / 2); }, [angle]);

  useEffect(() => {
    if (!command) return;
    if (command.kind === "fit") {
      userZoomed.current = false;
      if (!followRef.current) target.current.set((b.minX + b.maxX) / 2, PLINTH, (b.minZ + b.maxZ) / 2);
      goalDist.current = followRef.current ? 7 : fitDist();
    } else {
      userZoomed.current = true;
      goalDist.current = THREE.MathUtils.clamp(goalDist.current * (command.kind === "zoom-in" ? 1 / 1.3 : 1.3), 3, 280);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command?.n]);

  useEffect(() => {
    const el = gl.domElement;
    el.style.cursor = "grab";
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userZoomed.current = true;
      const min = followRef.current ? 3 : 6;
      const max = followRef.current ? 18 : 280;
      goalDist.current = THREE.MathUtils.clamp(goalDist.current * Math.exp(e.deltaY * 0.0012), min, max);
    };
    let drag: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; moved.current = false; };
    const onMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!moved.current && Math.hypot(dx, dy) < 4) return;
      moved.current = true;
      el.style.cursor = "grabbing";
      drag = { x: e.clientX, y: e.clientY };
      if (followRef.current) {
        // Dans l'espace : glisser fait tourner la vue autour du joueur.
        az.current -= dx * 0.006;
        goalAz.current = az.current;
        elev.current = THREE.MathUtils.clamp(elev.current + dy * 0.004, 0.2, 1.15);
      } else {
        const wpp = (2 * dist.current * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, size.height);
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
        const fwd = new THREE.Vector3().subVectors(target.current, cam.position).setY(0).normalize();
        target.current.addScaledVector(right, -dx * wpp);
        target.current.addScaledVector(fwd, (dy * wpp) / Math.sin(elev.current));
      }
      place();
    };
    const onUp = () => {
      drag = null;
      el.style.cursor = "grab";
      setTimeout(() => { moved.current = false; }, 0);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, cam, size.height]);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const p = followRef.current?.current;
    if (p) {
      const k = Math.min(1, dt * 6);
      target.current.x += (p.x - target.current.x) * k;
      target.current.y += (PLINTH + 0.9 - target.current.y) * k;
      target.current.z += (p.z - target.current.z) * k;
    }
    const dAz = goalAz.current - az.current;
    if (Math.abs(dAz) > 0.0005) az.current += dAz * Math.min(1, dt * 6);
    const dD = goalDist.current - dist.current;
    if (Math.abs(dD) > 0.01) dist.current += dD * Math.min(1, dt * 8);
    place();
  });

  return null;
}

// ── Les étiquettes : du DOM net au-dessus de la scène ────────────────────────

function LabelSync({ labels, objects, layout, playerPos }: {
  labels: React.MutableRefObject<Map<string, HTMLElement>>;
  objects: React.MutableRefObject<Map<string, THREE.Object3D>>;
  layout: Layout;
  playerPos: React.MutableRefObject<P | null> | null;
}) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  // Le nom d'une pièce se pose au-dessus de son mur le plus ÉLOIGNÉ de la
  // caméra — celui qui reste debout — quel que soit l'angle de vue.
  const zoneAnchor = useMemo(() => new Map(layout.zones.map((z) => {
    const y = PLINTH + 2.05;
    return [`zone:${z.key}`, [
      new THREE.Vector3(z.x + z.w / 2, y, z.z + 0.2),
      new THREE.Vector3(z.x + z.w / 2, y, z.z + z.d - 0.2),
      new THREE.Vector3(z.x + 0.2, y, z.z + z.d / 2),
      new THREE.Vector3(z.x + z.w - 0.2, y, z.z + z.d / 2),
    ]];
  })), [layout]);

  useFrame(() => {
    for (const [key, el] of labels.current) {
      if (key.startsWith("agent:")) {
        const o = objects.current.get(key.slice(6));
        if (!o) { el.style.opacity = "0"; continue; }
        o.getWorldPosition(v);
        v.y += 1.3;
      } else if (key === "player") {
        const p = playerPos?.current;
        if (!p) { el.style.opacity = "0"; continue; }
        v.set(p.x, PLINTH + FLOOR_Y + 1.45, p.z);
      } else {
        const cands = zoneAnchor.get(key);
        if (!cands) { el.style.opacity = "0"; continue; }
        let best = cands[0], far = -1;
        for (const c of cands) {
          const dd = (c.x - camera.position.x) ** 2 + (c.z - camera.position.z) ** 2;
          if (dd > far) { far = dd; best = c; }
        }
        v.copy(best);
      }
      v.project(camera);
      const behind = v.z > 1;
      const x = (v.x + 1) / 2 * size.width;
      const y = (1 - v.y) / 2 * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.opacity = behind || x < -60 || y < -60 || x > size.width + 60 || y > size.height + 60 ? "0" : "1";
    }
  });
  return null;
}

// ── Les textures dessinées ───────────────────────────────────────────────────

function useCanvasTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, repeat: [number, number], deps: unknown[], size: [number, number] = [256, 256]) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = size[0]; c.height = size[1];
    draw(c.getContext("2d")!, size[0], size[1]);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.repeat.set(repeat[0], repeat[1]);
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

/** Le sol de chaque genre de pièce : chacun sa matière, pour que deux
 *  bureaux voisins ne se ressemblent pas. */
function drawFloor(kind: FloorKind, color: string | null) {
  return (ctx: CanvasRenderingContext2D, n: number) => {
    const r = seeded(hash(kind));
    if (kind === "herringbone") {
      // Le parquet du plateau : de longues lames de chêne miel, à joints décalés.
      const rows = 8, h = n / rows;
      for (let i = 0; i < rows; i++) {
        let x = -Math.floor(r() * n * 0.6);
        while (x < n) {
          const len = n * (0.45 + r() * 0.35);
          const tone = 188 + Math.floor(r() * 16);
          ctx.fillStyle = `rgb(${tone}, ${tone - 52}, ${tone - 100})`;
          ctx.fillRect(x, i * h, len, h);
          ctx.fillStyle = "rgba(255, 236, 205, 0.07)";
          ctx.fillRect(x, i * h + h * 0.2, len, h * 0.25);
          ctx.fillStyle = "rgba(80, 44, 20, 0.22)";
          ctx.fillRect(x, i * h, 1.2, h);
          x += len;
        }
        ctx.fillStyle = "rgba(80, 44, 20, 0.2)";
        ctx.fillRect(0, i * h, n, 1.2);
      }
      return;
    }
    if (kind === "tile") {
      // Des tomettes : terre cuite et crème, en damier.
      const q = n / 4;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 ? "#eee3d1" : "#d6a07a";
        ctx.fillRect(i * q, j * q, q, q);
        ctx.fillStyle = `rgba(0, 0, 0, ${0.03 + r() * 0.05})`;
        ctx.fillRect(i * q, j * q, q, q);
      }
      ctx.strokeStyle = "rgba(90, 60, 40, 0.35)"; ctx.lineWidth = 2;
      for (let k = 0; k <= 4; k++) { ctx.beginPath(); ctx.moveTo(k * q, 0); ctx.lineTo(k * q, n); ctx.moveTo(0, k * q); ctx.lineTo(n, k * q); ctx.stroke(); }
      return;
    }
    if (kind === "cork") {
      ctx.fillStyle = "#c79a68"; ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 1800; i++) {
        const g = 120 + Math.floor(r() * 70);
        ctx.fillStyle = `rgba(${g + 40}, ${g}, ${g - 50}, 0.45)`;
        ctx.fillRect(r() * n, r() * n, 1.5 + r() * 3, 1.5 + r() * 3);
      }
      return;
    }
    if (kind === "wood" || kind === "darkwood") {
      const base = kind === "wood" ? 226 : 150;
      for (let i = 0; i < 8; i++) {
        const tone = base - Math.floor(r() * 16);
        ctx.fillStyle = kind === "wood" ? `rgb(${tone}, ${tone - 30}, ${tone - 66})` : `rgb(${tone}, ${tone - 38}, ${tone - 62})`;
        ctx.fillRect(0, i * 32, n, 32);
        ctx.fillStyle = "rgba(60, 35, 15, 0.22)";
        ctx.fillRect(0, i * 32, n, 1.5);
        ctx.fillRect(Math.floor(r() * 200) + 28, i * 32, 1.5, 32);
      }
    } else if (kind === "terrazzo") {
      ctx.fillStyle = "#ece7df"; ctx.fillRect(0, 0, n, n);
      const chips = ["#c9b8a6", "#9db4c0", "#d8a48f", "#a7a29a", color ? mix(color, "#ffffff", 0.3) : "#b9adff"];
      for (let i = 0; i < 420; i++) {
        ctx.fillStyle = chips[Math.floor(r() * chips.length)];
        const s = 1.5 + r() * 4.5;
        ctx.beginPath(); ctx.ellipse(r() * n, r() * n, s, s * (0.5 + r() * 0.5), r() * 3, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === "concrete") {
      ctx.fillStyle = "#c9ccd1"; ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 1400; i++) {
        const g = 185 + Math.floor(r() * 30);
        ctx.fillStyle = `rgba(${g}, ${g + 2}, ${g + 6}, 0.35)`;
        ctx.fillRect(r() * n, r() * n, 2 + r() * 5, 2 + r() * 5);
      }
      ctx.strokeStyle = "rgba(90, 95, 105, 0.25)"; ctx.lineWidth = 1.5;
      ctx.strokeRect(0.5, 0.5, n - 1, n - 1);
    } else if (kind === "tech") {
      ctx.fillStyle = "#dfe2e8"; ctx.fillRect(0, 0, n, n);
      ctx.fillStyle = "#d4d8df"; ctx.fillRect(0, 0, n / 2, n / 2); ctx.fillRect(n / 2, n / 2, n / 2, n / 2);
      ctx.strokeStyle = "rgba(70, 80, 100, 0.25)"; ctx.lineWidth = 2;
      for (const o of [1, n / 2 + 1]) for (const q of [1, n / 2 + 1]) ctx.strokeRect(o, q, n / 2 - 2, n / 2 - 2);
    } else {
      // Moquette : la teinte de l'équipe (ou un gris chaud), avec sa trame.
      const base = kind === "lounge" ? "#d9c3a5" : kind === "meeting" ? "#7d8aa6" : mix(color ?? "#9aa3b2", "#f4e9da", 0.45);
      ctx.fillStyle = base; ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 2600; i++) {
        ctx.fillStyle = `rgba(0, 0, 0, ${0.025 + r() * 0.035})`;
        ctx.fillRect(r() * n, r() * n, 1.5, 1.5);
      }
    }
  };
}

const FLOOR_SCALE: Record<FloorKind, number> = {
  wood: 2.5, darkwood: 2.5, terrazzo: 3, concrete: 2.4, tech: 1.2, carpet: 2, lounge: 2, meeting: 2,
  tile: 1.4, cork: 2, herringbone: 3.4, none: 1,
};

// ── L'île et son jardin ──────────────────────────────────────────────────────

/** Le dessous de l'île : un bloc de roche qui s'effile, facetté. */
function rockBase(w: number, d: number, h: number, seed: number) {
  const g = new THREE.BoxGeometry(w, h, d, 8, 3, 8);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const r = seeded(seed);
  const jit = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${x.toFixed(3)}:${y.toFixed(3)}:${z.toFixed(3)}`;
    let j = jit.get(k);
    if (!j) { j = [(r() - 0.5) * 0.5, (r() - 0.5) * 0.35, (r() - 0.5) * 0.5]; jit.set(k, j); }
    const t = (h / 2 - y) / h;
    const shrink = 1 - 0.55 * t * t;
    const top = y > h / 2 - 0.01;
    pos.setXYZ(i, x * shrink + (top ? 0 : j[0]), y + (top ? 0 : j[1] - t * 0.6), z * shrink + (top ? 0 : j[2]));
  }
  g.computeVertexNormals();
  return g;
}

function footprints(layout: Layout): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  return [layout.building];
}

function Plinth({ rect, i, pal }: { rect: { minX: number; maxX: number; minZ: number; maxZ: number }; i: number; pal: Pal }) {
  const h = PLINTH + 0.1 - i * 0.002;
  const geo = useMemo(
    () => new RoundedBoxGeometry(rect.maxX - rect.minX + 0.3, h, rect.maxZ - rect.minZ + 0.3, 3, 0.07),
    [rect.maxX, rect.minX, rect.maxZ, rect.minZ, h],
  );
  useEffect(() => () => geo.dispose(), [geo]);
  return <mesh geometry={geo} material={mat(pal.plinthSide, 0.9)} position={[(rect.minX + rect.maxX) / 2, h / 2 - 0.1, (rect.minZ + rect.maxZ) / 2]} castShadow receiveShadow />;
}

function Island({ layout, pal, assets }: { layout: Layout; pal: Pal; assets: LiveAssets }) {
  const b = layout.bounds;
  const bd = layout.building;
  const W = b.maxX - b.minX, D = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const seed = Math.round(W * 31 + D * 17);
  const grassTex = useCanvasTexture((ctx, n) => {
    ctx.fillStyle = "#7fb565"; ctx.fillRect(0, 0, n, n);
    const r = seeded(11);
    for (let i = 0; i < 900; i++) {
      const g = 150 + Math.floor(r() * 50);
      ctx.fillStyle = `rgba(${g - 70}, ${g + 30}, ${g - 90}, ${0.18 + r() * 0.2})`;
      const s = 2 + r() * 6;
      ctx.fillRect(r() * n, r() * n, s, s);
    }
  }, [W / 8, D / 8], [W, D]);
  const grassMat = useMemo(() => new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }), [grassTex]);
  useEffect(() => () => grassMat.dispose(), [grassMat]);
  const grassGeo = useMemo(() => new RoundedBoxGeometry(W, 0.34, D, 4, 0.17), [W, D]);
  const soilGeo = useMemo(() => new RoundedBoxGeometry(W - 0.3, 0.9, D - 0.3, 3, 0.3), [W, D]);
  const rockGeo = useMemo(() => rockBase(W - 0.9, D - 0.9, 2.6, seed), [W, D, seed]);
  useEffect(() => () => { grassGeo.dispose(); soilGeo.dispose(); rockGeo.dispose(); }, [grassGeo, soilGeo, rockGeo]);
  const rects = useMemo(() => footprints(layout), [layout]);

  return (
    <group>
      <mesh geometry={grassGeo} material={grassMat} position={[cx, -0.17, cz]} receiveShadow />
      <mesh geometry={soilGeo} material={mat(pal.soil, 1)} position={[cx, -0.72, cz]} />
      <mesh geometry={rockGeo} material={mat(pal.rock, 1, true)} position={[cx, -2.4, cz]} />
      {rects.map((r, i) => <Plinth key={i} rect={r} i={i} pal={pal} />)}
      {[-1, 1].map((sx) => (
        <group key={sx} position={[sx > 0 ? bd.maxX + 0.25 : bd.minX - 0.25, 0, 0]}>
          {[0, 1, 2].map((i) => (
            <mesh
              key={i} geometry={UNIT} material={mat(pal.plinth, 0.9)}
              position={[sx * (0.22 + i * 0.4), (PLINTH * (3 - i)) / 8, 0]}
              scale={[0.44, (PLINTH * (3 - i)) / 4, layout.hall.half * 2 - 0.2]}
              castShadow receiveShadow
            />
          ))}
        </group>
      ))}
      <Garden layout={layout} pal={pal} assets={assets} seed={seed} rects={rects} />
    </group>
  );
}

type Planted =
  | { kind: "tree"; x: number; z: number; s: number; c: string; cone: boolean }
  | { kind: "bush"; x: number; z: number; s: number; c: string }
  | { kind: "rock"; x: number; z: number; s: number; r: number }
  | { kind: "flowers"; x: number; z: number; c: string }
  | { kind: "mound"; x: number; z: number; sx: number; sz: number };

const LEAVES = ["#6fbf5f", "#5aa957", "#82c96a", "#4f9a55", "#93cf6d"];
const BLOSSOM = ["#f2a7c3", "#f6c4d6"];
const PETALS = ["#f7d24a", "#f29bb5", "#ffffff", "#b9a4f0", "#ff9f6e"];

/** Le jardin : semé une fois par plan, toujours au même endroit pour un même plan. */
function Garden({ layout, pal, assets, seed, rects }: {
  layout: Layout; pal: Pal; assets: LiveAssets; seed: number;
  rects: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
}) {
  const b = layout.bounds, bd = layout.building;
  const pond = useMemo(() => {
    const l = layout.lounge;
    return l
      ? { x: l.x + l.w / 2, z: l.side === "north" ? l.z - 3.1 : l.z + l.d + 3.1, rx: 2.2, rz: 1.5 }
      : { x: bd.minX + 4, z: bd.minZ - 3.1, rx: 2.2, rz: 1.5 };
  }, [layout, bd.minX, bd.minZ]);

  const items = useMemo(() => {
    const r = seeded(seed);
    const out: Planted[] = [];
    const taken: Array<{ x: number; z: number; rad: number }> = [];
    const free = (x: number, z: number, rad: number) => {
      if (x - rad < b.minX + 0.6 || x + rad > b.maxX - 0.6 || z - rad < b.minZ + 0.6 || z + rad > b.maxZ - 0.6) return false;
      if (rects.some((q) => x + rad > q.minX - 0.9 && x - rad < q.maxX + 0.9 && z + rad > q.minZ - 0.9 && z - rad < q.maxZ + 0.9)) return false;
      if (Math.abs(z) < 1.6 + rad && (x < bd.minX || x > bd.maxX)) return false;
      if (((x - pond.x) / (pond.rx + 1.2)) ** 2 + ((z - pond.z) / (pond.rz + 1.2)) ** 2 < 1) return false;
      return taken.every((t) => Math.hypot(t.x - x, t.z - z) > t.rad + rad);
    };
    const tryPlace = (rad: number, make: (x: number, z: number) => Planted, attempts = 30) => {
      for (let i = 0; i < attempts; i++) {
        const x = b.minX + r() * (b.maxX - b.minX), z = b.minZ + r() * (b.maxZ - b.minZ);
        if (free(x, z, rad)) { taken.push({ x, z, rad }); out.push(make(x, z)); return true; }
      }
      return false;
    };
    const area = (b.maxX - b.minX) * (b.maxZ - b.minZ) - (bd.maxX - bd.minX) * (bd.maxZ - bd.minZ);
    for (let i = 0; i < 3; i++) tryPlace(2.2, (x, z) => ({ kind: "mound", x, z, sx: 1.8 + r() * 1.2, sz: 1.4 + r() * 0.9 }));
    const trees = Math.min(46, Math.round(area / 14));
    for (let i = 0; i < trees; i++) {
      tryPlace(0.9, (x, z) => ({
        kind: "tree", x, z, s: 0.8 + r() * 0.6, cone: r() < 0.3,
        c: r() < 0.12 ? BLOSSOM[Math.floor(r() * BLOSSOM.length)] : LEAVES[Math.floor(r() * LEAVES.length)],
      }));
    }
    for (let i = 0; i < Math.min(40, Math.round(area / 12)); i++) {
      tryPlace(0.45, (x, z) => ({ kind: "bush", x, z, s: 0.3 + r() * 0.3, c: LEAVES[Math.floor(r() * LEAVES.length)] }));
    }
    for (let i = 0; i < 14; i++) tryPlace(0.4, (x, z) => ({ kind: "rock", x, z, s: 0.2 + r() * 0.35, r: r() * Math.PI }));
    for (let i = 0; i < 22; i++) tryPlace(0.35, (x, z) => ({ kind: "flowers", x, z, c: PETALS[Math.floor(r() * PETALS.length)] }));
    return out;
  }, [seed, b.minX, b.maxX, b.minZ, b.maxZ, bd.minX, bd.maxX, rects, pond]);

  const stones = useMemo(() => {
    const r = seeded(seed + 7);
    const out: Array<{ x: number; z: number; r: number; w: number }> = [];
    for (const sx of [-1, 1]) {
      const start = sx > 0 ? bd.maxX + 1.6 : bd.minX - 1.6;
      const end = sx > 0 ? b.maxX - 0.6 : b.minX + 0.6;
      for (let x = start; sx > 0 ? x < end : x > end; x += sx * 0.75) {
        out.push({ x, z: (r() - 0.5) * 0.3, r: (r() - 0.5) * 0.4, w: 0.55 + r() * 0.2 });
      }
    }
    return out;
  }, [seed, bd.minX, bd.maxX, b.minX, b.maxX]);

  const water = useMemo(() => new THREE.MeshStandardMaterial({
    color: pal.water, roughness: 0.08, metalness: 0.15, emissive: pal.water, emissiveIntensity: 0.12,
  }), [pal.water]);
  useEffect(() => () => water.dispose(), [water]);
  useFrame(({ clock }) => { water.emissiveIntensity = 0.1 + Math.sin(clock.elapsedTime * 1.3) * 0.04; });

  const lamps: Array<[number, number]> = [];
  for (const sx of [-1, 1]) {
    const start = sx > 0 ? bd.maxX + 2.2 : bd.minX - 2.2;
    for (let k = 0; k < 2; k++) for (const sz of [-1, 1]) lamps.push([start + sx * k * 2.6, sz * 1.25]);
  }

  return (
    <group>
      {stones.map((s, i) => (
        <mesh key={i} geometry={UNIT} material={mat(pal.stone, 0.9)} position={[s.x, 0.03, s.z]} rotation={[0, s.r, 0]} scale={[s.w, 0.06, 0.55]} receiveShadow />
      ))}
      {lamps.map(([x, z], i) => <Prop key={i} assets={assets} name="lampSquareFloor" p={[x, 0, z]} s={0.9} />)}
      <group position={[pond.x, 0, pond.z]}>
        <mesh material={water} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} scale={[pond.rx, pond.rz, 1]}>
          <circleGeometry args={[1, 28]} />
        </mesh>
        {Array.from({ length: 14 }, (_, i) => {
          const a = (i / 14) * Math.PI * 2;
          return (
            <mesh key={i} material={mat(pal.rock, 1, true)} position={[Math.cos(a) * (pond.rx + 0.1), 0.06, Math.sin(a) * (pond.rz + 0.1)]} scale={[0.32, 0.18, 0.28]} rotation={[0, a, 0]}>
              <dodecahedronGeometry args={[1, 0]} />
            </mesh>
          );
        })}
        {[[-0.7, 0.3], [0.5, -0.4], [0.9, 0.5]].map(([x, z], i) => (
          <mesh key={i} material={mat("#5fae5a", 0.9)} position={[x, 0.035, z]} rotation={[-Math.PI / 2, 0, i]}>
            <circleGeometry args={[0.2, 10, 0, Math.PI * 1.75]} />
          </mesh>
        ))}
        <Prop assets={assets} name="bench" p={[0, 0, pond.rz + 0.9]} r={0} />
      </group>
      {items.map((it, i) => {
        if (it.kind === "mound") {
          return (
            <mesh key={i} material={mat("#86c06a", 1, true)} position={[it.x, -0.05, it.z]} scale={[it.sx, 0.55, it.sz]} receiveShadow castShadow>
              <sphereGeometry args={[1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
            </mesh>
          );
        }
        if (it.kind === "tree") {
          return (
            <group key={i} position={[it.x, 0, it.z]} scale={it.s}>
              <mesh material={mat("#8a5a3b", 0.9)} position={[0, 0.45, 0]} castShadow>
                <cylinderGeometry args={[0.08, 0.12, 0.9, 6]} />
              </mesh>
              {it.cone ? (
                <>
                  <mesh material={mat(it.c, 0.85, true)} position={[0, 1.15, 0]} castShadow><coneGeometry args={[0.6, 1.0, 7]} /></mesh>
                  <mesh material={mat(it.c, 0.85, true)} position={[0, 1.65, 0]} castShadow><coneGeometry args={[0.45, 0.8, 7]} /></mesh>
                </>
              ) : (
                <>
                  <mesh material={mat(it.c, 0.85, true)} position={[0, 1.25, 0]} castShadow><icosahedronGeometry args={[0.62, 0]} /></mesh>
                  <mesh material={mat(mix(it.c, "#ffffff", 0.12), 0.85, true)} position={[0.25, 1.6, 0.1]} castShadow><icosahedronGeometry args={[0.38, 0]} /></mesh>
                </>
              )}
            </group>
          );
        }
        if (it.kind === "bush") {
          return (
            <mesh key={i} material={mat(it.c, 0.9, true)} position={[it.x, it.s * 0.55, it.z]} scale={[it.s * 1.3, it.s, it.s * 1.2]} castShadow>
              <icosahedronGeometry args={[1, 0]} />
            </mesh>
          );
        }
        if (it.kind === "rock") {
          return (
            <mesh key={i} material={mat(pal.rock, 1, true)} position={[it.x, it.s * 0.4, it.z]} rotation={[0, it.r, 0]} scale={[it.s * 1.3, it.s, it.s]} castShadow>
              <dodecahedronGeometry args={[1, 0]} />
            </mesh>
          );
        }
        return (
          <group key={i} position={[it.x, 0, it.z]}>
            {[[0, 0], [0.14, 0.08], [-0.1, 0.12], [0.06, -0.13], [-0.13, -0.06]].map(([x, z], k) => (
              <group key={k} position={[x, 0, z]}>
                <mesh material={mat("#5aa957", 0.9)} position={[0, 0.07, 0]}><cylinderGeometry args={[0.012, 0.012, 0.14, 4]} /></mesh>
                <mesh material={mat(it.c, 0.7)} position={[0, 0.16, 0]}><sphereGeometry args={[0.05, 6, 5]} /></mesh>
              </group>
            ))}
          </group>
        );
      })}
    </group>
  );
}

// ── Le plateau ───────────────────────────────────────────────────────────────

function OpenFloor({ layout, pal, assets }: { layout: Layout; pal: Pal; assets: LiveAssets }) {
  const { x0, x1, z0, z1, half, fixtures } = layout.hall;
  const L = x1 - x0, D = z1 - z0;
  const tex = useCanvasTexture(drawFloor("herringbone", null), [L / FLOOR_SCALE.herringbone, D / FLOOR_SCALE.herringbone], [L, D], [512, 512]);
  const floor = useMemo(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }), [tex]);
  useEffect(() => () => floor.dispose(), [floor]);
  return (
    <group>
      <mesh geometry={UNIT} material={floor} position={[(x0 + x1) / 2, 0.06, (z0 + z1) / 2]} scale={[L, 0.12, D]} receiveShadow />
      {/* Le boulevard : un long tapis d'une entrée à l'autre. */}
      <mesh geometry={UNIT} material={mat(mix(pal.runner, "#3b2a22", 0.15), 1)} position={[(x0 + x1) / 2, 0.126, 0]} scale={[L - 2.6, 0.012, half * 0.9]} receiveShadow />
      <mesh geometry={UNIT} material={mat(mix(pal.runner, "#f3e3cc", 0.55), 1)} position={[(x0 + x1) / 2, 0.128, 0]} scale={[L - 3.0, 0.012, half * 0.9 - 0.25]} receiveShadow />
      {fixtures.map((f, i) => <FixtureView key={i} f={f} assets={assets} pal={pal} />)}
      <Walls walls={layout.shell} pal={pal} />
    </group>
  );
}

/** Quelques lampes chaudes, sans ombres : le café, le salon, les coins. Plus
 *  de six lumières ponctuelles coûterait cher à chaque pixel. */
function WarmLights({ layout }: { layout: Layout }) {
  const spots = useMemo(() => {
    const out: Array<[number, number]> = [];
    for (const z of [layout.cafe, layout.lounge, ...layout.zones.filter((q) => q.kind === "nook")]) {
      if (z && out.length < 6) out.push([z.x + z.w / 2, z.z + z.d / 2]);
    }
    return out;
  }, [layout]);
  return (
    <>
      {spots.map(([x, z], i) => (
        <pointLight key={i} position={[x, PLINTH + 2.2, z]} color="#ffb977" intensity={6} distance={7} decay={1.6} />
      ))}
    </>
  );
}

// ── Une pièce ────────────────────────────────────────────────────────────────

function ZoneView({ zone, pal, assets, stateOf, colorOf }: {
  zone: Zone; pal: Pal; assets: LiveAssets;
  stateOf: Map<string, AgentState>; colorOf: Map<string, string>;
}) {
  const { w, d } = zone;
  const sc = FLOOR_SCALE[zone.floor];
  const tex = useCanvasTexture(drawFloor(zone.floor, zone.color), [w / sc, d / sc], [zone.floor, zone.color, w, d]);
  const floorMat = useMemo(() => new THREE.MeshStandardMaterial({
    map: tex, roughness: zone.floor === "wood" || zone.floor === "darkwood" ? 0.6 : zone.floor === "terrazzo" ? 0.35 : 0.9,
  }), [tex, zone.floor]);
  useEffect(() => () => floorMat.dispose(), [floorMat]);
  const inlay = zone.side === "open";
  const floorGeo = useMemo(() => inlay ? new THREE.BoxGeometry(w, 0.01, d) : new RoundedBoxGeometry(w, 0.12, d, 2, 0.04), [w, d, inlay]);
  useEffect(() => () => floorGeo.dispose(), [floorGeo]);

  return (
    <group>
      {zone.floor !== "none" && (
        // Sur le plateau, le sol d'une équipe s'incruste dans le parquet.
        <mesh geometry={floorGeo} material={floorMat} position={[zone.x + w / 2, inlay ? 0.125 : 0.06, zone.z + d / 2]} receiveShadow />
      )}
      <Walls walls={zone.walls} pal={pal} />
      {zone.fixtures.map((f, i) => (
        <FixtureView
          key={i} f={f} assets={assets} pal={pal} accent={zone.color}
          state={f.seat?.agentId ? stateOf.get(f.seat.agentId) ?? "idle" : null}
          color={f.seat?.agentId ? colorOf.get(f.seat.agentId) ?? zone.color ?? "#9aa3b2" : zone.color ?? "#9aa3b2"}
          decorSeed={`${zone.key}:${i}`}
        />
      ))}
      {zone.kind === "memory" && zone.core && <Silo zone={zone} />}
    </group>
  );
}

/** Le nom de l'équipe, peint en grand sur son mur. */
function useWallText(text: string, color: string) {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 256;
    const ctx = c.getContext("2d")!;
    const dark = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }).l > 0.62;
    ctx.fillStyle = dark ? "rgba(30, 30, 40, 0.92)" : "rgba(255, 252, 245, 0.96)";
    let size = 150;
    ctx.font = `800 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
    while (ctx.measureText(text).width > 960 && size > 40) { size -= 6; ctx.font = `800 ${size}px Inter, "Segoe UI", system-ui, sans-serif`; }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 512, 132);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [text, color]);
}

/** Des murs, et la coupe de maison de poupée : ceux qui se dressent entre
 *  la caméra et ce qu'ils bordent descendent à hauteur de plinthe. */
function Walls({ walls, pal }: { walls: WallSeg[]; pal: Pal }) {
  const refs = useRef<Array<THREE.Group | null>>([]);
  const glassMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: pal.glass, emissive: pal.glass, emissiveIntensity: 0.25, roughness: 0.1, metalness: 0.05,
  }), [pal.glass]);
  useEffect(() => () => glassMat.dispose(), [glassMat]);
  const dir = useMemo(() => new THREE.Vector2(), []);

  useFrame(({ camera }, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    walls.forEach((wl, i) => {
      const g = refs.current[i];
      if (!g) return;
      // Seuls les murs pleins se coupent ; vitres et cloisons basses laissent voir.
      if (wl.kind !== "solid" && wl.kind !== "feature") return;
      dir.set(camera.position.x - (wl.x1 + wl.x2) / 2, camera.position.z - (wl.z1 + wl.z2) / 2).normalize();
      const facingCam = wl.nx * dir.x + wl.nz * dir.y;
      const goal = facingCam > 0.2 ? 0.12 : 1;
      g.scale.y += (goal - g.scale.y) * Math.min(1, dt * 7);
      for (const c of g.children[0]?.children ?? []) if (c.userData.mounted) c.visible = g.scale.y > 0.7;
    });
  });

  return (
    <>
      {walls.map((wl, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el; }} position={[(wl.x1 + wl.x2) / 2, 0, (wl.z1 + wl.z2) / 2]}>
          <WallBody wl={wl} pal={pal} glassMat={glassMat} />
        </group>
      ))}
    </>
  );
}

const ART_PROP: Partial<Record<WallArt["kind"], PropName>> = {
  frameA: "pictureframe_large_A", frameB: "pictureframe_large_B", frameM: "pictureframe_medium",
  frameS: "pictureframe_small_A", frameS2: "pictureframe_small_B", shelf: "shelf_B_small_decorated",
  upper: "kitchenCabinetUpper",
};

/** Ce qui est accroché au mur, côté intérieur : cadres, étagère, tableau,
 *  écran, horloge. Monté sur le mur, il disparaît avec lui quand il se coupe. */
function MountedArt({ a, x, T, assets }: { a: WallArt; x: number; T: number; assets: LiveAssets | null }) {
  const prop = ART_PROP[a.kind];
  // Le côté intérieur du mur est en −z local ; l'objet regarde vers −z.
  const z = -T / 2;
  if (prop && assets) {
    const kenney = !KAYKIT_SET.has(prop);
    return (
      <group userData={{ mounted: true }} position={[x, a.y, z]} rotation={[0, Math.PI, 0]}>
        <Prop assets={assets} name={prop} p={[0, kenney ? -0.4 : -0.42, kenney ? 0.24 : 0.07]} r={kenney ? Math.PI : 0} />
      </group>
    );
  }
  const f: Fixture = { kind: a.kind, x: 0, z: 0, rot: 0 };
  return (
    <group userData={{ mounted: true }} position={[x, a.y, z - 0.035]} rotation={[0, Math.PI, 0]}>
      {a.kind === "screen" ? <BigScreen f={f} accent={null} mounted />
        : a.kind === "whiteboard" ? <WallBoard />
        : a.kind === "pinboard" ? <Pinboard f={{ ...f, y: 0 }} accent={null} mounted />
        : <WallClock />}
    </group>
  );
}

const AssetsCtx = createContext<LiveAssets | null>(null);

function WallBody({ wl, pal, glassMat }: { wl: WallSeg; pal: Pal; glassMat: THREE.Material }) {
  const assets = useContext(AssetsCtx);
  const len = Math.hypot(wl.x2 - wl.x1, wl.z2 - wl.z1);
  // Le repère du mur : x le long du mur, z vers l'extérieur.
  const rotY = Math.atan2(wl.nx, wl.nz);
  const T = 0.16, H = wl.height;
  // Le repère local x pointe vers (cos rotY, −sin rotY) : un point du mur à
  // la fraction t s'y projette ainsi.
  const artX = (t: number) => {
    const px = wl.x1 + (wl.x2 - wl.x1) * t - (wl.x1 + wl.x2) / 2;
    const pz = wl.z1 + (wl.z2 - wl.z1) * t - (wl.z1 + wl.z2) / 2;
    return px * Math.cos(rotY) - pz * Math.sin(rotY);
  };
  const text = useWallText(wl.text ?? "", wl.color ?? "#cccccc");
  useEffect(() => () => text.dispose(), [text]);

  const windows = Array.from({ length: wl.windows }, (_, k) => ((k + 1) / (wl.windows + 1) - 0.5) * len);
  const wallColor = wl.kind === "feature" ? mix(wl.color ?? "#cccccc", "#ffffff", 0.08)
    : wl.color ? mix(wl.color, "#f1e9de", 0.12) : pal.wall;
  const textW = Math.min(len * 0.8, 5.2);
  return (
    <group rotation={[0, rotY, 0]}>
      {wl.kind === "solid" || wl.kind === "feature" ? (
        <>
          <mesh geometry={UNIT} material={mat(wallColor, 0.92)}
            position={[0, H / 2, 0]} scale={[len, H, T]} castShadow receiveShadow />
          {/* Une plinthe claire au pied, un chant au sommet : le mur a de l'épaisseur. */}
          <mesh geometry={UNIT} material={mat(mix(wallColor, "#ffffff", 0.55), 0.6)} position={[0, 0.06, -T / 2 - 0.01]} scale={[len, 0.12, 0.02]} />
          <mesh geometry={UNIT} material={mat(wl.kind === "feature" ? mix(wl.color ?? "#cccccc", "#000000", 0.2) : pal.wallCap, 0.7)}
            position={[0, H + 0.02, 0]} scale={[len + 0.01, 0.04, T + 0.03]} />
          {wl.kind === "feature" && wl.text && (
            // Le nom, en bandeau en haut du mur, côté intérieur.
            <mesh userData={{ mounted: true }} position={[0, H - 0.34, -T / 2 - 0.006]} rotation={[0, Math.PI, 0]}>
              <planeGeometry args={[textW, textW / 4]} />
              <meshBasicMaterial map={text} transparent toneMapped={false} />
            </mesh>
          )}
          {wl.art?.map((a, k) => <MountedArt key={k} a={a} x={artX(a.t)} T={T} assets={assets} />)}
          {windows.map((o, k) => (
            <group key={k} userData={{ mounted: true }} position={[o, 1.1, 0]}>
              <mesh geometry={UNIT} material={mat(pal.frame, 0.5)} scale={[1.1, 0.95, T + 0.04]} />
              <mesh geometry={UNIT} material={glassMat} scale={[0.96, 0.82, T + 0.06]} />
            </group>
          ))}
        </>
      ) : wl.kind === "glass" || wl.kind === "partition" ? (
        <>
          <mesh geometry={UNIT} material={GLASS} position={[0, H / 2, 0]} scale={[len, H - 0.08, 0.04]} />
          <mesh geometry={UNIT} material={mat("#c9ced8", 0.35)} position={[0, H - 0.02, 0]} scale={[len, 0.05, 0.07]} />
          <mesh geometry={UNIT} material={mat("#c9ced8", 0.35)} position={[0, 0.05, 0]} scale={[len, 0.1, 0.07]} />
          {range(Math.max(2, Math.round(len / 1.6) + 1)).map((k, _i, arr) => (
            <mesh key={k} geometry={UNIT} material={mat("#c9ced8", 0.35)} position={[-len / 2 + (k * len) / (arr.length - 1), H / 2, 0]} scale={[0.05, H, 0.07]} />
          ))}
        </>
      ) : wl.kind === "planter" ? (
        <>
          <mesh geometry={UNIT} material={mat("#b0703f", 0.8)} position={[0, 0.28, 0]} scale={[len, 0.56, 0.42]} castShadow receiveShadow />
          <mesh geometry={UNIT} material={mat("#5a4030", 1)} position={[0, 0.565, 0]} scale={[len - 0.06, 0.02, 0.36]} />
          {range(Math.max(2, Math.round(len / 0.55))).map((k, _i, arr) => (
            <mesh key={k} material={mat(LEAVES[k % LEAVES.length], 0.9, true)} position={[-len / 2 + 0.28 + (k * (len - 0.56)) / Math.max(1, arr.length - 1), 0.78, 0]} scale={[0.32, 0.36, 0.3]} castShadow>
              <icosahedronGeometry args={[1, 0]} />
            </mesh>
          ))}
        </>
      ) : wl.kind === "slats" ? (
        <>
          {range(Math.max(3, Math.round(len / 0.16))).map((k, _i, arr) => (
            <mesh key={k} geometry={UNIT} material={mat(k % 2 ? "#c99a6a" : "#b88a5c", 0.75)} position={[-len / 2 + 0.04 + (k * (len - 0.08)) / (arr.length - 1), H / 2, 0]} scale={[0.06, H, 0.06]} castShadow />
          ))}
          <mesh geometry={UNIT} material={mat("#8f6a45", 0.75)} position={[0, H, 0]} scale={[len, 0.04, 0.1]} />
        </>
      ) : (
        // Une étagère basse, garnie de livres : la séparation qui sert.
        <>
          <mesh geometry={UNIT} material={mat("#d9c3a2", 0.75)} position={[0, H / 2, 0]} scale={[len, H, 0.36]} castShadow receiveShadow />
          {[0.35, 0.8].map((y) => (
            <group key={y}>
              {Array.from({ length: Math.round(len / 0.12) }, (_, k) => k).filter((k) => (k * 7) % 5 !== 0).map((k) => (
                <mesh key={k} geometry={UNIT} material={mat(["#c0392b", "#2f6fb5", "#e3b23c", "#3f8f5a", "#7b5ea7"][k % 5], 0.8)}
                  position={[-len / 2 + 0.08 + k * 0.12, y + 0.14, 0.19]} scale={[0.09, 0.26 + ((k * 13) % 7) * 0.012, 0.04]} />
              ))}
            </group>
          ))}
        </>
      )}
    </group>
  );
}

// ── Le mobilier ──────────────────────────────────────────────────────────────

const DESK_DECOR: Array<PropName | null> = ["plantSmall1", "lampSquareTable", "plantSmall2", "books", "cactus_small_A", null, "plantSmall3", null];

/** L'écran d'un poste : il dit ce que fait son agent — à sa couleur quand il
 *  travaille, rouge sur un échec, ambre quand il vous attend, éteint au repos. */
function useScreen(state: AgentState | null, color: string, pal: Pal, seed: string) {
  const screen = useMemo(() => new THREE.MeshBasicMaterial({ color: pal.screenOff, toneMapped: false }), [pal.screenOff]);
  useEffect(() => () => screen.dispose(), [screen]);
  const base = useMemo(() => new THREE.Color(), []);
  const off = useMemo(() => new THREE.Color(pal.screenOff), [pal.screenOff]);
  const phase = useMemo(() => (hash(seed) % 1000) / 160, [seed]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    if (state === "working") {
      base.set(mix(color, "#ffffff", 0.35));
      screen.color.copy(off).lerp(base, 0.8 + 0.12 * Math.sin(t * 6.1) + 0.08 * Math.sin(t * 15.3));
    } else if (state === "error") {
      base.set("#ff5a5f");
      screen.color.copy(off).lerp(base, Math.sin(t * 4) > 0 ? 0.95 : 0.45);
    } else if (state === "waiting") {
      base.set("#ffb547");
      screen.color.copy(off).lerp(base, 0.7 + 0.2 * Math.sin(t * 3));
    } else {
      screen.color.copy(off);
    }
  });
  return screen;
}

function FixtureView({ f, assets, pal, accent = null, state = null, color = "#9aa3b2", decorSeed = "" }: {
  f: Fixture; assets: LiveAssets; pal: Pal; accent?: string | null;
  state?: AgentState | null; color?: string; decorSeed?: string;
}) {
  const y = FLOOR_Y;
  switch (f.kind) {
    case "workstation": return <Workstation f={f} assets={assets} pal={pal} state={state} color={color} decorSeed={decorSeed} />;
    case "benchSeat": return <LaptopSeat f={f} assets={assets} pal={pal} state={state} color={color} chair="chairCushion" />;
    case "roundSeat": return <LaptopSeat f={f} assets={assets} pal={pal} state={state} color={color} chair="chairRounded" />;
    case "benchTable": return <BenchTable f={f} accent={accent} pal={pal} assets={assets} />;
    case "roundTable": return <Prop assets={assets} name="tableRound" p={[f.x, y, f.z]} r={f.rot} />;
    case "meetingTable": return <MeetingTable f={f} />;
    case "whiteboard": return <Whiteboard f={f} accent={accent} />;
    case "pinboard": return <Pinboard f={f} accent={accent} />;
    case "bigScreen": return <BigScreen f={f} accent={accent} />;
    case "booth": return <Booth f={f} assets={assets} />;
    case "skillCabinet": return <SkillCabinet f={f} />;
    case "rug": return <Rug f={f} />;
    case "rugDisc": return <Rug f={f} round />;
    case "planterBox": case "planterBig": return <Planter f={f} big={f.kind === "planterBig"} />;
    case "pottedPlant": return <PotPlant f={f} />;
    case "pouf": return <Pouf f={f} />;
    case "pingpong": return <PingPong f={f} />;
    case "serverRack": return <ServerRack f={f} />;
    case "hvac": return <Hvac f={f} pal={pal} />;
    case "pipes": return <Pipes f={f} pal={pal} />;
    case "electricPanel": return <ElectricPanel f={f} />;
    default:
      if (!assets.props.has(f.kind as PropName)) return null;
      return <Prop assets={assets} name={f.kind as PropName} p={[f.x, y + (f.y ?? 0), f.z]} r={facing(f.kind, f.rot)} s={f.s ?? 1} />;
  }
}

/** Un poste : bureau, écran (ou deux), clavier, chaise, un objet à soi. */
function Workstation({ f, assets, pal, state, color, decorSeed }: {
  f: Fixture; assets: LiveAssets; pal: Pal; state: AgentState | null; color: string; decorSeed: string;
}) {
  const screen = useScreen(state, color, pal, decorSeed);
  const decor = DESK_DECOR[hash(decorSeed) % DESK_DECOR.length];
  const dual = f.variant === "dual";
  // Repère local : l'agent s'assied en +z et regarde vers −z, comme le veut
  // le mobilier de Kenney. Le poste est tourné pour regarder la chaise.
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot + Math.PI, 0]}>
      <Prop assets={assets} name="desk" p={[0, 0, 0]} />
      {(dual ? [-0.36, 0.36] : [0]).map((x, k) => (
        <group key={k} position={[x, 0.79, -0.14]} rotation={[0, Math.PI + (dual ? (k ? -0.25 : 0.25) : 0), 0]}>
          <Prop assets={assets} name="computerScreen" p={[0, 0, 0]} s={dual ? 0.85 : 1} />
          <mesh position={[0, dual ? 0.31 : 0.36, -0.035]} rotation={[0, Math.PI, 0]} material={screen}>
            <planeGeometry args={dual ? [0.6, 0.34] : [0.7, 0.4]} />
          </mesh>
        </group>
      ))}
      <Prop assets={assets} name="computerKeyboard" p={[0, 0.79, 0.16]} />
      <Prop assets={assets} name="computerMouse" p={[0.42, 0.79, 0.18]} />
      {decor && !dual && <Prop assets={assets} name={decor} p={[-0.55, 0.79, -0.18]} r={0.4} />}
      <Prop assets={assets} name="chairDesk" p={[0, 0, 0.8]} />
    </group>
  );
}

/** Une place à une table partagée : une chaise, et un portable ouvert devant. */
function LaptopSeat({ f, assets, pal, state, color, chair }: {
  f: Fixture; assets: LiveAssets; pal: Pal; state: AgentState | null; color: string; chair: PropName;
}) {
  const screen = useScreen(state, color, pal, `${f.x}:${f.z}`);
  const s = f.seat;
  const tableY = f.kind === "roundSeat" ? 0.75 : 0.74;
  return (
    <group>
      <group position={[f.x, FLOOR_Y + tableY, f.z]} rotation={[0, f.rot, 0]}>
        <Prop assets={assets} name="laptop" p={[0, 0, 0]} s={0.85} />
        <mesh position={[0, 0.16, -0.17]} rotation={[-0.3, Math.PI, 0]} material={screen}>
          <planeGeometry args={[0.36, 0.22]} />
        </mesh>
      </group>
      {s && <Prop assets={assets} name={chair} p={[s.x, FLOOR_Y, s.z]} r={s.facing + Math.PI} />}
    </group>
  );
}

function BenchTable({ f, accent, assets }: { f: Fixture; accent: string | null; pal: Pal; assets: LiveAssets }) {
  const len = f.len ?? 3;
  const top = mat("#d8b98f", 0.55);
  const legs = mat("#2f3138", 0.4);
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={top} position={[0, 0.72, 0]} scale={[len, 0.05, 0.95]} castShadow receiveShadow />
      {/* La bande centrale, à la couleur de l'équipe, avec ses jardinières. */}
      <mesh geometry={UNIT} material={mat(accent ? mix(accent, "#ffffff", 0.2) : "#9aa3b2", 0.6)} position={[0, 0.76, 0]} scale={[len - 0.2, 0.04, 0.16]} />
      {range(Math.max(1, Math.floor(len / 2.2))).map((k, _i, arr) => (
        <Prop key={k} assets={assets} name="plantSmall2" p={[-len / 2 + (len / (arr.length + 1)) * (k + 1), 0.78, 0]} />
      ))}
      {[-1, 1].map((sx) => (
        <group key={sx} position={[sx * (len / 2 - 0.12), 0, 0]}>
          <mesh geometry={UNIT} material={legs} position={[0, 0.36, 0]} scale={[0.06, 0.72, 0.8]} castShadow />
        </group>
      ))}
    </group>
  );
}

function MeetingTable({ f }: { f: Fixture }) {
  const len = f.len ?? 3.4;
  const geo = useMemo(() => new RoundedBoxGeometry(len, 0.06, 1.3, 3, 0.03), [len]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={geo} material={mat("#6e4f3a", 0.45)} position={[0, 0.74, 0]} castShadow receiveShadow />
      {[-len / 3, len / 3].map((x) => (
        <mesh key={x} geometry={UNIT} material={mat("#2f3138", 0.4)} position={[x, 0.36, 0]} scale={[0.12, 0.72, 0.7]} castShadow />
      ))}
      <mesh material={mat("#d7dbe3", 0.3)} position={[0, 0.79, 0]}><cylinderGeometry args={[0.12, 0.14, 0.04, 20]} /></mesh>
      {[-0.9, 0.2, 1.1].map((x, k) => (
        <mesh key={x} geometry={UNIT} material={mat(["#f4f1ea", "#e3b23c", "#f4f1ea"][k], 0.8)} position={[x, 0.775, (k - 1) * 0.25]} rotation={[0, k * 0.4, 0]} scale={[0.3, 0.01, 0.21]} />
      ))}
    </group>
  );
}

function Whiteboard({ f, accent }: { f: Fixture; accent: string | null }) {
  const ink = ["#2f6fb5", "#c0392b", accent ?? "#3f8f5a"];
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#c9ced8", 0.35)} position={[0, 1.05, 0]} scale={[1.7, 1.0, 0.05]} castShadow />
      <mesh geometry={UNIT} material={mat("#fbfbfd", 0.25)} position={[0, 1.05, 0.03]} scale={[1.6, 0.9, 0.01]} />
      {[[-0.45, 1.25, 0.6], [-0.2, 1.08, 0.9], [0.35, 1.2, 0.5], [0.1, 0.9, 1.1], [0.5, 0.95, 0.35]].map(([x, yy, w], k) => (
        <mesh key={k} geometry={UNIT} material={mat(ink[k % ink.length], 0.6)} position={[x, yy, 0.04]} rotation={[0, 0, (k % 2 ? 0.08 : -0.05)]} scale={[w * 0.6, 0.025, 0.005]} />
      ))}
      {[-0.7, 0.7].map((x) => (
        <mesh key={x} geometry={UNIT} material={mat("#9aa3b2", 0.4)} position={[x, 0.3, 0]} scale={[0.04, 0.6, 0.04]} />
      ))}
    </group>
  );
}

function Pinboard({ f, accent, mounted }: { f: Fixture; accent: string | null; mounted?: boolean }) {
  const notes = useMemo(() => {
    const r = seeded(hash(`${f.x}:${f.z}`));
    const cs = ["#f7d24a", "#f29bb5", "#9fd3f0", accent ? mix(accent, "#ffffff", 0.4) : "#b9a4f0"];
    return Array.from({ length: 9 }, () => ({ x: (r() - 0.5) * 1.6, y: (r() - 0.5) * 0.55, c: cs[Math.floor(r() * cs.length)], a: (r() - 0.5) * 0.3 }));
  }, [f.x, f.z, accent]);
  return (
    <group position={mounted ? [0, 0, 0] : [f.x, FLOOR_Y + 1.05, f.z]} rotation={[0, mounted ? 0 : f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#c4975e", 0.9)} scale={[2.0, 0.8, 0.03]} />
      {notes.map((n, k) => (
        <mesh key={k} geometry={UNIT} material={mat(n.c, 0.8)} position={[n.x, n.y, 0.02]} rotation={[0, 0, n.a]} scale={[0.17, 0.17, 0.005]} />
      ))}
    </group>
  );
}

/** Le grand écran mural : des courbes qui avancent, comme un tableau de bord. */
function BigScreen({ f, accent, mounted }: { f: Fixture; accent: string | null; mounted?: boolean }) {
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 288;
    return { c, t: new THREE.CanvasTexture(c) };
  }, []);
  useEffect(() => { tex.t.colorSpace = THREE.SRGBColorSpace; return () => tex.t.dispose(); }, [tex]);
  const tick = useRef(0);
  useFrame(({ clock }) => {
    if (clock.elapsedTime - tick.current < 0.5) return;
    tick.current = clock.elapsedTime;
    const ctx = tex.c.getContext("2d")!;
    const t = clock.elapsedTime;
    ctx.fillStyle = "#121722"; ctx.fillRect(0, 0, 512, 288);
    const col = accent ?? "#8b7bd8";
    for (let k = 0; k < 6; k++) {
      const h = 40 + 60 * (0.5 + 0.5 * Math.sin(t * 0.7 + k * 1.3));
      ctx.fillStyle = k % 2 ? col : "#4fd1c5";
      ctx.fillRect(30 + k * 40, 250 - h, 26, h);
    }
    ctx.strokeStyle = "#f6ad55"; ctx.lineWidth = 3; ctx.beginPath();
    for (let x = 0; x <= 200; x += 8) {
      const yy = 140 + Math.sin(x * 0.05 + t) * 40 + Math.sin(x * 0.13 + t * 1.7) * 15;
      if (x === 0) ctx.moveTo(290 + x, yy); else ctx.lineTo(290 + x, yy);
    }
    ctx.stroke();
    ctx.fillStyle = "#e2e8f0"; ctx.font = "600 22px sans-serif"; ctx.fillText("LIVE", 30, 40);
    tex.t.needsUpdate = true;
  });
  return (
    <group position={mounted ? [0, 0, 0] : [f.x, FLOOR_Y + 1.15, f.z]} rotation={[0, mounted ? 0 : f.rot, 0]} scale={mounted ? 0.82 : 1}>
      <mesh geometry={UNIT} material={mat("#1b1d24", 0.3)} scale={[2.3, 1.35, 0.06]} castShadow />
      <mesh position={[0, 0, 0.035]}>
        <planeGeometry args={[2.18, 1.23]} />
        <meshBasicMaterial map={tex.t} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Un tapis à la mesure : un bord tissé plus sombre, un champ plus clair. */
function Rug({ f, round }: { f: Fixture; round?: boolean }) {
  const c = f.color ?? "#c98b6b";
  const len = f.len ?? 2, depth = f.depth ?? len;
  if (round) {
    return (
      <group position={[f.x, FLOOR_Y + 0.006, f.z]}>
        <mesh material={mat(mix(c, "#2a2018", 0.25), 1)} receiveShadow><cylinderGeometry args={[len / 2, len / 2, 0.012, 40]} /></mesh>
        <mesh material={mat(c, 1)} position={[0, 0.004, 0]} receiveShadow><cylinderGeometry args={[len / 2 - 0.14, len / 2 - 0.14, 0.012, 40]} /></mesh>
        <mesh material={mat(mix(c, "#ffffff", 0.35), 1)} position={[0, 0.007, 0]} receiveShadow><cylinderGeometry args={[len / 4, len / 4, 0.012, 32]} /></mesh>
      </group>
    );
  }
  return (
    <group position={[f.x, FLOOR_Y + 0.006, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat(mix(c, "#2a2018", 0.25), 1)} scale={[len, 0.012, depth]} receiveShadow />
      <mesh geometry={UNIT} material={mat(c, 1)} position={[0, 0.004, 0]} scale={[len - 0.24, 0.012, depth - 0.24]} receiveShadow />
      <mesh geometry={UNIT} material={mat(mix(c, "#ffffff", 0.3), 1)} position={[0, 0.007, 0]} scale={[len - 0.6, 0.012, 0.06]} receiveShadow />
    </group>
  );
}

/** Une plante de bureau dans son pot de terre cuite : de grandes feuilles
 *  qui retombent, chacune un peu différente. */
function PotPlant({ f }: { f: Fixture }) {
  const leaves = useMemo(() => {
    const r = seeded(hash(`${f.x.toFixed(2)}:${f.z.toFixed(2)}`));
    const n = 7 + Math.floor(r() * 4);
    return Array.from({ length: n }, (_, i) => ({
      a: (i / n) * Math.PI * 2 + r() * 0.5,
      tilt: 0.35 + r() * 0.55,
      h: 0.55 + r() * 0.5,
      s: 0.75 + r() * 0.45,
      c: LEAVES[Math.floor(r() * LEAVES.length)],
    }));
  }, [f.x, f.z]);
  const s = f.s ?? 1;
  return (
    <group position={[f.x, FLOOR_Y + (f.y ?? 0), f.z]} scale={s}>
      <mesh material={mat("#c4693f", 0.85)} position={[0, 0.2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.2, 0.15, 0.4, 20]} />
      </mesh>
      <mesh material={mat("#a9572f", 0.85)} position={[0, 0.41, 0]}><cylinderGeometry args={[0.215, 0.215, 0.04, 20]} /></mesh>
      <mesh material={mat("#4a3426", 1)} position={[0, 0.42, 0]}><cylinderGeometry args={[0.19, 0.19, 0.02, 16]} /></mesh>
      {leaves.map((l, i) => (
        <group key={i} position={[0, 0.42, 0]} rotation={[0, l.a, 0]}>
          <mesh material={mat("#4f7a3a", 0.9)} position={[0, l.h / 2, 0.05]} rotation={[l.tilt * 0.5, 0, 0]}>
            <cylinderGeometry args={[0.008, 0.012, l.h, 4]} />
          </mesh>
          <mesh material={mat(l.c, 0.75, true)} position={[0, l.h, l.tilt * 0.32]} rotation={[l.tilt + 0.5, 0, 0]} scale={[0.17 * l.s, 0.025, 0.3 * l.s]} castShadow>
            <sphereGeometry args={[1, 8, 6]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Une jardinière à la mesure, garnie. */
function Planter({ f, big }: { f: Fixture; big?: boolean }) {
  const len = f.len ?? 1.6, depth = f.depth ?? 0.45;
  const bushes = useMemo(() => {
    const r = seeded(hash(`${f.x}:${f.z}:p`));
    const n = Math.max(2, Math.round((len * depth) / (big ? 0.25 : 0.12)));
    return Array.from({ length: n }, () => ({
      x: (r() - 0.5) * (len - 0.3), z: (r() - 0.5) * (depth - 0.2),
      s: (big ? 0.28 : 0.18) + r() * (big ? 0.3 : 0.12), c: LEAVES[Math.floor(r() * LEAVES.length)],
      tree: big && r() < 0.3,
    }));
  }, [f.x, f.z, len, depth, big]);
  const H = big ? 0.42 : 0.55;
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#a8774f", 0.75)} position={[0, H / 2, 0]} scale={[len, H, depth]} castShadow receiveShadow />
      <mesh geometry={UNIT} material={mat("#4a3426", 1)} position={[0, H + 0.005, 0]} scale={[len - 0.08, 0.01, depth - 0.08]} />
      {bushes.map((b, i) => (
        <group key={i} position={[b.x, H, b.z]}>
          {b.tree && (
            <mesh material={mat("#7a5236", 0.9)} position={[0, 0.45, 0]}><cylinderGeometry args={[0.03, 0.04, 0.9, 6]} /></mesh>
          )}
          <mesh material={mat(b.c, 0.85, true)} position={[0, b.tree ? 1.0 : b.s * 0.6, 0]} scale={b.tree ? [0.45, 0.5, 0.45] : [b.s * 1.2, b.s, b.s * 1.1]} castShadow>
            <icosahedronGeometry args={[1, 0]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Un pouf rond, en cuir coloré. */
function Pouf({ f }: { f: Fixture }) {
  const c = f.color ?? "#e39b3b";
  const hex = f.variant === "hex";
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh material={mat(c, 0.7)} position={[0, 0.21, 0]} castShadow receiveShadow>
        <cylinderGeometry args={hex ? [0.42, 0.42, 0.42, 6] : [0.26, 0.24, 0.42, 24]} />
      </mesh>
      <mesh material={mat(mix(c, "#2a2018", 0.35), 0.7)} position={[0, 0.425, 0]}>
        <cylinderGeometry args={hex ? [0.4, 0.42, 0.02, 6] : [0.25, 0.26, 0.02, 24]} />
      </mesh>
    </group>
  );
}

/** Une table de ping-pong : plateau bleu, lignes blanches, filet. */
function PingPong({ f }: { f: Fixture }) {
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#2f6f9f", 0.45)} position={[0, 0.74, 0]} scale={[1.5, 0.04, 2.6]} castShadow receiveShadow />
      <mesh geometry={UNIT} material={mat("#ffffff", 0.5)} position={[0, 0.762, 0]} scale={[0.02, 0.004, 2.56]} />
      <mesh geometry={UNIT} material={mat("#ffffff", 0.5)} position={[0, 0.762, 1.28]} scale={[1.46, 0.004, 0.03]} />
      <mesh geometry={UNIT} material={mat("#ffffff", 0.5)} position={[0, 0.762, -1.28]} scale={[1.46, 0.004, 0.03]} />
      <mesh geometry={UNIT} material={mat("#f4f4f4", 0.9)} position={[0, 0.83, 0]} scale={[1.6, 0.14, 0.01]} />
      {[[-0.6, -1.0], [0.6, -1.0], [-0.6, 1.0], [0.6, 1.0]].map(([x, z], i) => (
        <mesh key={i} geometry={UNIT} material={mat("#2b2e38", 0.4)} position={[x, 0.36, z]} scale={[0.06, 0.72, 0.06]} castShadow />
      ))}
      <mesh material={mat("#c0392b", 0.5)} position={[0.3, 0.775, 0.7]} rotation={[0, 0, 0]}><cylinderGeometry args={[0.08, 0.08, 0.015, 16]} /></mesh>
      <mesh material={mat("#ffffff", 0.3)} position={[-0.2, 0.79, -0.3]}><sphereGeometry args={[0.025, 10, 8]} /></mesh>
    </group>
  );
}

/** Le tableau blanc accroché au mur. */
function WallBoard() {
  const ink = ["#2f6fb5", "#c0392b", "#3f8f5a"];
  return (
    <group>
      <mesh geometry={UNIT} material={mat("#c9ced8", 0.35)} scale={[1.7, 0.95, 0.04]} castShadow />
      <mesh geometry={UNIT} material={mat("#fbfbfd", 0.25)} position={[0, 0, 0.025]} scale={[1.6, 0.85, 0.01]} />
      {[[-0.45, 0.2, 0.6], [-0.2, 0.03, 0.9], [0.35, 0.15, 0.5], [0.1, -0.15, 1.1], [0.5, -0.1, 0.35]].map(([x, yy, w], k) => (
        <mesh key={k} geometry={UNIT} material={mat(ink[k % ink.length], 0.6)} position={[x, yy, 0.032]} rotation={[0, 0, k % 2 ? 0.08 : -0.05]} scale={[w * 0.6, 0.025, 0.005]} />
      ))}
      <mesh geometry={UNIT} material={mat("#9aa3b2", 0.4)} position={[0, -0.5, 0.05]} scale={[1.2, 0.03, 0.08]} />
    </group>
  );
}

/** L'horloge : son aiguille des minutes tourne pour de vrai. */
function WallClock() {
  const hand = useRef<THREE.Mesh>(null);
  const small = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const d = new Date();
    const m = (d.getMinutes() + d.getSeconds() / 60) / 60, h = ((d.getHours() % 12) + m) / 12;
    if (hand.current) hand.current.rotation.z = -m * Math.PI * 2;
    if (small.current) small.current.rotation.z = -h * Math.PI * 2;
  });
  return (
    <group>
      <mesh material={mat("#2b2e38", 0.4)} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.22, 0.22, 0.04, 32]} /></mesh>
      <mesh material={mat("#fbf7f0", 0.4)} position={[0, 0, 0.022]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.19, 0.19, 0.01, 32]} /></mesh>
      <mesh ref={hand} position={[0, 0, 0.03]}><boxGeometry args={[0.012, 0.3, 0.005]} /><meshBasicMaterial color="#2b2e38" /></mesh>
      <mesh ref={small} position={[0, 0, 0.033]}><boxGeometry args={[0.018, 0.2, 0.005]} /><meshBasicMaterial color="#c0392b" /></mesh>
    </group>
  );
}

/** Un box de travail : une cabine, paroi de feutre à la couleur, vitres sur
 *  les côtés, une tablette et une chaise. On y entre par l'avant. */
function Booth({ f, assets }: { f: Fixture; assets: LiveAssets }) {
  const felt = mat(f.color ?? "#7aa6d8", 1);
  const frame = mat("#2f3138", 0.4);
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={felt} position={[0, 1.05, -0.78]} scale={[1.7, 2.1, 0.06]} castShadow receiveShadow />
      {[-1, 1].map((sx) => (
        <group key={sx}>
          <mesh geometry={UNIT} material={GLASS} position={[sx * 0.82, 1.05, 0]} scale={[0.03, 2.0, 1.55]} />
          <mesh geometry={UNIT} material={frame} position={[sx * 0.82, 2.1, 0]} scale={[0.06, 0.06, 1.6]} />
          <mesh geometry={UNIT} material={frame} position={[sx * 0.82, 1.05, 0.78]} scale={[0.06, 2.1, 0.06]} />
        </group>
      ))}
      <mesh geometry={UNIT} material={felt} position={[0, 2.12, 0]} scale={[1.7, 0.06, 1.6]} castShadow />
      <mesh geometry={UNIT} material={mat("#d8b98f", 0.55)} position={[0, 0.74, -0.52]} scale={[1.3, 0.05, 0.45]} castShadow />
      <Prop assets={assets} name="laptop" p={[0, 0.765, -0.5]} r={0} s={0.8} />
      <Prop assets={assets} name="lampRoundTable" p={[0.5, 0.765, -0.6]} s={0.8} />
      <Prop assets={assets} name="chair" p={[0, 0, 0.35]} r={Math.PI + Math.PI} />
    </group>
  );
}

function ServerRack({ f }: { f: Fixture }) {
  const leds = useContext(LedCtx);
  const r = hash(`${f.x}`) % 4;
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#2b2e38", 0.5)} position={[0, 0.95, 0]} scale={[0.68, 1.9, 0.6]} castShadow receiveShadow />
      <mesh geometry={UNIT} material={mat("#3a3e4b", 0.4)} position={[0, 0.95, 0.305]} scale={[0.6, 1.8, 0.01]} />
      {Array.from({ length: 9 }, (_, k) => (
        <group key={k} position={[0, 0.25 + k * 0.19, 0.315]}>
          <mesh geometry={UNIT} material={mat("#1c1e25", 0.6)} scale={[0.54, 0.13, 0.01]} />
          {[0, 1, 2].map((j) => leds[(k + j + r) % Math.max(1, leds.length)] && (
            <mesh key={j} geometry={UNIT} material={leds[(k + j + r) % leds.length]} position={[0.16 + j * 0.05, 0, 0.008]} scale={[0.025, 0.025, 0.01]} />
          ))}
        </group>
      ))}
    </group>
  );
}

function Hvac({ f, pal }: { f: Fixture; pal: Pal }) {
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#e6e8ee", 0.5)} position={[0, 0.65, 0]} scale={[1.1, 1.3, 0.7]} castShadow receiveShadow />
      <mesh material={mat("#2b2e38", 0.4)} position={[0, 0.8, 0.36]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.32, 0.32, 0.03, 24]} /></mesh>
      <mesh material={mat(pal.metal, 0.35)} position={[0, 0.8, 0.38]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.32, 0.03, 8, 24]} /></mesh>
    </group>
  );
}

function Pipes({ f, pal }: { f: Fixture; pal: Pal }) {
  const len = f.len ?? 6;
  const copper = mat("#c98a5a", 0.35), steel = mat(pal.metal, 0.35);
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      {[0, 0.18].map((dx, i) => (
        <mesh key={i} material={i ? steel : copper} position={[dx - 0.09, 1.25 - i * 0.18, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.06, 0.06, len, 12]} />
        </mesh>
      ))}
      {[-len / 2 + 1, len / 2 - 1].map((z, i) => (
        <mesh key={i} material={copper} position={[-0.09, 0.62, z]} castShadow><cylinderGeometry args={[0.06, 0.06, 1.2, 12]} /></mesh>
      ))}
    </group>
  );
}

function ElectricPanel({ f }: { f: Fixture }) {
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]}>
      <mesh geometry={UNIT} material={mat("#d8dbe2", 0.5)} position={[0, 1.0, 0]} scale={[0.7, 0.9, 0.14]} castShadow />
      {[-0.2, 0, 0.2].map((x, i) => (
        <mesh key={i} geometry={UNIT} material={mat(i === 1 ? "#e8505b" : "#2b2e38", 0.4)} position={[x, 1.1, 0.08]} scale={[0.08, 0.12, 0.03]} />
      ))}
    </group>
  );
}

// ── Le silo de la mémoire partagée ───────────────────────────────────────────

/** L'icône d'une base de données à taille de pièce : trois disques empilés,
 *  des anneaux de lumière entre eux. Une vague les remonte quand un agent est
 *  branché ; un éclair quand un chargement s'achève. Un clic l'ouvre. */
function Silo({ zone }: { zone: Zone }) {
  const silo = useContext(SiloCtx);
  const c = zone.core!;
  const R = 0.9, DISC = 0.5, GAP = 0.09, BASE = 0.2;
  const bands = useMemo(() => Array.from({ length: 4 }, () => new THREE.MeshStandardMaterial({
    color: "#b9adff", emissive: "#8b7bd8", emissiveIntensity: 0.6, roughness: 0.3, toneMapped: false,
  })), []);
  const shardMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: "#cfc6ff", emissive: "#8b7bd8", emissiveIntensity: 1.2, roughness: 0.2, toneMapped: false,
  }), []);
  useEffect(() => () => { bands.forEach((m) => m.dispose()); shardMat.dispose(); }, [bands, shardMat]);
  const shards = useRef<THREE.Group>(null);
  const count = silo?.count ?? 0;
  const nShards = Math.max(4, Math.min(22, Math.round(Math.log10(count + 1) * 7)));
  const shardSpec = useMemo(() => {
    const r = seeded(91);
    return Array.from({ length: nShards }, () => ({ a: r() * Math.PI * 2, y: 0.4 + r() * 1.6, rad: R + 0.35 + r() * 0.35, sp: 0.25 + r() * 0.35, s: 0.04 + r() * 0.05 }));
  }, [nShards]);

  useFrame(({ clock }, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const t = clock.elapsedTime;
    if (silo) silo.pulse.current = Math.max(0, silo.pulse.current - dt * 1.2);
    const pulse = silo?.pulse.current ?? 0;
    const active = (silo?.plugged.current ?? 0) > 0;
    bands.forEach((m, i) => {
      m.emissiveIntensity = 0.55 + 0.15 * Math.sin(t * 1.4 + i * 0.6) + (active ? 1.4 * Math.max(0, Math.sin(t * 4.5 - i * 1.1)) : 0) + pulse * 2.4;
    });
    shardMat.emissiveIntensity = 1 + pulse * 2;
    shards.current?.children.forEach((o, i) => {
      const sp = shardSpec[i];
      if (!sp) return;
      const a = sp.a + t * sp.sp * (active ? 2.2 : 1);
      o.position.set(Math.cos(a) * sp.rad, sp.y + Math.sin(t * 1.3 + i) * 0.08, Math.sin(a) * sp.rad);
      o.rotation.set(t * 0.8 + i, t * 1.1, 0);
    });
  });

  const discY = (i: number) => BASE + DISC / 2 + i * (DISC + GAP);
  const open = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.delta < 5) silo?.onOpen?.(); };
  return (
    <group position={[c.x, FLOOR_Y, c.z]} onClick={open}
      onPointerOver={(e) => { e.stopPropagation(); (e.nativeEvent.target as HTMLElement | null)?.style.setProperty("cursor", "pointer"); }}
      onPointerOut={(e) => (e.nativeEvent.target as HTMLElement | null)?.style.setProperty("cursor", "grab")}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} material={mat("#f2c14e", 0.6)}>
        <ringGeometry args={[R + 0.32, R + 0.42, 48]} />
      </mesh>
      <mesh material={mat("#3a3e4b", 0.45)} position={[0, BASE / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[R + 0.18, R + 0.25, BASE, 40]} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={i} material={mat("#eef0f5", 0.3)} position={[0, discY(i), 0]} castShadow receiveShadow>
          <cylinderGeometry args={[R, R, DISC, 48]} />
        </mesh>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} material={bands[i]} position={[0, BASE + i * (DISC + GAP) - GAP / 2 + (i === 0 ? GAP / 2 : 0), 0]}>
          <cylinderGeometry args={[R + 0.025, R + 0.025, i === 0 || i === 3 ? 0.05 : GAP, 48]} />
        </mesh>
      ))}
      <mesh material={mat("#eef0f5", 0.3)} position={[0, discY(2) + DISC / 2, 0]} scale={[1, 0.22, 1]} castShadow>
        <sphereGeometry args={[R, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      <mesh material={bands[3]} position={[0, discY(2) + DISC / 2 + 0.2, 0]}>
        <cylinderGeometry args={[0.12, 0.16, 0.06, 20]} />
      </mesh>
      <group ref={shards}>
        {shardSpec.map((sp, i) => (
          <mesh key={i} material={shardMat} scale={sp.s}><octahedronGeometry args={[1, 0]} /></mesh>
        ))}
      </group>
      {zone.spots.filter((s) => s.port).map((s, i) => {
        const pt = s.port!;
        const dx = pt.x - c.x, dz = pt.z - c.z;
        const len = Math.hypot(dx, dz);
        const ang = Math.atan2(dx, dz);
        return (
          <group key={i}>
            <mesh geometry={UNIT} material={mat("#3a3e4b", 0.6)} position={[dx / 2, 0.02, dz / 2]} rotation={[0, ang, 0]} scale={[0.1, 0.03, len]} />
            <group position={[dx, 0, dz]} rotation={[0, ang, 0]}>
              <mesh geometry={UNIT} material={mat("#2b2e38", 0.4)} position={[0, 0.2, 0]} scale={[0.3, 0.4, 0.26]} castShadow />
              <mesh material={bands[1]} position={[0, 0.34, 0.135]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.06, 0.015, 8, 16]} /></mesh>
            </group>
          </group>
        );
      })}
    </group>
  );
}

// ── L'armoire des skills ─────────────────────────────────────────────────────

interface SkillsState {
  list: SkillItem[];
  onOpen?: () => void;
  /** Monte à 1 quand un agent vient chercher un skill ; retombe seul. */
  pulse: React.MutableRefObject<number>;
}
const SkillsCtx = createContext<SkillsState | null>(null);

/** La teinte d'une catégorie de skills : stable, pour qu'on reconnaisse une
 *  famille d'une étagère à l'autre. */
function skillColor(category: string | null): string {
  const h = hash(category || "autres") % 360;
  return `hsl(${h}, 55%, 58%)`;
}

/**
 * L'armoire des compétences, dans Utilities, à côté du silo de la mémoire :
 * chaque skill du service y a sa cartouche, rangée par famille, une diode à sa
 * couleur. Un agent qui vient d'en acquérir un vient l'y chercher — l'armoire
 * s'éclaire. Un clic l'ouvre : la liste, et qui maîtrise quoi.
 */
function SkillCabinet({ f }: { f: Fixture }) {
  const sk = useContext(SkillsCtx);
  const len = f.len ?? 1.9, D = 0.5, H = 2.05, SHELVES = 4, STEP = 0.074;
  const per = Math.max(4, Math.floor((len - 0.16) / STEP));
  const list = useMemo(
    () => [...(sk?.list ?? [])].sort((a, b) => (a.category ?? "~").localeCompare(b.category ?? "~") || a.name.localeCompare(b.name)).slice(0, SHELVES * per),
    [sk?.list, per],
  );
  const shelfY = (s: number) => 0.18 + s * ((H - 0.42) / SHELVES);
  const mats = useMemo(() => {
    const m = new Map<string, THREE.MeshStandardMaterial>();
    for (const s of list) {
      const c = skillColor(s.category);
      if (!m.has(c)) m.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.1 }));
    }
    return m;
  }, [list]);
  const led = useMemo(() => new THREE.MeshBasicMaterial({ color: "#9ff0c4", toneMapped: false }), []);
  const glow = useMemo(() => new THREE.MeshStandardMaterial({
    color: "#2b2e38", emissive: "#8b7bd8", emissiveIntensity: 0.5, roughness: 0.4, toneMapped: false,
  }), []);
  useEffect(() => () => { mats.forEach((m) => m.dispose()); }, [mats]);
  useEffect(() => () => { led.dispose(); glow.dispose(); }, [led, glow]);
  const header = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 96;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#1d1f27"; ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = "#e9e4ff"; ctx.font = "700 46px Inter, 'Segoe UI', sans-serif"; ctx.textBaseline = "middle";
    ctx.fillText("SKILLS", 24, 50);
    ctx.fillStyle = "#b9adff"; ctx.font = "600 38px Inter, 'Segoe UI', sans-serif"; ctx.textAlign = "right";
    ctx.fillText(String(sk?.list.length ?? 0), 488, 50);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [sk?.list.length]);
  useEffect(() => () => header.dispose(), [header]);

  useFrame(({ clock }, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    if (sk) sk.pulse.current = Math.max(0, sk.pulse.current - dt * 0.8);
    const p = sk?.pulse.current ?? 0;
    const t = clock.elapsedTime;
    glow.emissiveIntensity = 0.45 + 0.1 * Math.sin(t * 1.6) + p * 2.2;
    led.color.set("#9ff0c4").multiplyScalar(0.7 + 0.3 * Math.sin(t * 3) + p * 1.5);
  });

  const wood = mat("#6b4a36", 0.7), inner = mat("#3a2c24", 0.85);
  const open = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.delta < 5) sk?.onOpen?.(); };
  return (
    <group position={[f.x, FLOOR_Y, f.z]} rotation={[0, f.rot, 0]} onClick={open}
      onPointerOver={(e) => { e.stopPropagation(); (e.nativeEvent.target as HTMLElement | null)?.style.setProperty("cursor", "pointer"); }}
      onPointerOut={(e) => (e.nativeEvent.target as HTMLElement | null)?.style.setProperty("cursor", "grab")}
    >
      {/* Le corps : fond, flancs, dessus, socle, et les tablettes. */}
      <mesh geometry={UNIT} material={inner} position={[0, H / 2, -D / 2 + 0.02]} scale={[len, H, 0.04]} castShadow receiveShadow />
      {[-1, 1].map((sx) => (
        <mesh key={sx} geometry={UNIT} material={wood} position={[sx * (len / 2 - 0.03), H / 2, 0]} scale={[0.06, H, D]} castShadow receiveShadow />
      ))}
      <mesh geometry={UNIT} material={wood} position={[0, H - 0.03, 0]} scale={[len, 0.06, D + 0.02]} castShadow />
      <mesh geometry={UNIT} material={mat("#2b2e38", 0.5)} position={[0, 0.06, 0]} scale={[len - 0.02, 0.12, D - 0.02]} />
      {range(SHELVES).map((s) => (
        <mesh key={s} geometry={UNIT} material={wood} position={[0, shelfY(s) - 0.015, 0]} scale={[len - 0.1, 0.03, D - 0.06]} receiveShadow />
      ))}
      {/* Les cartouches : une par skill, à la couleur de sa famille. */}
      {list.map((s, k) => {
        // Réparties sur les quatre étagères, en commençant par le haut : une
        // armoire pleine sur une seule planche aurait l'air vide.
        const perShelf = Math.max(1, Math.min(per, Math.ceil(list.length / SHELVES)));
        const shelf = SHELVES - 1 - Math.floor(k / perShelf), slot = k % perShelf;
        const x = -len / 2 + 0.08 + STEP / 2 + slot * STEP;
        const y = shelfY(shelf) + 0.16;
        return (
          <group key={s.id} position={[x, y, 0.02]}>
            <mesh geometry={UNIT} material={mats.get(skillColor(s.category))} scale={[STEP - 0.016, 0.3, D - 0.14]} castShadow />
            <mesh geometry={UNIT} material={led} position={[0, 0.1, (D - 0.14) / 2 + 0.004]} scale={[0.018, 0.018, 0.008]} />
          </group>
        );
      })}
      {/* Les portes vitrées, et le fronton lumineux : SKILLS, et leur nombre. */}
      {[-1, 1].map((sx) => (
        <mesh key={sx} geometry={UNIT} material={GLASS} position={[sx * len / 4, H / 2 + 0.04, D / 2 - 0.01]} scale={[len / 2 - 0.04, H - 0.32, 0.015]} />
      ))}
      <mesh geometry={UNIT} material={glow} position={[0, H - 0.17, D / 2 - 0.005]} scale={[len - 0.1, 0.2, 0.02]} />
      <mesh position={[0, H - 0.17, D / 2 + 0.008]}>
        <planeGeometry args={[Math.min(1.1, len - 0.3), 0.2]} />
        <meshBasicMaterial map={header} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Le câble d'un agent branché : de ses mains à la borne, avec les paquets
 *  de données qui y filent vers le silo. */
function Cable({ from, to, color }: { from: [number, number, number]; to: [number, number, number]; color: string }) {
  const curve = useMemo(() => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const mid = a.clone().lerp(b, 0.5);
    mid.y = Math.min(a.y, b.y) - 0.22;
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }, [from[0], from[1], from[2], to[0], to[1], to[2]]); // eslint-disable-line react-hooks/exhaustive-deps
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 24, 0.02, 6), [curve]);
  useEffect(() => () => geo.dispose(), [geo]);
  const packet = useMemo(() => new THREE.MeshBasicMaterial({ color: mix(color, "#ffffff", 0.35), toneMapped: false }), [color]);
  useEffect(() => () => packet.dispose(), [packet]);
  const dots = useRef<Array<THREE.Mesh | null>>([]);
  useFrame(({ clock }) => {
    dots.current.forEach((m, k) => { if (m) m.position.copy(curve.getPoint((clock.elapsedTime * 0.7 + k / 3) % 1)); });
  });
  return (
    <group>
      <mesh geometry={geo} material={mat("#24262e", 0.5)} castShadow />
      {[0, 1, 2].map((k) => (
        <mesh key={k} ref={(el) => { dots.current[k] = el; }} material={packet}><sphereGeometry args={[0.045, 10, 8]} /></mesh>
      ))}
    </group>
  );
}

// ── Un agent ─────────────────────────────────────────────────────────────────

type Goal = "seat" | "beside" | "room" | "out" | "plug" | "visit" | "meet" | "fetch";

/** Où va un agent : le point visé, celui d'où l'on s'en approche (une chaise
 *  ne s'aborde que par derrière, un canapé que par devant), et ce qu'on y fait. */
interface Dest {
  kind: Goal;
  p: P;
  approach: P | null;
  face: number;
  /** Hauteur des hanches si l'on s'y assoit ; null : debout. */
  sit: number | null;
  port?: P;
  zone: Zone | null;
  /** Pour une visite : l'agent à qui l'on vient parler. */
  target?: string;
}

interface Ctrl {
  mode: "seated" | "walking" | "standing";
  goal: Goal;
  at: Dest;
  path: P[];
  timer: number;
  pos: THREE.Vector2;
  heading: number;
  seatKey: string;
  dance: boolean;
  stride: number;
  storeQueue: number;
  pluggedIn: boolean;
  /** Les skills fraîchement acquis, à aller chercher à l'armoire. */
  skillQueue: number;
  fetching: boolean;
  visitQueue: string[];
  /** Le temps passé à céder le passage : au-delà, on recalcule un chemin. */
  yield: number;
  stuck: number;
  lastPos: THREE.Vector2;
}

const SPEED = 1.15;
const PERSONAL = 0.62;

function Agent({
  agent, seat, zone, layout, ring, storeSignal, skillSignal, visit, speaking, meetSeat, talkingToPlayer, agentPos,
  onSelect, onHover, register,
}: {
  agent: SceneAgent; seat: Seat; zone: Zone; layout: Layout;
  ring: string | null;
  storeSignal: number;
  skillSignal: number;
  visit: { to: string; n: number } | null;
  speaking: boolean;
  meetSeat: number | null;
  talkingToPlayer: boolean;
  agentPos: (id: string) => { x: number; z: number; moving: boolean } | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  register: (o: THREE.Object3D | null) => void;
}) {
  const root = useRef<THREE.Group>(null);
  const dots = useRef<THREE.Group>(null);
  const rng = useMemo(() => seeded(hash(agent.id)), [agent.id]);
  const silo = useContext(SiloCtx);
  const crowd = useContext(CrowdCtx);
  const claims = useContext(ClaimsCtx);
  const nav = layout.nav;
  const claimKey = useRef<string | null>(null);

  const figure = useMemo(() => buildAgentFigure(describeAvatar(agent.avatarUrl, agent.name)), [agent.avatarUrl, agent.name]);
  useEffect(() => () => figure.dispose(), [figure]);
  const [plug, setPlug] = useState<{ from: [number, number, number]; to: [number, number, number] } | null>(null);

  const seatDest = (): Dest => ({
    kind: "seat", p: { x: seat.x, z: seat.z },
    approach: seat.ax !== seat.x || seat.az !== seat.z ? { x: seat.ax, z: seat.az } : null,
    face: seat.facing, sit: seat.hip, zone,
  });
  const spotDest = (s: Spot, z: Zone | null, kind: Goal): Dest => ({
    kind, p: { x: s.x, z: s.z },
    approach: s.sit !== null ? { x: s.ax, z: s.az } : null,
    face: s.face, sit: s.sit, port: s.port, zone: z,
  });
  /** Une place est libre si personne d'autre ne l'a prise, ni ne s'y tient. */
  const occupied = (x: number, z: number, r = 0.55) => {
    if (claims) for (const c of claims.current.values()) {
      if (c.id !== agent.id && Math.hypot(c.x - x, c.z - z) < r) return true;
    }
    if (crowd) for (const [id, o] of crowd.current) {
      if (id !== agent.id && !o.moving && Math.hypot(o.x - x, o.z - z) < r) return true;
    }
    return false;
  };
  const pickFree = (arr: Spot[]) => {
    const f = arr.filter((q) => !occupied(q.x, q.z));
    return f.length ? f[Math.floor(rng() * f.length)] : null;
  };
  const claim = (d: Dest | null) => {
    if (claimKey.current) claims?.current.delete(claimKey.current);
    claimKey.current = null;
    if (!d || d.kind === "seat") return;
    const k = spotKey(d.p.x, d.p.z);
    claims?.current.set(k, { id: agent.id, x: d.p.x, z: d.p.z });
    claimKey.current = k;
  };

  const seatKey = `${seat.x.toFixed(2)}:${seat.z.toFixed(2)}`;
  const ctrl = useRef<Ctrl>({
    mode: "seated", goal: "seat", at: seatDest(), path: [], timer: 8 + rng() * 40,
    pos: V2(seat.x, seat.z), heading: seat.facing, seatKey, dance: false, stride: 0,
    storeQueue: 0, pluggedIn: false, skillQueue: 0, fetching: false, visitQueue: [], yield: 0, stuck: 0, lastPos: V2(seat.x, seat.z),
  });
  const lastStore = useRef(0);
  const lastSkill = useRef(0);
  const skillsCtx = useContext(SkillsCtx);
  const lastVisit = useRef(0);
  const stateRef = useRef(agent.state);
  stateRef.current = agent.state;
  const start = useMemo(() => ({ p: [seat.x, seat.hip - figure.hip, seat.z] as [number, number, number], r: seat.facing }), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    register(root.current);
    return () => {
      register(null);
      crowd?.current.delete(agent.id);
      if (claimKey.current) claims?.current.delete(claimKey.current);
      if (ctrl.current.pluggedIn && silo) silo.plugged.current = Math.max(0, silo.plugged.current - 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

  const dest = (g: Goal): Dest | null => {
    if (g === "seat") return seatDest();
    if (g === "beside") {
      // À côté de son poste : il se lève pour vous faire signe.
      const fx = Math.sin(seat.facing), fz = Math.cos(seat.facing);
      for (const [ox, oz] of [[fz, -fx], [-fz, fx], [-fx, -fz]]) {
        const p = { x: seat.x + ox * 1.0, z: seat.z + oz * 1.0 };
        if (isFree(nav, p.x, p.z) && !occupied(p.x, p.z, 0.45)) return { kind: "beside", p, approach: null, face: seat.facing, sit: null, zone };
      }
      return null;
    }
    if (g === "room") {
      const s = pickFree(zone.spots);
      return s ? spotDest(s, zone, "room") : null;
    }
    if (g === "plug") {
      const m = layout.memory;
      const s = pickFree(m?.spots.filter((q) => q.port) ?? []);
      return s ? spotDest(s, m, "plug") : null;
    }
    if (g === "fetch") {
      const m = layout.memory;
      const s = pickFree(m?.spots.filter((q) => q.use === "skills") ?? []);
      return s ? spotDest(s, m, "fetch") : null;
    }
    if (g === "meet") {
      const m = layout.meeting;
      const s = m && meetSeat !== null ? m.spots[meetSeat % m.spots.length] : null;
      return s ? spotDest(s, m, "meet") : null;
    }
    if (g === "visit") {
      const to = ctrl.current.visitQueue[0];
      const home = to ? layout.seatOf.get(to) : null;
      const now = to ? agentPos(to) : null;
      const ax = now?.x ?? home?.seat.x, az = now?.z ?? home?.seat.z;
      if (ax === undefined || az === undefined) return null;
      // Se poster à côté de celui à qui l'on parle, du côté le plus proche.
      const here = ctrl.current.pos;
      const cands = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]
        .map(([dx, dz]) => ({ x: ax + dx * 0.95, z: az + dz * 0.95 }))
        .filter((p) => isFree(nav, p.x, p.z) && !occupied(p.x, p.z, 0.5))
        .sort((a, b) => Math.hypot(a.x - here.x, a.z - here.y) - Math.hypot(b.x - here.x, b.z - here.y));
      if (!cands.length) return null;
      const p = cands[0];
      return { kind: "visit", p, approach: null, face: Math.atan2(ax - p.x, az - p.z), sit: null, zone: null, target: to };
    }
    // Sortir : un coin du plateau, le café, le salon, un box, l'atelier — de
    // préférence pas trop loin — ou une halte devant le silo.
    if (rng() < 0.1 && layout.memory) {
      const s = pickFree(layout.memory.spots.filter((q) => q.port || q.use === "skills"));
      if (s) return spotDest(s, layout.memory, "out");
    }
    const here = ctrl.current.pos;
    const pool = layout.commons
      .map((z) => ({ z, dist: Math.hypot(z.x + z.w / 2 - here.x, z.z + z.d / 2 - here.y) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 6);
    for (let tries = 0; tries < 4 && pool.length; tries++) {
      const { z } = pool[Math.floor(rng() * pool.length)];
      const s = pickFree(z.spots);
      if (s) return spotDest(s, z, "out");
    }
    const hs = pickFree(layout.hall.spots);
    return hs ? spotDest(hs, null, "out") : null;
  };

  const unplug = (finished: boolean) => {
    const c = ctrl.current;
    if (!c.pluggedIn) return;
    c.pluggedIn = false;
    if (silo) {
      silo.plugged.current = Math.max(0, silo.plugged.current - 1);
      if (finished) silo.pulse.current = 1;
    }
    if (!finished) c.storeQueue += 1;
    setPlug(null);
  };

  /** Partir vers un but : se lever (par l'arrière de la chaise), suivre le
   *  chemin calculé, puis s'installer au dernier pas. */
  const go = (g: Goal): boolean => {
    const c = ctrl.current;
    const target = dest(g);
    if (!target) return false;
    unplug(false);
    const here = { x: c.pos.x, z: c.pos.y };
    const leaving = c.mode !== "walking" && c.at.sit !== null && c.at.approach ? c.at.approach : null;
    const from = leaving ?? here;
    const mid = findPath(nav, from, target.approach ?? target.p);
    if (!mid) return false;
    claim(target);
    c.path = [...(leaving ? [leaving] : []), ...mid, ...(target.approach ? [target.p] : [])];
    c.goal = g;
    c.at = target;
    c.mode = "walking";
    c.dance = false;
    c.fetching = false;
    c.yield = 0;
    c.stuck = 0;
    return true;
  };
  const want = (g: Goal) => { if (ctrl.current.goal !== g) go(g); };

  useFrame(({ clock }, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const t = clock.elapsedTime + (hash(agent.id) % 100) / 13;
    const c = ctrl.current;
    const g = root.current;
    if (!g) return;

    if (storeSignal > lastStore.current) { c.storeQueue += storeSignal - lastStore.current; lastStore.current = storeSignal; }
    if (skillSignal > lastSkill.current) { c.skillQueue += skillSignal - lastSkill.current; lastSkill.current = skillSignal; }
    if (visit && visit.n > lastVisit.current) { lastVisit.current = visit.n; c.visitQueue.push(visit.to); }

    if (c.seatKey !== seatKey) { c.seatKey = seatKey; go("seat"); }

    const st = stateRef.current;
    if (talkingToPlayer) {
      // Quelqu'un lui parle : il s'arrête et se tourne vers lui. Assis, il
      // reste assis ; debout, il attend.
      if (c.mode === "walking") { c.path = []; c.mode = "standing"; }
      const pl = crowd?.current.get("!player");
      if (pl) {
        let dh = Math.atan2(pl.x - c.pos.x, pl.z - c.pos.y) - c.heading;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        if (c.mode !== "seated") c.heading += dh * Math.min(1, dt * 6);
      }
    } else if (st === "working" || st === "error") {
      // Au travail, il reste assis à son poste.
      want("seat");
    } else if (st === "waiting") {
      want("beside");
    } else if (meetSeat !== null && layout.meeting) {
      want("meet");
    } else if (c.goal === "meet") {
      go("seat");
    } else if (c.mode !== "walking") {
      c.timer -= dt;
      if (c.goal === "plug" && c.mode === "standing") {
        if (c.timer <= 0) { unplug(true); go("seat"); }
      } else if (c.goal === "fetch" && c.mode === "standing") {
        if (c.timer <= 0) { c.fetching = false; go("seat"); }
      } else if (c.goal === "visit") {
        if (c.timer <= 0) { c.visitQueue.shift(); if (!(c.visitQueue.length && go("visit"))) go("seat"); }
      } else if (c.visitQueue.length) {
        if (!go("visit")) c.visitQueue.shift();
      } else if (c.storeQueue > 0 && layout.memory) {
        c.storeQueue -= 1;
        go("plug");
      } else if (c.skillQueue > 0 && layout.memory) {
        c.skillQueue -= 1;
        if (!go("fetch")) c.timer = 5;
      } else if (c.timer <= 0) {
        // Il se lève : le plus souvent pour quelques pas dans son espace,
        // parfois pour sortir. Puis il revient s'asseoir.
        if (c.goal === "seat") { if (!go(rng() < 0.75 ? "room" : "out")) c.timer = 10; }
        else go("seat");
      }
    }

    // ── La marche, en s'écartant des autres ──
    let walked = 0;
    if (c.mode === "walking") {
      const next = c.path[0];
      if (!next) {
        c.mode = c.at.sit !== null ? "seated" : "standing";
        c.timer = c.goal === "seat" ? 30 + rng() * 45
          : c.goal === "plug" ? 3.5 + rng() * 2
          : c.goal === "fetch" ? 3 + rng() * 1.5
          : c.goal === "visit" ? 9 + rng() * 4
          : c.goal === "out" ? (c.at.sit !== null ? 18 + rng() * 20 : 8 + rng() * 10)
          : c.at.sit !== null ? 15 + rng() * 15 : 5 + rng() * 7;
        c.dance = c.goal === "out" && (c.at.zone?.kind === "lounge" || c.at.zone?.kind === "cafe") && c.at.sit === null && rng() < 0.25;
        // À l'armoire : il prend sa cartouche — l'armoire s'éclaire.
        if (c.goal === "fetch") { c.fetching = true; if (skillsCtx) skillsCtx.pulse.current = 1; }
        if (c.goal === "plug" && c.at.port) {
          c.pluggedIn = true;
          if (silo) silo.plugged.current += 1;
          const f = c.at.face;
          setPlug({
            from: [c.pos.x + Math.sin(f) * 0.3, FLOOR_Y + figure.hip + 0.32, c.pos.y + Math.cos(f) * 0.3],
            to: [c.at.port.x, FLOOR_Y + 0.34, c.at.port.z],
          });
        }
      } else {
        const lastLeg = c.path.length === 1 && c.at.approach !== null;
        const dx = next.x - c.pos.x, dz = next.z - c.pos.y;
        const dist = Math.hypot(dx, dz);
        const step = SPEED * dt;
        const dirX = dx / (dist || 1), dirZ = dz / (dist || 1);
        // Les autres : on cède le passage à qui arrive de face, on contourne
        // qui se tient immobile, et l'on garde ses distances.
        let pushX = 0, pushZ = 0, blocked = false;
        if (crowd && !lastLeg) {
          for (const [id, o] of crowd.current) {
            if (id === agent.id) continue;
            const ox = o.x - c.pos.x, oz = o.z - c.pos.y;
            const d = Math.hypot(ox, oz);
            if (d > PERSONAL || d < 1e-4) continue;
            const ahead = (ox * dirX + oz * dirZ) / d;
            if (ahead > 0.55 && d < 0.5 && o.moving && id < agent.id) blocked = true;
            const k = (PERSONAL - d) / PERSONAL;
            pushX -= (ox / d) * k;
            pushZ -= (oz / d) * k;
            if (!o.moving && ahead > 0.4) { pushX += -dirZ * k * 0.8; pushZ += dirX * k * 0.8; }
          }
        }
        if (blocked && c.yield < 1.4) {
          c.yield += dt;
        } else {
          c.yield = 0;
          if (dist <= step) {
            c.pos.set(next.x, next.z);
            c.path.shift();
            walked = dist;
          } else {
            let mx = dirX + pushX * 0.9, mz = dirZ + pushZ * 0.9;
            const ml = Math.hypot(mx, mz) || 1;
            mx = (mx / ml) * step; mz = (mz / ml) * step;
            const nx = c.pos.x + mx, nz = c.pos.y + mz;
            // On ne sort jamais du sol praticable — sauf pour le dernier pas
            // vers une chaise, qui se trouve souvent contre une table.
            if (lastLeg || isFree(nav, nx, nz)) { c.pos.set(nx, nz); walked = step; }
            else { c.pos.set(c.pos.x + dirX * step, c.pos.y + dirZ * step); walked = step; }
            let dh = Math.atan2(mx, mz) - c.heading;
            dh = Math.atan2(Math.sin(dh), Math.cos(dh));
            c.heading += dh * Math.min(1, dt * 10);
          }
        }
        // Coincé trop longtemps : on recalcule la route.
        c.stuck = c.pos.distanceTo(c.lastPos) < 0.01 ? c.stuck + dt : 0;
        c.lastPos.copy(c.pos);
        if (c.stuck > 2.5) { c.stuck = 0; go(c.goal); }
      }
    }
    c.stride += walked * 7;

    const seated = c.mode === "seated";
    if (!talkingToPlayer && c.mode !== "walking" && !Number.isNaN(c.at.face)) {
      let dh = c.at.face - c.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      c.heading += dh * Math.min(1, dt * 6);
    }
    g.position.set(c.pos.x, seated && c.at.sit !== null ? c.at.sit - figure.hip : FLOOR_Y, c.pos.y);
    g.rotation.y = c.heading;
    crowd?.current.set(agent.id, { x: c.pos.x, z: c.pos.y, moving: c.mode === "walking" });

    figure.update({
      t,
      stride: c.stride,
      walking: c.mode === "walking" && walked > 0,
      seated,
      working: seated && c.goal === "seat" && (st === "working" || st === "error"),
      waving: st === "waiting" && c.mode === "standing" && !talkingToPlayer,
      dancing: c.dance && c.mode === "standing",
      reaching: c.pluggedIn || c.fetching,
      talking: speaking || talkingToPlayer || (c.goal === "visit" && c.mode === "standing"),
    });

    if (dots.current) {
      dots.current.visible = seated && c.goal === "seat" && st === "working";
      if (dots.current.visible) dots.current.children.forEach((d, i) => { d.position.y = Math.max(0, Math.sin(t * 6 - i * 0.7)) * 0.06; });
    }
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    onHover(agent.id);
    (e.nativeEvent.target as HTMLElement | null)?.style.setProperty("cursor", "pointer");
  };
  const out = (e: ThreeEvent<PointerEvent>) => {
    onHover(null);
    (e.nativeEvent.target as HTMLElement | null)?.style.setProperty("cursor", "grab");
  };
  const dotMat = useMemo(() => new THREE.MeshBasicMaterial({ color: figure.color, toneMapped: false }), [figure.color]);
  useEffect(() => () => dotMat.dispose(), [dotMat]);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: ring ?? "#ffffff", transparent: true, opacity: 0.9, toneMapped: false }), [ring]);
  useEffect(() => () => ringMat.dispose(), [ringMat]);

  return (
    <>
      <group
        ref={root}
        position={start.p}
        rotation={[0, start.r, 0]}
        onClick={(e) => { e.stopPropagation(); if (e.delta < 5) onSelect(agent.id); }}
        onPointerOver={over}
        onPointerOut={out}
      >
        <mesh geometry={UNIT} material={HIT} position={[0, 0.65, 0]} scale={[0.8, 1.35, 0.8]} />
        {ring && (
          <mesh material={ringMat} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
            <ringGeometry args={[0.42, 0.52, 40]} />
          </mesh>
        )}
        <primitive object={figure.root} />
        <group ref={dots} position={[0, 1.38, 0]} visible={false}>
          {[-0.09, 0, 0.09].map((dx, i) => (
            <mesh key={i} material={dotMat} position={[dx, 0, 0]}><sphereGeometry args={[0.035, 12, 12]} /></mesh>
          ))}
        </group>
      </group>
      {plug && <Cable from={plug.from} to={plug.to} color={figure.color} />}
    </>
  );
}

// ── Le joueur ────────────────────────────────────────────────────────────────

const PLAYER_KEYS = {
  forward: ["KeyW", "KeyZ", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "KeyQ", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
};

/** Soi-même, dans l'espace : on avance au clavier (ZQSD, WASD ou les flèches),
 *  la vue tourne à la souris, et E parle à l'agent le plus proche. On ne
 *  traverse ni les murs, ni les meubles, ni les agents. */
function Player({ spec, nav, hall, posOut, az, onNear, onInteract }: {
  spec: AvatarSpec; nav: NavGrid; hall: Layout["hall"];
  posOut: React.MutableRefObject<P | null>;
  az: React.MutableRefObject<number>;
  onNear?: (id: string | null) => void;
  onInteract?: (id: string) => void;
}) {
  const crowd = useContext(CrowdCtx);
  const figure = useMemo(() => buildAgentFigure(spec), [spec]);
  useEffect(() => () => figure.dispose(), [figure]);
  const root = useRef<THREE.Group>(null);
  const keys = useRef(new Set<string>());
  const pos = useRef(new THREE.Vector2(hall.x0 + 1.4, 0));
  const heading = useRef(Math.PI / 2);
  const stride = useRef(0);
  const near = useRef<string | null>(null);
  const cbs = useRef({ onNear, onInteract });
  cbs.current = { onNear, onInteract };

  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      keys.current.add(e.code);
      if (Object.values(PLAYER_KEYS).some((ks) => ks.includes(e.code))) e.preventDefault();
      if ((e.code === "KeyE" || e.code === "Enter") && near.current) cbs.current.onInteract?.(near.current);
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const blur = () => keys.current.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      crowd?.current.delete("!player");
      posOut.current = null;
      cbs.current.onNear?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(({ clock }, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const k = keys.current;
    const has = (list: string[]) => list.some((c) => k.has(c));
    const f = (has(PLAYER_KEYS.forward) ? 1 : 0) - (has(PLAYER_KEYS.back) ? 1 : 0);
    const r = (has(PLAYER_KEYS.right) ? 1 : 0) - (has(PLAYER_KEYS.left) ? 1 : 0);
    // Devant soi = vers où regarde la caméra.
    const a = az.current;
    const fwdX = -Math.sin(a), fwdZ = -Math.cos(a);
    const rgtX = -fwdZ, rgtZ = fwdX;
    let mx = fwdX * f + rgtX * r, mz = fwdZ * f + rgtZ * r;
    const ml = Math.hypot(mx, mz);
    let moving = false;
    if (ml > 0) {
      const speed = (k.has("ShiftLeft") || k.has("ShiftRight") ? 3.6 : 2.2) * dt;
      mx = (mx / ml) * speed; mz = (mz / ml) * speed;
      const p = pos.current;
      const blockedBy = (x: number, z: number) => {
        if (!isFree(nav, x, z)) return true;
        if (crowd) for (const [id, o] of crowd.current) {
          if (id === "!player") continue;
          if (Math.hypot(o.x - x, o.z - z) < 0.42) return true;
        }
        return false;
      };
      // On glisse le long des obstacles plutôt que de s'y coller.
      if (!blockedBy(p.x + mx, p.y + mz)) p.set(p.x + mx, p.y + mz);
      else if (!blockedBy(p.x + mx, p.y)) p.set(p.x + mx, p.y);
      else if (!blockedBy(p.x, p.y + mz)) p.set(p.x, p.y + mz);
      moving = true;
      let dh = Math.atan2(mx, mz) - heading.current;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      heading.current += dh * Math.min(1, dt * 12);
      stride.current += speed * 7;
    }
    const p = pos.current;
    posOut.current = { x: p.x, z: p.y };
    crowd?.current.set("!player", { x: p.x, z: p.y, moving });
    if (root.current) {
      root.current.position.set(p.x, FLOOR_Y, p.y);
      root.current.rotation.y = heading.current;
    }
    figure.update({ t: clock.elapsedTime, stride: stride.current, walking: moving, seated: false, working: false, waving: false, dancing: false, reaching: false });

    // Qui est à portée de voix ?
    let best: string | null = null, bestD = 1.9;
    if (crowd) for (const [id, o] of crowd.current) {
      if (id === "!player") continue;
      const d = Math.hypot(o.x - p.x, o.z - p.y);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (best !== near.current) { near.current = best; cbs.current.onNear?.(best); }
  });

  return (
    <group ref={root}>
      <primitive object={figure.root} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.4, 0.5, 40]} />
        <meshBasicMaterial color="#9d8cf0" transparent opacity={0.85} toneMapped={false} />
      </mesh>
    </group>
  );
}

// La machine d'un agent embarqué, vue de l'intérieur de son conteneur, dans le
// même format qu'une machine d'équipe (machine.info du superviseur) : l'onglet
// Machines l'affiche avec les mêmes jauges.
//
// Dans un conteneur, os.cpus() et os.totalmem() donnent ceux de l'HÔTE : les
// limites réelles sont dans le cgroup (v2 : cpu.max, memory.max,
// memory.current ; v1 en repli). Sans cgroup lisible, on prend l'hôte.

import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

export interface MachineInfo {
  version?: string;
  hostname: string;
  platform: string;
  arch: string;
  uptime_s: number;
  cpus: number;
  load: number[];
  mem: { total_kb: number; free_kb: number };
  disk: { total_kb: number; free_kb: number } | null;
  node: string;
  rss_mb: number;
  /** Les outils du catalogue installés dans l'image. */
  tools?: string[];
  /** L'image porte une configuration figée (export), sinon configuration en ligne seulement. */
  built?: boolean;
}

const read = (p: string) => readFile(p, "utf8").then((t) => t.trim()).catch(() => null);
const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);

/** Les processeurs dont le conteneur dispose : la limite du cgroup, sinon ceux de l'hôte. */
export function cpusFromCgroup(cpuMax: string | null, v1Quota: string | null, v1Period: string | null, host: number): number {
  // v2 : « 200000 100000 » (quota période) ou « max 100000 ».
  if (cpuMax) {
    const [q, p] = cpuMax.split(/\s+/);
    if (q !== "max" && Number(q) > 0 && Number(p) > 0) return Math.round((Number(q) / Number(p)) * 100) / 100;
  }
  const q1 = Number(v1Quota), p1 = Number(v1Period);
  if (q1 > 0 && p1 > 0) return Math.round((q1 / p1) * 100) / 100;
  return host;
}

/** La mémoire du conteneur en Ko : la limite du cgroup et ce qui est utilisé, sinon l'hôte. */
export function memFromCgroup(max: string | null, current: string | null, host: { total: number; free: number }): { total_kb: number; free_kb: number } {
  const limit = num(max);
  const used = num(current);
  // Une limite plus grande que l'hôte (ou « max ») ne limite rien : l'hôte fait foi.
  if (limit && limit < host.total && used != null) {
    return { total_kb: Math.round(limit / 1024), free_kb: Math.max(0, Math.round((limit - used) / 1024)) };
  }
  return { total_kb: Math.round(host.total / 1024), free_kb: Math.round(host.free / 1024) };
}

export async function machineInfo(opts: { workspaceDir: string; version?: string; tools?: string[]; built?: boolean }): Promise<MachineInfo> {
  const [cpuMax, q1, p1, memMax, memCur, memMax1, memCur1] = await Promise.all([
    read("/sys/fs/cgroup/cpu.max"),
    read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    read("/sys/fs/cgroup/memory.max"), read("/sys/fs/cgroup/memory.current"),
    read("/sys/fs/cgroup/memory/memory.limit_in_bytes"), read("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
  ]);
  const disk = await statfs(opts.workspaceDir).then(
    (s) => ({ total_kb: Math.round((s.blocks * s.bsize) / 1024), free_kb: Math.round((s.bavail * s.bsize) / 1024) }),
    () => null,
  );
  return {
    ...(opts.version ? { version: opts.version } : {}),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime_s: Math.round(process.uptime()),
    cpus: cpusFromCgroup(cpuMax, q1, p1, os.cpus().length),
    load: os.loadavg().map((l) => Math.round(l * 100) / 100),
    mem: memFromCgroup(memMax ?? memMax1, memCur ?? memCur1, { total: os.totalmem(), free: os.freemem() }),
    disk,
    node: process.version,
    rss_mb: Math.round(process.memoryUsage().rss / 1e6),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.built !== undefined ? { built: opts.built } : {}),
  };
}

let cached: boolean | null = null;

/** Whether the browser hands out a WebGL context at all — false when it is
 *  turned off, or blocked (after a GPU reset Chrome refuses them until it is
 *  restarted). Probed once, the context released straight away; kept free of
 *  three.js so the studio can ask without loading the engine. */
export function webglAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    cached = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

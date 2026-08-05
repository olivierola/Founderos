// @react-three/fiber v8 augments the GLOBAL `JSX.IntrinsicElements`, but this
// project's `jsx: "react-jsx"` transform resolves intrinsic elements through
// `React.JSX`. Re-apply the augmentation there so <mesh>/<shaderMaterial>/…
// type-check inside GradientOrb.
import type { ThreeElements } from "@react-three/fiber";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

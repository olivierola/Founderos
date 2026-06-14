import "./robot3d.css";

// A small CSS/SVG robot with a faux-3D look (perspective, shading, gentle float
// + blink). Tinted to the agent's accent colour. Pure CSS — cheap to render for
// many nodes on the canvas.
export function Robot3D({ color = "#2F2FE4", size = 56 }: { color?: string; size?: number }) {
  return (
    <div className="robot3d" style={{ width: size, height: size, ["--robot-accent" as any]: color }}>
      <div className="robot3d__float">
        {/* Antenna */}
        <span className="robot3d__antenna" />
        <span className="robot3d__antenna-tip" />
        {/* Head */}
        <div className="robot3d__head">
          <div className="robot3d__face">
            <span className="robot3d__eye robot3d__eye--l" />
            <span className="robot3d__eye robot3d__eye--r" />
            <span className="robot3d__mouth" />
          </div>
          {/* Side ears */}
          <span className="robot3d__ear robot3d__ear--l" />
          <span className="robot3d__ear robot3d__ear--r" />
        </div>
        {/* Body */}
        <div className="robot3d__body">
          <span className="robot3d__chest" />
        </div>
      </div>
      {/* Ground shadow */}
      <span className="robot3d__shadow" />
    </div>
  );
}

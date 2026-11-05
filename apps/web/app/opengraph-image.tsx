import { ImageResponse } from "next/og";

// The preview card when usecloudly.dev is shared on X, Discord, Slack or LinkedIn.
export const alt = "Cloudly: self-hosted coding agents that open checked pull requests";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 80, background: "#0c0e11", color: "#eceef1", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 40, fontWeight: 600 }}>
          <div style={{ width: 44, height: 44, borderRadius: 22, border: "4px solid #eceef1", background: "linear-gradient(90deg, #eceef1 50%, transparent 50%)" }} />
          Cloudly
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 72, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>Coding agents you own, end to end.</div>
          <div style={{ fontSize: 30, color: "#a3aab5" }}>Claude Code, Codex and Gemini CLI on your own server. Close the laptop, get a checked pull request.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 28, color: "#a3aab5" }}>
          <span style={{ color: "#f26a35" }}>usecloudly.dev</span>
          <span>Free · MIT · self-hosted</span>
        </div>
      </div>
    ),
    size,
  );
}

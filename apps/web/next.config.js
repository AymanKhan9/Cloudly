/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Shared contracts are TypeScript source in the monorepo.
  transpilePackages: ["@repo/shared"],
  // Lets a second copy (tests, previews) build next to the main one.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? "http://localhost:8787";
    // The relay's desktop port (a WebSocket to a sandbox's VNC server, by token).
    const relay = process.env.RELAY_INTERNAL_URL ?? "http://127.0.0.1:3140";
    return [
      { source: "/api/:path*", destination: `${api}/:path*` },
      { source: "/relay/:path*", destination: `${relay}/:path*` },
    ];
  },
};

export default nextConfig;

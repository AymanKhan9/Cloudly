/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Lets a second copy (tests, previews) build next to the main one.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? "http://localhost:8787";
    return [{ source: "/api/:path*", destination: `${api}/:path*` }];
  },
};

export default nextConfig;

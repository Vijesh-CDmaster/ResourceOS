import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // This is an authenticated, database-backed app: every route is per-request.
  // Cache Components is intentionally disabled so session reads stay straightforward.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

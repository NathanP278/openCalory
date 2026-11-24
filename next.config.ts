import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.DOCKER_BUILD === "1" ? { output: "standalone" as const } : {}),
  experimental: {
    optimizePackageImports: ["lucide-react", "motion"],
  },
  outputFileTracingIncludes: {
    "/api/foods/**": [
      "./public/data/food-catalog.db.gz",
      "./public/data/catalog-manifest.json",
    ],
  },
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

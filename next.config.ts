import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // No "X-Powered-By: Next.js" header on responses.
  poweredByHeader: false,
  // `next dev` would otherwise write an AGENTS.md into the repo whenever an AI agent runs it.
  agentRules: false,
  // Dev only: keep the Next.js indicator off the sidebar's "Sync now" button.
  devIndicators: { position: "bottom-right" },
  partialPrefetching: true,
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

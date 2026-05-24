import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // voyageai@0.2.1 ships an ESM build with bad imports (missing .mjs extensions
  // in dist/esm/extended/index.mjs). Leaving the package external on the server
  // bypasses bundling so Node resolves the working CJS entry instead.
  serverExternalPackages: ["voyageai"],
};

export default nextConfig;

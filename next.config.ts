import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // The CSV import is a Server Action, and Next caps those at 1 MB by
      // default. Without this the upload fails at the framework boundary — before
      // the action's own size check runs, so the person gets a generic error
      // instead of the sentence explaining what was wrong with their file.
      //
      // 8 MB matches the limit the action enforces and explains. A decade of
      // daily readings across every metric is well under one.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;

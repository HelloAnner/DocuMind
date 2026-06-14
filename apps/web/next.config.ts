import type { NextConfig } from "next";

const isStaticExport = process.env.DOCUMIND_STATIC_EXPORT === "1";
const basePath = process.env.DOCUMIND_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: isStaticExport ? "export" : "standalone",
  basePath,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

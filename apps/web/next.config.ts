import type { NextConfig } from "next";

const isStaticExport = process.env.DOCUMIND_STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  output: isStaticExport ? "export" : "standalone",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

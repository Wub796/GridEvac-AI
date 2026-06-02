/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Prevent webpack from attempting to bundle Node built-ins
      // that some optional CesiumJS code paths reference.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs:     false,
        path:   false,
        os:     false,
        crypto: false,
        stream: false,
        buffer: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;

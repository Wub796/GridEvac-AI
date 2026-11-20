/** @type {import('next').NextConfig} */

// `NEXT_PUBLIC_*` is inlined at build time, so a deployed build with no API
// origin silently falls back to the browser solver. That is a legitimate local
// default but never the intent on Vercel, so say so during the build.
const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').trim();
const loopback = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i;

if (process.env.VERCEL && process.env.NODE_ENV === 'production' && (!apiUrl || loopback.test(apiUrl))) {
  const environment = process.env.VERCEL_ENV ?? 'production';
  console.warn(
    `[gridevac] NEXT_PUBLIC_API_URL is ${apiUrl ? 'a loopback origin' : 'unset'} in this ${environment} build: ` +
      'the deployed site will solve routes in the browser. Set it per Vercel environment and rebuild.',
  );
}

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

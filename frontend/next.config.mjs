/** @type {import('next').NextConfig} */
const nextConfig = {
  // Runs as a SEPARATE service; server.js reverse-proxies migrated UI routes to
  // it, same-origin. No basePath: /home and /_next/* are proxied at the site root.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;

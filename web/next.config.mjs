/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async redirects() {
    return [
      { source: '/ec2', destination: '/inventory/ec2', permanent: false },
      // OpenCost moved per-cluster onto the EKS detail page; keep old bookmarks working.
      { source: '/opencost', destination: '/eks', permanent: false },
    ];
  },
  async rewrites() {
    // Public marketing brochure served from public/brochure/. Clean URL /brochure → the static index.
    // (Assets under /brochure/* are served directly by the static handler.)
    return [{ source: '/brochure', destination: '/brochure/index.html' }];
  },
};
export default nextConfig;

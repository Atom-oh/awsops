/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async redirects() {
    return [{ source: '/ec2', destination: '/inventory/ec2', permanent: false }];
  },
};
export default nextConfig;

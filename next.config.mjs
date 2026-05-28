/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/awsops',
  // `standalone` emits a self-contained Node server in .next/standalone/server.js
  // that the Dockerfile copies into a minimal runtime image. Required for the
  // ADR-030 dev ECS Fargate deployment. Existing EC2 prod `npm run build && start`
  // still works — standalone is additive output, not a replacement.
  output: 'standalone',
  env: {
    NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL || 'https://whchoi98.github.io/awsops',
  },
};

export default nextConfig;

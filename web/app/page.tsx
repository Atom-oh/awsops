export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ color: '#00d4ff', fontSize: 40, margin: 0 }}>AWSops v2</h1>
      <p style={{ color: '#94a3b8', marginTop: 8 }}>
        thin-BFF web tier — Next.js 14 standalone on ECS Fargate (arm64), behind CloudFront VPC Origin → internal ALB.
      </p>
      <ul style={{ marginTop: 32, lineHeight: 2 }}>
        <li>
          <a style={{ color: '#00ff88' }} href="/api/health">/api/health</a> — liveness
        </li>
        <li>
          <a style={{ color: '#00ff88' }} href="/api/stream">/api/stream</a> — SSE (heartbeat ≤20s)
        </li>
        <li>
          <a style={{ color: '#00ff88' }} href="/api/db">/api/db</a> — Aurora connectivity
        </li>
      </ul>
      <p style={{ color: '#64748b', marginTop: 48, fontSize: 13 }}>
        Heavy/async work (AI, reports, scans) runs in the P2 worker tier — not here.
      </p>
    </main>
  );
}

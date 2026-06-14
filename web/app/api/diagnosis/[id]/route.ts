import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';
import { getReport } from '@/lib/diagnosis';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export const dynamic = 'force-dynamic';

async function readArtifact(uri: string): Promise<string | null> {
  const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  // [PR#37 review MINOR] defense-in-depth: only read keys under the diagnosis/ prefix (matches the
  // web role's IAM scope s3:GetObject .../diagnosis/*). An injected URI returns null → clean 404,
  // not an opaque AWS AccessDenied.
  if (!m[2].startsWith('diagnosis/')) return null;
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  const r = await s3.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
  return (await r.Body?.transformToString()) ?? null;
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const report = await getReport(Number(params.id));
  if (!report) return NextResponse.json({ message: 'not found' }, { status: 404 });
  let markdown: string | null = null;
  if (report.artifact_uri) {
    try {
      markdown = await readArtifact(report.artifact_uri);
    } catch {
      markdown = null;
    }
  }
  return NextResponse.json({ report, markdown });
}

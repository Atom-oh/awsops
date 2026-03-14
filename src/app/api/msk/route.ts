// MSK Broker Nodes API — uses AWS CLI (Steampipe has no broker node table)
// MSK 브로커 노드 API — AWS CLI 사용 (Steampipe에 브로커 노드 테이블 없음)
// Note: clusterArn is validated against strict ARN pattern before use
import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';

const REGION = 'ap-northeast-2';
const ARN_PATTERN = /^arn:aws:kafka:[a-z0-9-]+:\d{12}:cluster\/[a-zA-Z0-9._-]+\/[a-z0-9-]+$/;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const clusterArn = searchParams.get('clusterArn');

  if (!clusterArn || !ARN_PATTERN.test(clusterArn)) {
    return NextResponse.json({ error: 'Invalid or missing clusterArn' }, { status: 400 });
  }

  try {
    const output = execFileSync('aws', [
      'kafka', 'list-nodes',
      '--cluster-arn', clusterArn,
      '--region', REGION,
      '--output', 'json',
    ], { encoding: 'utf-8', timeout: 15000 });
    const data = JSON.parse(output);
    return NextResponse.json({ nodes: data.NodeInfoList || [] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to list MSK nodes';
    return NextResponse.json({ error: message, nodes: [] }, { status: 500 });
  }
}

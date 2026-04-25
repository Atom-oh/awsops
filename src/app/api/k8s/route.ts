import { NextRequest, NextResponse } from 'next/server';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { getUserFromRequest } from '@/lib/auth-utils';
import { getAllowedEksClusters } from '@/lib/app-config';

const HOME = process.env.HOME || '/home/ec2-user';
const K8S_SPC_PATH = resolve(HOME, '.steampipe/config/kubernetes.spc');

// Add a connection block for the new context if it doesn't exist.
// Rewrites the file so there is exactly one `connection "kubernetes"` (the aggregator)
// — a duplicate default + aggregator pair causes Steampipe to error:
//   `duplicate connection name: 'kubernetes'` which nukes schema loading for ALL clusters.
// 새 컨텍스트에 대한 connection 블록이 없으면 추가. `connection "kubernetes"`는 오직 aggregator 하나만 남겨야 함.
function addConnectionIfMissing(clusterName: string, contextArn: string) {
  const connName = 'kubernetes_' + clusterName.replace(/[^a-zA-Z0-9]/g, '_');
  const aggregatorBlock = `connection "kubernetes" {\n  plugin      = "kubernetes"\n  type        = "aggregator"\n  connections = ["kubernetes_*"]\n}\n`;
  const newBlock = `connection "${connName}" {\n  plugin = "kubernetes"\n  config_context = "${contextArn}"\n  custom_resource_tables = ["*"]\n}\n`;

  let content = '';
  try {
    content = readFileSync(K8S_SPC_PATH, 'utf-8');
  } catch {
    writeFileSync(K8S_SPC_PATH, newBlock + '\n' + aggregatorBlock, 'utf-8');
    return true;
  }

  if (content.includes(contextArn)) return false; // already exists

  // Strip every `connection "kubernetes" { ... }` block (aggregator or default)
  // to avoid duplicate-connection errors; we re-append a single aggregator at the end.
  const stripped = content.replace(/connection\s+"kubernetes"\s*\{[\s\S]*?\n\}\s*/g, '').trimEnd() + '\n';

  writeFileSync(K8S_SPC_PATH, stripped + '\n' + newBlock + '\n' + aggregatorBlock, 'utf-8');
  return true;
}

// POST: Register kubeconfig + add Steampipe connection + restart Steampipe
export async function POST(req: NextRequest) {
  try {
    const { clusterName, region } = await req.json();

    if (!clusterName || !/^[a-zA-Z0-9_-]+$/.test(clusterName)) {
      return NextResponse.json({ error: 'Invalid cluster name' }, { status: 400 });
    }
    // Department EKS access check / 부서별 EKS 접근 검증
    const user = getUserFromRequest(req);
    const allowedClusters = getAllowedEksClusters(user.groups);
    if (allowedClusters !== null && !allowedClusters.includes(clusterName)) {
      return NextResponse.json({ error: 'Access denied: cluster not allowed for your department' }, { status: 403 });
    }
    if (!region || !/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
      return NextResponse.json({ error: 'Invalid region' }, { status: 400 });
    }

    // 1. aws eks update-kubeconfig
    const output = execFileSync('aws', [
      'eks', 'update-kubeconfig',
      '--name', clusterName,
      '--region', region,
    ], { encoding: 'utf-8', timeout: 15000 });

    // Extract context ARN from output (e.g. "Updated context arn:aws:eks:...")
    const arnMatch = output.match(/(arn:aws:eks:\S+)/);
    const contextArn = arnMatch ? arnMatch[1].replace(/[.,;]+$/, '') : `arn:aws:eks:${region}:*:cluster/${clusterName}`;

    // 2. Add connection to kubernetes.spc if missing
    const added = addConnectionIfMissing(clusterName, contextArn);

    // 3. Restart Steampipe so the kubernetes plugin reloads kubeconfig
    // The plugin caches ~/.kube/config at startup, so a restart is required
    try {
      execFileSync('steampipe', ['service', 'restart'], {
        encoding: 'utf-8',
        timeout: 30000,
        env: { ...process.env, HOME },
      });
    } catch {
      // Steampipe restart failed — data will appear after manual restart
    }

    const msg = added
      ? `kubeconfig + Steampipe connection registered for ${clusterName}.`
      : `kubeconfig updated for ${clusterName}.`;

    return NextResponse.json({ success: true, message: msg, needsRestart: false });
  } catch (e: any) {
    return NextResponse.json({
      success: false,
      error: e.stderr?.trim() || e.message || 'Unknown error',
    }, { status: 500 });
  }
}

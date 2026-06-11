import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';
import { registerCluster, unregisterCluster, isEnvCluster } from '@/lib/eks-registry';
import { hasAccessEntry, onboardingGuide } from '@/lib/eks-access';
import { listClusters } from '@/lib/aws';

export const dynamic = 'force-dynamic';

function json(obj: unknown, status: number) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

const CLUSTER_NAME_RE = /^[0-9A-Za-z][A-Za-z0-9-_]{0,99}$/; // EKS cluster-name charset — also guards the CLI guide against injected text

export async function POST(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
  if (!CLUSTER_NAME_RE.test(params.cluster)) return json({ status: 'error', message: 'invalid cluster name' }, 400);
  // Cluster must actually exist (spec §3.2 ①) — never emit a guide for arbitrary input.
  const known = (await listClusters()).some((c) => c.name === params.cluster);
  if (!known) return json({ status: 'error', message: 'unknown cluster' }, 404);
  // Terraform-managed clusters are already permanently allowed — idempotent no-op, no redundant DB row (P4 gate).
  if (isEnvCluster(params.cluster)) return json({ registered: true, managedBy: 'terraform' }, 200);
  const entry = await hasAccessEntry(params.cluster);
  if (entry !== true) {
    // No entry (or undeterminable) — hand back the v1-style guide instead of failing opaquely.
    // cluster echoed for idempotent-call debugging (PR #36 review suggestion).
    return json({ registered: false, cluster: params.cluster, access: entry === false ? 'no-entry' : 'unknown', guide: await onboardingGuide(params.cluster) }, 409);
  }
  const ok = await registerCluster(params.cluster, user.sub);
  if (!ok) return json({ status: 'error', message: 'registry storage unavailable' }, 503);
  return json({ registered: true }, 200);
}

export async function DELETE(request: Request, { params }: { params: { cluster: string } }) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) return json({ status: 'error', message: 'unauthenticated' }, 401);
  if (!(await isAdmin(user))) return json({ status: 'error', message: 'admin only' }, 403);
  if (isEnvCluster(params.cluster)) {
    return json({ status: 'error', message: 'Terraform(onboard_eks_clusters) 관할 — tfvars에서 제거하세요' }, 400);
  }
  // PR #36 review: not-found(404) vs storage-down(503) must be distinguishable — a DB
  // outage presented as "already unregistered" misleads the operator.
  const result = await unregisterCluster(params.cluster);
  if (result === 'deleted') return json({ unregistered: true }, 200);
  if (result === 'not-found') return json({ status: 'error', message: 'not registered' }, 404);
  return json({ status: 'error', message: '등록 저장소(Aurora)를 사용할 수 없습니다' }, 503);
}

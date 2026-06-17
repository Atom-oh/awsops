// THE allow-list swap-point for OpenCost. Today it parses ONBOARDED_EKS_CLUSTERS env
// (same as web/app/api/eks/[cluster]/incluster/route.ts:10). When the EKS-page buildout
// lands eks-registry, replace this body with `return (await isAllowed(cluster))` — a 1-line
// swap isolated here so no OpenCost route/page changes (consensus Decision 2).
export function isClusterOnboarded(cluster: string): boolean {
  const allow = (process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allow.includes(cluster);
}

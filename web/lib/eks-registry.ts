import { getPool } from './db';

// Single source for "which EKS clusters may the app query".
// Allow-list = ONBOARDED_EKS_CLUSTERS env (Terraform-managed, immutable here) ∪ eks_registrations (runtime).
// DB failure/absence degrades to env-only — existing clusters keep working (never throws).

const TTL_MS = 30_000;
let cache: { set: Set<string>; at: number } | null = null;

const dbOn = () => !!process.env.AURORA_ENDPOINT;

export function envClusters(): string[] {
  return (process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').filter(Boolean);
}

export function isEnvCluster(name: string): boolean {
  return envClusters().includes(name);
}

export function _resetForTests() { cache = null; }

export async function getAllowedClusters(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  const set = new Set(envClusters());
  if (dbOn()) {
    try {
      const r = await getPool().query(`SELECT cluster_name FROM eks_registrations`);
      for (const row of r.rows) set.add(row.cluster_name);
    } catch (e) {
      console.warn(`[eks-registry] falling back to env-only: ${e instanceof Error ? e.message : e}`);
    }
  }
  cache = { set, at: Date.now() };
  return set;
}

export async function isAllowed(cluster: string): Promise<boolean> {
  return (await getAllowedClusters()).has(cluster);
}

export async function registerCluster(cluster: string, userSub: string): Promise<boolean> {
  if (!dbOn()) return false;
  try {
    await getPool().query(
      `INSERT INTO eks_registrations (cluster_name, registered_by) VALUES ($1, $2)
       ON CONFLICT (cluster_name) DO NOTHING`,
      [cluster, userSub],
    );
  } catch (e) { // write failure degrades to "storage unavailable" (route → 503), never a 500
    console.warn(`[eks-registry] register failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  cache = null; // bust so the next read sees it immediately
  return true;
}

export async function unregisterCluster(cluster: string): Promise<boolean> {
  if (!dbOn()) return false;
  try {
    const r = await getPool().query(`DELETE FROM eks_registrations WHERE cluster_name = $1`, [cluster]);
    cache = null;
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    console.warn(`[eks-registry] unregister failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

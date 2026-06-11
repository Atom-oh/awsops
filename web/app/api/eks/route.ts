import { verifyUser } from '@/lib/auth';
import { listClusters } from '@/lib/aws';
import { getAllowedClusters, isEnvCluster } from '@/lib/eks-registry';
import { hasAccessEntry } from '@/lib/eks-access';
import { isAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export type AccessState = 'connected' | 'entry-only' | 'no-entry' | 'unknown';

export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const [clusters, allowed] = await Promise.all([listClusters(), getAllowedClusters()]);
    const rows = await Promise.all(clusters.map(async (c) => {
      let access: AccessState;
      const isEnv = isEnvCluster(c.name);
      if (allowed.has(c.name) && isEnv) {
        access = 'connected'; // Terraform guarantees the entry — skip the per-row API call
      } else {
        const entry = await hasAccessEntry(c.name);
        if (allowed.has(c.name)) {
          // runtime-registered: re-verify the entry (spec: connected = allowed AND entry) —
          // a revoked entry shows as no-entry again (guide + still unregisterable)
          access = entry === true ? 'connected' : entry === false ? 'no-entry' : 'unknown';
        } else {
          access = entry === true ? 'entry-only' : entry === false ? 'no-entry' : 'unknown';
        }
      }
      return { ...c, access, runtime: allowed.has(c.name) && !isEnv };
    }));
    const admin = await isAdmin(user);
    return Response.json({ clusters: rows, admin });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

import { verifyUser } from '@/lib/auth';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface EniRow { id: string; privateIp: string; publicIp: string | null; subnet: string | null; ips: number }

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

/**
 * EKS Node ENI panel (v1 parity): the node's EC2 network interfaces + IP capacity,
 * matched from the SYNCED ec2 inventory row by private DNS name — no live EC2 call.
 */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const node = new URL(request.url).searchParams.get('node') ?? '';
  if (!node) return Response.json({ status: 'error', message: 'node required' }, { status: 400 });
  try {
    const r = await getPool().query<{ id: string; data: Record<string, unknown> }>(
      `SELECT resource_id AS id, data FROM inventory_resources
       WHERE resource_type='ec2' AND (data->>'private_dns_name') = $1 LIMIT 1`,
      [node],
    );
    const row = r.rows[0];
    if (!row) return Response.json({ found: false });
    const d = row.data;
    const enis: EniRow[] = asArr(d.network_interfaces).map((e) => {
      const o = rec(e);
      const assoc = rec(pick(o, 'Association', 'association'));
      const priv = asArr(pick(o, 'PrivateIpAddresses', 'private_ip_addresses'));
      return {
        id: String(pick(o, 'NetworkInterfaceId', 'network_interface_id') ?? ''),
        privateIp: String(pick(o, 'PrivateIpAddress', 'private_ip_address') ?? ''),
        publicIp: typeof assoc.PublicIp === 'string' ? assoc.PublicIp : null,
        subnet: (pick(o, 'SubnetId', 'subnet_id') as string | undefined) ?? null,
        ips: priv.length || 1,
      };
    }).filter((e) => e.id);
    const maxEnis = Number(d.max_enis) || null;
    return Response.json({
      found: true,
      instanceId: row.id,
      instanceType: (d.instance_type as string | undefined) ?? null,
      maxEnis,
      eniCount: enis.length,
      totalIps: enis.reduce((s, e) => s + e.ips, 0),
      enis,
    });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

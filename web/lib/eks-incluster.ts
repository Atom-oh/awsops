import https from 'node:https';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { EKSClient, DescribeClusterCommand } from '@aws-sdk/client-eks';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';

/**
 * Replicate `aws eks get-token`: presign an STS GetCallerIdentity GET with the
 * `x-k8s-aws-id: <cluster>` header SIGNED, then `k8s-aws-v1.` + base64url(url).
 * The web task role's P1e Access Entry + AmazonEKSViewPolicy authorize the read.
 */
export async function eksToken(cluster: string, region: string): Promise<string> {
  const host = `sts.${region}.amazonaws.com`;
  const signer = new SignatureV4({ service: 'sts', region, sha256: Sha256, credentials: fromNodeProviderChain() });
  const req = new HttpRequest({
    method: 'GET', protocol: 'https:', hostname: host, path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host, 'x-k8s-aws-id': cluster }, // x-k8s-aws-id MUST be signed
  });
  const p = await signer.presign(req, { expiresIn: 60 });
  const qs = Object.entries(p.query as Record<string, string | string[]>)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v[0] : v)}`).join('&');
  const url = `https://${host}/?${qs}`;
  return `k8s-aws-v1.${Buffer.from(url).toString('base64url').replace(/=+$/, '')}`;
}

// ── cluster connection (endpoint + CA), 5-min in-memory cache ──────────────
export interface ClusterConn { endpoint: string; caPem: Buffer }
interface CacheEntry { conn: ClusterConn; at: number }
const CONN_TTL_MS = 5 * 60 * 1000;
const connCache = new Map<string, CacheEntry>();

let eks: EKSClient | null = null;
function eksClient(): EKSClient { if (!eks) eks = new EKSClient({ region: REGION }); return eks; }

export async function clusterConn(cluster: string): Promise<ClusterConn> {
  const cached = connCache.get(cluster);
  if (cached && Date.now() - cached.at < CONN_TTL_MS) return cached.conn;
  const { cluster: c } = await eksClient().send(new DescribeClusterCommand({ name: cluster }));
  const endpoint = c?.endpoint;
  const caData = c?.certificateAuthority?.data;
  if (!endpoint || !caData) throw new Error(`cluster ${cluster}: missing endpoint or certificateAuthority`);
  const conn: ClusterConn = { endpoint, caPem: Buffer.from(caData, 'base64') };
  connCache.set(cluster, { conn, at: Date.now() });
  return conn;
}

// ── in-cluster list + normalize ────────────────────────────────────────────
export type Kind = 'nodes' | 'pods' | 'deployments' | 'services' | 'namespaces';

const KIND_PATH: Record<Kind, string> = {
  nodes: '/api/v1/nodes',
  pods: '/api/v1/pods',
  deployments: '/apis/apps/v1/deployments',
  services: '/api/v1/services',
  namespaces: '/api/v1/namespaces',
};

export function isKind(k: string): k is Kind {
  return k === 'nodes' || k === 'pods' || k === 'deployments' || k === 'services' || k === 'namespaces';
}

/** ISO timestamp → compact age like "3d", "5h", "12m", "8s". */
function age(ts?: string): string {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// minimal K8s shapes (only the fields we read)
interface K8sList { items?: K8sItem[]; message?: string; kind?: string }
interface K8sItem {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> };
  status?: {
    conditions?: { type?: string; status?: string }[];
    nodeInfo?: { kubeletVersion?: string };
    phase?: string;
    containerStatuses?: { restartCount?: number }[];
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
  spec?: {
    nodeName?: string;
    replicas?: number;
    type?: string;
    clusterIP?: string;
    ports?: { port?: number; protocol?: string }[];
  };
}

export interface NodeRow { name: string; status: string; roles: string; version: string; instanceType: string; zone: string; age: string }
export interface PodRow { name: string; namespace: string; status: string; node: string; restarts: number; age: string }
export interface DeploymentRow { name: string; namespace: string; ready: string; upToDate: number; available: number; age: string }
export interface ServiceRow { name: string; namespace: string; type: string; clusterIP: string; ports: string; age: string }
export interface NamespaceRow { name: string; status: string; age: string }
export type InClusterRow = NodeRow | PodRow | DeploymentRow | ServiceRow | NamespaceRow;

function nodeRoles(labels: Record<string, string> = {}): string {
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);
  return roles.length ? roles.join(',') : '<none>';
}

export function normalizeNode(it: K8sItem): NodeRow {
  const labels = it.metadata?.labels ?? {};
  const ready = it.status?.conditions?.find((c) => c.type === 'Ready');
  return {
    name: it.metadata?.name ?? '',
    status: ready?.status === 'True' ? 'Ready' : 'NotReady',
    roles: nodeRoles(labels),
    version: it.status?.nodeInfo?.kubeletVersion ?? '',
    instanceType: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? '',
    zone: labels['topology.kubernetes.io/zone'] ?? labels['failure-domain.beta.kubernetes.io/zone'] ?? '',
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizePod(it: K8sItem): PodRow {
  const restarts = (it.status?.containerStatuses ?? []).reduce((s, c) => s + (c.restartCount ?? 0), 0);
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    status: it.status?.phase ?? '',
    node: it.spec?.nodeName ?? '',
    restarts,
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizeDeployment(it: K8sItem): DeploymentRow {
  const desired = it.spec?.replicas ?? 0;
  const ready = it.status?.readyReplicas ?? 0;
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    ready: `${ready}/${desired}`,
    upToDate: it.status?.updatedReplicas ?? 0,
    available: it.status?.availableReplicas ?? 0,
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizeService(it: K8sItem): ServiceRow {
  const ports = (it.spec?.ports ?? [])
    .map((p) => `${p.port}${p.protocol ? `/${p.protocol}` : ''}`)
    .join(',');
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    type: it.spec?.type ?? '',
    clusterIP: it.spec?.clusterIP ?? '',
    ports,
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizeNamespace(it: K8sItem): NamespaceRow {
  return {
    name: it.metadata?.name ?? '',
    status: it.status?.phase ?? '',
    age: age(it.metadata?.creationTimestamp),
  };
}

const NORMALIZERS: Record<Kind, (it: K8sItem) => InClusterRow> = {
  nodes: normalizeNode,
  pods: normalizePod,
  deployments: normalizeDeployment,
  services: normalizeService,
  namespaces: normalizeNamespace,
};

/** HTTPS GET against the cluster K8s API, verifying TLS with the cluster CA. */
function k8sGet(endpoint: string, path: string, token: string, caPem: Buffer): Promise<string> {
  const u = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        agent: new https.Agent({ ca: caPem }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let msg = `HTTP ${status}`;
            try { msg = (JSON.parse(body) as { message?: string }).message ?? msg; } catch { /* keep msg */ }
            reject(new Error(msg));
            return;
          }
          resolve(body);
        });
      },
    );
    r.on('error', reject);
    r.end();
  });
}

export async function listInCluster(cluster: string, kind: Kind): Promise<InClusterRow[]> {
  const { endpoint, caPem } = await clusterConn(cluster);
  const token = await eksToken(cluster, REGION);
  const body = await k8sGet(endpoint, KIND_PATH[kind], token, caPem);
  const parsed = JSON.parse(body) as K8sList;
  const norm = NORMALIZERS[kind];
  return (parsed.items ?? []).map(norm);
}

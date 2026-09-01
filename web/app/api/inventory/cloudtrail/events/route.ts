import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { verifyUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let ct: CloudTrailClient | null = null;
const ctClient = () => (ct ??= new CloudTrailClient({ region: REGION }));

export interface TrailEvent {
  time: string; name: string; source: string; user: string;
  resourceType: string; resourceName: string; readOnly: boolean;
  // Drill-down fields (gap L62) — from the SAME LookupEvents response (no new AWS surface).
  eventId: string;
  awsRegion: string;
  sourceIPAddress: string;
  userAgent: string;
  errorCode: string;
  /** Every resource on the event (the table shows only the first). */
  resources: { type: string; name: string }[];
  /** The parsed CloudTrailEvent payload; null when the JSON was malformed. */
  raw: Record<string, unknown> | null;
}

/** Recent CloudTrail events (v1 parity: last 20, live LookupEvents). ?write=1 → write-only audit view. */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const writeOnly = new URL(request.url).searchParams.get('write') === '1';
  try {
    const r = await ctClient().send(new LookupEventsCommand({
      MaxResults: 20,
      ...(writeOnly ? { LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }] } : {}),
    }));
    const events: TrailEvent[] = (r.Events ?? []).map((e) => {
      // The payload was already parsed for readOnly and thrown away — keep it for the
      // drill-down panel (gap L62). Malformed JSON → raw:null, the row still renders.
      let raw: Record<string, unknown> | null = null;
      try { raw = JSON.parse(e.CloudTrailEvent ?? '') as Record<string, unknown>; } catch { /* keep null */ }
      const readOnly = raw?.readOnly !== false;
      const res = e.Resources?.[0];
      return {
        time: e.EventTime instanceof Date ? e.EventTime.toISOString() : String(e.EventTime ?? ''),
        name: e.EventName ?? '',
        source: e.EventSource ?? '',
        user: e.Username ?? '',
        resourceType: res?.ResourceType?.replace(/^AWS::/, '') ?? '',
        resourceName: res?.ResourceName ?? '',
        readOnly,
        eventId: e.EventId ?? '',
        awsRegion: typeof raw?.awsRegion === 'string' ? raw.awsRegion : '',
        sourceIPAddress: typeof raw?.sourceIPAddress === 'string' ? raw.sourceIPAddress : '',
        userAgent: typeof raw?.userAgent === 'string' ? raw.userAgent : '',
        errorCode: typeof raw?.errorCode === 'string' ? raw.errorCode : '',
        resources: (e.Resources ?? []).map((x) => ({
          type: x.ResourceType?.replace(/^AWS::/, '') ?? '', name: x.ResourceName ?? '',
        })),
        raw,
      };
    });
    return Response.json({ events });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

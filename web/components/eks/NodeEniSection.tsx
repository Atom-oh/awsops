'use client';
import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';

interface EniRow { id: string; privateIp: string; publicIp: string | null; subnet: string | null; ips: number }
interface NodeEni {
  found: boolean; instanceId?: string; instanceType?: string | null;
  maxEnis?: number | null; eniCount?: number; totalIps?: number; enis?: EniRow[];
}

/** 노드 ENI 패널 (v1 parity): 노드의 EC2 네트워크 인터페이스 + IP 용량 — 동기화된 ec2 행에서 매칭. */
export default function NodeEniSection({ nodeName }: { nodeName: string }) {
  const { tt } = useI18n();
  const [d, setD] = useState<NodeEni | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setD(null); setErr(false);
    fetch(`/api/eks/node-eni?node=${encodeURIComponent(nodeName)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (alive) setD(body); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [nodeName]);

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-700">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-600"><Network size={12} /></span>
        {tt('네트워크 인터페이스 (ENI)')}
      </h3>
      {!d && !err && <p className="text-[12px] text-ink-400">{tt('조회 중…')}</p>}
      {(err || (d && !d.found)) && <p className="text-[12px] text-ink-300">{tt('인벤토리에서 노드 인스턴스를 찾지 못했습니다')}</p>}
      {d?.found && (
        <>
          <p className="mb-2 text-[12px] text-ink-600">
            <span className="font-mono text-[11px] text-ink-500">{d.instanceId}</span>
            {d.instanceType && <span> · {d.instanceType}</span>}
            <span> · ENI {d.eniCount}{d.maxEnis ? ` / max ${d.maxEnis}` : ''} · {tt(`IP ${d.totalIps}개`)}</span>
          </p>
          <ul className="flex flex-col gap-1.5">
            {(d.enis ?? []).map((e) => (
              <li key={e.id} className="rounded-md border border-ink-100 bg-paper-muted/40 px-2 py-1.5 text-[12px]">
                <span className="font-mono text-[11px] text-brand-700">{e.id}</span>
                <span className="ml-2 text-ink-700">{e.privateIp}</span>
                {e.publicIp && <span className="ml-2 text-ink-500">(pub {e.publicIp})</span>}
                {e.subnet && <span className="ml-2 font-mono text-[10.5px] text-ink-400">{e.subnet}</span>}
                <span className="ml-2 text-[10.5px] text-ink-400">IP {e.ips}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

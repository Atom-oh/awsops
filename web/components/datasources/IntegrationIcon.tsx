import {
  Flame, Database, ScrollText, Waypoints, LineChart, NotebookPen, Plug, type LucideIcon,
} from 'lucide-react';

// Per-kind brand icon so datasources/connectors are visually distinguishable across the Integrations
// hub (table rows, connector cards, the form Type selector). A lucide glyph (guaranteed to render) in
// the brand color on a tinted rounded tile — brand-accurate SVG logos can be swapped in later without
// touching any call site. Glyphs are chosen to read as the signal type: flame=Prometheus, db=ClickHouse,
// scroll=Loki(logs), waypoints=Tempo(traces), line=Mimir(metrics), notebook=Notion.
interface KindStyle { Icon: LucideIcon; color: string; title: string; }

const KINDS: Record<string, KindStyle> = {
  prometheus: { Icon: Flame, color: '#E6522C', title: 'Prometheus' },
  clickhouse: { Icon: Database, color: '#B58900', title: 'ClickHouse' },
  loki: { Icon: ScrollText, color: '#D9A406', title: 'Loki' },
  tempo: { Icon: Waypoints, color: '#7C3AED', title: 'Tempo' },
  mimir: { Icon: LineChart, color: '#4F46E5', title: 'Mimir' },
  notion: { Icon: NotebookPen, color: '#0F172A', title: 'Notion' },
};

const FALLBACK: KindStyle = { Icon: Plug, color: '#64748b', title: 'Integration' };

/** 6-digit hex → ~12%-alpha background tile; non-hex → a neutral tint. */
function tint(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}1f` : 'rgba(100,116,139,0.12)';
}

export default function IntegrationIcon({
  kind, size = 18, className = '',
}: { kind: string; size?: number; className?: string }) {
  const style = KINDS[kind] ?? { ...FALLBACK, title: kind || FALLBACK.title };
  const box = size + 10;
  return (
    <span
      role="img"
      aria-label={style.title}
      title={style.title}
      className={`inline-flex shrink-0 items-center justify-center rounded-md ${className}`}
      style={{ width: box, height: box, backgroundColor: tint(style.color), color: style.color }}
    >
      <style.Icon size={size} strokeWidth={2} aria-hidden />
    </span>
  );
}

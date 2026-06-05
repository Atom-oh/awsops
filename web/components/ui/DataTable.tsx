export interface Column { key: string; label: string }

export default function DataTable({ columns, rows }: { columns: Column[]; rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <div style={{ padding: 24, color: '#7da2c9', textAlign: 'center' }}>데이터 없음</div>;
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>{columns.map((c) => (
          <th key={c.key} style={{ textAlign: 'left', padding: '8px 10px', color: '#7da2c9', borderBottom: '1px solid #1a2540', fontWeight: 600 }}>{c.label}</th>
        ))}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map((c) => (
            <td key={c.key} style={{ padding: '8px 10px', color: '#bcd6f2', borderBottom: '1px solid #131d31' }}>{String(row[c.key] ?? '')}</td>
          ))}</tr>
        ))}
      </tbody>
    </table>
  );
}

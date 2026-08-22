import React from 'react';

export function Table({ columns = [], rows = [] }) {
  return (
    <div style={{ overflowX: 'auto', fontFamily: 'var(--font-bn)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{
                textAlign: c.align || 'left', padding: '10px 12px', fontSize: 12, fontWeight: 600,
                color: 'var(--color-text-muted)', borderBottom: '1px solid var(--color-border)',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left', padding: '12px', color: 'var(--color-text)' }}>
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

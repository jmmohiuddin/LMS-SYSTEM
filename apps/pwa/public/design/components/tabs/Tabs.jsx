import React from 'react';

export function Tabs({ items = [], active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', fontFamily: 'var(--font-bn)' }}>
      {items.map((it) => {
        const isActive = it.value === active;
        return (
          <button key={it.value} type="button" onClick={() => onChange && onChange(it.value)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 16px', fontSize: 14, fontWeight: 600,
              color: isActive ? 'var(--color-primary)' : 'var(--color-text-muted)',
              borderBottom: isActive ? '2px solid var(--color-primary)' : '2px solid transparent',
              marginBottom: -1,
            }}>{it.label}</button>
        );
      })}
    </div>
  );
}

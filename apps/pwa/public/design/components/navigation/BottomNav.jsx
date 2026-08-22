import React from 'react';

export function BottomNav({ items = [], active }) {
  // Shell constraint carried over from the app: 5 tabs max, the rest sits behind "আরও".
  const bar = items.slice(0, 5);
  return (
    <nav style={{
      display: 'flex', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg)',
      fontFamily: 'var(--font-bn)', boxShadow: '0 -2px 8px rgba(15,23,42,0.04)',
    }}>
      {bar.map((it) => {
        const isActive = it.value === active;
        return (
          <button key={it.value} type="button" style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            padding: '10px 4px', minHeight: 56, background: 'none', border: 'none', cursor: 'pointer',
            color: isActive ? 'var(--color-primary)' : 'var(--color-text-muted)',
          }}>
            <span aria-hidden="true" style={{ width: 22, height: 22, display: 'flex' }}>{it.icon}</span>
            <span style={{ fontSize: 11, fontWeight: isActive ? 600 : 500 }}>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

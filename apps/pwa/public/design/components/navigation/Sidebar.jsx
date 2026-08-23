import React from 'react';

export function Sidebar({ items = [], active, brand = 'ShikhonBD' }) {
  return (
    <nav style={{
      width: 240, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)',
      display: 'flex', flexDirection: 'column', gap: 2, padding: 16, fontFamily: 'var(--font-bn)', height: '100%',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 20px', fontWeight: 700, fontSize: 16, color: 'var(--color-text)' }}>
        {brand}
      </div>
      {items.map((it) => {
        const isActive = it.value === active;
        return (
          <a key={it.value} href="#" style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
            borderRadius: 'var(--radius-md)', textDecoration: 'none',
            background: isActive ? 'var(--color-primary-soft)' : 'transparent',
            color: isActive ? 'var(--color-primary)' : 'var(--color-text)',
            fontWeight: isActive ? 600 : 500, fontSize: 14,
          }}>
            <span aria-hidden="true" style={{ width: 20, height: 20, display: 'flex' }}>{it.icon}</span>
            {it.label}
          </a>
        );
      })}
    </nav>
  );
}

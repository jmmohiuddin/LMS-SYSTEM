import React from 'react';

export function Card({ kicker, title, meta, children, padding = 20 }) {
  return (
    <div style={{
      background: 'var(--color-bg)', border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding,
      fontFamily: 'var(--font-bn)',
    }}>
      {kicker && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{kicker}</div>}
      {title && <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>{title}</div>}
      {children}
      {meta && <div style={{ fontSize: 12, color: 'var(--color-text-faint)', marginTop: 8 }}>{meta}</div>}
    </div>
  );
}

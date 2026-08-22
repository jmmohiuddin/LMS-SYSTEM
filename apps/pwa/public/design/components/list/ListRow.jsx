import React from 'react';

export function ListRow({ leading, title, subtitle, trailing, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px',
        borderBottom: '1px solid var(--color-border)', fontFamily: 'var(--font-bn)',
        cursor: onClick ? 'pointer' : 'default', minHeight: 48,
      }}
    >
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      {trailing}
    </div>
  );
}

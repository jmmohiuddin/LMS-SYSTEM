import React from 'react';

export function Select({ label, options = [], value, onChange }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-bn)' }}>
      {label && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>{label}</span>}
      <select
        value={value}
        onChange={onChange}
        style={{
          height: 48, padding: '0 14px', fontSize: 14, fontFamily: 'inherit',
          borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border-strong)',
          background: 'var(--color-bg)', color: 'var(--color-text)', outline: 'none',
        }}
      >
        {options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </label>
  );
}

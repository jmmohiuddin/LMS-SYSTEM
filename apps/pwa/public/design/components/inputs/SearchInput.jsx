import React from 'react';

export function SearchInput({ placeholder = 'খুঁজুন...', value, onChange }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, height: 48, padding: '0 14px',
      borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)',
      background: 'var(--color-surface)',
    }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.75" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        placeholder={placeholder} value={value} onChange={onChange}
        style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 14, fontFamily: 'var(--font-bn)', color: 'var(--color-text)', width: '100%' }}
      />
    </div>
  );
}

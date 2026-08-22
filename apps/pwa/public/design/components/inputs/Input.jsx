import React from 'react';

export function Input({ label, placeholder, value, onChange, error, type = 'text' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-bn)' }}>
      {label && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>{label}</span>}
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        style={{
          height: 48, padding: '0 14px', fontSize: 14, fontFamily: 'inherit',
          borderRadius: 'var(--radius-md)',
          border: `1px solid ${error ? 'var(--color-danger)' : 'var(--color-border-strong)'}`,
          background: 'var(--color-bg)', color: 'var(--color-text)', outline: 'none',
        }}
      />
      {error && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{error}</span>}
    </label>
  );
}

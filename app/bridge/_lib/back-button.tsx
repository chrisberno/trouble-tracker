// app/bridge/_lib/back-button.tsx
//
// Client-side back-nav for /bridge/* pages. Fires window.history.back() so
// the user can step back through their iframe navigation (list ↔ detail).
//
// If history is empty (cold load), falls back to fallbackHref if provided,
// otherwise no-op (anchor href = '#'). The list page is typically the entry
// point so history.back() may not have anywhere to go — that's fine, the
// button just becomes a no-op on the first load.

'use client';

export function BackButton({ fallbackHref }: { fallbackHref?: string }) {
  return (
    <a
      href={fallbackHref ?? '#'}
      onClick={(e) => {
        if (typeof window !== 'undefined' && window.history.length > 1) {
          e.preventDefault();
          window.history.back();
        }
        // else: let the fallbackHref (or default '#') handle it
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: '13px',
        color: '#2563eb',
        textDecoration: 'none',
        padding: '4px 8px',
        marginLeft: '-8px',
        marginBottom: '12px',
        borderRadius: '6px',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <span style={{ fontSize: '16px', lineHeight: 1 }}>←</span>
      <span>Back</span>
    </a>
  );
}

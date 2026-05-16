// app/bridge/_lib/iframe-blocker.tsx
//
// Friendly blocker UI shown when the iframe-gate check fails on a /bridge/*
// page. Server-rendered; matches the inline-style design language of
// app/bridge/tickets/page.tsx.
//
// Log the reason on render so we can audit blocked attempts via Vercel logs.

import type { IframeGateResult } from './iframe-gate';

export function IframeBlocker({ result }: { result: Extract<IframeGateResult, { allowed: false }> }) {
  // Server-side log for audit.
  console.warn(
    JSON.stringify({
      bridge_iframe_blocked: true,
      reason: result.reason,
      referer: result.referer,
      host: result.host,
    }),
  );

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        backgroundColor: '#f9fafb',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '480px',
          padding: '32px',
          backgroundColor: 'white',
          borderRadius: '8px',
          border: '1px solid #e5e7eb',
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '20px',
            fontWeight: 700,
            color: '#111827',
            marginTop: 0,
            marginBottom: '12px',
          }}
        >
          Not available outside the Connie portal
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: '#4b5563',
            marginBottom: '16px',
            lineHeight: 1.5,
          }}
        >
          This page is only accessible from inside the Connie CRM container.
          Please access it via your Connie support portal.
        </p>
        <details
          style={{
            fontSize: '12px',
            color: '#6b7280',
            textAlign: 'left',
            backgroundColor: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: '4px',
            padding: '8px 10px',
          }}
        >
          <summary style={{ cursor: 'pointer', userSelect: 'none' }}>Diagnostic info</summary>
          <div style={{ marginTop: '8px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
            <div>reason: {result.reason}</div>
            <div>referer: {result.referer || '(none)'}</div>
            <div>host: {result.host ?? '(none)'}</div>
          </div>
        </details>
      </div>
    </div>
  );
}

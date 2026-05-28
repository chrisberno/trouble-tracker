// app/bridge/twilio-flex/ticket/[id]/TicketActions.tsx
// Client-side action footer for the iframe page.
//
// Phase 3 v2 (2026-05-04): three write actions — status flip + customer reply
// + internal note. Customer reply is the new addition (replaces the
// "agent replies via Twilio Conversation in WorkBench" pathway from the
// original brief; that pathway depended on the Flex Interactions API which
// we pivoted away from).
//
// Color coding for clarity at a glance:
//   - Update status     → blue   (action button)
//   - Reply to customer → blue   (customer-facing; visible to customer)
//   - Add internal note → green  (internal-only; agent eyes only)
//
// All three POST to thin Next.js API routes; server-side calls pp-client.
// Browser never holds the PP.app token.

'use client';

import { useState } from 'react';

type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';

const FLIPPABLE_STATUSES: TicketStatus[] = ['open', 'in_progress', 'closed'];

interface Props {
  ticketId: string;
  currentStatus: TicketStatus;
  // S6: 'client' trims this footer to a customer-appropriate view — no
  // internal-note box, "Reply" not "Reply to customer". Default 'agent'
  // renders identically to pre-S6 (the agent canvas sends no viewerMode).
  viewerMode?: 'agent' | 'client';
}

export function TicketActions({ ticketId, currentStatus, viewerMode = 'agent' }: Props) {
  const isClient = viewerMode === 'client';
  const [selectedStatus, setSelectedStatus] = useState<TicketStatus>(
    FLIPPABLE_STATUSES.includes(currentStatus) ? currentStatus : 'open',
  );
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const [replyBody, setReplyBody] = useState('');
  const [replyMsg, setReplyMsg] = useState<string | null>(null);
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyErr, setReplyErr] = useState<string | null>(null);

  const [noteBody, setNoteBody] = useState('');
  const [noteMsg, setNoteMsg] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<string | null>(null);

  async function handleStatusFlip(): Promise<void> {
    setStatusBusy(true);
    setStatusMsg(null);
    setStatusErr(null);
    try {
      const res = await fetch('/api/bridge/twilio-flex/status-flip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, status: selectedStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatusErr(data.error ?? `Failed (${res.status})`);
      } else {
        setStatusMsg(`Status updated to ${data.status}`);
      }
    } catch (err) {
      setStatusErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleCustomerReply(): Promise<void> {
    if (!replyBody.trim()) return;
    setReplyBusy(true);
    setReplyMsg(null);
    setReplyErr(null);
    try {
      const res = await fetch('/api/bridge/twilio-flex/customer-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, body: replyBody }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReplyErr(data.error ?? `Failed (${res.status})`);
      } else {
        setReplyMsg(`Reply sent (id ${data.replyId})`);
        setReplyBody('');
      }
    } catch (err) {
      setReplyErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setReplyBusy(false);
    }
  }

  async function handleAddNote(): Promise<void> {
    if (!noteBody.trim()) return;
    setNoteBusy(true);
    setNoteMsg(null);
    setNoteErr(null);
    try {
      const res = await fetch('/api/bridge/twilio-flex/internal-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, body: noteBody }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNoteErr(data.error ?? `Failed (${res.status})`);
      } else {
        setNoteMsg(`Note added (id ${data.replyId})`);
        setNoteBody('');
      }
    } catch (err) {
      setNoteErr(err instanceof Error ? err.message : 'Network error');
    } finally {
      setNoteBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">{isClient ? 'Actions' : 'Agent actions'}</h2>

      <div>
        <label className="block text-xs text-gray-600 mb-1">Update status</label>
        <div className="flex items-center gap-2">
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value as TicketStatus)}
            disabled={statusBusy}
            className="border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
          >
            {FLIPPABLE_STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace('_', ' ')}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleStatusFlip}
            disabled={statusBusy || selectedStatus === currentStatus}
            className="bg-blue-600 text-white px-3 py-1 text-sm rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {statusBusy ? 'Updating…' : 'Update'}
          </button>
          {statusMsg && <span className="text-xs text-green-700">{statusMsg}</span>}
          {statusErr && <span className="text-xs text-red-600">{statusErr}</span>}
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-600 mb-1">{isClient ? 'Reply' : 'Reply to customer'}</label>
        <textarea
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          placeholder={isClient ? 'Add a reply to this ticket' : 'Customer-visible reply (will appear on the ticket)'}
          rows={3}
          disabled={replyBusy}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            type="button"
            onClick={handleCustomerReply}
            disabled={replyBusy || !replyBody.trim()}
            className="bg-blue-600 text-white px-3 py-1 text-sm rounded hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {replyBusy ? 'Sending…' : 'Send reply'}
          </button>
          {replyMsg && <span className="text-xs text-green-700">{replyMsg}</span>}
          {replyErr && <span className="text-xs text-red-600">{replyErr}</span>}
        </div>
      </div>

      {/* Internal note — AGENT ONLY (S6). Never render for a client viewer:
          it's a staff-eyes-only channel and the box must not be reachable. */}
      {!isClient && (
      <div>
        <label className="block text-xs text-gray-600 mb-1">Add internal note</label>
        <textarea
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
          placeholder="Internal note (visible only to agents)"
          rows={3}
          disabled={noteBusy}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:bg-gray-100"
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            type="button"
            onClick={handleAddNote}
            disabled={noteBusy || !noteBody.trim()}
            className="bg-green-600 text-white px-3 py-1 text-sm rounded hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {noteBusy ? 'Adding…' : 'Add note'}
          </button>
          {noteMsg && <span className="text-xs text-green-700">{noteMsg}</span>}
          {noteErr && <span className="text-xs text-red-600">{noteErr}</span>}
        </div>
      </div>
      )}
    </div>
  );
}

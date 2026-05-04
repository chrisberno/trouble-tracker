// app/bridge/twilio-flex/ticket/[id]/TicketActions.tsx
// Client-side action footer for the iframe page.
// Two write actions: status flip + add internal note.
// Both POST to thin Next.js API routes (server-side calls pp-client).
// Browser never holds the PP.app token.

'use client';

import { useState } from 'react';

type TicketStatus = 'open' | 'in_progress' | 'waiting' | 'resolved' | 'closed';

const FLIPPABLE_STATUSES: TicketStatus[] = ['open', 'in_progress', 'closed'];

interface Props {
  ticketId: string;
  currentStatus: TicketStatus;
}

export function TicketActions({ ticketId, currentStatus }: Props) {
  const [selectedStatus, setSelectedStatus] = useState<TicketStatus>(
    FLIPPABLE_STATUSES.includes(currentStatus) ? currentStatus : 'open',
  );
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);

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
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Agent actions</h2>

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
        <label className="block text-xs text-gray-600 mb-1">Add internal note</label>
        <textarea
          value={noteBody}
          onChange={(e) => setNoteBody(e.target.value)}
          placeholder="Internal note (visible only to agents)"
          rows={3}
          disabled={noteBusy}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
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
    </div>
  );
}

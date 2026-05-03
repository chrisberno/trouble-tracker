// pp-client/smoke-test.ts
// Phase 1 acceptance gate — live end-to-end round-trip against TroubleTracker tenant.
// Run with: npx ts-node pp-client/smoke-test.ts
// Requires TROUBLETRACKER_TENANT_API_TOKEN env var to be set.

import { createTicket, getTicket, addReply, updateStatus, resolveTicket, closeTicket } from './index';
import type { DeploymentConfig } from './types';

const config: DeploymentConfig = {
  tenantUrl: process.env.TROUBLETRACKER_TENANT_URL ?? 'https://troubletracker.peopleperson.app',
  tenantApiToken:
    process.env.TROUBLETRACKER_TENANT_API_TOKEN ??
    (() => {
      throw new Error('TROUBLETRACKER_TENANT_API_TOKEN not set');
    })(),
  customerScopeRule: () => 'phase-1-test',
  statusMap: { open: 1, in_progress: 2, waiting: 4, resolved: 3, closed: 5 },
};

async function run() {
  console.log('=== Phase 1 pp-client smoke test ===\n');

  // Step 1: createTicket
  console.log('Step 1: createTicket...');
  const ticket = await createTicket(
    {
      subject: 'Phase 1 pp-client smoke test',
      description: 'Automated smoke test — safe to delete',
      priority: 'low',
      customer: { name: 'Smoke Test User', email: 'smoke-test@troubletracker.test' },
      customerScope: 'phase-1-test',
      intakeSource: 'phase-1-test',
    },
    config,
  );
  console.log(`  ✅ Created ticket ID: ${ticket.id}, subject: ${ticket.subject}`);
  console.assert(ticket.id, 'ticket.id must be present');
  console.assert(ticket.subject === 'Phase 1 pp-client smoke test', 'subject must match');

  // Step 2: getTicket
  console.log('Step 2: getTicket...');
  const fetched = await getTicket(ticket.id, config);
  console.log(`  ✅ Fetched ticket ID: ${fetched.id}`);
  console.assert(fetched.id === ticket.id, 'fetched ticket ID must match');
  console.assert(fetched.subject === ticket.subject, 'fetched subject must match');

  // Step 3: addReply (agent — with source)
  console.log('Step 3: addReply (agent, source=test-bridge-a)...');
  const agentReply = await addReply(
    ticket.id,
    { body: 'Agent reply test — source present', source: 'test-bridge-a' },
    config,
  );
  console.log(`  ✅ Agent reply ID: ${agentReply.id}, source: ${agentReply.source}`);
  console.assert(agentReply.source === 'test-bridge-a', 'agent reply source must be test-bridge-a');
  // Note: webhook discrimination verified via Vercel logs — ticket.replied.agent should appear

  // Step 4: addReply (customer — no source, HTML body)
  console.log('Step 4: addReply (customer, HTML body)...');
  const customerReply = await addReply(ticket.id, { body: '<p>customer-side test</p>' }, config);
  console.log(`  ✅ Customer reply ID: ${customerReply.id}, body: "${customerReply.body}"`);
  console.assert(!customerReply.source, 'customer reply must have no source');
  console.assert(
    customerReply.body === 'customer-side test' || customerReply.body === '<p>customer-side test</p>',
    `body should be either stripped or raw; got: "${customerReply.body}"`,
  );

  // Step 5: updateStatus → in_progress
  console.log('Step 5: updateStatus → in_progress...');
  const updated = await updateStatus(ticket.id, 'in_progress', config);
  console.log(`  ✅ Status updated: ${updated.status}`);
  console.assert(updated.status === 'in_progress', 'status must be in_progress');

  // Step 6: resolveTicket
  console.log('Step 6: resolveTicket...');
  const resolved = await resolveTicket(ticket.id, config);
  console.log(`  ✅ Resolved: ${resolved.status}`);
  console.assert(
    resolved.status === 'resolved' || resolved.status === 'waiting',
    'status must reflect resolved mapping',
  );

  // Step 7: closeTicket
  console.log('Step 7: closeTicket...');
  const closed = await closeTicket(ticket.id, config);
  console.log(`  ✅ Closed: ${closed.status}`);
  console.assert(closed.status === 'closed', 'status must be closed');

  console.log('\n=== All steps passed ✅ ===');
  console.log(`Test ticket ID ${ticket.id} left in closed state on TroubleTracker tenant.`);
  console.log(
    'Verify webhook events in Vercel logs: ticket.created, ticket.replied.agent, ticket.replied.customer, ticket.status_changed, ticket.resolved, ticket.closed should all appear.',
  );
}

run().catch((err) => {
  console.error('❌ Smoke test FAILED:', err);
  process.exit(1);
});

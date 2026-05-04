// adapters/bridge/human/twilio-flex/index.ts
// Public surface of the Twilio Flex bridge. Consumers import ONLY from here.
// Per Manifesto v2.2 Bridge Contract — no Twilio specifics leak to other adapters
// or to pp-client; pp-client specifics don't leak in here.

export { register } from './register';
export { buildTwilioClient } from './twilio-client';
export type { TwilioBridgeConfig, BridgeSource } from './types';
export { BRIDGE_METADATA } from './types';

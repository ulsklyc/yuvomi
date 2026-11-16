// Sender fixture (phase 1b, F13): providers and the push service handed in as parameters.
// No import rule sees these calls; the lint selectors CHANNEL-SEND and PUSH-SEND do.
// test:lint-baseline expects exactly the marked lines.
/**
 * @param {any} providers @param {any} provider @param {any} p @param {any} channel
 * @param {any} payload @param {any} pushService @param {any} webpush
 * @param {any} svc @param {any} deps
 * @this {any}
 */
export async function handed(providers, provider, p, channel, payload, pushService, webpush, svc, deps) {
  await provider.send({ channel, payload });                    // channel-1 (name and shape)
  await providers[channel.provider].send({ payload, channel }); // channel-2 (name and shape)
  await p.send({ channel: channel, payload });                  // channel-3 (shape: any name)
  await provider?.send(payload);                                // channel-4 (name, optional call)
  await pushService.sendPushToUser(1, payload);                 // push-1
  await webpush.sendNotification(channel, payload);             // push-2
  await this.providers[channel.provider].send(payload);         // channel-5 (name behind this)
  await svc.providers[channel.provider].send(payload);          // channel-6 (name behind a member)
  await deps.provider.send(payload);                            // channel-7 (name as the last member)
  await svc['providers'][channel.provider].send(payload);       // channel-8 (name as a computed key)
  await p.send(payload);                                        // allowed: no channel key, no provider name
  const { send } = provider;
  await send(payload);                                          // blind spot: a destructured send has no object
  const q = provider;
  await q.send(payload);                                        // blind spot: an alias carries no provider name
  return p.send({ ...channel });                                // blind spot: a spread hides the key
}

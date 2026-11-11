// Sender fixture (phase 1b, F13): providers and the push service handed in as parameters.
// No import rule sees these calls; the lint selectors CHANNEL-SEND and PUSH-SEND do.
// test:lint-baseline expects exactly the marked lines.
/**
 * @param {any} providers @param {any} provider @param {any} p @param {any} channel
 * @param {any} payload @param {any} pushService @param {any} webpush
 */
export async function handed(providers, provider, p, channel, payload, pushService, webpush) {
  await provider.send({ channel, payload });                    // channel-1 (name and shape)
  await providers[channel.provider].send({ payload, channel }); // channel-2 (name and shape)
  await p.send({ channel: channel, payload });                  // channel-3 (shape: any name)
  await provider?.send(payload);                                // channel-4 (name, optional call)
  await pushService.sendPushToUser(1, payload);                 // push-1
  await webpush.sendNotification(channel, payload);             // push-2
  await p.send(payload);                                        // allowed: no channel key, no provider name
  return p.send({ ...channel });                                // blind spot: a spread hides the key
}

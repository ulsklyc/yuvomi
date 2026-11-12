// Sender fixture (phase 1b, F13): a fifth file that imports the bottleneck.
import { sendToChannel } from './channel-delivery.js';            // channel-delivery-importers
export const fifth = () => sendToChannel;

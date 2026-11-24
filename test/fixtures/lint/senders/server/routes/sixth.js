// Sender fixture (phase 1b, F13): a route that imports a provider module past the bottleneck.
import { gotifyProvider } from '../services/notification-providers/gotify.js'; // providers-only-in-channel-delivery
export const sixth = () => gotifyProvider;

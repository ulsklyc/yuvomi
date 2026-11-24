import { sendToChannel } from './channel-delivery.js';            // allowed: a named importer
import { NotificationProviderError } from './notification-providers/provider-error.js'; // allowed: not a sender
export const notify = () => [sendToChannel, NotificationProviderError];

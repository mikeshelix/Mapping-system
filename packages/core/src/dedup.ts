import type { MessageType } from './nws';

export type IngestDecision =
  /** We already stored this exact message. Nothing to do. */
  | { action: 'skip'; eventId: string }
  /** First message we have seen for this event. */
  | { action: 'create'; status: 'active' | 'cancelled' }
  /** A newer message for an event we already track. */
  | { action: 'update'; eventId: string }
  /** The source withdrew an event we already track. */
  | { action: 'cancel'; eventId: string };

/**
 * Decide what an incoming message means for the stored events.
 *
 * Sources such as NWS issue a brand-new message ID for every update and point
 * back at the messages it replaces. So identity is the chain, not the ID:
 * a message belongs to an existing event if we have stored either the message
 * itself or any message it references.
 *
 * @param knownMessages message ID -> event ID, for every stored message among
 *   this message's own ID and its references.
 */
export function decideIngest(
  message: { messageId: string; references: string[]; messageType: MessageType },
  knownMessages: ReadonlyMap<string, string>,
): IngestDecision {
  const own = knownMessages.get(message.messageId);
  if (own) return { action: 'skip', eventId: own };

  // References are ordered most recent first; follow the newest one we know.
  for (const ref of message.references) {
    const eventId = knownMessages.get(ref);
    if (eventId) {
      return message.messageType === 'cancel' ? { action: 'cancel', eventId } : { action: 'update', eventId };
    }
  }

  // Nothing known. A cancellation of something we never saw is still kept for history.
  return { action: 'create', status: message.messageType === 'cancel' ? 'cancelled' : 'active' };
}

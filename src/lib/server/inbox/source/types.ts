import "server-only";

/**
 * Where mail comes from. The sync engine sees only this interface. Two implementations:
 *
 *   gmail-source.ts    the Gmail REST API (step 2.5)
 *   fixture-source.ts  Gmail-shaped JSON from fixtures/mail/ (MAIL_SOURCE=fixture: development,
 *                      tests and CI, without any Google secret)
 *
 * Failures are thrown as MailSourceError (sync/errors.ts). A message that is gone is not an
 * error: getMessage and getAttachment answer null.
 *
 * The Gmail* types below are the parts of Gmail's own resources this app reads (format=full).
 * Fields the app does not read are left out; Gmail may send more.
 */
export interface MailSource {
  /** The mailbox's address and its current history id (users.getProfile). */
  getProfile(): Promise<MailboxProfile>;

  /**
   * First scan: the ids of every message received after `after`, sent mail, drafts and chats
   * left out (spam and trash are left out by Gmail's default). All pages, no duplicates. The
   * order is not defined.
   */
  listMessageIds(after: Date): Promise<string[]>;

  /**
   * Incremental sync: the ids of messages added since `startHistoryId` (all pages, no
   * duplicates) and the history id to continue from next time. Throws MailSourceError with kind
   * "history_expired" when the start id is too old (Gmail answers 404).
   */
  listAddedSince(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string }>;

  /** One message, format=full, or null when it no longer exists. */
  getMessage(id: string): Promise<GmailMessage | null>;

  /** An attachment's data (base64url), or null when it no longer exists. */
  getAttachment(messageId: string, attachmentId: string): Promise<string | null>;
}

export interface MailboxProfile {
  emailAddress: string;
  historyId: string;
}

/** Gmail's MessagePartHeader. Values may still be RFC 2047 encoded. */
export interface GmailHeader {
  name: string;
  value: string;
}

/** Gmail's MessagePartBody. `data` is base64url; a large part has an attachmentId instead. */
export interface GmailPartBody {
  size: number;
  data?: string;
  attachmentId?: string;
}

/** Gmail's MessagePart. */
export interface GmailPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailPartBody;
  parts?: GmailPart[];
}

/** Gmail's Message resource (format=full). */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** When Gmail received the message: milliseconds since the epoch, as a decimal string. */
  internalDate: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

/**
 * mail/types — shared type definitions for the Mail module.
 */

export type DraftStatus = 'draft' | 'approved' | 'sent';
export type Account = 'm365' | 'yahoo';

export interface MailDraft {
  id: string;
  createdAt: string;
  status: DraftStatus;
  account: Account;
  user: string;
  to: string[];
  subject: string;
  bodyText: string;
}

export interface UnifiedMsg {
  source: Account;
  id: string;
  dateIso: string;
  from: string;
  subject: string;
}

export interface ProcessedMails {
  version: 1;
  ids: string[];
}

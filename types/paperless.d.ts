/** Records crossing the Paperless API / database boundary. */
export type LiveSettings = { token_mode: 'shared' | 'personal'; allowed_tag_ids: number[] | null; revision: number };
export type Account = { id: number; base_url: string; api_token: string; live_settings?: LiveSettings };
export type LiveAccount = Account & { live_settings: LiveSettings };
export type FolderAudience = { visibility: string; allowed_member_ids: number[]; created_by?: number | null };
export type Folder = FolderAudience & { id: number; name: string; account_id: number; view_id: number; created_by: number; can_manage?: boolean };
export type Tag = { id: number; name: string };
export type Document = { id: string; title: string; filename: string; url?: string; created?: string | null };

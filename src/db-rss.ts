import { randomUUID } from 'crypto';

import { getDb } from './db.js';
import { RssSubscription } from './types.js';

export function createRssSubscription(
  groupFolder: string,
  chatJid: string,
  url: string,
  title?: string,
): RssSubscription {
  const db = getDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO rss_subscriptions (id, group_folder, chat_jid, url, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, groupFolder, chatJid, url, title ?? null, createdAt);
  return {
    id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    url,
    title: title ?? null,
    last_fetched: null,
    created_at: createdAt,
  };
}

export function getRssSubscriptions(groupFolder: string): RssSubscription[] {
  return getDb()
    .prepare(
      'SELECT * FROM rss_subscriptions WHERE group_folder = ? ORDER BY created_at ASC',
    )
    .all(groupFolder) as RssSubscription[];
}

export function getAllRssSubscriptions(): RssSubscription[] {
  return getDb()
    .prepare(
      'SELECT * FROM rss_subscriptions ORDER BY group_folder, created_at ASC',
    )
    .all() as RssSubscription[];
}

export function deleteRssSubscription(id: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM rss_subscriptions WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function updateRssSubscriptionTitle(id: string, title: string): void {
  getDb()
    .prepare('UPDATE rss_subscriptions SET title = ? WHERE id = ?')
    .run(title, id);
}

export function updateRssSubscriptionFetched(
  id: string,
  lastFetched: string,
): void {
  getDb()
    .prepare('UPDATE rss_subscriptions SET last_fetched = ? WHERE id = ?')
    .run(lastFetched, id);
}

export function isRssItemSeen(
  subscriptionId: string,
  itemGuid: string,
): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 FROM rss_seen_items WHERE subscription_id = ? AND item_guid = ?',
    )
    .get(subscriptionId, itemGuid);
  return row !== undefined;
}

export function markRssItemSeen(
  subscriptionId: string,
  itemGuid: string,
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO rss_seen_items (subscription_id, item_guid, seen_at) VALUES (?, ?, ?)`,
    )
    .run(subscriptionId, itemGuid, new Date().toISOString());
}

export function pruneRssSeenItems(
  subscriptionId: string,
  keepCount = 500,
): void {
  getDb()
    .prepare(
      `DELETE FROM rss_seen_items
     WHERE subscription_id = ? AND item_guid NOT IN (
       SELECT item_guid FROM rss_seen_items
       WHERE subscription_id = ?
       ORDER BY seen_at DESC
       LIMIT ?
     )`,
    )
    .run(subscriptionId, subscriptionId, keepCount);
}

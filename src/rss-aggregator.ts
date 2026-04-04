import { RSS_POLL_INTERVAL_MS } from './config.js';
import {
  createRssSubscription,
  deleteRssSubscription,
  getAllRssSubscriptions,
  getRssSubscriptions,
  isRssItemSeen,
  markRssItemSeen,
  pruneRssSeenItems,
  updateRssSubscriptionFetched,
  updateRssSubscriptionTitle,
} from './db.js';
import { logger } from './logger.js';
import type { RssSubscription } from './types.js';

export interface RssAggregatorDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export interface RssItem {
  guid: string;
  title: string;
  link: string;
  pubDate: string | null;
  description: string | null;
}

export interface ParsedFeed {
  title: string | null;
  items: RssItem[];
}

// --- XML helpers (no external deps) ---

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  return decodeCdata(m[1].trim());
}

function extractTagAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

function decodeCdata(s: string): string {
  // Strip CDATA wrappers
  return s.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, '$1').trim();
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

function textContent(raw: string): string {
  // For titles and plain text fields: decode CDATA and HTML entities, but don't strip tags
  // (CDATA content like "Hello <World>" would lose "<World>" if we stripped)
  return decodeHtmlEntities(decodeCdata(raw));
}

function textContentStripped(raw: string): string {
  // For description fields: decode CDATA, strip HTML tags, then decode entities
  return decodeHtmlEntities(stripTags(decodeCdata(raw)));
}

/**
 * Minimal RSS 2.0 / Atom parser using regex.
 * Handles CDATA, html entities, and basic Atom <entry> tags.
 */
export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed\b/i.test(xml);

  if (isAtom) {
    return parseAtomFeed(xml);
  }
  return parseRssFeed(xml);
}

function parseRssFeed(xml: string): ParsedFeed {
  const channelMatch = xml.match(/<channel[^>]*>([\s\S]*?)<\/channel>/i);
  const channelXml = channelMatch ? channelMatch[1] : xml;

  // Feed title: the first <title> not inside an <item>
  const feedTitleRaw =
    channelXml.match(/^[\s\S]*?(?=<item\b)/i)?.[0] ?? channelXml;
  const feedTitle = extractTag(feedTitleRaw, 'title');

  const itemBlocks = extractTagAll(channelXml, 'item');
  const items: RssItem[] = itemBlocks.map((block) => {
    const title = textContent(extractTag(block, 'title') ?? '');
    const link =
      textContent(extractTag(block, 'link') ?? '') ||
      extractTagAttr(block, 'link', 'href') ||
      '';
    const pubDate =
      extractTag(block, 'pubDate') ?? extractTag(block, 'dc:date');
    const description =
      extractTag(block, 'description') ?? extractTag(block, 'content:encoded');
    const guid =
      extractTag(block, 'guid') || link || `${title}-${pubDate ?? ''}`;
    return {
      guid: guid.trim(),
      title: title || '(no title)',
      link: link.trim(),
      pubDate: pubDate?.trim() ?? null,
      description: description
        ? textContentStripped(description).slice(0, 300)
        : null,
    };
  });

  return { title: feedTitle ? textContent(feedTitle) : null, items };
}

function parseAtomFeed(xml: string): ParsedFeed {
  const feedTitle = extractTag(xml, 'title');

  const entryBlocks = extractTagAll(xml, 'entry');
  const items: RssItem[] = entryBlocks.map((block) => {
    const title = textContent(extractTag(block, 'title') ?? '');
    const link =
      extractTagAttr(block, 'link', 'href') ||
      textContent(extractTag(block, 'link') ?? '');
    const pubDate =
      extractTag(block, 'published') ??
      extractTag(block, 'updated') ??
      extractTag(block, 'dc:date');
    const description =
      extractTag(block, 'summary') ?? extractTag(block, 'content');
    const guid = extractTag(block, 'id') || link || `${title}-${pubDate ?? ''}`;
    return {
      guid: guid.trim(),
      title: title || '(no title)',
      link: link.trim(),
      pubDate: pubDate?.trim() ?? null,
      description: description
        ? textContentStripped(description).slice(0, 300)
        : null,
    };
  });

  return { title: feedTitle ? textContent(feedTitle) : null, items };
}

function extractTagAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? decodeHtmlEntities(m[1]) : '';
}

// --- Fetch helpers ---

async function fetchFeed(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'NanoClaw-RSS/1.0',
        Accept: 'application/rss+xml,application/atom+xml,text/xml,*/*',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// --- Command handling ---

const USAGE = `RSS 订阅管理：
  /rss add <url>    — 添加 RSS 订阅
  /rss list         — 列出所有订阅
  /rss del <id>     — 删除订阅（id 为 list 命令显示的序号）`;

export async function handleRssCommand(
  args: string,
  groupFolder: string,
  chatJid: string,
  sendReply: (text: string) => Promise<void>,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcmd = parts[0]?.toLowerCase();

  if (subcmd === 'add') {
    const url = parts[1];
    if (!url || !/^https?:\/\//i.test(url)) {
      await sendReply('请提供有效的 RSS URL。\n' + USAGE);
      return;
    }
    // Check for duplicates
    const existing = getRssSubscriptions(groupFolder);
    if (existing.some((s) => s.url === url)) {
      await sendReply('该 RSS 源已订阅。');
      return;
    }
    try {
      const xml = await fetchFeed(url);
      const feed = parseFeed(xml);
      const title = feed.title ?? url;
      const sub = createRssSubscription(groupFolder, chatJid, url, title);
      // Mark all current items as seen so we don't flood on first subscribe
      for (const item of feed.items) {
        markRssItemSeen(sub.id, item.guid);
      }
      updateRssSubscriptionFetched(sub.id, new Date().toISOString());
      await sendReply(
        `✅ 已订阅：${title}\n共发现 ${feed.items.length} 条已有条目（不会重复推送）。`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ url, err: msg }, 'RSS add: failed to fetch feed');
      await sendReply(`❌ 无法获取该 RSS 源：${msg}`);
    }
    return;
  }

  if (subcmd === 'list') {
    const subs = getRssSubscriptions(groupFolder);
    if (subs.length === 0) {
      await sendReply('当前没有 RSS 订阅。\n' + USAGE);
      return;
    }
    const lines = subs.map(
      (s, i) => `${i + 1}. ${s.title ?? s.url}\n   ${s.url}`,
    );
    await sendReply(
      `📋 RSS 订阅列表（共 ${subs.length} 条）：\n${lines.join('\n\n')}\n\n删除：/rss del <序号>`,
    );
    return;
  }

  if (subcmd === 'del') {
    const idx = parseInt(parts[1] ?? '', 10);
    const subs = getRssSubscriptions(groupFolder);
    if (isNaN(idx) || idx < 1 || idx > subs.length) {
      await sendReply(`请提供有效序号（1-${subs.length}）。\n` + USAGE);
      return;
    }
    const sub = subs[idx - 1];
    deleteRssSubscription(sub.id);
    await sendReply(`🗑️ 已删除订阅：${sub.title ?? sub.url}`);
    return;
  }

  await sendReply(USAGE);
}

// --- Polling loop ---

async function pollOnce(deps: RssAggregatorDeps): Promise<void> {
  const subs = getAllRssSubscriptions();
  for (const sub of subs) {
    try {
      await pollSubscription(sub, deps);
    } catch (err) {
      logger.warn(
        {
          subscriptionId: sub.id,
          url: sub.url,
          err: err instanceof Error ? err.message : String(err),
        },
        'RSS poll error',
      );
    }
  }
}

async function pollSubscription(
  sub: RssSubscription,
  deps: RssAggregatorDeps,
): Promise<void> {
  const xml = await fetchFeed(sub.url);
  const feed = parseFeed(xml);

  // Update feed title if it changed or was unknown
  if (feed.title && feed.title !== sub.title) {
    updateRssSubscriptionTitle(sub.id, feed.title);
  }

  const newItems = feed.items.filter(
    (item) => !isRssItemSeen(sub.id, item.guid),
  );

  if (newItems.length > 0) {
    // Deliver newest-first (reversed) in batches to avoid too-long messages
    const toSend = newItems.slice(0, 10); // cap to 10 items per poll
    for (const item of toSend.reverse()) {
      const lines: string[] = [];
      lines.push(`📰 *${feed.title ?? sub.url}*`);
      lines.push(item.title);
      if (item.link) lines.push(item.link);
      if (item.description) lines.push(item.description);
      if (item.pubDate) lines.push(`🕒 ${item.pubDate}`);
      try {
        await deps.sendMessage(sub.chat_jid, lines.join('\n'));
      } catch (err) {
        logger.warn(
          { chatJid: sub.chat_jid, err },
          'RSS: failed to send message',
        );
      }
    }
    for (const item of newItems) {
      markRssItemSeen(sub.id, item.guid);
    }
    pruneRssSeenItems(sub.id);
    logger.info(
      { subscriptionId: sub.id, url: sub.url, newItemCount: newItems.length },
      'RSS: delivered new items',
    );
  }

  updateRssSubscriptionFetched(sub.id, new Date().toISOString());
}

export function startRssPoller(deps: RssAggregatorDeps): void {
  logger.info({ intervalMs: RSS_POLL_INTERVAL_MS }, 'RSS poller starting');

  const tick = () => {
    pollOnce(deps).catch((err) => {
      logger.error({ err }, 'RSS poller unexpected error');
    });
  };

  // First poll after a short delay so startup isn't slowed down
  setTimeout(tick, 10_000);
  setInterval(tick, RSS_POLL_INTERVAL_MS);
}

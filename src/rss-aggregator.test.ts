import { describe, it, expect } from 'vitest';
import { parseFeed } from './rss-aggregator.js';

describe('parseFeed (RSS 2.0)', () => {
  it('parses a basic RSS feed', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/1</link>
      <guid>guid-1</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <description>Summary here</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/2</link>
      <guid>guid-2</guid>
    </item>
  </channel>
</rss>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe('Test Feed');
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].guid).toBe('guid-1');
    expect(feed.items[0].title).toBe('First Post');
    expect(feed.items[0].link).toBe('https://example.com/1');
    expect(feed.items[1].title).toBe('Second Post');
  });

  it('handles CDATA in titles and descriptions', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title><![CDATA[My Blog & More]]></title>
    <item>
      <title><![CDATA[Hello <World>]]></title>
      <link>https://example.com/post</link>
      <guid>cdata-guid</guid>
      <description><![CDATA[Some <b>bold</b> content here.]]></description>
    </item>
  </channel>
</rss>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe('My Blog & More');
    expect(feed.items[0].title).toBe('Hello <World>');
    expect(feed.items[0].description).toContain('bold');
    expect(feed.items[0].description).not.toContain('<b>');
  });

  it('falls back to link as guid when guid is missing', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>F</title>
  <item>
    <title>No Guid</title>
    <link>https://example.com/noguid</link>
  </item>
</channel></rss>`;
    const feed = parseFeed(xml);
    expect(feed.items[0].guid).toBe('https://example.com/noguid');
  });
});

describe('parseFeed (Atom)', () => {
  it('parses a basic Atom feed', () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom/1"/>
    <id>atom-id-1</id>
    <published>2024-01-01T00:00:00Z</published>
    <summary>Atom summary text.</summary>
  </entry>
</feed>`;
    const feed = parseFeed(xml);
    expect(feed.title).toBe('Atom Blog');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].guid).toBe('atom-id-1');
    expect(feed.items[0].title).toBe('Atom Entry');
    expect(feed.items[0].link).toBe('https://example.com/atom/1');
  });
});

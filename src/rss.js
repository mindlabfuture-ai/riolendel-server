const { POSTS } = require('./posts');

const SITE_URL = 'https://riolendel.com';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function generateRssXml() {
  const sorted = [...POSTS].sort((a, b) => b.pubDate - a.pubDate);

  const items = sorted.map(post => `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${SITE_URL}/blog/${post.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${post.slug}</guid>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${post.pubDate.toUTCString()}</pubDate>
    </item>`).join('');

  const lastBuildDate = sorted.length ? sorted[0].pubDate.toUTCString() : new Date().toUTCString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Riolendel Stories</title>
    <link>${SITE_URL}/blog/</link>
    <description>Gold education stories for Filipino consumers \u2014 family gold, jewelry care, and scam awareness.</description>
    <language>en-ph</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>${items}
  </channel>
</rss>`;
}

module.exports = { generateRssXml };

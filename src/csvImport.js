/**
 * Tiny CSV parser — no dependency needed for a simple name/email/phone/
 * channel import. Handles quoted fields (so commas inside a name or
 * address don't break columns) and CRLF or LF line endings.
 *
 * Expected columns (header row, any order, case-insensitive):
 *   name (or full_name / fullname), email, phone (or mobile), channel
 *
 * `channel` is optional per-row — defaults to 'email' if blank/missing.
 * Valid values: email, sms, both.
 */

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields.map(f => f.trim());
}

function normalizeHeader(h) {
  const key = h.toLowerCase().replace(/[\s_]/g, '');
  if (['name', 'fullname'].includes(key)) return 'fullName';
  if (['email', 'emailaddress'].includes(key)) return 'email';
  if (['phone', 'mobile', 'mobilenumber', 'phonenumber'].includes(key)) return 'phone';
  if (['channel', 'preference'].includes(key)) return 'channel';
  return key;
}

/**
 * Parse CSV text into an array of contact objects:
 *   { fullName, email, phone, channel }
 * Rows missing both email and phone are dropped.
 */
function parseCsv(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });

    const email = (row.email || '').toLowerCase();
    const phone = (row.phone || '').replace(/[\s-]/g, '');
    if (!email && !phone) continue; // need at least one contact method

    let channel = (row.channel || '').toLowerCase();
    if (!['email', 'sms', 'both'].includes(channel)) {
      channel = email && phone ? 'both' : phone ? 'sms' : 'email';
    }

    rows.push({
      fullName: row.fullName || '',
      email: email || null,
      phone: phone || null,
      channel,
    });
  }

  return rows;
}

module.exports = { parseCsv };

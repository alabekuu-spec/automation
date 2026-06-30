// Parses a plain-text list of Facebook group URLs — one per line.
// Comments (#) and blank lines are ignored.
//
// Each entry becomes:
//   { id, label, url }
//
// `id`    is the path segment after /groups/ — numeric id or vanity handle.
// `label` is the same as `id` (we don't know the real group name from a URL
//         alone). Scripts that need a searchable name will fall back to `id`.
// `url`   is the canonical https://www.facebook.com/groups/<id>/ URL.
import fs from 'node:fs';

const URL_REGEX = /facebook\.com\/groups\/([A-Za-z0-9._-]+)/i;

export function loadGroups(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const seen = new Set();
  const groups = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = URL_REGEX.exec(line);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push({
      id,
      label: id,
      url: `https://www.facebook.com/groups/${id}/`,
    });
  }
  return groups;
}

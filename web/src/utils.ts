export function formatTime(millis: number) {
  const d = new Date(millis);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86400000);
  const eventDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const h = d.getHours();
  const hour = h % 12 || 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  const min = d.getMinutes().toString().padStart(2, '0');
  const time = `${hour}:${min} ${ampm}`;

  if (eventDay.getTime() === today.getTime()) return `Today, ${time}`;
  if (eventDay.getTime() === tomorrow.getTime()) return `Tomorrow, ${time}`;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${time}`;
}

export function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Event routes can be opened from outside the app; never trust URL query data.
export function getSourceUrls(serialized: string, fallback: string): string[] {
  let values: unknown = [];
  try {
    values = serialized ? JSON.parse(serialized) : [];
  } catch {}
  const candidates = Array.isArray(values) ? values : [];
  const safe = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  };
  const urls = candidates.filter(safe);
  if (urls.length === 0 && safe(fallback)) urls.push(fallback);
  return [...new Set(urls)];
}

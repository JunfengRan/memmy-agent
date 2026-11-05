/**
 * Entry times keep the caller's wall-clock offset (`2026-10-28T12:00:00+08:00`)
 * and are compared as instants, never as strings.
 */
const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

export function timeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function isBefore(left: string, right: string): boolean {
  return timeMs(left) < timeMs(right);
}

/** Offset in minutes east of UTC for an IANA zone or a literal offset; null when unknown. */
export function zoneOffsetMinutes(zone: string | null | undefined, at: Date): number | null {
  if (!zone) return null;
  const literal = OFFSET.exec(zone.trim());
  if (literal) {
    const minutes = Number(literal[2]) * 60 + Number(literal[3]);
    return literal[1] === "-" ? -minutes : minutes;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone.trim(),
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return null;
  }
}

export function serverOffsetMinutes(at: Date): number {
  return -at.getTimezoneOffset();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatWithOffset(epochMs: number, offsetMinutes: number): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Normalizes a chat_time. Values without a zone are read in the caller's zone
 * (X-MemOS-TZ) or, failing that, the server's. Returns null when unparseable.
 */
export function normalizeChatTime(value: string, zone: string | null | undefined, now: Date): string | null {
  const text = value.trim();
  if (!text) return null;
  if (HAS_ZONE.test(text)) {
    const epoch = Date.parse(text.replace(" ", "T"));
    if (Number.isNaN(epoch)) return null;
    const offset = zoneOffsetMinutes(zone, new Date(epoch)) ?? serverOffsetMinutes(new Date(epoch));
    return formatWithOffset(epoch, offset);
  }
  const match = LOCAL.exec(text);
  if (!match) return null;
  const wall = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0)
  );
  if (Number.isNaN(wall)) return null;
  const offset = zoneOffsetMinutes(zone, new Date(wall)) ?? serverOffsetMinutes(new Date(wall));
  return formatWithOffset(wall - offset * 60_000, offset);
}

export function nowWithOffset(zone: string | null | undefined, now: Date): string {
  const offset = zoneOffsetMinutes(zone, now) ?? serverOffsetMinutes(now);
  return formatWithOffset(now.getTime(), offset);
}

/**
 * Shareable settings links: the settings that differ from the defaults are
 * stored as compact base64url JSON in the URL hash (#s=…). Nothing is sent to
 * a server and the photo itself is never part of the link.
 */
import { cloneSettings, DEFAULT_SETTINGS, type StereoSettings } from '../core/settings';

function diff(base: unknown, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const d = diff((base as Record<string, unknown>)[k], v);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
}

/** Merge a (possibly partial or untrusted) patch onto `base`, keeping types. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) {
      // Allow switching union shapes (e.g. background.color appears with kind 'color').
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      continue;
    }
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const kind = (cur as { kind?: unknown }).kind;
      const next = v as { kind?: unknown } | null;
      // Tagged unions (e.g. background): a different `kind` replaces the object.
      if (kind !== undefined && next && typeof next === 'object' && next.kind !== undefined && next.kind !== kind) {
        const fresh: Record<string, unknown> = {};
        for (const [kk, vv] of Object.entries(next)) if (['string', 'number', 'boolean'].includes(typeof vv)) fresh[kk] = vv;
        out[k] = fresh;
      } else {
        out[k] = deepMerge(cur, v);
      }
    } else if (typeof v === typeof cur) out[k] = v;
  }
  return base;
}

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeSettings(s: StereoSettings): string {
  const d = diff(DEFAULT_SETTINGS, s);
  return d ? toBase64Url(JSON.stringify(d)) : '';
}

export function decodeSettings(token: string): StereoSettings | null {
  try {
    const patch = JSON.parse(fromBase64Url(token));
    return deepMerge(cloneSettings(DEFAULT_SETTINGS), patch);
  } catch {
    return null;
  }
}

export function settingsFromHash(hash: string): StereoSettings | null {
  const m = /[#&]s=([A-Za-z0-9_-]*)/.exec(hash);
  if (!m) return null;
  return m[1] ? decodeSettings(m[1]) : cloneSettings(DEFAULT_SETTINGS);
}

export function shareUrl(s: StereoSettings, href: string): string {
  const url = new URL(href);
  url.hash = `s=${encodeSettings(s)}`;
  return url.toString();
}

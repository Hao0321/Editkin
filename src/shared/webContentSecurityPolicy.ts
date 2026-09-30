// Content-Security-Policy for the static browser build (GitHub Pages).
//
// Delivered as a <meta http-equiv> tag because Pages cannot set response
// headers. That has two consequences worth knowing:
// - `frame-ancestors`, `report-uri` and `sandbox` are ignored in a meta policy,
//   so they are deliberately absent. Clickjacking protection therefore needs a
//   host that can send headers; Pages cannot.
// - The policy only covers content parsed after the tag, so the plugin in
//   vite.config.ts must inject it before every script.
//
// Desktop shells do not use this policy: Tauri injects its own CSP (see
// src-tauri/tauri.conf.json) and Electron loads the same dist over file://.
const directives: Record<string, readonly string[]> = {
  "default-src": ["'self'"],
  // Vite emits only external module scripts, so no inline or eval allowance.
  "script-src": ["'self'"],
  // React renders inline style attributes; same allowance as the Tauri policy.
  "style-src": ["'self'", "'unsafe-inline'"],
  // blob:/data: carry user-imported media and canvas snapshots.
  "img-src": ["'self'", "blob:", "data:"],
  "media-src": ["'self'", "blob:"],
  "font-src": ["'self'"],
  // The browser build makes no cross-origin requests.
  "connect-src": ["'self'"],
  // Also gates the PWA service worker script.
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "frame-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
};

export const WEB_CONTENT_SECURITY_POLICY = Object.entries(directives)
  .map(([name, sources]) => `${name} ${sources.join(" ")}`)
  .join("; ");

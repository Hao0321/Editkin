# Remote relay authentication and outbound data boundary review

Tracks [#25](https://github.com/Hao0321/Editkin/issues/25). Scope: the desktop side of Editkin Remote (`src/remote/server.ts`, `src/remote/relayContract.ts`) as it talks to a user-configured cloud relay and to phones on the LAN. **This is one contributor's review, not the second security review the issue requires, and no public relay is enabled or endorsed by it.**

## What could not be reviewed

The relay service itself (a Cloudflare Worker driven by `wrangler` in the maintainer's smoke script) is **not part of the public checkout** (no `relay/` directory). Its access control, room isolation, how it assigns client ids, and what it logs or retains were not reviewed. Everything below assumes only what the desktop can enforce.

## Authentication paths

| Path | Credential | Checked by |
| --- | --- | --- |
| `pair` (LAN `POST /api/pair`, relay `pair`) | Bootstrap token, valid 10 minutes after the server starts | `bootstrapAuthorized`: length check, `timingSafeEqual`, expiry. LAN pairing is rate limited per address; relay pairing per client id **and** across all client ids |
| `status`, `command` (LAN) | `editkin_remote_device` cookie (`HttpOnly; SameSite=Strict`, `Secure` behind TLS) matched by SHA-256 against the trusted-device store; JSON mutations also need a same-origin `Origin` and `application/json` | `authenticate` |
| `status`, `command` (relay) | Device id plus the device credential, matched against the trusted-device store on every request. A credential-less follow-up is accepted only for a client id remembered **on the current relay connection** after a credentialed request, and the store is re-checked each time | `authenticateRelayDevice` |

No command reaches the queue except through `enqueueCommand`, which is called only after one of the authenticated `command` paths.

Device credentials do not expire on their own (the cookie is set for ten years and the store has no expiry). Revocation is the desktop's `revoke_mobile_device` command, which removes the device from the trusted-device file; the server re-reads that file on every request, so revocation takes effect on the next message.

## Findings

### F1 (fixed): a remembered relay client id survived reconnects

`relaySessions` maps a relay-assigned client id to a session and was never cleared. After a reconnect, a relay (or anything able to reuse a client id) that also knew a paired **device id** could send a credential-less `command` and have it queued. Device ids are not secrets.

- **Reproduction (before the fix):** pair a device, make one credentialed request, drop the relay connection and let the desktop reconnect, then send `command` with the same client id and device id and no credential. The desktop answered `accepted` and wrote a queue file. This is `src/remote/server.test.ts` "does not let a client id remembered on one relay connection authorize on the next", which failed with `Expected: "unauthorized" Received: "accepted"` when the fix was removed.
- **Fix:** `relaySessions` is cleared when a relay connection opens and when it closes, so a client id only means something on the connection that issued it.
- **Precondition to exploit:** control of the relay or of client-id assignment, plus a known device id. The relay is a trust boundary, so this matters.

### F2 (fixed): outbound status spread the whole snapshot

The relay `status` reply and the LAN `/api/status` reply spread every snapshot key except `previewPath`. Any field added to the snapshot later would have left the desktop automatically.

- **Fix:** `projectRemoteStatus(snapshot, "relay" | "lan")` builds the reply from an explicit allowlist with per-field type and length validation; a field that fails validation is omitted.
- **Sent to a cloud relay:** project name, canvas size (`resolution`), `fps`, track count, playhead time and label, and the desktop `status` text. **Not sent to a relay:** preview media, preview id and kind, local paths, and any field not on the list. On the LAN the preview id and kind are added, still without a path.
- **Residual privacy note:** the project name and the free-text `status` line (up to 500 characters) still leave the desktop, and `status` is written by the desktop, so a future message that includes a file name would be forwarded. Treat both as user-visible metadata and review any change to `status` text.

### F3 (fixed): relay URL was not restricted

The desktop passed `EDITKIN_REMOTE_RELAY_WS_URL` straight to `new WebSocket`. The Rust launcher builds a `wss://` URL, but the server did not verify it.

- **Fix:** `assertRelayWebSocketUrl` requires `wss:` (plain `ws:` only for loopback), no credentials, query or fragment, and the exact path `/ws/<room>` for the desktop's own room. The server refuses to start otherwise, so a bad relay URL fails closed instead of connecting.

### F4 (fixed): relay rate limits keyed only on a relay-chosen value

Relay commands were limited per client id, and pairing attempts per client id. A hostile relay can rotate client ids.

- **Fix:** relay commands are limited per **device id** (one per 150 ms) and pairing attempts are also limited across all client ids (10 per minute).

## Limits that were confirmed, not changed

- **Message size:** relay frames over 32 768 bytes, non-text frames, malformed JSON and unknown envelope types are rejected and the socket is closed with code 4008. The frame is received before it is measured, so a hostile relay can still make the desktop buffer one oversized frame.
- **HTTP body:** LAN bodies over 32 KiB are rejected; commands are limited to 1 000 characters.
- **Reconnect:** the desktop reconnects with exponential backoff from 500 ms to 15 s; it re-authenticates to the relay with its room secret on every connection (`desktop-auth`).
- **Room secret transport:** the secret is sent as the first frame of the WebSocket. With `wss:` it is protected in transit, but it is visible to the relay operator, who must be trusted with the room.

## The three CodeQL findings

| Alert (see #24 triage) | Assessment | Status |
| --- | --- | --- |
| Relay authorization (`user-controlled-bypass`, `server.ts` `pair` branch) | Not a bypass: `pair` skips device authentication by design but requires the time-limited bootstrap token and is rate limited; every other type requires a device credential. Now covered by tests for wrong-token pairing, rotating-client pairing floods and unauthorized status/command | Proposed dismissal; needs second reviewer |
| File data in an outbound message (`file-access-to-http`) | The relay `status` message is now an explicit allowlist (F2) | Improved; proposed dismissal after review of the allowlist |
| HTTP input reaching a file operation (`http-to-file-access`) | Only authenticated, rate-limited, length-limited command text is written; the file name is generated (`remote-<time>-<random>`) and opened with `wx` | Proposed dismissal; needs second reviewer |

I cannot dismiss alerts in GitHub. Dismissal needs a reviewer who is not the author.

## Tests

`src/remote/relayContract.test.ts` (unit: envelope parsing, URL rules, outbound contract) and `src/remote/server.test.ts` (bundles the real `server.ts`, runs it against a minimal in-process WebSocket relay and real HTTP): unauthorized `pair`/`status`/`command` over relay and LAN, wrong-token and cross-origin pairing, revocation, client-id reuse across reconnects, malformed and oversized envelopes, pairing flood across rotating client ids, per-device command rate, startup refusal for unsafe relay URLs, and the outbound allowlist for both transports.

## Not covered

Credential expiry beyond the ten-year cookie, the 10-minute bootstrap window (only its logic is reviewed; no test waits it out), the preview endpoint's range handling, TLS certificate validation by the runtime, and the relay service. A public relay must not be enabled, and no official updater shipped, on the strength of this review.

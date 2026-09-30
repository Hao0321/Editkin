/** A paired device that has not been seen for this long must pair again. */
export const DEVICE_IDLE_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export function deviceIdleExpired(lastSeenIso: string, now: number): boolean {
  return now - Date.parse(lastSeenIso) > DEVICE_IDLE_LIFETIME_MS;
}

/**
 * The bootstrap pairing token is valid for one successful pairing inside a
 * fixed window. `claim` is synchronous, so concurrent requests cannot both win;
 * `release` gives the token back when the claimed pairing then fails, so a
 * device-limit or disk error does not burn the QR code.
 */
export class PairingWindow {
  private consumed = false;

  constructor(readonly expiresAt: number) {}

  get isConsumed(): boolean {
    return this.consumed;
  }

  claim(now: number): boolean {
    if (this.consumed || now > this.expiresAt) return false;
    this.consumed = true;
    return true;
  }

  release(): void {
    this.consumed = false;
  }
}

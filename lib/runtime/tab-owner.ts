/**
 * lib/runtime/tab-owner.ts
 *
 * R3.1a tabOwner claim protocol — BroadcastChannel-based async collision detection.
 * Each document instance gets a unique ownerId; copy tabs detect occupation and rotate.
 * Holder keeps channel open and yields when pinger has smaller instanceId.
 */

// ─── M2: generateHexId ────────────────────────────────────────────────────────

/** Generate a random hex string of byteLen bytes (2×byteLen chars). */
export function generateHexId(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── M3: tabOwner claim protocol ─────────────────────────────────────────────

const INSTANCE_ID = generateHexId(16);
let currentOwnerId: string | null = null;
let holderChannel: BroadcastChannel | null = null;

/** Holder continuously listens for pings and yields when pinger's instanceId is lexicographically smaller. */
function startHolderListener(ownerId: string): void {
  const channel = new BroadcastChannel(`r3:tab:claim:${ownerId}`);
  holderChannel = channel;

  channel.onmessage = (event) => {
    if (event.data?.type !== 'ping') return;
    const pingerId: string = event.data.from;
    if (pingerId < INSTANCE_ID) {
      // Pinger has smaller instanceId → this holder yields
      channel.close();
      holderChannel = null;
      currentOwnerId = null;
      sessionStorage.removeItem('r3:tab:owner-id');
    } else {
      // This holder keeps the owner → respond occupied
      channel.postMessage({ type: 'occupied', from: INSTANCE_ID });
    }
  };
}

/** Async probe: ping the ownerId channel, wait 150ms for 'occupied' response. */
function probeOwnerId(ownerId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const channel = new BroadcastChannel(`r3:tab:claim:${ownerId}`);
    let occupied = false;
    let settled = false;

    const done = (free: boolean) => {
      if (settled) return;
      settled = true;
      channel.close();
      resolve(free);
    };

    channel.onmessage = (event) => {
      if (event.data?.type === 'occupied') occupied = true;
    };

    channel.postMessage({ type: 'ping', from: INSTANCE_ID });
    setTimeout(() => done(!occupied), 150);
  });
}

/** Async claim a tabOwnerId. Short-circuits if already held (anti-self-collision). */
export async function claimTabOwnerId(): Promise<string> {
  if (currentOwnerId) return currentOwnerId; // M3 self-collision short-circuit

  const KEY = 'r3:tab:owner-id';
  const existing = sessionStorage.getItem(KEY);

  // Even if sessionStorage has an ID, probe for potential stale claim
  if (existing) {
    const free = await probeOwnerId(existing);
    if (free) {
      currentOwnerId = existing;
      startHolderListener(existing);
      return existing;
    }
    sessionStorage.removeItem(KEY);
  }

  // Try candidates
  const candidates = Array.from({ length: 4 }, () => generateHexId(16));
  for (const candidate of candidates) {
    const free = await probeOwnerId(candidate);
    if (free) {
      sessionStorage.setItem(KEY, candidate);
      currentOwnerId = candidate;
      startHolderListener(candidate);
      return candidate;
    }
  }
  throw new Error('Failed to claim tabOwnerId after 4 candidates');
}

// ─── Cleanup on unload ────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    holderChannel?.close();
    holderChannel = null;
  });
}

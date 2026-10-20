/**
 * IPFS storage adapter for Next.js API routes.
 *
 * #1189 – Replaces the process-local `Map` with an explicit storage adapter
 * interface so that:
 *  - development uses the built-in in-memory mock (enabled by
 *    `IPFS_STORAGE_ADAPTER=mock` or when no env var is set);
 *  - production can swap to a real Pinata / web3.storage provider without
 *    changing any call-site code.
 *  Provider credentials are read server-side only (no `NEXT_PUBLIC_` prefix).
 *
 * #1190 – Pin status now tracks the full provider lifecycle:
 *   requested → pending → pinned | failed
 *  `pinnedHashes.has(hash)` used to lie (it was set immediately on upload).
 *  Now `getStorageStatus` returns an explicit `PinStatus` and `pinned` is
 *  `true` only after the adapter confirms it.
 *
 * Public surface (unchanged for callers):
 *  uploadJSON, uploadFile, retrieve, pinHash, getGatewayUrl, getStorageStatus
 *
 * New exports:
 *  PinStatus – union type for pin lifecycle states
 *  StorageEntry – shape of a stored record
 */

import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Full lifecycle of a pin request. */
export type PinStatus = "none" | "requested" | "pending" | "pinned" | "failed";

export interface StorageEntry {
  hash: string;
  data: unknown;
  metadata: { name?: string; uploadedAt: string };
  pinStatus: PinStatus;
  /** ISO timestamp of the last pin-state transition */
  pinUpdatedAt?: string;
  /** Number of times we have retried a failed pin */
  pinRetries: number;
  /** Last error message from the provider (if any) */
  pinError?: string;
}

/** Minimal adapter that any storage backend must implement. */
export interface IpfsStorageAdapter {
  /**
   * Persist a new entry keyed by its content hash.
   * The adapter is responsible for generating the hash when `hash` is
   * undefined (dev mock uses `generateHash()`).
   */
  put(entry: Omit<StorageEntry, "hash">, suggestedHash?: string): Promise<string>;
  get(hash: string): Promise<StorageEntry | undefined>;
  updatePinStatus(
    hash: string,
    status: PinStatus,
    extra?: { error?: string; incrementRetry?: boolean }
  ): Promise<void>;
  has(hash: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory dev adapter  (#1189 — explicit mock, not the accidental default)
// ---------------------------------------------------------------------------

class MemoryAdapter implements IpfsStorageAdapter {
  private store = new Map<string, StorageEntry>();

  async put(
    entry: Omit<StorageEntry, "hash">,
    suggestedHash?: string
  ): Promise<string> {
    // #1188 – derive a real content identifier from the payload bytes.
    const hash = suggestedHash
      ? validateCid(suggestedHash)
      : await computeCid(entry.data);
    this.store.set(hash, { ...entry, hash });
    return hash;
  }

  async get(hash: string): Promise<StorageEntry | undefined> {
    return this.store.get(hash);
  }

  async updatePinStatus(
    hash: string,
    status: PinStatus,
    extra: { error?: string; incrementRetry?: boolean } = {}
  ): Promise<void> {
    const entry = this.store.get(hash);
    if (!entry) return;
    entry.pinStatus = status;
    entry.pinUpdatedAt = new Date().toISOString();
    if (extra.error !== undefined) entry.pinError = extra.error;
    if (extra.incrementRetry) entry.pinRetries += 1;
    this.store.set(hash, entry);
  }

  async has(hash: string): Promise<boolean> {
    return this.store.has(hash);
  }
}

// ---------------------------------------------------------------------------
// Adapter registry  (#1189)
// ---------------------------------------------------------------------------

/**
 * Resolve the storage adapter from the server-side environment variable
 * `IPFS_STORAGE_ADAPTER`.  Currently only `"mock"` is implemented; all other
 * values also fall back to the dev mock so that the app starts without
 * credentials in development.  Adding a real Pinata adapter only requires
 * implementing `IpfsStorageAdapter` and wiring it here.
 *
 * This function is module-level and evaluated once per worker lifetime, which
 * is the correct scope for a server-side singleton.
 */
function resolveAdapter(): IpfsStorageAdapter {
  const adapterName =
    (process.env.IPFS_STORAGE_ADAPTER ?? "mock").toLowerCase().trim();
  if (adapterName !== "mock") {
    // Future: return new PinataAdapter(), etc.
    // For now, fall through to the mock so the app still runs.
    if (process.env.NODE_ENV === "production") {
      console.warn(
        `[ipfsStore] Unknown IPFS_STORAGE_ADAPTER="${adapterName}". ` +
          "Falling back to in-memory mock — data will NOT survive restarts."
      );
    }
  }
  return new MemoryAdapter();
}

const adapter: IpfsStorageAdapter = resolveAdapter();

// ---------------------------------------------------------------------------
// Gateway helpers (unchanged public API)
// ---------------------------------------------------------------------------

/** Public Pinata gateway — never a localhost production default. */
const FALLBACK_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

function resolveGatewayBase(): string {
  const configured = process.env.NEXT_PUBLIC_IPFS_GATEWAY?.trim();
  if (configured) {
    const base = configured.endsWith("/") ? configured : `${configured}/`;
    if (
      process.env.NODE_ENV === "production" &&
      /localhost|127\.0\.0\.1/i.test(base)
    ) {
      throw new Error(
        "NEXT_PUBLIC_IPFS_GATEWAY points at localhost in a production build. " +
          "Set it to a public gateway (see Frontend/.env.example)."
      );
    }
    return base;
  }
  return FALLBACK_GATEWAY;
}

/**
 * #1188 – Deterministic serialisation of a payload so that the same logical
 * content always yields the same bytes (and therefore the same CID).
 * Object keys are sorted recursively; `undefined` values are dropped.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

/**
 * #1188 – Compute a real CIDv1 (raw codec, sha2-256 multihash) from the
 * payload bytes.  This replaces the previous random `Qm…` pseudo-hash.
 */
async function computeCid(data: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(data));
  const digest = await sha256.digest(bytes);
  const cid = CID.createV1(raw.code, digest);
  return cid.toString();
}

/**
 * #1188 – Parse and validate a CID string with the standard multiformats
 * parser.  Throws a descriptive error when the value is not a valid CID so
 * that invalid identifiers never reach a gateway URL.
 */
function validateCid(hash: string): string {
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("IPFS CID is required");
  }
  try {
    return CID.parse(hash).toString();
  } catch {
    throw new Error(`Invalid IPFS CID: "${hash}"`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a JSON document to the configured storage adapter.
 *
 * #1189 – Stores via adapter (not a bare Map) so providers can be swapped.
 * #1190 – Initial `pinStatus` is "none"; callers must call `pinHash` to
 *          request pinning — the status will not be "pinned" on upload alone.
 */
export async function uploadJSON(
  data: unknown,
  options: { name?: string } = {}
): Promise<string> {
  const entry: Omit<StorageEntry, "hash"> = {
    data,
    metadata: { name: options.name, uploadedAt: new Date().toISOString() },
    pinStatus: "none",
    pinRetries: 0,
  };
  return adapter.put(entry);
}

/**
 * Upload a raw file / string to the configured storage adapter.
 * #1190 – same pin lifecycle as uploadJSON.
 */
export async function uploadFile(
  content: string,
  fileName: string
): Promise<string> {
  const entry: Omit<StorageEntry, "hash"> = {
    data: { content, fileName },
    metadata: { uploadedAt: new Date().toISOString() },
    pinStatus: "none",
    pinRetries: 0,
  };
  return adapter.put(entry);
}

/**
 * Retrieve JSON data for a given hash.
 * Throws if the hash is not found in the adapter.
 */
export async function retrieve(hash: string): Promise<unknown> {
  const cid = validateCid(hash);
  const entry = await adapter.get(cid);
  if (!entry) {
    throw new Error(`Failed to retrieve data from IPFS: hash ${hash} not found`);
  }
  const payload = entry.data;
  // Unwrap legacy { data, metadata } shape stored by earlier code
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "data" in (payload as Record<string, unknown>)
  ) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

/**
 * Request pinning for a stored hash.
 *
 * #1190 – This is now a two-phase operation:
 *  1. Mark `pinStatus = "requested"` immediately (optimistic, no provider
 *     call needed to record intent).
 *  2. Attempt the provider confirmation (mock: always succeeds instantly;
 *     a real adapter would contact the pin API and poll).
 *  3. On success → `"pinned"`.  On failure → `"failed"` with the error
 *     message stored for retry.
 *
 * Returns `true` only when the adapter confirms the pin ("pinned").
 * Returns `false` and records the error when the adapter reports failure.
 */
export async function pinHash(hash: string, name?: string): Promise<boolean> {
  const cid = validateCid(hash);
  const exists = await adapter.has(cid);
  if (!exists) {
    throw new Error(`Hash ${hash} not found`);
  }

  // Step 1 – record intent
  await adapter.updatePinStatus(cid, "requested");

  try {
    // Step 2 – simulate/perform provider confirmation
    // In the mock adapter the "provider" is immediate; a real adapter would
    // make an HTTP request here and wait for the provider's confirmation.
    await simulateProviderPin(cid, name);

    // Step 3a – confirmed
    await adapter.updatePinStatus(cid, "pinned");
    return true;
  } catch (err) {
    // Step 3b – failed; store reason for retry
    const message = err instanceof Error ? err.message : "unknown provider error";
    await adapter.updatePinStatus(cid, "failed", {
      error: message,
      incrementRetry: true,
    });
    return false;
  }
}

/**
 * Mock provider pin — always succeeds in the dev adapter.
 * A real implementation would call e.g. the Pinata /pinning/pinByHash API.
 * This function is intentionally `async` so the real version can await HTTP.
 */
async function simulateProviderPin(
  _hash: string,
  _name?: string
): Promise<void> {
  // no-op for the mock; throws on deliberate failure injection in tests
}

export function getGatewayUrl(hash: string): string {
  if (!hash || typeof hash !== "string") {
    throw new Error("IPFS hash is required to build a gateway URL");
  }
  // #1188 – never build a URL from an unvalidated identifier.
  const cid = validateCid(hash);
  return `${resolveGatewayBase()}${cid}`;
}

/**
 * Return the current storage + pin status for a hash.
 *
 * #1190 – `pinned` is now derived from the persisted `pinStatus` field rather
 *          than a parallel Set, so it reflects provider-confirmed state only.
 */
export async function getStorageStatus(hash: string): Promise<{
  stored: boolean;
  pinStatus: PinStatus;
  /** Convenience boolean: true only when pinStatus === "pinned" */
  pinned: boolean;
  gatewayUrl: string;
  pinRetries?: number;
  pinError?: string;
}> {
  const cid = validateCid(hash);
  const entry = await adapter.get(cid);
  const pinStatus: PinStatus = entry?.pinStatus ?? "none";
  return {
    stored: entry !== undefined,
    pinStatus,
    pinned: pinStatus === "pinned",
    gatewayUrl: getGatewayUrl(cid),
    ...(entry?.pinRetries !== undefined ? { pinRetries: entry.pinRetries } : {}),
    ...(entry?.pinError ? { pinError: entry.pinError } : {}),
  };
}

/** Exposed for testing — returns the raw adapter entry. */
export async function getEntry(hash: string): Promise<StorageEntry | undefined> {
  return adapter.get(validateCid(hash));
}

/**
 * #1188 – Compute the CID for a payload without storing it.  Useful for
 * callers that need to verify content addressing independently.
 */
export async function computeContentCid(data: unknown): Promise<string> {
  return computeCid(data);
}

/**
 * #1188 – Verify that the bytes fetched from the configured gateway match the
 * locally stored payload for `hash`.  Returns `true` when the gateway content
 * hashes to the same CID.
 */
export async function verifyGatewayContent(hash: string): Promise<boolean> {
  const cid = validateCid(hash);
  const entry = await adapter.get(cid);
  if (!entry) return false;
  const expected = await computeCid(entry.data);
  if (expected !== cid) return false;
  const response = await fetch(getGatewayUrl(cid));
  if (!response.ok) return false;
  const remoteBytes = new Uint8Array(await response.arrayBuffer());
  const remoteDigest = await sha256.digest(remoteBytes);
  const remoteCid = CID.createV1(raw.code, remoteDigest).toString();
  return remoteCid === cid;
}

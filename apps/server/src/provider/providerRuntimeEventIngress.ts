import type { ProviderRuntimeEvent } from "@nuncio/contracts";

export const PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE = 64;
export const PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES = 512 * 1024;

export function isTerminalProviderRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "turn.completed" || event.type === "session.exited";
}

/**
 * Sizing an event requires serializing it. Admission serializes twice for the
 * same object: once to decide whether the raw payload needs compacting, then
 * again as the ingress `sizeOf`. Memoizing per event object removes the second
 * pass. Keyed weakly so retained sizes cannot outlive the events themselves.
 */
const providerRuntimeEventByteCache = new WeakMap<ProviderRuntimeEvent, number>();

export function providerRuntimeEventBytes(event: ProviderRuntimeEvent): number {
  const cached = providerRuntimeEventByteCache.get(event);
  if (cached !== undefined) {
    return cached;
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    bytes = PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES + 1;
  }
  providerRuntimeEventByteCache.set(event, bytes);
  return bytes;
}

/**
 * Raw provider payloads are diagnostic data. Compact them before the callback
 * ingress so one pathological native message cannot consume the whole budget.
 */
export function compactProviderRuntimeEventForIngress(
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent {
  const originalBytes = providerRuntimeEventBytes(event);
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES || event.raw === undefined) {
    return event;
  }
  return {
    ...event,
    raw: {
      source: event.raw.source,
      ...(event.raw.method !== undefined ? { method: event.raw.method } : {}),
      ...(event.raw.messageType !== undefined ? { messageType: event.raw.messageType } : {}),
      payload: {
        nuncioadeTruncated: true,
        reason: "provider runtime event exceeded the callback ingress size limit",
        originalBytes,
      },
    },
  };
}

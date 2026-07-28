// FILE: event-ingress.ts
// Purpose: Compact oversized runtime events before they leave the sidecar.
// Layer: Sidecar engine (OMP)
// Exports: compactProviderRuntimeEventForIngress, providerRuntimeEventBytes

import type { ProviderRuntimeEvent } from "@synara/contracts";

const PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES = 512 * 1024;

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
    bytes = PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES + 1;
  }
  providerRuntimeEventByteCache.set(event, bytes);
  return bytes;
}

/**
 * Raw provider payloads are diagnostic data. Compact them before they cross the
 * wire so one pathological native message cannot exceed the 1 MiB frame cap.
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
        synaraTruncated: true,
        reason: "provider runtime event exceeded the callback ingress size limit",
        originalBytes,
      },
    },
  };
}

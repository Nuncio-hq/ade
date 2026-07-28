/**
 * OmpAdapter - OMP (oh-my-pi) direct SDK implementation of the generic provider
 * adapter contract.
 *
 * Like pi, OMP is treated as an unopinionated harness: NuncioADE does not add
 * permissions or plan-mode semantics on top of it.
 *
 * @module OmpAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "omp";
}

export class OmpAdapter extends ServiceMap.Service<OmpAdapter, OmpAdapterShape>()(
  "nuncioade/provider/Services/OmpAdapter",
) {}

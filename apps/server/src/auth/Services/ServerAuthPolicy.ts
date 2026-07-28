import type { ServerAuthDescriptor } from "@nuncio/contracts";
import { Effect, ServiceMap } from "effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends ServiceMap.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "nuncioade/auth/Services/ServerAuthPolicy",
) {}

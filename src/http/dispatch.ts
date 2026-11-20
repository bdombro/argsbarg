/*
In-process REST dispatch over the shared native-bound invocation seam.
It binds once, invokes once, and returns the transport-owned encoded response.
*/

import { bindHttpRequest, type HttpBindOptions } from "./bind.ts";
import { encodeHttpBindError, encodeHttpOutcome } from "./encode.ts";
import { type HttpRouteCatalog, invokeRegisteredHttpRoute } from "./routes.ts";

/** Dispatches one `Request` through one immutable REST registration catalog. */
export async function dispatchHttpRequest<Seed extends object = Record<never, never>>(
  /** Fixed route catalog shared with OpenAPI. */
  catalog: HttpRouteCatalog,
  /** Native Fetch request. */
  request: Request,
  /** Per-call mount and seed-local options. */
  options: HttpBindOptions<Seed> = {},
): Promise<Response> {
  const bound = await bindHttpRequest(catalog, request, options);
  if (!bound.ok) return encodeHttpBindError(bound);
  const outcome = await invokeRegisteredHttpRoute(bound.route, bound.rawInputs, bound.base);
  return encodeHttpOutcome(outcome, bound.route);
}

/*
Shared task subscription framing and delivery for HTTP and stdio.
Transport writers supply backpressure; watch cancellation never cancels a task.
*/

import { encodeMcpResult, type McpRequestId, type McpServerInfo } from "./protocol.ts";
import type { McpTask } from "./tasks.ts";

/** Correlates acknowledgments, events, and graceful completion on a shared transport. */
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** One already authorized app-owned task watch. */
export interface TaskWatch {
  /** Public ID acknowledged to the client. */
  readonly id: string;
  /** Provider iterator whose pending reads honor the watch signal. */
  readonly iterator: AsyncIterator<McpTask>;
  /** Validates the provider's snapshot and maps its local ID to the wire ID. */
  readonly snapshot: (value: unknown) => McpTask;
}

/** A prepared subscription retains its capacity slot until delivery finishes. */
export interface TaskSubscription {
  /** The original JSON-RPC request ID. */
  readonly id: McpRequestId;
  /** Identity for the terminal response. */
  readonly serverInfo: McpServerInfo;
  /** Watches authorized before the acknowledgment is sent. */
  readonly watches: readonly TaskWatch[];
  /** Aborts provider reads without aborting the underlying transport. */
  readonly controller: AbortController;
  /** Stops the watches and releases the subscription slot. */
  dispose(): void;
}

/** Resolves promptly on abort even if an app callback is slow to observe its signal. */
export function untilTaskAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    /** Stops waiting without leaving a late rejection unhandled. */
    const abort = (): void => resolve(undefined);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Sends the acknowledgment, backpressured updates, and server-initiated closure. */
export async function deliverTaskSubscription(
  subscription: TaskSubscription,
  send: (frame: object, signal?: AbortSignal) => Promise<void>,
  transport: AbortSignal,
  shutdown?: AbortSignal,
): Promise<void> {
  const { controller, id, watches } = subscription;
  const meta = { [SUBSCRIPTION_ID]: id };
  /** Stops producing updates during a graceful shutdown, leaving the writer open. */
  const stop = (): void => controller.abort();
  shutdown?.addEventListener("abort", stop, { once: true });
  if (shutdown?.aborted) stop();
  try {
    if (transport.aborted) return;
    await send({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: meta, notifications: watches.length === 0 ? {} : { taskIds: watches.map((watch) => watch.id) } },
    });

    let reason: string | undefined;
    try {
      await Promise.all(watches.map(async (watch) => {
        while (!controller.signal.aborted) {
          const next = await untilTaskAbort(Promise.resolve(watch.iterator.next()), controller.signal);
          if (controller.signal.aborted || next === undefined || next.done === true) return;
          const snapshot = watch.snapshot(next.value);
          await send({
            jsonrpc: "2.0",
            method: "notifications/tasks",
            params: { ...snapshot, _meta: meta },
          }, controller.signal);
        }
      }));
    } catch {
      if (!controller.signal.aborted) reason = "Task watch failed";
      stop();
    }

    if (transport.aborted) return;
    await send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, _meta: meta, ...(reason === undefined ? {} : { reason }) },
    });
    const completion = encodeMcpResult(id, {}, subscription.serverInfo);
    await send({
      ...completion,
      result: { ...completion.result, _meta: { ...completion.result._meta, ...meta } },
    });
  } finally {
    shutdown?.removeEventListener("abort", stop);
    subscription.dispose();
  }
}

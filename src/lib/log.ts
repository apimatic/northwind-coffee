/** Structured JSON logs, one object per line, for Workers Logs. */
export type LogEvent =
  | { event: "request"; method: string; path: string; status: number; ms: number }
  | { event: "error"; method: string; path: string; message: string; stack?: string; name?: string }
  | {
      /** One line per PayPal call outcome. Never carries tokens, secrets or request bodies. */
      event: "paypal";
      op: "create_order" | "get_order" | "capture_order" | "get_capture" | "refund";
      orderId: number;
      outcome: string;
      status?: number;
      debugId?: string;
      detail?: string;
    }
  | {
      /** The SDK is about to re-send an idempotent PayPal request (GET only). */
      event: "paypal_retry";
      attempt: number;
      delayMs: number;
      status?: number;
      fault?: string;
      tokenRequest?: boolean;
    };

export function log(entry: LogEvent): void {
  const line = JSON.stringify(entry);
  if (entry.event === "error") console.error(line);
  else if ((entry.event === "paypal" && entry.outcome !== "ok") || entry.event === "paypal_retry") console.warn(line);
  else console.log(line);
}

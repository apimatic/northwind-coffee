/** Structured JSON logs, one object per line, for Workers Logs. */
export type LogEvent =
  | { event: "request"; method: string; path: string; status: number; ms: number }
  | { event: "error"; method: string; path: string; message: string; stack?: string; name?: string }
  | { event: "payment"; action: string; orderId: number; outcome: string; providerOrderId?: string }
  | {
      event: "payment_error";
      action: string;
      orderId: number;
      name: string;
      message: string;
      status?: number;
      issue?: string | null;
      debugId?: string | null;
    };

export function log(entry: LogEvent): void {
  const line = JSON.stringify(entry);
  if (entry.event === "error" || entry.event === "payment_error") console.error(line);
  else console.log(line);
}

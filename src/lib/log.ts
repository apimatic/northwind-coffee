/** Structured JSON logs, one object per line, for Workers Logs. */
export type LogEvent =
  | { event: "request"; method: string; path: string; status: number; ms: number }
  | { event: "error"; method: string; path: string; message: string; stack?: string; name?: string };

export function log(entry: LogEvent): void {
  const line = JSON.stringify(entry);
  if (entry.event === "error") console.error(line);
  else console.log(line);
}

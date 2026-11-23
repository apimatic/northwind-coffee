import type { Child } from "hono/jsx";
import { CSRF_FIELD } from "../lib/csrf";
import { formatMoney } from "../lib/money";
import { statusLabel } from "../services/orders";

export function CsrfField(props: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={props.token} />;
}

export function Money(props: { cents: number; currency?: string }) {
  return <>{formatMoney(props.cents, props.currency)}</>;
}

export function StatusBadge(props: { status: string }) {
  return <span class={`status status-${props.status.replaceAll("_", "-")}`}>{statusLabel(props.status)}</span>;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export type FieldErrors = Partial<Record<string, string>>;

export function TextField(props: {
  label: string;
  name: string;
  value?: string;
  error?: string | undefined;
  type?: string;
  autocomplete?: string;
  required?: boolean;
  hint?: string;
  maxlength?: number;
}) {
  const id = `field-${props.name}`;
  const describedBy = [props.hint ? `${id}-hint` : null, props.error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div class={props.error ? "field has-error" : "field"}>
      <label for={id}>
        {props.label}
        {props.required === false ? <span class="optional"> (optional)</span> : null}
      </label>
      {props.hint ? (
        <p class="hint" id={`${id}-hint`}>
          {props.hint}
        </p>
      ) : null}
      <input
        id={id}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value ?? ""}
        autocomplete={props.autocomplete}
        required={props.required !== false}
        maxlength={props.maxlength}
        aria-invalid={props.error ? "true" : undefined}
        aria-describedby={describedBy || undefined}
      />
      {props.error ? (
        <p class="field-error" id={`${id}-error`}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function Alert(props: { kind: "error" | "info" | "success"; title?: string; children: Child }) {
  return (
    <div class={`alert alert-${props.kind}`} role={props.kind === "error" ? "alert" : "status"}>
      {props.title ? <p class="alert-title">{props.title}</p> : null}
      {props.children}
    </div>
  );
}

export function PageHeader(props: { title: string; children?: Child }) {
  return (
    <div class="page-header">
      <h1>{props.title}</h1>
      {props.children}
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import type { Health } from "../core/margin";

export function PageHead({ verdict, sub, lead, children }: { verdict: ReactNode; sub?: ReactNode; lead?: boolean; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1 className={lead ? "verdict verdict--lead" : "verdict"}>{verdict}</h1>
      {sub ? <p className="sub">{sub}</p> : null}
      {children ? <div className="actions">{children}</div> : null}
    </header>
  );
}

export function HealthStamp({ health, pct }: { health: Health; pct?: number | null }) {
  const map = { green: ["stamp--ok", "On target"], amber: ["stamp--warn", "Thin"], red: ["stamp--bad", "Losing"], unknown: ["stamp--quiet", "No data"] } as const;
  const [cls, label] = map[health];
  return <span className={`stamp ${cls}`}>{pct != null && health !== "unknown" ? `${label}` : label}</span>;
}

export function Stamp({ tone, children }: { tone: "ok" | "warn" | "bad" | "quiet"; children: ReactNode }) {
  return <span className={`stamp stamp--${tone}`}>{children}</span>;
}

export interface ActionResultLike { ok: boolean; message: string; redirectTo?: string; data?: unknown }

/** Posts to the current route's action, shows the result as a status toast. */
export function useIntent(action?: string) {
  const fetcher = useFetcher<ActionResultLike>();
  const [toast, setToast] = useState<ActionResultLike | null>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setToast(fetcher.data);
      const t = setTimeout(() => setToast(null), 6000);
      return () => clearTimeout(t);
    }
  }, [fetcher.state, fetcher.data]);
  return { fetcher, toast, busy: fetcher.state !== "idle", action };
}

export function Toast({ result, onClose }: { result: ActionResultLike | null; onClose?: () => void }) {
  if (!result) return null;
  return (
    <div className={`callout toast ${result.ok ? "callout--ok" : "callout--bad"}`} role={result.ok ? "status" : "alert"}>
      <span>{result.message}</span>
      {onClose ? <button type="button" className="btn btn--quiet btn--small" onClick={onClose}>Close</button> : null}
    </div>
  );
}

export function IntentButton({
  intent, fields = {}, children, variant = "default", small, confirm, disabled, action,
}: {
  intent: string; fields?: Record<string, string>; children: ReactNode; variant?: "default" | "primary" | "danger" | "quiet";
  small?: boolean; confirm?: string; disabled?: boolean; action?: string;
}) {
  const { fetcher, toast, busy } = useIntent();
  return (
    <>
      <fetcher.Form method="post" action={action} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }} style={{ display: "inline" }}>
        <input type="hidden" name="intent" value={intent} />
        {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <button className={`btn${variant !== "default" ? ` btn--${variant}` : ""}${small ? " btn--small" : ""}`} disabled={disabled || busy} data-loading={busy} aria-disabled={disabled || busy}>
          {children}
        </button>
      </fetcher.Form>
      <Toast result={toast} />
    </>
  );
}

export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p className="muted">{children}</p>
      {action}
    </div>
  );
}

export const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${v.toFixed(1)}%`);
export const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

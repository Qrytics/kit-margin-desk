/**
 * Control layer. Inside the Shopify admin the main interactive controls render as real Polaris web
 * components (s-button, s-text-field, s-number-field, s-email-field, s-select, s-checkbox, s-banner,
 * s-modal). Standalone demo mode, where the Polaris script and App Bridge are not available, renders
 * the same controls as native elements with the Bench styles. Callers never choose; they use these
 * components with identical props.
 *
 * React 18 specifics: custom elements get attributes only, so booleans are mapped to "" / undefined
 * and input/change events are bound with addEventListener in a ref.
 *
 * UNVERIFIED: the Polaris branch has been type-checked against @shopify/polaris-types but never
 * rendered inside a real Shopify admin.
 */
import { Link } from "react-router";
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";

const PolarisCtx = createContext(false);
export const PolarisProvider = PolarisCtx.Provider;
export const usePolaris = () => useContext(PolarisCtx);

const flag = (b?: boolean) => (b ? "" : undefined);

type Variant = "default" | "primary" | "danger" | "quiet";
const polarisVariant = (v: Variant) => (v === "primary" ? "primary" : v === "quiet" ? "tertiary" : "secondary");

export function Button({ children, variant = "default", small, type = "button", loading, disabled, onClick, href, download, name, value, label }: {
  children: ReactNode; variant?: Variant; small?: boolean; type?: "button" | "submit";
  loading?: boolean; disabled?: boolean; onClick?: () => void; href?: string; download?: boolean; name?: string; value?: string; label?: string;
}) {
  const polaris = usePolaris();
  if (polaris) {
    return (
      <s-button variant={polarisVariant(variant)} tone={variant === "danger" ? "critical" : undefined}
        type={type === "submit" ? "submit" : undefined} loading={flag(loading) as never} disabled={flag(disabled || loading) as never}
        href={href} accessibilityLabel={label} {...(download ? { download: "" } : {})} {...(name ? { name, value } : {})} onClick={onClick}>
        {children}
      </s-button>
    );
  }
  const cls = `btn${variant !== "default" ? ` btn--${variant}` : ""}${small ? " btn--small" : ""}`;
  if (href && !download && href.startsWith("/")) return <Link className={cls} to={href} aria-label={label}>{children}</Link>;
  if (href) return <a className={cls} href={href} download={download || undefined} aria-label={label}>{children}</a>;
  return (
    <button className={cls} type={type} name={name} value={value} disabled={disabled || loading} data-loading={loading || undefined}
      aria-disabled={disabled || loading || undefined} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

interface FieldBase { label: string; name?: string; hint?: string; error?: string; disabled?: boolean; required?: boolean; labelHidden?: boolean }

function useChange(onValue: ((v: string) => void) | undefined) {
  const ref = useRef<HTMLElement>(null);
  const cb = useRef(onValue);
  cb.current = onValue;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: Event) => cb.current?.((e.currentTarget as HTMLInputElement).value);
    el.addEventListener("input", h);
    el.addEventListener("change", h);
    return () => { el.removeEventListener("input", h); el.removeEventListener("change", h); };
  }, []);
  return ref;
}

export function TextField({ label, name, hint, error, disabled, required, labelHidden, type = "text", value, defaultValue, onValue, placeholder, step, min, max }: FieldBase & {
  type?: "text" | "number" | "email" | "search"; value?: string; defaultValue?: string; onValue?: (v: string) => void; placeholder?: string; step?: string; min?: string; max?: string;
}) {
  const polaris = usePolaris();
  const ref = useChange(onValue);
  const id = useId();
  if (polaris) {
    const common = {
      ref: ref as never, label, name, details: hint, error, placeholder, value, defaultValue, disabled: flag(disabled), required: flag(required),
      labelAccessibilityVisibility: labelHidden ? "exclusive" : undefined,
    } as object;
    if (type === "number") return <s-number-field {...common} step={step === undefined ? undefined : Number(step)} min={min === undefined ? undefined : Number(min)} max={max === undefined ? undefined : Number(max)} inputMode="decimal" />;
    if (type === "email") return <s-email-field {...common} />;
    return <s-text-field {...common} />;
  }
  return (
    <label className="field" htmlFor={id}>
      {labelHidden ? <span className="sr-only">{label}</span> : label}
      <input id={id} name={name} type={type} value={value} defaultValue={defaultValue} placeholder={placeholder} step={step} min={min} max={max}
        disabled={disabled} required={required} aria-invalid={error ? true : undefined} onChange={onValue ? (e) => onValue(e.target.value) : undefined} />
      {error ? <span className="hint" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Select({ label, name, hint, disabled, labelHidden, value, defaultValue, onValue, options }: FieldBase & {
  value?: string; defaultValue?: string; onValue?: (v: string) => void; options: Array<{ value: string; label: string }>;
}) {
  const polaris = usePolaris();
  const ref = useChange(onValue);
  const id = useId();
  if (polaris) {
    return (
      <s-select ref={ref as never} label={label} name={name} details={hint} value={value ?? defaultValue} disabled={flag(disabled) as never}
        labelAccessibilityVisibility={labelHidden ? "exclusive" : undefined}>
        {options.map((o) => <s-option key={o.value} value={o.value}>{o.label}</s-option>)}
      </s-select>
    );
  }
  return (
    <label className="field" htmlFor={id}>
      {labelHidden ? <span className="sr-only">{label}</span> : label}
      <select id={id} name={name} value={value} defaultValue={defaultValue} disabled={disabled} onChange={onValue ? (e) => onValue(e.target.value) : undefined}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ label, name, hint, disabled, checked, defaultChecked, onChecked }: FieldBase & {
  checked?: boolean; defaultChecked?: boolean; onChecked?: (c: boolean) => void;
}) {
  const polaris = usePolaris();
  const ref = useRef<HTMLElement>(null);
  const cb = useRef(onChecked);
  cb.current = onChecked;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: Event) => cb.current?.(!!(e.currentTarget as HTMLInputElement).checked);
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  }, []);
  if (polaris) {
    return <s-checkbox ref={ref as never} label={label} name={name} details={hint} checked={flag(checked) as never} defaultChecked={flag(defaultChecked) as never} disabled={flag(disabled) as never} />;
  }
  return (
    <label className="check">
      <input type="checkbox" name={name} checked={checked} defaultChecked={defaultChecked} disabled={disabled} onChange={onChecked ? (e) => onChecked(e.target.checked) : undefined} />
      <span>{label}{hint ? <span className="hint" style={{ display: "block" }}>{hint}</span> : null}</span>
    </label>
  );
}

export type BannerTone = "ok" | "warn" | "bad" | "info";

export function Banner({ tone, children, role, heading, className = "", style, toast }: {
  tone: BannerTone; children: ReactNode; role?: "status" | "alert"; heading?: string; className?: string; style?: React.CSSProperties; toast?: boolean;
}) {
  const polaris = usePolaris();
  if (polaris) {
    const t = tone === "ok" ? "success" : tone === "warn" ? "warning" : tone === "bad" ? "critical" : "info";
    return (
      <div className={toast ? "toast toast--polaris" : className} role={role} style={toast ? undefined : style}>
        <s-banner tone={t} heading={heading}>{children}</s-banner>
      </div>
    );
  }
  return (
    <div className={`callout callout--${tone === "info" ? "ok" : tone}${toast ? " toast" : ""} ${className}`.trim()} role={role} style={style}>
      {heading ? <strong>{heading}</strong> : null}
      <span>{children}</span>
    </div>
  );
}

/** Confirmation dialog. Polaris: s-modal opened via commandFor from the trigger. Native: <dialog>. */
export function ConfirmModal({ id, heading, body, confirmLabel, tone, onConfirm }: {
  id: string; heading: string; body: ReactNode; confirmLabel: string; tone?: "critical"; onConfirm: () => void;
}) {
  const polaris = usePolaris();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (polaris) return;
    const open = (e: Event) => { if ((e as CustomEvent).detail === id) ref.current?.showModal(); };
    window.addEventListener("kmd:open-modal", open);
    return () => window.removeEventListener("kmd:open-modal", open);
  }, [polaris, id]);
  if (polaris) {
    return (
      <s-modal id={id} heading={heading}>
        <s-text>{body}</s-text>
        <s-button slot="primary-action" variant="primary" tone={tone} onClick={onConfirm} {...{ commandFor: id, command: "--hide" }}>{confirmLabel}</s-button>
        <s-button slot="secondary-actions" {...{ commandFor: id, command: "--hide" }}>Cancel</s-button>
      </s-modal>
    );
  }
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{heading}</h2>
      <p style={{ margin: "12px 0 20px" }}>{body}</p>
      <div className="row">
        <button type="button" className={`btn ${tone === "critical" ? "btn--danger" : "btn--primary"}`} onClick={() => { ref.current?.close(); onConfirm(); }}>{confirmLabel}</button>
        <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
      </div>
    </dialog>
  );
}

export function ModalTrigger({ modalId, children, variant = "default", small, disabled }: { modalId: string; children: ReactNode; variant?: Variant; small?: boolean; disabled?: boolean }) {
  const polaris = usePolaris();
  if (polaris) {
    return <s-button variant={polarisVariant(variant)} tone={variant === "danger" ? "critical" : undefined} disabled={flag(disabled) as never} {...{ commandFor: modalId, command: "--show" }}>{children}</s-button>;
  }
  return <Button variant={variant} small={small} disabled={disabled} onClick={() => window.dispatchEvent(new CustomEvent("kmd:open-modal", { detail: modalId }))}>{children}</Button>;
}

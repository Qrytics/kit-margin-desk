/** Provider abstraction for outbound mail. No SMTP/vendor SDK: a webhook (Zapier, Make, your own relay) or the console. */
export interface OutboundMail { to: string; subject: string; text: string; html: string }
export interface MailProvider { name: string; send(mail: OutboundMail): Promise<{ ok: boolean; detail: string }> }

export class ConsoleMailProvider implements MailProvider {
  name = "console";
  constructor(private log: (line: string) => void = (l) => console.log(l)) {}
  async send(m: OutboundMail) {
    this.log(`[digest:console] to=${m.to} subject=${m.subject}\n${m.text}`);
    return { ok: true, detail: "Logged to console (no mail provider configured)." };
  }
}

export class WebhookMailProvider implements MailProvider {
  name = "webhook";
  constructor(private url: string, private fetchFn: typeof fetch = fetch, private secret?: string) {}
  async send(m: OutboundMail) {
    try {
      const res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}) },
        body: JSON.stringify({ kind: "kit-margin-desk.digest", ...m }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? { ok: true, detail: `Webhook accepted (${res.status}).` } : { ok: false, detail: `Webhook returned ${res.status}.` };
    } catch (e) {
      return { ok: false, detail: `Webhook failed: ${(e as Error).message}` };
    }
  }
}

/** DIGEST_PROVIDER=webhook|console (default: webhook when DIGEST_WEBHOOK_URL is set, else console). */
export function providerFromEnv(env: Record<string, string | undefined> = process.env, fetchFn: typeof fetch = fetch): MailProvider {
  const kind = env.DIGEST_PROVIDER ?? (env.DIGEST_WEBHOOK_URL ? "webhook" : "console");
  if (kind === "webhook") {
    if (!env.DIGEST_WEBHOOK_URL) return new ConsoleMailProvider();
    return new WebhookMailProvider(env.DIGEST_WEBHOOK_URL, fetchFn, env.DIGEST_WEBHOOK_SECRET);
  }
  return new ConsoleMailProvider();
}

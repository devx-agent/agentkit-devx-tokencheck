import { readFileSync } from "node:fs";
import { join } from "node:path";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");
export const PR_B64 = fx("payment_required.b64").trim();
export const DEGEN_DEMO = JSON.parse(fx("degen_demo.json"));
export const DANGER_PAID = JSON.parse(fx("danger_paid.json"));

export const decode = (b64: string) => JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
export const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** Payment-required header with a field of accepts[0] changed. */
export function prWith(patch: Record<string, unknown>): string {
  const d = decode(PR_B64);
  d.accepts = [{ ...d.accepts[0], ...patch }];
  return encode(d);
}

export interface Call { url: string; headers: Record<string, string> }

/**
 * Fake x402 server: unpaid request -> 402 with the (real, captured) PAYMENT-REQUIRED header,
 * request with PAYMENT-SIGNATURE -> 200 with `paidBody`. Demo URL -> DEGEN demo fixture.
 */
export function fakeServer(opts: { pr?: string; paidBody?: unknown } = {}) {
  const calls: Call[] = [];
  const f = async (input: any, init: any = {}) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    calls.push({ url: req.url, headers });
    if (req.url.includes("/v1/token/demo")) return new Response(JSON.stringify(DEGEN_DEMO), { status: 200, headers: { "content-type": "application/json" } });
    if (headers["payment-signature"]) {
      return new Response(JSON.stringify(opts.paidBody ?? DANGER_PAID), {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": encode({ success: true, transaction: "0xabc123", network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }) },
      });
    }
    return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": opts.pr ?? PR_B64 } });
  };
  return { fetch: f as unknown as typeof globalThis.fetch, calls };
}

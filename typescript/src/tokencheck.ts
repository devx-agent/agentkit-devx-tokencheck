/**
 * DevX Token Check client (shared core).
 *
 * Calls https://tokencheck.madebydevx.com/v1/token/verdict, paying $0.01 USDC on Base via x402 v2
 * with the caller's own EVM signer. Known demo tokens (Base USDC/WETH/DEGEN/AERO) use the free
 * /v1/token/demo endpoint instead, and are the fallback when no signer is configured.
 *
 * Safety: the client refuses to pay unless the 402 asks for Base USDC, to the pinned DevX payee,
 * at or below maxPriceAtomic (default 10000 = $0.01).
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_BASE_URL = "https://tokencheck.madebydevx.com";
/** DevX payee (Made by DevX main wallet). Payments to any other address are refused. */
export const DEVX_PAY_TO = "0xe30c4544eC57ac44d8586eB49e49e267fc2d40DB";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_NETWORK = "eip155:8453";
export const DEFAULT_MAX_PRICE_ATOMIC = 10_000n; // 0.01 USDC (6 decimals)

export const SUPPORTED_CHAINS = ["base", "ethereum", "arbitrum", "optimism", "polygon", "robinhood", "solana"] as const;
export type TokenChain = (typeof SUPPORTED_CHAINS)[number];

const CHAIN_ALIASES: Record<string, TokenChain> = {
  base: "base", "8453": "base",
  ethereum: "ethereum", eth: "ethereum", mainnet: "ethereum", "1": "ethereum",
  arbitrum: "arbitrum", arb: "arbitrum", "42161": "arbitrum",
  optimism: "optimism", op: "optimism", "10": "optimism",
  polygon: "polygon", matic: "polygon", pol: "polygon", "137": "polygon",
  robinhood: "robinhood", rh: "robinhood", "4663": "robinhood",
  solana: "solana", sol: "solana",
};

/** Free demo tokens (Base only): USDC, WETH, DEGEN, AERO. */
export const DEMO_TOKENS: Record<string, string> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0x4200000000000000000000000000000000000006": "WETH",
  "0x4ed4e862860bed51a9570b96d89af5e1b0efefed": "DEGEN",
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": "AERO",
};

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function normalizeChain(chain?: string | null): TokenChain | null {
  if (chain == null || chain === "") return "base";
  const c = String(chain).trim().toLowerCase().replace(/^eip155:/, "");
  return CHAIN_ALIASES[c] ?? null;
}

export function isValidAddress(chain: TokenChain, address: string): boolean {
  return chain === "solana" ? SOL_RE.test(address) && !address.startsWith("0x") : EVM_RE.test(address);
}

export function isDemoToken(chain: TokenChain, address: string): boolean {
  return chain === "base" && address.toLowerCase() in DEMO_TOKENS;
}

export type Verdict = "safe" | "caution" | "danger";

export interface TokenCheckReason { severity: string; code: string; message: string }

export interface TokenCheckResult {
  ok: boolean;
  /** "paid" = x402 paid call, "demo" = free demo endpoint, "none" = no result */
  source: "paid" | "demo" | "none";
  chain: TokenChain | null;
  address: string;
  verdict?: Verdict;
  riskScore?: number;
  confidence?: number;
  grade?: string;
  oneLiner?: string;
  symbol?: string;
  name?: string;
  reasons?: TokenCheckReason[];
  flags?: Record<string, boolean>;
  honeypot?: { buyTaxPct?: number | null; sellTaxPct?: number | null; sellOk?: boolean | null };
  operationId?: string | null;
  pageUrl?: string | null;
  payment?: { transaction?: string; payer?: string; network?: string } | null;
  /** Error code when ok=false: invalid_input | payment_not_configured | payment_refused | payment_failed | http_error | network_error */
  error?: string;
  message?: string;
  /** Full JSON body returned by the service. */
  raw?: unknown;
}

export interface TokenCheckClientOptions {
  /** 0x-prefixed EVM private key of the agent's own wallet (Base USDC pays the fee). */
  privateKey?: string;
  /** Alternative to privateKey: any x402 ClientEvmSigner ({ address, signTypedData }). */
  signer?: { address: `0x${string}`; signTypedData: (m: any) => Promise<`0x${string}`> };
  baseUrl?: string;
  /** Max price per call in USDC atomic units (6 decimals). Default 10000 ($0.01). */
  maxPriceAtomic?: bigint;
  /** Payee to require. Default: the DevX address. */
  payTo?: string;
  /** Use the free demo endpoint for demo tokens even when a signer exists. Default true. */
  preferDemo?: boolean;
  /** Never pay; demo tokens only. Default false. */
  demoOnly?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export function usdcToAtomic(v: string | number): bigint {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`invalid USDC amount: ${s}`);
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

/** x402 policy: keep only Base USDC requirements to the pinned payee at or below the cap. */
export function makePaymentPolicy(payTo: string, maxAtomic: bigint) {
  return (_v: number, reqs: PaymentRequirements[]): PaymentRequirements[] =>
    reqs.filter((r: any) => {
      const amount = r.amount ?? r.maxAmountRequired;
      try {
        return (
          r.scheme === "exact" &&
          (r.network === BASE_NETWORK || r.network === "base") &&
          String(r.asset).toLowerCase() === BASE_USDC.toLowerCase() &&
          String(r.payTo).toLowerCase() === payTo.toLowerCase() &&
          BigInt(amount) <= maxAtomic
        );
      } catch {
        return false;
      }
    });
}

function toResult(base: Pick<TokenCheckResult, "chain" | "address">, source: "paid" | "demo", body: any, payment: TokenCheckResult["payment"]): TokenCheckResult {
  const r = body?.result ?? body ?? {};
  const hp = r.honeypot ?? {};
  return {
    ok: true,
    source,
    ...base,
    verdict: r.verdict,
    riskScore: r.risk_score,
    confidence: r.confidence,
    grade: r.grade,
    oneLiner: r.one_liner,
    symbol: r.token?.symbol ?? r.metrics?.ticker,
    name: r.token?.name ?? r.metrics?.tokenName,
    reasons: Array.isArray(r.reasons) ? r.reasons : [],
    flags: r.flags,
    honeypot: { buyTaxPct: hp.buy_tax_pct ?? null, sellTaxPct: hp.sell_tax_pct ?? null, sellOk: hp.sell_ok ?? null },
    operationId: body?.operation_id ?? null,
    pageUrl: body?.page_url ?? null,
    payment,
    raw: body,
  };
}

export class TokenCheckClient {
  readonly baseUrl: string;
  readonly maxPriceAtomic: bigint;
  readonly payTo: string;
  readonly payerAddress: string | null;
  private readonly opts: TokenCheckClientOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private paidFetch: typeof globalThis.fetch | null = null;

  constructor(opts: TokenCheckClientOptions = {}) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxPriceAtomic = opts.maxPriceAtomic ?? DEFAULT_MAX_PRICE_ATOMIC;
    this.payTo = opts.payTo ?? DEVX_PAY_TO;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    let signer = opts.signer ?? null;
    if (!signer && opts.privateKey && !opts.demoOnly) {
      const pk = opts.privateKey.startsWith("0x") ? opts.privateKey : `0x${opts.privateKey}`;
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("invalid EVM private key format");
      signer = privateKeyToAccount(pk as `0x${string}`);
    }
    this.payerAddress = signer?.address ?? null;
    if (signer && !opts.demoOnly) {
      const client = new x402Client();
      client.register(BASE_NETWORK as any, new ExactEvmScheme(signer as any));
      client.registerPolicy(makePaymentPolicy(this.payTo, this.maxPriceAtomic));
      this.paidFetch = wrapFetchWithPayment(this.fetchImpl, client);
    }
  }

  get canPay(): boolean {
    return this.paidFetch !== null;
  }

  private async timed(f: typeof globalThis.fetch, url: string, init: RequestInit = {}): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      return await f(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Free demo call (Base USDC/WETH/DEGEN/AERO only). */
  async demo(address: string): Promise<TokenCheckResult> {
    const base = { chain: "base" as TokenChain, address };
    try {
      const res = await this.timed(this.fetchImpl, `${this.baseUrl}/v1/token/demo?chain=base&address=${encodeURIComponent(address)}`);
      const body: any = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, source: "none", ...base, error: "http_error", message: body?.error ?? `HTTP ${res.status}`, raw: body };
      return toResult(base, "demo", body, null);
    } catch (e: any) {
      return { ok: false, source: "none", ...base, error: "network_error", message: String(e?.message ?? e) };
    }
  }

  /** Token risk verdict. Pays $0.01 via x402 unless the token is a free demo token. */
  async check(chainIn: string | undefined, addressIn: string, o: { requestKey?: string } = {}): Promise<TokenCheckResult> {
    const address = String(addressIn ?? "").trim();
    const chain = normalizeChain(chainIn);
    if (!chain) return { ok: false, source: "none", chain: null, address, error: "invalid_input", message: `unsupported chain "${chainIn}"; use one of ${SUPPORTED_CHAINS.join(", ")}` };
    if (!isValidAddress(chain, address)) return { ok: false, source: "none", chain, address, error: "invalid_input", message: `invalid ${chain} token address` };
    const demo = isDemoToken(chain, address);
    if (demo && (this.opts.preferDemo !== false || !this.paidFetch)) return this.demo(address);
    if (!this.paidFetch) {
      return {
        ok: false, source: "none", chain, address, error: "payment_not_configured",
        message: `No wallet configured for x402 payment. Paid checks cost $0.01 USDC on Base; the free demo covers only Base ${Object.values(DEMO_TOKENS).join("/")}.`,
      };
    }
    const qs = new URLSearchParams({ chain, address });
    if (o.requestKey) qs.set("requestKey", o.requestKey);
    try {
      const res = await this.timed(this.paidFetch, `${this.baseUrl}/v1/token/verdict?${qs}`, { headers: { accept: "application/json" } });
      const body: any = await res.json().catch(() => null);
      if (!res.ok) {
        if (demo) return this.demo(address);
        return { ok: false, source: "none", chain, address, error: res.status === 402 ? "payment_failed" : "http_error", message: body?.message ?? body?.error ?? `HTTP ${res.status}`, raw: body };
      }
      let payment: TokenCheckResult["payment"] = null;
      const pr = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      if (pr) {
        try {
          const d: any = decodePaymentResponseHeader(pr);
          payment = { transaction: d.transaction, payer: d.payer, network: d.network };
        } catch { /* ignore */ }
      }
      return toResult({ chain, address }, "paid", body, payment);
    } catch (e: any) {
      if (demo) return this.demo(address);
      const msg = String(e?.message ?? e);
      const refused = /no .*payment requirements|polic|not supported|no matching|spend/i.test(msg);
      return { ok: false, source: "none", chain, address, error: refused ? "payment_refused" : "network_error", message: msg };
    }
  }
}

/** Pull a token reference out of free text: "check 0xabc... on arbitrum". Returns the last address. */
export function extractToken(text: string, defaultChain: string = "base"): { chain: TokenChain; address: string } | null {
  if (!text) return null;
  const evm = text.match(/0x[0-9a-fA-F]{40}/g);
  let chain = normalizeChain(defaultChain) ?? "base";
  const lower = text.toLowerCase();
  for (const [alias, c] of Object.entries(CHAIN_ALIASES)) {
    if (/^\d+$/.test(alias) || alias.length < 3) continue;
    if (new RegExp(`\\b${alias}\\b`).test(lower)) { chain = c; break; }
  }
  if (evm) return { chain: chain === "solana" ? "base" : chain, address: evm[evm.length - 1] };
  if (chain === "solana") {
    const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g);
    if (sol) return { chain: "solana", address: sol[sol.length - 1] };
  }
  return null;
}

export function summarize(r: TokenCheckResult): string {
  if (!r.ok) return `Token Check unavailable for ${r.address || "token"}: ${r.message ?? r.error}`;
  const top = (r.reasons ?? []).filter((x) => x.severity !== "info").slice(0, 3).map((x) => x.message);
  const sym = r.symbol ? `$${r.symbol}` : r.address;
  const tax = r.honeypot && (r.honeypot.buyTaxPct != null || r.honeypot.sellTaxPct != null) ? ` Tax buy ${r.honeypot.buyTaxPct ?? "?"}% / sell ${r.honeypot.sellTaxPct ?? "?"}%.` : "";
  const src = r.source === "demo" ? " (free demo)" : r.payment?.transaction ? ` (paid $0.01, tx ${r.payment.transaction})` : " (paid)";
  return `DevX Token Check ${sym} on ${r.chain}: ${String(r.verdict).toUpperCase()} (risk ${r.riskScore}, confidence ${r.confidence}).${top.length ? " " + top.join("; ") + "." : ""}${tax}${src} Informational only, not financial advice.`;
}

export interface GuardPolicy {
  /** Verdicts that block. Default ["danger"]. */
  blockOn?: Verdict[];
  /** Block when no verdict could be obtained. Default false (fail open, with a warning). */
  failClosed?: boolean;
}

export function guardDecision(r: TokenCheckResult, p: GuardPolicy = {}): { allow: boolean; reason: string } {
  const blockOn = p.blockOn ?? ["danger"];
  if (!r.ok) return { allow: !p.failClosed, reason: `no verdict (${r.error}): ${r.message}` };
  if (r.verdict && blockOn.includes(r.verdict)) return { allow: false, reason: summarize(r) };
  return { allow: true, reason: summarize(r) };
}

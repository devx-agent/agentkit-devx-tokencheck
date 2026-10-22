import { describe, it, expect } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  TokenCheckClient, normalizeChain, isValidAddress, extractToken, usdcToAtomic, makePaymentPolicy,
  guardDecision, summarize, DEVX_PAY_TO, BASE_USDC,
} from "../src/tokencheck";
import { fakeServer, prWith, decode, DANGER_PAID } from "./helpers";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const RANDOM = "0x1111111111111111111111111111111111111111";
const LIVE = process.env.LIVE !== "0";

describe("helpers", () => {
  it("normalizes chains and aliases", () => {
    expect(normalizeChain(undefined)).toBe("base");
    expect(normalizeChain("ETH")).toBe("ethereum");
    expect(normalizeChain("eip155:42161")).toBe("arbitrum");
    expect(normalizeChain("sol")).toBe("solana");
    expect(normalizeChain("bsc")).toBeNull();
  });
  it("validates addresses", () => {
    expect(isValidAddress("base", DEGEN)).toBe(true);
    expect(isValidAddress("base", "0x123")).toBe(false);
    expect(isValidAddress("solana", "So11111111111111111111111111111111111111112")).toBe(true);
    expect(isValidAddress("solana", DEGEN)).toBe(false);
  });
  it("extracts tokens from text", () => {
    expect(extractToken(`is ${DEGEN} safe?`)).toEqual({ chain: "base", address: DEGEN });
    expect(extractToken(`check ${RANDOM} on arbitrum`)).toEqual({ chain: "arbitrum", address: RANDOM });
    expect(extractToken("rug check So11111111111111111111111111111111111111112 on solana")?.chain).toBe("solana");
    expect(extractToken("hello")).toBeNull();
  });
  it("parses USDC amounts", () => {
    expect(usdcToAtomic("0.01")).toBe(10000n);
    expect(usdcToAtomic(1)).toBe(1000000n);
    expect(() => usdcToAtomic("abc")).toThrow();
  });
  it("payment policy pins asset, payee, network and price", () => {
    const p = makePaymentPolicy(DEVX_PAY_TO, 10000n);
    const ok: any = { scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: DEVX_PAY_TO, amount: "10000" };
    expect(p(2, [ok])).toHaveLength(1);
    expect(p(2, [{ ...ok, amount: "10001" }])).toHaveLength(0);
    expect(p(2, [{ ...ok, payTo: RANDOM }])).toHaveLength(0);
    expect(p(2, [{ ...ok, network: "eip155:1" }])).toHaveLength(0);
    expect(p(2, [{ ...ok, asset: RANDOM }])).toHaveLength(0);
  });
  it("guard decisions", () => {
    const danger: any = { ok: true, source: "paid", chain: "base", address: RANDOM, verdict: "danger", reasons: [] };
    expect(guardDecision(danger).allow).toBe(false);
    expect(guardDecision({ ...danger, verdict: "caution" }).allow).toBe(true);
    expect(guardDecision({ ...danger, verdict: "caution" }, { blockOn: ["danger", "caution"] }).allow).toBe(false);
    const none: any = { ok: false, source: "none", chain: "base", address: RANDOM, error: "network_error" };
    expect(guardDecision(none).allow).toBe(true);
    expect(guardDecision(none, { failClosed: true }).allow).toBe(false);
  });
});

describe("client (mocked server, real x402 signing, no funds)", () => {
  it("pays $0.01 to the pinned DevX payee and parses the verdict", async () => {
    const s = fakeServer();
    const c = new TokenCheckClient({ privateKey: generatePrivateKey(), fetch: s.fetch });
    const r = await c.check("base", RANDOM);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("paid");
    expect(r.verdict).toBe("danger");
    expect(r.payment?.transaction).toBe("0xabc123");
    expect(s.calls).toHaveLength(2);
    const sig = decode(s.calls[1].headers["payment-signature"]);
    expect(sig.accepted.amount).toBe("10000");
    expect(sig.accepted.payTo.toLowerCase()).toBe(DEVX_PAY_TO.toLowerCase());
    expect(sig.payload.authorization.to.toLowerCase()).toBe(DEVX_PAY_TO.toLowerCase());
    expect(sig.payload.authorization.value).toBe("10000");
    expect(summarize(r)).toContain("DANGER");
  });
  it("refuses a different payee", async () => {
    const s = fakeServer({ pr: prWith({ payTo: RANDOM }) });
    const r = await new TokenCheckClient({ privateKey: generatePrivateKey(), fetch: s.fetch }).check("base", RANDOM);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("payment_refused");
    expect(s.calls.some((c) => c.headers["payment-signature"])).toBe(false);
  });
  it("refuses a higher price than the cap", async () => {
    const s = fakeServer({ pr: prWith({ amount: "20000" }) });
    const r = await new TokenCheckClient({ privateKey: generatePrivateKey(), fetch: s.fetch }).check("base", RANDOM);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("payment_refused");
    expect(s.calls.some((c) => c.headers["payment-signature"])).toBe(false);
  });
  it("allows a raised cap", async () => {
    const s = fakeServer({ pr: prWith({ amount: "20000" }) });
    const r = await new TokenCheckClient({ privateKey: generatePrivateKey(), fetch: s.fetch, maxPriceAtomic: 20000n }).check("base", RANDOM);
    expect(r.ok).toBe(true);
  });
  it("uses the free demo for demo tokens even with a wallet", async () => {
    const s = fakeServer();
    const r = await new TokenCheckClient({ privateKey: generatePrivateKey(), fetch: s.fetch }).check("base", DEGEN);
    expect(r.source).toBe("demo");
    expect(r.verdict).toBe("caution");
    expect(s.calls.every((c) => c.url.includes("/v1/token/demo"))).toBe(true);
  });
  it("without a wallet: demo tokens work, others return payment_not_configured with no request", async () => {
    const s = fakeServer();
    const c = new TokenCheckClient({ fetch: s.fetch });
    expect(c.canPay).toBe(false);
    expect((await c.check("base", DEGEN)).source).toBe("demo");
    const r = await c.check("base", RANDOM);
    expect(r.error).toBe("payment_not_configured");
    expect(s.calls).toHaveLength(1);
  });
  it("demoOnly never pays", async () => {
    const s = fakeServer();
    const c = new TokenCheckClient({ privateKey: generatePrivateKey(), demoOnly: true, fetch: s.fetch });
    expect(c.canPay).toBe(false);
    expect((await c.check("ethereum", RANDOM)).error).toBe("payment_not_configured");
  });
  it("rejects bad input before any request", async () => {
    const s = fakeServer();
    const c = new TokenCheckClient({ privateKey: generatePrivateKey(), fetch: s.fetch });
    expect((await c.check("bsc", RANDOM)).error).toBe("invalid_input");
    expect((await c.check("base", "0x12")).error).toBe("invalid_input");
    expect(s.calls).toHaveLength(0);
  });
});

describe.runIf(LIVE)("live production (no money moves)", () => {
  it("free demo returns a verdict", async () => {
    const r = await new TokenCheckClient().check("base", DEGEN);
    expect(r.ok).toBe(true);
    expect(r.source).toBe("demo");
    expect(["safe", "caution", "danger"]).toContain(r.verdict);
  }, 30000);
  it("real 402 is accepted by the policy and signed; unfunded wallet is rejected without charge", async () => {
    const r = await new TokenCheckClient({ privateKey: generatePrivateKey() }).check("base", "0x532f27101965dd16442E59d40670FaF5eBB142E4");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("payment_failed");
    expect(JSON.stringify(r.raw ?? r.message)).toMatch(/insufficient|invalid|balance|payment/i);
  }, 45000);
});

import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base, arbitrum } from "viem/chains";
import { AgentKit, ViemWalletProvider, ActionProvider, EvmWalletProvider } from "@coinbase/agentkit";
import { z } from "zod";
// compiled with tsc (decorator metadata), see "pretest"
import { devxTokenCheckActionProvider, withTokenCheckGuard, chainForWallet } from "../dist/index.js";
import { fakeServer, decode } from "./helpers";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
const RANDOM = "0x1111111111111111111111111111111111111111";
const PAYTO = "0xe30c4544eC57ac44d8586eB49e49e267fc2d40DB";

const wallet = (chain = base) =>
  new ViemWalletProvider(createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain, transport: http("http://127.0.0.1:1") }));

const byName = (acts: any[], n: string) => acts.find((a) => a.name.endsWith(n));

describe("DevxTokenCheckActionProvider", () => {
  it("exposes two actions through AgentKit", async () => {
    const agentkit = await AgentKit.from({ walletProvider: wallet(), actionProviders: [devxTokenCheckActionProvider()] });
    const names = agentkit.getActions().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["DevxTokenCheckActionProvider_check_token_risk", "DevxTokenCheckActionProvider_pre_swap_token_check"]));
  });
  it("maps wallet network to chain", () => {
    expect(chainForWallet(wallet(base))).toBe("base");
    expect(chainForWallet(wallet(arbitrum))).toBe("arbitrum");
  });
  it("check_token_risk pays via x402 with the wallet's signer (mocked server)", async () => {
    const s = fakeServer();
    const w = wallet();
    const acts = devxTokenCheckActionProvider({ fetch: s.fetch }).getActions(w);
    const out = JSON.parse(await byName(acts, "check_token_risk").invoke({ tokenAddress: RANDOM }));
    expect(out.ok).toBe(true);
    expect(out.source).toBe("paid");
    expect(out.verdict).toBe("danger");
    const sig = decode(s.calls[1].headers["payment-signature"]);
    expect(sig.payload.authorization.from.toLowerCase()).toBe(w.getAddress().toLowerCase());
    expect(sig.payload.authorization.to.toLowerCase()).toBe(PAYTO.toLowerCase());
    expect(sig.payload.authorization.value).toBe("10000");
  });
  it("uses the wallet chain by default and explicit chain when given", async () => {
    const s = fakeServer();
    const acts = devxTokenCheckActionProvider({ fetch: s.fetch }).getActions(wallet(arbitrum));
    await byName(acts, "check_token_risk").invoke({ tokenAddress: RANDOM });
    expect(s.calls[0].url).toContain("chain=arbitrum");
    await byName(acts, "check_token_risk").invoke({ tokenAddress: RANDOM, chain: "polygon" });
    expect(s.calls[2].url).toContain("chain=polygon");
  });
  it("demo tokens are free", async () => {
    const s = fakeServer();
    const acts = devxTokenCheckActionProvider({ fetch: s.fetch }).getActions(wallet());
    const out = JSON.parse(await byName(acts, "check_token_risk").invoke({ tokenAddress: DEGEN }));
    expect(out.source).toBe("demo");
    expect(s.calls.every((c) => !c.headers["payment-signature"])).toBe(true);
  });
  it("demoOnly never signs", async () => {
    const s = fakeServer();
    const acts = devxTokenCheckActionProvider({ fetch: s.fetch, demoOnly: true }).getActions(wallet());
    const out = JSON.parse(await byName(acts, "check_token_risk").invoke({ tokenAddress: RANDOM }));
    expect(out.error).toBe("payment_not_configured");
    expect(s.calls).toHaveLength(0);
  });
  it("pre_swap_token_check returns proceed=false on danger, true on caution", async () => {
    const s = fakeServer();
    const acts = devxTokenCheckActionProvider({ fetch: s.fetch }).getActions(wallet());
    expect(JSON.parse(await byName(acts, "pre_swap_token_check").invoke({ tokenAddress: RANDOM })).proceed).toBe(false);
    expect(JSON.parse(await byName(acts, "pre_swap_token_check").invoke({ tokenAddress: DEGEN })).proceed).toBe(true);
    const strict = devxTokenCheckActionProvider({ fetch: s.fetch, blockOn: ["danger", "caution"] }).getActions(wallet());
    expect(JSON.parse(await byName(strict, "pre_swap_token_check").invoke({ tokenAddress: DEGEN })).proceed).toBe(false);
  });
  it("supports EVM networks only", () => {
    const p = devxTokenCheckActionProvider();
    expect(p.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" } as any)).toBe(true);
    expect(p.supportsNetwork({ protocolFamily: "svm" } as any)).toBe(false);
  });
});

const SwapSchema = z.object({ fromToken: z.string(), toToken: z.string(), amount: z.string() });
class FakeSwapProvider extends ActionProvider<EvmWalletProvider> {
  calls = 0;
  constructor() { super("fake_swap", []); }
  // plain getActions (vitest's esbuild emits no decorator metadata for @CreateAction)
  getActions(_w: EvmWalletProvider): any[] {
    return [{ name: "FakeSwapProvider_swap", description: "swap tokens", schema: SwapSchema, invoke: async (_a: any) => { this.calls++; return "swapped"; } }];
  }
  supportsNetwork = () => true;
}

describe("withTokenCheckGuard", () => {
  it("blocks a swap into a danger token and passes a caution one", async () => {
    const s = fakeServer();
    const inner = new FakeSwapProvider();
    const guarded = withTokenCheckGuard(inner, { actions: ["swap"], checker: devxTokenCheckActionProvider({ fetch: s.fetch }) });
    const agentkit = await AgentKit.from({ walletProvider: wallet(), actionProviders: [guarded] });
    const swap = agentkit.getActions().find((a) => a.name.endsWith("swap"))!;
    expect(await swap.invoke({ fromToken: "eth", toToken: RANDOM, amount: "1" })).toMatch(/blocked by DevX Token Check/);
    expect(inner.calls).toBe(0);
    expect(await swap.invoke({ fromToken: "eth", toToken: DEGEN, amount: "1" })).toBe("swapped");
    expect(inner.calls).toBe(1);
  });
  it("fail-closed blocks when the token cannot be identified", async () => {
    const inner = new FakeSwapProvider();
    const guarded = withTokenCheckGuard(inner, { actions: ["swap"], failClosed: true, checker: devxTokenCheckActionProvider({ fetch: fakeServer().fetch }) });
    const swap = guarded.getActions(wallet()).find((a: any) => a.name.endsWith("swap"))!;
    expect(await swap.invoke({ fromToken: "eth", toToken: "usdc", amount: "1" })).toMatch(/could not identify/);
    expect(inner.calls).toBe(0);
  });
});

import { z } from "zod";
import { ActionProvider, CreateAction, EvmWalletProvider, type Action, type Network, type WalletProvider } from "@coinbase/agentkit";
import { CheckTokenRiskSchema, PreSwapCheckSchema } from "./schemas";
import {
  TokenCheckClient, guardDecision, summarize, normalizeChain, usdcToAtomic,
  type GuardPolicy, type TokenCheckResult, type TokenChain,
} from "./tokencheck";

export interface DevxTokenCheckConfig extends GuardPolicy {
  /** Max USDC per check the provider will sign for. Default "0.01". */
  maxPriceUsdc?: string;
  /** Never pay; only the free demo tokens. Default false. */
  demoOnly?: boolean;
  /** Override the API origin (testing). */
  baseUrl?: string;
  /** Inject fetch (testing). */
  fetch?: typeof globalThis.fetch;
}

const NETWORK_TO_CHAIN: Record<string, TokenChain> = {
  "base-mainnet": "base", "ethereum-mainnet": "ethereum", "arbitrum-mainnet": "arbitrum",
  "optimism-mainnet": "optimism", "polygon-mainnet": "polygon", "solana-mainnet": "solana",
};

export function chainForWallet(walletProvider: WalletProvider): TokenChain | undefined {
  try {
    return NETWORK_TO_CHAIN[walletProvider.getNetwork().networkId ?? ""];
  } catch {
    return undefined;
  }
}

function compact(r: TokenCheckResult) {
  return {
    ok: r.ok, source: r.source, chain: r.chain, tokenAddress: r.address, verdict: r.verdict, riskScore: r.riskScore,
    confidence: r.confidence, grade: r.grade, symbol: r.symbol, name: r.name, reasons: r.reasons, flags: r.flags,
    honeypot: r.honeypot, operationId: r.operationId, payment: r.payment, error: r.error, message: r.message,
    summary: summarize(r),
  };
}

/**
 * DevX Token Check action provider: token risk verdict (safe/caution/danger) before a swap.
 * Paid calls cost $0.01 USDC on Base via x402, signed by the agent's own EVM wallet.
 * Base USDC/WETH/DEGEN/AERO are free (demo).
 */
export class DevxTokenCheckActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly config: DevxTokenCheckConfig;
  private readonly clients = new WeakMap<object, TokenCheckClient>();

  constructor(config: DevxTokenCheckConfig = {}) {
    super("devx_tokencheck", []);
    this.config = config;
  }

  /** @internal */
  clientFor(walletProvider: EvmWalletProvider): TokenCheckClient {
    let c = this.clients.get(walletProvider);
    if (!c) {
      let signer: any;
      if (!this.config.demoOnly) {
        try {
          signer = (walletProvider as any).toSigner?.();
        } catch {
          signer = undefined;
        }
      }
      c = new TokenCheckClient({
        signer,
        demoOnly: this.config.demoOnly,
        baseUrl: this.config.baseUrl,
        fetch: this.config.fetch,
        maxPriceAtomic: this.config.maxPriceUsdc ? usdcToAtomic(this.config.maxPriceUsdc) : undefined,
      });
      this.clients.set(walletProvider, c);
    }
    return c;
  }

  /** Run a check (also used by the guard wrapper). */
  async check(walletProvider: EvmWalletProvider, tokenAddress: string, chain?: string): Promise<TokenCheckResult> {
    const ch = chain ?? chainForWallet(walletProvider) ?? "base";
    return this.clientFor(walletProvider).check(ch, tokenAddress);
  }

  @CreateAction({
    name: "check_token_risk",
    description: `Check a token for rug-pull / honeypot risk with DevX Token Check BEFORE buying or swapping into it.
Returns verdict safe | caution | danger with risk score, confidence and reasons: simulated buy/transfer/sell with measured taxes,
mint, blacklist/freeze, pause, fee setter, proxy/upgradeability, owner status, liquidity and contract age.
Chains: base, ethereum, arbitrum, optimism, polygon, robinhood, solana.
Cost: $0.01 USDC on Base per check, paid automatically via x402 from this wallet (needs Base USDC).
Base USDC, WETH, DEGEN and AERO are free (demo). Failed checks are not charged. Informational only, not financial advice.`,
    schema: CheckTokenRiskSchema,
  })
  async checkTokenRisk(walletProvider: EvmWalletProvider, args: z.infer<typeof CheckTokenRiskSchema>): Promise<string> {
    const r = await this.check(walletProvider, args.tokenAddress, args.chain);
    return JSON.stringify(compact(r));
  }

  @CreateAction({
    name: "pre_swap_token_check",
    description: `Call this right before any swap or buy. Runs DevX Token Check on the token being bought and returns
{"proceed": true|false, "reason": ...}. Do NOT execute the swap when proceed is false.
Blocks on verdict "danger" by default. Same pricing as check_token_risk ($0.01 USDC on Base via x402; demo tokens free).`,
    schema: PreSwapCheckSchema,
  })
  async preSwapTokenCheck(walletProvider: EvmWalletProvider, args: z.infer<typeof PreSwapCheckSchema>): Promise<string> {
    const r = await this.check(walletProvider, args.tokenAddress, args.chain);
    const d = guardDecision(r, this.config);
    return JSON.stringify({ proceed: d.allow, reason: d.reason, verdict: r.verdict ?? null, source: r.source, error: r.error ?? null });
  }

  supportsNetwork = (network: Network) => network.protocolFamily === "evm";
}

export const devxTokenCheckActionProvider = (config: DevxTokenCheckConfig = {}) => new DevxTokenCheckActionProvider(config);

const DEFAULT_TOKEN_KEYS = ["toToken", "buyToken", "toAssetId", "toAssetAddress", "toTokenAddress", "tokenOut", "outputToken", "toAddress"];

export interface GuardWrapOptions extends GuardPolicy {
  /** Action names to guard (as returned by getActions, e.g. "CdpEvmWalletActionProvider_swap"). Matched by suffix. */
  actions: string[];
  /** Read the bought token from the action args. Default: first of toToken/buyToken/toAssetId/... that looks like an address. */
  getToken?: (args: Record<string, unknown>) => { tokenAddress: string; chain?: string } | null;
  /** Provider used for the checks (default: a new DevxTokenCheckActionProvider). */
  checker?: DevxTokenCheckActionProvider;
}

/**
 * Wrap another action provider (e.g. a swap provider) so the named actions run DevX Token Check
 * on the bought token first and refuse to execute on a blocked verdict (default: danger).
 */
export class TokenCheckGuardActionProvider<W extends EvmWalletProvider = EvmWalletProvider> extends ActionProvider<W> {
  constructor(private readonly inner: ActionProvider<W>, private readonly opts: GuardWrapOptions) {
    super(`${inner.name}_devx_guarded`, []);
  }

  supportsNetwork = (network: Network) => this.inner.supportsNetwork(network);

  getActions(walletProvider: W): Action[] {
    const checker = this.opts.checker ?? new DevxTokenCheckActionProvider();
    const names = this.opts.actions.map((n) => n.toLowerCase());
    const getToken = this.opts.getToken ?? ((args: Record<string, unknown>): { tokenAddress: string; chain?: string } | null => {
      for (const k of DEFAULT_TOKEN_KEYS) {
        const v = args[k];
        if (typeof v === "string" && (/^0x[0-9a-fA-F]{40}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))) return { tokenAddress: v };
      }
      return null;
    });
    return this.inner.getActions(walletProvider).map((a) => {
      const n = a.name.toLowerCase();
      if (!names.some((x) => n === x || n.endsWith(`_${x}`))) return a;
      return {
        ...a,
        description: `${a.description}\n(Guarded: DevX Token Check runs on the bought token first; the action refuses tokens with a ${(this.opts.blockOn ?? ["danger"]).join("/")} verdict.)`,
        invoke: async (args: any) => {
          const t = getToken(args ?? {});
          if (t) {
            const chain = t.chain ? normalizeChain(t.chain) ?? undefined : undefined;
            const r = await checker.check(walletProvider, t.tokenAddress, chain);
            const d = guardDecision(r, this.opts);
            if (!d.allow) return `Swap blocked by DevX Token Check guard. ${d.reason}`;
          } else if (this.opts.failClosed) {
            return "Swap blocked by DevX Token Check guard: could not identify the bought token.";
          }
          return a.invoke(args);
        },
      };
    });
  }
}

export const withTokenCheckGuard = <W extends EvmWalletProvider>(inner: ActionProvider<W>, opts: GuardWrapOptions) =>
  new TokenCheckGuardActionProvider<W>(inner, opts);

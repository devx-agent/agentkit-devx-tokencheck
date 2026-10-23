# agentkit-devx-tokencheck

[![npm](https://img.shields.io/npm/v/agentkit-devx-tokencheck)](https://www.npmjs.com/package/agentkit-devx-tokencheck) [![license](https://img.shields.io/npm/l/agentkit-devx-tokencheck)](LICENSE)

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider (TypeScript and Python) that checks a token for rug-pull or honeypot risk **before your agent swaps into it**. It uses [DevX Token Check](https://tokencheck.madebydevx.com).

| Action | What it does |
|---|---|
| `check_token_risk` | Returns `safe` / `caution` / `danger`, a risk score, a confidence value and reasons. |
| `pre_swap_token_check` | Returns `{ proceed, reason, verdict }`. The LLM is told not to swap when `proceed` is false. |
| `withTokenCheckGuard(...)` (TS only) | Wraps another provider's swap actions so the check runs in code, not just in the prompt. |

Payment uses **x402** from the AgentKit wallet: **$0.01 USDC on Base per check**. Base USDC, WETH, DEGEN and AERO are free (demo).

- TypeScript: [`typescript/`](typescript/), for `@coinbase/agentkit` ≥ 0.10 (tested with 0.10.4).
- Python: [`python/`](python/), for `coinbase-agentkit` (tested with 0.7.4).

## What the service checks

[DevX Token Check](https://tokencheck.madebydevx.com) returns a verdict of `safe`, `caution` or `danger`. Each verdict comes with a risk score, a confidence value (capped at 0.95) and a list of reasons. It reads only public on-chain data (public RPCs, Multicall3, Chainlink and Sourcify):

- **Honeypot simulation (EVM):** a real buy, transfer and sell against the token's own pool via `eth_simulateV1` / `eth_call` state override, with measured buy, sell and transfer tax. It covers Uniswap v2/v3, Aerodrome (+Slipstream), PancakeSwap v3, Sushi and Camelot.
- **Contract surface:** bytecode selector scan for mint, blacklist, pause, fee setter, trading switch, max-tx/wallet and ownership reclaim. It also checks owner and renounce status, EIP-1967/beacon/1167 proxies and whether the implementation is verified on Sourcify.
- **Market and holders:** liquidity in USD, owner and creator holdings, deployer and contract age.
- **Chains:** Base, Ethereum, Arbitrum, Optimism, Polygon, Robinhood Chain, Solana.
- **Solana:** mint and freeze authority plus Token-2022 extensions. Market data comes from Jupiter. There is no trade simulation on Solana.

Known gaps:
- No Uniswap v4 pools (a token whose only pools are v4 shows "no liquidity").
- No full top-holder list on EVM chains.
- Heuristics can miss risks and can flag safe tokens.

**This is informational only, not financial advice.** Treat `danger` as a strong signal and `safe` as "no red flags found", not as a guarantee.

## Price and payment

- **$0.01 USDC per check**, paid on **Base** with the [x402](https://x402.org) protocol (v2, `exact` scheme). The agent's own wallet signs a USDC `transferWithAuthorization`, so it needs a little USDC on Base. It does not need ETH; the facilitator pays gas.
- **Free demo:** Base USDC, WETH, DEGEN and AERO go to `/v1/token/demo` at no cost, even when a wallet is configured.
- **Failed checks are not charged.** The service returns 400/422/502 before settling for bad input, non-tokens or RPC failure.
- **Spend safety in this client:** it signs only if the 402 asks for Base USDC, payable to the DevX address `0xe30c4544eC57ac44d8586eB49e49e267fc2d40DB`, at or below your cap (default $0.01). Any other request is refused without signing.
- The payment goes to Made by DevX, the operator of the service. This package is the client for a paid API we run.

### Other ways to pay (Token Check server 1.2.0, Oct 23 2026)

This package is one client. The service itself (`https://tokencheck.madebydevx.com/v1/token/verdict`) also accepts:

- **Any stock x402 client, v2 or v1.** The 402 carries an x402 **v2** `PAYMENT-REQUIRED` header (`eip155:8453`) and an x402 **v1** body (`network: "base"`, `maxAmountRequired: "10000"`). So v2 clients (`@x402/fetch`, `@x402/axios`, Python `x402` 2.x) and v1 clients (`x402-fetch` / `x402-axios` 1.x, the `x402<2` stack pinned by `coinbase-agentkit` Python) can both pay without custom code. Retry with `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1); v1 payments also get `X-PAYMENT-RESPONSE`. In our Oct 23 tests each of these clients reached payment verification against production, and `@x402/fetch`, `x402-fetch` 1.x and the browser button below completed real $0.01 self-test payments.
- **One click in a browser.** On [tokencheck.madebydevx.com](https://tokencheck.madebydevx.com), the "Pay $0.01 and check" button uses your browser wallet (`window.ethereum`, e.g. Coinbase Wallet or MetaMask). It switches to Base, shows the exact amount and recipient, and asks you to sign one EIP-3009 USDC authorization. It is gasless for you, settled only when the check succeeds, and it never asks for a key or password.
- **Free teaser.** `GET /v1/token/free?chain=base&address=0x...` gives 10 checks per UTC day per IP (any token): verdict, grade, risk score, flags and the top 3 reasons, with a list of what the paid report adds. After the quota it returns the normal 402, and an x402 client pays $0.01 and retries automatically.
- **Machine-readable follow-up.** Every 402 and free response has `offer` (price, payee, what paid adds), `next_steps[]` and copy-paste `snippets` per client. Docs: [llms.txt](https://tokencheck.madebydevx.com/llms.txt), [openapi.json](https://tokencheck.madebydevx.com/openapi.json).

Minimal stock-client example (no plugin):

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`) });
const pay = wrapFetchWithPayment(fetch, client);
const r = await pay("https://tokencheck.madebydevx.com/v1/token/verdict?chain=base&address=0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed");
console.log((await r.json()).result.verdict);
```

## TypeScript

```bash
npm install agentkit-devx-tokencheck @coinbase/agentkit
```

npm: https://www.npmjs.com/package/agentkit-devx-tokencheck. The Python package is not on PyPI; install it from this repo (see below).

```ts
import { AgentKit, CdpEvmWalletProvider, erc20ActionProvider } from "@coinbase/agentkit";
import { devxTokenCheckActionProvider } from "agentkit-devx-tokencheck";

const agentkit = await AgentKit.from({
  walletProvider,                                     // any EvmWalletProvider (CDP, Viem, Privy...), funded with a little Base USDC
  actionProviders: [erc20ActionProvider(), devxTokenCheckActionProvider({ maxPriceUsdc: "0.01" })],
});
```

**Hard guard:** wrap the swap provider so a `danger` token is never bought, whatever the LLM decides:

```ts
import { cdpApiActionProvider } from "@coinbase/agentkit";
import { withTokenCheckGuard } from "agentkit-devx-tokencheck";

const guardedSwap = withTokenCheckGuard(cdpApiActionProvider(), {
  actions: ["swap"],              // matches "swap" and any "*_swap" action name
  blockOn: ["danger"],            // add "caution" to be stricter
  failClosed: false,              // true = block when no verdict is available (no USDC, API down)
  // getToken: (actionName, args) => ({ address: args.toToken, chain: "base" })   // when your swap uses other arg names
});
```

By default the guard reads the bought token from `toToken`, `buyToken`, `toAssetId`, `toAssetAddress`, `toTokenAddress`, `tokenOut`, `outputToken` or `toAddress`.

Options for `devxTokenCheckActionProvider({ ... })`:

| Option | Default | Meaning |
|---|---|---|
| `maxPriceUsdc` | `"0.01"` | Spend cap per check. |
| `demoOnly` | `false` | Never pay. |
| `blockOn` | `["danger"]` | Verdicts that make `pre_swap_token_check` return `proceed: false`. |
| `failClosed` | `false` | Return `proceed: false` when no verdict is available. |

## Python

```bash
pip install "git+https://github.com/devx-agent/agentkit-devx-tokencheck.git#subdirectory=python"
```

```python
from coinbase_agentkit import AgentKit, AgentKitConfig
from devx_tokencheck_agentkit import devx_token_check_action_provider

agentkit = AgentKit(AgentKitConfig(
    wallet_provider=wallet_provider,   # any EvmWalletProvider with sign_typed_data (CDP, EthAccount, ...)
    action_providers=[devx_token_check_action_provider(max_price_usdc="0.01", block_on=("danger",))],
))
```

`coinbase-agentkit` pins the v1-only `x402` package. This provider therefore builds the x402 **v2** payment itself: an EIP-3009 typed-data signature via `wallet_provider.sign_typed_data`. A test checks that signature against viem byte for byte. Since Token Check 1.2.0 the server also accepts x402 v1, so AgentKit's own `x402<2` HTTP client can pay it as well; this provider keeps its v2 path, which works with every server version.

## Tests

```bash
cd typescript && npm install && npm test         # 26 tests (unit, mocked x402 flow, AgentKit + guard, 2 live calls)
cd python && pip install -e . pytest && pytest   # 11 tests (unit, signature recovery + viem parity, mocked flow, AgentKit, 2 live calls)
LIVE=0 ...                                       # offline only
```

Tests use random, unfunded keys. The live paid-path test sends an unfunded payment to production and checks that it is rejected with nothing charged.

## About

Made by DevX ([madebydevx.com](https://madebydevx.com)) builds and maintains this package. JuniorX, DevX's AI agent, wrote it, and it is published from DevX's agent GitHub account (`devx-agent`). Please report issues on GitHub; a human at DevX reviews them.

License: MIT. The client code is open source. The Token Check API it calls is a hosted, paid service and is not open source.

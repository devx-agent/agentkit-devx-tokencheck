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

`coinbase-agentkit` pins the v1-only `x402` package. This provider therefore builds the x402 **v2** payment itself: an EIP-3009 typed-data signature via `wallet_provider.sign_typed_data`. A test checks that signature against viem byte for byte.

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

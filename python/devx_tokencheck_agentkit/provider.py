"""Coinbase AgentKit (Python) action provider for DevX Token Check."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field

from coinbase_agentkit.action_providers.action_decorator import create_action
from coinbase_agentkit.action_providers.action_provider import ActionProvider
from coinbase_agentkit.network import Network
from coinbase_agentkit.wallet_providers import EvmWalletProvider

from .client import NETWORK_TO_CHAIN, TokenCheckClient, guard_decision, usdc_to_atomic


class CheckTokenRiskSchema(BaseModel):
    token_address: str = Field(..., description="Token contract address (0x... for EVM chains, base58 mint for Solana)")
    chain: str | None = Field(None, description="base | ethereum | arbitrum | optimism | polygon | robinhood | solana. Defaults to the wallet's network, else base.")


class PreSwapCheckSchema(BaseModel):
    token_address: str = Field(..., description="Address of the token you are about to buy / receive in a swap")
    chain: str | None = Field(None, description="Chain of the token. Defaults to the wallet's network, else base.")


def _chain_for(wallet_provider: EvmWalletProvider) -> str | None:
    try:
        return NETWORK_TO_CHAIN.get(wallet_provider.get_network().network_id or "")
    except Exception:  # noqa: BLE001
        return None


class DevxTokenCheckActionProvider(ActionProvider[EvmWalletProvider]):
    """Token risk verdict (safe/caution/danger) before swaps. $0.01 USDC on Base via x402 from the agent wallet."""

    def __init__(self, max_price_usdc: str = "0.01", demo_only: bool = False, block_on: tuple[str, ...] = ("danger",),
                 fail_closed: bool = False, base_url: str | None = None, session: Any = None):
        super().__init__("devx_tokencheck", [])
        self.max_price_atomic = usdc_to_atomic(max_price_usdc)
        self.demo_only = demo_only
        self.block_on = tuple(block_on)
        self.fail_closed = fail_closed
        self.base_url = base_url
        self.session = session

    def client_for(self, wallet_provider: EvmWalletProvider) -> TokenCheckClient:
        address = None if self.demo_only else wallet_provider.get_address()
        return TokenCheckClient(
            address, None if self.demo_only else wallet_provider.sign_typed_data, base_url=self.base_url,
            max_price_atomic=self.max_price_atomic, demo_only=self.demo_only, session=self.session,
        )

    def check(self, wallet_provider: EvmWalletProvider, token_address: str, chain: str | None = None):
        return self.client_for(wallet_provider).check(chain or _chain_for(wallet_provider) or "base", token_address)

    @create_action(
        name="check_token_risk",
        description="""Check a token for rug-pull / honeypot risk with DevX Token Check BEFORE buying or swapping into it.
Returns verdict safe | caution | danger with risk score, confidence and reasons: simulated buy/transfer/sell with measured taxes,
mint, blacklist/freeze, pause, fee setter, proxy/upgradeability, owner status, liquidity and contract age.
Chains: base, ethereum, arbitrum, optimism, polygon, robinhood, solana.
Cost: $0.01 USDC on Base per check, paid automatically via x402 from this wallet (needs Base USDC).
Base USDC, WETH, DEGEN and AERO are free (demo). Failed checks are not charged. Informational only, not financial advice.""",
        schema=CheckTokenRiskSchema,
    )
    def check_token_risk(self, wallet_provider: EvmWalletProvider, args: dict[str, Any]) -> str:
        a = CheckTokenRiskSchema(**args)
        return json.dumps(self.check(wallet_provider, a.token_address, a.chain).to_dict())

    @create_action(
        name="pre_swap_token_check",
        description="""Call this right before any swap or buy. Runs DevX Token Check on the token being bought and returns
{"proceed": true|false, "reason": ...}. Do NOT execute the swap when proceed is false. Blocks on verdict "danger" by default.
Same pricing as check_token_risk ($0.01 USDC on Base via x402; demo tokens free).""",
        schema=PreSwapCheckSchema,
    )
    def pre_swap_token_check(self, wallet_provider: EvmWalletProvider, args: dict[str, Any]) -> str:
        a = PreSwapCheckSchema(**args)
        r = self.check(wallet_provider, a.token_address, a.chain)
        allow, reason = guard_decision(r, self.block_on, self.fail_closed)
        return json.dumps({"proceed": allow, "reason": reason, "verdict": r.verdict, "source": r.source, "error": r.error})

    def supports_network(self, network: Network) -> bool:
        return network.protocol_family == "evm"


def devx_token_check_action_provider(**kwargs: Any) -> DevxTokenCheckActionProvider:
    return DevxTokenCheckActionProvider(**kwargs)

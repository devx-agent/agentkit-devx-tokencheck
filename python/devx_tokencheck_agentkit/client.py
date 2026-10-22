"""DevX Token Check client: x402 v2 'exact' payment on Base USDC, signed by the caller's own wallet.

Free demo tokens (Base USDC/WETH/DEGEN/AERO) use /v1/token/demo. The client refuses to sign unless the
402 asks for Base USDC, to the pinned DevX payee, at or below max_price_atomic (default 10000 = $0.01).
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import requests

DEFAULT_BASE_URL = "https://tokencheck.madebydevx.com"
DEVX_PAY_TO = "0xe30c4544eC57ac44d8586eB49e49e267fc2d40DB"
BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
BASE_NETWORK = "eip155:8453"
DEFAULT_MAX_PRICE_ATOMIC = 10_000
SUPPORTED_CHAINS = ("base", "ethereum", "arbitrum", "optimism", "polygon", "robinhood", "solana")
CHAIN_ALIASES = {
    "base": "base", "8453": "base", "ethereum": "ethereum", "eth": "ethereum", "mainnet": "ethereum", "1": "ethereum",
    "arbitrum": "arbitrum", "arb": "arbitrum", "42161": "arbitrum", "optimism": "optimism", "op": "optimism", "10": "optimism",
    "polygon": "polygon", "matic": "polygon", "pol": "polygon", "137": "polygon",
    "robinhood": "robinhood", "rh": "robinhood", "4663": "robinhood", "solana": "solana", "sol": "solana",
}
NETWORK_TO_CHAIN = {
    "base-mainnet": "base", "ethereum-mainnet": "ethereum", "arbitrum-mainnet": "arbitrum",
    "optimism-mainnet": "optimism", "polygon-mainnet": "polygon", "solana-mainnet": "solana",
}
DEMO_TOKENS = {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
    "0x4200000000000000000000000000000000000006": "WETH",
    "0x4ed4e862860bed51a9570b96d89af5e1b0efefed": "DEGEN",
    "0x940181a94a35a4569e4529a3cdfb74e38fd98631": "AERO",
}
EVM_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SOL_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")

# signer(typed_data_dict) -> 0x-hex signature ; address of the signer
TypedDataSigner = Callable[[dict[str, Any]], str]


def normalize_chain(chain: str | None) -> str | None:
    if not chain:
        return "base"
    return CHAIN_ALIASES.get(str(chain).strip().lower().removeprefix("eip155:"))


def is_valid_address(chain: str, address: str) -> bool:
    if chain == "solana":
        return bool(SOL_RE.match(address)) and not address.startswith("0x")
    return bool(EVM_RE.match(address))


def is_demo_token(chain: str, address: str) -> bool:
    return chain == "base" and address.lower() in DEMO_TOKENS


def usdc_to_atomic(v: str | float | int) -> int:
    s = str(v).strip()
    if not re.match(r"^\d+(\.\d{1,6})?$", s):
        raise ValueError(f"invalid USDC amount: {s}")
    i, _, f = s.partition(".")
    return int(i) * 1_000_000 + int((f + "000000")[:6])


def b64json(o: Any) -> str:
    return base64.b64encode(json.dumps(o, separators=(",", ":")).encode()).decode()


def unb64json(s: str) -> Any:
    return json.loads(base64.b64decode(s))


def accept_requirement(req: dict[str, Any], pay_to: str, max_atomic: int) -> bool:
    try:
        amount = int(req.get("amount", req.get("maxAmountRequired")))
    except (TypeError, ValueError):
        return False
    return (
        req.get("scheme") == "exact"
        and req.get("network") in (BASE_NETWORK, "base")
        and str(req.get("asset", "")).lower() == BASE_USDC.lower()
        and str(req.get("payTo", "")).lower() == pay_to.lower()
        and amount <= max_atomic
    )


def transfer_with_authorization_typed_data(req: dict[str, Any], from_addr: str, now: int | None = None, nonce: str | None = None) -> dict[str, Any]:
    """EIP-712 typed data for USDC (EIP-3009) TransferWithAuthorization, as used by x402 'exact' on EVM."""
    now = int(time.time()) if now is None else now
    extra = req.get("extra") or {}
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": extra.get("name", "USD Coin"), "version": extra.get("version", "2"),
            "chainId": 8453, "verifyingContract": req["asset"],
        },
        "message": {
            "from": from_addr, "to": req["payTo"], "value": int(req.get("amount", req.get("maxAmountRequired"))),
            "validAfter": now - 600, "validBefore": now + int(req.get("maxTimeoutSeconds", 120)),
            "nonce": nonce or "0x" + secrets.token_hex(32),
        },
    }


def build_payment_signature(payment_required: dict[str, Any], req: dict[str, Any], from_addr: str, sign: TypedDataSigner, now: int | None = None, nonce: str | None = None) -> str:
    td = transfer_with_authorization_typed_data(req, from_addr, now, nonce)
    sig = sign(td)
    if not sig.startswith("0x"):
        sig = "0x" + sig
    m = td["message"]
    payload: dict[str, Any] = {
        "x402Version": 2,
        "payload": {
            "authorization": {
                "from": m["from"], "to": m["to"], "value": str(m["value"]), "validAfter": str(m["validAfter"]),
                "validBefore": str(m["validBefore"]), "nonce": m["nonce"],
            },
            "signature": sig,
        },
        "resource": payment_required.get("resource"),
        "accepted": req,
    }
    if payment_required.get("extensions"):
        payload["extensions"] = payment_required["extensions"]
    return b64json(payload)


@dataclass
class TokenCheckResult:
    ok: bool
    source: str  # paid | demo | none
    chain: str | None
    address: str
    verdict: str | None = None
    risk_score: float | None = None
    confidence: float | None = None
    grade: str | None = None
    symbol: str | None = None
    name: str | None = None
    reasons: list[dict[str, Any]] = field(default_factory=list)
    flags: dict[str, Any] | None = None
    honeypot: dict[str, Any] | None = None
    operation_id: str | None = None
    payment: dict[str, Any] | None = None
    error: str | None = None
    message: str | None = None
    raw: Any = None

    def summary(self) -> str:
        if not self.ok:
            return f"Token Check unavailable for {self.address or 'token'}: {self.message or self.error}"
        top = [r.get("message") for r in self.reasons if r.get("severity") != "info"][:3]
        sym = f"${self.symbol}" if self.symbol else self.address
        hp = self.honeypot or {}
        tax = ""
        if hp.get("buy_tax_pct") is not None or hp.get("sell_tax_pct") is not None:
            tax = f" Tax buy {hp.get('buy_tax_pct', '?')}% / sell {hp.get('sell_tax_pct', '?')}%."
        src = " (free demo)" if self.source == "demo" else (f" (paid $0.01, tx {self.payment['transaction']})" if self.payment and self.payment.get("transaction") else " (paid)")
        reasons = (" " + "; ".join(top) + ".") if top else ""
        return f"DevX Token Check {sym} on {self.chain}: {str(self.verdict).upper()} (risk {self.risk_score}, confidence {self.confidence}).{reasons}{tax}{src} Informational only, not financial advice."

    def to_dict(self, include_raw: bool = False) -> dict[str, Any]:
        d = {k: v for k, v in self.__dict__.items() if k != "raw"}
        if include_raw:
            d["raw"] = self.raw
        d["summary"] = self.summary()
        return d


def _result(chain: str, address: str, source: str, body: Any, payment: dict[str, Any] | None) -> TokenCheckResult:
    r = (body or {}).get("result") or {}
    tok = r.get("token") or {}
    met = r.get("metrics") or {}
    hp = r.get("honeypot") or {}
    return TokenCheckResult(
        ok=True, source=source, chain=chain, address=address, verdict=r.get("verdict"), risk_score=r.get("risk_score"),
        confidence=r.get("confidence"), grade=r.get("grade"), symbol=tok.get("symbol") or met.get("ticker"),
        name=tok.get("name") or met.get("tokenName"), reasons=r.get("reasons") or [], flags=r.get("flags"),
        honeypot={"buy_tax_pct": hp.get("buy_tax_pct"), "sell_tax_pct": hp.get("sell_tax_pct"), "sell_ok": hp.get("sell_ok")},
        operation_id=(body or {}).get("operation_id"), payment=payment, raw=body,
    )


class TokenCheckClient:
    def __init__(
        self, address: str | None = None, sign_typed_data: TypedDataSigner | None = None, *, base_url: str | None = None,
        max_price_atomic: int = DEFAULT_MAX_PRICE_ATOMIC, pay_to: str = DEVX_PAY_TO, prefer_demo: bool = True,
        demo_only: bool = False, timeout: float = 30.0, session: requests.Session | None = None,
    ):
        self.address = address
        self.sign = sign_typed_data
        self.base_url = (base_url or os.getenv("DEVX_TOKENCHECK_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.max_price_atomic = max_price_atomic
        self.pay_to = pay_to
        self.prefer_demo = prefer_demo
        self.demo_only = demo_only
        self.timeout = timeout
        self.http = session or requests.Session()

    @property
    def can_pay(self) -> bool:
        return bool(self.address and self.sign and not self.demo_only)

    def demo(self, address: str) -> TokenCheckResult:
        try:
            res = self.http.get(f"{self.base_url}/v1/token/demo", params={"chain": "base", "address": address}, timeout=self.timeout)
            body = res.json() if res.content else None
        except Exception as e:  # noqa: BLE001
            return TokenCheckResult(False, "none", "base", address, error="network_error", message=str(e))
        if res.status_code != 200:
            return TokenCheckResult(False, "none", "base", address, error="http_error", message=(body or {}).get("error", f"HTTP {res.status_code}"), raw=body)
        return _result("base", address, "demo", body, None)

    def check(self, chain: str | None, address: str) -> TokenCheckResult:
        address = (address or "").strip()
        ch = normalize_chain(chain)
        if not ch:
            return TokenCheckResult(False, "none", None, address, error="invalid_input", message=f'unsupported chain "{chain}"; use one of {", ".join(SUPPORTED_CHAINS)}')
        if not is_valid_address(ch, address):
            return TokenCheckResult(False, "none", ch, address, error="invalid_input", message=f"invalid {ch} token address")
        demo = is_demo_token(ch, address)
        if demo and (self.prefer_demo or not self.can_pay):
            return self.demo(address)
        if not self.can_pay:
            return TokenCheckResult(False, "none", ch, address, error="payment_not_configured",
                                    message="No wallet configured for x402 payment. Paid checks cost $0.01 USDC on Base; the free demo covers only Base USDC/WETH/DEGEN/AERO.")
        url = f"{self.base_url}/v1/token/verdict"
        params = {"chain": ch, "address": address}
        try:
            res = self.http.get(url, params=params, headers={"accept": "application/json"}, timeout=self.timeout)
            if res.status_code == 402:
                hdr = res.headers.get("PAYMENT-REQUIRED")
                if not hdr:
                    return TokenCheckResult(False, "none", ch, address, error="payment_failed", message="402 without PAYMENT-REQUIRED header (x402 v2 expected)")
                pr = unb64json(hdr)
                reqs = [r for r in pr.get("accepts", []) if accept_requirement(r, self.pay_to, self.max_price_atomic)]
                if not reqs:
                    return TokenCheckResult(False, "none", ch, address, error="payment_refused",
                                            message="402 payment requirements do not match the pinned DevX payee / Base USDC / price cap; not signing")
                header = build_payment_signature(pr, reqs[0], self.address, self.sign)  # type: ignore[arg-type]
                res = self.http.get(url, params=params, headers={"accept": "application/json", "PAYMENT-SIGNATURE": header}, timeout=self.timeout)
            body = res.json() if res.content else None
        except Exception as e:  # noqa: BLE001
            if demo:
                return self.demo(address)
            return TokenCheckResult(False, "none", ch, address, error="network_error", message=str(e))
        if res.status_code != 200:
            if demo:
                return self.demo(address)
            msg = (body or {}).get("message") or (body or {}).get("error") or f"HTTP {res.status_code}"
            return TokenCheckResult(False, "none", ch, address, error="payment_failed" if res.status_code == 402 else "http_error", message=msg, raw=body)
        payment = None
        pr_hdr = res.headers.get("PAYMENT-RESPONSE")
        if pr_hdr:
            try:
                d = unb64json(pr_hdr)
                payment = {"transaction": d.get("transaction"), "payer": d.get("payer"), "network": d.get("network")}
            except Exception:  # noqa: BLE001
                payment = None
        return _result(ch, address, "paid", body, payment)


def guard_decision(r: TokenCheckResult, block_on: tuple[str, ...] = ("danger",), fail_closed: bool = False) -> tuple[bool, str]:
    if not r.ok:
        return (not fail_closed, f"no verdict ({r.error}): {r.message}")
    if r.verdict in block_on:
        return (False, r.summary())
    return (True, r.summary())

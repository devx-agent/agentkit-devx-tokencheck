import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from coinbase_agentkit import AgentKit, AgentKitConfig, EthAccountWalletProvider, EthAccountWalletProviderConfig
from devx_tokencheck_agentkit import DevxTokenCheckActionProvider, TokenCheckClient, guard_decision
from devx_tokencheck_agentkit.client import (
    DEVX_PAY_TO, accept_requirement, b64json, build_payment_signature, normalize_chain,
    is_valid_address, transfer_with_authorization_typed_data, unb64json, usdc_to_atomic,
)

FX = Path(__file__).parent / "fixtures"
PR_B64 = (FX / "payment_required.b64").read_text().strip()
DEGEN_DEMO = json.loads((FX / "degen_demo.json").read_text())
DANGER = json.loads((FX / "danger_paid.json").read_text())
DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"
RANDOM = "0x1111111111111111111111111111111111111111"
LIVE = os.getenv("LIVE", "1") != "0"


class Resp:
    def __init__(self, status, body, headers=None):
        self.status_code, self._b, self.headers = status, body, headers or {}
        self.content = json.dumps(body).encode()

    def json(self):
        return self._b


class FakeSession:
    def __init__(self, pr=PR_B64, paid=DANGER):
        self.calls, self.pr, self.paid = [], pr, paid

    def get(self, url, params=None, headers=None, timeout=None):
        headers = headers or {}
        self.calls.append({"url": url, "params": params, "headers": headers})
        if url.endswith("/v1/token/demo"):
            return Resp(200, DEGEN_DEMO)
        if "PAYMENT-SIGNATURE" in headers:
            return Resp(200, self.paid, {"PAYMENT-RESPONSE": b64json({"success": True, "transaction": "0xabc123", "network": "eip155:8453"})})
        return Resp(402, {"error": "payment required"}, {"PAYMENT-REQUIRED": self.pr})


def pr_with(**patch):
    d = unb64json(PR_B64)
    d["accepts"] = [{**d["accepts"][0], **patch}]
    return b64json(d)


def wallet(chain_id="8453"):
    return EthAccountWalletProvider(EthAccountWalletProviderConfig(account=Account.create(), chain_id=chain_id, rpc_url="http://127.0.0.1:1"))


def test_helpers():
    assert normalize_chain(None) == "base" and normalize_chain("ETH") == "ethereum" and normalize_chain("bsc") is None
    assert is_valid_address("base", DEGEN) and not is_valid_address("base", "0x12")
    assert is_valid_address("solana", "So11111111111111111111111111111111111111112")
    assert usdc_to_atomic("0.01") == 10000
    req = unb64json(PR_B64)["accepts"][0]
    assert accept_requirement(req, DEVX_PAY_TO, 10000)
    assert not accept_requirement({**req, "amount": "10001"}, DEVX_PAY_TO, 10000)
    assert not accept_requirement({**req, "payTo": RANDOM}, DEVX_PAY_TO, 10000)
    assert not accept_requirement({**req, "network": "eip155:1"}, DEVX_PAY_TO, 10000)


def test_signature_recovers_to_wallet():
    acct = Account.create()
    pr = unb64json(PR_B64)
    req = pr["accepts"][0]
    hdr = build_payment_signature(pr, req, acct.address, lambda td: acct.sign_typed_data(full_message=td).signature.hex())
    p = unb64json(hdr)
    assert p["x402Version"] == 2 and p["accepted"]["payTo"] == DEVX_PAY_TO and p["payload"]["authorization"]["value"] == "10000"
    a = p["payload"]["authorization"]
    td = transfer_with_authorization_typed_data(req, acct.address, nonce=a["nonce"])
    td["message"].update(validAfter=int(a["validAfter"]), validBefore=int(a["validBefore"]))
    assert Account.recover_message(encode_typed_data(full_message=td), signature=p["payload"]["signature"]) == acct.address


TS_DIR = Path(__file__).resolve().parents[2] / "typescript"


@pytest.mark.skipif(not shutil.which("node") or not (TS_DIR / "node_modules" / "viem").exists(), reason="needs node + viem from ../typescript")
def test_signature_matches_viem():
    acct = Account.create()
    req = unb64json(PR_B64)["accepts"][0]
    td = transfer_with_authorization_typed_data(req, acct.address, now=1_800_000_000, nonce="0x" + "ab" * 32)
    py_sig = acct.sign_typed_data(full_message=td).signature.hex()
    py_sig = py_sig if py_sig.startswith("0x") else "0x" + py_sig
    js = """
const {privateKeyToAccount}=require('viem/accounts');
const [pk,tdj]=process.argv.slice(1); const td=JSON.parse(tdj); delete td.types.EIP712Domain;
td.message.value=BigInt(td.message.value); td.message.validAfter=BigInt(td.message.validAfter); td.message.validBefore=BigInt(td.message.validBefore);
privateKeyToAccount(pk).signTypedData(td).then(s=>console.log(s));"""
    out = subprocess.run(["node", "-e", js, "0x" + acct.key.hex().removeprefix("0x"), json.dumps(td)], cwd=TS_DIR, capture_output=True, text=True, timeout=60)
    assert out.stdout.strip() == py_sig, out.stderr


def test_paid_flow_mocked():
    s = FakeSession()
    w = wallet()
    p = DevxTokenCheckActionProvider(session=s)
    out = json.loads(next(a for a in p.get_actions(w) if a.name.endswith("check_token_risk")).invoke({"token_address": RANDOM}))
    assert out["ok"] and out["source"] == "paid" and out["verdict"] == "danger" and out["payment"]["transaction"] == "0xabc123"
    sig = unb64json(s.calls[1]["headers"]["PAYMENT-SIGNATURE"])
    assert sig["payload"]["authorization"]["from"].lower() == w.get_address().lower()
    assert sig["payload"]["authorization"]["to"].lower() == DEVX_PAY_TO.lower()


def test_refuses_wrong_payee_and_price():
    for pr in (pr_with(payTo=RANDOM), pr_with(amount="20000")):
        s = FakeSession(pr=pr)
        r = DevxTokenCheckActionProvider(session=s).check(wallet(), RANDOM)
        assert r.error == "payment_refused"
        assert not any("PAYMENT-SIGNATURE" in c["headers"] for c in s.calls)


def test_demo_tokens_free_and_demo_only():
    s = FakeSession()
    r = DevxTokenCheckActionProvider(session=s).check(wallet(), DEGEN)
    assert r.source == "demo" and r.verdict == "caution"
    assert all(c["url"].endswith("/v1/token/demo") for c in s.calls)
    s2 = FakeSession()
    r2 = DevxTokenCheckActionProvider(session=s2, demo_only=True).check(wallet(), RANDOM)
    assert r2.error == "payment_not_configured" and s2.calls == []


def test_wallet_chain_default():
    s = FakeSession()
    DevxTokenCheckActionProvider(session=s).check(wallet("42161"), RANDOM)
    assert s.calls[0]["params"]["chain"] == "arbitrum"


def test_pre_swap_and_guard():
    s = FakeSession()
    acts = {a.name.split("_", 1)[1]: a for a in DevxTokenCheckActionProvider(session=s).get_actions(wallet())}
    assert json.loads(acts["pre_swap_token_check"].invoke({"token_address": RANDOM}))["proceed"] is False
    assert json.loads(acts["pre_swap_token_check"].invoke({"token_address": DEGEN}))["proceed"] is True
    strict = {a.name.split("_", 1)[1]: a for a in DevxTokenCheckActionProvider(session=s, block_on=("danger", "caution")).get_actions(wallet())}
    assert json.loads(strict["pre_swap_token_check"].invoke({"token_address": DEGEN}))["proceed"] is False
    none = TokenCheckClient().check("base", RANDOM)
    assert guard_decision(none)[0] is True and guard_decision(none, fail_closed=True)[0] is False


def test_registers_in_agentkit():
    ak = AgentKit(AgentKitConfig(wallet_provider=wallet(), action_providers=[DevxTokenCheckActionProvider()]))
    names = [a.name for a in ak.get_actions()]
    assert any(n.endswith("check_token_risk") for n in names) and any(n.endswith("pre_swap_token_check") for n in names)


@pytest.mark.skipif(not LIVE, reason="LIVE=0")
def test_live_demo():
    r = TokenCheckClient().check("base", DEGEN)
    assert r.ok and r.source == "demo" and r.verdict in ("safe", "caution", "danger")


@pytest.mark.skipif(not LIVE, reason="LIVE=0")
def test_live_unfunded_wallet_not_charged():
    w = wallet()
    r = DevxTokenCheckActionProvider().check(w, "0x532f27101965dd16442E59d40670FaF5eBB142E4")
    assert not r.ok and r.error == "payment_failed"
    # the facilitator got past signature checks and failed on the (empty) balance
    assert "signature" not in (r.message or "").lower(), r.message

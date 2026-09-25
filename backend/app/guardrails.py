"""Input / output guardrails for a regulated (financial services) chatbot.

- PII detection & redaction: SSNs, card numbers (Luhn-validated), long account
  numbers, passwords/PINs typed into chat. Redacted text is what gets logged,
  retrieved against, and sent to any LLM.
- Prompt-injection detection: attempts to override instructions or exfiltrate
  the system prompt.
- Advice detection: personalised investment/tax/legal advice requests are
  answered with general education plus a disclaimer, never a recommendation.
- Domain check: politely declines questions unrelated to banking & finance.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

SSN_RE = re.compile(r"\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b")
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
ACCOUNT_RE = re.compile(r"\b\d{8,17}\b")
SECRET_RE = re.compile(
    r"\b(password|passcode|pin|otp|one[- ]time code|cvv|security code)\b\s*(is|=|:)\s*\S+",
    re.IGNORECASE,
)

INJECTION_PATTERNS = [
    r"ignore (all |any )?(the |your )?(previous|prior|above) (instructions|prompts?|rules)",
    r"disregard (all |your )?(previous |prior )?(instructions|rules|guidelines)",
    r"(reveal|show|print|repeat|leak) (me )?(your|the) (system )?(prompt|instructions)",
    r"you are now (dan|in developer mode|jailbroken)",
    r"\bjailbreak\b",
    r"pretend (you are|to be) (not )?(an? )?(ai|assistant|bank)",
    r"act as (an? )?(unfiltered|uncensored)",
]
INJECTION_RE = re.compile("|".join(INJECTION_PATTERNS), re.IGNORECASE)

ADVICE_RE = re.compile(
    r"\b(should i (buy|sell|invest|short)|which (stock|crypto|coin|fund|etf)s? (should|to)|"
    r"best (stock|crypto|coin)s? to (buy|invest)|is .{1,30} a good investment|"
    r"will .{1,30} (stock|price) (go up|rise|crash)|tax advice|legal advice|"
    r"guaranteed returns?)\b",
    re.IGNORECASE,
)

FINANCE_TERMS = {
    "account", "bank", "banking", "balance", "card", "credit", "debit", "loan", "mortgage",
    "interest", "rate", "apr", "apy", "fee", "fees", "payment", "pay", "deposit", "withdraw",
    "withdrawal", "transfer", "wire", "ach", "check", "cheque", "savings", "checking", "cd",
    "overdraft", "fraud", "scam", "dispute", "charge", "statement", "atm", "branch", "invest",
    "investment", "ira", "retirement", "stock", "fund", "money", "cash", "budget", "debt",
    "refinance", "score", "fico", "limit", "routing", "pin", "password", "login", "tax",
    "emi", "principal", "borrow", "lend", "finance", "financial", "dollar", "$", "salary",
    "paycheck", "save", "saving", "fdic", "crypto", "payoff", "auto", "car", "home",
    "business", "ein", "beneficiary", "joint", "support", "help", "agent", "human",
}


@dataclass
class GuardResult:
    text: str
    flags: list[str] = field(default_factory=list)
    blocked: bool = False


def _luhn_ok(digits: str) -> bool:
    total, parity = 0, len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _trailing(match: str) -> str:
    """Keep the separator the card regex swallowed after the last digit."""
    return match[len(match.rstrip(" -")):]


def redact_pii(text: str) -> tuple[str, list[str]]:
    flags: list[str] = []

    def card_sub(m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            flags.append("pii:card_number")
            return f"[CARD •••• {digits[-4:]}]" + _trailing(m.group())
        return m.group()

    text = CARD_RE.sub(card_sub, text)
    if SSN_RE.search(text):
        flags.append("pii:ssn")
        text = SSN_RE.sub("[SSN REDACTED]", text)
    if SECRET_RE.search(text):
        flags.append("pii:secret")
        text = SECRET_RE.sub(lambda m: f"{m.group(1)} [REDACTED]", text)
    if ACCOUNT_RE.search(text):
        flags.append("pii:account_number")
        text = ACCOUNT_RE.sub(lambda m: f"[ACCT •••• {m.group()[-4:]}]", text)
    return text, sorted(set(flags))


def check_input(message: str) -> GuardResult:
    text = message.strip()[:2000]
    redacted, flags = redact_pii(text)
    result = GuardResult(text=redacted, flags=flags)
    if INJECTION_RE.search(text):
        result.flags.append("prompt_injection")
        result.blocked = True
    if ADVICE_RE.search(text):
        result.flags.append("personal_advice")
    return result


def is_finance_related(text: str) -> bool:
    words = set(re.findall(r"[a-z$]+", text.lower()))
    return bool(words & FINANCE_TERMS)


PII_WARNING = (
    "For your security I've removed sensitive details from your message. "
    "Please never share full card numbers, SSNs, passwords, PINs or one-time codes in chat — "
    "FinPilot will never ask for them."
)

ADVICE_DISCLAIMER = (
    "I can share general information, but I can't give personalised investment, tax or legal "
    "advice. For recommendations tailored to you, please speak with a licensed financial advisor."
)


def check_output(text: str) -> str:
    """Last line of defence: never echo sensitive numbers back to the user."""
    def card_sub(m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group())
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            return f"[CARD •••• {digits[-4:]}]" + _trailing(m.group())
        return m.group()

    text = CARD_RE.sub(card_sub, text)
    return SSN_RE.sub("[SSN REDACTED]", text)

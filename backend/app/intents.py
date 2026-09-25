"""Lightweight, explainable intent router.

Rules are fast, free and auditable - important in banking. Anything that is
not an explicit action or calculation falls through to RAG.
"""
from __future__ import annotations

import re

R = lambda p: re.compile(p, re.I)  # noqa: E731

GREETING = R(r"^\s*(hi|hello|hey|hiya|howdy|good (morning|afternoon|evening)|yo)\b[\s!.,]*(there|team|finpilot)?[\s!.]*$")
THANKS = R(r"\b(thanks|thank you|thx|ty|appreciate it)\b")
BYE = R(r"^\s*(bye|goodbye|see you|that'?s all|no,? that'?s it)\b")
WHO = R(r"\b(who are you|what can you do|what do you do|help me|how can you help)\b")
HUMAN = R(r"\b(human|real person|live agent|an agent|representative|speak (to|with) (someone|a person)|talk (to|with) (someone|a person)|escalate|file a complaint|make a complaint|create (a )?(support )?ticket|open (a )?ticket)\b")
LOCK = R(r"\b(lock|freeze|block|disable)\b.{0,20}\bcard\b")
BALANCE = R(r"\b(my|account|what'?s my|check( my)?) (current )?balances?\b|\bhow much (money )?(do i have|is in my)")
TXNS = R(r"\b(recent|last|latest) (transactions|charges|purchases|activity)\b|\btransaction history\b|\bshow (me )?my transactions\b")
PAYOFF = R(r"\b(pay ?off|payoff|get rid of)\b.{0,40}\b(card|credit|balance|debt)\b|\bhow long.{0,40}pay (off|down)\b")
SAVINGS = R(r"\b(save|saving|invest|put away|set aside|contribute|deposit)\b.{0,40}\b(a|per|each|every|/) ?(month|mo)\b|\bhow much will i have\b|\bcompound(ing)? interest\b.{0,40}\d|\bgrow\b.{0,30}\d")
LOAN = R(r"\b(monthly payment|payment on|emi|amortization|afford|calculate|estimate|how much (would|will) i pay)\b.{0,60}\b(loan|mortgage|car|auto|home|house|borrow)|\b(loan|mortgage|car loan|auto loan|home loan|borrow)\b.{0,60}\b(payment|emi|per month|a month|monthly|calculat|estimate)")
FOLLOWUP = R(r"^\s*(what|how) about\b|^\s*(and|or) (for|at|with|if)\b|^\s*(instead|same but|what if)\b")

LOAN_DEFAULTS = {
    "mortgage": {"rate": 6.75, "months": 360, "label": "30-year fixed mortgage"},
    "auto": {"rate": 5.49, "months": 60, "label": "new auto loan"},
    "personal": {"rate": 11.99, "months": 36, "label": "personal loan"},
}


def loan_kind(text: str) -> str | None:
    t = text.lower()
    if re.search(r"\b(car|auto|vehicle|truck)\b", t):
        return "auto"
    if re.search(r"\b(personal|debt consolidation)\b", t):
        return "personal"
    if re.search(r"\b(mortgage|home|house|condo)\b", t):
        return "mortgage"
    return None


def classify(text: str, has_slots: bool, memory: dict) -> str:
    if GREETING.search(text):
        return "greeting"
    if BYE.search(text):
        return "goodbye"
    if THANKS.search(text) and len(text.split()) <= 6:
        return "thanks"
    if WHO.search(text):
        return "capabilities"
    if HUMAN.search(text):
        return "escalate"
    if LOCK.search(text):
        return "lock_card"
    if TXNS.search(text):
        return "transactions"
    if BALANCE.search(text):
        return "balance"
    if PAYOFF.search(text) and has_slots:
        return "card_payoff"
    if SAVINGS.search(text):
        return "savings_calc"
    if LOAN.search(text):
        return "loan_calc"
    # Multi-turn: user answers a question we asked, or tweaks the last calculation.
    pending = memory.get("pending_tool")
    if pending and has_slots:
        return pending
    last = memory.get("last_tool")
    if last and has_slots and (FOLLOWUP.search(text) or len(text.split()) <= 6):
        return last
    return "faq"

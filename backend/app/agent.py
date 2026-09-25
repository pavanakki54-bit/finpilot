"""The support agent, orchestrated as a LangGraph state machine.

    guard_input ──blocked──▶ refuse ─────────────────────────────┐
         │                                                       │
         ▼                                                       ▼
      classify ──▶ smalltalk | escalate | account | calculator | rag ──▶ finalize ──▶ END

Each node is a pure function over `ChatState`, which makes the flow easy to
test, trace (LangSmith / OpenTelemetry) and extend with new tools.
"""
from __future__ import annotations

import time
from collections import defaultdict
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from . import guardrails, intents, llm, tools
from .config import settings
from .knowledge import Hit, KnowledgeBase, Retriever

KB = KnowledgeBase(settings.kb_path)
RETRIEVER = Retriever(KB)

STARTERS = [
    "How do I dispute a transaction?",
    "Estimate a $350,000 mortgage at 6.5% for 30 years",
    "I lost my debit card",
    "What are your CD rates?",
]


class ChatState(TypedDict, total=False):
    message: str
    session_id: str
    memory: dict
    text: str
    flags: list[str]
    blocked: bool
    intent: str
    slots: dict
    hits: list[Hit]
    tool: dict | None
    reply: str
    suggestions: list[str]
    confidence: float


def term_str(months: int) -> str:
    return f"{months // 12} years" if months % 12 == 0 else f"{months} months"


# ---------------------------------------------------------------- nodes ---- #
def guard_input(state: ChatState) -> ChatState:
    g = guardrails.check_input(state["message"])
    return {"text": g.text, "flags": g.flags, "blocked": g.blocked}


def refuse(state: ChatState) -> ChatState:
    return {
        "intent": "blocked",
        "reply": "I can only help with FinPilot Bank accounts, cards, payments, loans and other banking questions. "
        "What can I help you with today?",
        "suggestions": STARTERS[:3],
        "confidence": 1.0,
    }


def classify(state: ChatState) -> ChatState:
    slots = tools.extract_slots(state["text"])
    intent = intents.classify(state["text"], bool(slots), state["memory"])
    return {"intent": intent, "slots": slots}


def smalltalk(state: ChatState) -> ChatState:
    replies = {
        "greeting": f"Hi! I'm FinPilot, the virtual assistant for {KB.bank_name}. I can answer questions about accounts, "
        "cards, transfers, loans and fees, run payment calculators, or connect you with a specialist. How can I help?",
        "thanks": "You're welcome! Is there anything else I can help you with?",
        "goodbye": "Thanks for chatting with FinPilot. Have a great day!",
        "capabilities": "Here's what I can do:\n• Answer questions about accounts, fees, cards, transfers, loans, savings and security\n"
        "• Calculate loan/mortgage payments, savings growth and credit-card payoff time\n"
        "• Demo account actions: check balances, show recent transactions, lock a card\n"
        "• Create a support ticket for a human specialist",
    }
    return {"reply": replies[state["intent"]], "suggestions": STARTERS, "confidence": 1.0, "tool": None}


def escalate(state: ChatState) -> ChatState:
    urgent = any(w in state["text"].lower() for w in ("fraud", "stolen", "hacked", "unauthorized", "urgent"))
    ticket = tools.create_ticket(state["text"], "high" if urgent else "normal")
    reply = (
        f"I've created support ticket **{ticket['ticket_id']}** ({ticket['priority']} priority). "
        f"A specialist will contact you {ticket['eta']}. You can also call us at {KB.support['phone']} "
        f"({KB.support['hours']})."
    )
    if urgent:
        reply += f" For suspected fraud, please call our 24/7 fraud line now: {KB.support['fraud_line']}."
    return {"reply": reply, "tool": {"name": "create_ticket", "output": ticket}, "confidence": 1.0,
            "suggestions": ["How do I dispute a transaction?", "Lock my card"]}


def account(state: ChatState) -> ChatState:
    intent = state["intent"]
    if intent == "balance":
        out = tools.get_balances()
        lines = [f"• {a['type']} (••{a['last4']}): {tools.money(a['balance'])}" for a in out["accounts"]]
        reply = "Here are your balances (demo data):\n" + "\n".join(lines)
        sugg = ["Show my recent transactions", "How do I set up alerts?"]
    elif intent == "transactions":
        out = tools.recent_transactions()
        lines = [f"• {t['date']} — {t['desc']}: {tools.money(t['amount'])}" for t in out["transactions"]]
        reply = "Your most recent transactions (demo data):\n" + "\n".join(lines) + \
                "\n\nSee something you don't recognise? I can help you dispute it."
        sugg = ["How do I dispute a transaction?", "Lock my card"]
    else:
        out = tools.lock_card()
        reply = (f"Done — your card ending in {out['last4']} is now **locked** (demo). New purchases will be declined, "
                 "but recurring payments and deposits still go through. You can unlock it any time in Cards → Unlock. "
                 "If the card is lost or stolen, I can help you order a replacement.")
        sugg = ["I lost my debit card", "I see fraud on my account"]
    return {"reply": reply, "tool": {"name": intent, "output": out}, "confidence": 1.0, "suggestions": sugg}


def calculator(state: ChatState) -> ChatState:
    memory, intent = state["memory"], state["intent"]
    # Merge with slots from an earlier turn (multi-turn slot filling / "what about 15 years?").
    continuing = intent in (memory.get("pending_tool"), memory.get("last_tool"))
    prev = memory.get("slots", {}) if continuing else {}
    explicit_kind = intents.loan_kind(state["text"]) if intent == "loan_calc" else None
    if explicit_kind and memory.get("loan_kind") and explicit_kind != memory["loan_kind"]:
        prev, continuing = {}, False  # user switched from e.g. a mortgage to a car loan: start fresh
    slots = {**prev, **state["slots"]}
    notes: list[str] = []

    if intent == "loan_calc":
        kind = intents.loan_kind(state["text"]) or (memory.get("loan_kind") if continuing else None) or "personal"
        d = intents.LOAN_DEFAULTS[kind]
        if "amount" not in slots:
            memory.update(pending_tool=intent, slots=slots, loan_kind=kind)
            return {"reply": f"Happy to estimate that {d['label'] if continuing or explicit_kind else 'loan'} payment. "
                             "How much would you like to borrow? You can also include the rate and term, e.g. "
                             "\"$300,000 at 6.5% for 30 years\".", "tool": None, "confidence": 0.9,
                    "suggestions": ["$300,000 at 6.5% for 30 years", "$25,000 car loan for 5 years"]}
        if "rate" not in slots:
            slots["rate"] = d["rate"]
            notes.append(f"a sample {d['label']} rate of {d['rate']}%")
        if "months" not in slots:
            slots["months"] = d["months"]
            notes.append(f"a {d['months'] // 12}-year term")
        out = tools.loan_payment(slots["amount"], slots["rate"], slots["months"])
        reply = (f"For a **{tools.money(out['amount'])}** loan at **{out['rate']:g}% APR** over **{term_str(out['months'])}**:\n"
                 f"• Monthly payment (principal + interest): **{tools.money(out['monthly_payment'])}**\n"
                 f"• Total interest: {tools.money(out['total_interest'])}\n"
                 f"• Total paid: {tools.money(out['total_paid'])}")
        if kind == "mortgage":
            reply += "\n\nThis excludes property taxes, homeowners insurance and PMI, which are often included in a mortgage payment."
        sugg = ["What about 15 years?", "What about at 5.75%?", "What mortgage options do you offer?"]
        memory["loan_kind"] = kind
    elif intent == "savings_calc":
        if "monthly" not in slots and "amount" not in slots:
            memory.update(pending_tool=intent, slots=slots)
            return {"reply": "Let's project your savings. How much would you save each month (and for how many years)? "
                             "For example: \"$500 a month for 10 years\".", "tool": None, "confidence": 0.9,
                    "suggestions": ["$500 a month for 10 years", "$10,000 plus $200/month for 5 years"]}
        if "rate" not in slots:
            slots["rate"] = 4.10
            notes.append("our sample High-Yield Savings rate of 4.10% APY")
        if "months" not in slots:
            slots["months"] = 120
            notes.append("a 10-year horizon")
        out = tools.savings_growth(slots.get("monthly", 0.0), slots["rate"], slots["months"], slots.get("amount", 0.0))
        yrs = out["months"] / 12
        start = f"{tools.money(out['initial'])} to start" if out["initial"] else ""
        add = f"{tools.money(out['monthly'])}/month" if out["monthly"] else ""
        reply = (f"Saving {' plus '.join(x for x in (start, add) if x)} at **{out['rate']:g}%** for **{yrs:g} years**:\n"
                 f"• Projected balance: **{tools.money(out['future_value'])}**\n"
                 f"• You contribute: {tools.money(out['contributed'])}\n"
                 f"• Interest earned: {tools.money(out['interest_earned'])}\n\n"
                 "Projections assume a constant rate compounded monthly; actual variable rates change over time.")
        sugg = ["What about 20 years?", "What are your CD rates?", "Is my money FDIC insured?"]
    else:  # card_payoff
        if "amount" not in slots or "monthly" not in slots:
            memory.update(pending_tool=intent, slots=slots)
            return {"reply": "I can work out your payoff timeline. What's the card balance and how much can you pay each month? "
                             "E.g. \"$5,000 balance paying $200 a month at 24%\".", "tool": None, "confidence": 0.9,
                    "suggestions": ["$5,000 balance paying $200 a month at 24%"]}
        if "rate" not in slots:
            slots["rate"] = 24.99
            notes.append("a sample APR of 24.99%")
        out = tools.card_payoff(slots["amount"], slots["rate"], slots["monthly"])
        if not out["payable"]:
            reply = (f"At {slots['rate']}% APR, a payment of {tools.money(slots['monthly'])} doesn't cover the monthly interest, "
                     f"so the balance would never go down. You'd need to pay at least {tools.money(out['min_payment_needed'])} a month. "
                     "A 0% intro APR balance transfer could help — want to know how it works?")
        else:
            y, m = divmod(out["months"], 12)
            span = " and ".join(p for p in (f"{y} year{'s' * (y != 1)}" if y else "", f"{m} month{'s' * (m != 1)}" if m else "") if p)
            reply = (f"Paying **{tools.money(out['monthly'])}/month** on a **{tools.money(out['balance'])}** balance at **{out['apr']:g}% APR**:\n"
                     f"• Debt-free in **{out['months']} months** ({span})\n"
                     f"• Total interest: {tools.money(out['total_interest'])}\n"
                     f"• Total paid: ~{tools.money(out['total_paid'])}\n\n"
                     "This assumes no new purchases on the card.")
        sugg = ["How does a balance transfer work?", "What about $300 a month?"]

    if notes:
        reply = f"_Assuming {' and '.join(notes)} — tell me yours to adjust._\n\n" + reply
    memory.update(last_tool=intent, slots=slots)
    memory.pop("pending_tool", None)
    return {"reply": reply, "tool": {"name": intent, "input": slots, "output": out}, "confidence": 1.0, "suggestions": sugg}


def rag(state: ChatState) -> ChatState:
    memory, text = state["memory"], state["text"]
    memory.pop("pending_tool", None)
    memory.pop("last_tool", None)
    query = text
    hits = RETRIEVER.search(query, settings.top_k)
    # Follow-ups ("and for premier checking?") are resolved against the previous question.
    if intents.FOLLOWUP.search(text) and memory.get("last_query"):
        query = memory["last_query"] + " " + text
        hits = RETRIEVER.search(query, settings.top_k)
    top = hits[0].score if hits else 0.0

    if top < settings.min_score:
        if not guardrails.is_finance_related(text):
            return {"hits": [], "confidence": 0.0, "suggestions": STARTERS, "tool": None, "intent": "out_of_scope",
                    "reply": "I'm FinPilot, a banking assistant, so I can only help with things like accounts, cards, "
                             "payments, loans, savings and security. Is there something banking-related I can help with?"}
        return {"hits": hits, "confidence": top, "tool": None, "intent": "fallback",
                "suggestions": [h.faq.question for h in hits[:2]] + ["Talk to a human"],
                "reply": "I'm not certain I have the right answer for that. Could you rephrase it, or would you like me "
                         "to create a support ticket so a specialist can follow up?"}

    memory["last_query"] = query
    answer = llm.generate(text, hits, memory.get("history", []))
    if answer is None:  # grounded extractive answer
        answer = hits[0].faq.answer
    related = [h.faq.question for h in hits[1:] if h.score >= settings.min_score]
    return {"hits": hits, "reply": answer, "confidence": round(top, 3), "suggestions": related[:3], "tool": None}


def finalize(state: ChatState) -> ChatState:
    reply = state["reply"]
    flags = state.get("flags", [])
    if "personal_advice" in flags:
        reply = f"_{guardrails.ADVICE_DISCLAIMER}_\n\n" + reply
    if any(f.startswith("pii:") for f in flags):
        reply = f"🔒 {guardrails.PII_WARNING}\n\n" + reply
    return {"reply": guardrails.check_output(reply)}


# ---------------------------------------------------------------- graph ---- #
def _route(state: ChatState) -> str:
    return {
        "greeting": "smalltalk", "thanks": "smalltalk", "goodbye": "smalltalk", "capabilities": "smalltalk",
        "escalate": "escalate",
        "balance": "account", "transactions": "account", "lock_card": "account",
        "loan_calc": "calculator", "savings_calc": "calculator", "card_payoff": "calculator",
    }.get(state["intent"], "rag")


def build_graph():
    g = StateGraph(ChatState)
    for name, fn in [("guard_input", guard_input), ("refuse", refuse), ("classify", classify),
                     ("smalltalk", smalltalk), ("escalate", escalate), ("account", account),
                     ("calculator", calculator), ("rag", rag), ("finalize", finalize)]:
        g.add_node(name, fn)
    g.add_edge(START, "guard_input")
    g.add_conditional_edges("guard_input", lambda s: "refuse" if s["blocked"] else "classify", ["refuse", "classify"])
    g.add_conditional_edges("classify", _route, ["smalltalk", "escalate", "account", "calculator", "rag"])
    for n in ("refuse", "smalltalk", "escalate", "account", "calculator", "rag"):
        g.add_edge(n, "finalize")
    g.add_edge("finalize", END)
    return g.compile()


GRAPH = build_graph()
SESSIONS: dict[str, dict] = defaultdict(dict)


def chat(message: str, session_id: str = "default") -> dict[str, Any]:
    started = time.perf_counter()
    memory = SESSIONS[session_id]
    state = GRAPH.invoke({"message": message, "session_id": session_id, "memory": memory})
    history = memory.setdefault("history", [])
    history += [{"role": "user", "content": state["text"]}, {"role": "assistant", "content": state["reply"]}]
    del history[:-10]
    node = "refuse" if state.get("blocked") else _route(state)
    path = ["guard_input"] + ([] if node == "refuse" else ["classify"]) + [node, "finalize"]
    return {
        "reply": state["reply"],
        "intent": state["intent"],
        "confidence": state.get("confidence", 0.0),
        "sources": [h.as_source() for h in state.get("hits") or []][: settings.top_k],
        "tool": state.get("tool"),
        "guardrails": state.get("flags", []),
        "suggestions": state.get("suggestions", []),
        "engine": "server+llm" if settings.llm_enabled else "server",
        "path": path,
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }

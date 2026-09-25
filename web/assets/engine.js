/*
 * FinPilot in-browser engine.
 *
 * A JavaScript port of the Python agent in backend/app (guardrails -> intent
 * router -> tools / TF-IDF RAG -> output check). It lets the static site on
 * GitHub Pages answer questions with no server. When the FastAPI backend is
 * reachable, the UI calls it instead; both return the same response shape.
 */
(function (root) {
  "use strict";

  const STOP = root.FP_STOPWORDS || (typeof require !== "undefined" ? require("./stopwords.js") : new Set());
  const TOP_K = 3;
  const MIN_SCORE = 0.12;

  // ------------------------------------------------------------ guardrails --
  const SSN_RE = /\b(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g;
  const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
  const ACCOUNT_RE = /\b\d{8,17}\b/g;
  const SECRET_RE = /\b(password|passcode|pin|otp|one[- ]time code|cvv|security code)\b\s*(is|=|:)\s*\S+/gi;
  const INJECTION_RE = new RegExp([
    "ignore (all |any )?(the |your )?(previous|prior|above) (instructions|prompts?|rules)",
    "disregard (all |your )?(previous |prior )?(instructions|rules|guidelines)",
    "(reveal|show|print|repeat|leak) (me )?(your|the) (system )?(prompt|instructions)",
    "you are now (dan|in developer mode|jailbroken)",
    "\\bjailbreak\\b",
    "pretend (you are|to be) (not )?(an? )?(ai|assistant|bank)",
    "act as (an? )?(unfiltered|uncensored)",
  ].join("|"), "i");
  const ADVICE_RE = new RegExp(
    "\\b(should i (buy|sell|invest|short)|which (stock|crypto|coin|fund|etf)s? (should|to)|" +
    "best (stock|crypto|coin)s? to (buy|invest)|is .{1,30} a good investment|" +
    "will .{1,30} (stock|price) (go up|rise|crash)|tax advice|legal advice|guaranteed returns?)\\b", "i");
  const FINANCE_TERMS = new Set(("account bank banking balance card credit debit loan mortgage interest rate apr apy " +
    "fee fees payment pay deposit withdraw withdrawal transfer wire ach check cheque savings checking cd overdraft " +
    "fraud scam dispute charge statement atm branch invest investment ira retirement stock fund money cash budget " +
    "debt refinance score fico limit routing pin password login tax emi principal borrow lend finance financial " +
    "dollar $ salary paycheck save saving fdic crypto payoff auto car home business ein beneficiary joint support " +
    "help agent human").split(" "));

  const PII_WARNING = "For your security I've removed sensitive details from your message. Please never share full " +
    "card numbers, SSNs, passwords, PINs or one-time codes in chat — FinPilot will never ask for them.";
  const ADVICE_DISCLAIMER = "I can share general information, but I can't give personalised investment, tax or legal " +
    "advice. For recommendations tailored to you, please speak with a licensed financial advisor.";

  function luhnOk(digits) {
    let total = 0;
    const parity = digits.length % 2;
    for (let i = 0; i < digits.length; i++) {
      let d = +digits[i];
      if (i % 2 === parity) { d *= 2; if (d > 9) d -= 9; }
      total += d;
    }
    return total % 10 === 0;
  }

  function maskCards(text, flags) {
    return text.replace(CARD_RE, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) {
        if (flags) flags.add("pii:card_number");
        return `[CARD •••• ${digits.slice(-4)}]` + m.slice(m.replace(/[ -]+$/, "").length);
      }
      return m;
    });
  }

  function redactPii(text) {
    const flags = new Set();
    text = maskCards(text, flags);
    if (new RegExp(SSN_RE.source).test(text)) { flags.add("pii:ssn"); text = text.replace(SSN_RE, "[SSN REDACTED]"); }
    if (new RegExp(SECRET_RE.source, "i").test(text)) { flags.add("pii:secret"); text = text.replace(SECRET_RE, (m, g1) => `${g1} [REDACTED]`); }
    if (new RegExp(ACCOUNT_RE.source).test(text)) { flags.add("pii:account_number"); text = text.replace(ACCOUNT_RE, (m) => `[ACCT •••• ${m.slice(-4)}]`); }
    return { text, flags: [...flags].sort() };
  }

  function checkInput(message) {
    const raw = message.trim().slice(0, 2000);
    const { text, flags } = redactPii(raw);
    const out = { text, flags, blocked: false };
    if (INJECTION_RE.test(raw)) { out.flags.push("prompt_injection"); out.blocked = true; }
    if (ADVICE_RE.test(raw)) out.flags.push("personal_advice");
    return out;
  }

  const isFinanceRelated = (text) => (text.toLowerCase().match(/[a-z$]+/g) || []).some((w) => FINANCE_TERMS.has(w));
  const checkOutput = (text) => maskCards(text).replace(SSN_RE, "[SSN REDACTED]");

  // ----------------------------------------------------------------- tools --
  const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)";
  const AMOUNT_RE = new RegExp("\\$\\s?" + NUM + "\\s*(k|m|million|thousand)?\\b|" + NUM + "\\s*(k|m|million|thousand)\\b", "gi");
  const RATE_RE = new RegExp(NUM + "\\s*(%|percent|pct)", "i");
  const YEARS_RE = new RegExp(NUM + "[\\s-]*(years?|yrs?|yr)\\b", "i");
  const MONTHS_RE = new RegExp(NUM + "[\\s-]*(months?|mos?)\\b", "i");
  const MONTHLY_RE = new RegExp("\\$\\s?" + NUM + "\\s*(k)?\\s*(?:/|a|per|each|every)\\s*(?:mo\\b|month)", "i");
  const BARE_NUM_RE = new RegExp("(?<![\\d.])" + NUM + "(?![\\d.%])", "g");
  const MULT = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 };
  const toFloat = (s) => parseFloat(s.replace(/,/g, ""));
  const cut = (t, m) => t.slice(0, m.index) + " " + t.slice(m.index + m[0].length);

  function extractSlots(text) {
    const slots = {};
    let t = text.toLowerCase(), m;
    if ((m = MONTHLY_RE.exec(t))) { slots.monthly = toFloat(m[1]) * (m[2] ? 1e3 : 1); t = cut(t, m); }
    if ((m = RATE_RE.exec(t))) { slots.rate = toFloat(m[1]); t = cut(t, m); }
    if ((m = YEARS_RE.exec(t))) { slots.months = Math.round(toFloat(m[1]) * 12); t = cut(t, m); }
    else if ((m = MONTHS_RE.exec(t))) { slots.months = Math.round(toFloat(m[1])); t = cut(t, m); }
    let amounts = [];
    for (const a of t.matchAll(AMOUNT_RE)) {
      const [num, mult] = a[1] ? [a[1], a[2]] : [a[3], a[4]];
      amounts.push(toFloat(num) * (MULT[(mult || "").toLowerCase()] || 1));
    }
    if (!amounts.length) amounts = [...t.matchAll(BARE_NUM_RE)].map((x) => toFloat(x[1])).filter((x) => x >= 100);
    if (amounts.length) slots.amount = Math.max(...amounts);
    return slots;
  }

  const round2 = (x) => Math.round(x * 100) / 100;
  const money = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const g = (x) => String(+x.toFixed(6));

  function loanPayment(amount, rate, months) {
    const r = rate / 100 / 12;
    const pay = r === 0 ? amount / months : (amount * r) / (1 - Math.pow(1 + r, -months));
    const total = pay * months;
    return { monthly_payment: round2(pay), total_paid: round2(total), total_interest: round2(total - amount), amount, rate, months };
  }

  function savingsGrowth(monthly, rate, months, initial = 0) {
    const r = rate / 100 / 12;
    const fvInit = initial * Math.pow(1 + r, months);
    const fvContrib = r === 0 ? monthly * months : monthly * ((Math.pow(1 + r, months) - 1) / r);
    const fv = fvInit + fvContrib, contributed = initial + monthly * months;
    return { future_value: round2(fv), contributed: round2(contributed), interest_earned: round2(fv - contributed), monthly, initial, rate, months };
  }

  function cardPayoff(balance, apr, monthly) {
    const r = apr / 100 / 12;
    if (monthly <= balance * r) return { payable: false, min_payment_needed: round2(balance * r + 1) };
    let months = 0, remaining = balance, total = 0;
    while (remaining > 0.005 && months < 1200) {
      remaining += remaining * r;
      const pay = Math.min(monthly, remaining);
      remaining -= pay; total += pay; months++;
    }
    return { payable: true, months, total_paid: round2(total), total_interest: round2(Math.max(total - balance, 0)), balance, apr, monthly };
  }

  const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const DEMO = {
    name: "Alex Morgan (demo customer)",
    accounts: [
      { type: "Everyday Checking", last4: "4821", balance: 2847.63 },
      { type: "High-Yield Savings", last4: "9034", balance: 15230.18 },
      { type: "Cash Back Card", last4: "7712", balance: -642.9, credit_limit: 8000 },
    ],
    transactions: [
      { date: day(0), desc: "Grocery Market #212", amount: -86.42 },
      { date: day(1), desc: "Payroll Direct Deposit", amount: 2450.0 },
      { date: day(2), desc: "Coffee House", amount: -6.75 },
      { date: day(3), desc: "Electric Utility AutoPay", amount: -118.2 },
      { date: day(4), desc: "Streaming Subscription", amount: -15.99 },
    ],
  };
  let ticketSeq = 10421;
  const createTicket = (summary, priority = "normal") => ({
    ticket_id: `FP-${ticketSeq++}`, priority, summary: summary.slice(0, 200),
    eta: priority === "normal" ? "within 1 business day" : "within 2 hours",
  });

  // --------------------------------------------------------------- intents --
  const R = (p) => new RegExp(p, "i");
  const GREETING = R("^\\s*(hi|hello|hey|hiya|howdy|good (morning|afternoon|evening)|yo)\\b[\\s!.,]*(there|team|finpilot)?[\\s!.]*$");
  const THANKS = R("\\b(thanks|thank you|thx|ty|appreciate it)\\b");
  const BYE = R("^\\s*(bye|goodbye|see you|that'?s all|no,? that'?s it)\\b");
  const WHO = R("\\b(who are you|what can you do|what do you do|help me|how can you help)\\b");
  const HUMAN = R("\\b(human|real person|live agent|an agent|representative|speak (to|with) (someone|a person)|talk (to|with) (someone|a person)|escalate|file a complaint|make a complaint|create (a )?(support )?ticket|open (a )?ticket)\\b");
  const LOCK = R("\\b(lock|freeze|block|disable)\\b.{0,20}\\bcard\\b");
  const BALANCE = R("\\b(my|account|what'?s my|check( my)?) (current )?balances?\\b|\\bhow much (money )?(do i have|is in my)");
  const TXNS = R("\\b(recent|last|latest) (transactions|charges|purchases|activity)\\b|\\btransaction history\\b|\\bshow (me )?my transactions\\b");
  const PAYOFF = R("\\b(pay ?off|payoff|get rid of)\\b.{0,40}\\b(card|credit|balance|debt)\\b|\\bhow long.{0,40}pay (off|down)\\b");
  const SAVINGS = R("\\b(save|saving|invest|put away|set aside|contribute|deposit)\\b.{0,40}\\b(a|per|each|every|/) ?(month|mo)\\b|\\bhow much will i have\\b|\\bcompound(ing)? interest\\b.{0,40}\\d|\\bgrow\\b.{0,30}\\d");
  const LOAN = R("\\b(monthly payment|payment on|emi|amortization|afford|calculate|estimate|how much (would|will) i pay)\\b.{0,60}\\b(loan|mortgage|car|auto|home|house|borrow)|\\b(loan|mortgage|car loan|auto loan|home loan|borrow)\\b.{0,60}\\b(payment|emi|per month|a month|monthly|calculat|estimate)");
  const FOLLOWUP = R("^\\s*(what|how) about\\b|^\\s*(and|or) (for|at|with|if)\\b|^\\s*(instead|same but|what if)\\b");
  const LOAN_DEFAULTS = {
    mortgage: { rate: 6.75, months: 360, label: "30-year fixed mortgage" },
    auto: { rate: 5.49, months: 60, label: "new auto loan" },
    personal: { rate: 11.99, months: 36, label: "personal loan" },
  };

  function loanKind(text) {
    const t = text.toLowerCase();
    if (/\b(car|auto|vehicle|truck)\b/.test(t)) return "auto";
    if (/\b(personal|debt consolidation)\b/.test(t)) return "personal";
    if (/\b(mortgage|home|house|condo)\b/.test(t)) return "mortgage";
    return null;
  }

  function classify(text, hasSlots, memory) {
    if (GREETING.test(text)) return "greeting";
    if (BYE.test(text)) return "goodbye";
    if (THANKS.test(text) && text.split(/\s+/).filter(Boolean).length <= 6) return "thanks";
    if (WHO.test(text)) return "capabilities";
    if (HUMAN.test(text)) return "escalate";
    if (LOCK.test(text)) return "lock_card";
    if (TXNS.test(text)) return "transactions";
    if (BALANCE.test(text)) return "balance";
    if (PAYOFF.test(text) && hasSlots) return "card_payoff";
    if (SAVINGS.test(text)) return "savings_calc";
    if (LOAN.test(text)) return "loan_calc";
    if (memory.pending_tool && hasSlots) return memory.pending_tool;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (memory.last_tool && hasSlots && (FOLLOWUP.test(text) || words <= 6)) return memory.last_tool;
    return "faq";
  }

  // ------------------------------------------------------------- retrieval --
  // TF-IDF over word (1-2 gram, stop words removed) + char_wb (3-5 gram)
  // features, sublinear tf, smoothed idf, l2-normalised per block: the same
  // recipe as the scikit-learn FeatureUnion on the server.
  function wordFeatures(text) {
    const toks = (text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []).filter((w) => !STOP.has(w));
    const out = toks.slice();
    for (let i = 0; i + 1 < toks.length; i++) out.push(toks[i] + " " + toks[i + 1]);
    return out;
  }

  function charFeatures(text) {
    const out = [];
    for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      const w = " " + word + " ";
      for (let n = 3; n <= 5; n++) {
        let off = 0;
        out.push(w.slice(off, off + n));
        while (off + n < w.length) { off++; out.push(w.slice(off, off + n)); }
      }
    }
    return out;
  }

  class TfidfBlock {
    constructor(analyzer, docs) {
      this.analyzer = analyzer;
      const df = new Map();
      const counts = docs.map((d) => {
        const c = new Map();
        for (const f of analyzer(d)) c.set(f, (c.get(f) || 0) + 1);
        for (const f of c.keys()) df.set(f, (df.get(f) || 0) + 1);
        return c;
      });
      const n = docs.length;
      this.idf = new Map([...df].map(([f, d]) => [f, Math.log((1 + n) / (1 + d)) + 1]));
      this.vectors = counts.map((c) => this.weigh(c));
    }
    weigh(counts) {
      const v = new Map();
      let norm = 0;
      for (const [f, tf] of counts) {
        const idf = this.idf.get(f);
        if (idf === undefined) continue;
        const w = (1 + Math.log(tf)) * idf;
        v.set(f, w); norm += w * w;
      }
      norm = Math.sqrt(norm);
      if (norm) for (const [f, w] of v) v.set(f, w / norm);
      return v;
    }
    query(text) {
      const c = new Map();
      for (const f of this.analyzer(text)) c.set(f, (c.get(f) || 0) + 1);
      return this.weigh(c);
    }
  }

  const dot = (a, b) => { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [f, w] of x) { const o = y.get(f); if (o) s += w * o; } return s; };
  const sqnorm = (v) => { let s = 0; for (const w of v.values()) s += w * w; return s; };

  class Retriever {
    constructor(faqs) {
      this.faqs = faqs;
      const docs = faqs.map((f) => { const tags = f.tags.join(" "); return `${f.question} ${f.question} ${tags} ${tags} ${f.answer}`; });
      this.word = new TfidfBlock(wordFeatures, docs);
      this.char = new TfidfBlock(charFeatures, docs);
      this.norms = faqs.map((_, i) => Math.sqrt(sqnorm(this.word.vectors[i]) + sqnorm(this.char.vectors[i])) || 1);
    }
    search(text, k = TOP_K) {
      const qw = this.word.query(text), qc = this.char.query(text);
      const qn = Math.sqrt(sqnorm(qw) + sqnorm(qc)) || 1;
      return this.faqs
        .map((faq, i) => ({ faq, score: (dot(qw, this.word.vectors[i]) + dot(qc, this.char.vectors[i])) / (this.norms[i] * qn) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .filter((h) => h.score > 0);
    }
  }

  // ----------------------------------------------------------------- agent --
  const STARTERS = [
    "How do I dispute a transaction?",
    "Estimate a $350,000 mortgage at 6.5% for 30 years",
    "I lost my debit card",
    "What are your CD rates?",
  ];
  const termStr = (m) => (m % 12 === 0 ? `${m / 12} years` : `${m} months`);

  function createEngine(kb) {
    const retriever = new Retriever(kb.faqs);
    const sessions = new Map();

    function smalltalk(intent) {
      const replies = {
        greeting: `Hi! I'm FinPilot, the virtual assistant for ${kb.bank_name}. I can answer questions about accounts, cards, transfers, loans and fees, run payment calculators, or connect you with a specialist. How can I help?`,
        thanks: "You're welcome! Is there anything else I can help you with?",
        goodbye: "Thanks for chatting with FinPilot. Have a great day!",
        capabilities: "Here's what I can do:\n• Answer questions about accounts, fees, cards, transfers, loans, savings and security\n" +
          "• Calculate loan/mortgage payments, savings growth and credit-card payoff time\n" +
          "• Demo account actions: check balances, show recent transactions, lock a card\n" +
          "• Create a support ticket for a human specialist",
      };
      return { reply: replies[intent], suggestions: STARTERS, confidence: 1, tool: null };
    }

    function escalate(text) {
      const urgent = ["fraud", "stolen", "hacked", "unauthorized", "urgent"].some((w) => text.toLowerCase().includes(w));
      const t = createTicket(text, urgent ? "high" : "normal");
      let reply = `I've created support ticket **${t.ticket_id}** (${t.priority} priority). A specialist will contact you ${t.eta}. ` +
        `You can also call us at ${kb.support.phone} (${kb.support.hours}).`;
      if (urgent) reply += ` For suspected fraud, please call our 24/7 fraud line now: ${kb.support.fraud_line}.`;
      return { reply, tool: { name: "create_ticket", output: t }, confidence: 1, suggestions: ["How do I dispute a transaction?", "Lock my card"] };
    }

    function account(intent) {
      let out, reply, sugg;
      if (intent === "balance") {
        out = { customer: DEMO.name, accounts: DEMO.accounts };
        reply = "Here are your balances (demo data):\n" + out.accounts.map((a) => `• ${a.type} (••${a.last4}): ${money(a.balance)}`).join("\n");
        sugg = ["Show my recent transactions", "How do I set up alerts?"];
      } else if (intent === "transactions") {
        out = { transactions: DEMO.transactions };
        reply = "Your most recent transactions (demo data):\n" + out.transactions.map((t) => `• ${t.date} — ${t.desc}: ${money(t.amount)}`).join("\n") +
          "\n\nSee something you don't recognise? I can help you dispute it.";
        sugg = ["How do I dispute a transaction?", "Lock my card"];
      } else {
        out = { status: "locked", last4: "7712", reversible: true };
        reply = `Done — your card ending in ${out.last4} is now **locked** (demo). New purchases will be declined, but recurring payments and ` +
          "deposits still go through. You can unlock it any time in Cards → Unlock. If the card is lost or stolen, I can help you order a replacement.";
        sugg = ["I lost my debit card", "I see fraud on my account"];
      }
      return { reply, tool: { name: intent, output: out }, confidence: 1, suggestions: sugg };
    }

    function calculator(state) {
      const { memory, intent, text } = state;
      let continuing = intent === memory.pending_tool || intent === memory.last_tool;
      let prev = continuing ? memory.slots || {} : {};
      const explicitKind = intent === "loan_calc" ? loanKind(text) : null;
      if (explicitKind && memory.loan_kind && explicitKind !== memory.loan_kind) { prev = {}; continuing = false; }
      const slots = { ...prev, ...state.slots };
      const notes = [];
      let out, reply, sugg;

      if (intent === "loan_calc") {
        const kind = loanKind(text) || (continuing ? memory.loan_kind : null) || "personal";
        const d = LOAN_DEFAULTS[kind];
        if (!("amount" in slots)) {
          Object.assign(memory, { pending_tool: intent, slots, loan_kind: kind });
          return { reply: `Happy to estimate that ${continuing || explicitKind ? d.label : "loan"} payment. How much would you like to borrow? ` +
            'You can also include the rate and term, e.g. "$300,000 at 6.5% for 30 years".', tool: null, confidence: 0.9,
            suggestions: ["$300,000 at 6.5% for 30 years", "$25,000 car loan for 5 years"] };
        }
        if (!("rate" in slots)) { slots.rate = d.rate; notes.push(`a sample ${d.label} rate of ${d.rate}%`); }
        if (!("months" in slots)) { slots.months = d.months; notes.push(`a ${d.months / 12}-year term`); }
        out = loanPayment(slots.amount, slots.rate, slots.months);
        reply = `For a **${money(out.amount)}** loan at **${g(out.rate)}% APR** over **${termStr(out.months)}**:\n` +
          `• Monthly payment (principal + interest): **${money(out.monthly_payment)}**\n` +
          `• Total interest: ${money(out.total_interest)}\n• Total paid: ${money(out.total_paid)}`;
        if (kind === "mortgage") reply += "\n\nThis excludes property taxes, homeowners insurance and PMI, which are often included in a mortgage payment.";
        sugg = ["What about 15 years?", "What about at 5.75%?", "What mortgage options do you offer?"];
        memory.loan_kind = kind;
      } else if (intent === "savings_calc") {
        if (!("monthly" in slots) && !("amount" in slots)) {
          Object.assign(memory, { pending_tool: intent, slots });
          return { reply: 'Let\'s project your savings. How much would you save each month (and for how many years)? For example: "$500 a month for 10 years".',
            tool: null, confidence: 0.9, suggestions: ["$500 a month for 10 years", "$10,000 plus $200/month for 5 years"] };
        }
        if (!("rate" in slots)) { slots.rate = 4.1; notes.push("our sample High-Yield Savings rate of 4.10% APY"); }
        if (!("months" in slots)) { slots.months = 120; notes.push("a 10-year horizon"); }
        out = savingsGrowth(slots.monthly || 0, slots.rate, slots.months, slots.amount || 0);
        const start = out.initial ? `${money(out.initial)} to start` : "";
        const add = out.monthly ? `${money(out.monthly)}/month` : "";
        reply = `Saving ${[start, add].filter(Boolean).join(" plus ")} at **${g(out.rate)}%** for **${g(out.months / 12)} years**:\n` +
          `• Projected balance: **${money(out.future_value)}**\n• You contribute: ${money(out.contributed)}\n` +
          `• Interest earned: ${money(out.interest_earned)}\n\nProjections assume a constant rate compounded monthly; actual variable rates change over time.`;
        sugg = ["What about 20 years?", "What are your CD rates?", "Is my money FDIC insured?"];
      } else {
        if (!("amount" in slots) || !("monthly" in slots)) {
          Object.assign(memory, { pending_tool: intent, slots });
          return { reply: 'I can work out your payoff timeline. What\'s the card balance and how much can you pay each month? E.g. "$5,000 balance paying $200 a month at 24%".',
            tool: null, confidence: 0.9, suggestions: ["$5,000 balance paying $200 a month at 24%"] };
        }
        if (!("rate" in slots)) { slots.rate = 24.99; notes.push("a sample APR of 24.99%"); }
        out = cardPayoff(slots.amount, slots.rate, slots.monthly);
        if (!out.payable) {
          reply = `At ${slots.rate}% APR, a payment of ${money(slots.monthly)} doesn't cover the monthly interest, so the balance would never go down. ` +
            `You'd need to pay at least ${money(out.min_payment_needed)} a month. A 0% intro APR balance transfer could help — want to know how it works?`;
        } else {
          const y = Math.floor(out.months / 12), m = out.months % 12;
          const span = [y ? `${y} year${y !== 1 ? "s" : ""}` : "", m ? `${m} month${m !== 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
          reply = `Paying **${money(out.monthly)}/month** on a **${money(out.balance)}** balance at **${g(out.apr)}% APR**:\n` +
            `• Debt-free in **${out.months} months** (${span})\n• Total interest: ${money(out.total_interest)}\n` +
            `• Total paid: ~${money(out.total_paid)}\n\nThis assumes no new purchases on the card.`;
        }
        sugg = ["How does a balance transfer work?", "What about $300 a month?"];
      }
      if (notes.length) reply = `_Assuming ${notes.join(" and ")} — tell me yours to adjust._\n\n` + reply;
      Object.assign(memory, { last_tool: intent, slots });
      delete memory.pending_tool;
      return { reply, tool: { name: intent, input: slots, output: out }, confidence: 1, suggestions: sugg };
    }

    function rag(state) {
      const { memory, text } = state;
      delete memory.pending_tool; delete memory.last_tool;
      let query = text;
      let hits = retriever.search(query);
      if (FOLLOWUP.test(text) && memory.last_query) { query = memory.last_query + " " + text; hits = retriever.search(query); }
      const top = hits.length ? hits[0].score : 0;
      if (top < MIN_SCORE) {
        if (!isFinanceRelated(text)) {
          return { hits: [], confidence: 0, suggestions: STARTERS, tool: null, intent: "out_of_scope",
            reply: "I'm FinPilot, a banking assistant, so I can only help with things like accounts, cards, payments, loans, savings and security. Is there something banking-related I can help with?" };
        }
        return { hits, confidence: top, tool: null, intent: "fallback",
          suggestions: hits.slice(0, 2).map((h) => h.faq.question).concat("Talk to a human"),
          reply: "I'm not certain I have the right answer for that. Could you rephrase it, or would you like me to create a support ticket so a specialist can follow up?" };
      }
      memory.last_query = query;
      const related = hits.slice(1).filter((h) => h.score >= MIN_SCORE).map((h) => h.faq.question);
      return { hits, reply: hits[0].faq.answer, confidence: Math.round(top * 1000) / 1000, suggestions: related.slice(0, 3), tool: null };
    }

    const ROUTES = { greeting: "smalltalk", thanks: "smalltalk", goodbye: "smalltalk", capabilities: "smalltalk", escalate: "escalate",
      balance: "account", transactions: "account", lock_card: "account", loan_calc: "calculator", savings_calc: "calculator", card_payoff: "calculator" };

    function chat(message, sessionId = "default") {
      const started = (typeof performance !== "undefined" ? performance : Date).now();
      if (!sessions.has(sessionId)) sessions.set(sessionId, {});
      const memory = sessions.get(sessionId);
      const guard = checkInput(message);
      const path = ["guard_input"];
      let state = { message, memory, text: guard.text, flags: guard.flags };
      let result;
      if (guard.blocked) {
        path.push("refuse");
        result = { intent: "blocked", confidence: 1, suggestions: STARTERS.slice(0, 3), tool: null,
          reply: "I can only help with FinPilot Bank accounts, cards, payments, loans and other banking questions. What can I help you with today?" };
      } else {
        path.push("classify");
        const slots = extractSlots(guard.text);
        const intent = classify(guard.text, Object.keys(slots).length > 0, memory);
        state = { ...state, intent, slots };
        const node = ROUTES[intent] || "rag";
        path.push(node);
        if (node === "smalltalk") result = smalltalk(intent);
        else if (node === "escalate") result = escalate(guard.text);
        else if (node === "account") result = account(intent);
        else if (node === "calculator") result = calculator(state);
        else result = rag(state);
        result.intent = result.intent || intent;
      }
      path.push("finalize");
      let reply = result.reply;
      if (guard.flags.includes("personal_advice")) reply = `_${ADVICE_DISCLAIMER}_\n\n` + reply;
      if (guard.flags.some((f) => f.startsWith("pii:"))) reply = `🔒 ${PII_WARNING}\n\n` + reply;
      reply = checkOutput(reply);
      const ended = (typeof performance !== "undefined" ? performance : Date).now();
      return {
        session_id: sessionId,
        reply,
        intent: result.intent,
        confidence: result.confidence || 0,
        sources: (result.hits || []).slice(0, TOP_K).map((h) => ({ id: h.faq.id, category: h.faq.category, question: h.faq.question, score: Math.round(h.score * 1000) / 1000 })),
        tool: result.tool || null,
        guardrails: guard.flags,
        suggestions: result.suggestions || [],
        engine: "browser",
        path,
        latency_ms: Math.round((ended - started) * 10) / 10,
      };
    }

    return { chat, retriever, starters: STARTERS, reset: (id) => sessions.delete(id) };
  }

  const api = { createEngine, extractSlots, loanPayment, savingsGrowth, cardPayoff, redactPii, checkInput, classify, STARTERS };
  root.FinPilotEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

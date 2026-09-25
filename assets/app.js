/* FinPilot web UI: talks to the FastAPI backend when it is reachable and falls
 * back to the in-browser engine otherwise (e.g. on GitHub Pages). */
(function () {
  "use strict";

  const cfg = window.FINPILOT_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const log = $("#log"), input = $("#input"), form = $("#composer"), sendBtn = $("#send");
  const chips = $("#suggestions"), pipeline = $("#pipeline"), inspect = $("#inspect-body");

  const state = { mode: null, api: "", engine: null, kb: null, sessionId: null, busy: false };
  const newSessionId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 24);
  state.sessionId = newSessionId();
  if (cfg.repoUrl) { $("#repo-link").href = cfg.repoUrl; $("#rail-repo").href = cfg.repoUrl; }

  // ---------------------------------------------------------------- backend --
  async function withTimeout(promise, ms) {
    let t;
    return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() => clearTimeout(t));
  }

  async function loadKb() {
    if (state.kb) return state.kb;
    state.kb = window.FP_KB || (await (await fetch("data/faqs.json")).json());
    return state.kb;
  }

  async function ensureEngine() {
    if (!state.engine) state.engine = window.FinPilotEngine.createEngine(await loadKb());
    return state.engine;
  }

  async function detectMode() {
    const base = cfg.apiBase;
    if (base !== "browser" && !window.FP_KB) {
      state.api = base || "";
      try {
        const res = await withTimeout(fetch(state.api + "api/health"), 2500);
        const health = res.ok ? await res.json() : null;
        if (health && health.status === "ok") {
          setMode("server", health.llm ? `API · ${health.llm}` : "API · retrieval");
          return;
        }
      } catch (_) { /* fall through to the browser engine */ }
    }
    await ensureEngine();
    setMode("browser", "In-browser engine");
  }

  function setMode(mode, text) {
    state.mode = mode;
    const el = $("#mode");
    el.className = "mode " + mode;
    $("#mode-text").textContent = text;
    el.title = mode === "server" ? "Answers come from the FastAPI + LangGraph backend" : "Answers are computed in your browser by a port of the same agent";
  }

  async function ask(message) {
    if (state.mode === "server") {
      try {
        const res = await withTimeout(fetch(state.api + "api/chat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, session_id: state.sessionId }),
        }), 30000);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        state.sessionId = data.session_id || state.sessionId;
        return data;
      } catch (err) {
        console.warn("API unavailable, switching to in-browser engine:", err);
        await ensureEngine();
        setMode("browser", "In-browser engine");
      }
    }
    const engine = await ensureEngine();
    await new Promise((r) => setTimeout(r, 280 + Math.random() * 260)); // let the typing indicator read naturally
    return engine.chat(message, state.sessionId);
  }

  // ---------------------------------------------------------------- render --
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(-?\$[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?%)/g, '<span class="num">$1</span>');
  }
  function markdown(text) {
    const blocks = text.trim().split(/\n{2,}/);
    return blocks.map((block) => {
      const lines = block.split("\n");
      let html = "", list = [];
      const flush = () => { if (list.length) { html += "<ul>" + list.map((l) => `<li>${inline(l)}</li>`).join("") + "</ul>"; list = []; } };
      for (const line of lines) {
        if (/^\s*[•\-*]\s+/.test(line)) { list.push(line.replace(/^\s*[•\-*]\s+/, "")); continue; }
        flush();
        const italic = /^_(.+)_$/.exec(line.trim());
        html += italic ? `<p><em>${inline(italic[1])}</em></p>` : `<p>${inline(line)}</p>`;
      }
      flush();
      return html;
    }).join("");
  }

  const AVATAR = '<svg class="avatar" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"/><path d="M10 22V10h9M10 16h6" stroke="var(--on-accent)" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22" cy="21" r="2.8" fill="var(--brass)"/></svg>';
  const INTENT_LABEL = {
    faq: "knowledge", fallback: "low confidence", out_of_scope: "out of scope", blocked: "blocked",
    loan_calc: "loan calculator", savings_calc: "savings calculator", card_payoff: "payoff calculator",
    escalate: "ticket", balance: "balances", transactions: "transactions", lock_card: "card lock",
    greeting: "greeting", thanks: "small talk", goodbye: "small talk", capabilities: "capabilities",
  };

  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function addUser(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = `<div class="bubble">${esc(text)}</div>`;
    log.appendChild(el);
    scrollDown();
  }

  function addTyping() {
    const el = document.createElement("div");
    el.className = "msg bot typing";
    el.innerHTML = `${AVATAR}<div class="bubble"><div class="body" aria-label="FinPilot is typing"><i></i><i></i><i></i></div></div>`;
    log.appendChild(el);
    scrollDown();
    return el;
  }

  function addBot(r) {
    const el = document.createElement("div");
    el.className = "msg bot";
    let extra = "";
    if (r.tool && r.tool.name === "create_ticket") {
      const t = r.tool.output;
      extra += `<div class="ticket"><span class="id">${esc(t.ticket_id)}</span><span class="pill ${t.priority === "high" ? "danger" : "brass"}">${esc(t.priority)} priority</span><span>Reply ${esc(t.eta)}</span></div>`;
    }
    if (r.sources && r.sources.length && (r.intent === "faq" || r.intent === "fallback")) {
      extra += `<details class="sources"><summary>${r.sources.length} source${r.sources.length > 1 ? "s" : ""} from the knowledge base</summary><ul class="source-list">` +
        r.sources.map((s) => `<li><span class="q">${esc(s.question)}</span><span class="cat">${esc(s.category)} · ${esc(s.id)}</span><span class="score">${s.score.toFixed(2)}</span></li>`).join("") +
        "</ul></details>";
    }
    const flags = (r.guardrails || []).map((f) => `<span class="pill ${f === "prompt_injection" ? "danger" : "warn"}">${esc(f)}</span>`).join("");
    const conf = r.intent === "faq" || r.intent === "fallback" ? `<span class="pill">${Math.round(r.confidence * 100)}% match</span>` : "";
    el.innerHTML = `${AVATAR}<div class="bubble"><div class="body">${markdown(r.reply)}</div>${extra}
      <div class="meta"><span class="pill accent">${esc(INTENT_LABEL[r.intent] || r.intent)}</span>${conf}${flags}<span class="spacer"></span>
      <button class="fb" type="button" data-v="up" aria-pressed="false" aria-label="Helpful">▲ Helpful</button>
      <button class="fb" type="button" data-v="down" aria-pressed="false" aria-label="Not helpful">▼</button></div></div>`;
    el.querySelectorAll(".fb").forEach((b) => b.addEventListener("click", () => feedback(el, b)));
    log.appendChild(el);
    scrollDown();
  }

  function feedback(el, btn) {
    el.querySelectorAll(".fb").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    const helpful = btn.dataset.v === "up";
    btn.textContent = helpful ? "▲ Thanks" : "▼ Noted";
    if (state.mode === "server") {
      fetch(state.api + "api/feedback", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: state.sessionId, helpful }) }).catch(() => {});
    }
  }

  function setSuggestions(list) {
    chips.innerHTML = "";
    for (const s of (list || []).slice(0, 4)) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = s;
      b.addEventListener("click", () => send(s));
      chips.appendChild(b);
    }
  }

  function trace(path) {
    const nodes = new Set(path || []);
    ["smalltalk", "escalate", "account", "calculator", "refuse"].forEach((n) => { if (nodes.has(n)) nodes.add("tool"); });
    pipeline.classList.add("traced");
    pipeline.querySelectorAll("li").forEach((li) => li.classList.toggle("hit", nodes.has(li.dataset.node)));
  }

  function renderInspector(r) {
    const conf = Math.max(0, Math.min(1, r.confidence || 0));
    const route = (r.path || []).map((n) => `<span class="pill ${["guard_input", "classify", "finalize"].includes(n) ? "" : "accent"}">${esc(n)}</span>`).join('<span class="arrow">→</span>');
    const flags = (r.guardrails || []).length
      ? r.guardrails.map((f) => `<span class="pill ${f === "prompt_injection" ? "danger" : "warn"}">${esc(f)}</span>`).join("")
      : '<span class="muted" style="font-size:13px">None triggered</span>';
    const sources = (r.sources || []).map((s) => `<div class="bar-row"><span>${esc(s.question)}</span><span class="s">${s.score.toFixed(3)}</span><span class="bar"><span style="width:${Math.min(100, s.score * 100 / 0.6).toFixed(0)}%"></span></span></div>`).join("");
    const tool = r.tool ? JSON.stringify(r.tool, null, 2) : null;
    inspect.innerHTML = `
      <dl class="kv">
        <dt>Intent</dt><dd>${esc(r.intent)}</dd>
        <dt>Engine</dt><dd>${esc(r.engine || state.mode)}</dd>
        <dt>Latency</dt><dd>${r.latency_ms} ms</dd>
        <dt>Confidence</dt><dd>${conf.toFixed(3)}</dd>
      </dl>
      <div class="meter ${conf < 0.2 ? "low" : ""}"><span style="width:${(conf * 100).toFixed(0)}%"></span></div>
      <h3>Route through the graph</h3><div class="route">${route}</div>
      <h3>Guardrails</h3><div class="flags">${flags}</div>
      ${sources ? `<h3>Retrieved passages</h3><div style="margin-bottom:20px">${sources}</div>` : ""}
      ${tool ? `<h3>Tool call</h3><pre>${esc(tool)}</pre>` : ""}`;
  }

  // ------------------------------------------------------------------ flow --
  async function send(text) {
    text = (text || "").trim();
    if (!text || state.busy) return;
    state.busy = true; sendBtn.disabled = true;
    input.value = ""; autosize();
    chips.innerHTML = "";
    // The transcript never displays card numbers, SSNs or passwords, even the user's own.
    addUser(window.FinPilotEngine.redactPii(text).text);
    const typing = addTyping();
    try {
      const r = await ask(text);
      typing.remove();
      addBot(r);
      setSuggestions(r.suggestions);
      trace(r.path);
      renderInspector(r);
    } catch (err) {
      typing.remove();
      addBot({ reply: "Something went wrong on my side. Please try again, or call 1-800-555-0199 (demo).", intent: "error", guardrails: [], confidence: 0 });
      console.error(err);
    } finally {
      state.busy = false; sendBtn.disabled = false; input.focus({ preventScroll: true });
    }
  }

  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; }
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); send(input.value); });

  // Drawers on narrow screens.
  const backdrop = $("#backdrop");
  function openPanel(id) { closePanels(); $("#" + id).classList.add("open"); backdrop.hidden = false; }
  function closePanels() { document.querySelectorAll(".panel.open").forEach((p) => p.classList.remove("open")); backdrop.hidden = true; }
  $("#open-rail").addEventListener("click", () => openPanel("rail"));
  $("#open-inspector").addEventListener("click", () => openPanel("inspector"));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closePanels));
  backdrop.addEventListener("click", closePanels);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanels(); });

  function welcome(kb) {
    const el = document.createElement("div");
    el.className = "msg bot";
    el.innerHTML = `${AVATAR}<div class="bubble"><div class="body">${markdown(
      `Hi, I'm **FinPilot**, the virtual assistant for ${kb.bank_name}. Ask me about accounts, cards, transfers, loans and fees. ` +
      "I can also run exact payment calculators, show demo account data, or open a ticket for a specialist.")}</div></div>`;
    log.appendChild(el);
  }

  $("#new-chat").addEventListener("click", async () => {
    if (state.engine) state.engine.reset(state.sessionId);
    state.sessionId = newSessionId();
    log.innerHTML = "";
    welcome(await loadKb());
    setSuggestions(window.FinPilotEngine.STARTERS);
    pipeline.classList.remove("traced");
    pipeline.querySelectorAll("li").forEach((li) => li.classList.remove("hit"));
    inspect.innerHTML = '<p class="muted">Send a message to see how the agent handled it.</p>';
    input.focus();
  });

  async function init() {
    const kb = await loadKb().catch(() => ({ bank_name: "FinPilot Bank", faqs: [] }));
    welcome(kb);
    if (kb.disclaimer) $("#disclaimer").textContent = kb.disclaimer;

    // Topics: one button per FAQ category, asking that category's first question.
    const cats = new Map();
    for (const f of kb.faqs) { if (!cats.has(f.category)) cats.set(f.category, []); cats.get(f.category).push(f); }
    const topics = $("#topics");
    for (const [cat, items] of cats) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "topic";
      b.innerHTML = `<span>${esc(cat)}</span><span class="count">${items.length}</span>`;
      b.title = items[0].question;
      b.addEventListener("click", () => { closePanels(); send(items[Math.floor(Math.random() * items.length)].question); });
      topics.appendChild(b);
    }

    await detectMode();
    // Open on a worked example so the first view shows what the assistant does.
    const div = document.createElement("div");
    div.className = "divider"; div.textContent = "Example question";
    log.appendChild(div);
    await send("How do I dispute a transaction?");
    setSuggestions(window.FinPilotEngine.STARTERS.slice(1));
  }

  init();
})();

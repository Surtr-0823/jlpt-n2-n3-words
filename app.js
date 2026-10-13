/*  JLPT N2 / N3 考点单词 — 纯静态背单词应用
 *  进度以「追加式复习日志」保存，多端合并时求并集即可，不会互相覆盖。
 */
(() => {
  "use strict";

  const DAY = 86400000;
  const MIN = 60000;
  const K_LOG = "jlpt.progress.v1";
  const K_SET = "jlpt.settings.v1";
  const K_PREVIEWED = "jlpt.previewed.v1";
  // Bump whenever anything under data/ changes: the versioned URL is a cache
  // miss for the service worker, so phones pick up new word data on first load
  // instead of serving yesterday's copy.
  const DATA_V = "4";

  const DEFAULT_SETTINGS = {
    newPerDay: 20,
    maxReview: 200,
    cardMode: "mix",       // ja2zh | zh2ja | cloze | mix
    showReading: "after",  // after | always | never
    levels: ["N2", "N3"],
    preview: true,         // 学习今日新词前先预习一遍
    planByDeadline: true,  // 按截止日期自动算每日新词
    deadline: "2026-12-06",
  };

  const S = {
    words: [],
    byKey: new Map(),
    manifest: null,
    log: [],
    cards: new Map(),
    settings: { ...DEFAULT_SETTINGS },
    view: "study",
    queue: [],
    qi: 0,
    flipped: false,
    session: { new: 0, review: 0 },
    filter: { level: "", bank: "", q: "" },
    showPreview: false,
    previewList: [],
  };

  /* ------------------------------------------------------------ storage */
  function loadLog() {
    try { return JSON.parse(localStorage.getItem(K_LOG) || "[]"); } catch { return []; }
  }
  function saveLog() {
    try { localStorage.setItem(K_LOG, JSON.stringify(S.log)); } catch (e) { toast("保存失败：存储空间不足"); }
  }
  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(K_SET) || "{}") }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() {
    try { localStorage.setItem(K_SET, JSON.stringify(S.settings)); } catch {}
  }

  /* ------------------------------------------------------------ srs */
  const newCard = () => ({ ease: 2.5, ivl: 0, due: 0, reps: 0, lapses: 0, last: 0 });

  function applyGrade(c, g, ts) {
    if (c.reps === 0) {
      if (g === 0) { c.due = ts; c.ivl = 0; }
      else if (g === 1) { c.due = ts + 4 * MIN; c.ivl = 0; }
      else if (g === 2) { c.due = ts + 10 * MIN; c.ivl = 0; }
      else { c.due = ts + 2 * DAY; c.ivl = 2; }
    } else if (c.ivl === 0) {
      if (g === 0) { c.due = ts + 1 * MIN; c.lapses++; c.ease = Math.max(1.3, c.ease - 0.2); }
      else if (g === 1) { c.due = ts + 6 * MIN; }
      else { c.ivl = 1; c.due = ts + DAY; }
    } else {
      if (g === 0) {
        c.lapses++;
        c.ease = Math.max(1.3, c.ease - 0.2);
        c.ivl = Math.max(0, Math.floor(c.ivl * 0.4));
        c.due = ts + 2 * MIN;
      } else if (g === 1) {
        c.ease = Math.max(1.3, c.ease - 0.15);
        c.ivl = Math.max(1, Math.round(c.ivl * 1.25));
        c.due = ts + c.ivl * DAY;
      } else if (g === 2) {
        c.ivl = Math.max(1, Math.round(c.ivl * c.ease));
        c.due = ts + c.ivl * DAY;
      } else {
        c.ease = Math.min(3.0, c.ease + 0.12);
        c.ivl = Math.max(2, Math.round(c.ivl * c.ease * 1.3));
        c.due = ts + c.ivl * DAY;
      }
    }
    c.reps++;
    c.last = ts;
  }

  function replay(log) {
    const m = new Map();
    for (const ev of log) {
      let c = m.get(ev[0]);
      if (!c) { c = newCard(); m.set(ev[0], c); }
      applyGrade(c, ev[1], ev[2]);
    }
    return m;
  }

  const keyOf = (w) => w.w + "\u0001" + w.r;
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function previewedToday() {
    try { return localStorage.getItem(K_PREVIEWED) === todayStr(); } catch { return false; }
  }

  function markPreviewed() {
    try { localStorage.setItem(K_PREVIEWED, todayStr()); } catch {}
  }

  /* ------------------------------------------------------------ plan */
  function plan() {
    const pool = activeWords();
    const unseen = pool.filter((w) => !S.cards.has(keyOf(w))).length;
    const dl = S.settings.deadline;
    const out = { total: pool.length, unseen, deadline: dl, daysLeft: null, target: null };
    if (dl) {
      const end = new Date(dl + "T00:00:00");
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const daysLeft = Math.max(1, Math.round((end - today) / DAY));
      out.daysLeft = daysLeft;
      out.target = Math.max(1, Math.ceil(unseen / daysLeft));
      out.end = end;
    }
    // recent pace: words introduced per day over the last 7 days
    const t0 = startOfToday();
    const firstSeen = new Map();
    for (const ev of S.log) if (!firstSeen.has(ev[0])) firstSeen.set(ev[0], ev[2]);
    let recent = 0;
    for (const t of firstSeen.values()) if (t >= t0 - 6 * DAY) recent++;
    out.pace = recent / 7;
    out.etaDays = out.pace > 0 ? Math.ceil(unseen / out.pace) : null;
    return out;
  }

  function effectiveNewPerDay() {
    if (S.settings.planByDeadline && S.settings.deadline) {
      const p = plan();
      if (p.target) return p.target;
    }
    return S.settings.newPerDay;
  }

  function introducedToday() {
    const t0 = startOfToday();
    const first = new Map();
    for (const ev of S.log) if (!first.has(ev[0])) first.set(ev[0], ev[2]);
    let n = 0;
    for (const t of first.values()) if (t >= t0) n++;
    return n;
  }

  function reviewedToday() {
    const t0 = startOfToday();
    let n = 0;
    for (const ev of S.log) if (ev[2] >= t0) n++;
    return n;
  }

  function streakDays() {
    const days = new Set(S.log.map((e) => {
      const d = new Date(e[2]); d.setHours(0, 0, 0, 0); return d.getTime();
    }));
    if (!days.size) return 0;
    let n = 0;
    let cur = startOfToday();
    if (!days.has(cur)) {
      cur -= DAY;
      if (!days.has(cur)) return 0;
    }
    while (days.has(cur)) { n++; cur -= DAY; }
    return n;
  }

  /* ------------------------------------------------------------ queue */
  function activeWords() {
    const lv = new Set(S.settings.levels);
    return S.words.filter((w) => w.lvls.some((l) => lv.has(l)));
  }

  function buildQueue() {
    const now = Date.now();
    const pool = activeWords();
    const due = [], fresh = [];
    for (const w of pool) {
      const c = S.cards.get(keyOf(w));
      if (!c) fresh.push(w);
      else if (c.due <= now) due.push({ w, c });
    }
    due.sort((a, b) => a.c.due - b.c.due);
    const room = Math.max(0, effectiveNewPerDay() - introducedToday());
    // brand-new cards stay in dataset order so the list reads like the PDF
    return [
      ...due.slice(0, S.settings.maxReview).map((x) => x.w),
      ...fresh.slice(0, room),
    ];
  }

  function newInQueue() {
    return S.queue.filter((w) => !S.cards.has(keyOf(w)));
  }

  function requeueSoon(word, ts) {
    // if the card is due again within this session, put it back after a few cards
    const c = S.cards.get(keyOf(word));
    if (!c) return;
    if (c.due - Date.now() < 30 * MIN) {
      const at = Math.min(S.queue.length, S.qi + 5);
      S.queue.splice(at, 0, word);
    }
  }

  /* ------------------------------------------------------------ helpers */
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function sentenceHTML(ex, opts = {}) {
    const j = esc(ex.j);
    const h = ex.h;
    if (!h) return j;
    const raw = ex.j;
    const before = esc(raw.slice(0, h[0]));
    const mid = esc(raw.slice(h[0], h[1]));
    const after = esc(raw.slice(h[1]));
    if (opts.blank) return before + `<span class="blank">＿＿＿</span>` + after;
    return before + `<span class="mark">${mid}</span>` + after;
  }

  const bankLabel = (id) => {
    const b = (S.manifest?.banks || []).find((x) => x.id === id);
    return b ? b.title : id;
  };

  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), 1700);
  }

  function cardMode(w) {
    const m = S.settings.cardMode;
    if (m !== "mix") return m;
    // alternate, but cloze only when there is an example to blank out
    const hasEx = w.ex.length > 0;
    const n = (w.w.length + (w.r ? w.r.length : 0)) % 3;
    if (n === 0 && hasEx) return "cloze";
    if (n === 1) return "zh2ja";
    return "ja2zh";
  }

  /* ------------------------------------------------------------ views */
  function render() {
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.view === S.view));
    const titles = { study: "学习", browse: "词表", stats: "进度", settings: "设置" };
    byId("viewTitle").textContent = titles[S.view];
    renderTopStats();
    const main = byId("main");
    if (S.view === "study") renderStudy(main);
    else if (S.view === "browse") renderBrowse(main);
    else if (S.view === "stats") renderStats(main);
    else renderSettings(main);
  }

  const byId = (id) => document.getElementById(id);

  function renderTopStats() {
    const now = Date.now();
    const pool = activeWords();
    let due = 0, unseen = 0;
    for (const w of pool) {
      const c = S.cards.get(keyOf(w));
      if (!c) unseen++;
      else if (c.due <= now) due++;
    }
    const room = Math.max(0, effectiveNewPerDay() - introducedToday());
    byId("topStats").innerHTML =
      `待复习 <b>${due}</b> · 新词 <b>${Math.min(unseen, room)}</b> · 今日 <b>${reviewedToday()}</b>`;
    const total = due + Math.min(unseen, room);
    const done = S.session.new + S.session.review;
    const pct = total + done === 0 ? 100 : Math.round((done / (total + done)) * 100);
    byId("duebar").innerHTML = `<i style="width:${pct}%"></i>`;
    renderPlanStrip();
  }

  const fmtDate = (s) => { const [, m, d] = s.split("-"); return `${+m}/${+d}`; };

  function renderPlanStrip() {
    const el = byId("planbar");
    if (!el) return;
    const p = plan();
    if (!p.deadline || !p.daysLeft) { el.style.display = "none"; return; }
    const learned = p.total - p.unseen;
    const doneToday = introducedToday();
    const ok = doneToday >= p.target;
    const pct = p.total ? Math.round((learned / p.total) * 100) : 0;
    el.style.display = "flex";
    el.innerHTML =
      `<span class="pb"><span class="pb-k">倒计时</span><b>${p.daysLeft}</b> 天到 ${fmtDate(p.deadline)}</span>` +
      `<span class="pb"><span class="pb-k">今日新词</span><b>${doneToday}</b>/${p.target}${ok ? " ✓" : ""}</span>` +
      `<span class="pb"><span class="pb-k">总进度</span><b>${learned}</b>/${p.total}<i class="pb-bar"><i style="width:${pct}%"></i></i></span>`;
  }

  /* ---- study ---- */
  function exHTML(e, opts = {}) {
    return `<div class="sentence">${sentenceHTML(e, opts)}${e.n ? `<div class="exnote">${esc(e.n)}</div>` : ""}</div>`;
  }

  function trHTML(e) {
    return e && e.t ? `<div class="ex-tr">${esc(e.t)}</div>` : "";
  }

  function openPreview() {
    S.previewList = newInQueue();
    S.showPreview = true;
    render();
    window.scrollTo(0, 0);
  }

  function renderPreview(main) {
    const list = S.previewList;
    const p = plan();
    main.innerHTML = `
      <div class="preview-head">
        <div class="pv-title">今日新词 ${list.length} 个</div>
        <div class="hint" style="text-align:left">先看一遍读音、释义、例句和句子翻译，再开始默记。</div>
        ${p.daysLeft ? `<div class="hint" style="text-align:left">距 ${fmtDate(p.deadline)} 还有 <b>${p.daysLeft}</b> 天 · 每天需要 <b>${p.target}</b> 个新词</div>` : ""}
        <button class="btn wide" id="startStudy" style="margin-top:10px">开始学习</button>
      </div>
      <div class="list" id="plist"></div>
      <div class="hint" style="margin-top:14px">不想每次预习？在「设置」里关掉即可。</div>
    `;
    const frag = document.createDocumentFragment();
    list.forEach((w, i) => {
      const el = document.createElement("div");
      el.className = "item pv-item";
      el.innerHTML = `
        <div class="item-head">
          <span class="pv-n">${i + 1}</span>
          <span class="item-word">${esc(w.w)}</span>
          <span class="item-read">${esc(w.r || w.kh || "")}</span>
          <span class="item-zh">${esc(w.z)}</span>
        </div>
        ${w.ex.slice(0, 2).map((e) => exHTML(e) + trHTML(e)).join("")}
      `;
      frag.appendChild(el);
    });
    byId("plist").appendChild(frag);
    byId("startStudy").onclick = () => {
      markPreviewed();
      S.showPreview = false;
      render();
      window.scrollTo(0, 0);
    };
  }

  function renderStudy(main) {
    if (S.showPreview) { renderPreview(main); return; }
    if (!S.queue.length) {
      main.innerHTML = `<div class="card"><div class="empty">
        <div class="big">🎉</div>
        <div><b>这一轮已经完成</b></div>
        <div>本次学习 ${S.session.new + S.session.review} 张（新词 ${S.session.new}）</div>
      </div></div>
      <div class="row" style="margin-top:12px">
        <button class="btn ghost" id="moreNew">再学 10 个新词</button>
        <button class="btn" id="reload">刷新队列</button>
      </div>`;
      byId("moreNew").onclick = () => {
        S.settings.planByDeadline = false;
        S.settings.newPerDay = effectiveNewPerDay() + 10;
        saveSettings(); rebuild(true);
      };
      byId("reload").onclick = () => rebuild(true);
      return;
    }
    const w = S.queue[S.qi];
    const c = S.cards.get(keyOf(w));
    const isNew = !c;
    const mode = cardMode(w);
    const flipped = S.flipped;

    const badge = `<div class="badges">
      ${w.lvls.map((l) => `<span class="badge lvl">${l}</span>`).join("")}
      ${isNew ? `<span class="badge new">新词</span>` : `<span class="badge due">复习</span>`}
      ${w.banks.map((b) => `<span class="badge">${esc(bankLabel(b))}</span>`).join("")}
      ${mode === "cloze" ? `<span class="badge">例句填空</span>` : mode === "zh2ja" ? `<span class="badge">中→日</span>` : `<span class="badge">日→中</span>`}
      ${w.ex.length && newInQueue().length ? `<button class="badge pv-btn" id="pvBtn">先看一遍</button>` : ""}
    </div>`;

    let front = "", back = "";
    const showRead = S.settings.showReading;
    const readShown = showRead === "always" || (showRead === "after" && flipped);
    const kh = w.kh ? `<div class="reading">${esc(w.kh)}</div>` : "";
    // the prompt side masks the reading unless the setting reveals it
    const masked = w.r
      ? `<div class="reading${readShown ? "" : " hidden-reading"}">${readShown ? esc(w.r) : "读音 ?"}</div>`
      : kh;
    const revealed = w.r ? `<div class="reading">${esc(w.r)}</div>` : kh;

    if (mode === "zh2ja") {
      front = `<div class="meaning">${esc(w.z || "（无释义）")}</div>`;
      back = `<div class="word">${esc(w.w)}</div>${revealed}`;
    } else if (mode === "cloze") {
      front = `<div class="sentence">${sentenceHTML(w.ex[0], { blank: true })}</div>
               ${w.ex[0].t ? `<div class="ex-tr">${esc(w.ex[0].t)}</div>` : ""}
               <div class="hint">补出这句里被挖掉的词</div>`;
      back = `<div class="word small">${esc(w.w)}</div>${revealed}
              <div class="sentence">${sentenceHTML(w.ex[0])}</div>
              ${w.ex[0].t ? `<div class="ex-tr">${esc(w.ex[0].t)}</div>` : ""}`;
    } else {
      front = `<div class="word">${esc(w.w)}</div>${masked}`;
      back = `<div class="word small">${esc(w.w)}</div>${revealed}
              <div class="meaning">${esc(w.z || "（无释义）")}</div>`;
    }

    // examples live on the answer side; the cloze prompt already showed the first one
    const already = mode === "cloze" ? 1 : 0;
    const allEx = flipped
      ? w.ex.slice(already, already + 2).map((e) => exHTML(e) + trHTML(e)).join("")
      : "";

    main.innerHTML = `
      <div class="card" id="card">
        ${badge}
        <div class="prompt-area">${flipped ? back : front}</div>
        ${flipped && allEx ? `<div class="divider"></div>${allEx}` : ""}
      </div>
      ${flipped ? `
        <div class="grades" style="margin-top:12px">
          <button class="grade" data-g="0">忘记<small>1</small></button>
          <button class="grade" data-g="1">模糊<small>2</small></button>
          <button class="grade" data-g="2">记得<small>3</small></button>
          <button class="grade" data-g="3">太简单<small>4</small></button>
        </div>
        <div class="swipe-hint">左滑=忘记 · 右滑=记得 · 空格翻面</div>
      ` : `
        <div class="btn wide" id="flip" style="margin-top:12px">显示答案</div>
        <div class="swipe-hint">点卡片或按空格翻面</div>
      `}
    `;

    const card = byId("card");
    card.onclick = () => { S.flipped = !S.flipped; render(); };
    if (byId("pvBtn")) byId("pvBtn").onclick = (e) => { e.stopPropagation(); openPreview(); };
    if (byId("flip")) byId("flip").onclick = (e) => { e.stopPropagation(); S.flipped = true; render(); };
    document.querySelectorAll(".grade").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); grade(+b.dataset.g); };
    });
  }

  function grade(g) {
    const w = S.queue[S.qi];
    if (!w) return;
    const k = keyOf(w);
    const wasNew = !S.cards.has(k);
    const ts = Date.now();
    S.log.push([k, g, ts]);
    let c = S.cards.get(k);
    if (!c) { c = newCard(); S.cards.set(k, c); }
    applyGrade(c, g, ts);
    saveLog();
    if (wasNew) S.session.new++; else S.session.review++;

    S.flipped = false;
    S.qi++;
    requeueSoon(w, ts);
    if (S.qi >= S.queue.length) rebuild(false);
    else render();
  }

  function rebuild(force, autoPreview) {
    S.queue = buildQueue();
    S.qi = 0;
    S.flipped = false;
    if (force) S.session = { new: 0, review: 0 };
    S.previewList = newInQueue();
    S.showPreview = !!(autoPreview && S.settings.preview && !previewedToday()
                       && S.previewList.length);
    render();
  }

  /* ---- browse ---- */
  function renderBrowse(main) {
    const f = S.filter;
    const lv = new Set(S.settings.levels);
    let list = S.words.filter((w) => w.lvls.some((l) => lv.has(l)));
    if (f.level) list = list.filter((w) => w.lvls.includes(f.level));
    if (f.bank) list = list.filter((w) => w.banks.includes(f.bank));
    if (f.q) {
      const q = f.q.toLowerCase();
      list = list.filter((w) =>
        w.w.includes(q) || (w.r && w.r.includes(q)) ||
        (w.z && w.z.toLowerCase().includes(q)) ||
        w.ex.some((e) => e.j.includes(q)));
    }
    const banks = S.manifest?.banks || [];
    main.innerHTML = `
      <div class="toolbar">
        <input class="search" id="q" placeholder="搜索词 / 读音 / 中文 / 例句" value="${esc(f.q)}">
      </div>
      <div class="chips" style="margin-bottom:10px">
        <button class="chip ${!f.level ? "on" : ""}" data-lv="">全部级别</button>
        ${["N2", "N3"].map((l) => `<button class="chip ${f.level === l ? "on" : ""}" data-lv="${l}">${l}</button>`).join("")}
        <button class="chip ${!f.bank ? "on" : ""}" data-bk="">全部词库</button>
        ${banks.map((b) => `<button class="chip ${f.bank === b.id ? "on" : ""}" data-bk="${b.id}">${esc(b.title)}</button>`).join("")}
      </div>
      <div class="hint" style="text-align:left;margin-bottom:8px">共 ${list.length} 个词</div>
      <div class="list" id="list"></div>
    `;
    const q = byId("q");
    q.oninput = () => { S.filter.q = q.value; const pos = q.selectionStart; renderBrowse(main); const n = byId("q"); n.focus(); n.setSelectionRange(pos, pos); };
    main.querySelectorAll("[data-lv]").forEach((b) => b.onclick = () => { S.filter.level = b.dataset.lv; renderBrowse(main); });
    main.querySelectorAll("[data-bk]").forEach((b) => b.onclick = () => { S.filter.bank = b.dataset.bk; renderBrowse(main); });

    const listEl = byId("list");
    const cap = 200;
    const frag = document.createDocumentFragment();
    list.slice(0, cap).forEach((w) => {
      const c = S.cards.get(keyOf(w));
      const el = document.createElement("div");
      el.className = "item";
      const pct = c && c.ivl > 0 ? Math.min(100, Math.round((c.reps / 6) * 100)) : (c ? 8 : 0);
      el.innerHTML = `
        <div class="item-head">
          <span class="item-word">${esc(w.w)}</span>
          <span class="item-read">${esc(w.r)}</span>
          <span class="item-zh">${esc(w.z)}</span>
        </div>
        ${w.ex[0] ? `<div class="item-ex">${sentenceHTML(w.ex[0])}</div>` : ""}
        ${w.ex[0] && w.ex[0].t ? `<div class="item-tr">${esc(w.ex[0].t)}</div>` : ""}
        <div class="meter"><i style="width:${pct}%;background:${c ? "var(--ok)" : "var(--line)"}"></i></div>
      `;
      frag.appendChild(el);
    });
    listEl.appendChild(frag);
    if (list.length > cap) {
      const more = document.createElement("div");
      more.className = "hint";
      more.textContent = `只显示前 ${cap} 个，输入搜索词可缩小范围`;
      listEl.appendChild(more);
    }
  }

  /* ---- stats ---- */
  function renderStats(main) {
    const now = Date.now();
    const pool = activeWords();
    let learning = 0, mature = 0, young = 0, unseen = 0, due = 0, leech = 0;
    for (const w of pool) {
      const c = S.cards.get(keyOf(w));
      if (!c) { unseen++; continue; }
      if (c.ivl >= 21) mature++;
      else if (c.ivl >= 1) young++;
      else learning++;
      if (c.due <= now) due++;
      if (c.lapses >= 4) leech++;
    }
    const total = pool.length;
    const touched = total - unseen;
    const pct = total ? Math.round((touched / total) * 100) : 0;

    // last 14 days activity
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = startOfToday() - i * DAY;
      days.push({ t: d, n: 0, newN: 0 });
    }
    const firstSeen = new Map();
    for (const ev of S.log) if (!firstSeen.has(ev[0])) firstSeen.set(ev[0], ev[2]);
    for (const ev of S.log) {
      const d = new Date(ev[2]); d.setHours(0, 0, 0, 0);
      const slot = days.find((x) => x.t === d.getTime());
      if (slot) slot.n++;
    }
    for (const t of firstSeen.values()) {
      const d = new Date(t); d.setHours(0, 0, 0, 0);
      const slot = days.find((x) => x.t === d.getTime());
      if (slot) slot.newN++;
    }
    const maxN = Math.max(1, ...days.map((d) => d.n));

    const perBank = (S.manifest?.banks || []).map((b) => {
      const ws = S.words.filter((w) => w.banks.includes(b.id) && w.lvls.some((l) => S.settings.levels.includes(l)));
      const seen = ws.filter((w) => S.cards.has(keyOf(w))).length;
      return { title: b.title, total: ws.length, seen };
    });

    main.innerHTML = `
      <div class="grid2">
        <div class="stat"><div class="k">今日复习</div><div class="v">${reviewedToday()}<span class="u"> 次</span></div></div>
        <div class="stat"><div class="k">连续打卡</div><div class="v">${streakDays()}<span class="u"> 天</span></div></div>
        <div class="stat"><div class="k">已学单词</div><div class="v">${touched}<span class="u"> / ${total}</span></div></div>
        <div class="stat"><div class="k">总体进度</div><div class="v">${pct}<span class="u"> %</span></div></div>
      </div>

      ${planPanel()}

      <div class="section-title">掌握程度</div>
      <div class="panel" style="padding:14px">
        <div class="bars">
          ${bar("已熟练", mature, total, "var(--ok)")}
          ${bar("复习中", young, total, "var(--accent)")}
          ${bar("学习中", learning, total, "var(--warn)")}
          ${bar("未学习", unseen, total, "var(--line)")}
        </div>
        <div class="hint" style="margin-top:12px;text-align:left">
          已熟练 = 间隔 ≥21 天 · 复习中 = 1–20 天 · 学习中 = 不到 1 天
        </div>
        ${leech ? `<div class="hint" style="margin-top:6px;text-align:left">久攻不下（忘记 ≥4 次）：${leech} 个</div>` : ""}
      </div>

      <div class="section-title">最近 14 天</div>
      <div class="panel" style="padding:14px">
        <div style="display:flex;align-items:flex-end;gap:3px;height:76px">
          ${days.map((d) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:2px" title="${d.n} 次">
            <div style="height:${Math.round((d.n / maxN) * 62)}px;background:var(--accent);border-radius:3px 3px 0 0"></div>
            <div style="height:${Math.round((d.newN / maxN) * 62)}px;background:var(--accent-soft);border-radius:0 0 3px 3px"></div>
          </div>`).join("")}
        </div>
        <div class="hint" style="margin-top:8px">深色=复习次数，浅色=新学单词</div>
      </div>

      <div class="section-title">各词库进度</div>
      <div class="panel" style="padding:14px">
        <div class="bars">
          ${perBank.map((b) => bar(b.title, b.seen, b.total, "var(--accent)", true)).join("")}
        </div>
      </div>

      <div class="section-title">累计</div>
      <div class="panel" style="padding:14px">
        <div class="field"><span class="fl">总复习次数</span><span>${S.log.length}</span></div>
        <div class="field"><span class="fl">当前待复习</span><span>${due}</span></div>
        <div class="field"><span class="fl">词库总量</span><span>${S.words.length}</span></div>
      </div>
    `;
  }

  function bar(label, n, total, color, wide) {
    const pct = total ? Math.round((n / total) * 100) : 0;
    return `<div class="brow">
      <span class="bl" style="${wide ? "width:118px" : ""}">${esc(label)}</span>
      <span class="bt"><i style="width:${pct}%;background:${color}"></i></span>
      <span class="bn">${n}</span>
    </div>`;
  }

  function planPanel() {
    const p = plan();
    if (!p.deadline || !p.daysLeft) return "";
    const learned = p.total - p.unseen;
    const needPerDayLeft = p.target;
    let eta = "还不够判断（先背几天）";
    if (p.pace > 0) {
      const days = Math.ceil(p.unseen / p.pace);
      const d = new Date(startOfToday() + days * DAY);
      eta = `${days} 天后 · ${d.getMonth() + 1}/${d.getDate()}`;
    }
    const off = p.etaDays && p.etaDays > p.daysLeft;
    return `
      <div class="section-title">完成期限</div>
      <div class="panel" style="padding:14px">
        <div class="field"><span class="fl">目标日期</span><span>${fmtDate(p.deadline)}（还有 ${p.daysLeft} 天）</span></div>
        <div class="field"><span class="fl">每天需学新词</span><span>${needPerDayLeft} 个</span></div>
        <div class="field"><span class="fl">已学 / 词库总量</span><span>${learned} / ${p.total}</span></div>
        <div class="field"><span class="fl">按最近速度预计完成</span><span style="color:${off ? "var(--bad)" : "var(--ok)"}">${eta}</span></div>
      </div>`;
  }

  /* ---- settings ---- */
  function deadlineHint() {
    if (!S.settings.deadline) return "设定后会自动算出每天要背多少词";
    const p = plan();
    if (!p.daysLeft) return "期限已过";
    return `距 ${fmtDate(S.settings.deadline)} 还有 ${p.daysLeft} 天 · 剩余 ${p.unseen} 个词 · 每天 ${p.target} 个`;
  }

  function renderSettings(main) {
    const s = S.settings;
    main.innerHTML = `
      <div class="panel">
        <div class="field">
          <div><div class="fl">按截止日期排计划</div><div class="fd">自动算出每天要学多少个新词</div></div>
          <label class="sw"><input type="checkbox" id="planByDeadline" ${s.planByDeadline ? "checked" : ""}><span></span></label>
        </div>
        <div class="field">
          <div><div class="fl">背完所有单词的期限</div><div class="fd">${deadlineHint()}</div></div>
          <input type="date" id="deadline" value="${s.deadline || ""}">
        </div>
        <div class="field">
          <div><div class="fl">每日新词</div><div class="fd">每天最多引入多少个新词</div></div>
          <input type="number" id="newPerDay" min="0" max="500" value="${s.newPerDay}" ${s.planByDeadline ? "disabled" : ""}>
        </div>
        <div class="field">
          <div><div class="fl">每次复习上限</div><div class="fd">每轮最多排多少张待复习卡</div></div>
          <input type="number" id="maxReview" min="20" max="1000" value="${s.maxReview}">
        </div>
        <div class="field">
          <div><div class="fl">学习前先预习</div><div class="fd">每天第一次学习前，先把今日新词看一遍</div></div>
          <label class="sw"><input type="checkbox" id="preview" ${s.preview ? "checked" : ""}><span></span></label>
        </div>
        <div class="field">
          <div><div class="fl">卡片模式</div><div class="fd">混合模式会轮流出现三种题型</div></div>
          <select id="cardMode">
            <option value="mix" ${s.cardMode === "mix" ? "selected" : ""}>混合</option>
            <option value="ja2zh" ${s.cardMode === "ja2zh" ? "selected" : ""}>日 → 中</option>
            <option value="zh2ja" ${s.cardMode === "zh2ja" ? "selected" : ""}>中 → 日</option>
            <option value="cloze" ${s.cardMode === "cloze" ? "selected" : ""}>例句填空</option>
          </select>
        </div>
        <div class="field">
          <div><div class="fl">显示读音</div><div class="fd">日→中模式下何时显示假名</div></div>
          <select id="showReading">
            <option value="after" ${s.showReading === "after" ? "selected" : ""}>翻面后</option>
            <option value="always" ${s.showReading === "always" ? "selected" : ""}>总是</option>
            <option value="never" ${s.showReading === "never" ? "selected" : ""}>从不</option>
          </select>
        </div>
        <div class="field">
          <div><div class="fl">启用级别</div><div class="fd">默认 N2 + N3</div></div>
          <div style="display:flex;gap:12px">
            ${["N2", "N3"].map((l) => `<label style="display:flex;gap:5px;align-items:center;font-size:15px">
              <input type="checkbox" data-lvl="${l}" ${s.levels.includes(l) ? "checked" : ""}>${l}</label>`).join("")}
          </div>
        </div>
      </div>

      <div class="section-title">进度备份与同步</div>
      <div class="panel" style="padding:14px">
        <div class="field" style="display:block">
          <div class="fl">导出</div>
          <div class="fd">把学习记录存成 JSON 文件（可放进 iCloud / 微信 / 邮件）</div>
          <button class="btn ghost wide" id="export" style="margin-top:10px">导出进度文件</button>
        </div>
        <div class="field" style="display:block">
          <div class="fl">导入</div>
          <div class="fd">与当前记录<b>合并</b>（求并集，不会覆盖已有进度）</div>
          <input type="file" id="importFile" accept="application/json,.json" style="margin-top:10px">
        </div>
      </div>

      <div class="section-title">危险操作</div>
      <div class="panel" style="padding:14px">
        <button class="btn ghost wide" id="reset" style="color:var(--bad)">清空全部学习进度</button>
      </div>

      <div class="section-title">关于</div>
      <div class="panel" style="padding:14px">
        <div class="field"><span class="fl">词库总量</span><span>${S.words.length} 条</span></div>
        <div class="field"><span class="fl">例句总数</span><span>${S.words.reduce((a, w) => a + w.ex.length, 0)} 条</span></div>
        <div class="field"><span class="fl">数据版本</span><span>${esc(S.manifest?.generated || "-")}</span></div>
        <div class="fd" style="padding:10px 0">
          词库来自你的 PDF 词表，读音经 JMdict 与 OpenJLPT 校验；
          例句、中文释义保留原始出处。
        </div>
      </div>
    `;

    const bind = (id, fn) => { const el = byId(id); if (el) el.onchange = fn; };
    bind("planByDeadline", (e) => { s.planByDeadline = e.target.checked; saveSettings(); rebuild(false, false); });
    bind("deadline", (e) => { s.deadline = e.target.value; saveSettings(); rebuild(false, false); });
    bind("newPerDay", (e) => { s.newPerDay = Math.max(0, +e.target.value || 0); saveSettings(); rebuild(false, false); });
    bind("maxReview", (e) => { s.maxReview = Math.max(20, +e.target.value || 200); saveSettings(); });
    bind("cardMode", (e) => { s.cardMode = e.target.value; saveSettings(); });
    bind("showReading", (e) => { s.showReading = e.target.value; saveSettings(); render(); });
    bind("preview", (e) => { s.preview = e.target.checked; saveSettings(); });
    main.querySelectorAll("[data-lvl]").forEach((cb) => cb.onchange = () => {
      const on = [...main.querySelectorAll("[data-lvl]")].filter((x) => x.checked).map((x) => x.dataset.lvl);
      s.levels = on.length ? on : ["N2"];
      saveSettings(); rebuild(false);
    });

    byId("export").onclick = () => {
      const blob = new Blob([JSON.stringify({ v: 1, exported: new Date().toISOString(), log: S.log }, null, 1)],
        { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `jlpt-progress-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("已导出");
    };
    byId("importFile").onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const obj = JSON.parse(r.result);
          const incoming = Array.isArray(obj) ? obj : obj.log;
          if (!Array.isArray(incoming)) throw new Error("格式不对");
          const seen = new Set(S.log.map((x) => x[0] + ":" + x[2] + ":" + x[1]));
          let added = 0;
          for (const ev of incoming) {
            if (!Array.isArray(ev) || ev.length < 3) continue;
            const sig = ev[0] + ":" + ev[2] + ":" + ev[1];
            if (seen.has(sig)) continue;
            S.log.push([ev[0], ev[1], ev[2]]);
            seen.add(sig);
            added++;
          }
          S.log.sort((a, b) => a[2] - b[2]);
          saveLog();
          S.cards = replay(S.log);
          rebuild(false);
          toast(`合并完成，新增 ${added} 条记录`);
        } catch (err) { toast("导入失败：" + err.message); }
      };
      r.readAsText(f);
    };
    byId("reset").onclick = () => {
      if (!confirm("确定清空全部学习进度？此操作不可撤销。建议先导出备份。")) return;
      S.log = []; S.cards = new Map(); saveLog(); rebuild(true);
      toast("已清空");
    };
  }

  /* ------------------------------------------------------------ boot */
  async function boot() {
    document.querySelectorAll(".tab").forEach((t) => {
      t.onclick = () => { S.view = t.dataset.view; render(); window.scrollTo(0, 0); };
    });
    S.settings = loadSettings();
    S.log = loadLog();
    try {
      const [w, m] = await Promise.all([
        fetch(`data/words.json?v=${DATA_V}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch(`data/manifest.json?v=${DATA_V}`).then((r) => r.json()),
      ]);
      S.words = w.words;
      S.manifest = m;
    } catch (e) {
      byId("main").innerHTML = `<div class="empty"><div class="big">⚠️</div>
        <div>词库加载失败</div><div class="hint">${esc(e.message)}</div>
        <div class="hint">如果是首次离线打开，请先联网加载一次。</div></div>`;
      return;
    }
    S.words.forEach((w) => S.byKey.set(keyOf(w), w));
    S.cards = replay(S.log);
    rebuild(true, true);

    // keyboard shortcuts (desktop / iPad with keyboard)
    addEventListener("keydown", (e) => {
      if (S.view !== "study") return;
      if (e.target.tagName === "INPUT") return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (S.queue[S.qi]) { S.flipped = !S.flipped; render(); }
      } else if (S.flipped && "1234".includes(e.key)) {
        grade(+e.key - 1);
      }
    });

    // swipe on the card
    let sx = 0, sy = 0, tracking = false;
    document.addEventListener("touchstart", (e) => {
      if (S.view !== "study" || e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    document.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 55 || Math.abs(dy) > Math.abs(dx)) return;
      if (!S.flipped) { S.flipped = true; render(); return; }
      grade(dx < 0 ? 0 : 2);
    }, { passive: true });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    addEventListener("beforeunload", saveLog);
    document.addEventListener("visibilitychange", () => { if (document.hidden) saveLog(); });
  }

  boot();
})();

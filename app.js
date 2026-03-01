import { modules, phrasesById, getModuleById, phrases } from "./data.js";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = "phraseofun_state_v1";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const st = JSON.parse(raw);
    return {
      xp: Number(st.xp || 0),
      completed: st.completed || {},
      favorites: st.favorites || [],
      streak: st.streak || { count: 0, lastDate: null },
      settings: st.settings || { sync: true },
      meta: st.meta || { updatedAt: 0, lastSyncAt: null },
    };
  } catch {
    return {
      xp: 0,
      completed: {},
      favorites: [],
      streak: { count: 0, lastDate: null },
      settings: { sync: true },
      meta: { updatedAt: 0, lastSyncAt: null },
    };
  }
}

function saveState({ skipSync = false } = {}) {
  state.meta = state.meta || { updatedAt: 0, lastSyncAt: null };
  state.meta.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  // $("#pill-xp").textContent = `XP: ${state.xp}`;
  if (!skipSync) queueSync();
}

let state = normalizeState(loadState());
saveState({ skipSync: true });

function xpToLevel(xp) {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function setActiveNav(route) {
  $$("#nav a").forEach(a => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isIOS() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

/* ---------- Supabase auth + sync ---------- */
let sb = null;
let authUser = null;
let authInitDone = false;
let authInitPromise = null;
let authBanner = { type: null, text: "" };
let syncTimer = null;

function normalizeState(st) {
  const base = {
    xp: 0,
    completed: {},
    favorites: [],
    streak: { count: 0, lastDate: null },
    settings: { sync: true },
    meta: { updatedAt: 0, lastSyncAt: null },
  };
  const s = Object.assign({}, base, st || {});
  s.xp = Number(s.xp || 0);
  s.completed = s.completed || {};
  s.favorites = Array.isArray(s.favorites) ? s.favorites : [];
  s.streak = s.streak || { count: 0, lastDate: null };
  s.settings = s.settings || { sync: true };
  s.meta = s.meta || { updatedAt: 0, lastSyncAt: null };
  s.meta.updatedAt = Number(s.meta.updatedAt || 0);
  return s;
}

async function ensureSupabase() {
  if (sb) return sb;
  if (!isSupabaseConfigured()) return null;
  try {
    sb = await getSupabaseClient();
    return sb;
  } catch (e) {
    console.error(e);
    sb = null;
    return null;
  }
}

async function initAuthOnce() {
  if (authInitDone) return;
  if (authInitPromise) return authInitPromise;

  authInitPromise = (async () => {
    const client = await ensureSupabase();
    if (!client) {
      authInitDone = true;
      return;
    }

    try {
      const { data } = await client.auth.getSession();
      authUser = data?.session?.user || null;
    } catch (e) {
      console.error(e);
    }

    client.auth.onAuthStateChange((_event, session) => {
      authUser = session?.user || null;
      if (parseRoute().route === "profile") renderProfile();
      if (authUser && state.settings?.sync) queueSync(true);
    });

    authInitDone = true;
  })();

  await authInitPromise;
  authInitPromise = null;
}

function setAuthBanner(type, text) {
  authBanner = { type, text: text || "" };
  if (parseRoute().route === "profile") {
    const el = document.querySelector("#authBanner");
    if (el) {
      el.className = `alert ${type || ""}`.trim();
      el.style.display = text ? "block" : "none";
      el.textContent = text;
    }
  }
}

function queueSync(immediate = false) {
  if (!state.settings?.sync) return;
  if (!authUser) return;
  if (!isSupabaseConfigured()) return;
  if (!navigator.onLine) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncNow().catch(() => { });
  }, immediate ? 200 : 1200);
}

async function fetchRemoteState() {
  const client = await ensureSupabase();
  if (!client || !authUser) return null;
  const q = client
    .from("student_state")
    .select("state")
    .eq("user_id", authUser.id);

  const resp = q.maybeSingle ? await q.maybeSingle() : await q.single();
  const { data, error } = resp || {};

  if (error) {
    const msg = String(error.message || "").toLowerCase();
    const code = String(error.code || "");
    if (code === "PGRST116" || msg.includes("no rows") || msg.includes("0 rows")) return null;
    throw error;
  }
  return data?.state || null;
}

async function pushRemoteState() {
  const client = await ensureSupabase();
  if (!client || !authUser) return;
  const payload = {
    user_id: authUser.id,
    state: state,
  };
  const { error } = await client
    .from("student_state")
    .upsert(payload, { onConflict: "user_id" });

  if (error) throw error;
  state.meta.lastSyncAt = new Date().toISOString();
  saveState({ skipSync: true });
}

async function reconcileStateAfterLogin() {
  let remote = null;
  try {
    remote = await fetchRemoteState();
  } catch (e) {
    console.error(e);
    setAuthBanner(
      "bad",
      "Вход выполнен, но синхронизация недоступна: проверь таблицу student_state и RLS (см. README)."
    );
    return;
  }

  if (remote) {
    const r = normalizeState(remote);
    const rUpd = Number(r.meta?.updatedAt || 0);
    const lUpd = Number(state.meta?.updatedAt || 0);
    if (rUpd > lUpd) {
      state = r;
      saveState({ skipSync: true });
      setAuthBanner("good", "Прогресс загружен из облака Supabase.");
      render();
      return;
    }
  }

  try {
    await pushRemoteState();
    setAuthBanner("good", "Прогресс синхронизирован с Supabase.");
  } catch (e) {
    console.error(e);
    setAuthBanner("bad", "Не удалось синхронизировать прогресс. Проверь настройки RLS.");
  }
}

async function syncNow() {
  if (!state.settings?.sync) return;
  if (!authUser) return;
  if (!navigator.onLine) return;
  try {
    await pushRemoteState();
    if (parseRoute().route === "profile") renderProfile();
  } catch (e) {
    console.error(e);
    setAuthBanner("bad", "Ошибка синхронизации. Проверь интернет и RLS.");
  }
}

/* ---------- PWA install + SW ---------- */
let deferredPrompt = null;
const installBtn = document.querySelector("#installBtn");
const banner = document.querySelector("#top-banner");

if (isIOS() && !isStandalone()) {
  installBtn.classList.add("show");

  installBtn.addEventListener("click", () => {
    banner.classList.add("show");
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  console.log("Браузер готов к установке PWA");
  deferredPrompt = e;
  installBtn.classList.add("show");
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.classList.remove("show");
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  alert("Приложение установлено!");
  installBtn.classList.remove("show");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      // ignore in dev
    }
  });
}

/* ---------- Router ---------- */
function parseRoute() {
  const hash = location.hash || "#/modules";
  const parts = hash.replace(/^#\//, "").split("/").filter(Boolean);
  const route = parts[0] || "modules";
  const param = parts[1] || null;
  return { route, param };
}

window.addEventListener("hashchange", render);
window.addEventListener("load", () => {
  if (!location.hash) location.hash = "#/modules";
  render();

  if (isSupabaseConfigured() && navigator.onLine) {
    initAuthOnce().catch(() => { });
  }
});

/* ---------- Views ---------- */
function render() {
  const { route, param } = parseRoute();
  if (route === "modules") return renderModules();
  if (route === "module") return renderModule(param);
  if (route === "practice") return renderPractice(param);
  if (route === "profile") return renderProfile();
  if (route === "about") return renderAbout();
  renderNotFound();
}

function renderModules() {
  setActiveNav("modules");
  const app = $("#app");
  const grades = uniq(modules.map(m => m.grade).filter(Boolean));
  const levels = uniq(modules.map(m => m.level).filter(Boolean));

  app.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="stats">
          <!-- Модули -->
          <div class="stat">
            <div class="stat-icon">
              <!-- document.svg (inline) -->
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3h6l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>
                <path d="M14 3v5h5"/>
                <path d="M9 12h6"/>
                <path d="M9 16h6"/>
              </svg>
            </div>
            <div class="stat-text">${modules.length}</div>
            <div class="stat-text">Модулей</div>
          </div>

          <!-- Фразы -->
          <div class="stat">
            <div class="stat-icon">
              <!-- quotes.svg (inline) -->
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 17H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4v8a3 3 0 0 1-2 3z"/>
                <path d="M21 17h-2a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4v8a3 3 0 0 1-2 3z"/>
              </svg>
            </div>
            <div class="stat-text">${phrases.length}</div>
            <div class="stat-text">Фраз</div>
          </div>

          <!-- Уровни -->
          <div class="stat">
            <div class="stat-icon">
              <!-- star.svg (inline) -->
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2l3.1 6.5 7.2 1-5.2 5 1.3 7.1L12 18.8 5.6 21.6l1.3-7.1-5.2-5 7.2-1L12 2z"/>
              </svg>
            </div>
            <div class="stat-text">${levels.length}</div>
            <div class="stat-text">Уровней</div>
          </div>
        </div>

        <div class="controls">
          <input id="q" placeholder="Поиск по теме…" />
          <div class="select-wrap">
            <select id="level" class="select">
              <option value="">Все уровни</option>
              ${levels.map(l => `<option value="${htmlEscape(l)}">${htmlEscape(l)}</option>`).join("")}
            </select>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="list" id="list"></div>
      </section>
    </div>
  `;

  const q = $("#q");
  const gradeSel = $("#grade");
  const levelSel = $("#level");
  const list = $("#list");

  function renderList() {
    const term = q.value.trim().toLowerCase();
    // const g = gradeSel.value;
    const l = levelSel.value;

    const filtered = modules.filter(m => {
      // if (g && m.grade !== g) return false;
      if (l && m.level !== l) return false;
      if (term && !m.title.toLowerCase().includes(term)) return false;
      return true;
    });

    list.innerHTML = filtered.map(m => {
      const done = state.completed[m.id]?.done ? true : false;
      const best = state.completed[m.id]?.best ?? 0;
      const pct = clamp(best, 0, 100);
      const bar = `<div class="progress" title="Лучший результат: ${pct}%"><div style="width:${pct}%"></div></div>`;
      return `
        <div class="module">
          <div>
            <div class="row" style="gap:8px; margin-bottom:6px">
              <span class="badge accent">${htmlEscape(m.grade)} класс</span>
              <span class="badge">${htmlEscape(m.level)}</span>
              ${done ? `<span class="badge good">Завершён</span>` : ``}
            </div>
            <p class="title">${htmlEscape(m.title)}</p>
            <p class="desc">${htmlEscape((m.context || "").slice(0, 110))}${m.context?.length > 110 ? "…" : ""}</p>
          </div>
          <div class="right">
            ${bar}
            <a class="btn" href="#/module/${m.id}">Открыть</a>
          </div>
        </div>
      `;
    }).join("") || `<div class="meta">Ничего не найдено.</div>`;
  }

  q.addEventListener("input", renderList);
  // gradeSel.addEventListener("change", renderList);
  levelSel.addEventListener("change", renderList);
  renderList();
}

function renderModule(id) {
  setActiveNav("modules");
  const app = $("#app");
  const m = getModuleById(id);
  if (!m) {
    app.innerHTML = `<div class="card"><h2>Модуль не найден</h2><a class="btn" href="#/modules">Назад</a></div>`;
    return;
  }

  const done = state.completed[m.id]?.done ? true : false;
  const best = state.completed[m.id]?.best ?? 0;

  const phraseCards = m.phraseIds.map(pid => {
    const p = phrasesById[pid];
    if (!p) return "";
    const fav = state.favorites.includes(pid);
    return `
      <div class="phrase">
        <div style="flex:1">
          <div class="en">${htmlEscape(p.en)}</div>
          <div class="ru">${htmlEscape(p.ru || "—")}</div>
        </div>
        <div class="star ${fav ? "on" : ""}" data-id="${pid}" title="В избранное">${fav ? "★" : "☆"}</div>
      </div>
    `;
  }).join("");

  app.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="row">
          <a class="btn secondary" href="#/modules">← К модулям</a>
          <span class="badge accent">${htmlEscape(m.grade)} класс</span>
          <span class="badge">${htmlEscape(m.level)}</span>
          ${done ? `<span class="badge good">Завершён • лучший ${best}%</span>` : `<span class="badge">Лучший результат: ${best}%</span>`}
          <span style="margin-left:auto"></span>
          <a class="btn" href="#/practice/${m.id}">Начать</a>
        </div>
        <h2 style="margin-top:12px">${htmlEscape(m.title)}</h2>
        <div class="meta">${htmlEscape(m.context || "")}</div>
      </section>

      <section class="card">
        <h2>Ключевые фразы</h2>
        <div class="phrases">${phraseCards || `<div class="meta">В этом модуле нет списка фраз.</div>`}</div>
      </section>
    </div>
  `;

  $$(".star").forEach(el => {
    el.addEventListener("click", () => {
      const pid = el.dataset.id;
      const idx = state.favorites.indexOf(pid);
      if (idx >= 0) state.favorites.splice(idx, 1);
      else state.favorites.push(pid);
      saveState();
      el.classList.toggle("on");
      el.textContent = el.classList.contains("on") ? "★" : "☆";
    });
  });
}

function renderPractice(id) {
  setActiveNav("modules");
  const app = $("#app");
  const m = getModuleById(id);
  if (!m) {
    app.innerHTML = `<div class="card"><h2>Модуль не найден</h2><a class="btn" href="#/modules">Назад</a></div>`;
    return;
  }

  const pool = m.phraseIds.filter(pid => phrasesById[pid]);
  const take = shuffle(pool).slice(0, Math.min(10, pool.length));
  if (take.length < 4) {
    app.innerHTML = `
      <div class="card">
        <a class="btn secondary" href="#/module/${m.id}">← Назад</a>
        <h2 style="margin-top:12px">Практика</h2>
        <div class="meta">Недостаточно фраз для квиза (нужно хотя бы 4).</div>
      </div>`;
    return;
  }

  const allRu = phrases.map(p => p.ru).filter(Boolean);
  const questions = take.map(pid => {
    const p = phrasesById[pid];
    const correct = p.ru || "";
    const distractors = shuffle(allRu.filter(x => x && x !== correct)).slice(0, 3);
    const options = shuffle([correct, ...distractors]);
    return { pid, prompt: p.en, correct, options };
  });

  let idx = 0;
  let correctCount = 0;
  let locked = false;

  function renderQ() {
    const q = questions[idx];
    const progress = `${idx + 1} / ${questions.length}`;
    app.innerHTML = `
      <div class="grid">
        <section class="card">
          <div class="row">
            <a class="btn secondary" href="#/module/${m.id}">← Назад к модулю</a>
            <span class="badge">${htmlEscape(m.level)}</span>
            <span class="badge accent">${htmlEscape(m.grade)} класс</span>
            <span style="margin-left:auto" class="meta">${progress}</span>
          </div>
          <h2 style="margin-top:12px">Практика: выбери перевод</h2>
          <div class="quiz" style="margin-top:10px">
            <div class="qprompt">${htmlEscape(q.prompt)}</div>
            <div id="opts" class="quiz">
              ${q.options.map((opt, i) => `
                <div class="option" data-opt="${htmlEscape(opt)}">
                  <div class="badge">${String.fromCharCode(65 + i)}</div>
                  <div>${htmlEscape(opt || "—")}</div>
                </div>`).join("")}
            </div>
            <div class="row" style="margin-top:8px">
              <span class="meta">Правильных: ${correctCount}</span>
              <span style="margin-left:auto"></span>
              <button id="skip" class="btn secondary" type="button">Пропустить</button>
            </div>
          </div>
        </section>
      </div>
    `;


    $("#skip").addEventListener("click", () => {
      if (locked) return;
      next();
    });

    $$(".option").forEach(el => {
      el.addEventListener("click", () => {
        if (locked) return;
        locked = true;
        const picked = el.dataset.opt || "";
        const isRight = picked === q.correct;
        if (isRight) correctCount++;

        $$(".option").forEach(o => {
          const opt = o.dataset.opt || "";
          if (opt === q.correct) o.classList.add("correct");
          if (opt === picked && !isRight) o.classList.add("wrong");
        });

        setTimeout(() => next(), 600);
      });
    });
  }

  function next() {
    locked = false;
    idx++;
    if (idx >= questions.length) {
      finish();
    } else {
      renderQ();
    }
  }

  function finish() {
    const score = Math.round((correctCount / questions.length) * 100);
    const earned = correctCount * 10;

    const t = todayISO();
    if (state.streak.lastDate === t) {
      // ничего не делаем
    } else {
      const last = state.streak.lastDate ? new Date(state.streak.lastDate) : null;
      const now = new Date(t);
      const diffDays = last ? Math.round((now - last) / (24 * 3600 * 1000)) : 999;
      if (diffDays === 1) state.streak.count = (state.streak.count || 0) + 1;
      else state.streak.count = 1;
      state.streak.lastDate = t;
    }

    state.xp += earned;
    state.completed[m.id] = {
      done: score >= 70,
      best: Math.max(state.completed[m.id]?.best ?? 0, score),
      lastScore: score,
      lastAt: Date.now()
    };
    saveState();

    app.innerHTML = `
      <div class="grid">
        <section class="card">
          <div class="row">
            <a class="btn secondary" href="#/module/${m.id}">← Назад к модулю</a>
            <a class="btn" href="#/modules">К списку модулей</a>
            <span style="margin-left:auto" class="badge good">+${earned} XP</span>
          </div>
          <h2 style="margin-top:12px">Результат</h2>
          <div class="kpi" style="margin-top:12px">
            <div class="tile">
              <div class="meta">Счёт</div>
              <div class="num">${score}%</div>
            </div>
            <div class="tile">
              <div class="meta">Правильных</div>
              <div class="num">${correctCount}/${questions.length}</div>
            </div>
            <div class="tile">
              <div class="meta">Стрик</div>
              <div class="num">${state.streak.count} 🔥</div>
            </div>
          </div>
          <div class="meta" style="margin-top:10px">
            Модуль считается завершённым при результате ≥ 70%.
          </div>
        </section>
      </div>
    `;
  }

  renderQ();
}

function renderProfile() {
  setActiveNav("profile");
  const app = $("#app");
  const level = xpToLevel(state.xp);
  const doneCount = Object.values(state.completed).filter(x => x?.done).length;
  const total = modules.length;
  const favCount = state.favorites.length;

  const favPhrases = state.favorites.slice(0, 12).map(pid => {
    const p = phrasesById[pid];
    if (!p) return "";
    return `<div class="phrase">
      <div style="flex:1">
        <div class="en">${htmlEscape(p.en)}</div>
        <div class="ru">${htmlEscape(p.ru || "—")}</div>
      </div>
      <div class="star on" data-id="${pid}">★</div>
    </div>`;
  }).join("");

  // <div class="tile">
  //   <div class="meta">Стрик</div>
  //   <div class="num">${state.streak.count} 🔥</div>
  // </div>
  app.innerHTML = `
    <div class="grid">
      <section class="card">
        <h2>Аккаунт ученика</h2>
        <div id="authBanner" class="alert ${authBanner.type || ""}" style="display:${authBanner.text ? "block" : "none"}">${htmlEscape(authBanner.text || "")}</div>
        <div id="authBox" class="meta" style="margin-top:10px">Загрузка…</div>
      </section>

      <section class="card">
        <h2>Профиль</h2>
        <div class="kpi" style="margin-top:12px">
          <div class="tile">
            <div class="meta">Уровень</div>
            <div class="num">${level}</div>
          </div>
          <div class="tile">
            <div class="meta">Прогресс</div>
            <div class="num">${state.xp} XP</div>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <span class="badge good">Завершено: ${doneCount}/${total}</span>
          <span class="badge accent">Избранное: ${favCount}</span>
          <span style="margin-left:auto"></span>
          <button id="reset" class="btn secondary" type="button">Сбросить прогресс</button>
        </div>
      </section>

      <section class="card">
        <h2>Избранные фразы</h2>
        <div class="phrases">${favPhrases || `<div class="meta">Пока пусто. Добавляй звёздочкой в модуле.</div>`}</div>
      </section>
    </div>
  `;

  // Вставляем/обновляем UI авторизации (асинхронно)
  renderAuthCard();

  $("#reset").addEventListener("click", () => {
    if (!confirm("Сбросить XP, завершения и избранное?")) return;
    state = normalizeState({ xp: 0, completed: {}, favorites: [], streak: { count: 0, lastDate: null }, settings: state.settings });
    saveState();
    renderProfile();
  });

  $$(".star.on").forEach(el => {
    el.addEventListener("click", () => {
      const pid = el.dataset.id;
      const idx = state.favorites.indexOf(pid);
      if (idx >= 0) state.favorites.splice(idx, 1);
      saveState();
      renderProfile();
    });
  });
}

async function renderAuthCard() {
  const box = $("#authBox");
  if (!box) return;

  if (authBanner?.text) setAuthBanner(authBanner.type, authBanner.text);
  else setAuthBanner(null, "");

  if (!isSupabaseConfigured()) {
    box.innerHTML = `
      <div class="meta">
        Supabase не настроен. Чтобы включить регистрацию/вход:
      </div>
      <ol class="meta" style="margin:8px 0 0; padding-left:18px; line-height:1.6">
        <li>Создай проект в Supabase</li>
        <li>Открой <b>Project Settings → API</b></li>
        <li>В файле <b>supabaseConfig.js</b> заполни <b>SUPABASE_URL</b> и <b>SUPABASE_ANON_KEY</b></li>
        <li>Создай таблицу <b>student_state</b> и включи RLS (SQL есть в README)</li>
      </ol>
    `;
    return;
  }

  box.innerHTML = `<div class="meta">Подключаемся к Supabase…</div>`;
  await initAuthOnce();
  const client = await ensureSupabase();
  if (!client) {
    box.innerHTML = `<div class="alert bad">Не удалось загрузить Supabase SDK. Проверь интернет или блокировку CDN.</div>`;
    return;
  }

  const lastSync = state.meta?.lastSyncAt
    ? new Date(state.meta.lastSyncAt).toLocaleString("ru-RU")
    : "—";

  if (authUser) {
    box.innerHTML = `
      <div class="row" style="justify-content:space-between; align-items:flex-start">
        <div>
          <div class="badge good">Вход выполнен</div>
          <div style="margin-top:8px">
            <div><b>${htmlEscape(authUser.email || "")}</b></div>
            <div class="meta" style="margin-top:4px">Последняя синхронизация: ${htmlEscape(lastSync)}</div>
          </div>
        </div>
        <button id="btnSignOut" class="btn secondary" type="button">Выйти</button>
      </div>

      <div class="form">
        <label class="toggle">
          <input id="syncToggle" type="checkbox" ${state.settings?.sync ? "checked" : ""} />
          <span>Синхронизация прогресса (XP, завершения, избранное)</span>
        </label>

        <div class="actions">
          <button id="btnSyncNow" class="btn" type="button">Синхронизировать сейчас</button>
          <span class="meta">Если отключить — прогресс будет храниться только на устройстве.</span>
        </div>
      </div>
    `;

    $("#btnSignOut").addEventListener("click", async () => {
      try {
        await client.auth.signOut();
        setAuthBanner(null, "");
      } catch (e) {
        console.error(e);
        setAuthBanner("bad", "Не удалось выйти. Попробуй ещё раз.");
      }
    });

    $("#btnSyncNow").addEventListener("click", async () => {
      setAuthBanner(null, "");
      await syncNow();
      setAuthBanner("good", "Синхронизация выполнена.");
      renderProfile();
    });

    $("#syncToggle").addEventListener("change", (e) => {
      state.settings = state.settings || { sync: true };
      state.settings.sync = Boolean(e.target.checked);
      saveState({ skipSync: true });
      if (state.settings.sync) queueSync(true);
    });

    return;
  }

  box.innerHTML = `
    <div class="meta">Войди или зарегистрируйся (email + пароль).</div>
    <div class="form" style="max-width:520px">
      <div class="field">
        <label for="authEmail">Email</label>
        <input id="authEmail" type="email" autocomplete="email" placeholder="name@example.com" />
      </div>
      <div class="field">
        <label for="authPass">Пароль</label>
        <input id="authPass" type="password" autocomplete="current-password" placeholder="минимум 6 символов" />
      </div>
      <div class="actions">
        <button id="btnSignIn" class="btn" type="button">Войти</button>
        <button id="btnSignUp" class="btn secondary" type="button">Регистрация</button>
        <span class="meta">Если включено подтверждение email — после регистрации проверь почту.</span>
      </div>
    </div>
  `;

  const emailEl = $("#authEmail");
  const passEl = $("#authPass");
  const btnIn = $("#btnSignIn");
  const btnUp = $("#btnSignUp");

  function getCreds() {
    const email = (emailEl.value || "").trim();
    const password = passEl.value || "";
    return { email, password };
  }

  async function withBusy(fn) {
    btnIn.disabled = true;
    btnUp.disabled = true;
    try {
      await fn();
    } finally {
      btnIn.disabled = false;
      btnUp.disabled = false;
    }
  }

  btnIn.addEventListener("click", () => withBusy(async () => {
    setAuthBanner(null, "");
    const { email, password } = getCreds();
    if (!email || password.length < 6) {
      setAuthBanner("bad", "Укажи email и пароль (минимум 6 символов).");
      return;
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      setAuthBanner("bad", error.message || "Ошибка входа");
      return;
    }
    setAuthBanner("good", "Вход выполнен.");
    await reconcileStateAfterLogin();
    renderProfile();
  }));

  btnUp.addEventListener("click", () => withBusy(async () => {
    setAuthBanner(null, "");
    const { email, password } = getCreds();
    if (!email || password.length < 6) {
      setAuthBanner("bad", "Укажи email и пароль (минимум 6 символов).");
      return;
    }

    const { data, error } = await client.auth.signUp({ email, password });
    if (error) {
      setAuthBanner("bad", error.message || "Ошибка регистрации");
      return;
    }

    if (!data?.session) {
      setAuthBanner("good", "Регистрация успешна. Подтверди email в письме и затем войди.");
      return;
    }

    setAuthBanner("good", "Регистрация успешна. Выполнен вход.");
    await reconcileStateAfterLogin();
    renderProfile();
  }));
}

function renderAbout() {
  setActiveNav("about");
  const app = $("#app");
  app.innerHTML = `
    <div class="grid">
      <section class="card">
        <h2>О проекте</h2>
        <div class="meta">
          Это чистый PWA на HTML/CSS/JavaScript (без Expo и без фреймворков).
          Прогресс хранится в localStorage. Приложение работает офлайн благодаря service worker.
        </div>
        <div class="row" style="margin-top:12px">
          <span class="badge">Контент: ${modules.length} модулей</span>
          <span class="badge">Фразы: ${phrases.length}</span>
          <span style="margin-left:auto"></span>
          <a class="btn" href="#/modules">Начать</a>
        </div>
        <div class="meta" style="margin-top:10px">
          Чтобы PWA устанавливалось, открывай через <b>http://localhost</b> или через HTTPS.
        </div>
      </section>
    </div>
  `;
}

function renderNotFound() {
  const app = $("#app");
  app.innerHTML = `<div class="card"><h2>Страница не найдена</h2><a class="btn" href="#/modules">На главную</a></div>`;
}

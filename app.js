import { loadContent, loadStaticContent, refreshFromSupabase } from "./contentService.js";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STORAGE_KEY = "phraseofun_state_v1";

let content = {
  modules: [],
  phrases: [],
  phrasesById: {},
  moduleById: {},
};

let state = normalizeState(loadState());
let sb = null;
let authUser = null;
let authInitDone = false;
let authInitPromise = null;
let authBanner = { type: null, text: "" };
let syncTimer = null;
let isAdminUser = false;

const adminState = {
  selectedModuleId: null,
  selectedPhraseId: null,
};

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

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

function xpToLevel(xp) {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function isIOS() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const st = JSON.parse(raw);
    return {
      xp: Number(st.xp || 0),
      completed: st.completed || {},
      favorites: Array.isArray(st.favorites) ? st.favorites : [],
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

function saveState({ skipSync = false } = {}) {
  state.meta = state.meta || { updatedAt: 0, lastSyncAt: null };
  state.meta.updatedAt = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!skipSync) queueSync();
}

saveState({ skipSync: true });

function setActiveNav(route) {
  $$("#nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

function parseRoute() {
  const hash = location.hash || "#/modules";
  const parts = hash.replace(/^#\//, "").split("/").filter(Boolean);
  const route = parts[0] || "modules";
  const param = parts[1] || null;
  return { route, param };
}

function renderNav() {
  const nav = $("#nav");
  if (!nav) return;

  nav.innerHTML = `
    <a href="#/modules" data-route="modules">Модули</a>
    <a href="#/profile" data-route="profile">Профиль</a>
    ${isAdminUser ? `<a href="#/admin" data-route="admin">Админ</a>` : ""}
    ${isAdminUser ? `<a href="#/admin-users" data-route="admin-users">Пользователи</a>` : ""}
  `;
}

/* ---------- Supabase auth + sync ---------- */

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

async function fetchAdminUsers() {
  const client = await ensureSupabase();
  if (!client) throw new Error("Supabase не настроен");

  const { data: profiles, error: profilesError } = await client
    .from("profiles")
    .select("id, email, full_name, created_at")
    .order("created_at", { ascending: false });

  if (profilesError) throw profilesError;

  const { data: roles, error: rolesError } = await client
    .from("app_roles")
    .select("user_id, role");

  if (rolesError) throw rolesError;

  const roleMap = new Map((roles || []).map((r) => [r.user_id, r.role]));

  return (profiles || []).map((p) => ({
    ...p,
    role: roleMap.get(p.id) || "student",
  }));
}

async function loadUserRole() {
  isAdminUser = false;

  const client = await ensureSupabase();
  if (!client || !authUser) return;

  const { data, error } = await client
    .from("app_roles")
    .select("role")
    .eq("user_id", authUser.id)
    .maybeSingle();

  if (!error && data?.role === "admin") {
    isAdminUser = true;
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
      await loadUserRole();
    } catch (e) {
      console.error(e);
    }

    client.auth.onAuthStateChange((_event, session) => {
      (async () => {
        authUser = session?.user || null;
        await loadUserRole();

        if (authUser && state.settings?.sync) {
          queueSync(true);
        }

        const currentRoute = parseRoute().route;

        if (currentRoute === "admin" && !isAdminUser) {
          location.hash = "#/profile";
          return;
        }

        render();
      })().catch(console.error);
    });

    authInitDone = true;
  })();

  await authInitPromise;
  authInitPromise = null;
}

function setAuthBanner(type, text) {
  authBanner = { type, text: text || "" };

  if (parseRoute().route === "profile") {
    const el = $("#authBanner");
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

    if (code === "PGRST116" || msg.includes("no rows") || msg.includes("0 rows")) {
      return null;
    }

    throw error;
  }

  return data?.state || null;
}

async function pushRemoteState() {
  const client = await ensureSupabase();
  if (!client || !authUser) return;

  const payload = {
    user_id: authUser.id,
    state,
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
      "Вход выполнен, но синхронизация недоступна: проверь таблицу student_state и RLS."
    );
    await loadUserRole();
    render();
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
      await loadUserRole();
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

  await loadUserRole();
  render();
}

async function syncNow() {
  if (!state.settings?.sync) return;
  if (!authUser) return;
  if (!navigator.onLine) return;

  try {
    await pushRemoteState();

    if (parseRoute().route === "profile") {
      renderProfile();
    }
  } catch (e) {
    console.error(e);
    setAuthBanner("bad", "Ошибка синхронизации. Проверь интернет и RLS.");
  }
}

/* ---------- Admin helpers ---------- */

function adminNotify(message) {
  alert(message);
}

function nextTextId(items, prefix, pad = 2) {
  const maxNum = items.reduce((max, item) => {
    const raw = String(item?.id ?? "");
    const m = raw.match(new RegExp(`^${prefix}(\\d+)$`, "i"));
    if (!m) return max;
    return Math.max(max, Number(m[1]));
  }, 0);

  return `${prefix}${String(maxNum + 1).padStart(pad, "0")}`;
}

async function reloadContentAndKeepAdminSelection() {
  content = await loadContent();

  if (
    adminState.selectedModuleId &&
    !content.moduleById[adminState.selectedModuleId]
  ) {
    adminState.selectedModuleId = content.modules[0]?.id ?? null;
  }

  if (
    adminState.selectedPhraseId &&
    !content.phrasesById[adminState.selectedPhraseId]
  ) {
    adminState.selectedPhraseId = content.phrases[0]?.id ?? null;
  }
}

async function upsertModule(moduleData) {
  const client = await ensureSupabase();
  if (!client) throw new Error("Supabase не настроен");

  const payload = {
    id: String(moduleData.id).trim(),
    title: String(moduleData.title).trim(),
    grade: String(moduleData.grade).trim(),
    level: String(moduleData.level).trim(),
    context: String(moduleData.context || "").trim() || null,
    sort_order: Number(moduleData.sort_order || 0),
    is_published: Boolean(moduleData.is_published),
  };

  const { error } = await client
    .from("modules")
    .upsert(payload, { onConflict: "id" });

  if (error) throw error;
}

async function upsertPhrase(phraseData) {
  const client = await ensureSupabase();
  if (!client) throw new Error("Supabase не настроен");

  const payload = {
    id: String(phraseData.id).trim(),
    en: String(phraseData.en).trim(),
    ru: String(phraseData.ru).trim(),
    image_url: String(phraseData.image_url || "").trim() || null,
    sort_order: Number(phraseData.sort_order || 0),
    is_published: Boolean(phraseData.is_published),
  };

  const { error } = await client
    .from("phrases")
    .upsert(payload, { onConflict: "id" });

  if (error) throw error;
}

async function replaceModulePhrases(moduleId, phraseIds) {
  const client = await ensureSupabase();
  if (!client) throw new Error("Supabase не настроен");

  const { error: deleteError } = await client
    .from("module_phrases")
    .delete()
    .eq("module_id", moduleId);

  if (deleteError) throw deleteError;

  const rows = phraseIds.map((phraseId, index) => ({
    module_id: moduleId,
    phrase_id: phraseId,
    sort_order: index + 1,
  }));

  if (rows.length > 0) {
    const { error: insertError } = await client
      .from("module_phrases")
      .insert(rows);

    if (insertError) throw insertError;
  }
}

/* ---------- PWA install + SW ---------- */

let deferredPrompt = null;
const installBtn = $("#installBtn");
const banner = $("#top-banner");

if (installBtn) {
  if (isIOS() && !isStandalone()) {
    installBtn.classList.add("show");

    installBtn.addEventListener("click", () => {
      if (banner) banner.classList.add("show");
    });
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
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
    installBtn.classList.remove("show");
    alert("Приложение установлено!");
  });
}

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

window.addEventListener("hashchange", () => {
  render();
});

window.addEventListener("online", () => {
  queueSync(true);
});

async function initApp() {
  // 1. Мгновенно: статика или localStorage-кэш
  try {
    content = await loadContent();
  } catch (e) {
    content = loadStaticContent();
  }

  if (!location.hash) {
    location.hash = "#/modules";
  }

  // 2. Рендер сразу — пользователь видит модули без задержки
  render();

  // 3. Параллельно: Supabase SDK + auth + свежие данные
  refreshFromSupabase((fresh) => {
    content = fresh;
    render(); // обновить UI когда Supabase ответил
  });

  initAuthOnce().then(() => {
    loadUserRole().then(() => {
      renderNav();
    });
  });
}

initApp();

/* ---------- Views ---------- */

function render() {
  renderNav();

  const { route, param } = parseRoute();

  if (route === "modules") return renderModules();
  if (route === "module") return renderModule(param);
  if (route === "practice") return renderPractice(param);
  if (route === "profile") return renderProfile();
  if (route === "about") return renderAbout();
  if (route === "admin") return renderAdmin();
  if (route === "admin-users") return renderAdminUsers();

  renderNotFound();
}

function renderModules() {
  setActiveNav("modules");

  const app = $("#app");
  if (!app) return;

  // Скелетон пока контент не загружен
  if (!content.modules.length) {
    app.innerHTML = `
      <div class="grid">
        <section class="card">
          <div class="skeleton skeleton-line" style="width:60%;height:20px;margin-bottom:12px"></div>
          <div class="skeleton skeleton-line" style="width:100%;height:36px;margin-bottom:8px"></div>
          <div class="skeleton skeleton-line" style="width:100%;height:36px"></div>
        </section>
        <section class="card">
          ${[1, 2, 3, 4].map(() => `
            <div class="skeleton-module">
              <div class="skeleton skeleton-line" style="width:40%;height:14px;margin-bottom:8px"></div>
              <div class="skeleton skeleton-line" style="width:85%;height:18px;margin-bottom:6px"></div>
              <div class="skeleton skeleton-line" style="width:70%;height:13px"></div>
            </div>`).join("")}
        </section>
      </div>`;
    return;
  }

  const levels = uniq(content.modules.map((m) => m.level).filter(Boolean));

  app.innerHTML = `
    <div class="grid">
      <section class="card">
        <div class="stats">
          <div class="stat">
            <div class="stat-icon">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3h6l4 4v14H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>
                <path d="M14 3v5h5"/>
                <path d="M9 12h6"/>
                <path d="M9 16h6"/>
              </svg>
            </div>
            <div class="stat-text">${content.modules.length}</div>
            <div class="stat-text">Модулей</div>
          </div>

          <div class="stat">
            <div class="stat-icon">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round">
                <path d="M7 17H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4v8a3 3 0 0 1-2 3z"/>
                <path d="M21 17h-2a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4v8a3 3 0 0 1-2 3z"/>
              </svg>
            </div>
            <div class="stat-text">${content.phrases.length}</div>
            <div class="stat-text">Фраз</div>
          </div>

          <div class="stat">
            <div class="stat-icon">
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
              ${levels.map((l) => `<option value="${htmlEscape(l)}">${htmlEscape(l)}</option>`).join("")}
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
  const levelSel = $("#level");
  const list = $("#list");

  function renderList() {
    const term = (q?.value || "").trim().toLowerCase();
    const l = levelSel?.value || "";

    const filtered = content.modules.filter((m) => {
      if (l && m.level !== l) return false;
      if (term && !String(m.title || "").toLowerCase().includes(term)) return false;
      return true;
    });

    list.innerHTML = filtered.map((m) => {
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

  q?.addEventListener("input", renderList);
  levelSel?.addEventListener("change", renderList);

  renderList();
}

function renderModule(id) {
  setActiveNav("modules");

  const app = $("#app");
  if (!app) return;

  const m = content.moduleById[id];

  if (!m) {
    app.innerHTML = `<div class="card"><h2>Модуль не найден</h2><a class="btn" href="#/modules">Назад</a></div>`;
    return;
  }

  const done = state.completed[m.id]?.done ? true : false;
  const best = state.completed[m.id]?.best ?? 0;

  const phraseCards = (m.phraseIds || []).map((pid) => {
    const p = content.phrasesById[pid];
    if (!p) return "";

    const fav = state.favorites.includes(pid);

    return `
      <div class="phrase">
        ${p.image_url ? `<img class="phrase-img" src="${htmlEscape(p.image_url)}" alt="${htmlEscape(p.en)}" loading="lazy" />` : ""}
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

  $$(".star").forEach((el) => {
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
  if (!app) return;

  const m = content.moduleById[id];
  if (!m) {
    app.innerHTML = `<div class="card"><h2>Модуль не найден</h2><a class="btn" href="#/modules">Назад</a></div>`;
    return;
  }

  // ── Structured exercises (if available for this module) ──────────────────
  const exList = (content.exercises || {})[id];
  if (exList && exList.length > 0) {
    let idx = 0;
    let correctCount = 0;

    function advance(wasCorrect) {
      if (wasCorrect) correctCount++;
      idx++;
      if (idx >= exList.length) {
        const lastBadge = [...exList].reverse().find((e) => e.badge)?.badge || null;
        finishPractice(m, correctCount, exList.length, lastBadge);
      } else {
        showEx();
      }
    }

    function showEx() {
      const ex = exList[idx];
      const progress = `${idx + 1} / ${exList.length}`;
      const navRow = `
        <div class="row">
          <a class="btn secondary" href="#/module/${htmlEscape(m.id)}">← Назад</a>
          <span class="badge">${htmlEscape(m.level)}</span>
          <span class="badge accent">${htmlEscape(m.grade)} класс</span>
          <span style="margin-left:auto" class="meta">${progress}</span>
        </div>`;
      dispatchExercise(app, ex, navRow, advance);
    }

    showEx();
    return;
  }

  // ── Dynamic quiz (fallback for modules without structured exercises) ──────
  const pool = (m.phraseIds || []).filter((pid) => content.phrasesById[pid]);
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

  const allRu = content.phrases.map((p) => p.ru).filter(Boolean);
  const allEn = content.phrases.map((p) => p.en).filter(Boolean);
  const modulePhrasesWithImages = pool.map((pid) => content.phrasesById[pid]).filter((p) => p && p.image_url);

  const questions = take.map((pid) => {
    const p = content.phrasesById[pid];
    const roll = Math.random();
    const canImg = Boolean(p.image_url);
    const canImgOpts = canImg && modulePhrasesWithImages.length >= 4;

    if (canImgOpts && roll < 0.33) {
      const correctImg = p.image_url;
      const distractors = shuffle(modulePhrasesWithImages.filter((x) => x.image_url !== correctImg).map((x) => x.image_url)).slice(0, 3);
      return { pid, type: "img_options", prompt: p.en, hint: p.ru, correct: correctImg, options: shuffle([correctImg, ...distractors]) };
    } else if (canImg && roll < 0.66) {
      const correct = p.en;
      const distractors = shuffle(allEn.filter((x) => x && x !== correct)).slice(0, 3);
      return { pid, type: "img_prompt", image_url: p.image_url, prompt: p.ru, correct, options: shuffle([correct, ...distractors]) };
    } else {
      const correct = p.ru || "";
      const distractors = shuffle(allRu.filter((x) => x && x !== correct)).slice(0, 3);
      return { pid, type: "text", prompt: p.en, correct, options: shuffle([correct, ...distractors]) };
    }
  });

  let qIdx = 0;
  let qCorrect = 0;
  let locked = false;

  function renderQ() {
    const q = questions[qIdx];
    const progress = `${qIdx + 1} / ${questions.length}`;
    const heading = q.type === "img_options" ? "Выбери картинку к фразе"
      : q.type === "img_prompt" ? "Выбери фразу по картинке" : "Выбери перевод";

    const promptHtml = q.type === "img_options"
      ? `<div class="qprompt"><div>${htmlEscape(q.prompt)}</div><div class="qimg-hint" style="margin-top:4px">${htmlEscape(q.hint)}</div></div>`
      : q.type === "img_prompt"
        ? `<div class="qimg-wrap"><img class="qimg" src="${htmlEscape(q.image_url)}" alt="?" loading="lazy" /><div class="qimg-hint">${htmlEscape(q.prompt)}</div></div>`
        : `<div class="qprompt">${htmlEscape(q.prompt)}</div>`;

    const optsHtml = q.type === "img_options"
      ? `<div id="opts" class="opts-img">${q.options.map((url) => `<div class="option option--img" data-opt="${htmlEscape(url)}"><img src="${htmlEscape(url)}" alt="?" loading="lazy" /></div>`).join("")}</div>`
      : `<div id="opts" class="quiz">${q.options.map((opt, i) => `<div class="option" data-opt="${htmlEscape(opt)}"><div class="badge">${String.fromCharCode(65 + i)}</div><div>${htmlEscape(opt || "—")}</div></div>`).join("")}</div>`;

    app.innerHTML = `
      <div class="grid"><section class="card">
        <div class="row">
          <a class="btn secondary" href="#/module/${m.id}">← Назад к модулю</a>
          <span class="badge">${htmlEscape(m.level)}</span>
          <span class="badge accent">${htmlEscape(m.grade)} класс</span>
          <span style="margin-left:auto" class="meta">${progress}</span>
        </div>
        <h2 style="margin-top:12px">${heading}</h2>
        <div class="quiz" style="margin-top:10px">
          ${promptHtml}${optsHtml}
          <div class="row" style="margin-top:8px">
            <span class="meta">Правильных: ${qCorrect}</span>
            <span style="margin-left:auto"></span>
            <button id="skip" class="btn secondary" type="button">Пропустить</button>
          </div>
        </div>
      </section></div>`;

    $("#skip")?.addEventListener("click", () => { if (!locked) nextQ(); });
    $$(".option").forEach((el) => {
      el.addEventListener("click", () => {
        if (locked) return;
        locked = true;
        const picked = el.dataset.opt || "";
        const isRight = picked === q.correct;
        if (isRight) qCorrect++;
        $$(".option").forEach((o) => {
          if (o.dataset.opt === q.correct) o.classList.add("correct");
          if (o.dataset.opt === picked && !isRight) o.classList.add("wrong");
        });
        setTimeout(() => nextQ(), 600);
      });
    });
  }

  function nextQ() { locked = false; qIdx++; qIdx >= questions.length ? finishPractice(m, qCorrect, questions.length, null) : renderQ(); }
  renderQ();
}

/* ─── Shared finish screen ─────────────────────────────────────────────────── */
function finishPractice(m, correctCount, total, badge) {
  const app = $("#app");
  if (!app) return;

  const score = Math.round((correctCount / total) * 100);
  const earned = correctCount * 10;
  const t = todayISO();

  if (state.streak.lastDate !== t) {
    const last = state.streak.lastDate ? new Date(state.streak.lastDate) : null;
    const diff = last ? Math.round((new Date(t) - last) / 86400000) : 999;
    state.streak.count = diff === 1 ? (state.streak.count || 0) + 1 : 1;
    state.streak.lastDate = t;
  }

  state.xp += earned;
  state.completed[m.id] = {
    done: score >= 70,
    best: Math.max(state.completed[m.id]?.best ?? 0, score),
    lastScore: score,
    lastAt: Date.now(),
  };
  saveState();

  app.innerHTML = `
    <div class="grid"><section class="card">
      <div class="row">
        <a class="btn secondary" href="#/module/${m.id}">← Назад к модулю</a>
        <a class="btn" href="#/modules">К списку модулей</a>
        <span style="margin-left:auto" class="badge good">+${earned} XP</span>
      </div>
      <h2 style="margin-top:12px">Результат</h2>
      ${badge ? `<div class="ex-badge-earned">${htmlEscape(badge)}</div>` : ""}
      <div class="kpi" style="margin-top:12px">
        <div class="tile"><div class="meta">Счёт</div><div class="num">${score}%</div></div>
        <div class="tile"><div class="meta">Правильных</div><div class="num">${correctCount}/${total}</div></div>
        <div class="tile"><div class="meta">Стрик</div><div class="num">${state.streak.count} 🔥</div></div>
      </div>
      <div class="meta" style="margin-top:10px">Модуль считается завершённым при результате ≥ 70%.</div>
    </section></div>`;
}

/* ─── Exercise dispatcher ──────────────────────────────────────────────────── */
function dispatchExercise(app, ex, navRow, advance) {
  switch (ex.type) {
    case "img_options": return exImgOptions(app, ex, navRow, advance);
    case "choice": return exChoice(app, ex, navRow, advance);
    case "ordering": return exOrdering(app, ex, navRow, advance);
    case "fill_blanks": return exFillBlanks(app, ex, navRow, advance);
    case "word_order": return exWordOrder(app, ex, navRow, advance);
    case "word_spelling": return exWordSpelling(app, ex, navRow, advance);
    default: return exChoice(app, ex, navRow, advance);
  }
}

/* ─── choice / img_prompt ──────────────────────────────────────────────────── */
function exChoice(app, ex, navRow, advance) {
  const promptHtml = ex.image_url
    ? `<div class="qimg-wrap"><img class="qimg" src="${htmlEscape(ex.image_url)}" alt="?" loading="lazy" /></div>`
    : ex.prompt ? `<div class="qprompt">${htmlEscape(ex.prompt)}</div>` : "";
  const hintHtml = ex.hint ? `<div class="qimg-hint" style="margin-bottom:4px">${htmlEscape(ex.hint)}</div>` : "";

  const hasImgOpts = ex.options.some((o) => o.image_url);
  const optsHtml = hasImgOpts
    ? `<div class="opts-img opts-img--labeled">
        ${ex.options.map((o) => `
          <div class="option option--img" data-correct="${o.correct}">
            <img src="${htmlEscape(o.image_url || "")}" alt="${htmlEscape(o.text)}" loading="lazy" />
            <div class="opt-label">${htmlEscape(o.text)}</div>
          </div>`).join("")}
       </div>`
    : `<div class="quiz">
        ${ex.options.map((o, i) => `
          <div class="option" data-correct="${o.correct}">
            <div class="badge">${String.fromCharCode(65 + i)}</div>
            <div>${htmlEscape(o.text)}</div>
          </div>`).join("")}
       </div>`;

  app.innerHTML = `<div class="grid"><section class="card">
    ${navRow}
    <h2 style="margin-top:12px">${htmlEscape(ex.heading || "Выбери правильный ответ")}</h2>
    <div class="quiz" style="margin-top:10px">${promptHtml}${hintHtml}${optsHtml}</div>
  </section></div>`;

  let locked = false;
  $$(".option").forEach((el) => {
    el.addEventListener("click", () => {
      if (locked) return;
      locked = true;
      const isRight = el.dataset.correct === "true";
      $$(".option").forEach((o) => {
        if (o.dataset.correct === "true") o.classList.add("correct");
        else if (o === el && !isRight) o.classList.add("wrong");
      });
      setTimeout(() => advance(isRight), 700);
    });
  });
}

/* ─── img_options ──────────────────────────────────────────────────────────── */
function exImgOptions(app, ex, navRow, advance) {
  app.innerHTML = `<div class="grid"><section class="card">
    ${navRow}
    <h2 style="margin-top:12px">${htmlEscape(ex.heading || "Выбери картинку к фразе")}</h2>
    <div class="qprompt" style="margin-top:10px">${htmlEscape(ex.prompt)}</div>
    ${ex.hint ? `<div class="qimg-hint">${htmlEscape(ex.hint)}</div>` : ""}
    <div class="opts-img" style="margin-top:12px">
      ${ex.options.map((o) => `
        <div class="option option--img" data-correct="${o.correct}">
          <img src="${htmlEscape(o.image_url || "")}" alt="${htmlEscape(o.text)}" loading="lazy" />
        </div>`).join("")}
    </div>
  </section></div>`;

  let locked = false;
  $$(".option--img").forEach((el) => {
    el.addEventListener("click", () => {
      if (locked) return;
      locked = true;
      const isRight = el.dataset.correct === "true";
      $$(".option--img").forEach((o) => {
        if (o.dataset.correct === "true") o.classList.add("correct");
        else if (o === el && !isRight) o.classList.add("wrong");
      });
      setTimeout(() => advance(isRight), 700);
    });
  });
}

/* ─── ordering ─────────────────────────────────────────────────────────────── */
function exOrdering(app, ex, navRow, advance) {
  const items = shuffle([...ex.items]);
  const total = items.length;
  let nextNum = 1;
  const assigned = new Map(); // el → number

  const hasImages = items.some((it) => it.image_url);

  function render() {
    app.innerHTML = `<div class="grid"><section class="card">
      ${navRow}
      <h2 style="margin-top:12px">${htmlEscape(ex.heading || "Расставь по порядку")}</h2>
      ${ex.hint ? `<div class="meta" style="margin-bottom:10px">${htmlEscape(ex.hint)}</div>` : ""}
      <div class="ord-grid${hasImages ? " ord-grid--img" : ""}" id="ord-grid">
        ${items.map((it, i) => {
      const num = assigned.get(i);
      return `
            <div class="ord-item${num ? " ord-picked" : ""}" data-order="${it.order}" data-idx="${i}">
              ${it.image_url ? `<img src="${htmlEscape(it.image_url)}" alt="${htmlEscape(it.text)}" loading="lazy" class="ord-img" />` : ""}
              <div class="ord-label">${htmlEscape(it.text)}</div>
              ${num ? `<div class="ord-num">${num}</div>` : ""}
            </div>`;
    }).join("")}
      </div>
    </section></div>`;

    $$(".ord-item").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = Number(el.dataset.idx);
        if (assigned.has(idx)) return;
        assigned.set(idx, nextNum++);
        render();

        if (assigned.size === total) {
          setTimeout(() => {
            let allOk = true;
            $$(".ord-item").forEach((o) => {
              const got = assigned.get(Number(o.dataset.idx));
              const want = Number(o.dataset.order);
              if (got === want) o.classList.add("ord-correct");
              else { o.classList.add("ord-wrong"); allOk = false; }
            });
            setTimeout(() => advance(allOk), 1100);
          }, 200);
        }
      });
    });
  }
  render();
}

/* ─── fill_blanks ──────────────────────────────────────────────────────────── */
function exFillBlanks(app, ex, navRow, advance) {
  const bank = shuffle([...ex.wordBank]);
  const blankNums = Object.keys(ex.blanks).map(Number).sort((a, b) => a - b);
  const filled = {}; // blankNum → { word, bankIdx }

  function buildText() {
    return ex.text.split("\n").map((line) => {
      let l = htmlEscape(line);
      blankNums.forEach((n) => {
        const f = filled[n];
        const cls = f ? "blank-slot blank-filled" : "blank-slot";
        const val = f ? htmlEscape(f.word) : "_____";
        l = l.split(`[${n}]`).join(`<span class="${cls}" data-n="${n}">${val}</span>`);
      });
      return `<div class="blank-line">${l}</div>`;
    }).join("");
  }

  function render() {
    const usedIdxs = new Set(Object.values(filled).map((f) => f.bankIdx));

    app.innerHTML = `<div class="grid"><section class="card">
      ${navRow}
      <h2 style="margin-top:12px">${htmlEscape(ex.heading || "Заполни пропуски")}</h2>
      ${ex.hint ? `<div class="meta" style="margin-bottom:6px">${htmlEscape(ex.hint)}</div>` : ""}
      <div class="blank-text">${buildText()}</div>
      <div class="word-bank">
        ${bank.map((w, i) => `<span class="word-chip${usedIdxs.has(i) ? " used" : ""}" data-bi="${i}">${htmlEscape(w)}</span>`).join("")}
      </div>
      <div class="row" style="margin-top:14px">
        <span class="meta" id="fill-status" style="color:var(--c-danger,#f87171)"></span>
        <button class="btn" id="fill-check" style="margin-left:auto">Проверить</button>
      </div>
    </section></div>`;

    $$(".word-chip:not(.used)").forEach((chip) => {
      chip.addEventListener("click", () => {
        const bi = Number(chip.dataset.bi);
        const empty = blankNums.find((n) => !filled[n]);
        if (empty === undefined) return;
        filled[empty] = { word: bank[bi], bankIdx: bi };
        render();
      });
    });

    $$(".blank-slot.blank-filled").forEach((slot) => {
      slot.addEventListener("click", () => {
        delete filled[Number(slot.dataset.n)];
        render();
      });
    });

    $("#fill-check")?.addEventListener("click", () => {
      if (!blankNums.every((n) => filled[n])) {
        const s = $("#fill-status");
        if (s) s.textContent = "Заполни все пропуски!";
        return;
      }
      let allOk = true;
      blankNums.forEach((n) => {
        const slot = document.querySelector(`.blank-slot[data-n="${n}"]`);
        const ok = filled[n].word === ex.blanks[n];
        if (!ok) allOk = false;
        slot?.classList.remove("blank-filled");
        slot?.classList.add(ok ? "blank-correct" : "blank-wrong");
      });
      $$(".word-chip").forEach((c) => (c.style.pointerEvents = "none"));
      $("#fill-check").disabled = true;
      setTimeout(() => advance(allOk), 1200);
    });
  }
  render();
}

/* ─── word_order ───────────────────────────────────────────────────────────── */
function exWordOrder(app, ex, navRow, advance) {
  const tiles = shuffle([...ex.words]);
  const chosen = []; // tile indices in chosen order

  function render() {
    const usedSet = new Set(chosen);

    app.innerHTML = `<div class="grid"><section class="card">
      ${navRow}
      <h2 style="margin-top:12px">${htmlEscape(ex.heading || "Составь предложение")}</h2>
      ${ex.hint ? `<div class="meta" style="margin-bottom:6px">${htmlEscape(ex.hint)}</div>` : ""}
      <div class="wo-answer" id="wo-answer">
        ${chosen.length === 0
        ? `<span class="wo-placeholder">Нажимай слова снизу…</span>`
        : chosen.map((ti, ci) => `<span class="wo-token" data-ci="${ci}">${htmlEscape(tiles[ti])}</span>`).join("")}
      </div>
      <div class="word-tiles">
        ${tiles.map((w, i) => `<span class="word-tile${usedSet.has(i) ? " used" : ""}" data-ti="${i}">${htmlEscape(w)}</span>`).join("")}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn secondary" id="wo-clear" type="button">Очистить</button>
        <button class="btn" id="wo-check" type="button" style="margin-left:auto">Проверить</button>
      </div>
    </section></div>`;

    $$(".word-tile:not(.used)").forEach((tile) => {
      tile.addEventListener("click", () => { chosen.push(Number(tile.dataset.ti)); render(); });
    });
    $$(".wo-token").forEach((tok) => {
      tok.addEventListener("click", () => { chosen.splice(Number(tok.dataset.ci), 1); render(); });
    });
    $("#wo-clear")?.addEventListener("click", () => { chosen.length = 0; render(); });
    $("#wo-check")?.addEventListener("click", () => {
      const built = chosen.map((ti) => tiles[ti]).join(" ");
      const isRight = built === ex.answer;
      const ans = $("#wo-answer");
      if (ans) ans.classList.add(isRight ? "wo-correct" : "wo-wrong");
      if (!isRight) {
        const d = document.createElement("div");
        d.className = "meta wo-correction";
        d.textContent = `Правильно: ${ex.answer}`;
        ans?.after(d);
      }
      $("#wo-check").disabled = true;
      setTimeout(() => advance(isRight), 1300);
    });
  }
  render();
}

/* ─── word_spelling ────────────────────────────────────────────────────────── */
function exWordSpelling(app, ex, navRow, advance) {
  const tiles = shuffle([...ex.letters]);
  const typed = []; // tile indices

  function render() {
    app.innerHTML = `<div class="grid"><section class="card">
      ${navRow}
      <h2 style="margin-top:12px">${htmlEscape(ex.heading || "Составь слово из букв")}</h2>
      <div class="qprompt spell-prompt">${htmlEscape(ex.prompt)}</div>
      <div class="spell-answer" id="spell-answer">
        ${typed.length === 0
        ? `<span class="spell-placeholder">Нажимай буквы…</span>`
        : typed.map((ti, ci) => `<span class="spell-char" data-ci="${ci}">${tiles[ti] === " " ? "·" : htmlEscape(tiles[ti])}</span>`).join("")}
      </div>
      <div class="letter-tiles">
        ${tiles.map((ch, i) => {
          const usedCnt = typed.filter((ti) => tiles[ti] === ch).length;
          const totalCnt = tiles.filter((t) => t === ch).length;
          return `<span class="letter-tile${usedCnt >= totalCnt ? " used" : ""}" data-ti="${i}">${ch === " " ? "⎵" : htmlEscape(ch)}</span>`;
        }).join("")}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn secondary" id="spell-back" type="button">⌫ Стереть</button>
        <button class="btn" id="spell-check" type="button" style="margin-left:auto">Проверить</button>
      </div>
    </section></div>`;

    $$(".letter-tile:not(.used)").forEach((tile) => {
      tile.addEventListener("click", () => { typed.push(Number(tile.dataset.ti)); render(); });
    });
    $$(".spell-char").forEach((ch) => {
      ch.addEventListener("click", () => { typed.splice(Number(ch.dataset.ci), 1); render(); });
    });
    $("#spell-back")?.addEventListener("click", () => { if (typed.length) { typed.pop(); render(); } });
    $("#spell-check")?.addEventListener("click", () => {
      const built = typed.map((ti) => tiles[ti]).join("");
      const isRight = built.toLowerCase() === ex.answer.toLowerCase();
      const ans = $("#spell-answer");
      if (ans) ans.classList.add(isRight ? "spell-correct" : "spell-wrong");
      if (!isRight) {
        const d = document.createElement("div");
        d.className = "meta spell-correction";
        d.textContent = `Правильно: ${ex.answer}`;
        ans?.after(d);
      }
      $("#spell-check").disabled = true;
      setTimeout(() => advance(isRight), 1300);
    });
  }
  render();
}



function renderProfile() {
  setActiveNav("profile");

  const app = $("#app");
  if (!app) return;

  const level = xpToLevel(state.xp);
  const doneCount = Object.values(state.completed).filter((x) => x?.done).length;
  const total = content.modules.length;
  const favCount = state.favorites.length;

  const favPhrases = state.favorites.slice(0, 12).map((pid) => {
    const p = content.phrasesById[pid];
    if (!p) return "";

    return `
      <div class="phrase">
        <div style="flex:1">
          <div class="en">${htmlEscape(p.en)}</div>
          <div class="ru">${htmlEscape(p.ru || "—")}</div>
        </div>
        <div class="star on" data-id="${pid}">★</div>
      </div>
    `;
  }).join("");

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

  renderAuthCard();

  $("#reset")?.addEventListener("click", () => {
    if (!confirm("Сбросить XP, завершения и избранное?")) return;

    state = normalizeState({
      xp: 0,
      completed: {},
      favorites: [],
      streak: { count: 0, lastDate: null },
      settings: state.settings,
    });

    saveState();
    renderProfile();
  });

  $$(".star.on").forEach((el) => {
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
        <li>Создай таблицу <b>student_state</b> и включи RLS</li>
      </ol>
    `;
    return;
  }

  box.innerHTML = `<div class="meta">Подключаемся к Supabase…</div>`;

  await initAuthOnce();

  const client = await ensureSupabase();
  if (!client) {
    box.innerHTML = `<div class="alert bad">Не удалось загрузить Supabase SDK. Проверь интернет или CDN.</div>`;
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

    $("#btnSignOut")?.addEventListener("click", async () => {
      try {
        await client.auth.signOut();
        setAuthBanner(null, "");
      } catch (e) {
        console.error(e);
        setAuthBanner("bad", "Не удалось выйти. Попробуй ещё раз.");
      }
    });

    $("#btnSyncNow")?.addEventListener("click", async () => {
      setAuthBanner(null, "");
      await syncNow();
      setAuthBanner("good", "Синхронизация выполнена.");
      renderProfile();
    });

    $("#syncToggle")?.addEventListener("change", (e) => {
      state.settings = state.settings || { sync: true };
      state.settings.sync = Boolean(e.target.checked);
      saveState({ skipSync: true });

      if (state.settings.sync) {
        queueSync(true);
      }
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
    return {
      email: (emailEl?.value || "").trim(),
      password: passEl?.value || "",
    };
  }

  async function withBusy(fn) {
    if (btnIn) btnIn.disabled = true;
    if (btnUp) btnUp.disabled = true;

    try {
      await fn();
    } finally {
      if (btnIn) btnIn.disabled = false;
      if (btnUp) btnUp.disabled = false;
    }
  }

  btnIn?.addEventListener("click", () => withBusy(async () => {
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

  btnUp?.addEventListener("click", () => withBusy(async () => {
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
  if (!app) return;

  app.innerHTML = `
    <div class="grid">
      <section class="card">
        <h2>О проекте</h2>
        <div class="meta">
          Это чистый PWA на HTML/CSS/JavaScript.
          Прогресс хранится в localStorage и при желании синхронизируется через Supabase.
          Контент модулей и фраз тоже загружается из Supabase.
        </div>
        <div class="row" style="margin-top:12px">
          <span class="badge">Контент: ${content.modules.length} модулей</span>
          <span class="badge">Фразы: ${content.phrases.length}</span>
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

function renderAdmin() {
  setActiveNav("admin");

  const app = $("#app");
  if (!app) return;

  if (!isAdminUser) {
    app.innerHTML = `
      <section class="card">
        <h2>Доступ запрещён</h2>
        <p>Эта страница доступна только администратору.</p>
        <a class="btn" href="#/modules">К модулям</a>
      </section>
    `;
    return;
  }

  const allModules = [...content.modules].sort(
    (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
  );
  const allPhrases = [...content.phrases].sort(
    (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
  );

  if (!adminState.selectedModuleId) {
    adminState.selectedModuleId = allModules[0]?.id ?? null;
  }

  if (!adminState.selectedPhraseId) {
    adminState.selectedPhraseId = allPhrases[0]?.id ?? null;
  }

  const selectedModule = content.moduleById[adminState.selectedModuleId] ?? null;
  const selectedPhrase = content.phrasesById[adminState.selectedPhraseId] ?? null;
  const selectedModulePhraseIds = new Set(selectedModule?.phraseIds || []);

  app.innerHTML = `
    <section class="grid">
      <section class="card">
        <h1>Панель администратора</h1>
        <div class="meta">Управление учебными материалами: модули, фразы и состав модулей.</div>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h2 style="margin:0;">Модули</h2>
          <div class="row" style="gap:8px;">
            <button class="btn secondary" type="button" id="admin-new-module-btn">Новый модуль</button>
            <button class="btn" type="button" id="admin-refresh-btn">Обновить</button>
          </div>
        </div>

        <div class="field">
          <label for="admin-module-select">Выбери модуль</label>
          <select id="admin-module-select">
            ${allModules.length
      ? allModules
        .map(
          (m) => `
                        <option value="${htmlEscape(m.id)}" ${adminState.selectedModuleId === m.id ? "selected" : ""}>
                          ${htmlEscape(m.id)} — ${htmlEscape(m.title)}
                        </option>
                      `
        )
        .join("")
      : `<option value="">Нет модулей</option>`
    }
          </select>
        </div>

        <form id="admin-module-form" class="form" style="margin-top:12px;">
          <div class="field">
            <label for="admin-module-id">ID</label>
            <input id="admin-module-id" name="id" value="${htmlEscape(selectedModule?.id || "")}" placeholder="m01" />
          </div>

          <div class="field">
            <label for="admin-module-title">Название</label>
            <input id="admin-module-title" name="title" value="${htmlEscape(selectedModule?.title || "")}" placeholder="School Life" />
          </div>

          <div class="row" style="gap:10px; flex-wrap:wrap;">
            <div class="field" style="flex:1; min-width:160px;">
              <label for="admin-module-grade">Класс</label>
              <input id="admin-module-grade" name="grade" value="${htmlEscape(selectedModule?.grade || "")}" placeholder="5–6" />
            </div>

            <div class="field" style="flex:1; min-width:160px;">
              <label for="admin-module-level">Уровень</label>
              <input id="admin-module-level" name="level" value="${htmlEscape(selectedModule?.level || "")}" placeholder="Beginner" />
            </div>

            <div class="field" style="flex:1; min-width:160px;">
              <label for="admin-module-sort">Порядок</label>
              <input id="admin-module-sort" name="sort_order" type="number" value="${htmlEscape(selectedModule?.sort_order ?? 0)}" />
            </div>
          </div>

          <div class="field">
            <label for="admin-module-context">Описание</label>
            <textarea id="admin-module-context" name="context" rows="4" placeholder="Краткое описание модуля">${htmlEscape(selectedModule?.context || "")}</textarea>
          </div>

          <label class="toggle">
            <input id="admin-module-published" name="is_published" type="checkbox" ${selectedModule?.is_published !== false ? "checked" : ""} />
            <span>Опубликован</span>
          </label>

          <div class="actions">
            <button class="btn" type="submit">Сохранить модуль</button>
          </div>
        </form>
      </section>

      <section class="card">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h2 style="margin:0;">Фразы</h2>
          <button class="btn secondary" type="button" id="admin-new-phrase-btn">Новая фраза</button>
        </div>

        <div class="field">
          <label for="admin-phrase-select">Выбери фразу</label>
          <select id="admin-phrase-select">
            ${allPhrases.length
      ? allPhrases
        .map(
          (p) => `
                        <option value="${htmlEscape(p.id)}" ${adminState.selectedPhraseId === p.id ? "selected" : ""}>
                          ${htmlEscape(p.id)} — ${htmlEscape(p.en)}
                        </option>
                      `
        )
        .join("")
      : `<option value="">Нет фраз</option>`
    }
          </select>
        </div>

        <form id="admin-phrase-form" class="form" style="margin-top:12px;">
          <div class="field">
            <label for="admin-phrase-id">ID</label>
            <input id="admin-phrase-id" name="id" value="${htmlEscape(selectedPhrase?.id || "")}" placeholder="p0001" />
          </div>

          <div class="field">
            <label for="admin-phrase-en">English</label>
            <input id="admin-phrase-en" name="en" value="${htmlEscape(selectedPhrase?.en || "")}" placeholder="How are you?" />
          </div>

          <div class="field">
            <label for="admin-phrase-ru">Русский перевод</label>
            <input id="admin-phrase-ru" name="ru" value="${htmlEscape(selectedPhrase?.ru || "")}" placeholder="Как дела?" />
          </div>

          <div class="field">
            <label for="admin-phrase-image">URL картинки</label>
            <input id="admin-phrase-image" name="image_url" value="${htmlEscape(selectedPhrase?.image_url || "")}" placeholder="https://..." />
            ${selectedPhrase?.image_url
      ? `<img src="${htmlEscape(selectedPhrase.image_url)}" alt="preview" class="admin-img-preview" />`
      : ""}
          </div>

          <div class="row" style="gap:10px; flex-wrap:wrap;">
            <div class="field" style="flex:1; min-width:160px;">
              <label for="admin-phrase-sort">Порядок</label>
              <input id="admin-phrase-sort" name="sort_order" type="number" value="${htmlEscape(selectedPhrase?.sort_order ?? 0)}" />
            </div>

            <label class="toggle" style="margin-top:28px;">
              <input id="admin-phrase-published" name="is_published" type="checkbox" ${selectedPhrase?.is_published !== false ? "checked" : ""} />
              <span>Опубликована</span>
            </label>
          </div>

          <div class="actions">
            <button class="btn" type="submit">Сохранить фразу</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Фразы в модуле</h2>

        ${selectedModule
      ? `
              <div class="meta" style="margin-bottom:12px;">
                Модуль: <b>${htmlEscape(selectedModule.title)}</b>
              </div>

              <form id="admin-module-phrases-form">
                <div style="display:grid; gap:8px; max-height:420px; overflow:auto;">
                  ${allPhrases
        .map(
          (p) => `
                        <label style="display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:start; border:1px solid rgba(0,0,0,.08); padding:10px; border-radius:10px;">
                          <input
                            type="checkbox"
                            name="phrase_ids"
                            value="${htmlEscape(p.id)}"
                            ${selectedModulePhraseIds.has(p.id) ? "checked" : ""}
                          />
                          <div>
                            <div><b>${htmlEscape(p.en)}</b></div>
                            <div class="meta">${htmlEscape(p.ru)}</div>
                          </div>
                          <div class="meta">${htmlEscape(p.id)}</div>
                        </label>
                      `
        )
        .join("")}
                </div>

                <div class="actions" style="margin-top:14px;">
                  <button class="btn" type="submit">Сохранить состав модуля</button>
                </div>
              </form>
            `
      : `<div class="meta">Сначала создай или выбери модуль.</div>`
    }
      </section>
    </section>
  `;

  $("#admin-refresh-btn")?.addEventListener("click", async () => {
    try {
      await reloadContentAndKeepAdminSelection();
      renderAdmin();
    } catch (error) {
      console.error(error);
      adminNotify(`Ошибка обновления: ${error.message || error}`);
    }
  });

  $("#admin-module-select")?.addEventListener("change", (e) => {
    adminState.selectedModuleId = e.target.value || null;
    renderAdmin();
  });

  $("#admin-phrase-select")?.addEventListener("change", (e) => {
    adminState.selectedPhraseId = e.target.value || null;
    renderAdmin();
  });

  $("#admin-new-module-btn")?.addEventListener("click", () => {
    adminState.selectedModuleId = null;

    const idInput = $("#admin-module-id");
    const titleInput = $("#admin-module-title");
    const gradeInput = $("#admin-module-grade");
    const levelInput = $("#admin-module-level");
    const sortInput = $("#admin-module-sort");
    const contextInput = $("#admin-module-context");
    const publishedInput = $("#admin-module-published");

    if (idInput) idInput.value = nextTextId(content.modules, "m", 2);
    if (titleInput) titleInput.value = "";
    if (gradeInput) gradeInput.value = "";
    if (levelInput) levelInput.value = "";
    if (sortInput) sortInput.value = String(content.modules.length + 1);
    if (contextInput) contextInput.value = "";
    if (publishedInput) publishedInput.checked = true;
  });

  $("#admin-new-phrase-btn")?.addEventListener("click", () => {
    adminState.selectedPhraseId = null;

    const idInput = $("#admin-phrase-id");
    const enInput = $("#admin-phrase-en");
    const ruInput = $("#admin-phrase-ru");
    const sortInput = $("#admin-phrase-sort");
    const publishedInput = $("#admin-phrase-published");

    if (idInput) idInput.value = nextTextId(content.phrases, "p", 4);
    if (enInput) enInput.value = "";
    if (ruInput) ruInput.value = "";
    if (sortInput) sortInput.value = String(content.phrases.length + 1);
    if (publishedInput) publishedInput.checked = true;
  });

  $("#admin-module-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const form = e.currentTarget;
    const fd = new FormData(form);

    const data = {
      id: String(fd.get("id") || "").trim(),
      title: String(fd.get("title") || "").trim(),
      grade: String(fd.get("grade") || "").trim(),
      level: String(fd.get("level") || "").trim(),
      context: String(fd.get("context") || "").trim(),
      sort_order: Number(fd.get("sort_order") || 0),
      is_published: Boolean($("#admin-module-published")?.checked),
    };

    if (!data.id || !data.title || !data.grade || !data.level) {
      adminNotify("Заполни обязательные поля модуля");
      return;
    }

    try {
      await upsertModule(data);
      adminState.selectedModuleId = data.id;
      await reloadContentAndKeepAdminSelection();
      renderAdmin();
      adminNotify("Модуль сохранён");
    } catch (error) {
      console.error(error);
      adminNotify(`Ошибка сохранения модуля: ${error.message || error}`);
    }
  });

  $("#admin-phrase-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const form = e.currentTarget;
    const fd = new FormData(form);

    const data = {
      id: String(fd.get("id") || "").trim(),
      en: String(fd.get("en") || "").trim(),
      ru: String(fd.get("ru") || "").trim(),
      image_url: String(fd.get("image_url") || "").trim() || null,
      sort_order: Number(fd.get("sort_order") || 0),
      is_published: Boolean($("#admin-phrase-published")?.checked),
    };

    if (!data.id || !data.en || !data.ru) {
      adminNotify("Заполни обязательные поля фразы");
      return;
    }

    try {
      await upsertPhrase(data);
      adminState.selectedPhraseId = data.id;
      await reloadContentAndKeepAdminSelection();
      renderAdmin();
      adminNotify("Фраза сохранена");
    } catch (error) {
      console.error(error);
      adminNotify(`Ошибка сохранения фразы: ${error.message || error}`);
    }
  });

  $("#admin-module-phrases-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!adminState.selectedModuleId) {
      adminNotify("Сначала выбери модуль");
      return;
    }

    const checked = $$('input[name="phrase_ids"]:checked').map((el) => el.value);

    try {
      await replaceModulePhrases(adminState.selectedModuleId, checked);
      await reloadContentAndKeepAdminSelection();
      renderAdmin();
      adminNotify("Состав модуля сохранён");
    } catch (error) {
      console.error(error);
      adminNotify(`Ошибка сохранения состава модуля: ${error.message || error}`);
    }
  });
}

async function setUserRole(userId, role) {
  const client = await ensureSupabase();
  if (!client) throw new Error("Supabase не настроен");

  const payload = {
    user_id: userId,
    role,
  };

  const { error } = await client
    .from("app_roles")
    .upsert(payload, { onConflict: "user_id" });

  if (error) throw error;
}

async function removeAdminRole(userId) {
  const client = await ensureSupabase();
  if (!client) throw new Error("Supabase не настроен");

  const { error } = await client
    .from("app_roles")
    .delete()
    .eq("user_id", userId);

  if (error) throw error;
}

async function renderAdminUsers() {
  setActiveNav("admin-users");

  const app = $("#app");
  if (!app) return;

  if (!isAdminUser) {
    app.innerHTML = `
      <section class="card">
        <h2>Доступ запрещён</h2>
        <p>Эта страница доступна только администратору.</p>
        <a class="btn" href="#/modules">К модулям</a>
      </section>
    `;
    return;
  }

  app.innerHTML = `
    <section class="card">
      <h1>Пользователи</h1>
      <div class="meta">Загрузка списка пользователей...</div>
    </section>
  `;

  try {
    const users = await fetchAdminUsers();

    app.innerHTML = `
      <section class="grid">
        <section class="card">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <div>
              <h1 style="margin:0;">Пользователи</h1>
              <div class="meta" style="margin-top:6px;">
                Здесь можно просматривать зарегистрированных пользователей и назначать им роль администратора.
              </div>
            </div>
            <a class="btn secondary" href="#/admin">Назад</a>
          </div>
        </section>

        <section class="card">
          <div class="list">
            ${users.length
        ? users
          .map(
            (user) => `
                        <div class="module" data-user-id="${htmlEscape(user.id)}">
                          <div>
                            <div class="title">${htmlEscape(user.full_name || "Без имени")}</div>
                            <div class="desc">${htmlEscape(user.email || "Email не указан")}</div>
                            <div class="meta" style="margin-top:6px;">
                              ID: ${htmlEscape(user.id)}
                            </div>
                          </div>

                          <div class="right" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            <span class="badge ${user.role === "admin" ? "good" : "accent"}">
                              ${htmlEscape(user.role)}
                            </span>

                            ${user.role === "admin"
                ? `<button class="btn secondary js-demote" data-id="${htmlEscape(user.id)}">Снять админа</button>`
                : `<button class="btn js-promote" data-id="${htmlEscape(user.id)}">Сделать админом</button>`
              }
                          </div>
                        </div>
                      `
          )
          .join("")
        : `<div class="meta">Пользователи не найдены.</div>`
      }
          </div>
        </section>
      </section>
    `;

    $$(".js-promote").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.id;
        if (!userId) return;

        if (!confirm("Назначить пользователя администратором?")) return;

        btn.disabled = true;
        try {
          await setUserRole(userId, "admin");
          alert("Пользователь назначен администратором");
          await loadUserRole();
          await renderAdminUsers();
        } catch (error) {
          console.error(error);
          alert(`Ошибка назначения роли: ${error.message || error}`);
        } finally {
          btn.disabled = false;
        }
      });
    });

    $$(".js-demote").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.id;
        if (!userId) return;

        if (authUser?.id === userId) {
          alert("Нельзя снять роль администратора у самого себя через эту страницу.");
          return;
        }

        if (!confirm("Снять роль администратора у пользователя?")) return;

        btn.disabled = true;
        try {
          await removeAdminRole(userId);
          alert("Роль администратора снята");
          await loadUserRole();
          await renderAdminUsers();
        } catch (error) {
          console.error(error);
          alert(`Ошибка изменения роли: ${error.message || error}`);
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (error) {
    console.error(error);
    app.innerHTML = `
      <section class="card">
        <h2>Ошибка</h2>
        <div class="alert bad">
          Не удалось загрузить пользователей: ${htmlEscape(error.message || String(error))}
        </div>
      </section>
    `;
  }
}

function renderNotFound() {
  const app = $("#app");
  if (!app) return;

  app.innerHTML = `
    <div class="card">
      <h2>Страница не найдена</h2>
      <a class="btn" href="#/modules">На главную</a>
    </div>
  `;
}
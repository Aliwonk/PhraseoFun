import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient.js";
import { modules as staticModules, phrases as staticPhrases, exercises as staticExercises } from "./data.js";

const CONTENT_CACHE_KEY = "phraseofun_content_v2";

function buildPhrasesById(phrases) {
    return Object.fromEntries(phrases.map(p => [p.id, p]));
}

function buildModuleById(modules) {
    return Object.fromEntries(modules.map(m => [m.id, m]));
}

function buildContent(modules, phrases, links) {
    const phraseMap = buildPhrasesById(phrases);

    const linksByModule = new Map();
    for (const row of links) {
        if (!linksByModule.has(row.module_id)) linksByModule.set(row.module_id, []);
        linksByModule.get(row.module_id).push(row);
    }
    for (const arr of linksByModule.values()) {
        arr.sort((a, b) => a.sort_order - b.sort_order);
    }

    const normalizedModules = modules.map(m => ({
        ...m,
        phraseIds: (linksByModule.get(m.id) || []).map(x => x.phrase_id),
    }));

    return {
        modules: normalizedModules,
        phrases,
        phrasesById: phraseMap,
        moduleById: Object.fromEntries(normalizedModules.map(m => [m.id, m])),
        exercises: staticExercises,
    };
}

/* ── Статичный контент из data.js (мгновенно) ── */
export function loadStaticContent() {
    const phraseMap = buildPhrasesById(staticPhrases);
    const moduleById = buildModuleById(staticModules);
    return {
        modules: staticModules,
        phrases: staticPhrases,
        phrasesById: phraseMap,
        moduleById,
        exercises: staticExercises,
    };
}

/* ── Кэш (localStorage) ── */
function loadCachedContent() {
    try {
        const raw = localStorage.getItem(CONTENT_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return { ...parsed, exercises: staticExercises };
    } catch {
        return null;
    }
}

function saveCachedContent(content) {
    try {
        const { exercises, ...rest } = content;
        localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(rest));
    } catch { /* quota exceeded — ignore */ }
}

/* ── loadContent: сначала статика/кэш, потом Supabase в фоне ── */
export async function loadContent() {
    // 1. Мгновенно — кэш или статика
    const cached = loadCachedContent();
    if (cached) return cached;
    return loadStaticContent();
}

/* ── refreshFromSupabase: вызывается в фоне после первого рендера ── */
export async function refreshFromSupabase(onUpdated) {
    if (!isSupabaseConfigured()) return;

    let client;
    try {
        client = await getSupabaseClient();
    } catch { return; }
    if (!client) return;

    try {
        const [modulesResp, phrasesResp, linksResp] = await Promise.all([
            client.from("modules").select("*").eq("is_published", true).order("sort_order"),
            client.from("phrases").select("*").eq("is_published", true).order("sort_order"),
            client.from("module_phrases").select("*").order("sort_order"),
        ]);

        if (modulesResp.error || phrasesResp.error || linksResp.error) return;

        const fresh = buildContent(
            modulesResp.data || [],
            phrasesResp.data || [],
            linksResp.data || []
        );

        saveCachedContent(fresh);
        if (onUpdated) onUpdated(fresh);
    } catch { /* network error — работаем со статикой */ }
}
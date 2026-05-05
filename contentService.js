import { getSupabaseClient, isSupabaseConfigured } from "./supabaseClient.js";

const CONTENT_CACHE_KEY = "phraseofun_content_v1";

function buildContent(modules, phrases, links) {
    const phraseMap = Object.fromEntries(phrases.map(p => [p.id, p]));

    const linksByModule = new Map();
    for (const row of links) {
        if (!linksByModule.has(row.module_id)) linksByModule.set(row.module_id, []);
        linksByModule.get(row.module_id).push(row);
    }

    for (const [moduleId, arr] of linksByModule.entries()) {
        arr.sort((a, b) => a.sort_order - b.sort_order);
    }

    const normalizedModules = modules.map(m => ({
        ...m,
        phraseIds: (linksByModule.get(m.id) || []).map(x => x.phrase_id),
    }));

    const moduleById = Object.fromEntries(normalizedModules.map(m => [m.id, m]));

    return {
        modules: normalizedModules,
        phrases,
        phrasesById: phraseMap,
        moduleById,
    };
}

function loadCachedContent() {
    try {
        const raw = localStorage.getItem(CONTENT_CACHE_KEY);
        if (!raw) return { modules: [], phrases: [], phrasesById: {}, moduleById: {} };
        return JSON.parse(raw);
    } catch {
        return { modules: [], phrases: [], phrasesById: {}, moduleById: {} };
    }
}

function saveCachedContent(content) {
    localStorage.setItem(CONTENT_CACHE_KEY, JSON.stringify(content));
}

export async function loadContent() {
    const cached = loadCachedContent();

    if (!isSupabaseConfigured()) return cached;

    const client = await getSupabaseClient();
    if (!client) return cached;

    const [modulesResp, phrasesResp, linksResp] = await Promise.all([
        client.from("modules").select("*").eq("is_published", true).order("sort_order"),
        client.from("phrases").select("*").eq("is_published", true).order("sort_order"),
        client.from("module_phrases").select("*").order("sort_order"),
    ]);

    if (modulesResp.error) throw modulesResp.error;
    if (phrasesResp.error) throw phrasesResp.error;
    if (linksResp.error) throw linksResp.error;

    const content = buildContent(
        modulesResp.data || [],
        phrasesResp.data || [],
        linksResp.data || []
    );

    saveCachedContent(content);
    return content;
}
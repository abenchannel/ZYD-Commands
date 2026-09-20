// scripts/data/rankdata.js
import { world } from "@minecraft/server";

// =============================================================================
// DATABASE KEYS & DEFAULTS
// =============================================================================

const DB_CUSTOM_RANKS = "zyd_ranks_custom";
const DB_PLAYER_PREFIX = "zyd_ranks_player_";
const DEFAULT_RANK_DISPLAY = "§7[]";

// =============================================================================
// CUSTOM RANKS (World-level, persistent)
// =============================================================================

export function getCustomRanks() {
    const data = world.getDynamicProperty(DB_CUSTOM_RANKS);
    if (!data) return [];
    try { return JSON.parse(data); }
    catch { return []; }
}

export function saveCustomRanks(ranks) {
    world.setDynamicProperty(DB_CUSTOM_RANKS, JSON.stringify(ranks));
}

// =============================================================================
// DEFAULT RANK
// =============================================================================

export function getDefaultRank() {
    return DEFAULT_RANK_DISPLAY;
}

// =============================================================================
// PLAYER RANK DATA (Player-level, persistent per player)
// =============================================================================

export function getPlayerData(player) {
    const key = DB_PLAYER_PREFIX + player.name.toLowerCase();
    const data = player.getDynamicProperty(key);
    const def = { owned: [], active: null };

    if (!data) {
        player.setDynamicProperty(key, JSON.stringify(def));
        return def;
    }

    try { return JSON.parse(data); }
    catch {
        player.setDynamicProperty(key, JSON.stringify(def));
        return def;
    }
}

export function savePlayerData(player, data) {
    const key = DB_PLAYER_PREFIX + player.name.toLowerCase();
    player.setDynamicProperty(key, JSON.stringify(data));
}

// =============================================================================
// HELPERS
// =============================================================================

export function getAllPossibleRanks() {
    return [...getCustomRanks()];
}

export function getActiveRankDisplay(player) {
    const data = getPlayerData(player);
    if (data.active) {
        const rank = getAllPossibleRanks().find(r => r.id === data.active);
        if (rank) return rank.display;
    }
    return getDefaultRank();
}

export function stripColors(text) {
    return text.replace(/§[0-9a-fk-or]/g, "");
}
// scripts/ranks.js
import { world, system, ItemStack, EnchantmentTypes } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { getBalance, setBalance } from "./operator/currency.js";
import { isFlyEnabled, forceDisableFly } from "./fly.js";

const RANK_KILL_COOLDOWN_MS = 3600000; // 1 hour cooldown per victim/killer pair to prevent farming

// =============================================================================
// RANK DEFINITIONS & CONFIGURATION
// =============================================================================

const RANKS = [
    { id: "death_god", tag: "rank_death_god", min: 40, max: 50, req: 250000, name: "Death God", title: "§4[Death God]§r", chatIcon: "\u{E0D8}", headIcon: "\u{E0E8}", icon: "textures/ranks/death_god.png" },
    { id: "grandmaster", tag: "rank_grandmaster", min: 35, max: 40, req: 50000, name: "Grandmaster", title: "§5[Grandmaster]§r", chatIcon: "\u{E0D7}", headIcon: "\u{E0E7}", icon: "textures/ranks/grandmaster.png" },
    { id: "ace", tag: "rank_ace", min: 30, max: 35, req: 5000, name: "Ace", title: "§d[Ace]§r", chatIcon: "\u{E0D6}", headIcon: "\u{E0E6}", icon: "textures/ranks/ace.png" },
    { id: "specialist", tag: "rank_specialist", min: 25, max: 30, req: 1000, name: "Specialist", title: "§b[Specialist]§r", chatIcon: "\u{E0D5}", headIcon: "\u{E0E5}", icon: "textures/ranks/specialist.png" },
    { id: "cadet", tag: "rank_cadet", min: 20, max: 25, req: 500, name: "Cadet", title: "§6[Cadet]§r", chatIcon: "\u{E0D4}", headIcon: "\u{E0E4}", icon: "textures/ranks/cadet.png" },
    { id: "trainee", tag: "rank_trainee", min: 15, max: 20, req: 100, name: "Trainee", title: "§e[Trainee]§r", chatIcon: "\u{E0D3}", headIcon: "\u{E0E3}", icon: "textures/ranks/trainee.png" },
    { id: "recruit", tag: "rank_recruit", min: 8, max: 15, req: 50, name: "Recruit", title: "§a[Recruit]§r", chatIcon: "\u{E0D2}", headIcon: "\u{E0E2}", icon: "textures/ranks/recruit.png" },
    { id: "rookie", tag: "rank_rookie", min: 6, max: 8, req: 20, name: "Rookie", title: "§f[Rookie]§r", chatIcon: "\u{E0D1}", headIcon: "\u{E0E1}", icon: "textures/ranks/rookie.png" },
    { id: "noob", tag: "rank_noob", min: 1, max: 6, req: 0, name: "Noob", title: "§8[Noob]§r", chatIcon: "\u{E0D0}", headIcon: "\u{E0E0}", icon: "textures/ranks/noob.png" }
];

// =============================================================================
// RANK TIER SYSTEM (For Skill Access)
// =============================================================================

export const RANK_TIERS = {
    "noob": 1,
    "rookie": 2,
    "recruit": 3,
    "trainee": 4,
    "cadet": 5,
    "specialist": 6,
    "ace": 7,
    "grandmaster": 8,
    "death_god": 9
};

export function getEquippedRankTier(player) {
    if (!isRanksFeatureEnabled()) return 0;
    const data = getPlayerData(player);
    if (data.hideRank) return 0;
    if (!data.activeRank || data.activeRank === "none" || data.activeRank === "member") return 0;
    if (!getRankSystemEnabled()) return 0;
    const tier = RANK_TIERS[data.activeRank];
    if (tier !== undefined) return tier;
    return 0;
}

export function getEquippedRankId(player) {
    if (!isRanksFeatureEnabled()) return null;
    const data = getPlayerData(player);
    if (data.hideRank) return null;
    if (!data.activeRank || data.activeRank === "none" || data.activeRank === "member") return null;
    if (!getRankSystemEnabled()) return null;
    if (!RANK_TIERS[data.activeRank]) return null;
    return data.activeRank;
}

export function isCommandEnabledForPlayer(player, commandId) {
    const data = getPlayerData(player);
    if (data.hideRank) return false;
    if (!data.activeRank || data.activeRank === "none" || data.activeRank === "member") return false;

    // Custom rank titles carry their own skill toggles, independent of the
    // Rank System (points/progression). This is what allows Rank Titles to be
    // disabled server-wide without disabling custom rank skills.
    const custom = getCustomRanks().find(r => r.id === data.activeRank);
    if (custom) {
        return !!(custom.commands && custom.commands[commandId] === true);
    }

    // Progression ranks (Noob..Death God) are part of the Rank System,
    // so they still require Rank Titles to be enabled.
    if (!getRankTitlesEnabled()) return false;
    if (!RANK_TIERS[data.activeRank]) return false;
    const config = getRankCommandConfig();
    return config[data.activeRank] && config[data.activeRank][commandId] === true;
}

const RANK_COMMANDS = [
    { id: "heal", label: "/zyd:heal", minRank: "cadet", desc: "/zyd:heal - Cooldown 30mins" },
    { id: "hunger", label: "/zyd:hunger", minRank: "trainee", desc: "/zyd:hunger - Cooldown 45mins" },
    { id: "nick", label: "/zyd:nick", minRank: "specialist", desc: "/zyd:nick - Cooldown 60mins" },
    { id: "fire", label: "/zyd:fire", minRank: "specialist", desc: "/zyd:fire - Cooldown 10mins" },
    { id: "nv", label: "/zyd:nv", minRank: "ace", desc: "/zyd:nv - Cooldown 10mins" },
    { id: "repair", label: "/zyd:repair", minRank: "grandmaster", desc: "/zyd:repair - Cooldown 280mins" },
    { id: "day", label: "/zyd:day", minRank: "death_god", desc: "/zyd:day - Cooldown 45mins" },
    { id: "night", label: "/zyd:night", minRank: "death_god", desc: "/zyd:night - Cooldown 45mins" },
    { id: "itemname", label: "/zyd:itemname", minRank: "cadet", desc: "/zyd:itemname - Cooldown 30mins" },
    { id: "fly", label: "/zyd:fly", minRank: "ace", desc: "/zyd:fly - Toggle flight" }
];

const RANK_COMMAND_CONFIG_PROPERTY = "zyd:rank_command_config";

function getRawRankCommandConfig() {
    try { const data = world.getDynamicProperty(RANK_COMMAND_CONFIG_PROPERTY); return data ? JSON.parse(data) : {}; } catch (e) { return {}; }
}

function saveRankCommandConfig(config) {
    try { world.setDynamicProperty(RANK_COMMAND_CONFIG_PROPERTY, JSON.stringify(config)); } catch (e) { }
}

function getRankCommandConfig() {
    const saved = getRawRankCommandConfig();
    const config = {};
    for (const rank of RANKS) {
        config[rank.id] = {};
        for (const cmd of RANK_COMMANDS) {
            const def = RANK_TIERS[rank.id] >= RANK_TIERS[cmd.minRank];
            config[rank.id][cmd.id] = (saved[rank.id] && typeof saved[rank.id][cmd.id] === "boolean") ? saved[rank.id][cmd.id] : def;
        }
    }
    return config;
}

const MEMBER_TIERS = [
    { min: 0, display: "\u{E000}" },
    { min: 10, display: "\u{E001}" },
    { min: 20, display: "\u{E002}" },
    { min: 50, display: "\u{E010}" },
    { min: 100, display: "\u{E011}" },
    { min: 250, display: "\u{E012}" },
    { min: 500, display: "\u{E013}" },
    { min: 1000, display: "\u{E014}" },
    { min: 2500, display: "\u{E030}" },
    { min: 5000, display: "\u{E031}" },
    { min: 10000, display: "\u{E032}" },
    { min: 25000, display: "\u{E033}" },
    { min: 50000, display: "\u{E034}" },
    { min: 100000, display: "\u{E035}" },
    { min: 250000, display: "\u{E036}" },
    { min: 500000, display: "\u{E037}" }
];

const MEMBER_RANK = { id: "member", name: "Member", title: "\u{E000}", display: "\u{E000}" };

function getMemberRankDisplay(points) {
    let result = MEMBER_TIERS[0].display;
    for (let i = MEMBER_TIERS.length - 1; i >= 0; i--) {
        if (points >= MEMBER_TIERS[i].min) {
            result = MEMBER_TIERS[i].display;
            break;
        }
    }
    return result;
}

const MAX_POINTS = 999999999;
const POINTS_OBJ = "KillPoints";
const RANK_REWARDS_PROPERTY = "zyd:rank_rewards";
const RANK_CONFIG_PROPERTY = "zyd:rank_config";
const CUSTOM_RANKS_PROPERTY = "zyd:custom_ranks";
const CUSTOM_NICKS_PROPERTY = "zyd:custom_nicks";
const PLAYER_DATA_PROPERTY = "zyd:player_data";

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

const TEST_ENTITIES = false;
let testPlayersList = [];

const RANK_COLORS = ["aqua", "black", "blue", "dark_aqua", "dark_blue", "dark_gray", "dark_green", "dark_purple", "dark_red", "gold", "gray", "green", "light_purple", "red", "white", "yellow"];

function getRandomRankColorIcon() {
    const color = RANK_COLORS[Math.floor(Math.random() * RANK_COLORS.length)];
    return `textures/rank_colours/${color}.png`;
}

const UNICODE_LIST = [
    { code: "\\u{E0D0}", icon: "\u{E0D0}" }, { code: "\\u{E0D1}", icon: "\u{E0D1}" },
    { code: "\\u{E0D2}", icon: "\u{E0D2}" }, { code: "\\u{E0D3}", icon: "\u{E0D3}" },
    { code: "\\u{E0D4}", icon: "\u{E0D4}" }, { code: "\\u{E0D5}", icon: "\u{E0D5}" },
    { code: "\\u{E0D6}", icon: "\u{E0D6}" }, { code: "\\u{E0D7}", icon: "\u{E0D7}" },
    { code: "\\u{E0D8}", icon: "\u{E0D8}" }, { code: "\\u{E0E0}", icon: "\u{E0E0}" },
    { code: "\\u{E0E1}", icon: "\u{E0E1}" }, { code: "\\u{E0E2}", icon: "\u{E0E2}" },
    { code: "\\u{E0E3}", icon: "\u{E0E3}" }, { code: "\\u{E0E4}", icon: "\u{E0E4}" },
    { code: "\\u{E0E5}", icon: "\u{E0E5}" }, { code: "\\u{E0E6}", icon: "\u{E0E6}" },
    { code: "\\u{E0E7}", icon: "\u{E0E7}" }, { code: "\\u{E0E8}", icon: "\u{E0E8}" },
    { code: "\\u{E000}", icon: "\u{E000}" }, { code: "\\u{E001}", icon: "\u{E001}" },
    { code: "\\u{E002}", icon: "\u{E002}" }, { code: "\\u{E010}", icon: "\u{E010}" },
    { code: "\\u{E011}", icon: "\u{E011}" }, { code: "\\u{E012}", icon: "\u{E012}" },
    { code: "\\u{E013}", icon: "\u{E013}" }, { code: "\\u{E014}", icon: "\u{E014}" },
    { code: "\\u{E030}", icon: "\u{E030}" }, { code: "\\u{E031}", icon: "\u{E031}" },
    { code: "\\u{E032}", icon: "\u{E032}" }, { code: "\\u{E033}", icon: "\u{E033}" },
    { code: "\\u{E034}", icon: "\u{E034}" }, { code: "\\u{E035}", icon: "\u{E035}" },
    { code: "\\u{E036}", icon: "\u{E036}" }, { code: "\\u{E037}", icon: "\u{E037}" },
    { code: "\\u{E040}", icon: "\u{E040}" }, { code: "\\u{E041}", icon: "\u{E041}" },
    { code: "\\u{E0F0}", icon: "\u{E0F0}" }, { code: "\\u{E0F1}", icon: "\u{E0F1}" },
    { code: "\\u{E0F2}", icon: "\u{E0F2}" }, { code: "\\u{E0F3}", icon: "\u{E0F3}" },
    { code: "\\u{E0F4}", icon: "\u{E0F4}" }, { code: "\\u{E0F5}", icon: "\u{E0F5}" },
    { code: "\\u{E0F6}", icon: "\u{E0F6}" }, { code: "\\u{E0F7}", icon: "\u{E0F7}" },
    { code: "\\u{E0F8}", icon: "\u{E0F8}" }, { code: "\\u{E0F9}", icon: "\u{E0F9}" },
    { code: "\\u{E0FA}", icon: "\u{E0FA}" }, { code: "\\u{E0FB}", icon: "\u{E0FB}" }
];

// =============================================================================
// PLAYER TRACKER & SEASON CONFIG
// =============================================================================

const RANK_TRACKER_PROPERTY = "zyd:rank_tracker";
const trackedPlayers = new Map();
let trackerLoaded = false;

const LOSE_POINTS_MODE_PROPERTY = "zyd:lose_points_mode";
const LOSE_POINTS_OPTIONS = [
    "No Lose Points",
    "Lose on Player Kill Only",
    "Lose on Any Death"
];

const SEASON_START_PROPERTY = "zyd:season_start";
const SEASON_DURATION_PROPERTY = "zyd:season_duration";
const REWARDS_INIT_PROPERTY = "zyd:rewards_init";
const END_REWARDS_INIT_PROPERTY = "zyd:end_rewards_init";

const RANK_END_REWARDS_PROPERTY = "zyd:rank_end_rewards";

const SEASON_OPTIONS = [
    { name: "10 Seconds (Test)", ms: 10000 },
    { name: "1 Month", ms: 2592000000 },
    { name: "2 Months", ms: 5184000000 },
    { name: "3 Months", ms: 7776000000 },
    { name: "4 Months", ms: 10368000000 },
    { name: "5 Months", ms: 12960000000 },
    { name: "6 Months", ms: 15552000000 },
    { name: "7 Months", ms: 18144000000 },
    { name: "8 Months", ms: 20736000000 },
    { name: "9 Months", ms: 23328000000 },
    { name: "10 Months", ms: 25920000000 },
    { name: "11 Months", ms: 28512000000 },
    { name: "12 Months", ms: 31104000000 },
    { name: "None (Never Ends)", ms: 0 }
];

function loadRankTracker() {
    if (trackerLoaded) return;
    try {
        const data = world.getDynamicProperty(RANK_TRACKER_PROPERTY);
        if (data) {
            const parsed = JSON.parse(data);
            Object.entries(parsed).forEach(([id, info]) => {
                trackedPlayers.set(id, info);
            });
        }
        trackerLoaded = true;
    } catch (e) { trackerLoaded = true; }
}

function saveRankTracker() {
    try {
        const obj = {};
        trackedPlayers.forEach((val, key) => { obj[key] = val; });
        world.setDynamicProperty(RANK_TRACKER_PROPERTY, JSON.stringify(obj));
    } catch (e) { }
}

function updateTrackedPlayer(player) {
    loadRankTracker();
    const data = getPlayerData(player);
    const nick = getActiveNickDisplay(player);
    const points = getPoints(player);
    trackedPlayers.set(player.id, { name: player.name, points: points, nick: nick });
    saveRankTracker();
}

function formatTimeLeft(ms) {
    if (ms <= 0) return "0s";
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function initializeDefaultRewards() {
    try {
        if (world.getDynamicProperty(REWARDS_INIT_PROPERTY)) return;
        const rewards = getRankRewards();
        for (const rank of RANKS) {
            if (!rewards[rank.id]) rewards[rank.id] = { money: 0, items: [] };
            if (!rewards[rank.id].money || rewards[rank.id].money === 0) {
                rewards[rank.id].money = rank.req;
            }
        }
        saveRankRewards(rewards);
        world.setDynamicProperty(REWARDS_INIT_PROPERTY, true);
    } catch (e) { console.error("Init rewards error:", e); }
}

function initializeDefaultEndRewards() {
    try {
        if (world.getDynamicProperty(END_REWARDS_INIT_PROPERTY)) return;
        const rewards = getRankEndRewards();
        for (const rank of RANKS) {
            if (!rewards[rank.id]) rewards[rank.id] = { money: 0, items: [] };
            if (!rewards[rank.id].money || rewards[rank.id].money === 0) {
                rewards[rank.id].money = rank.req;
            }
        }
        saveRankEndRewards(rewards);
        world.setDynamicProperty(END_REWARDS_INIT_PROPERTY, true);
    } catch (e) { console.error("Init end rewards error:", e); }
}

// =============================================================================
// COLOR & FORMAT HELPERS
// =============================================================================

const COLOR_OPTIONS = [
    { code: "§f", name: "White" }, { code: "§0", name: "Black" }, { code: "§1", name: "Dark Blue" },
    { code: "§2", name: "Dark Green" }, { code: "§3", name: "Dark Aqua" }, { code: "§4", name: "Dark Red" },
    { code: "§5", name: "Dark Purple" }, { code: "§6", name: "Gold" }, { code: "§8", name: "Dark Gray" },
    { code: "§9", name: "Blue" }, { code: "§a", name: "Light Green" }, { code: "§b", name: "Aqua" },
    { code: "§c", name: "Red" }, { code: "§d", name: "Light Purple" }, { code: "§e", name: "Yellow" },
    { code: "§g", name: "Minecoin Gold" }, { code: "rainbow", name: "Rainbow" }
];

const FORMAT_OPTIONS = [
    { code: "", name: "None" }, { code: "§k", name: "Obfuscated" },
    { code: "§l", name: "Bold" }, { code: "§o", name: "Italic" }
];

const CHAT_COLOR_OPTIONS = [
    { code: "", name: "None" }, { code: "§f", name: "White" }, { code: "§0", name: "Black" },
    { code: "§1", name: "Dark Blue" }, { code: "§2", name: "Dark Green" }, { code: "§3", name: "Dark Aqua" },
    { code: "§4", name: "Dark Red" }, { code: "§5", name: "Dark Purple" }, { code: "§6", name: "Gold" },
    { code: "§8", name: "Dark Gray" }, { code: "§9", name: "Blue" }, { code: "§a", name: "Light Green" },
    { code: "§b", name: "Aqua" }, { code: "§c", name: "Red" }, { code: "§d", name: "Light Purple" },
    { code: "§e", name: "Yellow" }, { code: "rainbow", name: "Rainbow" }
];

const CHAT_FORMAT_OPTIONS = [
    { code: "", name: "None" }, { code: "§k", name: "Obfuscated" },
    { code: "§l", name: "Bold" }, { code: "§o", name: "Italic" }
];

const BRACKET_OPTIONS = [
    { id: "none", open: "", close: "", name: "None" },
    { id: "square", open: "[", close: "]", name: "[rank]" },
    { id: "angle", open: "<", close: ">", name: "<rank>" },
    { id: "curly", open: "{", close: "}", name: "{rank}" },
    { id: "double_angle", open: "«", close: "»", name: "«rank»" },
    { id: "trigram", open: "☰", close: "☰", name: "☰rank☰" },
    { id: "arrows", open: "▲", close: "▼", name: "▲rank▼" },
    { id: "pipes", open: "|", close: "|", name: "|rank|" }
];

const BRACKET_COLOR_OPTIONS = COLOR_OPTIONS.filter(c => c.name !== "Rainbow");

const COLOR_DISPLAYS = COLOR_OPTIONS.map(c => {
    if (c.name === "Rainbow") return "§cR§6a§ei§an§bb§9o§5w§r";
    return `${c.code}${c.name}§r`;
});

const FORMAT_DISPLAYS = FORMAT_OPTIONS.map(f => `${f.code}${f.name}§r`);

const CHAT_COLOR_DISPLAYS = CHAT_COLOR_OPTIONS.map(c => {
    if (c.name === "None") return c.name;
    if (c.name === "Rainbow") return "§cR§6a§ei§an§bb§9o§5w§r";
    return `${c.code}${c.name}§r`;
});

const CHAT_FORMAT_DISPLAYS = CHAT_FORMAT_OPTIONS.map(f => `${f.code}${f.name}§r`);
const BRACKET_DISPLAYS = BRACKET_OPTIONS.map(b => b.name);
const BRACKET_COLOR_DISPLAYS = BRACKET_COLOR_OPTIONS.map(c => `${c.code}${c.name}§r`);

function parseUnicodeEscapes(str) {
    if (!str) return "";
    return str.replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function applyRainbow(text) {
    const colors = ["§c", "§6", "§e", "§a", "§b", "§9", "§5"];
    let result = "";
    let colorIndex = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === " ") { result += " "; continue; }
        result += colors[colorIndex % colors.length] + text[i];
        colorIndex++;
    }
    return result + "§r";
}

function buildRankTitleText(colorCode, formatCode, textInput, bracketOption, bracketColorCode) {
    let base = parseUnicodeEscapes(textInput);
    let openB = bracketOption ? bracketOption.open : "";
    let closeB = bracketOption ? bracketOption.close : "";
    let bColor = bracketColorCode || "§f";

    let textPart = "";
    if (colorCode === "rainbow") {
        textPart = applyRainbow(base).replace(/§r$/, '');
    } else {
        textPart = `${colorCode}${base}`;
    }

    let result = "";
    if (openB) {
        result += `${formatCode}${bColor}${openB}§r`;
    }
    result += `${formatCode}${textPart}§r`;
    if (closeB) {
        result += `${formatCode}${bColor}${closeB}§r`;
    }

    if (!openB && !closeB) {
        result = `${formatCode}${textPart}§r`;
    }

    return result;
}

function buildNickText(colorCode, formatCode, textInput) {
    let base = parseUnicodeEscapes(textInput);
    if (colorCode === "rainbow") {
        return `${formatCode}${applyRainbow(base).replace(/§r$/, '')}§r`;
    }
    return `${formatCode}${colorCode}${base}§r`;
}

function stripColors(str) {
    return str.replace(/§./g, "").replace(/§r$/, "").replace(/[\[\]]/g, "").trim();
}

// =============================================================================
// DATA HELPERS
// =============================================================================

export function getPlayerData(player) {
    try {
        const data = world.getDynamicProperty(`${PLAYER_DATA_PROPERTY}_${player.id}`);
        return data ? JSON.parse(data) : { activeRank: null, hideRank: false, customRanks: [], activeNick: null, hideNick: false, customNicks: [] };
    } catch (e) { return { activeRank: null, hideRank: false, customRanks: [], activeNick: null, hideNick: false, customNicks: [] }; }
}

export function savePlayerData(player, data) {
    try { world.setDynamicProperty(`${PLAYER_DATA_PROPERTY}_${player.id}`, JSON.stringify(data)); } catch (e) { }
}

function getCustomRanks() {
    try { const data = world.getDynamicProperty(CUSTOM_RANKS_PROPERTY); return data ? JSON.parse(data) : []; } catch (e) { return []; }
}

function saveCustomRanks(ranks) {
    try { world.setDynamicProperty(CUSTOM_RANKS_PROPERTY, JSON.stringify(ranks)); } catch (e) { }
}

export function getCustomNicks() {
    try { const data = world.getDynamicProperty(CUSTOM_NICKS_PROPERTY); return data ? JSON.parse(data) : []; } catch (e) { return []; }
}

export function saveCustomNicks(nicks) {
    try { world.setDynamicProperty(CUSTOM_NICKS_PROPERTY, JSON.stringify(nicks)); } catch (e) { }
}

export function getActiveRankDisplay(player, context = "head") {
    if (!isRanksFeatureEnabled()) return "";
    const data = getPlayerData(player);
    if (data.hideRank) return "";
    if (data.activeRank === "none") return "";

    const rankSystemEnabled = getRankSystemEnabled();
    const rankTitlesEnabled = getRankTitlesEnabled(); // now = custom ranks toggle

    if (data.activeRank) {
        // Custom ranks depend on the Rank Titles (custom ranks) toggle
        const custom = getCustomRanks().find(r => r.id === data.activeRank);
        if (custom) {
            if (!rankTitlesEnabled) return "";
            let display = custom.display;
            if (context === "head") {
                display = display.replace(/§k/g, "");
            }
            return display;
        }
        // Progression ranks depend on the Rank System toggle
        if (rankSystemEnabled) {
            const prog = RANKS.find(r => r.id === data.activeRank);
            if (prog) {
                return context === "chat" ? prog.chatIcon : prog.headIcon;
            }
        }
    }

    // Default member display — only show when the Rank System is enabled
    if (rankSystemEnabled) {
        return getMemberRankDisplay(getPoints(player));
    }

    return "";
}

export function getActiveNickDisplay(player) {
    if (!isRanksFeatureEnabled() || !getNicknamesEnabled()) return player.name;
    const data = getPlayerData(player);
    if (data.hideNick) return player.name;
    if (data.activeNick) {
        const custom = getCustomNicks().find(n => n.id === data.activeNick);
        if (custom) return custom.display;
    }
    return player.name;
}

// =============================================================================
// RANK SKILLS TOGGLE (For main.js to check)
// =============================================================================

export function getRankSkillsEnabled() {
    try {
        // Check if ranks feature is disabled in operator menu (Feature Toggles)
        const featureData = world.getDynamicProperty("zyd:feature_toggles");
        if (featureData) {
            const toggles = JSON.parse(featureData);
            if (toggles.ranks === false) return false;
        }

        // Check rank skills specific toggle
        const val = world.getDynamicProperty("zyd:rank_skills_enabled");
        if (val === false || val === "false") return false;
        return true;
    } catch (e) {
        return true;
    }
}

export function setRankSkillsEnabled(enabled) {
    try {
        world.setDynamicProperty("zyd:rank_skills_enabled", enabled);
        return true;
    } catch (e) {
        console.error("Failed to set rank skills enabled:", e);
        return false;
    }
}

// =============================================================================
// CORE HELPER FUNCTIONS
// =============================================================================

export function getPoints(player) {
    try {
        const obj = world.scoreboard.getObjective(POINTS_OBJ);
        if (!obj) return 0;
        return obj.getScore(player) ?? 0;
    } catch (e) { return 0; }
}

function setPoints(player, value) {
    try {
        let obj = world.scoreboard.getObjective(POINTS_OBJ);
        if (!obj) {
            world.scoreboard.addObjective(POINTS_OBJ, "Rank Points");
            obj = world.scoreboard.getObjective(POINTS_OBJ);
        }
        if (obj) obj.setScore(player, Math.min(value, MAX_POINTS));
    } catch (e) { console.warn("Failed to set points: " + e); }
}

function getMoney(player) {
    return getBalance(player);
}

function setMoney(player, value) {
    setBalance(player, value);
}

function getPlayerScore(player, objective) {
    try {
        const obj = world.scoreboard.getObjective(objective);
        return obj ? (obj.getScore(player) ?? 0) : 0;
    } catch (e) { return 0; }
}

function getRankFromPoints(points) {
    for (let i = 0; i < RANKS.length; i++) {
        if (points >= RANKS[i].req) return RANKS[i];
    }
    return RANKS[RANKS.length - 1];
}

function applyRankTag(player, rankTag) {
    for (const rank of RANKS) {
        if (player.hasTag(rank.tag)) player.removeTag(rank.tag);
    }
    if (!player.hasTag(rankTag)) player.addTag(rankTag);
}

export function getGlobalTop(player) {
    const players = world.getPlayers();
    const scores = players.map(p => ({ id: p.id, points: getPoints(p) }));
    scores.sort((a, b) => b.points - a.points);
    const index = scores.findIndex(s => s.id === player.id);
    return index !== -1 ? index + 1 : players.length;
}

export function getRankProgress(player) {
    const points = getPoints(player);
    const currentRank = getRankFromPoints(points);
    const nextRankIndex = RANKS.findIndex(r => r.id === currentRank.id) - 1;
    const nextRank = nextRankIndex >= 0 ? RANKS[nextRankIndex] : null;

    if (nextRank) {
        const progress = ((points - currentRank.req) / (nextRank.req - currentRank.req) * 100).toFixed(1);
        return progress + "%";
    }
    return "MAX";
}

function forceCommas(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// =============================================================================
// REWARD SYSTEM & CONFIG HELPERS
// =============================================================================

function formatEncName(enc) {
    const name = enc.id.replace("minecraft:", "").replace(/_/g, " ");
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    const levelStr = ROMAN[enc.level] || String(enc.level);
    return `${capitalized} ${levelStr}`;
}

function enchantsMatch(a, b) {
    const aList = (a || []).map(e => `${e.id}:${e.level}`).sort();
    const bList = (b || []).map(e => `${e.id}:${e.level}`).sort();
    if (aList.length !== bList.length) return false;
    for (let i = 0; i < aList.length; i++) { if (aList[i] !== bList[i]) return false; }
    return true;
}

function getRankRewards() {
    try { const data = world.getDynamicProperty(RANK_REWARDS_PROPERTY); return data ? JSON.parse(data) : {}; } catch (e) { return {}; }
}

function saveRankRewards(rewards) {
    try { world.setDynamicProperty(RANK_REWARDS_PROPERTY, JSON.stringify(rewards)); } catch (e) { console.error("[RANKS] Reward Save error:", e); }
}

function getRankEndRewards() {
    try { const data = world.getDynamicProperty(RANK_END_REWARDS_PROPERTY); return data ? JSON.parse(data) : {}; } catch (e) { return {}; }
}

function saveRankEndRewards(rewards) {
    try { world.setDynamicProperty(RANK_END_REWARDS_PROPERTY, JSON.stringify(rewards)); } catch (e) { console.error("[RANKS] End Reward Save error:", e); }
}

function loadRanksConfig() {
    try {
        const data = world.getDynamicProperty(RANK_CONFIG_PROPERTY);
        if (data) {
            const config = JSON.parse(data);
            for (const c of config) {
                const rank = RANKS.find(r => r.id === c.id);
                if (!rank) continue;
                if (typeof c.req === "number") rank.req = c.req;
                if (typeof c.name === "string" && c.name.trim()) rank.name = c.name;
                if (typeof c.title === "string") rank.title = c.title;
                if (typeof c.chatIcon === "string") rank.chatIcon = c.chatIcon;
                if (typeof c.headIcon === "string") rank.headIcon = c.headIcon;
            }
        }
    } catch (e) { }
}

function saveRanksConfig() {
    try {
        const config = RANKS.map(r => ({ id: r.id, req: r.req, name: r.name, title: r.title, chatIcon: r.chatIcon, headIcon: r.headIcon }));
        world.setDynamicProperty(RANK_CONFIG_PROPERTY, JSON.stringify(config));
    } catch (e) { }
}

// Apply saved rank requirements on script load (they persist across reloads now).
loadRanksConfig();

function getTempData(player) {
    try { const data = world.getDynamicProperty(`zyd:ranktemp_${player.id}`); return data ? JSON.parse(data) : null; } catch (e) { return null; }
}

function saveTempData(player, temp) {
    try { world.setDynamicProperty(`zyd:ranktemp_${player.id}`, JSON.stringify(temp)); } catch (e) { }
}

function clearTempData(player) {
    try { world.setDynamicProperty(`zyd:ranktemp_${player.id}`, undefined); } catch (e) { }
}

function getInventoryItems(player) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return [];
    const items = [];
    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (!item) continue;
        let enchantments = [];
        try {
            const enchantable = item.getComponent("minecraft:enchantable");
            if (enchantable) {
                for (const enc of enchantable.getEnchantments()) {
                    enchantments.push({ id: enc.type.id, level: enc.level });
                }
            }
        } catch (e) { }
        const baseName = item.typeId.replace("minecraft:", "").replace(/_/g, " ");
        const name = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        items.push({ id: item.typeId, name: name, count: item.amount, enchantments: enchantments });
    }
    return items;
}

function buildItemDropdown(player, savedItems) {
    const invItems = getInventoryItems(player);
    const options = [{ display: "Nothing", id: null, count: 0, enchantments: [] }];
    for (const item of invItems) {
        let display = item.name;
        if (item.enchantments.length > 0) display += ` [${item.enchantments.map(e => formatEncName(e)).join(", ")}]`;
        if (item.count > 1) display += ` (x${item.count})`;
        options.push({ display: display, id: item.id, count: item.count, enchantments: item.enchantments });
    }

    const defaultIndices = [];
    for (const savedItem of savedItems) {
        if (!savedItem || !savedItem.id) { defaultIndices.push(0); continue; }
        let foundIndex = -1;
        for (let i = 1; i < options.length; i++) {
            if (options[i].id === savedItem.id && enchantsMatch(options[i].enchantments, savedItem.enchantments)) { foundIndex = i; break; }
        }
        if (foundIndex !== -1) {
            defaultIndices.push(foundIndex);
        } else {
            let display = `[Saved] ${savedItem.id.replace("minecraft:", "").replace(/_/g, " ")}`;
            if (savedItem.enchantments && savedItem.enchantments.length > 0) display += ` [${savedItem.enchantments.map(e => formatEncName(e)).join(", ")}]`;
            if (savedItem.count > 1) display += ` (x${savedItem.count})`;
            options.push({ display: display, id: savedItem.id, count: savedItem.count, enchantments: savedItem.enchantments || [] });
            defaultIndices.push(options.length - 1);
        }
    }
    return { options, defaultIndices, displayNames: options.map(o => o.display) };
}

// =============================================================================
// INITIALIZATION & RANK UP/DOWN LOGIC
// =============================================================================

world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) {
        const player = event.player;
        const points = getPoints(player);
        if (points === 0) setPoints(player, 0);
        const rank = getRankFromPoints(points);
        applyRankTag(player, rank.tag);
        updateTrackedPlayer(player);
        initializeDefaultRewards();
        initializeDefaultEndRewards();
    }
});

world.afterEvents.playerLeave.subscribe((event) => {
    loadRankTracker();
    saveRankTracker();
});

world.afterEvents.entityDie.subscribe((event) => {
    if (!isRanksFeatureEnabled()) return;

    const deadEntity = event.deadEntity;
    const killer = event.damageSource?.damagingEntity;

    // ==========================================
    // ANTI-FARM CHECK (1HR COOLDOWN & 0 POINTS)
    // ==========================================
    if (killer && killer.typeId === "minecraft:player" && deadEntity.typeId === "minecraft:player") {
        const killCdKey = `zyd:rank_kill_cd_${killer.id}_${deadEntity.id}`;
        const lastKillTime = world.getDynamicProperty(killCdKey) || 0;

        // 1. Check if killer farmed this victim within the last hour
        if (Date.now() - lastKillTime < RANK_KILL_COOLDOWN_MS) {
            const remaining = RANK_KILL_COOLDOWN_MS - (Date.now() - lastKillTime);
            const minutes = Math.floor(remaining / 60000);
            const seconds = Math.floor((remaining % 60000) / 1000);
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            try {
                killer.sendMessage(`§c[Rank] You already killed §f${deadEntity.name}§c. Please wait §e${timeStr} §cbefore getting points from them again.`);
            } catch (e) { }
            return;
        }

        // 2. Check if victim is already at 0 points
        if (getPoints(deadEntity) <= 0) {
            try {
                killer.sendMessage(`§7[Rank] §f${deadEntity.name} §7has no points left to give.`);
            } catch (e) { }
            return;
        }

        // 3. If they passed both checks, set the 1-hour cooldown
        world.setDynamicProperty(killCdKey, Date.now());
    }
    // ==========================================

    // KILLER LOGIC
    if (killer && killer.typeId === "minecraft:player" && (!TEST_ENTITIES || deadEntity.typeId === "minecraft:player")) {
        try {
            const currentPoints = getPoints(killer);
            const currentRank = getRankFromPoints(currentPoints);
            const pointsGained = Math.floor(Math.random() * (currentRank.max - currentRank.min + 1)) + currentRank.min;
            const newPoints = currentPoints + pointsGained;
            setPoints(killer, newPoints);

            const newRank = getRankFromPoints(newPoints);
            if (newRank.id !== currentRank.id) {
                applyRankTag(killer, newRank.tag);
                const data = getPlayerData(killer);
                // Only auto-equip the new progression rank display if the player was
                // already showing their progression rank (or never chose anything yet).
                // If they explicitly unequipped ("none") or have a custom rank equipped,
                // leave their display choice alone — points/tier still update either way.
                const wasFollowingProgression = data.activeRank === null || data.activeRank === undefined || data.activeRank === currentRank.id;
                if (wasFollowingProgression) {
                    data.activeRank = newRank.id;
                }
                data.hideRank = false;
                savePlayerData(killer, data);

                killer.sendMessage(`§a§lRANK UP! §rYou are now ${newRank.title}§a!`);
                killer.playSound("random.levelup");
                giveRankReward(killer, newRank.id);
            }
            updateTrackedPlayer(killer);
        } catch (e) { console.warn("Ranks Kill Tracking Error: " + e); }
    }

    // DEATH PENALTY LOGIC
    if (deadEntity.typeId === "minecraft:player") {
        const loseMode = world.getDynamicProperty(LOSE_POINTS_MODE_PROPERTY) ?? 0;
        const isPlayerKill = killer && killer.typeId === "minecraft:player";

        if ((loseMode === 1 && isPlayerKill) || (loseMode === 2)) {
            try {
                const deadPlayer = deadEntity;
                const currentPoints = getPoints(deadPlayer);
                const currentRank = getRankFromPoints(currentPoints);

                const pointsLost = Math.floor(Math.random() * (currentRank.max - currentRank.min + 1)) + currentRank.min;
                const newPoints = Math.max(0, currentPoints - pointsLost);
                setPoints(deadPlayer, newPoints);

                const newRank = getRankFromPoints(newPoints);
                if (newRank.id !== currentRank.id) {
                    applyRankTag(deadPlayer, newRank.tag);
                    const data = getPlayerData(deadPlayer);
                    if (data.activeRank === currentRank.id) data.activeRank = newRank.id;
                    savePlayerData(deadPlayer, data);

                    deadPlayer.sendMessage(`§c§lRANK DOWN! §rYou are now ${newRank.title}§c! (-${forceCommas(pointsLost)} pts)`);
                    deadPlayer.playSound("random.break");
                } else {
                    deadPlayer.sendMessage(`§cYou lost §e${forceCommas(pointsLost)} §cpoints!`);
                }
                updateTrackedPlayer(deadPlayer);
            } catch (e) { console.warn("Ranks Death Penalty Error: " + e); }
        }
    }
});

function giveRankReward(player, rankId) {
    const rewards = getRankRewards();
    const reward = rewards[rankId];
    if (!reward) return;

    const moneyAmount = reward.money || 0;
    const validItems = (reward.items || []).filter(item => item && item.id);

    if (moneyAmount > 0) {
        setMoney(player, getMoney(player) + moneyAmount);
    }

    if (validItems.length > 0) {
        const inv = player.getComponent("minecraft:inventory").container;
        for (const item of validItems) {
            try {
                const itemStack = new ItemStack(item.id, item.count);
                if (item.enchantments && item.enchantments.length > 0) {
                    const enchantable = itemStack.getComponent("minecraft:enchantable");
                    if (enchantable) {
                        for (const enc of item.enchantments) {
                            try { const t = EnchantmentTypes.get(enc.id); if (t) enchantable.addEnchantment({ type: t, level: enc.level }); } catch (e) { }
                        }
                    }
                }
                inv.addItem(itemStack);
            } catch (e) { console.error(`Failed to give rank item ${item.id}`, e); }
        }
    }

    if (moneyAmount > 0 || validItems.length > 0) {
        let msg = `§6----------------------\n§6[Rank Reward] You received rewards for ranking up!\n§6----------------------\n`;
        if (moneyAmount > 0) msg += `§7Money: §a+${forceCommas(moneyAmount)}\n`;
        if (validItems.length > 0) {
            msg += `§7Items:\n`;
            for (const item of validItems) {
                let encString = (item.enchantments && item.enchantments.length > 0) ? ` §e[${item.enchantments.map(e => formatEncName(e)).join(", ")}]` : "";
                msg += `   §f- ${item.id.replace("minecraft:", "").replace(/_/g, " ")} (x${item.count})${encString}\n`;
            }
        }
        msg += `§6----------------------`;
        player.sendMessage(msg);
    }
}

// =============================================================================
// SEASON SYSTEM LOGIC
// =============================================================================

system.runInterval(() => {
    const durationIdx = world.getDynamicProperty(SEASON_DURATION_PROPERTY) ?? 13;
    const duration = SEASON_OPTIONS[durationIdx].ms;
    if (duration === 0) return;

    const startTime = world.getDynamicProperty(SEASON_START_PROPERTY) || Date.now();
    if (Date.now() >= startTime + duration) {
        executeEndSeason();
    }
}, 400);

function executeEndSeason() {
    world.sendMessage("§c§lSEASON ENDED! §r§eResetting ranks 2 tiers down and distributing end rewards...");
    const endRewards = getRankEndRewards();

    for (const player of world.getPlayers()) {
        const currentPoints = getPoints(player);
        const currentRank = getRankFromPoints(currentPoints);

        const reward = endRewards[currentRank.id];
        if (reward) {
            const moneyAmount = reward.money || 0;
            const validItems = (reward.items || []).filter(item => item && item.id);

            if (moneyAmount > 0) {
                setMoney(player, getMoney(player) + moneyAmount);
            }

            if (validItems.length > 0) {
                const inv = player.getComponent("minecraft:inventory").container;
                for (const item of validItems) {
                    try {
                        const itemStack = new ItemStack(item.id, item.count);
                        if (item.enchantments && item.enchantments.length > 0) {
                            const enchantable = itemStack.getComponent("minecraft:enchantable");
                            if (enchantable) {
                                for (const enc of item.enchantments) {
                                    try { const t = EnchantmentTypes.get(enc.id); if (t) enchantable.addEnchantment({ type: t, level: enc.level }); } catch (e) { }
                                }
                            }
                        }
                        inv.addItem(itemStack);
                    } catch (e) { console.error(`Failed to give end season item ${item.id}`, e); }
                }
            }

            if (moneyAmount > 0 || validItems.length > 0) {
                let msg = `§6----------------------\n§6[Season End Reward] For finishing at ${currentRank.title}!\n§6----------------------\n`;
                if (moneyAmount > 0) msg += `§7Money: §a+${forceCommas(moneyAmount)}\n`;
                if (validItems.length > 0) {
                    msg += `§7Items:\n`;
                    for (const item of validItems) {
                        let encString = (item.enchantments && item.enchantments.length > 0) ? ` §e[${item.enchantments.map(e => formatEncName(e)).join(", ")}]` : "";
                        msg += `   §f- ${item.id.replace("minecraft:", "").replace(/_/g, " ")} (x${item.count})${encString}\n`;
                    }
                }
                msg += `§6----------------------`;
                player.sendMessage(msg);
            }
        }

        const currentRankIndex = RANKS.findIndex(r => r.id === currentRank.id);
        let newRankIndex = Math.min(currentRankIndex + 2, RANKS.length - 1);
        const newRank = RANKS[newRankIndex];

        setPoints(player, newRank.req);
        applyRankTag(player, newRank.tag);

        const data = getPlayerData(player);
        // Same wardrobe rule as normal rank ups: don't disturb an explicit
        // "none" unequip or a custom rank the player chose to wear.
        const wasFollowingProgression = data.activeRank === null || data.activeRank === undefined || data.activeRank === currentRank.id;
        if (wasFollowingProgression) {
            data.activeRank = newRank.id;
        }
        savePlayerData(player, data);

        player.sendMessage(`§cYou have been demoted to ${newRank.title}. Better luck next season!`);
        updateTrackedPlayer(player);
    }

    world.setDynamicProperty(SEASON_START_PROPERTY, Date.now());
}

// =============================================================================
// CHAT STYLE HELPER
// =============================================================================

function getActiveChatStyle(player) {
    const data = getPlayerData(player);
    if (data.activeNick) {
        const custom = getCustomNicks().find(n => n.id === data.activeNick);
        if (custom) {
            return { color: custom.chatColor || "", format: custom.chatFormat || "" };
        }
    }
    return { color: "", format: "" };
}

// =============================================================================
// FEATURE TOGGLE HELPER (Reads directly to avoid circular imports)
// =============================================================================

function isRanksFeatureEnabled() {
    try {
        const data = world.getDynamicProperty("zyd:feature_toggles");
        if (data) {
            const toggles = JSON.parse(data);
            if (toggles.ranks === false) return false;
        }
        return true;
    } catch (e) {
        return true;
    }
}

const RANK_SYSTEM_ENABLED_PROPERTY = "zyd:rank_system_enabled";
const RANK_TITLES_ENABLED_PROPERTY = "zyd:rank_titles_enabled";
const NICKNAMES_ENABLED_PROPERTY = "zyd:nicknames_enabled";

// Controls points, leaderboard, and progression ranks (Noob..Death God).
function getRankSystemEnabled() {
    try {
        const val = world.getDynamicProperty(RANK_SYSTEM_ENABLED_PROPERTY);
        if (val === false || val === "false") return false;
        return true;
    } catch (e) {
        return true;
    }
}

function setRankSystemEnabled(enabled) {
    try {
        world.setDynamicProperty(RANK_SYSTEM_ENABLED_PROPERTY, enabled);
    } catch (e) { }
}

// Controls custom-made ranks (created by operators via "Create Rank Title").
function getRankTitlesEnabled() {
    try {
        const val = world.getDynamicProperty(RANK_TITLES_ENABLED_PROPERTY);
        if (val === false || val === "false") return false;
        return true;
    } catch (e) {
        return true;
    }
}

function setRankTitlesEnabled(enabled) {
    try {
        world.setDynamicProperty(RANK_TITLES_ENABLED_PROPERTY, enabled);
    } catch (e) { }
}

function getNicknamesEnabled() {
    try {
        const val = world.getDynamicProperty(NICKNAMES_ENABLED_PROPERTY);
        if (val === false || val === "false") return false;
        return true;
    } catch (e) {
        return true;
    }
}

function setNicknamesEnabled(enabled) {
    try {
        world.setDynamicProperty(NICKNAMES_ENABLED_PROPERTY, enabled);
    } catch (e) { }
}

// =============================================================================
// FACTION PREFIX HELPER (Reads directly to avoid circular imports)
// =============================================================================

function getFactionPrefix(playerId) {
    try {
        // Check if factions feature is disabled
        const toggleData = world.getDynamicProperty("zyd:feature_toggles");
        if (toggleData) {
            const toggles = JSON.parse(toggleData);
            if (toggles.factions === false) return "";
        }

        const factionId = world.getDynamicProperty("zyd:fplayer_" + playerId);
        if (!factionId || factionId === "") return "";
        const rawFactions = world.getDynamicProperty("zyd:factions_data");
        if (!rawFactions) return "";
        const factions = JSON.parse(rawFactions);
        const faction = factions[factionId];
        if (!faction) return "";
        const iconUnicode = faction.iconUnicode || "";
        const factionName = faction.name || "";
        if (!iconUnicode && !factionName) return "";
        return `${iconUnicode} ${factionName} `;
    } catch (e) { return ""; }
}

// =============================================================================
// FACTION RELATIONSHIP CHAT COLOR (POV Based)
// =============================================================================
function getChatFactionColor(viewerId, targetFactionId, factionsCache) {
    if (!targetFactionId) return "§b"; // Default light blue if no faction
    const viewerFactionId = world.getDynamicProperty("zyd:fplayer_" + viewerId);

    // If viewer has no faction, or is in the SAME faction, show default color
    if (!viewerFactionId || viewerFactionId === targetFactionId) return "§b";

    const viewerFaction = factionsCache[viewerFactionId];
    if (!viewerFaction) return "§b";

    // Check if target is an enemy -> Red
    if ((viewerFaction.enemies || []).some(e => e.factionId === targetFactionId)) return "§c";
    // Check if target is an ally -> Yellow
    if ((viewerFaction.allies || []).includes(targetFactionId)) return "§e";

    return "§b"; // Neutral -> Default light blue
}

// =============================================================================
// NAMETAG & CHAT FORMATTING
// =============================================================================

system.runInterval(() => {
    for (const player of world.getPlayers()) {
        const factionPrefix = getFactionPrefix(player.id);

        let rankDisplay = "";
        let name = player.name;

        if (isRanksFeatureEnabled()) {
            rankDisplay = getActiveRankDisplay(player, "head");
            name = getActiveNickDisplay(player);
        }

        // Auto-revoke flight if the player lost rank-based fly permission —
        // rank unequipped/changed, custom rank edited to remove fly, custom
        // rank deleted, or Rank Skills disabled globally. OPs are exempt since
        // their fly access never depended on rank permissions.
        if (!player.hasTag("op") && isFlyEnabled(player) && (!getRankSkillsEnabled() || !isCommandEnabledForPlayer(player, "fly"))) {
            forceDisableFly(player);
        }

        // If in a faction, put faction above name using \n
        if (factionPrefix && factionPrefix.trim() !== "") {
            player.nameTag = `§r${factionPrefix.trim()}\n${rankDisplay} §f<${name}>`;
        } else {
            player.nameTag = `${rankDisplay} §f<${name}>`;
        }

        // Native v2.10.0+ Player Chat Properties
        try {
            const rankPart = getActiveRankDisplay(player, "chat");
            const fullPrefix = `${factionPrefix ? factionPrefix.trim() + " " : ""}${rankPart}`.trim();

            player.chatNamePrefix = fullPrefix ? `${fullPrefix} ` : "";
            player.chatDisplayName = name;
        } catch (e) { }
    }
}, 20);

function handleChatMessage(sender, rawMsg) {
    if (!sender || !sender.isValid) return;

    const factionPrefix = getFactionPrefix(sender.id);
    let rankDisplay = "";
    let name = sender.name;
    let msg = rawMsg;

    if (isRanksFeatureEnabled()) {
        rankDisplay = getActiveRankDisplay(sender, "chat");
        name = getActiveNickDisplay(sender);

        const chatStyle = getActiveChatStyle(sender);
        if (chatStyle.color === "rainbow") {
            msg = chatStyle.format + applyRainbow(rawMsg).replace(/§r$/, '') + "§r";
        } else if (chatStyle.color) {
            msg = chatStyle.format + chatStyle.color + rawMsg + "§r";
        } else if (chatStyle.format) {
            msg = chatStyle.format + rawMsg + "§r";
        }
    }

    const senderFactionId = world.getDynamicProperty("zyd:fplayer_" + sender.id);
    let factionsCache = {};
    try {
        const rawFactions = world.getDynamicProperty("zyd:factions_data");
        if (rawFactions) factionsCache = JSON.parse(rawFactions);
    } catch (e) { }

    const players = world.getPlayers();
    for (const viewer of players) {
        if (!viewer || !viewer.isValid) continue;
        const relColor = getChatFactionColor(viewer.id, senderFactionId, factionsCache);
        const coloredPrefix = relColor + (factionPrefix ? factionPrefix.trim() : "");
        const formattedRank = rankDisplay ? `${rankDisplay} ` : "";
        const prefixPart = coloredPrefix ? `${coloredPrefix} ` : "";

        viewer.sendMessage(`${prefixPart}${formattedRank}§f<${name}>: §f${msg}`);
    }
}

system.run(() => {
    const chatSignal = world.beforeEvents?.chatSend ?? world.afterEvents?.chatSend;
    if (chatSignal && typeof chatSignal.subscribe === "function") {
        chatSignal.subscribe((event) => {
            if ("cancel" in event) {
                event.cancel = true;
            }
            const sender = event.sender;
            const message = event.message;

            system.run(() => {
                handleChatMessage(sender, message);
            });
        });
    }
});

// =============================================================================
// LEADERBOARD
// =============================================================================

function getCategoryPlayers(rankId) {
    loadRankTracker();
    const scoresMap = new Map();

    for (const [id, info] of trackedPlayers) {
        scoresMap.set(id, { name: info.nick || info.name, points: info.points, isOnline: false });
    }

    for (const player of world.getPlayers()) {
        const pts = getPoints(player);
        const nick = getActiveNickDisplay(player);
        scoresMap.set(player.id, { name: nick, points: pts, isOnline: true });
    }

    const list = [];
    for (const [id, data] of scoresMap) {
        if (getRankFromPoints(data.points).id === rankId) {
            list.push({ id: id, name: data.name, points: data.points, isOnline: data.isOnline });
        }
    }

    list.sort((a, b) => b.points - a.points);
    return list;
}

// =============================================================================
// RANKS UI
// =============================================================================

function showLeaderboard(player) {
    const form = new ActionFormData()
        .title("§b§lLeaderboard")
        .body("§7Select a rank to view its top players.");

    for (const rank of RANKS) {
        const topPlayer = getCategoryPlayers(rank.id)[0];
        const subtext = topPlayer ? topPlayer.name : "- Empty -";
        form.button(`${rank.title}\n§f${subtext}`, rank.icon);
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === RANKS.length) { showRanks(player); return; }
        if (res.selection >= 0 && res.selection < RANKS.length) {
            showLeaderboardCategory(player, RANKS[res.selection].id, 0);
        }
    });
}

function showLeaderboardCategory(player, rankId, page) {
    const rank = RANKS.find(r => r.id === rankId);
    const players = getCategoryPlayers(rankId);

    const pageSize = 100;
    const start = page * pageSize;
    const end = start + pageSize;

    let body = "";
    if (page === 0) body += "Top 100 players\n\n";
    else body += `Players ${start + 1} - ${Math.min(end, players.length)}\n\n`;

    body += `Rank: ${rank.headIcon} - ${forceCommas(rank.req)} pts\n\n`;

    if (getRankSkillsEnabled()) {
        const config = getRankCommandConfig();
        const skills = RANK_COMMANDS.filter(c => config[rank.id] && config[rank.id][c.id] === true);
        if (skills.length > 0) {
            body += `§8--------§r\n`;
            body += `§7Commands:\n`;
            for (const skill of skills) body += `§f${skill.desc}\n`;
            body += `§8--------§r\n\n`;
        }
    }

    const pagePlayers = players.slice(start, end);
    if (pagePlayers.length === 0) {
        body += "- Empty -";
    } else {
        for (let i = 0; i < pagePlayers.length; i++) {
            const p = pagePlayers[i];
            let numColor = "§f";
            if (start + i === 0) numColor = "§a";
            else if (start + i === 1) numColor = "§e";
            else if (start + i === 2) numColor = "§c";

            body += `${numColor}${start + i + 1}. ${p.name} §f- §6(${forceCommas(p.points)} pts)\n`;
        }
    }

    const form = new ActionFormData()
        .title(`§b§l${rank.name} Leaderboard`)
        .body(body);

    let index = 0;
    let prevIdx = -1, nextIdx = -1;

    if (page > 0) {
        form.button("§e§lPrevious Page\n§f[ Back ]", "textures/ranks/back.png");
        prevIdx = index++;
    }
    if (players.length > end) {
        form.button("§e§lNext Page\n§f[ Forward ]", "textures/list.png");
        nextIdx = index++;
    }

    form.button("§cBack to Leaderboard", "textures/ranks/back.png");
    const backIdx = index;

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === prevIdx) showLeaderboardCategory(player, rankId, page - 1);
        else if (res.selection === nextIdx) showLeaderboardCategory(player, rankId, page + 1);
        else if (res.selection === backIdx) showLeaderboard(player);
    });
}

export function showRanks(player) {
    const points = getPoints(player);
    const currentRank = getRankFromPoints(points);
    const nextRankIndex = RANKS.findIndex(r => r.id === currentRank.id) - 1;
    const nextRank = nextRankIndex >= 0 ? RANKS[nextRankIndex] : null;

    const globalTop = getGlobalTop(player);
    const isOp = player.hasTag("op");

    const rankSystemEnabled = getRankSystemEnabled();
    const rankTitlesEnabled = getRankTitlesEnabled();
    const showWardrobeButton = rankSystemEnabled || rankTitlesEnabled;

    let body = `\n`;
    if (rankSystemEnabled) {
        body += `§7Current Rank: ${currentRank.headIcon}\n`;
        body += `\n`;
        if (nextRank) {
            body += `§7Next Rank: §f${nextRank.name} §8(§f${forceCommas(nextRank.req)} pts§8)\n`;
        } else {
            body += `§7Next Rank: §cMAX RANK REACHED!\n`;
        }
        body += `§7Global Top: §b#${globalTop}\n`;
        body += `§7Rank Points: §e${forceCommas(points)}\n`;

        if (TEST_ENTITIES) {
            const totalKills = getPlayerScore(player, "Kills");
            const playerKills = getPlayerScore(player, "PlayerKills");
            body += `§7Rank Kills: §c${totalKills} §8(§f${playerKills} Players§8)\n`;
        } else {
            const playerKills = getPlayerScore(player, "PlayerKills");
            body += `§7Rank Kills: §c${playerKills}\n`;
        }

        if (nextRank) {
            const progress = ((points - currentRank.req) / (nextRank.req - currentRank.req) * 100).toFixed(1);
            body += `§7Progress: §b${progress}%\n`;
        }
    }
    body += `\n`;

    const nicknamesEnabled = getNicknamesEnabled();

    const form = new ActionFormData()
        .title("§6§lRank System Info")
        .body(body);

    if (rankSystemEnabled) form.button("§b§lLeaderboard\n§f[ Top Players ]", "textures/list.png");
    if (showWardrobeButton) form.button("§e§lRank Titles\n§f[ Equip / Unequip ]", "textures/ranks/myranks.png");
    if (nicknamesEnabled) form.button("§d§lNicknames\n§f[ Equip / Unequip ]", "textures/name.png");

    if (isOp) {
        form.button("§6§lSettings\n§f[ OP Exclusive ]", "textures/hologram_edit.png");
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        // Actions are pushed in the exact same order (and same conditions)
        // as the buttons above, so indices always line up.
        const actions = [];
        if (rankSystemEnabled) actions.push(() => showLeaderboard(player));
        if (showWardrobeButton) actions.push(() => showRankTitles(player));
        if (nicknamesEnabled) actions.push(() => showNicknames(player));
        if (isOp) actions.push(() => showSettings(player));
        actions.push(() => {
            import("./menu.js").then(mod => {
                if (typeof mod.showMenu === "function") mod.showMenu(player);
            }).catch(err => { player.sendMessage("§cMenu module not found!"); });
        });

        const action = actions[response.selection];
        if (action) action();
    });
}

// =============================================================================
// SETTINGS (OP EXCLUSIVE)
// =============================================================================

function showSettings(player) {
    const desc = "§7Manage ranks, nicknames, and leaderboard settings.\n\n" +
        "§eCreate Rank Title §7- Make custom ranks with colors & brackets.\n" +
        "§dCreate Nickname §7- Make custom names with chat colors.\n" +
        "§bEdit Leaderboard Ranks §7- Set points, rewards, & season end.\n" +
        "§fRank Title List §7- Manage & give custom ranks to players.\n" +
        "§6Nickname List §7- Manage & give custom nicknames to players.\n" +
        "§9Unicode List §7- View special icons you can use in ranks.\n" +
        "§aPlayer List §7- Manage player points & data.";

    const form = new ActionFormData()
        .title("§6§lSettings")
        .body(desc)
        .button("§e§lCreate Rank Title", "textures/hologram_edit.png")
        .button("§d§lCreate Nickname", "textures/hologram_edit.png")
        .button("§b§lEdit Leaderboard Ranks", "textures/settings.png")
        .button("§f§lRank Title List", "textures/list.png")
        .button("§6§lNickname List", "textures/list.png")
        .button("§9§lUnicode List", "textures/ranks/myranks.png")
        .button("§a§lPlayer List", "textures/tpa2.png")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === 0) showCreateRank(player);
        else if (response.selection === 1) showCreateNick(player);
        else if (response.selection === 2) showEditLeaderboardMenu(player);
        else if (response.selection === 3) showOPRankList(player);
        else if (response.selection === 4) showOPNickList(player);
        else if (response.selection === 5) showUnicodeList(player);
        else if (response.selection === 6) showOPPlayerList(player);
        else showRanks(player);
    });
}

// =============================================================================
// EDIT LEADERBOARD RANKS MENU
// =============================================================================

function showEditLeaderboardMenu(player) {
    const skillsStatus = getRankSkillsEnabled() ? "§aON" : "§cOFF";
    const rankSystemOn = getRankSystemEnabled();
    const rankTitlesOn = getRankTitlesEnabled();
    const nicksOn = getNicknamesEnabled();

    let body = "§7Configure leaderboard ranks, toggles, and season.\n\n";
    body += `§bRank System: ${rankSystemOn ? "§aON" : "§cOFF"} §8| Points, Leaderboard & Progression\n`;
    body += `§eRank Titles: ${rankTitlesOn ? "§aON" : "§cOFF"} §8| Custom-Made Ranks\n`;
    body += `§dNicknames: ${nicksOn ? "§aON" : "§cOFF"} §8| Chat & Nametag\n`;
    body += `§9Rank Skills: ${skillsStatus} §8| Rank Commands\n`;
    body += `§6Rank Requirements §8| Set Points Per Rank\n`;
    body += `§aRank Rewards §8| Rank Up Items & Money\n`;
    body += `§5End Season Rewards §8| Season End Items & Money\n`;
    body += `§cEnd Season Settings §8| Duration, Lose Mode, Force End`;

    const form = new ActionFormData()
        .title("§b§lEdit Leaderboard Ranks")
        .body(body)
        .button(`§b§lToggle Rank System\n§f[ ${rankSystemOn ? "§aON" : "§cOFF"} §f| Points & Leaderboard ]`)
        .button(`§e§lToggle Rank Titles\n§f[ ${rankTitlesOn ? "§aON" : "§cOFF"} §f| Custom-Made Ranks ]`)
        .button(`§d§lToggle Nicknames\n§f[ ${nicksOn ? "§aON" : "§cOFF"} §f| Chat & Nametag ]`)
        .button(`§9§lToggle Rank Skills\n§f[ ${skillsStatus} §f| Rank Commands ]`)
        .button("§6§lRank Settings\n§f[ Points & Commands Per Rank ]")
        .button("§a§lRank Rewards\n§f[ Rank Up Items & Money ]")
        .button("§d§lEnd Season Rewards\n§f[ Season End Items & Money ]")
        .button("§c§lEnd Season Settings\n§f[ Duration, Lose Mode, Force End ]")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) {
            const newState = !rankSystemOn;
            setRankSystemEnabled(newState);
            if (!newState) {
                // Turning OFF: auto-unequip anyone displaying a progression/member rank.
                // Custom ranks are untouched — they're controlled by the separate toggle below.
                for (const p of world.getPlayers()) {
                    const pData = getPlayerData(p);
                    const isProgressionOrMember = !pData.activeRank || pData.activeRank === "member" || RANK_TIERS[pData.activeRank] !== undefined;
                    if (isProgressionOrMember) {
                        pData.activeRank = "none";
                        savePlayerData(p, pData);
                    }
                }
                player.sendMessage("§bRank System is now §cDISABLED§b. Points, leaderboard, and progression ranks are hidden/unequipped. Custom rank titles are unaffected.");
            } else {
                // Turning ON: let players with no active rank show the default member rank again
                for (const p of world.getPlayers()) {
                    const pData = getPlayerData(p);
                    if (!pData.activeRank || pData.activeRank === "none") {
                        pData.activeRank = null;
                        savePlayerData(p, pData);
                    }
                }
                player.sendMessage("§bRank System is now §aENABLED§b. Points, leaderboard, and progression ranks are active again.");
            }
            showEditLeaderboardMenu(player);
        }
        else if (res.selection === 1) {
            const newState = !rankTitlesOn;
            setRankTitlesEnabled(newState);
            if (!newState) {
                // Turning OFF: auto-unequip anyone wearing a custom-made rank.
                // Progression/member ranks are untouched — controlled by Rank System above.
                const customIds = getCustomRanks().map(r => r.id);
                for (const p of world.getPlayers()) {
                    const pData = getPlayerData(p);
                    if (pData.activeRank && customIds.includes(pData.activeRank)) {
                        pData.activeRank = "none";
                        savePlayerData(p, pData);
                    }
                }
                player.sendMessage("§eCustom Rank Titles are now §cDISABLED§e. Custom ranks unequipped from players.");
            } else {
                player.sendMessage("§eCustom Rank Titles are now §aENABLED§e.");
            }
            showEditLeaderboardMenu(player);
        }
        else if (res.selection === 2) {
            setNicknamesEnabled(!nicksOn);
            player.sendMessage(`§dNicknames are now ${!nicksOn ? "§aENABLED" : "§cDISABLED"}.`);
            showEditLeaderboardMenu(player);
        }
        else if (res.selection === 3) {
            const isCurrentlyEnabled = getRankSkillsEnabled();
            const newState = !isCurrentlyEnabled;
            setRankSkillsEnabled(newState);

            if (newState) {
                player.sendMessage("§a§l✔ Rank skills have been §aENABLED§r§a!");
                world.sendMessage("§9§l[SKILLS] §r§aRank skills have been enabled by an operator.");
            } else {
                player.sendMessage("§c§l✔ Rank skills have been §cDISABLED§r§c!");
                world.sendMessage("§9§l[SKILLS] §r§cRank skills have been disabled by an operator.");
            }
            player.playSound("random.levelup");
            showEditLeaderboardMenu(player);
        }
        else if (res.selection === 4) showRankSettings(player);
        else if (res.selection === 5) showRankRewardList(player);
        else if (res.selection === 6) showEndRewardList(player);
        else if (res.selection === 7) showEndSeasonSettings(player);
        else showSettings(player);
    });
}

function showRankSettings(player) {
    const form = new ActionFormData()
        .title("§6§lRank Settings")
        .body("§7Select a rank to edit its points requirement and command toggles.");

    for (const rank of RANKS) {
        form.button(`${rank.title}\n§f${forceCommas(rank.req)} pts`);
    }
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === RANKS.length) { showEditLeaderboardMenu(player); return; }
        showEditRankSettings(player, RANKS[res.selection].id);
    });
}

function showEditRankSettings(player, rankId) {
    const rank = RANKS.find(r => r.id === rankId);
    const config = getRankCommandConfig();
    const rankConfig = config[rankId] || {};
    const hasReq = rankId !== "noob";

    const form = new ModalFormData()
        .title(`§6§lRank Settings: ${rank.name}`)
        .textField("§7Rank Title §8(menus & messages, § codes allowed):", "§4[Death God]§r", { defaultValue: rank.title })
        .textField("§7Head Icon §8(shown above head):", "", { defaultValue: rank.headIcon })
        .textField("§7Chat Icon §8(shown in chat):", "", { defaultValue: rank.chatIcon });

    if (hasReq) {
        form.textField("§7Points Requirement:", "0", { defaultValue: String(rank.req) });
    }

    for (const cmd of RANK_COMMANDS) {
        form.toggle(`§7${cmd.desc}`, { defaultValue: rankConfig[cmd.id] === true });
    }

    form.show(player).then(res => {
        if (res.canceled) { showRankSettings(player); return; }

        let idx = 0;
        rank.title = String(res.formValues[idx] || "");
        rank.headIcon = String(res.formValues[idx + 1] || "");
        rank.chatIcon = String(res.formValues[idx + 2] || "");
        idx += 3;

        // Rank Name follows the Rank Title (they are one thing): plain text of the title.
        const plainTitle = stripColors(rank.title);
        if (plainTitle) rank.name = plainTitle;

        if (hasReq) {
            const val = parseInt(res.formValues[idx]);
            if (!isNaN(val) && val >= 0) rank.req = val;
            idx++;
        }

        const raw = getRawRankCommandConfig();
        if (!raw[rankId]) raw[rankId] = {};
        for (let i = 0; i < RANK_COMMANDS.length; i++) {
            raw[rankId][RANK_COMMANDS[i].id] = res.formValues[idx + i] === true;
        }
        saveRankCommandConfig(raw);
        saveRanksConfig();

        player.sendMessage("§a§l✔ Rank settings updated!");
        showRankSettings(player);
    });
}

function showEndSeasonSettings(player) {
    const currentLoseMode = world.getDynamicProperty(LOSE_POINTS_MODE_PROPERTY) ?? 0;
    const startTime = world.getDynamicProperty(SEASON_START_PROPERTY) || Date.now();
    const durationIdx = world.getDynamicProperty(SEASON_DURATION_PROPERTY) ?? 13;

    const duration = SEASON_OPTIONS[durationIdx].ms;
    let timeLeftStr = "§cNever";
    if (duration > 0) {
        const remaining = (startTime + duration) - Date.now();
        if (remaining <= 0) timeLeftStr = "§cEnded (Pending Reset)";
        else timeLeftStr = "§a" + formatTimeLeft(remaining);
    }

    const form = new ModalFormData()
        .title("§c§lEnd Season Settings")
        .dropdown("§7Lose Points Mode:", LOSE_POINTS_OPTIONS, { defaultValueIndex: currentLoseMode })
        .dropdown("§7Season Duration:", SEASON_OPTIONS.map(o => o.name), { defaultValueIndex: durationIdx })
        .textField("§7Time Left Until Reset:", "", { defaultValue: timeLeftStr })
        .toggle("§c§lForce End Season Now?", { defaultValue: false });

    form.show(player).then(res => {
        if (res.canceled) return;
        const newLoseMode = res.formValues[0];
        const newIdx = res.formValues[1];
        const forceEnd = res.formValues[3];

        world.setDynamicProperty(LOSE_POINTS_MODE_PROPERTY, newLoseMode);

        if (forceEnd) {
            executeEndSeason();
            player.sendMessage("§c§lSeason forcefully ended! Ranks have been reset.");
        } else if (newIdx !== durationIdx) {
            world.setDynamicProperty(SEASON_DURATION_PROPERTY, newIdx);
            world.setDynamicProperty(SEASON_START_PROPERTY, Date.now());
            player.sendMessage("§aSeason duration updated and timer reset!");
        } else {
            player.sendMessage("§aSettings saved!");
        }
        showEditLeaderboardMenu(player);
    });
}

// =============================================================================
// RANK REWARD UI
// =============================================================================

function showRankRewardList(player) {
    const form = new ActionFormData()
        .title("§a§lRank Rewards")
        .body("§7Select a rank to edit its rewards.");

    for (const rank of RANKS) {
        const rewards = getRankRewards();
        const reward = rewards[rank.id];
        let subtext = "§fNo Reward";
        if (reward) {
            let parts = [];
            if (reward.money > 0) parts.push(`§a$${forceCommas(reward.money)}`);
            if (reward.items && reward.items.length > 0) parts.push(`§b${reward.items.length} Items`);
            if (parts.length > 0) subtext = parts.join(" §f| ");
        }
        form.button(`${rank.title}\n${subtext}`);
    }
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === RANKS.length) {
            showEditLeaderboardMenu(player);
            return;
        }
        showEditRankReward(player, RANKS[res.selection].id);
    });
}

function showEditRankReward(player, rankId) {
    const rewards = getRankRewards();
    const existing = rewards[rankId] || { money: 0, items: [] };
    let temp = getTempData(player);

    if (!temp || temp.type !== "rank_reward" || temp.rankId !== rankId) {
        temp = {
            type: "rank_reward",
            rankId: rankId,
            money: String(existing.money || 0),
            selectedItems: (existing.items || []).slice(0, 3).map(i => ({ ...i })),
            itemSlots: 3
        };
        while (temp.selectedItems.length < temp.itemSlots) temp.selectedItems.push(null);
        saveTempData(player, temp);
    }

    const savedItems = temp.selectedItems || new Array(temp.itemSlots).fill(null);
    const { options, defaultIndices, displayNames } = buildItemDropdown(player, savedItems);
    const rank = RANKS.find(r => r.id === rankId);

    const form = new ModalFormData()
        .title(`§6§lEdit Reward: ${rank.name}`)
        .textField("§7Money Reward:", "0", { defaultValue: temp.money });

    for (let i = 0; i < temp.itemSlots; i++) {
        form.dropdown(`§7Item Reward ${i + 1}`, displayNames, { defaultValueIndex: (i < defaultIndices.length) ? defaultIndices[i] : 0 });
    }
    form.dropdown("§eAction", ["§aSubmit", "§bAdd 3 More Items"], { defaultValueIndex: 0 });

    form.show(player).then(res => {
        if (res.canceled) { clearTempData(player); showRankRewardList(player); return; }

        const nMoney = res.formValues[0];
        const nItems = [];
        for (let i = 0; i < temp.itemSlots; i++) {
            const idx = res.formValues[1 + i];
            if (idx > 0 && idx < options.length) nItems.push({ id: options[idx].id, count: options[idx].count, enchantments: options[idx].enchantments });
            else nItems.push(null);
        }
        const action = res.formValues[1 + temp.itemSlots];

        temp.money = nMoney;
        temp.selectedItems = nItems;

        if (action === 1) {
            if (temp.itemSlots < 3) {
                temp.itemSlots = 3;
                while (temp.selectedItems.length < 3) temp.selectedItems.push(null);
                saveTempData(player, temp);
                showEditRankReward(player, rankId);
            } else {
                player.sendMessage("§cMaximum of 3 item rewards reached!");
                saveTempData(player, temp);
                showEditRankReward(player, rankId);
            }
        } else {
            handleSubmitRankReward(player, temp);
        }
    });
}

function handleSubmitRankReward(player, temp) {
    const rewards = getRankRewards();
    let m = parseInt(temp.money) || 0;
    if (m < 0) m = 0;

    const rItems = [];
    for (const s of temp.selectedItems) {
        if (s && s.id) rItems.push({ id: s.id, count: s.count, enchantments: s.enchantments || [] });
    }

    rewards[temp.rankId] = { money: m, items: rItems };
    saveRankRewards(rewards);
    clearTempData(player);

    player.sendMessage("§a§l✔ Rank reward saved!");
    showRankRewardList(player);
}

// =============================================================================
// END SEASON REWARD UI
// =============================================================================

function showEndRewardList(player) {
    const form = new ActionFormData()
        .title("§d§lEnd Season Rewards")
        .body("§7Select a rank to edit its season end rewards.");

    for (const rank of RANKS) {
        const rewards = getRankEndRewards();
        const reward = rewards[rank.id];
        let subtext = "§fNo End Reward";
        if (reward) {
            let parts = [];
            if (reward.money > 0) parts.push(`§a$${forceCommas(reward.money)}`);
            if (reward.items && reward.items.length > 0) parts.push(`§b${reward.items.length} Items`);
            if (parts.length > 0) subtext = parts.join(" §f| ");
        }
        form.button(`${rank.title}\n${subtext}`);
    }
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === RANKS.length) {
            showEditLeaderboardMenu(player);
            return;
        }
        showEditEndReward(player, RANKS[res.selection].id);
    });
}

function showEditEndReward(player, rankId) {
    const rewards = getRankEndRewards();
    const existing = rewards[rankId] || { money: 0, items: [] };
    let temp = getTempData(player);

    if (!temp || temp.type !== "rank_end_reward" || temp.rankId !== rankId) {
        temp = {
            type: "rank_end_reward",
            rankId: rankId,
            money: String(existing.money || 0),
            selectedItems: (existing.items || []).slice(0, 3).map(i => ({ ...i })),
            itemSlots: 3
        };
        while (temp.selectedItems.length < temp.itemSlots) temp.selectedItems.push(null);
        saveTempData(player, temp);
    }

    const savedItems = temp.selectedItems || new Array(temp.itemSlots).fill(null);
    const { options, defaultIndices, displayNames } = buildItemDropdown(player, savedItems);
    const rank = RANKS.find(r => r.id === rankId);

    const form = new ModalFormData()
        .title(`§d§lEdit End Reward: ${rank.name}`)
        .textField("§7Money Reward:", "0", { defaultValue: temp.money });

    for (let i = 0; i < temp.itemSlots; i++) {
        form.dropdown(`§7Item Reward ${i + 1}`, displayNames, { defaultValueIndex: (i < defaultIndices.length) ? defaultIndices[i] : 0 });
    }
    form.dropdown("§eAction", ["§aSubmit", "§bAdd 3 More Items"], { defaultValueIndex: 0 });

    form.show(player).then(res => {
        if (res.canceled) { clearTempData(player); showEndRewardList(player); return; }

        const nMoney = res.formValues[0];
        const nItems = [];
        for (let i = 0; i < temp.itemSlots; i++) {
            const idx = res.formValues[1 + i];
            if (idx > 0 && idx < options.length) nItems.push({ id: options[idx].id, count: options[idx].count, enchantments: options[idx].enchantments });
            else nItems.push(null);
        }
        const action = res.formValues[1 + temp.itemSlots];

        temp.money = nMoney;
        temp.selectedItems = nItems;

        if (action === 1) {
            if (temp.itemSlots < 3) {
                temp.itemSlots = 3;
                while (temp.selectedItems.length < 3) temp.selectedItems.push(null);
                saveTempData(player, temp);
                showEditEndReward(player, rankId);
            } else {
                player.sendMessage("§cMaximum of 3 item rewards reached!");
                saveTempData(player, temp);
                showEditEndReward(player, rankId);
            }
        } else {
            handleSubmitEndReward(player, temp);
        }
    });
}

function handleSubmitEndReward(player, temp) {
    const rewards = getRankEndRewards();
    let m = parseInt(temp.money) || 0;
    if (m < 0) m = 0;

    const rItems = [];
    for (const s of temp.selectedItems) {
        if (s && s.id) rItems.push({ id: s.id, count: s.count, enchantments: s.enchantments || [] });
    }

    rewards[temp.rankId] = { money: m, items: rItems };
    saveRankEndRewards(rewards);
    clearTempData(player);

    player.sendMessage("§a§l✔ End season reward saved!");
    showEndRewardList(player);
}

// =============================================================================
// RANK TITLES (EQUIP / HIDE)
// =============================================================================
function showRankTitles(player) {
    const data = getPlayerData(player);
    const points = getPoints(player);
    const rankSystemEnabled = getRankSystemEnabled();
    const rankTitlesEnabled = getRankTitlesEnabled();
    let customRanks = getCustomRanks().filter(r => data.customRanks.includes(r.id));
    customRanks.sort((a, b) => stripColors(a.display).localeCompare(stripColors(b.display)));

    const options = [];

    if (rankSystemEnabled) {
        options.push({
            id: "member",
            display: getMemberRankDisplay(points),
            sortName: "0_Member"
        });

        const currentProgRank = getRankFromPoints(points);
        options.push({
            id: currentProgRank.id,
            display: currentProgRank.headIcon,
            sortName: "2_" + currentProgRank.name
        });
    }

    if (rankTitlesEnabled) {
        for (const cRank of customRanks) {
            options.push({
                id: cRank.id,
                display: cRank.display,
                sortName: "1_" + stripColors(cRank.display)
            });
        }
    }

    options.sort((a, b) => a.sortName.localeCompare(b.sortName));

    let activeIdx = options.findIndex(o => o.id === data.activeRank);
    if (activeIdx === -1 && rankSystemEnabled && (data.activeRank === null || data.activeRank === undefined)) activeIdx = options.findIndex(o => o.id === "member");

    if (activeIdx > -1) {
        const activeItem = options.splice(activeIdx, 1)[0];
        options.unshift(activeItem);
    }

    let statusLine;
    if (rankSystemEnabled && rankTitlesEnabled) statusLine = "§7Manage your rank titles.";
    else if (rankSystemEnabled) statusLine = "§7Custom rank titles are §cdisabled§7. Only progression ranks available.";
    else if (rankTitlesEnabled) statusLine = "§7The Rank System is §cdisabled§7. Only custom ranks available.";
    else statusLine = "§7Rank titles are currently unavailable.";

    const form = new ActionFormData()
        .title("§e§lRank Titles")
        .body(statusLine + "\n§7Click an equipped rank to unequip it.");

    for (const opt of options) {
        const isActive = (data.activeRank === opt.id) || ((data.activeRank === null || data.activeRank === undefined) && opt.id === "member");
        form.button(`${opt.display}\n§f${isActive ? "§a[Equipped]" : "§c[Equip]"}`);
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === options.length) {
            showRanks(player);
            return;
        }

        const selectedOpt = options[response.selection];
        const isActive = (data.activeRank === selectedOpt.id) || ((data.activeRank === null || data.activeRank === undefined) && selectedOpt.id === "member");

        if (isActive) {
            // Unequip current rank and turn into "No Rank Display"
            data.activeRank = "none";
        } else {
            if (selectedOpt.id === "member") {
                data.activeRank = null; // Reverts back to standard progression default
            } else {
                data.activeRank = selectedOpt.id;
            }
        }

        data.hideRank = false;
        savePlayerData(player, data);
        showRankTitles(player);
    });
}

// =============================================================================
// NICKNAMES (EQUIP / HIDE)
// =============================================================================

function showNicknames(player) {
    if (!getNicknamesEnabled()) {
        player.sendMessage("§cNicknames are currently disabled by the server.");
        showRanks(player);
        return;
    }
    const data = getPlayerData(player);
    let customNicks = getCustomNicks().filter(n => data.customNicks.includes(n.id));
    customNicks.sort((a, b) => stripColors(a.display).localeCompare(stripColors(b.display)));

    if (data.activeNick) {
        const activeIndex = customNicks.findIndex(n => n.id === data.activeNick);
        if (activeIndex > -1) {
            const activeItem = customNicks.splice(activeIndex, 1)[0];
            customNicks.unshift(activeItem);
        }
    }

    const form = new ActionFormData()
        .title("§d§lNicknames")
        .body(`§7Current Name: §f${getActiveNickDisplay(player)}`);

    for (const cNick of customNicks) {
        const isActive = data.activeNick === cNick.id;
        form.button(`${cNick.display}\n§f${isActive ? "§a[Equipped]" : "§c[Equip]"}`);
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        let index = 0;

        for (const cNick of customNicks) {
            if (response.selection === index++) {
                if (data.activeNick === cNick.id) {
                    data.activeNick = null;
                } else {
                    data.activeNick = cNick.id;
                }
                savePlayerData(player, data);
                showNicknames(player);
                return;
            }
        }

        showRanks(player);
    });
}

// =============================================================================
// CREATE RANK & NICK
// =============================================================================

function showCreateRank(player) {
    const form = new ModalFormData()
        .title("§e§lCreate Rank Title")
        .textField("§7Rank Name:", "VIP");

    for (const cmd of RANK_COMMANDS) {
        form.toggle(`§7${cmd.desc}`, { defaultValue: false });
    }

    form.dropdown("§7Color", COLOR_DISPLAYS, { defaultValueIndex: 0 })
        .dropdown("§7Formatting", FORMAT_DISPLAYS, { defaultValueIndex: 0 })
        .dropdown("§7Brackets", BRACKET_DISPLAYS, { defaultValueIndex: 0 })
        .dropdown("§7Bracket Color", BRACKET_COLOR_DISPLAYS, { defaultValueIndex: 0 });

    form.show(player).then(res => {
        if (res.canceled) { showSettings(player); return; }
        let name = res.formValues[0].trim();
        if (!name) { player.sendMessage("§cName cannot be empty!"); showCreateRank(player); return; }

        const cmdCount = RANK_COMMANDS.length;
        const commands = {};
        for (let i = 0; i < cmdCount; i++) {
            commands[RANK_COMMANDS[i].id] = res.formValues[1 + i] === true;
        }

        const base = 1 + cmdCount;
        const colorCode = COLOR_OPTIONS[res.formValues[base]].code;
        const formatCode = FORMAT_OPTIONS[res.formValues[base + 1]].code;
        const bracket = BRACKET_OPTIONS[res.formValues[base + 2]];
        const bracketColor = BRACKET_COLOR_OPTIONS[res.formValues[base + 3]].code;
        const display = buildRankTitleText(colorCode, formatCode, name, bracket, bracketColor);

        const plainName = stripColors(display);
        const rankId = plainName.toLowerCase().replace(/\s+/g, "_");

        const allCustom = getCustomRanks();
        if (allCustom.find(r => r.id === rankId)) {
            player.sendMessage("§cThis rank already exists!");
            showCreateRank(player);
            return;
        }

        allCustom.push({ id: rankId, display: display, bracketId: bracket.id, bracketColor: bracketColor, colorCode: colorCode, formatCode: formatCode, commands: commands });
        saveCustomRanks(allCustom);
        player.sendMessage(`§a§l✔ Created rank: §f${display}`);
        player.playSound("random.orb");
        showSettings(player);
    });
}

function showCreateNick(player) {
    const form = new ModalFormData()
        .title("§d§lCreate Nickname")
        .textField("§7Nickname:", "CoolName")
        .dropdown("§7Color", COLOR_DISPLAYS, { defaultValueIndex: 0 })
        .dropdown("§7Formatting", FORMAT_DISPLAYS, { defaultValueIndex: 0 })
        .dropdown("§7Chat Color", CHAT_COLOR_DISPLAYS, { defaultValueIndex: 0 })
        .dropdown("§7Chat Formatting", CHAT_FORMAT_DISPLAYS, { defaultValueIndex: 0 });

    form.show(player).then(res => {
        if (res.canceled) { showSettings(player); return; }
        let name = res.formValues[0].trim();
        if (!name) { player.sendMessage("§cName cannot be empty!"); showCreateNick(player); return; }

        const colorCode = COLOR_OPTIONS[res.formValues[1]].code;
        const formatCode = FORMAT_OPTIONS[res.formValues[2]].code;
        const chatColor = CHAT_COLOR_OPTIONS[res.formValues[3]].code;
        const chatFormat = CHAT_FORMAT_OPTIONS[res.formValues[4]].code;
        const display = buildNickText(colorCode, formatCode, name);

        const plainName = stripColors(display);
        const nickId = plainName.toLowerCase().replace(/\s+/g, "_");

        const allCustom = getCustomNicks();
        if (allCustom.find(n => n.id === nickId)) {
            player.sendMessage("§cThis nickname already exists!");
            showCreateNick(player);
            return;
        }

        allCustom.push({ id: nickId, display: display, chatColor: chatColor, chatFormat: chatFormat, nickColor: colorCode, nickFormat: formatCode });
        saveCustomNicks(allCustom);
        player.sendMessage(`§a§l✔ Created nickname: §f${display}`);
        player.playSound("random.orb");
        showSettings(player);
    });
}

// =============================================================================
// OP RANK LIST & ACTIONS
// =============================================================================

function showOPRankList(player) {
    const customRanks = getCustomRanks();
    if (customRanks.length === 0) {
        player.sendMessage("§cNo custom ranks created yet.");
        showSettings(player);
        return;
    }

    const form = new ActionFormData().title("§b§lRank Title List").body("§7Select a rank to manage:");
    for (const rank of customRanks) form.button(`${rank.display}\n§fID: ${rank.id}`, getRandomRankColorIcon());
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === customRanks.length) { showSettings(player); return; }
        showOPRankActions(player, customRanks[res.selection].id);
    });
}

function showOPRankActions(player, rankId) {
    const rank = getCustomRanks().find(r => r.id === rankId);
    const form = new ActionFormData()
        .title(`§b§lManage: ${rank.display}`)
        .body(`§7ID: §f${rankId}`)
        .button("§a§lSet Rank Title\n§f[ Give & Equip ]")
        .button("§e§lGive Rank Title\n§f[ Give Only ]")
        .button("§6§lEdit Rank Title\n§f[ Global Edit ]")
        .button("§c§lRemove Rank Title\n§f[ Global Remove ]")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) showOPSelectPlayerSetRank(player, rankId);
        else if (res.selection === 1) showOPSelectPlayerGiveRank(player, rankId);
        else if (res.selection === 2) showEditCustomRank(player, rankId);
        else if (res.selection === 3) confirmDeleteRank(player, rankId);
        else showOPRankList(player);
    });
}

function showOPSelectPlayerSetRank(player, rankId) {
    const players = world.getPlayers();
    const form = new ActionFormData().title("§a§lSet Rank: Select Player");
    players.forEach(p => form.button(p.name, getRandomRankColorIcon()));
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === players.length) { showOPRankActions(player, rankId); return; }
        const target = players[res.selection];
        const data = getPlayerData(target);
        if (!data.customRanks.includes(rankId)) data.customRanks.push(rankId);
        data.activeRank = rankId;
        data.hideRank = false;
        savePlayerData(target, data);
        player.sendMessage(`§aSet ${rankId} to ${target.name}`);
        target.sendMessage(`§aAn OP set your rank to: ${getCustomRanks().find(r => r.id === rankId)?.display || rankId}`);
        target.playSound("random.levelup");
        showOPSelectPlayerSetRank(player, rankId);
    });
}

function showOPSelectPlayerGiveRank(player, rankId) {
    const players = world.getPlayers();
    const form = new ActionFormData().title("§e§lGive Rank: Select Player");
    players.forEach(p => form.button(p.name, getRandomRankColorIcon()));
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === players.length) { showOPRankActions(player, rankId); return; }
        const target = players[res.selection];
        const data = getPlayerData(target);
        if (!data.customRanks.includes(rankId)) {
            data.customRanks.push(rankId);
            savePlayerData(target, data);
            player.sendMessage(`§aGave ${rankId} to ${target.name}`);
            target.sendMessage(`§aYou received a rank: ${getCustomRanks().find(r => r.id === rankId)?.display || rankId}`);
            target.playSound("random.orb");
        } else {
            player.sendMessage(`§e${target.name} already owns this rank.`);
        }
        showOPSelectPlayerGiveRank(player, rankId);
    });
}

function showEditCustomRank(player, rankId) {
    const customRanks = getCustomRanks();
    const rank = customRanks.find(r => r.id === rankId);

    let rawText = rank.display.replace(/§./g, "").replace(/§r$/, "").replace(/[\[\]<>{}«»☰▲▼|]/g, "");
    const currentColorCode = rank.colorCode || "§f";
    const currentFormatCode = rank.formatCode || "";
    const currentBracketId = rank.bracketId || "none";
    const currentBracketColorCode = rank.bracketColor || "§f";
    const currentCommands = rank.commands || {};

    let colorIndex = COLOR_OPTIONS.findIndex(c => c.code === currentColorCode);
    if (colorIndex === -1) colorIndex = 0;

    let formatIndex = FORMAT_OPTIONS.findIndex(f => f.code === currentFormatCode);
    if (formatIndex === -1) formatIndex = 0;

    let bracketIndex = BRACKET_OPTIONS.findIndex(b => b.id === currentBracketId);
    if (bracketIndex === -1) bracketIndex = 0;

    let bracketColorIndex = BRACKET_COLOR_OPTIONS.findIndex(c => c.code === currentBracketColorCode);
    if (bracketColorIndex === -1) bracketColorIndex = 0;

    const form = new ModalFormData()
        .title("§6§lEdit Rank Title")
        .textField("§7Rank Name:", "VIP", { defaultValue: rawText });

    for (const cmd of RANK_COMMANDS) {
        form.toggle(`§7${cmd.desc}`, { defaultValue: currentCommands[cmd.id] === true });
    }

    form.dropdown("§7Color", COLOR_DISPLAYS, { defaultValueIndex: colorIndex })
        .dropdown("§7Formatting", FORMAT_DISPLAYS, { defaultValueIndex: formatIndex })
        .dropdown("§7Brackets", BRACKET_DISPLAYS, { defaultValueIndex: bracketIndex })
        .dropdown("§7Bracket Color", BRACKET_COLOR_DISPLAYS, { defaultValueIndex: bracketColorIndex });

    form.show(player).then(res => {
        if (res.canceled) return;
        let name = res.formValues[0].trim();
        if (!name) { player.sendMessage("§cName cannot be empty!"); return; }

        const cmdCount = RANK_COMMANDS.length;
        const commands = {};
        for (let i = 0; i < cmdCount; i++) {
            commands[RANK_COMMANDS[i].id] = res.formValues[1 + i] === true;
        }

        const base = 1 + cmdCount;
        const colorCode = COLOR_OPTIONS[res.formValues[base]].code;
        const formatCode = FORMAT_OPTIONS[res.formValues[base + 1]].code;
        const bracket = BRACKET_OPTIONS[res.formValues[base + 2]];
        const bracketColor = BRACKET_COLOR_OPTIONS[res.formValues[base + 3]].code;
        rank.display = buildRankTitleText(colorCode, formatCode, name, bracket, bracketColor);
        rank.bracketId = bracket.id;
        rank.bracketColor = bracketColor;
        rank.colorCode = colorCode;
        rank.formatCode = formatCode;
        rank.commands = commands;

        saveCustomRanks(customRanks);
        player.sendMessage(`§a§l✔ Updated rank to: §f${rank.display}`);
        showOPRankActions(player, rankId);
    });
}

function confirmDeleteRank(player, rankId) {
    const form = new ActionFormData()
        .title("§c§lConfirm Delete")
        .body(`§cDelete §f${rankId} §cfor all players?`)
        .button("§c§lYes, Delete", "textures/ranks/delete.png")
        .button("§aCancel", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection !== 0) { showOPRankActions(player, rankId); return; }

        let customRanks = getCustomRanks();
        customRanks = customRanks.filter(r => r.id !== rankId);
        saveCustomRanks(customRanks);

        for (const p of world.getPlayers()) {
            const data = getPlayerData(p);
            data.customRanks = data.customRanks.filter(id => id !== rankId);
            if (data.activeRank === rankId) data.activeRank = null;
            savePlayerData(p, data);
        }

        player.sendMessage(`§cDeleted rank: ${rankId}`);
        player.playSound("random.break");
        showOPRankList(player);
    });
}

// =============================================================================
// OP NICK LIST & ACTIONS
// =============================================================================

function showOPNickList(player) {
    const customNicks = getCustomNicks();
    if (customNicks.length === 0) {
        player.sendMessage("§cNo custom nicknames created yet.");
        showSettings(player);
        return;
    }

    const form = new ActionFormData().title("§6§lNickname List").body("§7Select a nickname to manage:");
    for (const nick of customNicks) form.button(`${nick.display}\n§fID: ${nick.id}`, getRandomRankColorIcon());
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === customNicks.length) { showSettings(player); return; }
        showOPNickActions(player, customNicks[res.selection].id);
    });
}

function showOPNickActions(player, nickId) {
    const nick = getCustomNicks().find(n => n.id === nickId);
    const form = new ActionFormData()
        .title(`§6§lManage: ${nick.display}`)
        .body(`§7ID: §f${nickId}`)
        .button("§a§lSet Nickname\n§f[ Give & Equip ]")
        .button("§e§lGive Nickname\n§f[ Give Only ]")
        .button("§6§lEdit Nickname\n§f[ Global Edit ]")
        .button("§c§lRemove Nickname\n§f[ Global Remove ]")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) showOPSelectPlayerSetNick(player, nickId);
        else if (res.selection === 1) showOPSelectPlayerGiveNick(player, nickId);
        else if (res.selection === 2) showEditCustomNick(player, nickId);
        else if (res.selection === 3) confirmDeleteNick(player, nickId);
        else showOPNickList(player);
    });
}

function showOPSelectPlayerSetNick(player, nickId) {
    const players = world.getPlayers();
    const form = new ActionFormData().title("§a§lSet Nick: Select Player");
    players.forEach(p => form.button(p.name, getRandomRankColorIcon()));
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === players.length) { showOPNickActions(player, nickId); return; }
        const target = players[res.selection];
        const data = getPlayerData(target);
        if (!data.customNicks.includes(nickId)) data.customNicks.push(nickId);
        data.activeNick = nickId;
        data.hideNick = false;
        savePlayerData(target, data);
        player.sendMessage(`§aSet ${nickId} to ${target.name}`);
        target.sendMessage(`§aAn OP set your nickname to: ${getCustomNicks().find(n => n.id === nickId)?.display || nickId}`);
        target.playSound("random.levelup");
        showOPSelectPlayerSetNick(player, nickId);
    });
}

function showOPSelectPlayerGiveNick(player, nickId) {
    const players = world.getPlayers();
    const form = new ActionFormData().title("§e§lGive Nick: Select Player");
    players.forEach(p => form.button(p.name, getRandomRankColorIcon()));
    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === players.length) { showOPNickActions(player, nickId); return; }
        const target = players[res.selection];
        const data = getPlayerData(target);
        if (!data.customNicks.includes(nickId)) {
            data.customNicks.push(nickId);
            savePlayerData(target, data);
            player.sendMessage(`§aGave ${nickId} to ${target.name}`);
            target.sendMessage(`§aYou received a nickname: ${getCustomNicks().find(n => n.id === nickId)?.display || nickId}`);
            target.playSound("random.orb");
        } else {
            player.sendMessage(`§e${target.name} already owns this nickname.`);
        }
        showOPSelectPlayerGiveNick(player, nickId);
    });
}

function showEditCustomNick(player, nickId) {
    const customNicks = getCustomNicks();
    const nick = customNicks.find(n => n.id === nickId);

    let rawText = nick.display.replace(/§./g, "").replace(/§r$/, "");
    const currentColorCode = nick.nickColor || "§f";
    const currentFormatCode = nick.nickFormat || "";
    const currentChatColor = nick.chatColor || "";
    const currentChatFormat = nick.chatFormat || "";

    let colorIndex = COLOR_OPTIONS.findIndex(c => c.code === currentColorCode);
    if (colorIndex === -1) colorIndex = 0;

    let formatIndex = FORMAT_OPTIONS.findIndex(f => f.code === currentFormatCode);
    if (formatIndex === -1) formatIndex = 0;

    let chatColorIndex = CHAT_COLOR_OPTIONS.findIndex(c => c.code === currentChatColor);
    if (chatColorIndex === -1) chatColorIndex = 0;

    let chatFormatIndex = CHAT_FORMAT_OPTIONS.findIndex(f => f.code === currentChatFormat);
    if (chatFormatIndex === -1) chatFormatIndex = 0;

    const form = new ModalFormData()
        .title("§6§lEdit Nickname")
        .textField("§7Nickname:", "CoolName", { defaultValue: rawText })
        .dropdown("§7Color", COLOR_DISPLAYS, { defaultValueIndex: colorIndex })
        .dropdown("§7Formatting", FORMAT_DISPLAYS, { defaultValueIndex: formatIndex })
        .dropdown("§7Chat Color", CHAT_COLOR_DISPLAYS, { defaultValueIndex: chatColorIndex })
        .dropdown("§7Chat Formatting", CHAT_FORMAT_DISPLAYS, { defaultValueIndex: chatFormatIndex });

    form.show(player).then(res => {
        if (res.canceled) return;
        let name = res.formValues[0].trim();
        if (!name) { player.sendMessage("§cName cannot be empty!"); return; }

        const colorCode = COLOR_OPTIONS[res.formValues[1]].code;
        const formatCode = FORMAT_OPTIONS[res.formValues[2]].code;
        const chatColor = CHAT_COLOR_OPTIONS[res.formValues[3]].code;
        const chatFormat = CHAT_FORMAT_OPTIONS[res.formValues[4]].code;
        nick.display = buildNickText(colorCode, formatCode, name);
        nick.chatColor = chatColor;
        nick.chatFormat = chatFormat;
        nick.nickColor = colorCode;
        nick.nickFormat = formatCode;

        saveCustomNicks(customNicks);
        player.sendMessage(`§a§l✔ Updated nickname to: §f${nick.display}`);
        showOPNickActions(player, nickId);
    });
}

function confirmDeleteNick(player, nickId) {
    const form = new ActionFormData()
        .title("§c§lConfirm Delete")
        .body(`§cDelete §f${nickId} §cfor all players?`)
        .button("§c§lYes, Delete", "textures/ranks/delete.png")
        .button("§aCancel", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection !== 0) { showOPNickActions(player, nickId); return; }

        let customNicks = getCustomNicks();
        customNicks = customNicks.filter(n => n.id !== nickId);
        saveCustomNicks(customNicks);

        for (const p of world.getPlayers()) {
            const data = getPlayerData(p);
            data.customNicks = data.customNicks.filter(id => id !== nickId);
            if (data.activeNick === nickId) data.activeNick = null;
            savePlayerData(p, data);
        }

        player.sendMessage(`§cDeleted nickname: ${nickId}`);
        player.playSound("random.break");
        showOPNickList(player);
    });
}

// =============================================================================
// OP UNICODE LIST
// =============================================================================

function showUnicodeList(player, from = "settings") {
    // COPY-PASTE ONLY. The symbols below are hardcoded (UNICODE_LIST) and are
    // never saved or changed: if a player wipes a box, reopening restores them.
    // ModalFormData has no body text, so the instructions live in the first box.
    const form = new ModalFormData()
        .title("§9§lUnicode List")
        .textField("§7HOW TO COPY: hold inside a box > Select All > Copy, then paste it into your nickname or rank name. Nothing here is ever saved.", "instructions", { defaultValue: "Hold a box below > Select All > Copy" });

    for (let i = 0; i < UNICODE_LIST.length; i++) {
        form.textField(`§7Icon ${i + 1} §8- ${UNICODE_LIST[i].code}`, "", { defaultValue: UNICODE_LIST[i].icon });
    }

    form.submitButton("§cBack");

    form.show(player).then(() => {
        // Submit or cancel: no data is written, just go back where it was opened.
        if (from === "settings") showSettings(player);
        else showRanks(player);
    });
}

// =============================================================================
// OP PLAYER LIST
// =============================================================================

function showOPPlayerList(player) {
    const players = world.getPlayers();
    const form = new ActionFormData()
        .title("§a§lPlayer List")
        .body("§7Select a player to manage their data.");

    const rankTitlesEnabled = getRankTitlesEnabled();
    for (const p of players) {
        const pts = getPoints(p);
        if (rankTitlesEnabled) {
            const rank = getRankFromPoints(pts);
            form.button(`${p.name}\n§f${rank.title} - ${forceCommas(pts)} pts`, getRandomRankColorIcon());
        } else {
            form.button(`${p.name}\n§f${forceCommas(pts)} pts`, getRandomRankColorIcon());
        }
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === players.length) { showSettings(player); return; }

        const target = players[res.selection];
        showOPPlayerActions(player, target);
    });
}

function showOPPlayerActions(player, target) {
    const data = getPlayerData(target);
    const pts = getPoints(target);
    const rankSystemEnabled = getRankSystemEnabled();
    const rankTitlesEnabled = getRankTitlesEnabled();
    const nicknamesEnabled = getNicknamesEnabled();

    let body = `§7Player: §f${target.name}\n`;
    body += `§7Points: §e${forceCommas(pts)}\n`;

    if (rankSystemEnabled) {
        const rank = getRankFromPoints(pts);
        body += `§7Progression Rank: ${rank.title}\n`;
    }

    let activeDisplay = "None";
    if (data.activeRank === "none") {
        activeDisplay = "§f§oNo Rank Display§r §8(Unequipped)";
    } else if (data.activeRank) {
        if (data.activeRank === "member") {
            activeDisplay = rankSystemEnabled ? getMemberRankDisplay(pts) : "§8(Rank System Disabled)";
        } else {
            const custom = getCustomRanks().find(r => r.id === data.activeRank);
            if (custom) {
                activeDisplay = rankTitlesEnabled ? custom.display : `${custom.display} §8(Rank Titles Disabled)`;
            } else {
                const prog = RANKS.find(r => r.id === data.activeRank);
                if (prog) activeDisplay = rankSystemEnabled ? prog.headIcon : "§8(Rank System Disabled)";
            }
        }
    } else {
        activeDisplay = rankSystemEnabled ? getMemberRankDisplay(pts) + " §8(Default)" : "§8(Rank System Disabled)";
    }
    body += `§7Active Rank: ${activeDisplay}\n`;

    if (nicknamesEnabled) {
        body += `§7Active Nick: ${getActiveNickDisplay(target)}\n`;
    } else {
        body += `§7Active Nick: §8Disabled\n`;
    }

    body += `§7Hide Rank: ${data.hideRank ? "§cYes" : "§aNo"}\n`;
    body += `§7Hide Nick: ${data.hideNick ? "§cYes" : "§aNo"}\n`;
    body += `§7Ranks Owned: §f${data.customRanks.length}\n`;
    body += `§7Nicks Owned: §f${data.customNicks.length}\n`;

    const form = new ActionFormData()
        .title(`§a§lManage: ${target.name}`)
        .body(body)
        .button("§e§lSet Points", "textures/settings.png")
        .button(`§b§lRank Title Storage\n§f[ ${data.customRanks.length} Ranks ]`, "textures/ranks/myranks.png")
        .button(`§d§lNickname Storage\n§f[ ${data.customNicks.length} Nicks ]`, "textures/name.png")
        .button("§c§lReset Player Data", "textures/ranks/delete.png")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) showOPSetPoints(player, target);
        else if (res.selection === 1) showOPPlayerRankStorage(player, target);
        else if (res.selection === 2) showOPPlayerNickStorage(player, target);
        else if (res.selection === 3) confirmResetPlayer(player, target);
        else showOPPlayerList(player);
    });
}

function showOPPlayerRankStorage(player, target) {
    const data = getPlayerData(target);
    const customRanks = getCustomRanks().filter(r => data.customRanks.includes(r.id));

    const form = new ActionFormData()
        .title(`§b§l${target.name}'s Rank Storage`)
        .body(`§7Custom ranks owned by §f${target.name}§7: §f${customRanks.length}`);

    for (const cRank of customRanks) {
        const isActive = data.activeRank === cRank.id;
        form.button(`${cRank.display}\n§f${isActive ? "§a[Equipped]" : "§f[Not Equipped]"}`, getRandomRankColorIcon());
    }

    if (customRanks.length === 0) {
        form.button("§cNo ranks owned", "textures/ranks/back.png");
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        const backIdx = customRanks.length === 0 ? 0 : customRanks.length;
        if (res.selection === backIdx) {
            showOPPlayerActions(player, target);
            return;
        }
        if (res.selection >= 0 && res.selection < customRanks.length) {
            showOPPlayerRankItemActions(player, target, customRanks[res.selection].id);
        }
    });
}

function showOPPlayerRankItemActions(player, target, rankId) {
    const data = getPlayerData(target);
    const rank = getCustomRanks().find(r => r.id === rankId);
    const isActive = data.activeRank === rankId;

    const form = new ActionFormData()
        .title("§b§lManage Rank")
        .body(`§7Player: §f${target.name}\n§7Rank: ${rank.display}\n§7Status: ${isActive ? "§aEquipped" : "§7Not Equipped"}`)
        .button(`§a§l${isActive ? "Unequip" : "Equip"} Rank`, "textures/ranks/myranks.png")
        .button("§c§lDelete from Player", "textures/ranks/delete.png")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) {
            if (isActive) {
                data.activeRank = null;
            } else {
                data.activeRank = rankId;
                data.hideRank = false;
            }
            savePlayerData(target, data);
            player.sendMessage(`§a${isActive ? "Unequipped" : "Equipped"} rank ${rank.display} for ${target.name}.`);
            target.sendMessage(`§aAn OP ${isActive ? "unequipped" : "equipped"} your rank: ${rank.display}`);
            target.playSound(isActive ? "random.break" : "random.levelup");
            showOPPlayerRankItemActions(player, target, rankId);
        } else if (res.selection === 1) {
            data.customRanks = data.customRanks.filter(id => id !== rankId);
            if (data.activeRank === rankId) data.activeRank = null;
            savePlayerData(target, data);
            player.sendMessage(`§cDeleted rank ${rank.display} from ${target.name}.`);
            target.sendMessage(`§cAn OP removed your rank: ${rank.display}`);
            target.playSound("random.break");
            showOPPlayerRankStorage(player, target);
        } else {
            showOPPlayerRankStorage(player, target);
        }
    });
}

function showOPPlayerNickStorage(player, target) {
    const data = getPlayerData(target);
    const customNicks = getCustomNicks().filter(n => data.customNicks.includes(n.id));

    const form = new ActionFormData()
        .title(`§d§l${target.name}'s Nickname Storage`)
        .body(`§7Nicknames owned by §f${target.name}§7: §f${customNicks.length}`);

    for (const cNick of customNicks) {
        const isActive = data.activeNick === cNick.id;
        form.button(`${cNick.display}\n§f${isActive ? "§a[Equipped]" : "§f[Not Equipped]"}`, getRandomRankColorIcon());
    }

    if (customNicks.length === 0) {
        form.button("§cNo nicknames owned", "textures/ranks/back.png");
    }

    form.button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        const backIdx = customNicks.length === 0 ? 0 : customNicks.length;
        if (res.selection === backIdx) {
            showOPPlayerActions(player, target);
            return;
        }
        if (res.selection >= 0 && res.selection < customNicks.length) {
            showOPPlayerNickItemActions(player, target, customNicks[res.selection].id);
        }
    });
}

function showOPPlayerNickItemActions(player, target, nickId) {
    const data = getPlayerData(target);
    const nick = getCustomNicks().find(n => n.id === nickId);
    const isActive = data.activeNick === nickId;

    const form = new ActionFormData()
        .title("§d§lManage Nickname")
        .body(`§7Player: §f${target.name}\n§7Nickname: ${nick.display}\n§7Status: ${isActive ? "§aEquipped" : "§7Not Equipped"}`)
        .button(`§a§l${isActive ? "Unequip" : "Equip"} Nickname`, "textures/name.png")
        .button("§c§lDelete from Player", "textures/ranks/delete.png")
        .button("§cBack", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) {
            if (isActive) {
                data.activeNick = null;
            } else {
                data.activeNick = nickId;
                data.hideNick = false;
            }
            savePlayerData(target, data);
            player.sendMessage(`§a${isActive ? "Unequipped" : "Equipped"} nickname ${nick.display} for ${target.name}.`);
            target.sendMessage(`§aAn OP ${isActive ? "unequipped" : "equipped"} your nickname: ${nick.display}`);
            target.playSound(isActive ? "random.break" : "random.levelup");
            showOPPlayerNickItemActions(player, target, nickId);
        } else if (res.selection === 1) {
            data.customNicks = data.customNicks.filter(id => id !== nickId);
            if (data.activeNick === nickId) data.activeNick = null;
            savePlayerData(target, data);
            player.sendMessage(`§cDeleted nickname ${nick.display} from ${target.name}.`);
            target.sendMessage(`§cAn OP removed your nickname: ${nick.display}`);
            target.playSound("random.break");
            showOPPlayerNickStorage(player, target);
        } else {
            showOPPlayerNickStorage(player, target);
        }
    });
}

function showOPSetPoints(player, target) {
    const form = new ModalFormData()
        .title("§e§lSet Points")
        .textField("§7Points:", "0", { defaultValue: String(getPoints(target)) });

    form.show(player).then(res => {
        if (res.canceled) return;
        const val = parseInt(res.formValues[0]);
        if (isNaN(val)) { player.sendMessage("§cInvalid number!"); return; }

        setPoints(target, val);
        const newRank = getRankFromPoints(val);
        applyRankTag(target, newRank.tag);

        player.sendMessage(`§aSet ${target.name}'s points to ${forceCommas(val)}`);
        showOPPlayerActions(player, target);
    });
}

function confirmResetPlayer(player, target) {
    const form = new ActionFormData()
        .title("§c§lConfirm Reset")
        .body(`§cReset §f${target.name}§c's rank data and points to 0?`)
        .button("§c§lYes, Reset", "textures/ranks/delete.png")
        .button("§aCancel", "textures/ranks/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection !== 0) { showOPPlayerActions(player, target); return; }

        const defaultData = { activeRank: null, hideRank: false, customRanks: [], activeNick: null, hideNick: false, customNicks: [] };
        savePlayerData(target, defaultData);

        setPoints(target, 0);
        const noobRank = RANKS.find(r => r.id === "noob");
        if (noobRank) applyRankTag(target, noobRank.tag);

        player.sendMessage(`§cReset ${target.name}'s data and points to 0.`);
        showOPPlayerActions(player, target);
    });
}
// scripts/operator/scoreboard.js
import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { getActiveRankDisplay, getActiveNickDisplay, getPoints, getGlobalTop, getRankProgress } from "../ranks.js";
import { getCurrencyObjective, getBalance } from "./currency.js";

// =============================================================================
// CONFIGURATION & DEFAULTS
// =============================================================================

const CONFIG_KEY = "zyd_scoreboard_config";
const DEFAULT_OBJECTIVES = [
    "Kills", "Deaths", "TimePlayed", "rank",
    "PlayerKills", "TimePlayed2", "KillStreak", "BestKillStreak",
    "BlocksBreak", "BlocksPlace", "Money", "Bounty"
];

const DEFAULT_ZYD_DISPLAY_LINES = [
    "§l§aSERVER NAME",
    "§l§a: ${PlayersPlaying}",
    ": ${nick}",
    "§l§j--------------",
    "§g: ${Money}",
    "§c: ${Bounty}",
    "§l§j--------------",
    "§c: ${rank}",
    "§l§j--------------",
    "§c: ${PlayerKills}",
    "§c: ${Deaths}",
    "§c: ${KillStreak}",
    "§l§j--------------",
    ": ${TimePlayed2}"
];

const DEFAULT_DONUT_DISPLAY_LINES = [
    "§b§lDr Donut SMP",
    "",
    "§a\u0024 §fMoney: §a${Money}",
    " §cKills: §f${Kills}",
    " §cDeaths: §f${Deaths}",
    " §ePlaytime: §f${TimePlayedCompact}",
    " §9Team: §fNone",
    "",
    "§bPing: §7${Ping}"
];

function createDefaultDisplayPresets() {
    return {
        default: [...DEFAULT_ZYD_DISPLAY_LINES],
        donut: [...DEFAULT_DONUT_DISPLAY_LINES]
    };
}

function getSavedDisplayPresets(value) {
    const presets = createDefaultDisplayPresets();
    for (const key of Object.keys(presets)) {
        if (Array.isArray(value?.[key])) presets[key] = [...value[key]];
    }
    return presets;
}

function setActiveDisplay(config, key) {
    config.activeDisplay = key;
    config.hudLines = [...config.displayPresets[key]];
}

function saveActiveDisplayLines(config, lines) {
    config.hudLines = [...lines];
    if (config.activeDisplay === "default" || config.activeDisplay === "donut") {
        config.displayPresets[config.activeDisplay] = [...lines];
    }
}

const RAINBOW_COLORS = ["§c", "§6", "§e", "§a", "§b", "§9", "§d"];
const GRADIENT_PALETTES = [
    ["§c", "§6", "§e", "§a"], ["§b", "§3", "§9", "§d"], ["§a", "§2", "§b", "§9"],
    ["§d", "§5", "§9", "§1"], ["§e", "§6", "§c", "§4"]
];

// =============================================================================
// ANIMATION FUNCTIONS (UNCHANGED)
// =============================================================================

function animRainbow(text, tick) {
    let result = "";
    const plain = text.replace(/§./g, "");
    for (let i = 0; i < plain.length; i++) {
        const colorIndex = (i + Math.floor(tick / 3)) % RAINBOW_COLORS.length;
        result += RAINBOW_COLORS[colorIndex] + plain[i];
    }
    return result + "§r";
}

function animGradient(text, tick) {
    const plain = text.replace(/§./g, "");
    const palette = GRADIENT_PALETTES[Math.floor(tick / 40) % GRADIENT_PALETTES.length];
    let result = "";
    for (let i = 0; i < plain.length; i++) {
        const progress = i / Math.max(plain.length - 1, 1);
        const colorIndex = Math.floor(progress * (palette.length - 1));
        result += palette[colorIndex] + plain[i];
    }
    return result + "§r";
}

function animTypewriter(text, tick) {
    const plain = text.replace(/§./g, "");
    if (plain.length === 0) return "§7_§r";
    const totalFrames = plain.length * 2;
    const frame = Math.floor((tick / 3) % totalFrames);
    let visibleChars = frame < plain.length ? frame + 1 : totalFrames - frame;
    visibleChars = Math.max(0, Math.min(plain.length, visibleChars));
    return plain.substring(0, visibleChars) + "§7_§r";
}

function animBlink(text, tick) {
    return Math.floor(tick / 15) % 2 === 0 ? text : "§8" + text.replace(/§./g, "") + "§r";
}

function animFlash(text, tick) {
    const colors = ["§f", "§e", "§6", "§c", "§4"];
    return colors[Math.floor(tick / 2) % colors.length] + text.replace(/§./g, "") + "§r";
}

function animLoading(text, tick) {
    const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    return "§e" + spinners[Math.floor(tick / 3) % spinners.length] + " §r" + text;
}

function animPolice(text, tick) {
    const colors = ["§c§l", "§4§l", "§9§l", "§1§l"];
    return colors[Math.floor(tick / 4) % 4] + text.replace(/§./g, "") + "§r";
}

function animGlitch(text, tick) {
    const plain = text.replace(/§./g, "");
    const glitchChars = "!@#$%^&*<>[]{}|";
    if (Math.floor(tick / 5) % 8 < 2) {
        let result = "";
        for (let i = 0; i < plain.length; i++) {
            result += Math.random() < 0.25
                ? "§c" + glitchChars[Math.floor(Math.random() * glitchChars.length)]
                : "§f" + plain[i];
        }
        return result + "§r";
    }
    return "§f" + plain + "§r";
}

function animMarquee(text, tick) {
    const plain = text.replace(/§./g, "");
    const combined = plain + "     ";
    const offset = Math.floor(tick / 2) % combined.length;
    return (combined.substring(offset) + combined.substring(0, offset)).substring(0, plain.length);
}

function animSparkle(text, tick) {
    const plain = text.replace(/§./g, "");
    const sparkles = ["✦", "✧", "⋆", "·"];
    let result = "";
    for (let i = 0; i < plain.length; i++) {
        result += (i + Math.floor(tick / 4)) % 5 === 0
            ? "§e" + sparkles[Math.floor(tick / 3) % sparkles.length] + "§f" + plain[i]
            : "§f" + plain[i];
    }
    return result + "§r";
}

function animReverse(text) {
    return text.replace(/§./g, "").split("").reverse().join("");
}

function animTicker(text, tick) {
    const plain = text.replace(/§./g, "");
    const offset = Math.floor(tick / 4) % (plain.length * 2);
    return offset < plain.length
        ? " ".repeat(plain.length - offset) + plain.substring(0, offset)
        : plain.substring(offset - plain.length) + " ".repeat(offset - plain.length);
}

function animPulse(text, tick) {
    const b = ["§8", "§7", "§f", "§f§l", "§f", "§7"];
    return b[Math.floor(tick / 4) % b.length] + text.replace(/§./g, "") + "§r";
}

function animMirror(text) {
    const plain = text.replace(/§./g, "");
    return plain + "§7│§f" + plain.split("").reverse().join("");
}

function animSnake(text, tick) {
    const plain = text.replace(/§./g, "");
    const pos = Math.floor(tick / 3) % plain.length;
    let result = "";
    for (let i = 0; i < plain.length; i++) {
        result += i === pos ? "§a§l" + plain[i]
            : i === (pos + 1) % plain.length ? "§2" + plain[i]
                : "§8" + plain[i];
    }
    return result + "§r";
}

function animShimmer(text, tick) {
    const plain = text.replace(/§./g, "");
    const pos = Math.floor(tick / 2) % (plain.length + 4);
    let result = "";
    for (let i = 0; i < plain.length; i++) {
        const d = Math.abs(i - pos);
        result += d === 0 ? "§f§l" + plain[i]
            : d === 1 ? "§f" + plain[i]
                : d === 2 ? "§7" + plain[i]
                    : "§8" + plain[i];
    }
    return result + "§r";
}

function animCylon(text, tick) {
    const plain = text.replace(/§./g, "");
    const len = plain.length;
    const bounce = len * 2 - 2;
    const frame = Math.floor(tick / 2) % Math.max(bounce, 1);
    const pos = frame < len ? frame : bounce - frame;
    let result = "";
    for (let i = 0; i < len; i++) {
        const d = Math.abs(i - pos);
        result += d === 0 ? "§c§l" + plain[i]
            : d === 1 ? "§c" + plain[i]
                : d === 2 ? "§4" + plain[i]
                    : "§8" + plain[i];
    }
    return result + "§r";
}

function animBounce(text, tick) {
    const offsets = [0, 1, 2, 3, 2, 1];
    return " ".repeat(offsets[Math.floor(tick / 4) % offsets.length]) + text;
}

function processCustomAnimation(animName, text, tick, config) {
    if (!config.customAnimations) return text;
    const customAnim = config.customAnimations.find(a => a.name.toLowerCase() === animName.toLowerCase());
    if (!customAnim || !customAnim.frames || customAnim.frames.length === 0) return text;
    const frameIndex = Math.floor(tick / (customAnim.speed || 5)) % customAnim.frames.length;
    return customAnim.frames[frameIndex].replace(/\{text\}/gi, text);
}

function applyAnimation(animType, text, tick, config) {
    switch (animType.trim().toLowerCase()) {
        case "rainbow": return animRainbow(text, tick);
        case "gradient": return animGradient(text, tick);
        case "typewriter": return animTypewriter(text, tick);
        case "blink": return animBlink(text, tick);
        case "flash": return animFlash(text, tick);
        case "loading": return animLoading(text, tick);
        case "police": return animPolice(text, tick);
        case "glitch": return animGlitch(text, tick);
        case "marquee": return animMarquee(text, tick);
        case "sparkle": return animSparkle(text, tick);
        case "reverse": return animReverse(text);
        case "ticker": return animTicker(text, tick);
        case "pulse": return animPulse(text, tick);
        case "mirror": return animMirror(text);
        case "snake": return animSnake(text, tick);
        case "shimmer": return animShimmer(text, tick);
        case "cylon": return animCylon(text, tick);
        case "bounce": return animBounce(text, tick);
        default: return processCustomAnimation(animType, text, tick, config);
    }
}

// =============================================================================
// HELPER FUNCTIONS (UNCHANGED)
// =============================================================================

function getPlayerScore(player, objective) {
    try {
        const obj = world.scoreboard.getObjective(objective);
        return obj ? (obj.getScore(player) ?? 0) : 0;
    } catch (e) { return 0; }
}

function setPlayerScore(player, objective, value) {
    try {
        const obj = world.scoreboard.getObjective(objective);
        if (obj) obj.setScore(player, value);
    } catch (e) { }
}

function addScoreboardPoint(player, objective) {
    try {
        const obj = world.scoreboard.getObjective(objective);
        if (obj) obj.addScore(player, 1);
    } catch (e) { }
}

// =============================================================================
// ★ FIXED: PROPER NUMBER FORMATTING WITH 1T CAP!
// =============================================================================

/**
 * Format numbers with proper comma separation and K/M/B/T suffixes
 * Rules:
 * - Under 10,000: Show with commas (1,000, 9,999)
 * - 10,000 to 999,999: Show as X.XXk or XXk (11.11k, 100k)
 * - 1M to 999M: Show as X.XXM or XXXM
 * - 1B to 999B: Show as X.XXB or XXXB
 * - 1T max: Capped at 1T (1,000,000,000,000)
 */
function formatCustomNumber(value) {
    if (value === undefined || value === null || isNaN(value)) return "0";
    const MAX_VALUE = 9000000000000000; // 9 Quadrillion (safe integer cap)
    let num = parseFloat(value);
    if (!isFinite(num)) return "0";
    let isNegative = num < 0;
    num = Math.abs(num);
    if (num > MAX_VALUE) num = MAX_VALUE;
    num = Math.floor(num);
    if (num === 0) return "0";

    if (num < 10000) {
        return (isNegative ? "-" : "") + num.toLocaleString("en-US");
    }
    else if (num < 1000000) {
        // FIX: Use Math.floor to prevent 99,999 from rounding up to 100k
        const kValue = Math.floor((num / 1000) * 100) / 100;
        if (Number.isInteger(kValue)) {
            return (isNegative ? "-" : "") + kValue + "k";
        } else {
            return (isNegative ? "-" : "") + kValue.toFixed(2).replace(/\.?0+$/, '') + "k";
        }
    }
    else if (num < 1000000000) {
        const mValue = Math.floor((num / 1000000) * 100) / 100;
        if (Number.isInteger(mValue)) {
            return (isNegative ? "-" : "") + mValue + "M";
        } else {
            return (isNegative ? "-" : "") + mValue.toFixed(2).replace(/\.?0+$/, '') + "M";
        }
    }
    else if (num < 1000000000000) {
        const bValue = Math.floor((num / 1000000000) * 100) / 100;
        if (Number.isInteger(bValue)) {
            return (isNegative ? "-" : "") + bValue + "B";
        } else {
            return (isNegative ? "-" : "") + bValue.toFixed(2).replace(/\.?0+$/, '') + "B";
        }
    }
    else if (num < 1000000000000000) {
        const tValue = Math.floor((num / 1000000000000) * 100) / 100;
        if (Number.isInteger(tValue)) {
            return (isNegative ? "-" : "") + tValue + "T";
        } else {
            return (isNegative ? "-" : "") + tValue.toFixed(2).replace(/\.?0+$/, '') + "T";
        }
    }
    else {
        const qValue = Math.floor((num / 1000000000000000) * 100) / 100;
        if (Number.isInteger(qValue)) {
            return (isNegative ? "-" : "") + qValue + "Qa";
        } else {
            return (isNegative ? "-" : "") + qValue.toFixed(2).replace(/\.?0+$/, '') + "Qa";
        }
    }
}

/**
 * Validate if a value is within the allowed range (for money/score operations)
 * @param {number} value - The value to validate
 * @returns {boolean} true if valid, false if exceeds 1T
 */
function isValidScoreValue(value) {
    const num = parseFloat(value);
    if (!isFinite(num)) return false;
    if (num < 0) return false;
    if (num > 1000000000000) return false; // Max 1T
    return true;
}

/**
 * Clamp a value to valid range (0 to 1T)
 * @param {number} value - The value to clamp
 * @returns {number} Clamped value
 */
function clampToMax(value) {
    const num = parseFloat(value) || 0;
    if (num > 1000000000000) return 1000000000000; // Cap at 1T
    if (num < 0) return 0;
    return Math.floor(num);
}

function getGameTime(player, showIndicator = true) {
    try {
        const timeOfDay = player.dimension.getTimeOfDay();
        const totalMinutes = Math.floor((timeOfDay / 1000) * 60) + 360;
        const hours = Math.floor(totalMinutes / 60) % 24;
        const minutes = Math.floor(totalMinutes % 60);
        const indicator = hours >= 12 ? "PM" : "AM";
        const displayHours = hours % 12 || 12;
        return showIndicator
            ? `${displayHours}:${minutes.toString().padStart(2, "0")} ${indicator}`
            : `${displayHours}:${minutes.toString().padStart(2, "0")}`;
    } catch (e) { return "N/A"; }
}

function getGameDay() {
    try { return Math.floor(world.getAbsoluteTime() / 24000) + 1; }
    catch (e) { return 1; }
}

function getPlayerTag(player) {
    try {
        for (const tag of player.getTags()) {
            if (tag.startsWith("stag:")) return tag.substring(5);
        }
        return "";
    } catch (e) { return ""; }
}

function getPlayerPing(player) {
    try {
        const value = typeof player.getPing === "function" ? player.getPing() : player.ping;
        const ping = Number(value);
        return Number.isFinite(ping) && ping >= 0 ? `${Math.round(ping)}ms` : "N/A";
    } catch (e) { return "N/A"; }
}

function getHealthColor(current, max, config) {
    if (!config.healthDynamic || max === 0) return "§f";
    const ratio = current / max;
    if (ratio > 0.5) return config.healthHigh;
    if (ratio > 0.2) return config.healthMid;
    return config.healthLow;
}

function formatTimePlayed2(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => n.toString().padStart(2, "0");
    return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatTimePlayedCompact(totalSeconds) {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    return `${days}d ${hours}h`;
}

// =============================================================================
// CPS TRACKER (OPTIMIZED & FIXED)
// =============================================================================

const cpsTracker = new Map();
let lastMainhandCache = new Map();

function registerClick(playerId) {
    if (!cpsTracker.has(playerId)) cpsTracker.set(playerId, { clicks: [], lastCPS: 0, lastActivity: Date.now() });
    const data = cpsTracker.get(playerId);
    data.clicks.push(Date.now());
    data.lastActivity = Date.now();
}

function getPlayerCPS(player) {
    const data = cpsTracker.get(player.id);
    return data ? data.lastCPS : 0;
}

system.runInterval(() => {
    const now = Date.now();
    const cutoff = now - 1000;
    const staleThreshold = now - 5000;

    for (const [id, data] of cpsTracker) {
        if (data.clicks.length === 0 && data.lastActivity < staleThreshold) {
            cpsTracker.delete(id);
            continue;
        }

        let writeIdx = 0;
        const clicks = data.clicks;
        for (let i = 0; i < clicks.length; i++) {
            if (clicks[i] > cutoff) {
                clicks[writeIdx++] = clicks[i];
            }
        }
        clicks.length = writeIdx;
        data.lastCPS = clicks.length;
    }
}, 5);

world.afterEvents.entityHitEntity.subscribe((e) => {
    if (e.damagingEntity?.typeId === "minecraft:player") registerClick(e.damagingEntity.id);
});
world.afterEvents.entityHitBlock.subscribe((e) => {
    if (e.damagingEntity?.typeId === "minecraft:player") registerClick(e.damagingEntity.id);
});
world.beforeEvents.itemUse.subscribe((e) => {
    if (e.source?.typeId === "minecraft:player") registerClick(e.source.id);
});
world.beforeEvents.playerBreakBlock.subscribe((e) => {
    if (e.player?.typeId === "minecraft:player") registerClick(e.player.id);
});
world.afterEvents.playerInteractWithBlock.subscribe((e) => {
    if (e.player?.typeId === "minecraft:player") registerClick(e.player.id);
});
world.afterEvents.playerInteractWithEntity.subscribe((e) => {
    if (e.player?.typeId === "minecraft:player") registerClick(e.player.id);
});

system.runInterval(() => {
    const players = world.getAllPlayers();
    for (const player of players) {
        if (!player.isValid) continue;
        try {
            const equippable = player.getComponent("minecraft:equippable");
            if (!equippable) continue;
            const mainhand = equippable.getEquipment("Mainhand");
            const currentItem = mainhand ? mainhand.typeId : "empty";
            const cachedItem = lastMainhandCache.get(player.id);
            if (cachedItem !== undefined && cachedItem !== currentItem) {
                registerClick(player.id);
            }
            lastMainhandCache.set(player.id, currentItem);
        } catch (e) { }
    }
}, 10);

// =============================================================================
// CONFIG MANAGEMENT (WITH CACHING)
// =============================================================================

let cachedConfig = null;
let currentTPS = 20;
let lastTickTime = Date.now();
let animationTick = 0;

let configCacheTimestamp = 0;
const CONFIG_CACHE_TTL = 5000;

function getConfig() {
    const now = Date.now();
    if (cachedConfig && (now - configCacheTimestamp) < CONFIG_CACHE_TTL) {
        return cachedConfig;
    }

    const stored = world.getDynamicProperty(CONFIG_KEY);
    const defaultConfig = {
        refreshRate: 20,
        healthDynamic: true,
        healthHigh: "§a",
        healthMid: "§e",
        healthLow: "§c",
        hudMode: "sidebar", // "actionbar" to "sidebar"
        activeDisplay: "default",
        displayPresets: createDefaultDisplayPresets(),
        hudLines: [...DEFAULT_ZYD_DISPLAY_LINES],
        customAnimations: []
    };

    if (!stored) {
        cachedConfig = defaultConfig;
    } else {
        try {
            const parsed = JSON.parse(stored);
            const { showArmor, armorGlyphs, displayPresets, activeDisplay, hudLines, ...savedConfig } = parsed;
            const presets = getSavedDisplayPresets(displayPresets);
            const migratedActiveDisplay = !displayPresets && activeDisplay === "default" ? "donut" : activeDisplay;
            const selectedDisplay = migratedActiveDisplay === "default" || migratedActiveDisplay === "donut"
                ? migratedActiveDisplay
                : "custom";
            if (!displayPresets && selectedDisplay === "donut" && Array.isArray(hudLines)) presets.donut = [...hudLines];
            cachedConfig = {
                ...defaultConfig,
                ...savedConfig,
                displayPresets: presets,
                activeDisplay: selectedDisplay,
                hudLines: selectedDisplay === "custom"
                    ? (Array.isArray(hudLines) ? [...hudLines] : [...DEFAULT_ZYD_DISPLAY_LINES])
                    : [...presets[selectedDisplay]]
            };
            if (!cachedConfig.customAnimations) cachedConfig.customAnimations = [];

        } catch (e) {
            cachedConfig = defaultConfig;
        }
    }

    configCacheTimestamp = now;
    return cachedConfig;
}

function saveConfig(config) {
    cachedConfig = config;
    configCacheTimestamp = Date.now();
    try { world.setDynamicProperty(CONFIG_KEY, JSON.stringify(config)); } catch (e) { }
    restartHUDLoop();
}

// =============================================================================
// VARIABLE REPLACEMENT ENGINE (UNCHANGED)
// =============================================================================

function getVariableValue(player, variable, config) {
    let result = "N/A";
    const varName = variable.trim().toLowerCase();

    try {
        switch (varName) {
            case "playername": result = player.name; break;
            case "playerhealth-number": {
                const hc = player.getComponent("minecraft:health");
                if (hc) { const c = getHealthColor(hc.currentValue, hc.effectiveMax, config); result = c + Math.round(hc.currentValue) + "§r"; }
                else result = "0";
                break;
            }
            case "playerhealth-%": {
                const hp = player.getComponent("minecraft:health");
                if (hp && hp.effectiveMax > 0) { const c = getHealthColor(hp.currentValue, hp.effectiveMax, config); result = c + Math.round((hp.currentValue / hp.effectiveMax) * 100) + "%§r"; }
                else result = "0%";
                break;
            }
            case "playerhunger": result = (player.getComponent("minecraft:hunger") || { currentValue: 10 }).currentValue; break;
            case "playerxp": result = formatCustomNumber(player.xpEarnedAtCurrentLevel); break;
            case "playerxp-level": result = player.level; break;
            case "posx": result = Math.floor(player.location.x); break;
            case "posy": result = Math.floor(player.location.y); break;
            case "posz": result = Math.floor(player.location.z); break;
            case "dimension":
            case "dimenstion": {
                result = player.dimension.id.replace("minecraft:", "");
                result = result.charAt(0).toUpperCase() + result.slice(1);
                break;
            }
            case "playersplaying": result = world.getAllPlayers().length.toString(); break;
            case "tps": result = currentTPS.toFixed(1); break;
            case "time": result = getGameTime(player, true); break;
            case "day": result = getGameDay().toString(); break;
            case "cps": result = getPlayerCPS(player).toString(); break;
            case "ping": result = getPlayerPing(player); break;
            case "tag": result = getPlayerTag(player); break;
            case "rank": result = getActiveRankDisplay(player); break;
            case "nick": result = getActiveNickDisplay(player); break;
            case "rankpoints": result = formatCustomNumber(getPoints(player)); break;
            case "rankkills": result = formatCustomNumber(getPlayerScore(player, "PlayerKills")); break;
            case "globaltop": result = "#" + getGlobalTop(player); break;
            case "progress": result = getRankProgress(player); break;
            case "timeplayed-s": result = getPlayerScore(player, "TimePlayed"); break;
            case "timeplayed-m": result = Math.floor(getPlayerScore(player, "TimePlayed") / 60); break;
            case "timeplayed-h": result = Math.floor(getPlayerScore(player, "TimePlayed") / 3600); break;
            case "timeplayed-d": result = Math.floor(getPlayerScore(player, "TimePlayed") / 86400); break;

            case "kills": result = formatCustomNumber(getPlayerScore(player, "Kills")); break;
            case "deaths": result = formatCustomNumber(getPlayerScore(player, "Deaths")); break;
            case "playerkills": result = formatCustomNumber(getPlayerScore(player, "PlayerKills")); break;
            case "killstreak": result = formatCustomNumber(getPlayerScore(player, "KillStreak")); break;
            case "bestkillstreak": result = formatCustomNumber(getPlayerScore(player, "BestKillStreak")); break;
            case "blocksbreak": result = formatCustomNumber(getPlayerScore(player, "BlocksBreak")); break;
            case "blocksplace": result = formatCustomNumber(getPlayerScore(player, "BlocksPlace")); break;

            case "timeplayed2": result = formatTimePlayed2(getPlayerScore(player, "TimePlayed2")); break;
            case "timeplayedcompact": result = formatTimePlayedCompact(getPlayerScore(player, "TimePlayed2")); break;
            case "gamemode": result = "Survival"; break;
            case "money": result = formatCustomNumber(getBalance(player.scoreboardIdentity)); break;
            default: {
                if (varName.startsWith("scoreboard(") && varName.endsWith(")")) {
                    const objName = variable.trim().substring(11, variable.trim().length - 1);
                    result = formatCustomNumber(getPlayerScore(player, objName));
                } else {
                    let score = getPlayerScore(player, variable.trim());
                    if (score === 0 && variable.trim().length > 0) {
                        const capitalized = variable.trim().charAt(0).toUpperCase() + variable.trim().slice(1);
                        score = getPlayerScore(player, capitalized);
                    }
                    result = formatCustomNumber(score);
                }
                break;
            }
        }
    } catch (e) { result = "N/A"; }
    return String(result);
}

function processLine(player, line, tick, config) {
    let processed = line;
    processed = processed.replace(/\\n/g, "\n");

    processed = processed.replace(/\${anim,\s*([^,]+),\s*([^}]+)}/gi, (match, animType, text) => {
        return applyAnimation(animType.trim(), text.trim(), tick, config);
    });

    processed = processed.replace(/\${time,\s*Indi\((true|false)\)}/gi, (match, indicator) => {
        return getGameTime(player, indicator.toLowerCase() === "true");
    });

    processed = processed.replace(/\${(.*?)\((.*?)\)}/gi, (match, varName, modifier) => {
        const modLower = modifier.trim().toLowerCase();

        if (modLower === "formatscore") {
            const value = getVariableValue(player, varName, config);
            const plain = value.replace(/§./g, "");
            return value.replace(plain, formatCustomNumber(plain));
        }
        return match;
    });

    processed = processed.replace(/\${(.*?)}/g, (match, varName) => getVariableValue(player, varName, config));
    return processed + "§r";
}

// =============================================================================
// CORE STATS LOGIC (UNCHANGED)
// =============================================================================

world.afterEvents.entityDie.subscribe((event) => {
    if (event.deadEntity.typeId === "minecraft:player") {
        const deadPlayer = event.deadEntity;
        const killer = event.damageSource.damagingEntity;

        addScoreboardPoint(deadPlayer, "Deaths");
        setPlayerScore(deadPlayer, "KillStreak", 0);

        if (killer && killer.typeId === "minecraft:player") {
            addScoreboardPoint(killer, "Kills");
            addScoreboardPoint(killer, "PlayerKills");

            let currentStreak = getPlayerScore(killer, "KillStreak") + 1;
            setPlayerScore(killer, "KillStreak", currentStreak);

            let bestStreak = getPlayerScore(killer, "BestKillStreak");
            if (currentStreak > bestStreak) setPlayerScore(killer, "BestKillStreak", currentStreak);
        }
    } else if (event.damageSource.damagingEntity?.typeId === "minecraft:player") {
        addScoreboardPoint(event.damageSource.damagingEntity, "Kills");
    }
});

world.afterEvents.playerBreakBlock.subscribe((event) => {
    addScoreboardPoint(event.player, "BlocksBreak");
});

world.afterEvents.playerPlaceBlock.subscribe((event) => {
    addScoreboardPoint(event.player, "BlocksPlace");
});

system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
        addScoreboardPoint(player, "TimePlayed");
        addScoreboardPoint(player, "TimePlayed2");
    }
}, 20);

system.runInterval(() => {
    const now = Date.now();
    const elapsed = (now - lastTickTime) / 1000;
    const measuredTPS = Math.min(20, Math.round((1 / elapsed) * 20 * 10) / 10);
    currentTPS = (currentTPS * 0.9) + (measuredTPS * 0.1);
    lastTickTime = now;
}, 20);

// =============================================================================
// HUD DISPLAY LOOP (MAJOR OPTIMIZATION)
// =============================================================================

system.runInterval(() => {
    animationTick++;
    if (animationTick > 100000) animationTick = 0;
}, 1);

let hudLoopHandle = undefined;

function startHUDLoop() {
    if (hudLoopHandle !== undefined) return;

    const config = getConfig();
    const refreshRate = config.hudMode === "sidebar" ? 5 : config.refreshRate;

    console.warn(`✅ [Scoreboard] HUD Loop STARTED (refresh: ${refreshRate} ticks)`);

    hudLoopHandle = system.runInterval(() => {
        const config = getConfig();

        if (!config.hudLines || config.hudLines.length === 0) {
            stopHUDLoop();
            return;
        }

        const players = world.getAllPlayers();
        if (players.length === 0) return;

        for (const player of players) {
            if (!player.isValid) continue;

            try {
                const processedLines = config.hudLines.map(line =>
                    processLine(player, line, animationTick, config)
                );

                const hudText = processedLines.join("\n");

                if (config.hudMode === "actionbar") {
                    player.onScreenDisplay.setActionBar(hudText);
                } else if (config.hudMode === "sidebar") {
                    player.onScreenDisplay.setTitle(hudText, {
                        fadeInDuration: 0,
                        fadeOutDuration: 0,
                        stayDuration: 100
                    });
                }
            } catch (e) { }
        }
    }, refreshRate);
}

function stopHUDLoop() {
    if (hudLoopHandle !== undefined) {
        system.clearRun(hudLoopHandle);
        hudLoopHandle = undefined;
        console.warn(`⏹️ [Scoreboard] HUD Loop STOPPED`);
    }
}

function restartHUDLoop() {
    stopHUDLoop();
    system.runTimeout(() => {
        const config = getConfig();
        if (config.hudLines && config.hudLines.length > 0) {
            startHUDLoop();
        }
    }, 1);
}

// =============================================================================
// INITIALIZATION
// =============================================================================

system.run(() => {
    DEFAULT_OBJECTIVES.forEach(objective => {
        if (!world.scoreboard.getObjective(objective)) {
            try { world.scoreboard.addObjective(objective, objective); } catch (e) { }
        }
    });

    getConfig();

    system.runTimeout(() => {
        const config = getConfig();
        if (config.hudLines && config.hudLines.length > 0) {
            startHUDLoop();
        }
    }, 40);
});

// =============================================================================
// OPERATOR MENU SYSTEM (UNCHANGED)
// =============================================================================

export function showScoreboardMenu(player) {
    const config = getConfig();
    const form = new ActionFormData()
        .title("§9§lScoreboard HUD")
        .body(
            "§7Configure the scoreboard HUD display.\n\n" +
            `§7Mode: §f${config.hudMode === "actionbar" ? "Actionbar" : "Sidebar"}\n` +
            `§7Refresh Rate: §f${config.refreshRate} ticks\n` +
            `§7Lines: §f${config.hudLines.length}\n` +
            `§7Custom Animations: §f${config.customAnimations.length}\n\n` +
            `§7Health Dynamic: §f${config.healthDynamic ? "Yes" : "No"}`
        )
        .button("§e§lEdit Lines\n§r§8[ Modify HUD text ]", "textures/operator/lines.png")
        .button("§b§lScoreboard Display\n§r§8[ Choose a preset ]", "textures/edit2.png")
        .button("§b§lDisplay Settings\n§r§8[ Mode and refresh rate ]", "textures/operator/settings.png")
        .button("§a§lHealth Colors\n§r§8[ Dynamic health colors ]", "textures/operator/health.png")
        .button("§d§lCustom Animations\n§r§8[ Create animations ]", "textures/operator/animations.png")
        .button("§6§lVariables List\n§r§8[ View all variables ]", "textures/operator/variables.png")
        .button("§c§lReset Config\n§r§8[ Reset to default ]", "textures/operator/reset.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        switch (response.selection) {
            case 0: showEditLines(player); break;
            case 1: showScoreboardDisplayMenu(player); break;
            case 2: showDisplaySettings(player); break;
            case 3: showHealthColors(player); break;
            case 4: showCustomAnimationsMenu(player); break;
            case 5: showVariablesList(player); break;
            case 6: showResetConfig(player); break;
            case 7:
                import("./../menu.js").then(mod => {
                    if (typeof mod.showOperatorPanel === "function") mod.showOperatorPanel(player);
                });
                break;
        }
    });
}

function showScoreboardDisplayMenu(player) {
    const config = getConfig();
    const form = new ActionFormData()
        .title("§b§lScoreboard Display")
        .body("§7Choose a preset. Each preset keeps its own edits from §fEdit Lines§7.")
        .button("§a§lDefault\n§r§8ZYD Commands", "textures/operator/settings.png")
        .button("§b§lDr Donut SMP\n§r§8Scoreboard preset", "textures/operator/settings.png")
        .button("§c§lReset All\n§r§8Restore both preset designs", "textures/operator/reset.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 3) return showScoreboardMenu(player);
        if (response.selection === 2) {
            config.displayPresets = createDefaultDisplayPresets();
            setActiveDisplay(config, "default");
            saveConfig(config);
            player.sendMessage("§aBoth scoreboard presets were restored. Default is now active.");
            return showScoreboardMenu(player);
        }

        const selectedDisplay = response.selection === 0 ? "default" : "donut";
        setActiveDisplay(config, selectedDisplay);
        saveConfig(config);
        player.sendMessage(`§a${selectedDisplay === "default" ? "Default" : "Dr Donut SMP"} display applied. Use Edit Lines to customize it.`);
        showScoreboardMenu(player);
    });
}

function showEditLines(player, lineCount = null) {
    const config = getConfig();
    if (lineCount === null) lineCount = Math.max(3, config.hudLines.length);

    const form = new ModalFormData().title("§e§lEdit Lines");
    for (let i = 0; i < lineCount; i++) {
        const savedLine = config.hudLines[i];
        form.textField(`§7Line ${i + 1}`, "Enter text", { defaultValue: savedLine === "" ? " " : (savedLine ?? "") });
    }
    form.toggle("§e+ Add more lines", { defaultValue: false });

    form.show(player).then(response => {
        if (response.canceled) return showScoreboardMenu(player);
        const values = response.formValues;
        const addMoreLines = values[values.length - 1];

        const newLines = [];
        for (let i = 0; i < lineCount; i++) {
            const lineText = values[i];
            if (typeof lineText === "string" && lineText !== "") {
                lineText.split("\\n").forEach(splitLine => {
                    newLines.push(splitLine === "" ? " " : splitLine);
                });
            }
        }

        if (addMoreLines) {
            saveActiveDisplayLines(config, newLines);
            saveConfig(config);
            return showEditLines(player, Math.max(lineCount + 3, newLines.length));
        }

        saveActiveDisplayLines(config, newLines);
        saveConfig(config);
        player.sendMessage(`§aBoard saved with ${newLines.length} line(s)!`);
        showScoreboardMenu(player);
    });
}

function showDisplaySettings(player) {
    const config = getConfig();
    const form = new ModalFormData()
        .title("§b§lDisplay Settings")
        .dropdown("§7HUD Mode", ["actionbar", "sidebar"], { defaultValue: config.hudMode === "sidebar" ? 1 : 0 })
        .slider("§7Refresh Rate (Ticks)", 1, 100, { valueStep: 1, defaultValue: config.refreshRate });

    form.show(player).then(response => {
        if (response.canceled) return showScoreboardMenu(player);
        const [modeIdx, rate] = response.formValues;
        config.hudMode = modeIdx === 1 ? "sidebar" : "actionbar";
        config.refreshRate = rate;
        saveConfig(config);
        player.sendMessage("§aDisplay settings updated!");
        showScoreboardMenu(player);
    });
}

function showHealthColors(player) {
    const config = getConfig();
    const form = new ModalFormData()
        .title("§a§lHealth Colors")
        .toggle("§7Enable Dynamic Colors", { defaultValue: config.healthDynamic })
        .textField("§7High Health Color (e.g. §a)", "Color code", { defaultValue: config.healthHigh })
        .textField("§7Mid Health Color (e.g. §e)", "Color code", { defaultValue: config.healthMid })
        .textField("§7Low Health Color (e.g. §c)", "Color code", { defaultValue: config.healthLow });

    form.show(player).then(response => {
        if (response.canceled) return showScoreboardMenu(player);
        const [enabled, high, mid, low] = response.formValues;
        config.healthDynamic = enabled;
        config.healthHigh = high;
        config.healthMid = mid;
        config.healthLow = low;
        saveConfig(config);
        player.sendMessage("§aHealth colors updated!");
        showScoreboardMenu(player);
    });
}

function showCustomAnimationsMenu(player) {
    const config = getConfig();
    const count = config.customAnimations ? config.customAnimations.length : 0;
    const form = new ActionFormData()
        .title("§d§lCustom Animations")
        .body(`§7Create and manage custom text animations.\n§8Total: ${count} animation(s)\n\n§eUsage: \${anim, <name>, <text>}`)
        .button("§l§aCreate Animation", "textures/operator/add.png")
        .button("§l§bEdit Animation", "textures/operator/edit.png")
        .button("§l§cDelete Animation", "textures/operator/delete.png")
        .button("§l§eView All", "textures/operator/lines.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 4) return showScoreboardMenu(player);
        switch (response.selection) {
            case 0: createCustomAnimation(player); break;
            case 1: editCustomAnimationSelect(player); break;
            case 2: deleteCustomAnimationSelect(player); break;
            case 3: viewAllAnimations(player); break;
        }
    });
}

function createCustomAnimation(player) {
    const form = new ModalFormData()
        .title("§a§lCreate Animation")
        .textField("§7Animation Name", "e.g. myAnim", { defaultValue: "" })
        .slider("§7Speed (ticks per frame)", 1, 20, { valueStep: 1, defaultValue: 5 })
        .textField("§7Frame 1", "Use {text} as placeholder", { defaultValue: "§a{text}" })
        .textField("§7Frame 2", "Leave empty to skip", { defaultValue: "§b{text}" })
        .textField("§7Frame 3", "Leave empty to skip", { defaultValue: "§c{text}" })
        .textField("§7Frame 4", "Leave empty to skip", { defaultValue: "" })
        .textField("§7Frame 5", "Leave empty to skip", { defaultValue: "" });

    form.show(player).then(response => {
        if (response.canceled) return showCustomAnimationsMenu(player);
        const [name, speed, ...frames] = response.formValues;
        if (!name || name.trim() === "") { player.sendMessage("§cName is required!"); return createCustomAnimation(player); }
        const validFrames = frames.filter(f => f && f.trim() !== "");
        if (validFrames.length === 0) { player.sendMessage("§cAt least one frame is required!"); return createCustomAnimation(player); }

        const config = getConfig();
        if (config.customAnimations.find(a => a.name.toLowerCase() === name.trim().toLowerCase())) {
            player.sendMessage("§cAnimation already exists!"); return createCustomAnimation(player);
        }

        config.customAnimations.push({ name: name.trim(), speed, frames: validFrames });
        saveConfig(config);
        player.sendMessage(`§aAnimation "${name}" created!`);
        addMoreFrames(player, config.customAnimations.length - 1);
    });
}

function addMoreFrames(player, animIndex) {
    const config = getConfig();
    const anim = config.customAnimations[animIndex];
    const form = new ActionFormData()
        .title("§e§lAdd More Frames?")
        .body(`§7Animation: §f${anim.name}\n§7Current frames: §f${anim.frames.length}`)
        .button("§l§aAdd More Frames", "textures/operator/create.png")
        .button("§l§7Done", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) return showCustomAnimationsMenu(player);
        const frameForm = new ModalFormData().title("§a§lAdd Frames");
        for (let i = 0; i < 5; i++) frameForm.textField(`§7Frame ${anim.frames.length + i + 1}`, "Leave empty to skip", { defaultValue: "" });

        frameForm.show(player).then(res => {
            if (res.canceled) return showCustomAnimationsMenu(player);
            const newFrames = res.formValues.filter(f => f && f.trim() !== "");
            anim.frames.push(...newFrames);
            saveConfig(config);
            player.sendMessage(`§aAdded ${newFrames.length} frame(s)!`);
            addMoreFrames(player, animIndex);
        });
    });
}

function editCustomAnimationSelect(player) {
    const config = getConfig();
    if (!config.customAnimations || config.customAnimations.length === 0) {
        player.sendMessage("§cNo animations yet.");
        return showCustomAnimationsMenu(player);
    }
    const form = new ActionFormData().title("§b§lEdit Animation").body("§7Select an animation:");
    config.customAnimations.forEach(a => form.button(`§b${a.name}\n§8${a.frames.length} frames | Speed: ${a.speed}`, "textures/operator/edit.png"));
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === config.customAnimations.length) return showCustomAnimationsMenu(player);
        editAnimationDetails(player, response.selection);
    });
}

function editAnimationDetails(player, index) {
    const config = getConfig();
    const anim = config.customAnimations[index];
    const form = new ModalFormData().title(`§b§lEdit: ${anim.name}`)
        .textField("§7Name", "Name", { defaultValue: anim.name })
        .slider("§7Speed", 1, 20, { valueStep: 1, defaultValue: anim.speed });
    for (let i = 0; i < Math.max(anim.frames.length, 5); i++) form.textField(`§7Frame ${i + 1}`, "Leave empty to remove", { defaultValue: anim.frames[i] || "" });

    form.show(player).then(response => {
        if (response.canceled) return editCustomAnimationSelect(player);
        const [name, speed, ...frameValues] = response.formValues;
        const frames = frameValues.filter(f => f && f.trim() !== "");
        if (!name || name.trim() === "" || frames.length === 0) {
            player.sendMessage("§cInvalid input!");
            return editAnimationDetails(player, index);
        }
        config.customAnimations[index] = { name: name.trim(), speed, frames };
        saveConfig(config);
        player.sendMessage(`§aAnimation "${name}" updated!`);
        editCustomAnimationSelect(player);
    });
}

function deleteCustomAnimationSelect(player) {
    const config = getConfig();
    if (!config.customAnimations || config.customAnimations.length === 0) {
        player.sendMessage("§cNo animations yet.");
        return showCustomAnimationsMenu(player);
    }
    const form = new ActionFormData().title("§c§lDelete Animation").body("§7Select an animation to delete:");
    config.customAnimations.forEach(a => form.button(`§c${a.name}`, "textures/operator/delete.png"));
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === config.customAnimations.length) return showCustomAnimationsMenu(player);
        const name = config.customAnimations[response.selection].name;
        config.customAnimations.splice(response.selection, 1);
        saveConfig(config);
        player.sendMessage(`§cAnimation "${name}" deleted!`);
        deleteCustomAnimationSelect(player);
    });
}

function viewAllAnimations(player) {
    const config = getConfig();
    let body = "§7Your custom animations:\n\n";
    if (!config.customAnimations || config.customAnimations.length === 0) body += "§8No animations created yet.";
    else config.customAnimations.forEach(a => {
        body += `§b${a.name}§r\n§8Speed: ${a.speed} | Frames: ${a.frames.length}\n§7Usage: \${anim, ${a.name}, YourText}\n\n`;
    });
    const form = new ActionFormData().title("§e§lAll Animations").body(body).button("§cBack", "textures/back.png");
    form.show(player).then(() => showCustomAnimationsMenu(player));
}

function showVariablesList(player) {
    const form = new ActionFormData()
        .title("§6§lVariables List")
        .body(
            "§e§l--- Player Stats ---\n" +
            "§f${PlayerName} §7- Player name\n" +
            "§f${PlayerHealth-Number} §7- Health amount\n" +
            "§f${PlayerHealth-%} §7- Health percentage\n" +
            "§f${PlayerHunger} §7- Food level\n" +
            "§f${PlayerXP} §7- XP points (Formatted)\n" +
            "§f${PlayerXP-Level} §7- XP Level\n\n" +
            "§b§l--- Rank System ---\n" +
            "§f${rank} §7- Active Rank Title\n" +
            "§f${nick} §7- Active Nickname\n" +
            "§f${rankpoints} §7- Rank Points (Formatted)\n" +
            "§f${rankkills} §7- Player Kills (Formatted)\n" +
            "§f${globaltop} §7- Global Top Position\n" +
            "§f${progress} §7- Rank Progress %\n\n" +
            "§e§l--- Location ---\n" +
            "§f${PosX} §7- X coordinate\n" +
            "§f${PosY} §7- Y coordinate\n" +
            "§f${PosZ} §7- Z coordinate\n" +
            "§f${Dimension} §7- Current dimension\n\n" +
            "§e§l--- Server ---\n" +
            "§f${PlayersPlaying} §7- Online players\n" +
            "§f${TPS} §7- Server TPS\n" +
            "§f${Time} §7- In-game time\n" +
            "§f${Day} §7- In-game day\n" +
            "§f${CPS} §7- Clicks per second\n" +
            "§f${Ping} §7- Player ping, when the server API provides it\n" +
            "§f${Tag} §7- Custom stag: tag\n\n" +
            "§e§l--- Scoreboard (Auto-Formatted) ---\n" +
            "§f${Kills} §7- Total kills\n" +
            "§f${Deaths} §7- Total deaths\n" +
            "§f${PlayerKills} §7- Player kills\n" +
            "§f${KillStreak} §7- Current streak\n" +
            "§f${BestKillStreak} §7- Best streak\n" +
            "§f${BlocksBreak} §7- Blocks broken\n" +
            "§f${BlocksPlace} §7- Blocks placed\n" +
            "§f${TimePlayed2} §7- Formatted time\n" +
            "§f${TimePlayedCompact} §7- Days and hours only\n\n" +
            "§e§l--- Special ---\n" +
            "§f${anim, rainbow, Text} §7- Animations\n" +
            "§f${scoreboard(Objective)} §7- Custom obj\n\n" +
            "§6§l--- Limits ---\n" +
            "§fMax Value: §c9Qa (9,000,000,000,000,000)"
        )
        .button("§cBack", "textures/back.png");

    form.show(player).then(() => showScoreboardMenu(player));
}

function showResetConfig(player) {
    const form = new ActionFormData()
        .title("§c§lReset Config")
        .body("§c⚠ WARNING §c⚠\n\n§7This will reset ALL scoreboard HUD settings to default!\n§7Custom animations will be deleted.")
        .button("§c§lYes, Reset", "textures/operator/reset.png")
        .button("§aCancel", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection !== 0) return showScoreboardMenu(player);
        world.setDynamicProperty(CONFIG_KEY, null);
        cachedConfig = null;
        configCacheTimestamp = 0;
        getConfig();
        player.sendMessage("§cScoreboard config has been reset!");
        showScoreboardMenu(player);
    });
}

console.warn("§a✨ ZYD Scoreboard System Loaded (FIXED NUMBER FORMATTING)");

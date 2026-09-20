import { world, system } from "@minecraft/server";

// ============================================
// SET HOME DATA MANAGER
// ============================================

const DATA_KEY = "zyd_set_home_data";
const SETTINGS_KEY = "zyd_home_settings";
const PLAYER_LIMITS_KEY = "zyd_player_home_limits";
const PURCHASED_HOMES_KEY = "zyd_purchased_homes_data";

// ============================================
// DEFAULT SETTINGS
// ============================================

const defaultSettings = {
    maxHomes: 2,
    teleportCountdown: 5,
    teleportCooldown: 10,
    opBypassLimit: true,
    maxPurchasedHomes: 3
};

// ============================================
// HOME ICONS (Using claim_*.png textures)
// ============================================

export const HOME_ICONS = [
    { id: "home", name: "Home", texture: "textures/random/claim_0.png" },
    { id: "house", name: "House", texture: "textures/random/claim_10.png" },
    { id: "shovel", name: "Shovel", texture: "textures/random/claim_1.png" },
    { id: "flag", name: "Flag", texture: "textures/random/claim_2.png" },
    { id: "bed", name: "Bed", texture: "textures/random/claim_3.png" },
    { id: "boat", name: "Boat", texture: "textures/random/claim_4.png" },
    { id: "chest", name: "Chest", texture: "textures/random/claim_5.png" },
    { id: "cow", name: "Cow", texture: "textures/random/claim_6.png" },
    { id: "crown", name: "Crown", texture: "textures/random/claim_7.png" },
    { id: "enchanting", name: "Enchanting", texture: "textures/random/claim_8.png" },
    { id: "spawner", name: "Spawner", texture: "textures/random/claim_9.png" },
    { id: "wolf", name: "Wolf", texture: "textures/random/claim_11.png" },
    { id: "redstone", name: "Redstone", texture: "textures/random/claim_12.png" },
    { id: "dragon", name: "Dragon", texture: "textures/random/claim_13.png" },
    { id: "mushroom", name: "Mushroom", texture: "textures/random/claim_14.png" },
    { id: "blaze", name: "Blaze", texture: "textures/random/claim_15.png" },
    { id: "villager", name: "Villager", texture: "textures/random/claim_16.png" },
    { id: "lock", name: "Lock", texture: "textures/random/claim_17.png" },
    { id: "key", name: "Key", texture: "textures/random/claim_18.png" },
    { id: "globe", name: "Globe", texture: "textures/random/claim_19.png" },
    { id: "flower", name: "Flower", texture: "textures/random/claim_20.png" },
    { id: "sapling", name: "Sapling", texture: "textures/random/claim_21.png" },
    { id: "coin", name: "Coin", texture: "textures/random/claim_22.png" },
    { id: "furnace", name: "Furnace", texture: "textures/random/claim_23.png" },
    { id: "sword", name: "Sword", texture: "textures/random/claim_24.png" },
    { id: "star", name: "Star", texture: "textures/random/claim_25.png" },
    { id: "nether_portal", name: "Nether Portal", texture: "textures/random/claim_26.png" },
    { id: "end_portal", name: "End Portal", texture: "textures/random/claim_27.png" },
    { id: "music_note", name: "Music Note", texture: "textures/random/claim_28.png" },
    { id: "lightning", name: "Lightning", texture: "textures/random/claim_29.png" },
    { id: "grass", name: "Grass", texture: "textures/random/claim_30.png" },
    { id: "machine", name: "Machine", texture: "textures/random/claim_31.png" },
    { id: "toilet", name: "Toilet", texture: "textures/random/claim_32.png" },
    { id: "egg", name: "Egg", texture: "textures/random/claim_33.png" },
    { id: "ice_cream", name: "Ice Cream", texture: "textures/random/claim_34.png" },
    { id: "cage", name: "Cage", texture: "textures/random/claim_35.png" },
    { id: "barn", name: "Barn", texture: "textures/random/claim_36.png" },
    { id: "book", name: "Book", texture: "textures/random/claim_37.png" },
    { id: "forest", name: "Forest", texture: "textures/random/claim_38.png" },
    { id: "border_house", name: "Border House", texture: "textures/random/claim_border.png" },
    { id: "trash", name: "Trash", texture: "textures/random/delete_claim.png" }
];

// ============================================
// PRICE TIERS FOR BUYING HOMES
// Simple format: 1K, 10K, 100K, 500K, 1M, 2M, 3M... 1B... 1T
// ============================================

export const DEFAULT_PRICE_TIERS = [
    1000,           // 1st buy -> "1K"
    10000,          // 2nd buy -> "10K"
    100000,         // 3rd buy -> "100K"
    500000,         // 4th buy -> "500K"
    1000000,        // 5th buy -> "1M"
    2000000,        // 6th buy -> "2M"
    3000000,        // 7th buy -> "3M"
    4000000,        // 8th buy -> "4M"
    5000000,        // 9th buy -> "5M"
    6000000,        // 10th buy -> "6M"
    7000000,        // 11th buy -> "7M"
    8000000,        // 12th buy -> "8M"
    9000000,        // 13th buy -> "9M"
    10000000,       // 14th buy -> "10M"
];

// MAX CAP for any single purchase price = 1 Trillion
export const MAX_PURCHASE_PRICE = 1000000000000;

// ============================================
// CORE DATA FUNCTIONS
// ============================================

export function getHomeData() {
    try {
        const rawData = world.getDynamicProperty(DATA_KEY);
        if (!rawData) return {};
        return JSON.parse(rawData);
    } catch (e) {
        console.warn("[SetHome] Failed to load home data:", e);
        return {};
    }
}

export function saveHomeData(data) {
    try {
        world.setDynamicProperty(DATA_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn("[SetHome] Failed to save home data:", e);
    }
}

// ============================================
// GLOBAL SETTINGS
// ============================================

export function getSettings() {
    try {
        const rawSettings = world.getDynamicProperty(SETTINGS_KEY);
        if (!rawSettings) return { ...defaultSettings };
        return { ...defaultSettings, ...JSON.parse(rawSettings) };
    } catch (e) {
        console.warn("[SetHome] Failed to load settings:", e);
        return { ...defaultSettings };
    }
}

export function saveSettings(settings) {
    try {
        world.setDynamicProperty(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn("[SetHome] Failed to save settings:", e);
    }
}

// ============================================
// PLAYER HOMES MANAGEMENT
// ============================================

export function getPlayerHomes(playerId) {
    const allData = getHomeData();
    return allData[playerId] || [];
}

export function savePlayerHomes(playerId, homes) {
    const allData = getHomeData();
    allData[playerId] = homes;
    saveHomeData(allData);
}

export function addHome(playerId, homeData) {
    const homes = getPlayerHomes(playerId);

    if (homes.some(h => h.name.toLowerCase() === homeData.name.toLowerCase())) {
        return {
            success: false,
            message: '§cA home named §e"' + homeData.name + '"§c already exists!'
        };
    }

    homes.push({
        id: Date.now().toString() + "_" + Math.random().toString(36).substr(2, 9),
        name: homeData.name,
        x: Math.floor(homeData.x),
        y: Math.floor(homeData.y),
        z: Math.floor(homeData.z),
        dimension: homeData.dimension || "minecraft:overworld",
        icon: homeData.icon || "home",
        createdAt: Date.now()
    });

    savePlayerHomes(playerId, homes);

    return {
        success: true,
        message: '§aHome §e"' + homeData.name + '"§a created successfully!'
    };
}

export function updateHome(playerId, homeId, updates) {
    const homes = getPlayerHomes(playerId);
    const index = homes.findIndex(h => h.id === homeId);

    if (index === -1) {
        return { success: false, message: "§cHome not found!" };
    }

    if (updates.name) {
        const duplicate = homes.find(h =>
            h.id !== homeId &&
            h.name.toLowerCase() === updates.name.toLowerCase()
        );
        if (duplicate) {
            return { success: false, message: "§cA home with that name already exists!" };
        }
    }

    homes[index] = { ...homes[index], ...updates, updatedAt: Date.now() };

    if (updates.x !== undefined) homes[index].x = Math.floor(updates.x);
    if (updates.y !== undefined) homes[index].y = Math.floor(updates.y);
    if (updates.z !== undefined) homes[index].z = Math.floor(updates.z);

    savePlayerHomes(playerId, homes);

    return {
        success: true,
        message: '§aHome §e"' + homes[index].name + '"§a updated successfully!'
    };
}

export function deleteHome(playerId, homeId) {
    const homes = getPlayerHomes(playerId);
    const index = homes.findIndex(h => h.id === homeId);

    if (index === -1) {
        return { success: false, message: "§cHome not found!" };
    }

    const deletedName = homes[index].name;
    homes.splice(index, 1);
    savePlayerHomes(playerId, homes);

    return {
        success: true,
        message: '§cHome §e"' + deletedName + '"§c deleted!',
        homeName: deletedName
    };
}

export function getAllPlayersWithHomes() {
    const allData = getHomeData();
    const result = [];

    Object.keys(allData).forEach(playerId => {
        if (allData[playerId].length > 0) {
            const player = world.getAllPlayers().find(p => p.id === playerId);
            result.push({
                playerId: playerId,
                playerName: player ? player.name : "Unknown",
                homes: allData[playerId],
                isOnline: !!player
            });
        }
    });

    return result;
}

// ============================================
// PER-PLAYER HOME LIMITS SYSTEM
// ============================================

export function getPlayerLimits() {
    try {
        const rawData = world.getDynamicProperty(PLAYER_LIMITS_KEY);
        if (!rawData) return {};
        return JSON.parse(rawData);
    } catch (e) {
        return {};
    }
}

export function savePlayerLimits(limits) {
    try {
        world.setDynamicProperty(PLAYER_LIMITS_KEY, JSON.stringify(limits));
    } catch (e) { }
}

export function setPlayerLimit(playerId, limit) {
    const limits = getPlayerLimits();
    limits[playerId] = limit;
    savePlayerLimits(limits);
}

export function getPlayerLimit(playerId) {
    const limits = getPlayerLimits();
    return limits[playerId] !== undefined ? limits[playerId] : null;
}

export function removePlayerLimit(playerId) {
    const limits = getPlayerLimits();
    delete limits[playerId];
    savePlayerLimits(limits);
}

export function hasCustomLimit(playerId) {
    return playerId in getPlayerLimits();
}

export function getEffectiveMaxHomes(player) {
    const settings = getSettings();
    const isOp = player.hasTag("op") || player.hasTag("admin");

    if (isOp && settings.opBypassLimit) {
        return Infinity;
    }

    const customLimit = getPlayerLimit(player.id);
    if (customLimit !== null && customLimit !== undefined) {
        return customLimit;
    }

    return settings.maxHomes || 2;
}

export function getAllPlayersWithCustomLimits() {
    const limits = getPlayerLimits();
    const result = [];

    Object.keys(limits).forEach(playerId => {
        const player = world.getAllPlayers().find(p => p.id === playerId);
        result.push({
            playerId: playerId,
            playerName: player ? player.name : "Unknown",
            limit: limits[playerId],
            isOnline: !!player
        });
    });

    return result;
}

// ============================================
// BUY MORE HOMES SYSTEM
// ============================================

export function getPurchasedHomesData() {
    try {
        const rawData = world.getDynamicProperty(PURCHASED_HOMES_KEY);
        if (!rawData) return {};
        return JSON.parse(rawData);
    } catch (e) {
        return {};
    }
}

export function savePurchasedHomesData(data) {
    try {
        world.setDynamicProperty(PURCHASED_HOMES_KEY, JSON.stringify(data));
    } catch (e) { }
}

export function getPlayerPurchasedCount(playerId) {
    const data = getPurchasedHomesData();
    const playerData = data[playerId];
    return playerData ? playerData.count : 0;
}

export function setPlayerPurchasedCount(playerId, count) {
    const data = getPurchasedHomesData();
    if (!data[playerId]) {
        data[playerId] = { count: 0 };
    }
    data[playerId].count = count;
    savePurchasedHomesData(data);
}

export function incrementPlayerPurchase(playerId) {
    const currentCount = getPlayerPurchasedCount(playerId);
    const newCount = currentCount + 1;
    setPlayerPurchasedCount(playerId, newCount);
    return newCount;
}

/**
 * Calculate price for NEXT purchase
 * Format: 1K, 10K, 100K, 500K, 1M, 2M, 3M... 1B... 1T max
 */
export function getNextPurchasePrice(playerId) {
    const purchasedCount = getPlayerPurchasedCount(playerId);
    const tiers = DEFAULT_PRICE_TIERS;

    if (purchasedCount < tiers.length) {
        return Math.min(tiers[purchasedCount], MAX_PURCHASE_PRICE);
    }

    // Beyond predefined tiers: last tier was 10M at index 13
    // After that: 11M, 12M, 13M... until 999M then 1B, 2B...
    const lastTierValue = tiers[tiers.length - 1]; // 10,000,000
    const lastTierIndex = tiers.length - 1; // 13

    const buysBeyondTiers = purchasedCount - lastTierIndex;
    let calculatedPrice = lastTierValue + (buysBeyondTiers * 1000000); // Add 1M per extra buy

    return Math.min(calculatedPrice, MAX_PURCHASE_PRICE);
}

/**
 * Format price simply: 1K, 10K, 100K, 500K, 1M, 2M... 1B... 1T
 */
export function formatPrice(price) {
    if (price >= 1000000000000) {
        return "$" + (price / 1000000000000) + "T";
    }
    if (price >= 1000000000) {
        return "$" + (price / 1000000000) + "B";
    }
    if (price >= 1000000) {
        return "$" + (price / 1000000) + "M";
    }
    if (price >= 1000) {
        return "$" + (price / 1000) + "K";
    }
    return "$" + price;
}

export function getMaxPurchasedHomes() {
    const settings = getSettings();
    let max = settings.maxPurchasedHomes || 3;
    if (max > 100) max = 100;
    if (max < 0) max = 0;
    return max;
}

export function canPlayerBuyMore(playerId) {
    const purchasedCount = getPlayerPurchasedCount(playerId);
    const maxAllowed = getMaxPurchasedHomes();

    if (purchasedCount >= maxAllowed) {
        return {
            canBuy: false,
            reason: "MAX_PURCHASED",
            currentCount: purchasedCount,
            maxAllowed: maxAllowed
        };
    }

    return {
        canBuy: true,
        currentCount: purchasedCount,
        maxAllowed: maxAllowed
    };
}

// ============================================
// FIX: Replace your existing getTotalEffectiveMaxHomes with this one
// ============================================

/**
 * Total effective max homes considering everything
 * Priority: OP Bypass > Custom Manual Limit > (Global Default + Purchased Bonus)
 * 
 * @param {Object|Player} player - Can be real Player object OR plain data object { id, name }
 * @returns {number}
 */
export function getTotalEffectiveMaxHomes(player) {
    const settings = getSettings();

    // Check if player is a real Player object (has hasTag method) or data object
    var isOp = false;
    var playerId = null;

    // Try to detect what type of object was passed
    if (player && typeof player.id === "string") {
        // It's likely a data object from getAllPlayersWithHomes()
        playerId = player.playerId || player.id;

        // For data objects, check if they have isOnline property to find real player
        if (player.isOnline === true) {
            // Find the actual online player to check OP status
            var realPlayer = world.getAllPlayers().find(function (p) {
                return p.id === playerId;
            });
            if (realPlayer) {
                isOp = realPlayer.hasTag("op") || realPlayer.hasTag("admin");
            }
        } else {
            // Offline player - can't be OP anyway
            isOp = false;
        }
    } else if (player && typeof player.hasTag === "function") {
        // It's a real Player object
        isOp = player.hasTag("op") || player.hasTag("admin");
        playerId = player.id;
    }

    if (isOp && settings.opBypassLimit) {
        return Infinity;
    }

    const customLimit = getPlayerLimit(playerId);
    if (customLimit !== null && customLimit !== undefined) {
        return customLimit;
    }

    const globalDefault = settings.maxHomes || 2;
    const purchasedBonus = getPlayerPurchasedCount(playerId);

    return globalDefault + purchasedBonus;
}

// ============================================
// TELEPORT COOLDOWN
// ============================================

const teleportCooldowns = new Map();

export function checkCooldown(playerId) {
    const settings = getSettings();
    const now = Date.now();
    const lastTeleport = teleportCooldowns.get(playerId) || 0;
    const elapsed = (now - lastTeleport) / 1000;
    const remaining = settings.teleportCooldown - elapsed;

    if (remaining > 0) {
        return { canTeleport: false, remainingTime: Math.ceil(remaining) };
    }

    return { canTeleport: true };
}

export function setCooldown(playerId) {
    teleportCooldowns.set(playerId, Date.now());
}

export function clearCooldown(playerId) {
    teleportCooldowns.delete(playerId);
}

// ============================================
// UTILITIES
// ============================================

export function formatCoords(x, y, z) {
    return Math.floor(x) + ", " + Math.floor(y) + ", " + Math.floor(z);
}

export function getDimensionName(dimensionId) {
    const names = {
        "minecraft:overworld": "§aOverworld",
        "minecraft:nether": "§cNether",
        "minecraft:the_end": "§dThe End"
    };
    return names[dimensionId] || "§fUnknown";
}
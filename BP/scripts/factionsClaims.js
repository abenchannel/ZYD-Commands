// scripts/factionsClaims.js
// ============================================
// FACTIONS CLAIMS — Territory & Chunk Control
// ============================================
// Contains:
// - Chunk math & dictionary storage (No-lag architecture)
// - Claim & Unclaim execution (with Overclaiming!)
// - Dimension restrictions (Overworld default)
// - ASCII Map generator with dynamic centering
// - Live Auto-Map background tracker
// - Area Permissions (per-chunk access & rules)
// ============================================

import { world, system } from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import {
    getAllFactions,
    getPlayerFactionId,
    saveAllFactions,
    calculateFactionPower,
    MAX_POWER_PER_MEMBER,
    hasFactionPermission
} from "./factionsCore.js";

// ============================================
// SECTION 1: CONSTANTS & CONFIGURATION
// ============================================

const CLAIM_MAP_KEY = "zyd:claim_map";
const CLAIM_DIMS_KEY = "zyd:claim_allowed_dims";
const CLAIM_POWER_RATIO = 2; // 2 power = 1 claim
const CHUNK_PERMS_KEY = "zyd:chunk_perms";

export function getAllowedClaimDimensions() {
    try {
        const raw = world.getDynamicProperty(CLAIM_DIMS_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { }
    return { nether: false, end: false }; // Overworld is always true
}

export function saveAllowedClaimDimensions(dims) {
    try {
        world.setDynamicProperty(CLAIM_DIMS_KEY, JSON.stringify(dims));
    } catch (e) { }
}
const EXPAND_EAST_WEST = 6; // Radius East/West (e.g., 6 = 13 wide)
const EXPAND_NORTH_SOUTH = 3; // Radius North/South (e.g., 3 = 7 tall)

// ============================================
// SECTION 2: CLAIM MAP DATA HELPERS (The "No-Lag" Database)
// ============================================

function getClaimMap() {
    try {
        const raw = world.getDynamicProperty(CLAIM_MAP_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.warn("[FactionsClaims] Failed to load claim map:", e);
        return {};
    }
}

function saveClaimMap(map) {
    try {
        world.setDynamicProperty(CLAIM_MAP_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn("[FactionsClaims] Failed to save claim map:", e);
    }
}

// Chunk perms helpers (shared key with factionsCore direct helpers)
function getChunkPermsMap() {
    try {
        const raw = world.getDynamicProperty(CHUNK_PERMS_KEY);
        const map = raw ? JSON.parse(raw) : {};
        // migrate old entries: ensure public fields exist
        let migrated = false;
        for (const key in map) {
            const entry = map[key];
            if (!entry) continue;
            if (entry.canBreakPublic === undefined) { entry.canBreakPublic = false; migrated = true; }
            if (entry.canPlacePublic === undefined) { entry.canPlacePublic = false; migrated = true; }
            if (entry.canUseRedstonePublic === undefined) { entry.canUseRedstonePublic = false; migrated = true; }
            if (entry.canOpenContainersPublic === undefined) { entry.canOpenContainersPublic = false; migrated = true; }
            if (entry.syncEnabled === undefined) { entry.syncEnabled = true; migrated = true; }
            if (!Array.isArray(entry.allowedMembers)) { entry.allowedMembers = []; migrated = true; }
        }
        if (migrated) {
            try { world.setDynamicProperty(CHUNK_PERMS_KEY, JSON.stringify(map)); } catch (e) { }
        }
        return map;
    } catch (e) { return {}; }
}
function saveChunkPermsMap(map) {
    try {
        world.setDynamicProperty(CHUNK_PERMS_KEY, JSON.stringify(map));
    } catch (e) { }
}
export function getChunkPermAt(chunkKey) {
    try {
        const map = getChunkPermsMap();
        return map[chunkKey] || null;
    } catch (e) { return null; }
}
function ensureChunkPerm(chunkKey, factionId) {
    const map = getChunkPermsMap();
    if (!map[chunkKey]) {
        map[chunkKey] = getDefaultChunkPerm(factionId);
        saveChunkPermsMap(map);
        return map[chunkKey];
    }
    // if existing but faction changed (overclaim), reset
    if (map[chunkKey].factionId !== factionId) {
        map[chunkKey] = getDefaultChunkPerm(factionId);
        saveChunkPermsMap(map);
        return map[chunkKey];
    }
    // migrate old entries: ensure all fields exist
    let migrated = false;
    const def = getDefaultChunkPerm(factionId);
    for (const k in def) {
        if (map[chunkKey][k] === undefined) {
            map[chunkKey][k] = def[k];
            migrated = true;
        }
    }
    if (migrated) {
        // keep factionId correct
        map[chunkKey].factionId = factionId;
        saveChunkPermsMap(map);
    }
    return map[chunkKey];
}
function deleteChunkPermAt(chunkKey) {
    const map = getChunkPermsMap();
    if (map[chunkKey]) {
        delete map[chunkKey];
        saveChunkPermsMap(map);
    }
}

// ============================================
// SECTION 3: CHUNK MATH & CONNECTION HELPERS
// ============================================

function getChunkCoords(location) {
    return {
        x: Math.floor(location.x / 16),
        z: Math.floor(location.z / 16)
    };
}

function getChunkKey(x, z, dimensionId) {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    return `${dimensionId}_${cx},${cz}`;
}

function countFactionClaims(claimMap, factionId) {
    let count = 0;
    for (const key in claimMap) {
        if (claimMap[key] === factionId) count++;
    }
    return count;
}

export function getChunkOwnerAt(location, dimensionId) {
    const claimMap = getClaimMap();
    const chunkKey = getChunkKey(location.x, location.z, dimensionId);
    return claimMap[chunkKey] || null;
}

// ============================================
// SECTION 4: THE CLAIM UI (Called by the Wand)
// ============================================

export function showClaimMenuUI(player) {
    const factionId = getPlayerFactionId(player.id);
    const currentDim = player.dimension.id;
    const dims = getAllowedClaimDimensions();
    const isDimAllowed = currentDim === "minecraft:overworld" ||
        (currentDim === "minecraft:nether" && dims.nether) ||
        (currentDim === "minecraft:the_end" && dims.end);

    const { x, z } = getChunkCoords(player.location);
    const chunkKey = getChunkKey(player.location.x, player.location.z, currentDim);
    const claimMap = getClaimMap();
    const currentOwner = claimMap[chunkKey];
    const factions = getAllFactions();

    let isEnemy = false;
    let isAlly = false;
    if (factionId && currentOwner && currentOwner !== factionId) {
        const myFac = factions[factionId];
        if (myFac) {
            if (myFac.enemies && myFac.enemies.some(e => e.factionId === currentOwner)) isEnemy = true;
            if (myFac.allies && myFac.allies.includes(currentOwner)) isAlly = true;
        }
    }

    // Permission check for canClaim
    let hasCanClaim = false;
    if (factionId) {
        const myFac = factions[factionId];
        if (myFac) {
            hasCanClaim = hasFactionPermission(myFac, player.id, "canClaim");
        }
    }

    let statusText = "";
    let targetPowerText = "";
    if (currentOwner) {
        const ownerFaction = factions[currentOwner];
        const ownerName = ownerFaction ? `${ownerFaction.iconUnicode} ${ownerFaction.name}`.replace(/§r/g, "") : "§8Unknown";
        const ownerPlainName = ownerFaction ? ownerFaction.name.replace(/§./g, "").trim() : "Unknown";

        if (currentOwner === factionId) {
            statusText = `§7Status: §aClaimed §7(Your Faction: ${ownerName}§7)`;
        } else {
            let relationLabel = "Other Faction";
            if (isEnemy) relationLabel = "Enemy Faction";
            else if (isAlly) relationLabel = "Ally Faction";
            // Requirement: "Claimed (Other Faction: Name)"
            statusText = `§7Status: §cClaimed §7(${relationLabel}: ${ownerName}§7)`;

            if (ownerFaction) {
                targetPowerText = `§7Target Power: §b${calculateFactionPower(ownerFaction)}\n`;
            }
        }
    } else {
        statusText = "§7Status: §aWilderness §7(Unclaimed)";
    }

    let bodyText = "§7---------------------------\n";
    bodyText += `§7Dimension: §f${currentDim.replace("minecraft:", "")}\n`;
    bodyText += `§7Land Coord: §f${x}, ${z}\n`;
    bodyText += `${statusText}\n`;
    if (targetPowerText) bodyText += targetPowerText;

    if (factionId) {
        const faction = factions[factionId];
        if (faction) {
            const power = calculateFactionPower(faction);
            const maxClaims = Math.floor(power / CLAIM_POWER_RATIO);
            const currentClaims = countFactionClaims(claimMap, factionId);
            bodyText += "§7---------------------------\n";
            bodyText += `§7Faction Power: §b${power}\n`;
            bodyText += `§7Max Claims: §f${maxClaims}\n`;
            bodyText += `§7Current Claims: §f${currentClaims}\n`;
        }
    } else {
        bodyText += "§7---------------------------\n";
        bodyText += "§cYou are not in a faction.\n";
    }
    bodyText += "§7---------------------------";

    const form = new ActionFormData()
        .title("§6§lClaim Manager")
        .body(bodyText);

    const buttons = [];

    if (factionId && isDimAllowed && hasCanClaim) {
        if (!currentOwner) {
            buttons.push("claim");
            form.button("§aClaim Land\n§f[ Expand your territory ]", "textures/tpa2.png");
        } else if (currentOwner !== factionId && isEnemy) {
            buttons.push("claim");
            form.button("§6Overclaim Land\n§f[ Steal this territory ]", "textures/tpa2.png");
        }
    }

    if (factionId && currentOwner === factionId && hasCanClaim) {
        buttons.push("unclaim");
        form.button("§eUnclaim Land\n§f[ Release this territory ]", "textures/rank_colours/red.png");
    }

    // Area Permissions button above Claim Settings, only when standing on own claim and has canClaim
    if (factionId && currentOwner === factionId && hasCanClaim) {
        buttons.push("area_perms");
        form.button("§dArea Permissions\n§f[ Chunk access & rules ]", "textures/random/roles.png");
    }

    buttons.push("settings");
    form.button("§fClaim Settings\n§f[ Map & Configuration ]", "textures/settings.png");

    buttons.push("back");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        const action = buttons[response.selection];

        if (action === "claim") executeClaim(player);
        else if (action === "unclaim") executeUnclaim(player);
        else if (action === "area_perms") showAreaPermissionsUI(player);
        else if (action === "settings") showClaimSettingsUI(player);
    });
}

// ============================================
// SECTION 5: CLAIM & OVERCLAIM EXECUTION
// ============================================

export function executeClaim(player) {
    const factionId = getPlayerFactionId(player.id);
    if (!factionId) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou are not in a faction.");
    }

    const currentDim = player.dimension.id;
    const allowedDims = getAllowedClaimDimensions();

    if (currentDim === "minecraft:nether" && !allowedDims.nether) {
        player.playSound("note.bass");
        return player.sendMessage("§cClaiming land in the Nether is currently disabled!");
    }
    if (currentDim === "minecraft:the_end" && !allowedDims.end) {
        player.playSound("note.bass");
        return player.sendMessage("§cClaiming land in the End is currently disabled!");
    }

    const claimMap = getClaimMap();
    const chunkKey = getChunkKey(player.location.x, player.location.z, currentDim);
    const { x, z } = getChunkCoords(player.location);

    const factions = getAllFactions();
    const myFaction = factions[factionId];
    if (!myFaction) {
        player.playSound("note.bass");
        return player.sendMessage("§cFaction data not found.");
    }

    if (!hasFactionPermission(myFaction, player.id, "canClaim")) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou do not have permission to claim land! (Requires Can Claim)");
    }

    const myPower = calculateFactionPower(myFaction);
    const maxAllowedClaims = Math.floor(myPower / CLAIM_POWER_RATIO);
    const currentClaims = countFactionClaims(claimMap, factionId);
    const historicalMax = myFaction.maxClaimsReached || 0;

    let isOverclaim = false;
    let targetFactionId = null;

    // Already claimed? Overclaim checks
    if (claimMap[chunkKey]) {
        targetFactionId = claimMap[chunkKey];

        // Your own land
        if (targetFactionId === factionId) {
            player.playSound("note.bass");
            return player.sendMessage(`§cYou already claimed this area. §7(${currentClaims}/${maxAllowedClaims})`);
        }

        const targetFaction = factions[targetFactionId];
        if (!targetFaction) {
            // Owner data missing — treat as free land
            targetFactionId = null;
        } else {
            const targetName = `${targetFaction.iconUnicode} ${targetFaction.name}`;

            // Rule 1: Must be enemies
            const isEnemy = (myFaction.enemies || []).some(e => e.factionId === targetFactionId);
            if (!isEnemy) {
                player.playSound("note.bass");
                return player.sendMessage(`§cCannot claim this area. It belongs to ${targetName}§c. You must declare them as an enemy first.`);
            }

            // Rule 2: Must have higher CURRENT power
            const targetPower = calculateFactionPower(targetFaction);
            if (myPower <= targetPower) {
                player.playSound("note.bass");
                return player.sendMessage(`§cCannot overclaim ${targetName}§c. Your faction power (§e${myPower}§c) must be higher than theirs (§e${targetPower}§c).`);
            }

            isOverclaim = true;
        }
    }

    // Rule 3: Claim capacity / high water mark
    if (currentClaims >= maxAllowedClaims && currentClaims >= historicalMax) {
        player.playSound("note.bass");
        return player.sendMessage(`§cCannot claim more land. You need more power. §7(${currentClaims}/${maxAllowedClaims})`);
    }

    // SUCCESS
    claimMap[chunkKey] = factionId;
    saveClaimMap(claimMap);

    // Chunk perms handling
    try {
        if (isOverclaim) {
            // Overclaim: reset perms to new owner defaults
            const map = getChunkPermsMap();
            map[chunkKey] = getDefaultChunkPerm(factionId);
            saveChunkPermsMap(map);
        } else {
            ensureChunkPerm(chunkKey, factionId);
        }
    } catch (e) { }

    myFaction.currentClaims = currentClaims + 1;
    if (myFaction.currentClaims > (myFaction.maxClaimsReached || 0)) {
        myFaction.maxClaimsReached = myFaction.currentClaims;
    }

    if (isOverclaim && targetFactionId && factions[targetFactionId]) {
        const tFaction = factions[targetFactionId];
        tFaction.currentClaims = Math.max(0, countFactionClaims(claimMap, targetFactionId));

        const myFactionName = `${myFaction.iconUnicode} ${myFaction.name}`;

        // Check if enemy Faction Home was in this stolen chunk
        if (tFaction.home) {
            const homeCx = Math.floor(tFaction.home.x / 16);
            const homeCz = Math.floor(tFaction.home.z / 16);
            const homeDim = tFaction.home.dimension || "minecraft:overworld";

            if (homeCx === x && homeCz === z && homeDim === currentDim) {
                delete tFaction.home;
            }
        }

        // Notify Victim Faction (Online & Offline)
        for (const mid in tFaction.members) {
            const m = world.getAllPlayers().find(p => p.id === mid);
            if (m) {
                m.sendMessage(`§c§l[FACTIONS] §r§cYour territory at (${x}, ${z}) was stolen by ${myFactionName}§c!`);
                m.playSound("random.break");
            } else {
                tFaction.members[mid].notifications = tFaction.members[mid].notifications || [];
                tFaction.members[mid].notifications.push(`§c- 1 claim at (${x}, ${z}) was stolen by ${myFactionName}§c.`);
            }
        }

        player.sendMessage(`§a§lSuccessfully Overclaimed! §r§7You stole this territory from ${tFaction.iconUnicode} ${tFaction.name}§7. §7(${myFaction.currentClaims}/${maxAllowedClaims})`);
    } else {
        player.sendMessage(`§a§lSuccessfully Claimed! §r§7(${myFaction.currentClaims}/${maxAllowedClaims})`);
    }

    saveAllFactions(factions);
    player.playSound("random.levelup");
}

// ============================================
// SECTION 6: UNCLAIM EXECUTION
// ============================================

export function executeUnclaim(player) {
    const factionId = getPlayerFactionId(player.id);
    if (!factionId) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou are not in a faction.");
    }

    const claimMap = getClaimMap();
    const chunkKey = getChunkKey(player.location.x, player.location.z, player.dimension.id);

    if (!claimMap[chunkKey]) {
        player.playSound("note.bass");
        return player.sendMessage("§cThis area is not claimed.");
    }

    if (claimMap[chunkKey] !== factionId) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou cannot unclaim this area. It does not belong to your faction.");
    }

    const factions = getAllFactions();
    const faction = factions[factionId];
    if (faction && !hasFactionPermission(faction, player.id, "canClaim")) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou do not have permission to unclaim land! (Requires Can Claim)");
    }

    // SUCCESS: Unclaim the chunk
    delete claimMap[chunkKey];
    saveClaimMap(claimMap);
    try { deleteChunkPermAt(chunkKey); } catch (e) { }

    const { x, z } = getChunkCoords(player.location);

    // Update faction counter & check if Faction Home was in this chunk
    if (faction) {
        faction.currentClaims = Math.max(0, (faction.currentClaims || 1) - 1);

        if (faction.home) {
            const homeCx = Math.floor(faction.home.x / 16);
            const homeCz = Math.floor(faction.home.z / 16);
            const homeDim = faction.home.dimension || "minecraft:overworld";

            if (homeCx === x && homeCz === z && homeDim === player.dimension.id) {
                delete faction.home;
                player.sendMessage("§c§l[FACTIONS] §r§cYour Faction Home was deleted because this land was unclaimed.");
            }
        }

        saveAllFactions(factions);
    }

    player.playSound("random.orb");
    player.sendMessage(`§e§lSuccessfully Unclaimed! §r§7(${faction ? faction.currentClaims : 0} remaining)`);
}

// ============================================
// SECTION 7: TERRITORY ACTION BAR (Entering/Leaving)
// ============================================
const playerLastChunk = new Map();

function getTerritoryDisplayInfo(ownerId, myFactionId, factions) {
    if (!ownerId || !myFactionId || ownerId === myFactionId) return { prefixColor: "", prefix: "" };

    const myFaction = factions[myFactionId];
    if (myFaction) {
        if ((myFaction.allies || []).includes(ownerId)) return { prefixColor: "§d", prefix: "Ally " };
        if ((myFaction.enemies || []).some(e => e.factionId === ownerId)) return { prefixColor: "§c", prefix: "Enemy " };
    }
    return { prefixColor: "", prefix: "" };
}

system.runInterval(() => {
    const claimMap = getClaimMap();
    const factions = getAllFactions();

    for (const player of world.getAllPlayers()) {
        const currentDim = player.dimension.id;
        const chunkKey = getChunkKey(player.location.x, player.location.z, currentDim);
        const lastKey = playerLastChunk.get(player.id);

        if (chunkKey !== lastKey) {
            const currentOwner = claimMap[chunkKey];
            const lastOwner = lastKey ? claimMap[lastKey] : null;

            if (currentOwner !== lastOwner) {
                const myFactionId = getPlayerFactionId(player.id);

                const cInfo = getTerritoryDisplayInfo(currentOwner, myFactionId, factions);

                const fName = currentOwner
                    ? (factions[currentOwner] ? `§b${factions[currentOwner].iconUnicode} ${factions[currentOwner].name}` : "§bUnknown")
                    : "";
                const lName = lastOwner
                    ? (factions[lastOwner] ? `§b${factions[lastOwner].iconUnicode} ${factions[lastOwner].name}` : "§bUnknown")
                    : "";

                if (lastOwner && currentOwner) {
                    // Claim to Claim
                    player.onScreenDisplay.setActionBar(`§cLeaving ${lName} §7➤ §aEntering ${cInfo.prefixColor}${cInfo.prefix}${fName}`);
                } else if (!lastOwner && currentOwner) {
                    // Wilderness to Claim
                    player.onScreenDisplay.setActionBar(`§aEntering ${cInfo.prefixColor}${cInfo.prefix}${fName}`);
                } else if (lastOwner && !currentOwner) {
                    // Claim to Wilderness
                    player.onScreenDisplay.setActionBar(`§cLeaving ${lName}`);
                }
            }
            playerLastChunk.set(player.id, chunkKey);
        }
    }
}, 10);

// ============================================
// SECTION 8: ASCII MAP GENERATOR
// ============================================
export const autoMapPlayers = new Set();

export function generateAsciiMap(player) {
    const claimMap = getClaimMap();
    const factions = getAllFactions();
    const px = Math.floor(player.location.x / 16);
    const pz = Math.floor(player.location.z / 16);
    const dim = player.dimension.id;

    const playerChunkKey = getChunkKey(player.location.x, player.location.z, dim);
    const playerFactionId = getPlayerFactionId(player.id);
    const ownerOfCurrentChunk = claimMap[playerChunkKey];

    const halfW = EXPAND_EAST_WEST;
    const halfH = EXPAND_NORTH_SOUTH;

    // --- DYNAMIC ALIGNMENT CALCULATIONS ---
    const rowWidth = 6 + ((2 * halfW + 1) * 2);
    const border = "§8" + "-".repeat(Math.max(1, rowWidth - 5));
    const padding = " ".repeat(3 + (halfW * 2) + 3);

    let playerSymbolColor = "§e"; // Default yellow
    if (ownerOfCurrentChunk === playerFactionId) {
        playerSymbolColor = "§a"; // Green if yours
    } else if (ownerOfCurrentChunk) {
        playerSymbolColor = "§c"; // Red if someone else's
    }

    const myFaction = playerFactionId ? factions[playerFactionId] : null;

    const mapRows = [];
    for (let z = -halfH; z <= halfH; z++) {
        let row = "";
        for (let x = -halfW; x <= halfW; x++) {
            if (x === 0 && z === 0) {
                row += `${playerSymbolColor}+ `;
            } else {
                const key = `${dim}_${px + x},${pz + z}`;
                const ownerId = claimMap[key];
                if (!ownerId) {
                    row += "§7= "; // Wilderness gray
                } else if (ownerId === playerFactionId) {
                    row += "§a# "; // Own green
                } else if (myFaction) {
                    if ((myFaction.allies || []).includes(ownerId)) {
                        row += "§d# "; // Ally pink
                    } else if ((myFaction.enemies || []).some(e => e.factionId === ownerId)) {
                        row += "§c# "; // Enemy light red
                    } else {
                        row += "§b# "; // Other cyan
                    }
                } else {
                    row += "§b# "; // Other cyan when factionless
                }
            }
        }
        mapRows.push(row);
    }

    let mapStr = "\n";
    mapStr += padding + "§fN§r\n";
    mapStr += border + "\n";

    for (const row of mapRows) {
        mapStr += "§fW  " + row + "  E\n";
    }

    mapStr += border + "\n";
    mapStr += padding + "§fS§r\n";

    // Updated legend with new colors
    mapStr += `${playerSymbolColor}You: +§r §f|§r §aOwn: # §f|§r §bOther: # §f|§r §cEnemy: # §f|§r §dAlly: # §f|§r §7Wild: =`;

    return mapStr;
}

// ============================================
// SECTION 9: AUTO-MAP BACKGROUND LOOP
// ============================================
export const autoMapLastChunk = new Map();

system.runInterval(() => {
    if (autoMapPlayers.size === 0) return;

    const playersToRemove = [];
    for (const playerId of autoMapPlayers) {
        const player = world.getAllPlayers().find(p => p.id === playerId);
        if (!player) {
            playersToRemove.push(playerId);
            continue;
        }

        const currentDim = player.dimension.id;
        const currentChunkKey = getChunkKey(player.location.x, player.location.z, currentDim);
        const lastChunkKey = autoMapLastChunk.get(player.id);

        if (currentChunkKey !== lastChunkKey) {
            autoMapLastChunk.set(player.id, currentChunkKey);
            player.sendMessage(generateAsciiMap(player));
        }
    }

    for (const id of playersToRemove) {
        autoMapPlayers.delete(id);
        autoMapLastChunk.delete(id);
    }
}, 20);

// ============================================
// SECTION 10: CLAIM SETTINGS UI
// ============================================
function showClaimSettingsUI(player) {
    const isAutoMapOn = autoMapPlayers.has(player.id);

    const form = new ActionFormData()
        .title("§7§lClaim Settings")
        .body(`§7Claim System Configuration\n\n§7Live Map Tracker: ${isAutoMapOn ? "§aENABLED" : "§cDISABLED"}\n§7Automatically prints a map in chat\n§7every time you cross a chunk border.`);

    if (isAutoMapOn) {
        form.button("§cDisable Live Map\n§f[ Stop chat updates ]", "textures/rank_colours/red.png");
    } else {
        form.button("§aEnable Live Map\n§f[ Start chat updates ]", "textures/rank_colours/green.png");
    }

    form.button("§eView Full Map Once\n§f[ Print map now ]", "textures/list.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === 0) {
            if (autoMapPlayers.has(player.id)) {
                autoMapPlayers.delete(player.id);
                autoMapLastChunk.delete(player.id);
                player.sendMessage("§7Live map tracker §cDISABLED§7.");
            } else {
                autoMapPlayers.add(player.id);
                player.sendMessage("§7Live map tracker §aENABLED§7. Moving around will update your map.");
                player.sendMessage(generateAsciiMap(player));
            }
            showClaimSettingsUI(player);
        } else if (response.selection === 1) {
            player.sendMessage(generateAsciiMap(player));
            showClaimSettingsUI(player);
        } else {
            showClaimMenuUI(player);
        }
    });
}

// ============================================
// SECTION 10b: AREA PERMISSIONS SYSTEM
// ============================================

function getDefaultChunkPerm(factionId) {
    return {
        factionId: factionId,
        syncEnabled: true,
        canBreak: false,
        canPlace: false,
        canUseRedstone: false,
        canOpenContainers: false,
        canBreakPublic: false,
        canPlacePublic: false,
        canUseRedstonePublic: false,
        canOpenContainersPublic: false,
        allowedMembers: []
    };
}

function showAreaPermissionsUI(player) {
    const factionId = getPlayerFactionId(player.id);
    if (!factionId) {
        player.sendMessage("§cYou are not in a faction.");
        return showClaimMenuUI(player);
    }
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showClaimMenuUI(player);

    if (!hasFactionPermission(faction, player.id, "canClaim")) {
        player.sendMessage("§cYou do not have permission to manage Area Permissions! (Requires Can Claim)");
        return showClaimMenuUI(player);
    }

    const chunkKey = getChunkKey(player.location.x, player.location.z, player.dimension.id);
    const claimMap = getClaimMap();
    const owner = claimMap[chunkKey];
    if (owner !== factionId) {
        player.sendMessage("§cYou must stand inside your own claimed chunk to manage Area Permissions.");
        return showClaimMenuUI(player);
    }

    const perms = getChunkPermAt(chunkKey) || ensureChunkPerm(chunkKey, factionId);
    const { x, z } = getChunkCoords(player.location);
    const syncStatus = perms.syncEnabled ? "§cON (DISABLED)" : "§aOFF (ENABLED)";
    const membersCount = (perms.allowedMembers || []).length;
    const permSummaryMember = `Break:${perms.canBreak ? "§aON" : "§cOFF"}§f Place:${perms.canPlace ? "§aON" : "§cOFF"}§f Redstone:${perms.canUseRedstone ? "§aON" : "§cOFF"}§f Containers:${perms.canOpenContainers ? "§aON" : "§cOFF"}`;
    const permSummaryPublic = `Break:${perms.canBreakPublic ? "§aON" : "§cOFF"}§f Place:${perms.canPlacePublic ? "§aON" : "§cOFF"}§f Redstone:${perms.canUseRedstonePublic ? "§aON" : "§cOFF"}§f Containers:${perms.canOpenContainersPublic ? "§aON" : "§cOFF"}`;

    let body = "§7---------------------------\n";
    body += `§7Chunk: §f${x}, ${z} §7Dim: §f${player.dimension.id.replace("minecraft:", "")}\n`;
    body += `§7Sync: ${syncStatus} §8[ON=DISABLED, OFF=ENABLED]\n`;
    body += `§7Members: §f${membersCount}/10\n`;
    body += `§7Member Perms: ${permSummaryMember}\n`;
    body += `§7Public Perms: ${permSummaryPublic}\n`;
    body += "§7---------------------------\n";
    body += "§7Sync ON = Area Permissions DISABLED (fully locked).\n";
    body += "§7Sync OFF = ENABLED (member + public active).\n";
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title("§d§lArea Permissions")
        .body(body)
        .button(`§bMembers\n§f[ ${membersCount}/10 ]`, "textures/list.png")
        .button("§eSettings Permissions\n§f[ Member + Public ]", "textures/settings.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) showAreaPermsMembersUI(player, chunkKey, factionId);
        else if (res.selection === 1) showAreaPermsSettingsUI(player, chunkKey, factionId);
        else showClaimMenuUI(player);
    });
}

function showAreaPermsMembersUI(player, chunkKey, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showClaimMenuUI(player);

    const perms = getChunkPermAt(chunkKey) || ensureChunkPerm(chunkKey, factionId);
    const allowed = perms.allowedMembers || [];

    let body = `§7Chunk: §f${chunkKey}\n§7Allowed: §f${allowed.length}/10\n§7---------------------------\n`;
    if (allowed.length === 0) body += "§7No members added yet.\n";
    else body += "§7Members with extra access in this chunk (when Sync OFF).\n";
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title("§b§lArea Members")
        .body(body)
        .button("§aAdd Member\n§f[ Invite faction member ]", "textures/add.png");

    const onlinePlayers = world.getAllPlayers();
    const memberButtons = [];
    for (const pid of allowed) {
        const mData = faction.members[pid];
        const onlineP = onlinePlayers.find(p => p.id === pid);
        const name = onlineP?.name || mData?.name || "Unknown";
        const role = mData?.role || "member";
        form.button(`§f${name}\n§eRole: ${role} §f| §cRemove`, "textures/rank_colours/gray.png");
        memberButtons.push(pid);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) {
            showAreaPermsAddMemberUI(player, chunkKey, factionId);
        } else if (res.selection >= 1 && res.selection < 1 + memberButtons.length) {
            const targetId = memberButtons[res.selection - 1];
            showAreaPermsRemoveMemberConfirmUI(player, chunkKey, factionId, targetId);
        } else {
            showAreaPermissionsUI(player);
        }
    });
}

function showAreaPermsAddMemberUI(player, chunkKey, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showClaimMenuUI(player);

    const perms = getChunkPermAt(chunkKey) || ensureChunkPerm(chunkKey, factionId);
    const allowed = perms.allowedMembers || [];

    if (allowed.length >= 10) {
        player.sendMessage("§cThis chunk already has max 10 allowed members.");
        return showAreaPermsMembersUI(player, chunkKey, factionId);
    }

    const eligible = [];
    for (const mid in faction.members) {
        if (allowed.includes(mid)) continue;
        const mem = faction.members[mid];
        if (!mem) continue;
        // Owner exclusion: Owner role always has all perms
        if (mem.role === "owner") continue;
        // Exclude anyone who already has all 4 role perms
        const hasAll4 = hasFactionPermission(faction, mid, "canBreak") &&
            hasFactionPermission(faction, mid, "canPlace") &&
            hasFactionPermission(faction, mid, "canOpenContainers") &&
            hasFactionPermission(faction, mid, "canUseDoors");
        if (hasAll4) continue;
        eligible.push({ id: mid, data: mem });
    }

    if (eligible.length === 0) {
        player.sendMessage("§cNo eligible faction members to add (all already allowed, owner, or have full perms).");
        return showAreaPermsMembersUI(player, chunkKey, factionId);
    }

    const onlinePlayers = world.getAllPlayers();
    eligible.sort((a, b) => {
        const nameA = (onlinePlayers.find(p => p.id === a.id)?.name || a.data.name || "").toLowerCase();
        const nameB = (onlinePlayers.find(p => p.id === b.id)?.name || b.data.name || "").toLowerCase();
        return nameA.localeCompare(nameB);
    });

    const form = new ActionFormData()
        .title("§a§lAdd Area Member")
        .body(`§7Select a faction member to grant extra access in this chunk (when Sync OFF).\n§7Current: §f${allowed.length}/10`);

    for (const e of eligible) {
        const onlineP = onlinePlayers.find(p => p.id === e.id);
        const name = onlineP?.name || e.data.name || "Unknown";
        const role = e.data.role || "member";
        const status = onlineP ? "§aOnline" : "§cOffline";
        form.button(`§f${name}\n§e${role} §f| ${status}`, "textures/tpa2.png");
    }
    form.button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === eligible.length) { showAreaPermsMembersUI(player, chunkKey, factionId); return; }
        const chosen = eligible[res.selection];
        if (!chosen) return showAreaPermsAddMemberUI(player, chunkKey, factionId);

        const map = getChunkPermsMap();
        const current = map[chunkKey] || getDefaultChunkPerm(factionId);
        current.allowedMembers = current.allowedMembers || [];
        if (current.allowedMembers.length >= 10) {
            player.sendMessage("§cMax 10 members reached.");
            return showAreaPermsMembersUI(player, chunkKey, factionId);
        }
        if (!current.allowedMembers.includes(chosen.id)) {
            current.allowedMembers.push(chosen.id);
            current.factionId = factionId;
            map[chunkKey] = current;
            saveChunkPermsMap(map);
            const name = world.getAllPlayers().find(p => p.id === chosen.id)?.name || chosen.data.name;
            player.sendMessage(`§aAdded §f${name} §ato Area Permissions for chunk §e${chunkKey}§a.`);
            player.playSound("random.orb");
        }
        showAreaPermsMembersUI(player, chunkKey, factionId);
    });
}

function showAreaPermsRemoveMemberConfirmUI(player, chunkKey, factionId, targetId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showClaimMenuUI(player);
    const mData = faction.members[targetId];
    const onlineP = world.getAllPlayers().find(p => p.id === targetId);
    const name = onlineP?.name || mData?.name || "Unknown";

    const form = new MessageFormData()
        .title("§c§lRemove Area Member")
        .body(`§cRemove §f${name}§c from Area Permissions for this chunk?\n\n§7They will remain a faction member, but lose extra chunk access.`)
        .button1("§cYes, Remove")
        .button2("§aCancel");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 1) { showAreaPermsMembersUI(player, chunkKey, factionId); return; }
        const map = getChunkPermsMap();
        if (map[chunkKey] && Array.isArray(map[chunkKey].allowedMembers)) {
            map[chunkKey].allowedMembers = map[chunkKey].allowedMembers.filter(id => id !== targetId);
            saveChunkPermsMap(map);
            player.sendMessage(`§eRemoved §f${name} §efrom Area Permissions.`);
            player.playSound("random.orb");
        }
        showAreaPermsMembersUI(player, chunkKey, factionId);
    });
}

function showAreaPermsSettingsUI(player, chunkKey, factionId) {
    const perms = getChunkPermAt(chunkKey) || ensureChunkPerm(chunkKey, factionId);
    // ensure public fields exist for UI
    if (perms.canBreakPublic === undefined) perms.canBreakPublic = false;
    if (perms.canPlacePublic === undefined) perms.canPlacePublic = false;
    if (perms.canUseRedstonePublic === undefined) perms.canUseRedstonePublic = false;
    if (perms.canOpenContainersPublic === undefined) perms.canOpenContainersPublic = false;

    const form = new ModalFormData()
        .title("§e§lArea Settings")
        .toggle("§6Sync Mode §8[Sync ON = DISABLED, OFF = ENABLED]", { defaultValue: !!perms.syncEnabled })
        .divider()
        .label("§b§lMembers-Only Permissions §8[Requires Sync OFF + Added Member]")
        .toggle("Allow Break Blocks (Members-Only)", { defaultValue: !!perms.canBreak })
        .toggle("Allow Place Blocks (Members-Only)", { defaultValue: !!perms.canPlace })
        .toggle("Allow Redstone / Doors (Members-Only)", { defaultValue: !!perms.canUseRedstone })
        .toggle("Allow Containers / Chests (Members-Only)", { defaultValue: !!perms.canOpenContainers })
        .divider()
        .label("§a§lPublic Permissions §8[All Players, Requires Sync OFF]")
        .toggle("Allow Break Blocks (Public)", { defaultValue: !!perms.canBreakPublic })
        .toggle("Allow Place Blocks (Public)", { defaultValue: !!perms.canPlacePublic })
        .toggle("Allow Redstone / Doors (Public)", { defaultValue: !!perms.canUseRedstonePublic })
        .toggle("Allow Containers / Chests (Public)", { defaultValue: !!perms.canOpenContainersPublic });

    form.show(player).then(res => {
        if (res.canceled) return;
        const vals = res.formValues;
        const map = getChunkPermsMap();
        const current = map[chunkKey] || getDefaultChunkPerm(factionId);
        // vals: 0 sync, 1-4 member, 5-8 public (labels/dividers have no values)
        // Fallback if using textField headers (then length would be 11 with headers at 1 and 6)
        let syncVal, breakM, placeM, redM, contM, breakP, placeP, redP, contP;
        if (vals.length === 9) {
            syncVal = vals[0];
            breakM = vals[1];
            placeM = vals[2];
            redM = vals[3];
            contM = vals[4];
            breakP = vals[5];
            placeP = vals[6];
            redP = vals[7];
            contP = vals[8];
        } else if (vals.length >= 11) {
            // textField version: 0 sync, 1 header, 2-5 member, 6 header, 7-10 public
            syncVal = vals[0];
            breakM = vals[2];
            placeM = vals[3];
            redM = vals[4];
            contM = vals[5];
            breakP = vals[7];
            placeP = vals[8];
            redP = vals[9];
            contP = vals[10];
        } else {
            // unexpected, try best effort
            syncVal = vals[0];
            breakM = vals[1] ?? false;
            placeM = vals[2] ?? false;
            redM = vals[3] ?? false;
            contM = vals[4] ?? false;
            breakP = vals[5] ?? false;
            placeP = vals[6] ?? false;
            redP = vals[7] ?? false;
            contP = vals[8] ?? false;
        }

        current.syncEnabled = !!syncVal;
        current.canBreak = !!breakM;
        current.canPlace = !!placeM;
        current.canUseRedstone = !!redM;
        current.canOpenContainers = !!contM;
        current.canBreakPublic = !!breakP;
        current.canPlacePublic = !!placeP;
        current.canUseRedstonePublic = !!redP;
        current.canOpenContainersPublic = !!contP;
        current.factionId = factionId;
        current.allowedMembers = current.allowedMembers || [];
        map[chunkKey] = current;
        saveChunkPermsMap(map);

        const syncTxt = current.syncEnabled ? "§cON (DISABLED)" : "§aOFF (ENABLED)";
        player.sendMessage(`§aArea Permissions updated! Sync: ${syncTxt}`);
        player.playSound("random.orb");
        showAreaPermissionsUI(player);
    });
}

// ============================================
// SECTION 11: FACTION UNDER ATTACK ALARM
// ============================================
world.afterEvents.entityHurt.subscribe((event) => {
    const victim = event.hurtEntity;
    const attacker = event.damageSource?.damagingEntity;

    if (!victim || victim.typeId !== "minecraft:player") return;
    if (!attacker || attacker.typeId !== "minecraft:player") return;

    const victimFacId = getPlayerFactionId(victim.id);
    if (!victimFacId) return;

    const attackerFacId = getPlayerFactionId(attacker.id);
    if (victimFacId === attackerFacId) return;

    if (attackerFacId) {
        const factions = getAllFactions();
        const vFac = factions[victimFacId];
        if (vFac && (vFac.allies || []).includes(attackerFacId)) return;
    }

    const claimMap = getClaimMap();
    const chunkKey = getChunkKey(victim.location.x, victim.location.z, victim.dimension.id);
    if (claimMap[chunkKey] !== victimFacId) return;

    const cdKey = `zyd:alarm_cd_${victimFacId}`;
    const lastAlert = world.getDynamicProperty(cdKey) || 0;
    const now = Date.now();

    if (now - lastAlert > 60000) {
        world.setDynamicProperty(cdKey, now);

        for (const p of world.getAllPlayers()) {
            if (getPlayerFactionId(p.id) === victimFacId) {
                p.sendMessage("§c§l[FACTION ALARM] §r§cYour faction is under attack!");
                p.playSound("random.break");
            }
        }
    }
});

// ============================================
// SCRIPT INITIALIZATION
// ============================================

console.log("✅ [FactionsClaims] Loaded — Territory Control Active");

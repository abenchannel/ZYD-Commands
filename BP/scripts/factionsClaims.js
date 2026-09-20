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
// ============================================

import { world, system } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";
import {
    getAllFactions,
    getPlayerFactionId,
    saveAllFactions,
    calculateFactionPower,
    MAX_POWER_PER_MEMBER
} from "./factionsCore.js";

// ============================================
// SECTION 1: CONSTANTS & CONFIGURATION
// ============================================

const CLAIM_MAP_KEY = "zyd:claim_map";
const CLAIM_DIMS_KEY = "zyd:claim_allowed_dims";
const CLAIM_POWER_RATIO = 2; // 2 power = 1 claim

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
    if (factionId && currentOwner && currentOwner !== factionId) {
        const myFac = factions[factionId];
        if (myFac && myFac.enemies && myFac.enemies.some(e => e.factionId === currentOwner)) {
            isEnemy = true;
        }
    }

    let statusText = "";
    let targetPowerText = "";
    if (currentOwner) {
        const ownerFaction = factions[currentOwner];
        const ownerName = ownerFaction ? `${ownerFaction.iconUnicode} ${ownerFaction.name}` : "§8Unknown";

        if (currentOwner === factionId) {
            statusText = `§7Status: §aClaimed §7(Your Faction)\n§7Owner: ${ownerName}`;
        } else {
            const relationStr = isEnemy ? "§6Enemy Faction" : "§cOther Faction";
            statusText = `§7Status: §cClaimed §7(${relationStr}§7)\n§7Owner: ${ownerName}`;

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

    if (factionId && isDimAllowed) {
        if (!currentOwner) {
            buttons.push("claim");
            form.button("§aClaim Land\n§f[ Expand your territory ]", "textures/tpa2.png");
        } else if (currentOwner !== factionId && isEnemy) {
            buttons.push("claim");
            form.button("§6Overclaim Land\n§f[ Steal this territory ]", "textures/tpa2.png");
        }
    }

    if (factionId && currentOwner === factionId) {
        buttons.push("unclaim");
        form.button("§eUnclaim Land\n§f[ Release this territory ]", "textures/rank_colours/red.png");
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

    const factions = getAllFactions();
    const myFaction = factions[factionId];
    if (!myFaction) {
        player.playSound("note.bass");
        return player.sendMessage("§cFaction data not found.");
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

    // SUCCESS: Unclaim the chunk
    delete claimMap[chunkKey];
    saveClaimMap(claimMap);

    const { x, z } = getChunkCoords(player.location);

    // Update faction counter & check if Faction Home was in this chunk
    const factions = getAllFactions();
    const faction = factions[factionId];
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
    const px = Math.floor(player.location.x / 16);
    const pz = Math.floor(player.location.z / 16);
    const dim = player.dimension.id;

    const playerChunkKey = getChunkKey(player.location.x, player.location.z, dim);
    const playerFactionId = getPlayerFactionId(player.id);
    const ownerOfCurrentChunk = claimMap[playerChunkKey];

    const halfW = EXPAND_EAST_WEST;
    const halfH = EXPAND_NORTH_SOUTH;

    // --- DYNAMIC ALIGNMENT CALCULATIONS ---
    // Width = "W  " (3) + [Cells * 2] + "  E" (3)
    const rowWidth = 6 + ((2 * halfW + 1) * 2);
    // Dynamic border (shorter by 5 based on user request)
    const border = "§8" + "-".repeat(Math.max(1, rowWidth - 5));
    // Dynamic padding to center N and S directly over the "+" (shifted right by 3)
    const padding = " ".repeat(3 + (halfW * 2) + 3);

    let playerSymbolColor = "§e"; // Default yellow
    if (ownerOfCurrentChunk === playerFactionId) {
        playerSymbolColor = "§a"; // Green if yours
    } else if (ownerOfCurrentChunk) {
        playerSymbolColor = "§c"; // Red if someone else's
    }

    const mapRows = [];
    for (let z = -halfH; z <= halfH; z++) {
        let row = "";
        for (let x = -halfW; x <= halfW; x++) {
            if (x === 0 && z === 0) {
                row += `${playerSymbolColor}+ `; // Player
            } else if (claimMap[`${dim}_${px + x},${pz + z}`]) {
                row += "§b# "; // Claimed
            } else {
                row += "§7= "; // Wilderness
            }
        }
        mapRows.push(row);
    }

    let mapStr = "\n";
    mapStr += padding + "§fN§r\n";
    mapStr += border + "\n";

    // Map rows wrapped with W and E
    for (const row of mapRows) {
        mapStr += "§fW  " + row + "  E\n";
    }

    mapStr += border + "\n";
    mapStr += padding + "§fS§r\n";

    // Legend Line
    mapStr += `${playerSymbolColor}You: +§r §f|§r §bClaimed: §b# §f|§r §7Wilderness: =`;

    return mapStr;
}

// ============================================
// SECTION 9: AUTO-MAP BACKGROUND LOOP
// ============================================
// Uses its OWN chunk tracker so it doesn't conflict with the Action Bar system.
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
            // Update this isolated tracker
            autoMapLastChunk.set(player.id, currentChunkKey);
            // They moved to a new chunk! Send the updated map.
            player.sendMessage(generateAsciiMap(player));
        }
    }

    for (const id of playersToRemove) {
        autoMapPlayers.delete(id);
        autoMapLastChunk.delete(id);
    }
}, 20); // Check every 1 second (very lightweight)

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
            // Toggle Auto Map
            if (autoMapPlayers.has(player.id)) {
                autoMapPlayers.delete(player.id);
                autoMapLastChunk.delete(player.id);
                player.sendMessage("§7Live map tracker §cDISABLED§7.");
            } else {
                autoMapPlayers.add(player.id);
                player.sendMessage("§7Live map tracker §aENABLED§7. Moving around will update your map.");
                // Print the map immediately so they see it right away
                player.sendMessage(generateAsciiMap(player));
            }
            showClaimSettingsUI(player);
        } else if (response.selection === 1) {
            // View Full Map Once
            player.sendMessage(generateAsciiMap(player));
            showClaimSettingsUI(player);
        } else {
            showClaimMenuUI(player);
        }
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
    if (victimFacId === attackerFacId) return; // Ignore teammates

    if (attackerFacId) {
        const factions = getAllFactions();
        const vFac = factions[victimFacId];
        if (vFac && (vFac.allies || []).includes(attackerFacId)) return; // Ignore allies
    }

    // Check if victim was hit INSIDE their own faction's territory
    const claimMap = getClaimMap();
    const chunkKey = getChunkKey(victim.location.x, victim.location.z, victim.dimension.id);
    if (claimMap[chunkKey] !== victimFacId) return; // Not in their own land

    // Trigger Alarm (Cooldown of 60 seconds per faction so it doesn't spam chat)
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
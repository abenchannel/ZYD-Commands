// scripts/factionsPower.js
// ============================================
// FACTIONS POWER — Background Power Mechanics
// ============================================
// Contains:
// - Power regeneration loop (+1 every 10 mins)
// - Death penalty (-2 power, -2 to -6 for enemies)
// ============================================

import { world, system } from "@minecraft/server";
import {
    getAllFactions,
    getPlayerFactionId,
    saveAllFactions,
    MAX_POWER_PER_MEMBER,
    MIN_POWER_PER_MEMBER,
    DEATH_POWER_LOSS,
    POWER_REGEN_MS,
    POWER_REGEN_PREFIX,
    getPlayerSavedPower,
    savePlayerSavedPower,
    getFactionDisplay
} from "./factionsCore.js";

const FEATURE_TOGGLES_KEY_POWER = "zyd:feature_toggles";
function isFactionsEnabledPower() {
    try {
        const raw = world.getDynamicProperty(FEATURE_TOGGLES_KEY_POWER);
        if (raw) {
            const toggles = JSON.parse(raw);
            if (toggles.factions === false) return false;
        }
    } catch (e) { }
    return true;
}

// ============================================
// SECTION 1: POWER REGEN LOOP (OPTIMIZED)
// +1 power every 10 minutes per member
// Only regens if player is below max power
// 
// OPTIMIZATIONS:
// - Checks every 60 seconds instead of 10
// - Reads factions data ONCE per cycle (not per player)
// - Saves factions data ONCE per cycle (not per player)
// - Each player still has their OWN independent timer
// ============================================

system.runInterval(() => {
    if (!isFactionsEnabledPower()) return;
    const now = Date.now();
    const allPlayers = world.getAllPlayers();

    // ==========================================
    // PHASE 1: Identify who needs regen
    // ==========================================
    const factionedPlayers = []; // { player, factionId }
    const factionlessPlayers = [];

    for (const player of allPlayers) {
        const lastRegen = world.getDynamicProperty(POWER_REGEN_PREFIX + player.id) || 0;

        // Not time to regen yet — skip this player entirely
        if (now - lastRegen < POWER_REGEN_MS) continue;

        const factionId = getPlayerFactionId(player.id);

        if (factionId) {
            factionedPlayers.push({ player, factionId });
        } else {
            factionlessPlayers.push(player);
        }
    }

    // ==========================================
    // PHASE 2: Handle factionless players
    // These use individual properties, so cheap to save
    // ==========================================
    for (const player of factionlessPlayers) {
        let power = getPlayerSavedPower(player.id);
        if (power < MAX_POWER_PER_MEMBER) {
            savePlayerSavedPower(player.id, Math.min(power + 1, MAX_POWER_PER_MEMBER));
        }
        // Update their personal timer
        world.setDynamicProperty(POWER_REGEN_PREFIX + player.id, now);
    }

    // ==========================================
    // PHASE 3: Handle factioned players (BATCHED)
    // Group by faction to avoid duplicate reads
    // ==========================================
    if (factionedPlayers.length === 0) return;

    // Group players by their faction ID
    const factionGroups = new Map();
    for (const { player, factionId } of factionedPlayers) {
        if (!factionGroups.has(factionId)) {
            factionGroups.set(factionId, []);
        }
        factionGroups.get(factionId).push(player);
    }

    // READ factions data ONCE (instead of once per player)
    const factions = getAllFactions();
    let anyChangesMade = false;

    for (const [factionId, players] of factionGroups) {
        const faction = factions[factionId];
        if (!faction) continue;

        for (const player of players) {
            const memberData = faction.members[player.id];
            if (!memberData) continue;

            if (memberData.power < MAX_POWER_PER_MEMBER) {
                memberData.power = Math.min(memberData.power + 1, MAX_POWER_PER_MEMBER);
                anyChangesMade = true;
            }

            // Update their personal timer
            world.setDynamicProperty(POWER_REGEN_PREFIX + player.id, now);
        }
    }

    // SAVE factions data ONCE (instead of once per player)
    if (anyChangesMade) {
        saveAllFactions(factions);
    }

}, 1200); // Check every 60 seconds — 10min regen doesn't need faster checks

// ============================================
// SECTION 2: DEATH PENALTY & PVP BEHAVIOR
// - Neutral death → -2 power.
// - Enemy kill → -2 to -6 random power loss.
// - Teammate/Ally kill → 0 power loss.
// Power can go negative down to MIN_POWER_PER_MEMBER.
// ============================================

function isTeammateKill(killer, deadFactionId) {
    if (!killer || killer.typeId !== "minecraft:player") return false;
    if (!deadFactionId) return false;
    return getPlayerFactionId(killer.id) === deadFactionId;
}

world.afterEvents.entityDie.subscribe((event) => {
    if (!isFactionsEnabledPower()) return;
    const deadEntity = event.deadEntity;
    if (deadEntity.typeId !== "minecraft:player") return;

    const factionId = getPlayerFactionId(deadEntity.id);
    const killer = event.damageSource?.damagingEntity;

    // FRIENDLY-FIRE PROTECTION: dying to a teammate costs no power.
    if (isTeammateKill(killer, factionId)) return;

    // ALLY KILL PROTECTION: dying to an ally costs no power.
    if (killer && killer.typeId === "minecraft:player") {
        const killerFactionId = getPlayerFactionId(killer.id);
        if (killerFactionId && killerFactionId !== factionId) {
            const factions = getAllFactions();
            const killerFaction = factions[killerFactionId];
            if (killerFaction && (killerFaction.allies || []).includes(factionId)) {
                return;
            }
        }
    }

    // ENEMY KILL PENALTY: -2 to -6 random power loss
    let powerLoss = DEATH_POWER_LOSS; // Default -2 for neutral/environment deaths
    if (killer && killer.typeId === "minecraft:player") {
        const killerFactionId = getPlayerFactionId(killer.id);
        if (killerFactionId) {
            const factions = getAllFactions();
            const killerFaction = factions[killerFactionId];
            if (killerFaction && (killerFaction.enemies || []).some(e => e.factionId === factionId)) {
                powerLoss = Math.floor(Math.random() * 5) + 2; // Random between 2 and 6
            }
        }
    }

    if (factionId) {
        const factions = getAllFactions();
        const faction = factions[factionId];
        if (!faction) return;

        const memberData = faction.members[deadEntity.id];
        if (!memberData) return;

        if (memberData.power <= MIN_POWER_PER_MEMBER) return;

        memberData.power = Math.max(memberData.power - powerLoss, MIN_POWER_PER_MEMBER);
        saveAllFactions(factions);

        try {
            deadEntity.sendMessage(`§c[FACTIONS] You died! Power decreased by ${powerLoss}. Current: ${memberData.power}`);
        } catch (e) { }
    } else {
        let currentPower = getPlayerSavedPower(deadEntity.id);

        if (currentPower <= MIN_POWER_PER_MEMBER) return;

        currentPower = Math.max(currentPower - powerLoss, MIN_POWER_PER_MEMBER);
        savePlayerSavedPower(deadEntity.id, currentPower);

        try {
            deadEntity.sendMessage(`§c[FACTIONS] You died! Power decreased by ${powerLoss}. Current: ${currentPower}`);
        } catch (e) { }
    }
});

// ============================================
// SECTION 3: FRIENDLY FIRE & ALLY PROTECTION
// ============================================
world.beforeEvents.entityHurt.subscribe((event) => {
    if (!isFactionsEnabledPower()) return;
    const victim = event.hurtEntity;
    const attacker = event.damageSource?.damagingEntity;

    if (victim?.typeId !== "minecraft:player" || attacker?.typeId !== "minecraft:player") return;

    let mode = "team_only"; // default
    try {
        const raw = world.getDynamicProperty("zyd:faction_settings");
        if (raw) {
            const settings = JSON.parse(raw);
            if (typeof settings.friendlyFire === "boolean") {
                mode = settings.friendlyFire ? "enabled" : "team_only";
            } else if (
                settings.friendlyFireMode === "enabled" ||
                settings.friendlyFireMode === "team_and_ally" ||
                settings.friendlyFireMode === "team_only"
            ) {
                mode = settings.friendlyFireMode;
            }
        }
    } catch (e) { }

    // Full friendly fire enabled
    if (mode === "enabled") return;

    const victimFacId = getPlayerFactionId(victim.id);
    const attackerFacId = getPlayerFactionId(attacker.id);
    if (!victimFacId || !attackerFacId) return;

    // Always block same-team damage unless fully enabled
    if (victimFacId === attackerFacId) {
        event.cancel = true;
        return;
    }

    // Block ally damage only in team_and_ally mode
    if (mode === "team_and_ally") {
        const factions = getAllFactions();
        const attackerFac = factions[attackerFacId];
        if (attackerFac && (attackerFac.allies || []).includes(victimFacId)) {
            event.cancel = true;
        }
    }
});

// ============================================
// SCRIPT INITIALIZATION
// ============================================

console.log("✅ [FactionsPower] Loaded — Background Power Mechanics Active (Optimized)");
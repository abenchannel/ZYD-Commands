import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { world, system } from "@minecraft/server";
import { showMenu, isFeatureEnabled } from "./menu.js";

// === Pending Teleport Requests ===
const pendingRequests = new Map();

// === RTP Cooldown Tracker ===
const rtpCooldowns = new Map();

// === DEATH BACK Cooldown Tracker ===
const deathBackCooldowns = new Map();

// === Death Location Storage ===
const lastDeathLocations = new Map();

// =============================================================================
// ✅ DISCONNECT RECOVERY SYSTEM
// =============================================================================

// Tracks players currently in "finding" phase (chunk loading at Y=320 or death loc)
const teleportFindingState = new Map();
// playerName -> { originalLoc, originalDimId, type: "rtp"|"deathback", intervalId }

// Tracks players with active countdowns (no position recovery needed, just prevents double-start)
const activeCountdownPlayers = new Set(); // playerName

// Dynamic property key for persisting recovery positions across disconnects/restarts
const TP_RECOVERY_DYN_PROP = "zyd:tp_recovery_positions";
const TP_SETTINGS_DYN_PROP = "zyd:tp_settings";
const PLAYER_REGISTRY_DYN_PROP = "zyd:player_registry";

// =============================================================================
// PLAYER NAME REGISTRY (for offline faction invites - survives world close/reload)
// =============================================================================

function getPlayerRegistry() {
    try {
        const raw = world.getDynamicProperty(PLAYER_REGISTRY_DYN_PROP);
        if (raw) return JSON.parse(raw);
    } catch (e) { }
    return {};
}

function savePlayerRegistry(registry) {
    try {
        world.setDynamicProperty(PLAYER_REGISTRY_DYN_PROP, JSON.stringify(registry));
    } catch (e) { }
}

function registerPlayerName(playerId, playerName) {
    const registry = getPlayerRegistry();
    if (!registry[playerId]) {
        registry[playerId] = { name: playerName, firstSeen: Date.now() };
        savePlayerRegistry(registry);
    } else if (registry[playerId].name !== playerName) {
        registry[playerId].name = playerName;
        savePlayerRegistry(registry);
    }
}

// Helper functions for teleport settings
function getTPSettings() {
    try {
        const data = JSON.parse(world.getDynamicProperty(TP_SETTINGS_DYN_PROP) || "{}");
        return {
            randomTeleport: data.randomTeleport !== undefined ? data.randomTeleport : true,
            deathBack: data.deathBack !== undefined ? data.deathBack : true
        };
    } catch (e) {
        return { randomTeleport: true, deathBack: true };
    }
}

function saveTPSettings(settings) {
    try {
        world.setDynamicProperty(TP_SETTINGS_DYN_PROP, JSON.stringify(settings));
    } catch (e) {
        console.warn("Failed to save TP settings:", e);
    }
}

function saveTPRecoveryPosition(playerName, loc, dimId, type) {
    try {
        const data = JSON.parse(world.getDynamicProperty(TP_RECOVERY_DYN_PROP) || "{}");
        data[playerName] = { x: loc.x, y: loc.y, z: loc.z, dimId, type };
        world.setDynamicProperty(TP_RECOVERY_DYN_PROP, JSON.stringify(data));
    } catch (e) {
        console.warn("Failed to save TP recovery position:", e);
    }
}

function removeTPRecoveryPosition(playerName) {
    try {
        const data = JSON.parse(world.getDynamicProperty(TP_RECOVERY_DYN_PROP) || "{}");
        delete data[playerName];
        world.setDynamicProperty(TP_RECOVERY_DYN_PROP, JSON.stringify(data));
    } catch (e) {
        console.warn("Failed to remove TP recovery position:", e);
    }
}

function getTPRecoveryPosition(playerName) {
    try {
        const data = JSON.parse(world.getDynamicProperty(TP_RECOVERY_DYN_PROP) || "{}");
        return data[playerName] || null;
    } catch (e) {
        return null;
    }
}

// =============================================================================
// DEATH EVENT HANDLER
// =============================================================================

world.afterEvents.entityDie.subscribe(event => {
    const entity = event.deadEntity;
    if (entity.typeId === "minecraft:player") {
        const loc = entity.location;
        const dim = entity.dimension;

        lastDeathLocations.set(entity.name, {
            location: { ...loc },
            dimension: dim
        });

        // Only show death coordinates if Death Back is enabled
        const settings = getTPSettings();
        if (settings.deathBack) {
            const dimName = dim.id.replace("minecraft:", "").replace(/_/g, " ");
            entity.sendMessage(`§cYou died at X: ${Math.floor(loc.x)}, Y: ${Math.floor(loc.y)}, Z: ${Math.floor(loc.z)} in ${dimName}.`);
        }
    }
});

// =============================================================================
// ✅ PLAYER LEAVE HANDLER — Cleans up intervals (Position already saved on RTP start!)
// =============================================================================

world.afterEvents.playerLeave.subscribe((event) => {
    const playerName = event.playerName;

    // Clean up countdown tracking
    activeCountdownPlayers.delete(playerName);

    // If player was in teleport finding state, clean up their intervals
    if (teleportFindingState.has(playerName)) {
        const tpData = teleportFindingState.get(playerName);

        // Clear the chunk-loading interval to prevent server lag
        if (tpData.intervalId !== null) {
            try { system.clearRun(tpData.intervalId); } catch { }
        }

        // Remove from in-memory tracking
        teleportFindingState.delete(playerName);

        // Note: We no longer need to saveTPRecoveryPosition here because 
        // it is already saved the moment the finding phase starts!
        // This ensures it works even if the host closes the world abruptly.
    }

    // Clean up cooldowns on disconnect
    rtpCooldowns.delete(playerName);
    deathBackCooldowns.delete(playerName);
});

// =============================================================================
// ✅ PLAYER SPAWN HANDLER — Restore position if teleport was interrupted
//                           + Register player name + Check faction invites
// =============================================================================

world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) {
        const player = event.player;

        // ✅ REGISTER PLAYER NAME (for offline faction invites)
        registerPlayerName(player.id, player.name);

        // ✅ CHECK FOR PENDING FACTION INVITES
        system.runTimeout(() => {
            try {
                const raw = world.getDynamicProperty("zyd:fpending_" + player.id);
                if (raw) {
                    const pending = JSON.parse(raw);
                    if (pending.length > 0) {
                        player.sendMessage("§d§l[FACTIONS] §eYou have §d" + pending.length + " §epending faction invitation(s)!");
                        player.sendMessage("§7Open §eFactions Menu §7and check §ePending Invitation§7.");
                        player.playSound("random.orb");
                    }
                }
            } catch (e) { }
        }, 60); // Small delay to ensure player is fully loaded

        const savedPos = getTPRecoveryPosition(player.name);

        if (savedPos) {
            // Remove the saved position immediately (prevent double-restore)
            removeTPRecoveryPosition(player.name);

            // Give immediate resistance to prevent fall damage during load delay
            try {
                player.addEffect("resistance", 60, { amplifier: 255, showParticles: false });
            } catch { }

            // Wait 1 second (20 ticks) for the world to fully load the player
            system.runTimeout(() => {
                if (player.isValid) {
                    try {
                        const dim = world.getDimension(savedPos.dimId);
                        player.teleport(
                            { x: savedPos.x, y: savedPos.y, z: savedPos.z },
                            { dimension: dim }
                        );
                        const typeMsg = savedPos.type === "rtp" ? "Random Teleport" : "Death Back";
                        player.sendMessage(
                            `§eYour ${typeMsg} was interrupted by disconnect. ` +
                            `You've been returned to your original position.`
                        );
                    } catch (e) {
                        console.warn("Failed to restore TP recovery position:", e);
                    }
                }
            }, 20);
        }
    }
});

// =============================================================================
// CONFIGURATION
// =============================================================================

const SCAN_DEPTH = 100;
const LOWER_SCAN_LIMIT = -64;
const SEARCH_RADIUS_XZ = 10;
const REQUIRED_AIR_CLEARANCE = 2;
const SEARCH_UPWARD = 5;
const MOVE_CANCEL_THRESHOLD = 0.5;

const RTP_RADIUS = 5000;
const RTP_COUNTDOWN = 5;
const RTP_COOLDOWN = 30;
const DEATH_BACK_COOLDOWN = 35;

const AIR_TYPES = new Set(["minecraft:air", "minecraft:cave_air"]);
const UNSAFE_SURFACE = new Set([
    "minecraft:lava",
    "minecraft:flowing_lava",
    "minecraft:powder_snow",
    "minecraft:trip_wire",
    "minecraft:tripwire_hook"
]);

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function scanDownwardForFirstNonAir(x, startY, z, dimension, depth = SCAN_DEPTH) {
    const checks = [];
    const lowerLimit = Math.max(startY - (depth - 1), LOWER_SCAN_LIMIT);

    for (let y = startY; y >= lowerLimit; y--) {
        try {
            const block = dimension.getBlock({ x, y, z });
            if (!block) continue;
            const typeId = block.typeId;
            if (AIR_TYPES.has(typeId)) continue;
            if (UNSAFE_SURFACE.has(typeId)) {
                checks.push({ yCoord: y, status: "unsafe", typeId });
                break;
            }
            checks.push({ yCoord: y, status: "solid", typeId });
            break;
        } catch { }
    }
    return checks;
}

function findNearestSafeLocation(centerX, centerY, centerZ, dimension, radius = SEARCH_RADIUS_XZ, depth = SCAN_DEPTH) {
    let best = null;
    let bestDistSq = Infinity;

    const centerFx = centerX;
    const centerFy = centerY;
    const centerFz = centerZ;

    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = 0; dy <= depth; dy++) {
                const bx = Math.floor(centerFx + dx);
                const by = Math.floor(centerFy - dy);
                const bz = Math.floor(centerFz + dz);

                if (by < LOWER_SCAN_LIMIT) break;

                try {
                    const block = dimension.getBlock({ x: bx, y: by, z: bz });
                    if (!block) continue;
                    const typeId = block.typeId;

                    if (AIR_TYPES.has(typeId)) continue;
                    if (UNSAFE_SURFACE.has(typeId)) continue;

                    let hasClearance = true;
                    for (let a = 1; a <= REQUIRED_AIR_CLEARANCE; a++) {
                        const above = dimension.getBlock({ x: bx, y: by + a, z: bz });
                        if (!above || !AIR_TYPES.has(above.typeId)) {
                            hasClearance = false;
                            break;
                        }
                    }
                    if (!hasClearance) break;

                    const spawnX = bx + 0.5;
                    const spawnY = by + 1;
                    const spawnZ = bz + 0.5;
                    const dxF = spawnX - centerFx;
                    const dyF = spawnY - centerFy;
                    const dzF = spawnZ - centerFz;
                    const distSq = dxF * dxF + dyF * dyF + dzF * dzF;

                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        best = { x: spawnX, y: spawnY, z: spawnZ };
                    }
                    break;
                } catch { continue; }
            }
        }
    }
    return best;
}

function safeTeleportHere(target, sender, notifyRequesterOnly = false) {
    const senderDim = sender.dimension;
    const rawX = sender.location.x;
    const rawZ = sender.location.z;

    const scanStartY = Math.floor(sender.location.y) + SEARCH_UPWARD;
    const x = Math.floor(rawX);
    const z = Math.floor(rawZ);

    function hasClearanceAbove(dimension, floorY, bx, bz) {
        for (let a = 1; a <= REQUIRED_AIR_CLEARANCE; a++) {
            try {
                const above = dimension.getBlock({ x: bx, y: floorY + a, z: bz });
                if (!above || !AIR_TYPES.has(above.typeId)) return false;
            } catch { return false; }
        }
        return true;
    }

    const checks = scanDownwardForFirstNonAir(x, scanStartY, z, senderDim, SCAN_DEPTH + SEARCH_UPWARD);
    const firstNonAir = checks.find(c => c.status === "unsafe" || c.status === "solid");

    if (firstNonAir && firstNonAir.status === "solid") {
        const tpY = firstNonAir.yCoord + 1;
        if (hasClearanceAbove(senderDim, firstNonAir.yCoord, x, z)) {
            try {
                target.teleport({ x: x + 0.5, y: tpY, z: z + 0.5 }, { dimension: senderDim });
                if (!notifyRequesterOnly) {
                    sender.sendMessage(`§aTeleported ${target.nameTag} safely to your location in ${senderDim.id.replace("minecraft:", "")}.`);
                    target.sendMessage(`§eYou were teleported safely to §f${sender.nameTag} in ${senderDim.id.replace("minecraft:", "")}.`);
                } else { try { target.sendMessage("§aTeleported successfully."); } catch { } }
                return true;
            } catch {
                if (!notifyRequesterOnly) sender.sendMessage("§cTeleport failed: an error occurred while teleporting the player.");
                try { target.sendMessage("§cTeleport failed: an error occurred."); } catch { }
                return false;
            }
        }
    }

    const nearest = findNearestSafeLocation(rawX, scanStartY, rawZ, senderDim, SEARCH_RADIUS_XZ, SCAN_DEPTH + SEARCH_UPWARD);
    if (nearest) {
        try {
            target.teleport(nearest, { dimension: senderDim });
            if (!notifyRequesterOnly) {
                target.sendMessage("§eTeleport adjusted: nearest safe location used.");
            } else { try { target.sendMessage("§eTeleport adjusted: nearest safe location used."); } catch { } }
            try { sender.sendMessage("§cYour location was unsafe; player teleported to the nearest safe block."); } catch { }
            return true;
        } catch {
            if (!notifyRequesterOnly) sender.sendMessage("§cTeleport failed: an error occurred while teleporting the player.");
            try { target.sendMessage("§cTeleport failed: an error occurred."); } catch { }
            return false;
        }
    } else {
        try { target.sendMessage("§cTeleport failed: no safe place found in nearby area."); } catch { }
        try { sender.sendMessage("§cYou cannot teleport a player to your area because it is unsafe."); } catch { }
        return false;
    }
}

// =============================================================================
// RANDOM TELEPORT (WITH DISCONNECT RECOVERY)
// =============================================================================

function doRandomTeleport(player) {
    // Check if Random Teleport is enabled
    const settings = getTPSettings();
    if (!settings.randomTeleport) {
        player.sendMessage("§cRandom Teleport is currently disabled in settings.");
        return;
    }

    // Block if player already has an active teleport
    if (teleportFindingState.has(player.name) || activeCountdownPlayers.has(player.name)) {
        player.sendMessage("§cYou already have an active teleport. Wait for it to finish first.");
        return;
    }

    // Check Cooldown
    const now = Date.now();
    const cooldownEnd = rtpCooldowns.get(player.name);
    if (cooldownEnd && now < cooldownEnd) {
        const timeLeft = Math.ceil((cooldownEnd - now) / 1000);
        player.sendMessage(`§cPlease wait ${timeLeft} seconds before using Random Teleport again.`);
        return;
    }

    // Start Countdown
    let secondsLeft = RTP_COUNTDOWN;
    let canceled = false;
    const startLoc = { ...player.location };

    activeCountdownPlayers.add(player.name);

    player.sendMessage(`§eTeleporting in ${secondsLeft} seconds... Do not move!`);

    const countdownInterval = system.runInterval(() => {
        if (!player.isValid) {
            try { system.clearRun(countdownInterval); } catch { }
            activeCountdownPlayers.delete(player.name);
            return;
        }

        if (canceled) return;

        const dx = Math.abs(player.location.x - startLoc.x);
        const dy = Math.abs(player.location.y - startLoc.y);
        const dz = Math.abs(player.location.z - startLoc.z);

        if (dx > MOVE_CANCEL_THRESHOLD || dy > MOVE_CANCEL_THRESHOLD || dz > MOVE_CANCEL_THRESHOLD) {
            canceled = true;
            player.sendMessage("§cTeleport canceled because you moved.");
            try { player.onScreenDisplay.setActionBar("§cTeleport canceled - You moved!"); } catch { }
            try { system.clearRun(countdownInterval); } catch { }
            activeCountdownPlayers.delete(player.name);
            return;
        }

        if (secondsLeft > 0) {
            player.onScreenDisplay.setActionBar(`§eTeleporting in §l${secondsLeft}s...`);
            secondsLeft--;
        } else {
            try { system.clearRun(countdownInterval); } catch { }
            activeCountdownPlayers.delete(player.name);
            player.sendMessage("§eSearching for location...");
            startRTPLogic(player);
        }
    }, 20);
}

function startRTPLogic(player) {
    const radius = RTP_RADIUS;
    const dimension = world.getDimension("minecraft:overworld");

    const originalLoc = { ...player.location };
    const originalDim = player.dimension;
    const originalDimId = originalDim.id;

    // Track player in finding state
    teleportFindingState.set(player.name, {
        originalLoc,
        originalDimId,
        type: "rtp",
        intervalId: null
    });

    // ✅ FIX: Save original position IMMEDIATELY to Dynamic Properties.
    // This protects players if the world host suddenly goes offline (world shuts down abruptly).
    saveTPRecoveryPosition(player.name, originalLoc, originalDimId, "rtp");

    const attemptTeleport = (attempts) => {
        if (!player.isValid) {
            return;
        }

        if (attempts >= 5) {
            player.sendMessage("§cCould not find a safe location after 5 tries. Returning to start.");
            try { player.teleport(originalLoc, { dimension: originalDim }); } catch { }
            teleportFindingState.delete(player.name);
            removeTPRecoveryPosition(player.name);
            return;
        }

        const x = Math.floor(Math.random() * radius * 2) - radius;
        const z = Math.floor(Math.random() * radius * 2) - radius;

        player.teleport({ x: x, y: 320, z: z }, { dimension: dimension });
        player.addEffect("resistance", 300, { amplifier: 255, showParticles: false });

        let ticksWaited = 0;
        const maxWait = 200;

        const loadCheckId = system.runInterval(() => {
            ticksWaited++;

            if (!player.isValid || !teleportFindingState.has(player.name)) {
                try { system.clearRun(loadCheckId); } catch { }
                return;
            }

            if (ticksWaited > maxWait) {
                try { system.clearRun(loadCheckId); } catch { }
                player.sendMessage("§cGeneration timed out. Returning to start.");
                try { player.teleport(originalLoc, { dimension: originalDim }); } catch { }
                teleportFindingState.delete(player.name);
                removeTPRecoveryPosition(player.name);
                return;
            }

            if (ticksWaited % 40 === 0) {
                try { player.addEffect("resistance", 300, { amplifier: 255, showParticles: false }); } catch { }
            }

            const deepBlock = dimension.getBlock({ x: x, y: -60, z: z });

            if (deepBlock) {
                if (deepBlock.typeId === "minecraft:air") {
                    try { system.clearRun(loadCheckId); } catch { }
                    player.sendMessage("§cLocation is a void. Trying new location...");
                    attemptTeleport(attempts + 1);
                    return;
                }

                let groundY = null;

                for (let y = 319; y >= -60; y -= 8) {
                    const b = dimension.getBlock({ x: x, y: y, z: z });
                    if (!b || AIR_TYPES.has(b.typeId)) continue;

                    if (UNSAFE_SURFACE.has(b.typeId)) {
                        groundY = null;
                        break;
                    }

                    for (let fy = y + 8; fy >= y && fy <= 319; fy--) {
                        const fb = dimension.getBlock({ x: x, y: fy, z: z });
                        if (fb && !AIR_TYPES.has(fb.typeId) && !UNSAFE_SURFACE.has(fb.typeId)) {
                            groundY = fy + 1;
                            break;
                        }
                    }

                    if (groundY !== null) break;
                    groundY = null;
                    break;
                }

                if (groundY !== null) {
                    try { system.clearRun(loadCheckId); } catch { }
                    player.teleport({ x: x + 0.5, y: groundY, z: z + 0.5 }, { dimension: dimension });
                    player.sendMessage(`§aTeleported to X: ${x}, Z: ${z}`);
                    rtpCooldowns.set(player.name, Date.now() + (RTP_COOLDOWN * 1000));
                    teleportFindingState.delete(player.name);
                    removeTPRecoveryPosition(player.name);
                } else {
                    try { system.clearRun(loadCheckId); } catch { }
                    attemptTeleport(attempts + 1);
                }
            } else {
                const secondsLeft = Math.ceil((maxWait - ticksWaited * 10) / 20);
                try { player.onScreenDisplay.setActionBar(`§eGenerating terrain... ${Math.max(0, secondsLeft)}s`); } catch { }
            }
        }, 10);

        const state = teleportFindingState.get(player.name);
        if (state) state.intervalId = loadCheckId;
    };

    attemptTeleport(0);
}

// =============================================================================
// DEATH BACK (WITH DISCONNECT RECOVERY)
// =============================================================================

function doDeathBack(player) {
    // Check if Death Back is enabled
    const settings = getTPSettings();
    if (!settings.deathBack) {
        player.sendMessage("§cDeath Back is currently disabled in settings.");
        return;
    }

    const deathInfo = lastDeathLocations.get(player.name);
    if (!deathInfo) {
        player.sendMessage("§cNo death location recorded.");
        return;
    }

    if (teleportFindingState.has(player.name) || activeCountdownPlayers.has(player.name)) {
        player.sendMessage("§cYou already have an active teleport. Wait for it to finish first.");
        return;
    }

    const now = Date.now();
    const cooldownEnd = deathBackCooldowns.get(player.name);
    if (cooldownEnd && now < cooldownEnd) {
        const timeLeft = Math.ceil((cooldownEnd - now) / 1000);
        player.sendMessage(`§cPlease wait ${timeLeft} seconds before using Death Back again.`);
        return;
    }

    let secondsLeft = 5;
    let canceled = false;
    const startLoc = { ...player.location };

    activeCountdownPlayers.add(player.name);

    player.sendMessage(`§eReturning to death location in ${secondsLeft} seconds... Do not move!`);

    const countdownInterval = system.runInterval(() => {
        if (!player.isValid) {
            try { system.clearRun(countdownInterval); } catch { }
            activeCountdownPlayers.delete(player.name);
            return;
        }

        if (canceled) return;

        const dx = Math.abs(player.location.x - startLoc.x);
        const dy = Math.abs(player.location.y - startLoc.y);
        const dz = Math.abs(player.location.z - startLoc.z);

        if (dx > MOVE_CANCEL_THRESHOLD || dy > MOVE_CANCEL_THRESHOLD || dz > MOVE_CANCEL_THRESHOLD) {
            canceled = true;
            player.sendMessage("§cDeath Back canceled because you moved.");
            try { player.onScreenDisplay.setActionBar("§cTeleport canceled - You moved!"); } catch { }
            try { system.clearRun(countdownInterval); } catch { }
            activeCountdownPlayers.delete(player.name);
            return;
        }

        if (secondsLeft > 0) {
            player.onScreenDisplay.setActionBar(`§eReturning in §l${secondsLeft}s...`);
            secondsLeft--;
        } else {
            try { system.clearRun(countdownInterval); } catch { }
            activeCountdownPlayers.delete(player.name);
            player.sendMessage("§eTeleporting to death location...");
            startDeathBackLogic(player, deathInfo);
        }
    }, 20);
}

function startDeathBackLogic(player, deathInfo) {
    const originalLoc = { ...player.location };
    const originalDim = player.dimension;
    const originalDimId = originalDim.id;
    const dimension = deathInfo.dimension;
    const x = deathInfo.location.x;
    const y = deathInfo.location.y;
    const z = deathInfo.location.z;

    const isNether = dimension.id === "minecraft:nether";
    const isEnd = dimension.id === "minecraft:the_end";
    const isOverworld = dimension.id === "minecraft:overworld";

    const dimName = dimension.id.replace("minecraft:", "").replace(/_/g, " ");
    const deathLocString = `X: ${Math.floor(x)}, Y: ${Math.floor(y)}, Z: ${Math.floor(z)} in ${dimName}`;

    if (isNether) {
        if (y < 0) {
            player.sendMessage(`§cCannot teleport back: Death location is in the Nether Void.`);
            player.sendMessage(`§cDeath Location: ${deathLocString}`);
            return;
        }
        if (y > 127) {
            player.sendMessage(`§cCannot teleport back: Death location is on the Nether Roof.`);
            player.sendMessage(`§cDeath Location: ${deathLocString}`);
            return;
        }
    }
    if (isEnd && y <= 0) {
        player.sendMessage(`§cCannot teleport back: Death location is in the End Void.`);
        player.sendMessage(`§cDeath Location: ${deathLocString}`);
        return;
    }
    if (isOverworld && y < -64) {
        player.sendMessage(`§cCannot teleport back: Death location is in the Void.`);
        player.sendMessage(`§cDeath Location: ${deathLocString}`);
        return;
    }

    // Track player in finding state
    teleportFindingState.set(player.name, {
        originalLoc,
        originalDimId,
        type: "deathback",
        intervalId: null
    });

    // ✅ FIX: Save original position IMMEDIATELY to Dynamic Properties.
    // This protects players if the world host suddenly goes offline.
    saveTPRecoveryPosition(player.name, originalLoc, originalDimId, "deathback");

    player.addEffect("resistance", 300, { amplifier: 255, showParticles: false });
    player.teleport({ x: x, y: y, z: z }, { dimension: dimension });

    let ticksWaited = 0;
    const maxWait = 200;

    const loadCheckId = system.runInterval(() => {
        ticksWaited++;

        if (!player.isValid || !teleportFindingState.has(player.name)) {
            try { system.clearRun(loadCheckId); } catch { }
            return;
        }

        if (ticksWaited > maxWait) {
            try { system.clearRun(loadCheckId); } catch { }
            player.sendMessage(`§cDeath location chunk failed to load. Returning to safety.`);
            try { player.teleport(originalLoc, { dimension: originalDim }); } catch { }
            teleportFindingState.delete(player.name);
            removeTPRecoveryPosition(player.name);
            return;
        }

        if (ticksWaited % 40 === 0) {
            try { player.addEffect("resistance", 300, { amplifier: 255, showParticles: false }); } catch { }
        }

        const secondsLeft = Math.ceil((maxWait - ticksWaited * 10) / 20);
        try { player.onScreenDisplay.setActionBar(`§eLoading terrain... §l${Math.max(0, secondsLeft)}s left`); } catch { }

        let checkY = isOverworld ? -60 : 0;
        const block = dimension.getBlock({ x: x, y: checkY, z: z });

        if (block) {
            try { system.clearRun(loadCheckId); } catch { }

            let groundY = null;
            let isUnsafe = false;
            const startY = Math.floor(y);
            const scanLimit = isOverworld ? -64 : 0;

            for (let currentY = startY; currentY >= scanLimit; currentY -= 8) {
                const b = dimension.getBlock({ x: x, y: currentY, z: z });
                if (!b || AIR_TYPES.has(b.typeId)) continue;

                if (UNSAFE_SURFACE.has(b.typeId)) {
                    isUnsafe = true;
                    break;
                }

                for (let fy = currentY + 8; fy >= currentY && fy <= startY; fy--) {
                    const fb = dimension.getBlock({ x: x, y: fy, z: z });
                    if (fb && !AIR_TYPES.has(fb.typeId) && !UNSAFE_SURFACE.has(fb.typeId)) {
                        groundY = fy + 1;
                        break;
                    }
                }

                if (groundY !== null) break;
                isUnsafe = true;
                break;
            }

            if (groundY !== null && groundY > scanLimit && !isUnsafe) {
                player.teleport({ x: x + 0.5, y: groundY, z: z + 0.5 }, { dimension: dimension });
                player.sendMessage("§aReturned to death location safely.");
                deathBackCooldowns.set(player.name, Date.now() + (DEATH_BACK_COOLDOWN * 1000));
                teleportFindingState.delete(player.name);
                removeTPRecoveryPosition(player.name);
                return;
            }

            player.sendMessage("§eDeath spot is unsafe/air. Scanning area for safe ground...");
            const safeSpot = findNearestSafeLocation(x, y, z, dimension, 10, SCAN_DEPTH);

            if (safeSpot) {
                player.teleport(safeSpot, { dimension: dimension });
                player.sendMessage(`§aTeleported to a safe spot near your death location.`);
                deathBackCooldowns.set(player.name, Date.now() + (DEATH_BACK_COOLDOWN * 1000));
            } else {
                player.sendMessage(`§cNo safe ground found within 10 blocks. Returning to safety.`);
                try { player.teleport(originalLoc, { dimension: originalDim }); } catch { }
            }
            teleportFindingState.delete(player.name);
            removeTPRecoveryPosition(player.name);
        }
    }, 10);

    const state = teleportFindingState.get(player.name);
    if (state) state.intervalId = loadCheckId;
}

// =============================================================================
// TELEPORT MANAGER UI
// =============================================================================

export function showTeleport(player) {
    const settings = getTPSettings();
    const isOp = player.hasTag("op");
    const showRTP = settings.randomTeleport;
    const showDeathBack = settings.deathBack;

    const form = new ActionFormData()
        .title("§aTeleport Manager");

    const request = pendingRequests.get(player.name);
    if (request) {
        form.button("§l§e< Teleport Request >", "textures/teleport/teleport_pending.png");
    }

    // Build dynamic body description
    let bodyText = "§bTeleport to Player – §7Send a request to teleport yourself to another player.\n\n" +
        "§dTeleport Player Here – §7Send a request to bring another player to your location.";

    if (showRTP) {
        bodyText += "\n\n§6Random Teleport – §7Teleport to a random safe location in the world.";
    }
    if (showDeathBack) {
        bodyText += "\n\n§5Death Back – §7Return to the last location where you died.";
    }

    form.body(bodyText);

    form.button("§bTeleport to Player", "textures/teleport/tp_player.png");
    form.button("§dTeleport Player Here", "textures/teleport/tp_here.png");

    if (showRTP) {
        form.button("§6Random Teleport", "textures/teleport/tp_random.png");
    }
    if (showDeathBack) {
        form.button("§5Death Back", "textures/teleport/tp_death.png");
    }
    if (isOp) {
        form.button("§9Teleport Settings", "textures/settings.png");
    }
    form.button("§cBack", "textures/teleport/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let index = 0;

        if (request && response.selection === index++) {
            confirmTeleportRequest(player, request);
            return;
        }

        if (response.selection === index++) {
            showTeleportToAnyone(player);
            return;
        }
        if (response.selection === index++) {
            showTeleportAnyoneHere(player);
            return;
        }
        if (showRTP && response.selection === index++) {
            doRandomTeleport(player);
            return;
        }
        if (showDeathBack && response.selection === index++) {
            doDeathBack(player);
            return;
        }
        if (isOp && response.selection === index++) {
            showTeleportSettings(player);
            return;
        }
        if (response.selection === index++) {
            showMenu(player);
        }
    });
}

// =============================================================================
// CONFIRMATION UI
// =============================================================================

function confirmTeleportRequest(player, request) {
    const requesterName = request.from;
    const form = new ActionFormData()
        .title("§l§eTeleport Request")
        .body(
            request.type === "toPlayer"
                ? `§cWarning! §e${requesterName} wants to §a§lteleport to your location.§r\n§7If you don't know them, you can decline. The risk is yours.`
                : `§cWarning! §e${requesterName} wants you to §c§lteleport to their location.§r\n§7Be cautious before accepting.`
        )
        .button("§aAccept", "textures/teleport/tp_accept.png")
        .button("§cDecline", "textures/teleport/tp_cancel.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (request.timeoutId) { try { system.clearRun(request.timeoutId); } catch { } }

        const requester = world.getAllPlayers().find(p => p.name === request.from);

        if (response.selection === 0) {
            if (!requester) {
                player.sendMessage("§cRequester is no longer online.");
                pendingRequests.delete(player.name);
                return;
            }

            try { requester.sendMessage(`§aYour teleport request to ${player.nameTag} was accepted.`); } catch { }
            startTeleportCountdown(requester, player, request.type);
            pendingRequests.delete(player.name);
        } else {
            if (requester) { try { requester.sendMessage("§cYour teleport request was declined."); } catch { } }
            pendingRequests.delete(player.name);
        }
    });
}

// =============================================================================
// TPA COUNTDOWN SYSTEM
// =============================================================================

function startTeleportCountdown(requester, acceptor, requestType) {
    const willTeleport = requestType === "toPlayer" ? requester : acceptor;
    const willTeleportName = willTeleport.name;

    const destLocation = {
        x: willTeleport.location.x,
        y: willTeleport.location.y,
        z: willTeleport.location.z,
        dimension: willTeleport.dimension
    };

    let secondsLeft = 5;
    let canceled = false;
    let teleported = false;

    let refRequester = requester;
    let refAcceptor = acceptor;
    let refWillTeleport = willTeleport;

    try { willTeleport.onScreenDisplay.setActionBar(`§eTeleporting in §l${secondsLeft}s... Stay still!`); } catch { }
    try { (requestType === "toPlayer" ? acceptor : requester).onScreenDisplay.setActionBar(`§ePreparing teleport...`); } catch { }

    let movementIntervalId = null;

    const countdownIntervalId = system.runInterval(() => {
        if (canceled || teleported) {
            try { system.clearRun(countdownIntervalId); } catch { }
            return;
        }

        if (!refRequester || !refRequester.isValid) {
            canceled = true;
            try { system.clearRun(countdownIntervalId); } catch { }
            try { if (refAcceptor && refAcceptor.isValid) refAcceptor.onScreenDisplay.setActionBar(""); } catch { }
            try { if (movementIntervalId) system.clearRun(movementIntervalId); } catch { }
            return;
        }

        if (!refAcceptor || !refAcceptor.isValid) {
            canceled = true;
            try { system.clearRun(countdownIntervalId); } catch { }
            try { refRequester.sendMessage(`§cTeleport canceled: ${acceptor.nameTag} disconnected.`); } catch { }
            try { refRequester.onScreenDisplay.setActionBar(""); } catch { }
            try { if (movementIntervalId) system.clearRun(movementIntervalId); } catch { }
            return;
        }

        if (!refWillTeleport || !refWillTeleport.isValid) {
            canceled = true;
            try { system.clearRun(countdownIntervalId); } catch { }
            try { refRequester.sendMessage("§cTeleport canceled: teleporting player disconnected."); } catch { }
            try { if (movementIntervalId) system.clearRun(movementIntervalId); } catch { }
            return;
        }

        if (secondsLeft > 0) {
            try { refWillTeleport.onScreenDisplay.setActionBar(`§eTeleporting in §l${secondsLeft}s... Stay still!`); } catch { }
            secondsLeft--;
        } else {
            teleported = true;
            try { if (movementIntervalId) system.clearRun(movementIntervalId); } catch { }
            try { system.clearRun(countdownIntervalId); } catch { }

            try {
                if (!refRequester.isValid || !refAcceptor.isValid) {
                    throw new Error("Player disconnected");
                }

                if (requestType === "toPlayer") {
                    safeTeleportHere(refRequester, refAcceptor, true);
                } else {
                    safeTeleportHere(refAcceptor, refRequester, true);
                }
            } catch (err) {
                console.warn("Teleport during countdown failed:", err);
                try { refRequester.sendMessage("§cTeleport failed during countdown."); } catch { }
            } finally {
                try { refRequester.onScreenDisplay.setActionBar(""); } catch { }
                try { refAcceptor.onScreenDisplay.setActionBar(""); } catch { }
            }
        }
    }, 20);

    const startLoc = { x: destLocation.x, y: destLocation.y, z: destLocation.z };

    movementIntervalId = system.runInterval(() => {
        if (canceled || teleported) {
            try { if (movementIntervalId) system.clearRun(movementIntervalId); } catch { }
            return;
        }

        if (!refWillTeleport || !refWillTeleport.isValid) return;

        const dx = Math.abs(refWillTeleport.location.x - startLoc.x);
        const dy = Math.abs(refWillTeleport.location.y - startLoc.y);
        const dz = Math.abs(refWillTeleport.location.z - startLoc.z);

        if (dx > MOVE_CANCEL_THRESHOLD || dy > MOVE_CANCEL_THRESHOLD || dz > MOVE_CANCEL_THRESHOLD) {
            canceled = true;
            try { system.clearRun(countdownIntervalId); } catch { }
            try { system.clearRun(movementIntervalId); } catch { }

            try { refWillTeleport.onScreenDisplay.setActionBar("§cTeleport canceled - You moved!"); } catch { }
            try { (requestType === "toPlayer" ? refAcceptor : refRequester).onScreenDisplay.setActionBar(""); } catch { }

            try { refRequester.sendMessage("§cTeleport canceled: movement detected."); } catch { }
            return;
        }
    }, 5);

    return { countdownIntervalId, movementIntervalId };
}

// =============================================================================
// TPA REQUEST FUNCTIONS
// =============================================================================

function showTeleportToAnyone(player) {
    const players = Array.from(world.getPlayers()).filter(p => p.name !== player.name);
    if (players.length === 0) {
        player.sendMessage("§cNo other players online to teleport to.");
        return;
    }

    const names = players.map(p => p.nameTag);

    const modal = new ModalFormData()
        .title("§aTeleport to Player")
        .dropdown("Select a player:", names, { defaultValueIndex: 0 })
        .submitButton("§aSend Request");

    modal.show(player).then(response => {
        if (response.canceled) return;
        const target = players[response.formValues?.[0]];
        if (target) {
            if (pendingRequests.has(target.name)) {
                player.sendMessage("§cThat player already has a pending teleport request.");
                return;
            }

            target.sendMessage(`§e${player.name} wants to teleport to you.`);

            const timeoutId = system.runTimeout(() => {
                const req = pendingRequests.get(target.name);
                if (req && req.from === player.name) {
                    pendingRequests.delete(target.name);
                    try { player.sendMessage("§cTime runs out! Your teleport request has been declined."); } catch { }
                }
            }, 20 * 60);

            pendingRequests.set(target.name, { type: "toPlayer", from: player.name, timeoutId });
            player.sendMessage("§aTeleport request sent.");
        }
    });
}

function showTeleportAnyoneHere(player) {
    const players = Array.from(world.getPlayers()).filter(p => p.name !== player.name);
    if (players.length === 0) {
        player.sendMessage("§cNo other players online to bring here.");
        return;
    }

    const names = players.map(p => p.nameTag);

    const modal = new ModalFormData()
        .title("§dTeleport Player Here")
        .dropdown("Select a player:", names, { defaultValueIndex: 0 })
        .submitButton("§aSend Request");

    modal.show(player).then(response => {
        if (response.canceled) return;
        const target = players[response.formValues?.[0]];
        if (target) {
            if (target.hasTag("frozed")) {
                player.sendMessage(`§c${target.nameTag} is currently frozen and cannot be teleported.`);
                return;
            }
            if (pendingRequests.has(target.name)) {
                player.sendMessage("§cThat player already has a pending teleport request.");
                return;
            }

            target.sendMessage(`§e${player.name} wants you to teleport to them.`);

            const timeoutId = system.runTimeout(() => {
                const req = pendingRequests.get(target.name);
                if (req && req.from === player.name) {
                    pendingRequests.delete(target.name);
                    try { player.sendMessage("§cTime runs out! Your teleport request has been declined."); } catch { }
                }
            }, 20 * 60);

            pendingRequests.set(target.name, { type: "toHere", from: player.name, timeoutId });
            player.sendMessage("§aTeleport request sent.");
        }
    });
}

// =============================================================================
// TELEPORT SETTINGS UI
// =============================================================================

function showTeleportSettings(player) {
    // OP only check
    if (!player.hasTag("op")) {
        player.sendMessage("§cYou don't have permission to access Teleport Settings.");
        return;
    }

    const settings = getTPSettings();
    const rtpStatus = settings.randomTeleport ? "§a§lENABLED" : "§c§lDISABLED";
    const deathBackStatus = settings.deathBack ? "§a§lENABLED" : "§c§lDISABLED";

    const form = new ActionFormData()
        .title("§9Teleport Settings")
        .body(
            `§6Random Teleport: ${rtpStatus}§r\n§7Toggle the Random Teleport feature on/off.\n\n` +
            `§5Death Back: ${deathBackStatus}§r\n§7Toggle the Death Back feature on/off.\n\n` +
            `§eNote: §7Disabling a feature will prevent players from using it.`
        )
        .button(`§6Random Teleport: ${settings.randomTeleport ? "§aON" : "§cOFF"}`, "textures/teleport/tp_random.png")
        .button(`§5Death Back: ${settings.deathBack ? "§aON" : "§cOFF"}`, "textures/teleport/tp_death.png")
        .button("§cBack", "textures/teleport/back.png");

    // Only show to OP players
    if (!player.hasTag("op")) {
        player.sendMessage("§cYou don't have permission to access Teleport Settings.");
        return;
    }

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === 0) {
            // Toggle Random Teleport
            settings.randomTeleport = !settings.randomTeleport;
            saveTPSettings(settings);
            const status = settings.randomTeleport ? "§aenabled" : "§cdisabled";
            player.sendMessage(`§eRandom Teleport has been ${status}.`);
            showTeleportSettings(player); // Refresh UI
        } else if (response.selection === 1) {
            // Toggle Death Back
            settings.deathBack = !settings.deathBack;
            saveTPSettings(settings);
            const status = settings.deathBack ? "§aenabled" : "§cdisabled";
            player.sendMessage(`§eDeath Back has been ${status}.`);
            showTeleportSettings(player); // Refresh UI
        } else if (response.selection === 2) {
            // Back
            showTeleport(player);
        }
    });
}

// === Exports for main.js command handlers ===
export { pendingRequests, confirmTeleportRequest, doRandomTeleport, doDeathBack, showTeleportSettings, getTPSettings };

console.warn("§a✨ ZYD Teleport System Loaded (with Host-Offline Disconnect Recovery, Settings & Player Registry)");
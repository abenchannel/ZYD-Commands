// admin.js
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { system, world } from "@minecraft/server";
import { showFreezePlayerSubUI } from "./freezeplayer.js";

// === Death Location Storage ===
const lastDeathLocations = new Map();

world.afterEvents.entityDie.subscribe(event => {
    const entity = event.deadEntity;
    if (entity.typeId === "minecraft:player") {
        lastDeathLocations.set(entity.name, {
            location: { ...entity.location },
            dimension: entity.dimension
        });
    }
});

// === Configuration ===
const SCAN_DEPTH = 100;
const LOWER_SCAN_LIMIT = -66;
const SEARCH_RADIUS_XZ = 10; // ±10 blocks in X and Z
const REQUIRED_AIR_CLEARANCE = 2; // require 2 air blocks above candidate

// Movement cancel threshold (meters)
const MOVE_CANCEL_THRESHOLD = 0.5;

const AIR_TYPES = new Set(["minecraft:air", "minecraft:cave_air"]);
const UNSAFE_SURFACE = new Set([
    "minecraft:lava",
    "minecraft:flowing_lava",
    "minecraft:powder_snow",
    "minecraft:trip_wire",
    "minecraft:tripwire_hook",
    "minecraft:bedrock"
]);

// === Helper: scan downward (single column) ===
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
        } catch {
            // ignore read errors and continue scanning
        }
    }
    return checks;
}

// === Helper: find nearest safe location in X/Z radius and scanning downward up to depth ===
// Requirements for a valid candidate:
//  - block at (bx, by, bz) is solid and not in UNSAFE_SURFACE
//  - there are REQUIRED_AIR_CLEARANCE consecutive air blocks above (by+1 .. by+REQUIRED_AIR_CLEARANCE)
// Returns { x, y, z } world coordinates (centered) or null if none found.
function findNearestSafeLocation(centerX, centerY, centerZ, dimension, radius = SEARCH_RADIUS_XZ, depth = SCAN_DEPTH) {
    let best = null;
    let bestDistSq = Infinity;

    // Use floating center for distance calculation
    const centerFx = centerX;
    const centerFz = centerZ;
    const centerFy = centerY;

    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            // For each column (bx, bz), scan downward from centerY to lower limit
            for (let dy = 0; dy <= depth; dy++) {
                const bx = Math.floor(centerFx + dx);
                const by = Math.floor(centerFy - dy);
                const bz = Math.floor(centerFz + dz);

                // enforce lower limit
                if (by < LOWER_SCAN_LIMIT) break;

                try {
                    const block = dimension.getBlock({ x: bx, y: by, z: bz });
                    if (!block) continue;
                    const typeId = block.typeId;

                    // skip if block itself is air or unsafe surface
                    if (AIR_TYPES.has(typeId)) continue;
                    if (UNSAFE_SURFACE.has(typeId)) continue;

                    // check required air clearance above candidate
                    let hasClearance = true;
                    for (let a = 1; a <= REQUIRED_AIR_CLEARANCE; a++) {
                        const above = dimension.getBlock({ x: bx, y: by + a, z: bz });
                        if (!above || !AIR_TYPES.has(above.typeId)) {
                            hasClearance = false;
                            break;
                        }
                    }
                    if (!hasClearance) {
                        // this column's top isn't safe for player; stop scanning further down this column
                        break;
                    }

                    // compute squared distance from sender's position to candidate spawn position
                    const spawnX = bx + 0.5;
                    const spawnY = by + 1; // player feet
                    const spawnZ = bz + 0.5;
                    const dxF = spawnX - centerFx;
                    const dyF = spawnY - centerFy;
                    const dzF = spawnZ - centerFz;
                    const distSq = dxF * dxF + dyF * dyF + dzF * dzF;

                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        best = { x: spawnX, y: spawnY, z: spawnZ };
                    }

                    // found a solid non-unsafe block in this column; no need to scan further down this column
                    break;
                } catch {
                    // ignore errors and continue
                    continue;
                }
            }
        }
    }

    return best;
}

// === Safe teleport (dimension-aware) ===
// Behavior:
//  - Prefer direct column if it has a valid floor + clearance.
//  - Otherwise search entire radius (±SEARCH_RADIUS_XZ, depth SCAN_DEPTH) for nearest valid spot.
//  - Cancel only if no valid spot found in the whole search zone.
function safeTeleportHere(target, sender) {
    const senderDim = sender.dimension;
    const rawX = sender.location.x;
    const rawZ = sender.location.z;
    const startY = Math.floor(sender.location.y) - 1;
    const x = Math.floor(rawX);
    const z = Math.floor(rawZ);

    // 1) Check direct column first
    const checks = scanDownwardForFirstNonAir(x, startY, z, senderDim, SCAN_DEPTH);
    const firstNonAir = checks.find(c => c.status === "unsafe" || c.status === "solid");

    // Helper to validate clearance above a given floor Y
    function hasClearanceAbove(dimension, floorY, bx, bz) {
        for (let a = 1; a <= REQUIRED_AIR_CLEARANCE; a++) {
            try {
                const above = dimension.getBlock({ x: bx, y: floorY + a, z: bz });
                if (!above || !AIR_TYPES.has(above.typeId)) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    // If direct column has a solid floor, check clearance and teleport there if valid
    if (firstNonAir && firstNonAir.status === "solid") {
        const tpY = firstNonAir.yCoord + 1;
        if (hasClearanceAbove(senderDim, firstNonAir.yCoord, x, z)) {
            try {
                target.teleport({ x: x + 0.5, y: tpY, z: z + 0.5 }, { dimension: senderDim });
                try { sender.sendMessage(`§aTeleported ${target.nameTag} safely to your location in ${senderDim.id.replace("minecraft:", "")}.`); } catch { }
                try { target.sendMessage(`§eYou were teleported safely to ${sender.nameTag}§e in ${senderDim.id.replace("minecraft:", "")}.`); } catch { }
                return true;
            } catch {
                try { sender.sendMessage("§cTeleport failed: an error occurred while teleporting the player."); } catch { }
                try { target.sendMessage("§cTeleport failed: an error occurred."); } catch { }
                return false;
            }
        }
        // if direct column has no clearance, do not cancel yet — fall through to full search
    }

    // If direct column is unsafe or lacks clearance, search the whole nearby area
    const nearest = findNearestSafeLocation(rawX, startY + 1, rawZ, senderDim, SEARCH_RADIUS_XZ, SCAN_DEPTH);
    if (nearest) {
        try {
            target.teleport(nearest, { dimension: senderDim });
            try { target.sendMessage("§eTeleport adjusted: nearest safe location used."); } catch { }
            try { sender.sendMessage("§cYour location was unsafe; player teleported to the nearest safe block."); } catch { }
            return true;
        } catch {
            try { sender.sendMessage("§cTeleport failed: an error occurred while teleporting the player."); } catch { }
            try { target.sendMessage("§cTeleport failed: an error occurred."); } catch { }
            return false;
        }
    }

    // No valid spot found in the entire search zone — cancel
    try { target.sendMessage("§cTeleport failed: no safe place found in nearby area."); } catch { }
    try { sender.sendMessage("§cYou cannot teleport a player to your area because it is unsafe."); } catch { }
    return false;
}

// === Admin Panel UI ===
export function showAdminPanel(player) {
    const form = new ActionFormData()
        .title("§6Admin Panel")
        .body(
            "§aGamemodes§f – Switch between Spectator, Survival, Adventure.\n\n" +
            "§bTeleport§f – Teleport to players, bring them here, or go to death location.\n\n" +
            "§cFreeze Player§f – Temporarily stop a player’s movement.\n"
        )
        .button("§aChange Gamemodes", "textures/admin/gamemodes.png")
        .button("§bTeleport", "textures/admin/tp_cyan.png")
        .button("§cFreeze Player", "textures/admin/tp_red.png")
        .button("§cBack", "textures/admin/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        switch (response.selection) {
            case 0: showGamemodeSubMenu(player); break;
            case 1: showTeleportSubMenu(player); break;
            case 2:
                import("./freezeplayer.js").then(mod => {
                    if (typeof mod.showFreezePlayerSubUI === "function") mod.showFreezePlayerSubUI(player);
                });
                break;
            case 3:
            default:
                import("../menu.js").then(mod => {
                    if (typeof mod.showMenu === "function") mod.showMenu(player);
                });
                break;
        }
    });
}

// === Gamemode SubUI ===
function showGamemodeSubMenu(player) {
    const form = new ActionFormData()
        .title("§aChange Gamemodes")
        .button("§bSpectator", "textures/admin/tp_cyan.png")
        .button("§eSurvival", "textures/admin/tp_yellow.png")
        .button("§dAdventure", "textures/admin/tp_violet.png")
        .button("§cBack", "textures/admin/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        switch (response.selection) {
            case 0: system.run(() => player.runCommand("gamemode spectator @s")); break;
            case 1: system.run(() => player.runCommand("gamemode survival @s")); break;
            case 2: system.run(() => player.runCommand("gamemode adventure @s")); break;
            case 3: showAdminPanel(player); break;
        }
    });
}

// === Teleport SubUI ===
function showTeleportSubMenu(player) {
    const form = new ActionFormData()
        .title("§bTeleport Options")
        .button("§aTeleport to Anyone", "textures/admin/tp_green.png")
        .button("§eTeleport Anyone Here", "textures/admin/tp_yellow.png")
        .button("§cTeleport to Death Location", "textures/admin/tp_death.png")
        .button("§fBack", "textures/admin/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        switch (response.selection) {
            case 0: showTeleportToAnyone(player); break;
            case 1: showTeleportAnyoneHere(player); break;
            case 2: teleportToDeath(player); break;
            case 3: showAdminPanel(player); break;
        }
    });
}

// === Teleport to Anyone ===
function showTeleportToAnyone(player) {
    // allow self selection
    const players = Array.from(world.getPlayers());
    if (players.length === 0) {
        player.sendMessage("§cNo players online to teleport to.");
        return;
    }

    const names = players.map(p => p.nameTag);

    const modal = new ModalFormData()
        .title("§aTeleport to Anyone")
        .dropdown("Select a player:", names, { defaultValueIndex: 0 })
        .submitButton("§aTeleport");

    modal.show(player).then(response => {
        if (response.canceled) return;
        const target = players[response.formValues?.[0]];
        if (target) {
            // FIX: use safeTeleportHere instead of direct teleport
            safeTeleportHere(player, target);
        } else {
            player.sendMessage("§cInvalid player selection.");
        }
    });
}

// === Teleport Anyone Here ===
function showTeleportAnyoneHere(player) {
    // FIX: allow self selection
    const players = Array.from(world.getPlayers()); // no filter
    if (players.length === 0) {
        player.sendMessage("§cNo players online to bring here.");
        return;
    }

    const names = players.map(p => p.nameTag);

    const modal = new ModalFormData()
        .title("§eTeleport Anyone Here")
        .dropdown("Select a player:", names, { defaultValueIndex: 0 })
        .submitButton("§aTeleport");

    modal.show(player).then(response => {
        if (response.canceled) return;
        const target = players[response.formValues?.[0]];
        if (target) {
            if (target.hasTag("frozed")) {
                player.sendMessage(`§c${target.nameTag} is currently frozen and cannot be teleported to your location.`);
                return;
            }
            safeTeleportHere(target, player);
        } else {
            player.sendMessage("§cInvalid player selection.");
        }
    });
}

// === Teleport to Death Location ===
function teleportToDeath(player) {
    const deathInfo = lastDeathLocations.get(player.name);

    // If no death location recorded, just show message and return
    if (!deathInfo) {
        player.sendMessage("§cYou don't have a recorded death location.");
        return;
    }

    const loc = deathInfo.location;
    const x = Math.floor(loc.x) + 0.5;
    const z = Math.floor(loc.z) + 0.5;
    const y = Math.floor(loc.y);

    system.run(() => {
        player.teleport({ x, y, z }, { dimension: deathInfo.dimension });
        try {
            player.sendMessage("§aTeleported to your last death location.");
        } catch { }
    });
}
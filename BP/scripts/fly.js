//scripts/fly.js
// === [FLIGHT SYSTEM] ===
// Creative-style flight ported from the "FlyTrue" addon.
//
// /zyd:fly is a TOGGLE. Like FlyTrue, it tries two mechanisms in order:
//   1) Vanilla "ability @s mayfly"  -> real Creative flight (needs cheats ON).
//      This is the smoothest, most native feel, so we prefer it.
//   2) Custom impulse flight          -> used only if mayfly is unavailable
//      (e.g. cheats OFF). Double-tap Jump to take off / land; takeoff fires the
//      "start_flying" entity event which swaps the player into a no-gravity
//      component group (see entities/player.json) so they truly hover. Motion is
//      small per-tick impulses + drag, which feels smooth instead of jerky.
//
// /zyd:flysettings opens a settings form. Values are saved to world dynamic
// properties so they survive script reloads.
//
// main.js calls registerFlySystem() once at load and toggleFly(player) from
// the /zyd:fly command.

import {
    world,
    system,
    InputButton,
    ButtonState,
} from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";

// --- Tuning defaults ---
const DEF_HORIZONTAL_SPEED = 0.02;
const DEF_HORIZONTAL_SPEED_SPRINT = 0.06;
const DEF_ASCEND_SPEED = 0.02;
const DEF_DESCEND_SPEED = 0.03;
const DEF_HORIZONTAL_DRAG = 0.18;
const DEF_VERTICAL_DRAG = 0.15;
const DEF_FALL_DAMAGE = false;
const DEF_DEADZONE = 0.01;
const DEF_DOUBLE_TAP_WINDOW = 7;

// Persistent settings object — loaded from dynamic properties at registration time.
const flySettings = {
    horizontalSpeed: DEF_HORIZONTAL_SPEED,
    horizontalSprintSpeed: DEF_HORIZONTAL_SPEED_SPRINT,
    ascendSpeed: DEF_ASCEND_SPEED,
    descendSpeed: DEF_DESCEND_SPEED,
    horizontalDrag: DEF_HORIZONTAL_DRAG,
    verticalDrag: DEF_VERTICAL_DRAG,
    fallDamage: DEF_FALL_DAMAGE,
    deadzone: DEF_DEADZONE,
    doubleTapWindow: DEF_DOUBLE_TAP_WINDOW,
};

// Load persisted settings from dynamic properties (survives script reload).
export function loadFlySettingsFromWorld() {
    const raw = (name, fallback) => {
        let val;
        try { val = world.getDynamicProperty(name); } catch (e) { return fallback; }
        if (val !== undefined && val !== null) {
            // If the stored value is numeric-ish, parse it; otherwise return fallback.
            const num = parseFloat(val);
            if (!isNaN(num)) return num;
            // Boolean property.
            if (typeof val === 'boolean') return val;
        }
        return fallback;
    };

    flySettings.horizontalSpeed = raw("fly:hSpeed", DEF_HORIZONTAL_SPEED);
    flySettings.horizontalSprintSpeed = raw("fly:hSprintSpeed", DEF_HORIZONTAL_SPEED_SPRINT);
    flySettings.ascendSpeed = raw("fly:ascendSpeed", DEF_ASCEND_SPEED);
    flySettings.descendSpeed = raw("fly:descendSpeed", DEF_DESCEND_SPEED);
    flySettings.horizontalDrag = raw("fly:hDrag", DEF_HORIZONTAL_DRAG);
    flySettings.verticalDrag = raw("fly:vDrag", DEF_VERTICAL_DRAG);
    flySettings.fallDamage = raw("fly:fallDamage", DEF_FALL_DAMAGE);
    flySettings.deadzone = raw("fly:deadzone", DEF_DEADZONE);
    flySettings.doubleTapWindow = raw("fly:doubleTapWindow", DEF_DOUBLE_TAP_WINDOW);
}

// --- State ---
const mayflyPlayers = new Set();     // flying via vanilla mayfly
const flyEnabledPlayers = new Set(); // granted the custom ability (toggle ON)
const flyingPlayers = new Set();     // custom: currently airborne (gravity off)
const jumpState = new Map();         // custom: per-player double-tap tracking
const tickCounter = { value: 0 };

function clearPlayerState(id) {
    mayflyPlayers.delete(id);
    flyEnabledPlayers.delete(id);
    flyingPlayers.delete(id);
    jumpState.delete(id);
}

function stopCustomFlight(player) {
    flyingPlayers.delete(player.id);
    try { player.triggerEvent("stop_flying"); } catch (e) { }
}

/** True if the player currently has flight granted by EITHER mechanism. */
export function isFlyEnabled(player) {
    return mayflyPlayers.has(player.id) || flyEnabledPlayers.has(player.id);
}

/**
 * Toggle flight for a player. Prefers vanilla mayfly; falls back to the custom
 * system if mayfly is unavailable. Returns the new enabled state (boolean).
 */
export function toggleFly(player) {
    const target = !isFlyEnabled(player);

    // 1) Try real Creative flight first (works when cheats are enabled).
    try {
        player.runCommand(`ability @s mayfly ${target}`);
        if (target) {
            // Make sure the custom system is not also holding this player.
            flyEnabledPlayers.delete(player.id);
            if (flyingPlayers.has(player.id)) stopCustomFlight(player);
            jumpState.delete(player.id);
            try { player.setDynamicProperty("zyd_fly", false); } catch (e) { }
            mayflyPlayers.add(player.id);
        } else {
            mayflyPlayers.delete(player.id);
        }
        player.sendMessage(target
            ? "§a§l✔ Flight enabled! §r§7(Creative-style)"
            : "§c§l✘ Flight disabled!");
        player.playSound(target ? "random.orb" : "note.bass");
        return target;
    } catch (e) {
        // 2) mayfly unavailable -> use the custom FlyTrue-style system.
        return setCustomFlyEnabled(player, target);
    }
}

/** Grant or revoke the CUSTOM flight ability. Returns the new state. */
export function setCustomFlyEnabled(player, enabled) {
    if (enabled) {
        mayflyPlayers.delete(player.id);
        try { player.setDynamicProperty("zyd_fly", true); } catch (e) { }
        flyEnabledPlayers.add(player.id);
        player.sendMessage("§a§l✔ Flight enabled! §r§7Double-tap §fJump§7 to take off / land. §fSneak§7 = down, §fSprint§7 = faster.");
        player.playSound("random.orb");
    } else {
        try { player.setDynamicProperty("zyd_fly", false); } catch (e) { }
        flyEnabledPlayers.delete(player.id);
        if (flyingPlayers.has(player.id)) stopCustomFlight(player);
        jumpState.delete(player.id);
        player.sendMessage("§c§l✘ Flight disabled!");
        player.playSound("note.bass");
    }
    return enabled;
}

/** Force the player out of the air (gamemode change / death), keeps the grant. */
export function cancelFlight(player) {
    if (flyingPlayers.has(player.id)) stopCustomFlight(player);
}

/**
 * Fully revoke flight for a player, regardless of which mechanism granted it
 * (vanilla mayfly OR the custom impulse system). Used when a player loses
 * rank-based fly permission (rank unequipped/changed, custom rank edited to
 * remove fly, or rank skills disabled) so they don't get stuck flying forever.
 */
export function forceDisableFly(player) {
    const id = player.id;
    let wasEnabled = false;

    if (mayflyPlayers.has(id)) {
        try { player.runCommand("ability @s mayfly false"); } catch (e) { }
        mayflyPlayers.delete(id);
        wasEnabled = true;
    }

    if (flyEnabledPlayers.has(id)) {
        try { player.setDynamicProperty("zyd_fly", false); } catch (e) { }
        flyEnabledPlayers.delete(id);
        if (flyingPlayers.has(id)) stopCustomFlight(player);
        jumpState.delete(id);
        wasEnabled = true;
    }

    if (wasEnabled) {
        try { player.sendMessage("§c§l✘ Flight disabled — your rank no longer grants this ability."); } catch (e) { }
        try { player.playSound("note.bass"); } catch (e) { }
    }

    return wasEnabled;
}

/**
 * Fly settings panel — FlyTrue-style single modal form (OP only, /zyd:flysettings).
 * Submit ("Save & Apply") confirms and persists everything to world dynamic
 * properties. Modal forms can't carry extra buttons in this Script API version,
 * so RESET lives in its own command: /zyd:flysettingsclear (same as FlyTrue).
 */
export function showFlySettingsMenu(source) {
    system.run(() => {
        const form = new ModalFormData();
        form.title("§b§lFly Settings");
        form.textField("Horizontal Speed:", " ", { defaultValue: `${flySettings.horizontalSpeed}` });
        form.textField("Horizontal Sprinting Speed:", " ", { defaultValue: `${flySettings.horizontalSprintSpeed}` });
        form.textField("Descend Speed:", " ", { defaultValue: `${flySettings.descendSpeed}` });
        form.textField("Ascend Speed:", " ", { defaultValue: `${flySettings.ascendSpeed}` });
        form.textField("Horizontal Drag:", " ", { defaultValue: `${flySettings.horizontalDrag}` });
        form.textField("Vertical Drag:", " ", { defaultValue: `${flySettings.verticalDrag}` });
        form.toggle("Fall Damage", { defaultValue: flySettings.fallDamage });
        form.toggle("§cReset to Default Settings", { defaultValue: false });
        form.divider();
        form.submitButton("§a§lSave & Apply");

        form.show(source).then((r) => {
            if (r.canceled) return;

            const [h, hs, d, a, hd, vd, fall, resetToDefaults] = r.formValues;

            if (resetToDefaults) {
                resetFlySettingsToDefaults();
                source.sendMessage("§a§l✔ Fly settings have been reset to defaults!");
                world.sendMessage(`§9§l[FLY] §r§7${source.name} reset fly settings to defaults.`);
                return;
            }

            const nums = [h, hs, d, a, hd, vd].map((v) => parseFloat(String(v).trim()));
            if (nums.some((n) => isNaN(n) || n < 0)) {
                source.sendMessage("§c§l✘ Invalid number entered — settings were not changed.");
                return;
            }
            const fallDamage = !!fall;

            flySettings.horizontalSpeed = nums[0];
            flySettings.horizontalSprintSpeed = nums[1];
            flySettings.descendSpeed = nums[2];
            flySettings.ascendSpeed = nums[3];
            flySettings.horizontalDrag = nums[4];
            flySettings.verticalDrag = nums[5];
            flySettings.fallDamage = fallDamage;

            // Persist so values survive script reloads / server restarts.
            world.setDynamicProperty("fly:hSpeed", nums[0]);
            world.setDynamicProperty("fly:hSprintSpeed", nums[1]);
            world.setDynamicProperty("fly:descendSpeed", nums[2]);
            world.setDynamicProperty("fly:ascendSpeed", nums[3]);
            world.setDynamicProperty("fly:hDrag", nums[4]);
            world.setDynamicProperty("fly:vDrag", nums[5]);
            world.setDynamicProperty("fly:fallDamage", fallDamage);

            world.sendMessage(
                `§9§l[FLY] §r§7${source.name} set fly settings: §f${nums[0]} ${nums[1]} ${nums[2]} ${nums[3]} ${nums[4]} ${nums[5]} §7fallDamage=${fallDamage}`
            );
        });
    });
}

/** Reset all fly settings to defaults (in-memory + persisted). */
export function resetFlySettingsToDefaults() {
    Object.assign(flySettings, {
        horizontalSpeed: DEF_HORIZONTAL_SPEED,
        horizontalSprintSpeed: DEF_HORIZONTAL_SPEED_SPRINT,
        ascendSpeed: DEF_ASCEND_SPEED,
        descendSpeed: DEF_DESCEND_SPEED,
        horizontalDrag: DEF_HORIZONTAL_DRAG,
        verticalDrag: DEF_VERTICAL_DRAG,
        fallDamage: DEF_FALL_DAMAGE,
        deadzone: DEF_DEADZONE,
        doubleTapWindow: DEF_DOUBLE_TAP_WINDOW,
    });
    world.setDynamicProperty("fly:hSpeed", DEF_HORIZONTAL_SPEED);
    world.setDynamicProperty("fly:hSprintSpeed", DEF_HORIZONTAL_SPEED_SPRINT);
    world.setDynamicProperty("fly:ascendSpeed", DEF_ASCEND_SPEED);
    world.setDynamicProperty("fly:descendSpeed", DEF_DESCEND_SPEED);
    world.setDynamicProperty("fly:hDrag", DEF_HORIZONTAL_DRAG);
    world.setDynamicProperty("fly:vDrag", DEF_VERTICAL_DRAG);
    world.setDynamicProperty("fly:fallDamage", DEF_FALL_DAMAGE);
}

// === Registration: events + movement loop ===
export function registerFlySystem() {
    // Load persisted settings before anything else runs.
    loadFlySettingsFromWorld();

    // Reset custom flight to OFF on rejoin to prevent midair floating/barrier bugs.
    // Scans downwards for the nearest solid ground and teleports the player directly to the surface.
    world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
        if (!initialSpawn) return;

        const id = player.id;

        // Force stop any lingering flight component/animation state in Bedrock
        try { player.triggerEvent("stop_flying"); } catch (e) { }
        try { player.setDynamicProperty("zyd_fly", false); } catch (e) { }

        // Clear all flight states
        mayflyPlayers.delete(id);
        flyEnabledPlayers.add(id); // Keep them in the list so they can fly again later
        flyingPlayers.delete(id);
        jumpState.delete(id);

        // Wait a brief moment for chunks to load, check if mid-air, then apply safety/TP
        system.runTimeout(() => {
            if (!player.isValid) return;

            const dim = player.dimension;
            const loc = player.location;
            const bx = Math.floor(loc.x);
            const by = Math.floor(loc.y);
            const bz = Math.floor(loc.z);
            const minHeight = dim.heightRange.min;

            // Check if player is already safely on the ground (block beneath is solid)
            try {
                const blockBelow = dim.getBlock({ x: bx, y: by - 1, z: bz });
                if (blockBelow && !blockBelow.isAir) return; // Safely on ground, abort parachute!
            } catch (e) { }

            // If we reach here, they are floating mid-air. Give parachute effects.
            try {
                player.addEffect("slow_falling", 400, { amplifier: 0, showParticles: false });
                player.addEffect("resistance", 400, { amplifier: 255, showParticles: false });
            } catch (e) { }

            let surfaceY = null;

            // Scan downwards for ground (Solid or Liquid like Water)
            for (let y = by; y >= minHeight; y--) {
                try {
                    const block = dim.getBlock({ x: bx, y: y, z: bz });
                    if (block && !block.isAir) {
                        surfaceY = y + 1;
                        break;
                    }
                } catch (e) { break; }
            }

            // If ground was found, teleport and clear the parachute effect
            if (surfaceY !== null && surfaceY < by) {
                try {
                    player.teleport({ x: bx + 0.5, y: surfaceY, z: bz + 0.5 }, { dimension: dim });
                    // Remove slow falling since they are now on the ground
                    player.removeEffect("slow_falling");
                    player.sendMessage("§e[Flight] Safely returned to the surface.");
                } catch (e) {
                    // If teleport fails, they still have 20 seconds of Slow Falling as backup
                }
            }
        }, 20); // 1 second delay to allow chunks to load slightly
    });

    // Clear in-memory state when a player leaves.
    world.afterEvents.playerLeave.subscribe(({ playerId }) => {
        clearPlayerState(playerId);
    });

    // Cancel fall damage while custom flight is granted.
    world.beforeEvents.entityHurt.subscribe((event) => {
        const hurt = event.hurtEntity;
        if (hurt.typeId !== "minecraft:player") return;
        if (!flyEnabledPlayers.has(hurt.id)) return;
        if (event.damageSource.cause !== "fall") return;
        if (flySettings.fallDamage) return; // true means: DO NOT cancel (allow damage)
        event.cancel = true;
    });

    // Per-tick movement loop (custom system only).
    system.runInterval(() => {
        tickCounter.value++;

        for (const player of world.getAllPlayers()) {
            const id = player.id;

            // Not granted custom flight -> ensure not stuck airborne, then skip.
            if (!flyEnabledPlayers.has(id)) {
                if (flyingPlayers.has(id)) stopCustomFlight(player);
                jumpState.delete(id);
                continue;
            }

            // In Creative/Spectator the player flies natively; suspend our system.
            let gm = "";
            try { gm = String(player.getGameMode()).toLowerCase(); } catch (e) { }
            if (gm === "creative" || gm === "spectator") {
                if (flyingPlayers.has(id)) stopCustomFlight(player);
                continue;
            }

            // Dead -> drop out of the air.
            const health = player.getComponent("minecraft:health");
            if (health && health.currentValue <= 0) {
                if (flyingPlayers.has(id)) stopCustomFlight(player);
                continue;
            }

            const info = player.inputInfo;

            const jump = info ? info.getButtonState(InputButton.Jump) === ButtonState.Pressed : false;
            const sneak = player.isSneaking || (info && info.getButtonState(InputButton.Sneak) === ButtonState.Pressed);
            const sprint = player.isSprinting;

            const movement = info.getMovementVector();
            const moving = Math.abs(movement.x) > flySettings.deadzone || Math.abs(movement.y) > flySettings.deadzone;

            // --- Double-tap Jump detection => take off / land ---
            let state = jumpState.get(id);
            if (!state) {
                state = { lastPressed: false, lastTick: -999 };
                jumpState.set(id, state);
            }

            if (jump && !state.lastPressed) {
                if (tickCounter.value - state.lastTick <= flySettings.doubleTapWindow) {
                    if (flyingPlayers.has(id)) {
                        stopCustomFlight(player);
                    } else {
                        flyingPlayers.add(id);
                        try { player.triggerEvent("start_flying"); } catch (e) { }
                    }
                    state.lastTick = -999;
                } else {
                    state.lastTick = tickCounter.value;
                }
            }
            state.lastPressed = jump;

            if (!flyingPlayers.has(id)) continue;

            // --- Apply motion ---
            const vel = player.getVelocity();
            let impX = 0, impY = 0, impZ = 0;

            if (moving) {
                const look = player.getViewDirection();
                const forward = { x: look.x, z: look.z };
                const right = { x: look.z, z: -look.x };

                const dirX = forward.x * movement.y + right.x * movement.x;
                const dirZ = forward.z * movement.y + right.z * movement.x;
                const len = Math.hypot(dirX, dirZ);

                if (len > 0) {
                    const speed = sprint ? flySettings.horizontalSprintSpeed : flySettings.horizontalSpeed;
                    impX = (dirX / len) * speed;
                    impZ = (dirZ / len) * speed;
                }
            } else {
                impX = -vel.x * flySettings.horizontalDrag;
                impZ = -vel.z * flySettings.horizontalDrag;
            }

            if (jump) {
                impY = flySettings.ascendSpeed;
            } else if (sneak) {
                impY = -flySettings.descendSpeed;
            } else {
                impY = -vel.y * flySettings.verticalDrag;
            }

            if (impX !== 0 || impY !== 0 || impZ !== 0) {
                try { player.applyImpulse({ x: impX, y: impY, z: impZ }); } catch (e) { }
            }

            // Snap to a clean hover when input stops and we are basically still.
            const finalVelX = vel.x + impX;
            const finalVelY = vel.y + impY;
            const finalVelZ = vel.z + impZ;
            const stopX = !moving && Math.abs(finalVelX) < flySettings.deadzone;
            const stopY = !jump && !sneak && Math.abs(finalVelY) < flySettings.deadzone;
            const stopZ = !moving && Math.abs(finalVelZ) < flySettings.deadzone;
            if (stopX && stopY && stopZ) {
                try { player.clearVelocity(); } catch (e) { }
            }

            // Touching the ground ends the flight (like Creative).
            if (player.isOnGround) {
                stopCustomFlight(player);
            }
        }
    }, 1);
}

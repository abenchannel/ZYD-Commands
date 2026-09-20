import { ActionFormData } from "@minecraft/server-ui";
import { world, system } from "@minecraft/server";
import { saveFrozenLocation, getFrozenLocation, clearFrozenLocation } from "../data/frozendata.js";

// =====================================================
// 🔧 FREEZE INTERVAL MANAGEMENT (OPTIMIZED)
// =====================================================

/**
 * Stores the current running interval handle.
 * undefined = loop is NOT running (no frozen players)
 * number/interval = loop IS actively ticking
 */
let freezeIntervalHandle = undefined;

/**
 * ✅ STARTS the freeze monitoring loop
 * Only runs when at least 1 player is frozen
 * Automatically checks every 20 ticks (1 second)
 */
function startFreezeLoop() {
    // Prevent duplicate intervals
    if (freezeIntervalHandle !== undefined) {
        console.warn("[Freeze] Loop already running, skipping...");
        return;
    }

    console.warn("✅ [Freeze] Monitoring loop STARTED");

    freezeIntervalHandle = system.runInterval(() => {
        // Get all currently frozen players
        const frozenPlayers = world.getPlayers().filter(p =>
            p.hasTag("frozed") && p.hasTag("ban")
        );

        // 🛑 AUTO-STOP: If no frozen players remain, kill the loop!
        if (frozenPlayers.length === 0) {
            stopFreezeLoop();
            return;
        }

        // Process each frozen player
        for (const player of frozenPlayers) {
            try {
                // Show action bar message
                player.onScreenDisplay.setActionBar("§cYou are currently frozen!");

                // Teleport back to saved location
                const loc = getFrozenLocation(player);
                if (loc) {
                    const frozenDim = world.getDimension(loc.dimension);
                    player.teleport(
                        { x: loc.x, y: loc.y, z: loc.z },
                        { dimension: frozenDim }
                    );
                }
            } catch (error) {
                console.error(`[Freeze] Error processing ${player.name}:`, error);
            }
        }
    }, 20); // Run every 20 ticks (1 second)
}

/**
 * ⏹️ STOPS the freeze monitoring loop
 * Called when no players are frozen anymore
 */
function stopFreezeLoop() {
    if (freezeIntervalHandle !== undefined) {
        system.clearRun(freezeIntervalHandle);
        freezeIntervalHandle = undefined;
        console.warn("⏹️ [Freeze] Monitoring loop STOPPED (no frozen players)");
    }
}

// =====================================================
// ❄️ FREEZE / UNFREEZE PLAYER FUNCTIONS
// =====================================================

/**
 * Freezes a target player in place
 * @param {Player} target - The player to freeze
 */
function freezePlayer(target) {
    // Apply tags
    target.addTag("frozed");
    target.addTag("ban");

    // Execute freeze command function
    try {
        target.runCommand("function freeze");
    } catch (e) {
        console.error(`[Freeze] Command failed for ${target.name}:`, e);
    }

    // Save current location for teleport-locking
    saveFrozenLocation(target);

    // Notify server
    world.sendMessage(`§c${target.nameTag} has been frozen by admins!`);

    // 🚀 START the monitoring loop (if not already running)
    startFreezeLoop();
}

/**
 * Unfreezes a target player
 * @param {Player} target - The player to unfreeze
 */
function unfreezePlayer(target) {
    // Remove tags
    target.removeTag("frozed");
    target.removeTag("ban");

    // Execute unfreeze command function
    try {
        target.runCommand("function unfreeze");
    } catch (e) {
        console.error(`[Freeze] Unfreeze command failed for ${target.name}:`, e);
    }

    // Clear saved location data
    clearFrozenLocation(target);

    // Notify server
    world.sendMessage(`§a${target.nameTag} has been unfrozen by admins!`);

    // Show farewell message to unfrozen player
    target.onScreenDisplay.setActionBar("§aYou are no longer frozen, you are free to go...");

    // 🛑 Check if anyone else is still frozen; if not, stop the loop
    const stillFrozen = world.getPlayers().some(p =>
        p.hasTag("frozed") && p.hasTag("ban")
    );

    if (!stillFrozen) {
        stopFreezeLoop();
    }
}

// =====================================================
// 🎨 USER INTERFACE FUNCTIONS
// =====================================================

/**
 * Shows the Freeze Player selection sub-menu
 * Lists all online players (except self and OPs)
 * @param {Player} player - The admin using the menu
 */
export function showFreezePlayerSubUI(player) {
    // Filter out self and OP-tagged players
    const players = Array.from(world.getPlayers())
        .filter(p => p.name !== player.name && !p.hasTag("op"));

    // Handle empty list
    if (players.length === 0) {
        player.sendMessage("§eNo other players online to freeze.");
        return;
    }

    // Build form
    const form = new ActionFormData()
        .title("§c❄️ Freeze Player")
        .body("§7Select a player from the list below:\n\n§fClick a name to freeze/unfreeze them.");

    // Add buttons for each player
    players.forEach(p => {
        const status = (p.hasTag("frozed") && p.hasTag("ban")) ? " §c[FROZEN]" : " §a[Active]";
        form.button(`${p.nameTag}${status}`);
    });

    // Add back button
    form.button("§c« Back to Admin Panel");

    // Show form and handle response
    form.show(player).then(response => {
        if (response.canceled) return;

        const selectedIndex = response.selection;

        // Back button clicked
        if (selectedIndex === players.length) {
            import("./admin.js").then(mod => {
                if (typeof mod.showAdminPanel === "function") {
                    mod.showAdminPanel(player);
                }
            });
            return;
        }

        // Player selected
        const target = players[selectedIndex];
        if (!target) return;

        // Show confirmation dialog
        showFreezeConfirm(player, target);
    }).catch(error => {
        console.error("[Freeze] Form error:", error);
        player.sendMessage("§cAn error occurred while opening the menu.");
    });
}

/**
 * Shows confirmation dialog for freezing/unfreezing
 * @param {Player} player - The admin
 * @param {Player} target - The player to freeze/unfreeze
 */
function showFreezeConfirm(player, target) {
    const isFrozen = target.hasTag("frozed") && target.hasTag("ban");
    const targetStatus = isFrozen ? "§cFROZEN" : "§aACTIVE";
    const actionText = isFrozen ? "unfreeze" : "freeze";
    const actionColor = isFrozen ? "§a" : "§c";

    const form = new ActionFormData()
        .title(`§c❄️ ${actionText.toUpperCase()} PLAYER`)
        .body(
            `§7Target: §f${target.nameTag}\n` +
            `§7Current Status: ${targetStatus}\n\n` +
            `§7Are you sure you want to ${actionText} this player?\n\n` +
            `${actionColor}⚠ This will ${actionText} them immediately!`
        )
        .button(`§l${actionColor}✓ Confirm ${actionText}`)
        .button("§c✗ Cancel");

    form.show(player).then(response => {
        if (response.canceled) {
            player.sendMessage("§eAction cancelled.");
            return;
        }

        switch (response.selection) {
            case 0: // Confirm button
                if (isFrozen) {
                    unfreezePlayer(target);
                } else {
                    freezePlayer(target);
                }

                // Refresh menu after action
                setTimeout(() => {
                    showFreezePlayerSubUI(player);
                }, 500); // Small delay to ensure tags update
                break;

            case 1: // Cancel button
                player.sendMessage("§eAction cancelled.");
                break;
        }
    }).catch(error => {
        console.error("[Freeze] Confirmation error:", error);
        player.sendMessage("§cAn error occurred.");
    });
}
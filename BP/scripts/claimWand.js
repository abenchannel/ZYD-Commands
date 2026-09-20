//scripts/claimWand.js
//
// Right-click handler for the zyd:claim_wand item.
// Listens for the itemUse event and opens the Factions UI.
//
// NOTE on events:
//  - world.beforeEvents.itemUse  -> fires when the player USES (right-clicks) an item.
//    You must defer UI code with system.run(...) because this runs in the
//    "before" phase (read-only). Your codebase already follows this rule.
//  - The check uses the FULL item identifier "zyd:claim_wand" exactly as it
//    appears in BP/items/claim_wand.item.json.
//
//  - itemUse fires for right-clicking in the AIR. If you also want to react to
//    right-clicking ON a block (e.g. claim the chunk you clicked), use
//    world.afterEvents.playerInteractWithBlock and read e.itemStack.typeId.

import { world, system, Player } from "@minecraft/server";
import { showClaimMenuUI } from "./factionsClaims.js";

const CLAIM_WAND_ID = "zyd:claim_wand";

/**
 * What the wand does when used. Swap this out if you want a different UI
 * (e.g. a dedicated claim panel instead of the full Factions menu).
 */
function useClaimWand(player) {
    player.playSound("random.orb");
    showClaimMenuUI(player);
}

// ===========================================================================
// EVENT: USE ITEM (right-click in air / use)
// ===========================================================================
world.beforeEvents.itemUse.subscribe((event) => {
    const player = event.source;
    const item = event.itemStack;

    if (!(player instanceof Player)) return;
    if (item?.typeId !== CLAIM_WAND_ID) return;

    // Defer because beforeEvents is read-only — UI must open in a later tick.
    system.run(() => useClaimWand(player));
});

// ===========================================================================
// EVENT: INTERACT WITH BLOCK (right-click ON a block)
// ===========================================================================
// Uncomment if your claim wand should also work when right-clicking terrain,
// not just air. e.itemStack is the held item at the time of the click.
/*
world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    const player = event.player;
    const item = event.itemStack;
    if (item?.typeId !== CLAIM_WAND_ID) return;

    system.run(() => {
        // Example: use event.block to claim the chunk/block the player clicked.
        // const clickedBlock = event.block;
        useClaimWand(player);
    });
});
*/

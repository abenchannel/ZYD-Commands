// scripts/factionsProtection.js
// ============================================
// FACTIONS PROTECTION SYSTEM
// ============================================
// Handles all block/entity/interaction protection for claimed chunks.
// 
// Protection is based on WHERE THE BLOCK IS, not where the player stands.
// A player standing in Wilderness cannot break blocks in a claimed chunk.
//
// Global Settings (OP toggles via /zyd:factionsettings > Protection Settings):
// - Allow TNT/Creeper/Wither block damage in claims
// - Allow allies to interact globally
// - Allow enemy fire (Flint & Steel)
// - Allow enemy buckets (Lava/Water)
// - Allow crystal/anchor damage
//
// Per-Role Permissions (Owner/Admin configurable via My Faction > Roles):
// - Can Break Blocks
// - Can Place Blocks
// - Can Open Containers
// - Can Use Doors/Redstone
// ============================================

import { world, system, BlockPermutation } from "@minecraft/server";
import { getAllFactions, getPlayerFactionId, getFactionById, hasFactionPermission, calculateFactionPower } from "./factionsCore.js";
import { getChunkOwnerAt } from "./factionsClaims.js";

// ============================================
// SECTION 1: CONSTANTS
// ============================================

const PROTECTION_SETTINGS_KEY = "zyd:faction_protection_settings";

const DEFAULT_PROTECTION_SETTINGS = {
    allowTntDamage: false,
    allowCreeperDamage: false,
    allowWitherDamage: false,
    allowCrystalDamage: false,
    allowExplosionPlayerDamage: false,
    allowRaidOnZeroPower: false,
    allowAllyInteract: false,
    allowEnemyFire: false,
    allowEnemyBuckets: false,
    blockEnemyProjectiles: true
};

const BUCKET_ITEMS = new Set([
    "minecraft:bucket", "minecraft:water_bucket", "minecraft:lava_bucket",
    "minecraft:powder_snow_bucket", "minecraft:cod_bucket", "minecraft:salmon_bucket",
    "minecraft:tropical_fish_bucket", "minecraft:axolotl_bucket", "minecraft:tadpole_bucket"
]);

const FIRE_ITEMS = new Set([
    "minecraft:flint_and_steel", "minecraft:fire_charge"
]);

const CONTAINER_BLOCKS = new Set([
    "minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel",
    "minecraft:shulker_box", "minecraft:undyed_shulker_box",
    "minecraft:white_shulker_box", "minecraft:orange_shulker_box",
    "minecraft:magenta_shulker_box", "minecraft:light_blue_shulker_box",
    "minecraft:yellow_shulker_box", "minecraft:lime_shulker_box",
    "minecraft:pink_shulker_box", "minecraft:gray_shulker_box",
    "minecraft:light_gray_shulker_box", "minecraft:cyan_shulker_box",
    "minecraft:purple_shulker_box", "minecraft:blue_shulker_box",
    "minecraft:brown_shulker_box", "minecraft:green_shulker_box",
    "minecraft:red_shulker_box", "minecraft:black_shulker_box",
    "minecraft:hopper", "minecraft:dispenser", "minecraft:dropper",
    "minecraft:furnace", "minecraft:blast_furnace", "minecraft:smoker",
    "minecraft:brewing_stand", "minecraft:lectern", "minecraft:jukebox",
    "minecraft:ender_chest", "minecraft:chiseled_bookshelf",
    "minecraft:decorated_pot", "minecraft:crafter"
]);

const DOOR_BLOCKS = new Set([
    "minecraft:wooden_door", "minecraft:spruce_door", "minecraft:birch_door",
    "minecraft:jungle_door", "minecraft:acacia_door", "minecraft:dark_oak_door",
    "minecraft:mangrove_door", "minecraft:cherry_door", "minecraft:bamboo_door",
    "minecraft:crimson_door", "minecraft:warped_door", "minecraft:iron_door",
    "minecraft:copper_door", "minecraft:exposed_copper_door",
    "minecraft:weathered_copper_door", "minecraft:oxidized_copper_door",
    "minecraft:waxed_copper_door", "minecraft:waxed_exposed_copper_door",
    "minecraft:waxed_weathered_copper_door", "minecraft:waxed_oxidized_copper_door",
    "minecraft:trapdoor", "minecraft:spruce_trapdoor", "minecraft:birch_trapdoor",
    "minecraft:jungle_trapdoor", "minecraft:acacia_trapdoor", "minecraft:dark_oak_trapdoor",
    "minecraft:mangrove_trapdoor", "minecraft:cherry_trapdoor", "minecraft:bamboo_trapdoor",
    "minecraft:crimson_trapdoor", "minecraft:warped_trapdoor", "minecraft:iron_trapdoor",
    "minecraft:copper_trapdoor", "minecraft:exposed_copper_trapdoor",
    "minecraft:weathered_copper_trapdoor", "minecraft:oxidized_copper_trapdoor",
    "minecraft:waxed_copper_trapdoor", "minecraft:waxed_exposed_copper_trapdoor",
    "minecraft:waxed_weathered_copper_trapdoor", "minecraft:waxed_oxidized_copper_trapdoor",
    "minecraft:fence_gate", "minecraft:spruce_fence_gate", "minecraft:birch_fence_gate",
    "minecraft:jungle_fence_gate", "minecraft:acacia_fence_gate", "minecraft:dark_oak_fence_gate",
    "minecraft:mangrove_fence_gate", "minecraft:cherry_fence_gate", "minecraft:bamboo_fence_gate",
    "minecraft:crimson_fence_gate", "minecraft:warped_fence_gate"
]);

const REDSTONE_BLOCKS = new Set([
    "minecraft:lever", "minecraft:wooden_button", "minecraft:spruce_button",
    "minecraft:birch_button", "minecraft:jungle_button", "minecraft:acacia_button",
    "minecraft:dark_oak_button", "minecraft:mangrove_button", "minecraft:cherry_button",
    "minecraft:bamboo_button", "minecraft:crimson_button", "minecraft:warped_button",
    "minecraft:stone_button", "minecraft:polished_blackstone_button",
    "minecraft:wooden_pressure_plate", "minecraft:spruce_pressure_plate",
    "minecraft:birch_pressure_plate", "minecraft:jungle_pressure_plate",
    "minecraft:acacia_pressure_plate", "minecraft:dark_oak_pressure_plate",
    "minecraft:mangrove_pressure_plate", "minecraft:cherry_pressure_plate",
    "minecraft:bamboo_pressure_plate", "minecraft:crimson_pressure_plate",
    "minecraft:warped_pressure_plate", "minecraft:stone_pressure_plate",
    "minecraft:polished_blackstone_pressure_plate", "minecraft:light_weighted_pressure_plate",
    "minecraft:heavy_weighted_pressure_plate", "minecraft:daylight_detector",
    "minecraft:daylight_detector_inverted", "minecraft:comparator",
    "minecraft:powered_comparator", "minecraft:unpowered_comparator",
    "minecraft:repeater", "minecraft:powered_repeater", "minecraft:unpowered_repeater",
    "minecraft:noteblock", "minecraft:jukebox"
]);

const PROTECTED_PASSIVE_MOBS = new Set([
    "minecraft:villager", "minecraft:wandering_trader", "minecraft:iron_golem",
    "minecraft:snow_golem", "minecraft:sheep", "minecraft:cow", "minecraft:chicken",
    "minecraft:pig", "minecraft:horse", "minecraft:donkey", "minecraft:mule",
    "minecraft:llama", "minecraft:trader_llama", "minecraft:cat", "minecraft:ocelot",
    "minecraft:parrot", "minecraft:rabbit", "minecraft:turtle", "minecraft:panda",
    "minecraft:fox", "minecraft:mooshroom", "minecraft:bee", "minecraft:strider",
    "minecraft:axolotl", "minecraft:frog", "minecraft:goat", "minecraft:allay",
    "minecraft:camel", "minecraft:sniffer", "minecraft:armadillo", "minecraft:armor_stand",
    "minecraft:wolf", "minecraft:happy_ghast"
]);

// ============================================
// SECTION 2: SETTINGS HELPERS
// ============================================

export function getProtectionSettings() {
    try {
        const raw = world.getDynamicProperty(PROTECTION_SETTINGS_KEY);
        if (raw) return { ...DEFAULT_PROTECTION_SETTINGS, ...JSON.parse(raw) };
    } catch (e) { }
    return { ...DEFAULT_PROTECTION_SETTINGS };
}

export function saveProtectionSettings(settings) {
    try {
        world.setDynamicProperty(PROTECTION_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn("[FactionsProtection] Failed to save settings:", e);
    }
}

// ============================================
// SECTION 3: RELATIONSHIP HELPERS
// ============================================

function getRelationship(playerFactionId, chunkOwnerId) {
    if (!chunkOwnerId) return "wilderness";
    if (!playerFactionId) return "stranger";
    if (playerFactionId === chunkOwnerId) return "own";

    const factions = getAllFactions();
    const myFaction = factions[playerFactionId];
    if (!myFaction) return "stranger";

    if ((myFaction.allies || []).includes(chunkOwnerId)) return "ally";
    if ((myFaction.enemies || []).some(e => e.factionId === chunkOwnerId)) return "enemy";

    return "stranger";
}

// ============================================
// SECTION 4: BLOCK BREAKING
// ============================================

const safeSub = (signal, cb) => {
    if (signal && typeof signal.subscribe === "function") {
        try { signal.subscribe(cb); } catch (e) { }
    }
};

safeSub(world.beforeEvents?.playerBreakBlock, (event) => {
    const player = event.player;
    const block = event.block;

    if (player.hasTag("op")) return;

    const chunkOwnerId = getChunkOwnerAt(block.location, block.dimension.id);
    if (!chunkOwnerId) return;

    const playerFactionId = getPlayerFactionId(player.id);

    if (playerFactionId === chunkOwnerId) {
        const faction = getFactionById(chunkOwnerId);
        if (faction && !hasFactionPermission(faction, player.id, "canBreak")) {
            event.cancel = true;
            system.run(() => {
                player.sendMessage("§cYou don't have permission to break blocks in your faction.");
            });
        }
        return;
    }

    event.cancel = true;
    const ownerFac = getFactionById(chunkOwnerId);
    const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
    system.run(() => {
        player.sendMessage(`§cYou cannot break blocks in §b${name}§c's territory.`);
    });
});

// ============================================
// SECTION 5: BLOCK PLACING (Includes Liquids/Fire)
// ============================================

safeSub(world.beforeEvents?.playerPlaceBlock, (event) => {
    const player = event.player;
    const block = event.block;

    if (player.hasTag("op")) return;

    const chunkOwnerId = getChunkOwnerAt(block.location, block.dimension.id);
    if (!chunkOwnerId) return;

    const playerFactionId = getPlayerFactionId(player.id);

    if (playerFactionId === chunkOwnerId) {
        const faction = getFactionById(chunkOwnerId);
        if (faction && !hasFactionPermission(faction, player.id, "canPlace")) {
            event.cancel = true;
            system.run(() => {
                player.sendMessage("§cYou don't have permission to place blocks in your faction.");
            });
        }
        return;
    }

    const blockId = block.typeId;
    const settings = getProtectionSettings();

    if (!settings.allowEnemyFire && blockId === "minecraft:fire") {
        event.cancel = true;
        system.run(() => {
            player.sendMessage("§cYou cannot use fire in another faction's territory.");
        });
        return;
    }

    if (!settings.allowEnemyBuckets && (blockId === "minecraft:water" || blockId === "minecraft:flowing_water" || blockId === "minecraft:lava" || blockId === "minecraft:flowing_lava")) {
        event.cancel = true;
        system.run(() => {
            player.sendMessage("§cYou cannot place liquids in another faction's territory.");
        });
        return;
    }

    event.cancel = true;
    const ownerFac = getFactionById(chunkOwnerId);
    const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
    system.run(() => {
        player.sendMessage(`§cYou cannot place blocks in §b${name}§c's territory.`);
    });
});

// ============================================
// BUCKET & FIRE RESTRICTION HELPER
// ============================================

function isBucketOrFireBlocked(player, block, itemStack) {
    if (!player || player.hasTag("op")) return false;
    if (!itemStack) return false;

    const itemId = itemStack.typeId;
    const isBucket = BUCKET_ITEMS.has(itemId);
    const isFire = FIRE_ITEMS.has(itemId);

    if (!isBucket && !isFire) return false;

    const settings = getProtectionSettings();
    if (isBucket && settings.allowEnemyBuckets) return false;
    if (isFire && settings.allowEnemyFire) return false;

    const playerFacId = getPlayerFactionId(player.id);

    // 1. Check target block location
    if (block) {
        const chunkOwnerId = getChunkOwnerAt(block.location, block.dimension.id);
        if (chunkOwnerId && chunkOwnerId !== playerFacId) {
            return true;
        }
    }

    // 2. Check player standing location
    const playerChunkOwnerId = getChunkOwnerAt(player.location, player.dimension.id);
    if (playerChunkOwnerId && playerChunkOwnerId !== playerFacId) {
        return true;
    }

    return false;
}

// ============================================
// SECTION 6: INTERACT WITH BLOCK
// ============================================

safeSub(world.beforeEvents?.playerInteractWithBlock, (event) => {
    const player = event.player;
    const block = event.block;

    if (player.hasTag("op")) return;
    if (!block) return;

    const chunkOwnerId = getChunkOwnerAt(block.location, block.dimension.id);
    if (!chunkOwnerId) return; // Wilderness = allowed

    const playerFactionId = getPlayerFactionId(player.id);
    const relationship = getRelationship(playerFactionId, chunkOwnerId);

    const itemStack = event.itemStack || player.getComponent("equippable")?.getEquipment("Mainhand");

    // 1. Check Buckets & Fire in Enemy/Stranger territory
    if (isBucketOrFireBlocked(player, block, itemStack)) {
        event.cancel = true;
        system.run(() => {
            player.sendMessage("§cYou cannot use buckets or fire in another faction's territory.");
        });
        return;
    }

    // 2. Check Landscaping Tools (Hoe tilling, Shovel paths, Axe stripping) in other faction's territory
    if (itemStack && relationship !== "own") {
        const itemId = itemStack.typeId;
        if (itemId.includes("hoe") || itemId.includes("shovel") || itemId.includes("axe")) {
            event.cancel = true;
            const ownerFac = getFactionById(chunkOwnerId);
            const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
            system.run(() => {
                player.sendMessage(`§cYou cannot use tools to alter terrain in §b${name}§c's territory.`);
            });
            return;
        }
    }

    // 3. Check Block Type Interactions (Containers, Doors, Redstone)
    const blockId = block.typeId;
    const isContainer = CONTAINER_BLOCKS.has(blockId);
    const isDoor = DOOR_BLOCKS.has(blockId);
    const isRedstone = REDSTONE_BLOCKS.has(blockId);

    if (relationship === "own") {
        const faction = getFactionById(chunkOwnerId);
        if (!faction) return;

        if (isContainer && !hasFactionPermission(faction, player.id, "canOpenContainers")) {
            event.cancel = true;
            system.run(() => {
                player.sendMessage("§cYou don't have permission to open containers in your faction.");
            });
            return;
        }
        if ((isDoor || isRedstone) && !hasFactionPermission(faction, player.id, "canUseDoors")) {
            event.cancel = true;
            system.run(() => {
                player.sendMessage("§cYou don't have permission to use doors or redstone in your faction.");
            });
            return;
        }
        return; // Permitted
    }

    if (!isContainer && !isDoor && !isRedstone) return;

    if (relationship === "ally") {
        const settings = getProtectionSettings();
        if (settings.allowAllyInteract) return;
        event.cancel = true;
        system.run(() => {
            player.sendMessage("§cAlly interaction is disabled by server settings.");
        });
        return;
    }

    event.cancel = true;
    const ownerFac = getFactionById(chunkOwnerId);
    const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
    system.run(() => {
        player.sendMessage(`§cYou cannot interact here. It belongs to §b${name}§c.`);
    });
});

// ============================================
// SECTION 7: ITEM USE ON BLOCK & AIR (Buckets, Fire, Hoes, Shovels, Axes)
// ============================================

safeSub(world.beforeEvents?.itemUseOn, (event) => {
    const player = event.source;
    const block = event.block;
    const itemStack = event.itemStack;

    if (!player || player.typeId !== "minecraft:player" || player.hasTag("op") || !block) return;

    const chunkOwnerId = getChunkOwnerAt(block.location, block.dimension.id);
    if (!chunkOwnerId) return;

    const playerFactionId = getPlayerFactionId(player.id);
    if (chunkOwnerId === playerFactionId) return; // Your own faction is safe

    // 1. Check Bucket & Fire Overrides First
    if (isBucketOrFireBlocked(player, block, itemStack)) {
        event.cancel = true;
        system.run(() => {
            player.sendMessage("§cYou cannot use buckets or fire in another faction's territory.");
        });
        return;
    }

    // 2. Block Landscaping Tools (Hoe, Shovel paths, Axe stripping)
    if (itemStack) {
        const itemId = itemStack.typeId;
        if (itemId.endsWith("_hoe") || itemId.endsWith("_shovel") || itemId.endsWith("_axe")) {
            event.cancel = true;
            const ownerFac = getFactionById(chunkOwnerId);
            const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
            system.run(() => {
                player.sendMessage(`§cYou cannot use tools to alter terrain in §b${name}§c's territory.`);
            });
            return;
        }
    }
});

safeSub(world.beforeEvents?.itemUse, (event) => {
    const player = event.source;
    const itemStack = event.itemStack;

    if (isBucketOrFireBlocked(player, null, itemStack)) {
        event.cancel = true;
        system.run(() => {
            player.sendMessage("§cYou cannot use buckets or fire in another faction's territory.");
        });
    }
});

// ============================================
// SECTION 8: EXPLOSIONS (TNT, Creeper, Wither, Crystals)
// ============================================

safeSub(world.beforeEvents?.explosion, (event) => {
    const source = event.source;
    const settings = getProtectionSettings();

    let isTnt = false;
    let isCreeper = false;
    let isWither = false;
    let isCrystal = false;

    if (source) {
        const type = source.typeId;
        if (type === "minecraft:tnt" || type === "minecraft:primed_tnt") isTnt = true;
        else if (type === "minecraft:creeper") isCreeper = true;
        else if (type === "minecraft:wither" || type === "minecraft:wither_skull" || type === "minecraft:wither_skull_dangerous") isWither = true;
        else if (type === "minecraft:ender_crystal" || type === "minecraft:end_crystal" || type === "minecraft:respawn_anchor") isCrystal = true;
    }

    const allowTnt = settings.allowTntDamage;
    const allowCreeper = settings.allowCreeperDamage;
    const allowWither = settings.allowWitherDamage;
    const allowCrystal = settings.allowCrystalDamage;
    const allowRaidOnZero = settings.allowRaidOnZeroPower;

    const globalAllow = (isTnt && allowTnt) || (isCreeper && allowCreeper) || (isWither && allowWither) || (isCrystal && allowCrystal);

    // If the specific explosion type is globally allowed, do nothing (let it explode)
    if (globalAllow) return;

    const impactedBlocks = event.getImpactedBlocks();
    const dimensionId = source?.dimension?.id || "minecraft:overworld";
    const safeBlocks = [];
    const factions = getAllFactions(); // Load once for zero-power checks

    for (const block of impactedBlocks) {
        const ownerId = getChunkOwnerAt(block.location, dimensionId);

        if (!ownerId) {
            safeBlocks.push(block); // Wilderness — allow destruction
        } else if (allowRaidOnZero) {
            // Check if the faction owning this block is at 0 power
            const ownerFaction = factions[ownerId];
            if (ownerFaction) {
                const currentPower = calculateFactionPower(ownerFaction);
                if (currentPower <= 0) {
                    safeBlocks.push(block); // Power is 0 or less, let it blow up!
                }
            }
        }
    }

    // If we filtered any out, update the impacted list
    if (safeBlocks.length !== impactedBlocks.length) {
        event.setImpactedBlocks(safeBlocks);
    }
});

// ============================================
// SECTION 9: PASSIVE MOB & EXPLOSION DAMAGE PROTECTION
// ============================================

safeSub(world.beforeEvents?.entityHurt, (event) => {
    const victim = event.hurtEntity;
    const damageSource = event.damageSource;

    if (!victim || !damageSource) return;

    // Check Explosion Player Damage
    if (victim.typeId === "minecraft:player") {
        const cause = damageSource.cause;

        // Catch all forms of explosive damage using official Bedrock EntityDamageCause strings
        if (cause === "entityExplosion" || cause === "blockExplosion") {
            const settings = getProtectionSettings();

            // If player explosion damage is disabled (false), cancel damage if victim is inside ANY claim
            if (!settings.allowExplosionPlayerDamage) {
                const chunkOwnerId = getChunkOwnerAt(victim.location, victim.dimension.id);
                if (chunkOwnerId) {
                    event.cancel = true;
                    return;
                }
            }
        }
    }

    const attacker = damageSource.damagingEntity;
    if (!attacker) return;
    if (attacker.typeId !== "minecraft:player") return;
    if (attacker.hasTag("op")) return;

    if (!PROTECTED_PASSIVE_MOBS.has(victim.typeId)) return;

    const chunkOwnerId = getChunkOwnerAt(victim.location, victim.dimension.id);
    if (!chunkOwnerId) return;

    const playerFactionId = getPlayerFactionId(attacker.id);
    if (playerFactionId === chunkOwnerId) return;

    event.cancel = true;
    const ownerFac = getFactionById(chunkOwnerId);
    const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
    try {
        system.run(() => {
            attacker.sendMessage(`§cYou cannot harm passive mobs in §b${name}§c's territory.`);
        });
    } catch (e) { }
});

// ============================================
// SECTION 10: PLAYER INTERACT WITH ENTITY (Item Frames, Armor Stands, Villagers, Leash)
// ============================================

safeSub(world.beforeEvents?.playerInteractWithEntity, (event) => {
    const player = event.player;
    const target = event.target;

    if (!player || !target) return;
    if (player.hasTag("op")) return;
    if (target.typeId === "minecraft:player") return;

    const chunkOwnerId = getChunkOwnerAt(target.location, target.dimension.id);
    if (!chunkOwnerId) return;

    const playerFactionId = getPlayerFactionId(player.id);
    if (playerFactionId === chunkOwnerId) return;

    const relationship = getRelationship(playerFactionId, chunkOwnerId);

    if (relationship === "ally") {
        const settings = getProtectionSettings();
        if (settings.allowAllyInteract) return;
    }

    const targetId = target.typeId;
    const protectedInteractions = [
        "minecraft:villager", "minecraft:wandering_trader",
        "minecraft:armor_stand", "minecraft:item_frame",
        "minecraft:glow_item_frame", "minecraft:minecart",
        "minecraft:chest_minecart", "minecraft:hopper_minecart",
        "minecraft:boat", "minecraft:chest_boat"
    ];

    if (protectedInteractions.includes(targetId) || PROTECTED_PASSIVE_MOBS.has(targetId)) {
        event.cancel = true;
        const ownerFac = getFactionById(chunkOwnerId);
        const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
        try {
            system.run(() => {
                player.sendMessage(`§cYou cannot interact with this entity in §b${name}§c's territory.`);
            });
        } catch (e) { }
    }
});

// ============================================
// SECTION 11: PROJECTILE PROTECTION (Ender Pearls, Arrows, etc.)
// ============================================

const pearlThrowLocations = new Map();

// 1. Record location when an Ender Pearl is thrown, or block item use inside enemy claims
safeSub(world.beforeEvents?.itemUse, (event) => {
    const player = event.source;
    const itemStack = event.itemStack;
    if (!player || player.typeId !== "minecraft:player" || player.hasTag("op") || !itemStack) return;

    const itemId = itemStack.typeId;

    if (itemId === "minecraft:ender_pearl") {
        // Save throw location in case it hits an enemy claim
        pearlThrowLocations.set(player.id, {
            location: { x: player.location.x, y: player.location.y, z: player.location.z },
            dimension: player.dimension
        });
    }

    // Block throwing pearls or shooting bows while standing INSIDE an enemy claim
    const settings = getProtectionSettings();
    if (settings.blockEnemyProjectiles) {
        const chunkOwnerId = getChunkOwnerAt(player.location, player.dimension.id);
        if (chunkOwnerId) {
            const playerFacId = getPlayerFactionId(player.id);
            if (playerFacId !== chunkOwnerId) {
                const relationship = getRelationship(playerFacId, chunkOwnerId);
                if (relationship !== "ally" || !settings.allowAllyInteract) {
                    if (itemId === "minecraft:ender_pearl" || itemId.includes("bow") || itemId.includes("trident") || itemId === "minecraft:snowball" || itemId === "minecraft:egg") {
                        event.cancel = true;
                        const ownerFac = getFactionById(chunkOwnerId);
                        const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";
                        system.run(() => {
                            player.sendMessage(`§cYou cannot use projectiles inside §b${name}§c's territory.`);
                        });
                    }
                }
            }
        }
    }
});

// 2. Handle projectile impacts inside claims
function handleProjectileHit(location, dimension, sourceEntity, projectile) {
    if (!sourceEntity || sourceEntity.typeId !== "minecraft:player") return;
    if (sourceEntity.hasTag("op")) return;

    const settings = getProtectionSettings();
    if (!settings.blockEnemyProjectiles) return;

    const chunkOwnerId = getChunkOwnerAt(location, dimension.id);
    if (!chunkOwnerId) return; // Wilderness = allowed

    const playerFactionId = getPlayerFactionId(sourceEntity.id);
    if (playerFactionId === chunkOwnerId) return; // Own faction = allowed

    const relationship = getRelationship(playerFactionId, chunkOwnerId);
    if (relationship === "ally" && settings.allowAllyInteract) return;

    // Enemy/Stranger claim hit:
    const isEnderPearl = projectile && projectile.typeId === "minecraft:ender_pearl";

    try {
        if (projectile && projectile.isValid) {
            projectile.remove(); // Despawn projectile immediately
        }

        const ownerFac = getFactionById(chunkOwnerId);
        const name = ownerFac ? `${ownerFac.iconUnicode} ${ownerFac.name}` : "another faction";

        // If it's an Ender Pearl, teleport player BACK to their throw origin
        if (isEnderPearl) {
            const throwData = pearlThrowLocations.get(sourceEntity.id);
            system.run(() => {
                if (throwData && sourceEntity.isValid) {
                    try {
                        sourceEntity.teleport(throwData.location, { dimension: throwData.dimension });
                    } catch (e) { }
                }
                sourceEntity.sendMessage(`§cYou cannot Ender Pearl into §b${name}§c's territory! Teleport blocked.`);
            });
        } else {
            system.run(() => {
                sourceEntity.sendMessage(`§cYou cannot shoot projectiles into §b${name}§c's territory.`);
            });
        }
    } catch (e) { }
}

safeSub(world.afterEvents?.projectileHitBlock, (event) => {
    handleProjectileHit(event.location, event.dimension, event.source, event.projectile);
});

safeSub(world.afterEvents?.projectileHitEntity, (event) => {
    handleProjectileHit(event.location, event.dimension, event.source, event.projectile);
});

// ============================================
// SCRIPT INITIALIZATION
// ============================================

console.log("✅ [FactionsProtection] Loaded — Territory Protection Active");
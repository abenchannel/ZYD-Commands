// scripts/kits.js
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { ItemStack, EquipmentSlot, EnchantmentType, world, system } from "@minecraft/server";
import { getBalance, setBalance } from "./operator/currency.js";

/* -------------------------
   Configuration
   ------------------------- */
const kitCooldowns = {
    wooden: 15 * 60,
    copper: 30 * 60,
    iron: 60 * 60,
    builder_wood: 120 * 60,
    builder_stone: 120 * 60,
    builder_modern: 120 * 60,
    diamond: 240 * 60,
    ocean: 360 * 60,
    crystal_pvp: 480 * 60,
    pvp: 720 * 60,
    elytra: 2880 * 60,
    admin: 480 * 60,
    emergency: 360 * 60
};

const KIT_COSTS_PROP = "zyd:kit_costs_config";
const DEFAULT_KIT_COSTS = {
    wooden: 0,
    copper: 5000,
    iron: 15000,
    builder_wood: 30000,
    builder_stone: 32000,
    builder_modern: 36000,
    diamond: 75000,
    ocean: 200000,
    crystal_pvp: 400000,
    pvp: 600000,
    elytra: 100000000,
    admin: 0,
    emergency: 0
};

let kitCosts = { ...DEFAULT_KIT_COSTS };
const kitTimers = new Map();

function loadKitCosts() {
    try {
        const data = world.getDynamicProperty(KIT_COSTS_PROP);
        if (data && typeof data === "string") {
            const parsed = JSON.parse(data);
            kitCosts = { ...DEFAULT_KIT_COSTS, ...parsed };
            console.log(`[Kits] Loaded custom kit costs successfully.`);
        } else {
            console.log(`[Kits] No saved costs found, using defaults.`);
        }
    } catch (e) {
        console.warn(`[Kits] Error loading kit costs:`, e);
    }
}

function saveKitCosts() {
    try {
        world.setDynamicProperty(KIT_COSTS_PROP, JSON.stringify(kitCosts));
        console.log(`[Kits] Saved custom kit costs successfully!`);
    } catch (e) {
        console.warn(`[Kits] Error saving kit costs:`, e);
    }
}

// Safe initialization using system.run to ensure world properties are fully ready before reading
system.run(() => {
    loadKitCosts();
});

/* -------------------------
   Helpers
   ------------------------- */
function formatMoney(amount) {
    return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function sendStyled(player, text) {
    try { player.sendMessage(text); } catch { }
}

function playConfirmSound(player) {
    try { player.runCommandAsync(`playsound random.levelup @s`); } catch { }
}

function getPlayerMoney(player) {
    return getBalance(player.scoreboardIdentity);
}

function deductPlayerMoney(player, amount) {
    const currentBalance = getBalance(player.scoreboardIdentity);
    if (currentBalance < amount) return false;
    setBalance(player.scoreboardIdentity, currentBalance - amount);
    return true;
}

function isKitUnlocked(player, kit) {
    return player.hasTag(`${kit}_kit`);
}

function getLockStatusText(player, kit) {
    if (kitCosts[kit] === 0) return "§a[Free]";
    if (isKitUnlocked(player, kit)) return "§a[Unlocked]";
    return "§4[Locked]";
}

function getCostDisplay(cost) {
    if (cost === 0) return "§8[Free]";
    return `§7${cost.toLocaleString()} Money`;
}

/* -------------------------
   Show kits menu
   ------------------------- */
export function showKits(player) {
    const currentMoney = getPlayerMoney(player);
    const isOp = player.hasTag("op");

    const form = new ActionFormData()
        .title("§6§lKITS MENU")
        .body(`§7Choose a kit below\n§8---------------------------\n§eYour Money: §f$${formatMoney(currentMoney)}`)
        .button(`§aWooden Set Kit\n${getCostDisplay(kitCosts.wooden)}`, "textures/kits/noob.png")
        .button(`§6Copper Set Kit\n${getLockStatusText(player, "copper")}\n${getCostDisplay(kitCosts.copper)}`, "textures/kits/normal.png")
        .button(`§fIron Set Kit\n${getLockStatusText(player, "iron")}\n${getCostDisplay(kitCosts.iron)}`, "textures/kits/medium.png")
        .button(`§eBuilder Kit (Wood)\n${getLockStatusText(player, "builder_wood")}\n${getCostDisplay(kitCosts.builder_wood)}`, "textures/kits/builder_wood.png")
        .button(`§8Builder Kit (Stone)\n${getLockStatusText(player, "builder_stone")}\n${getCostDisplay(kitCosts.builder_stone)}`, "textures/kits/builder_stone.png")
        .button(`§fBuilder Kit (Modern)\n${getLockStatusText(player, "builder_modern")}\n${getCostDisplay(kitCosts.builder_modern)}`, "textures/kits/builder_modern.png")
        .button(`§bDiamond Set Kit\n${getLockStatusText(player, "diamond")}\n${getCostDisplay(kitCosts.diamond)}`, "textures/kits/pro.png")
        .button(`§3Ocean Kit\n${getLockStatusText(player, "ocean")}\n${getCostDisplay(kitCosts.ocean)}`, "textures/kits/ocean.png")
        .button(`§dCrystal PVP Kit\n${getLockStatusText(player, "crystal_pvp")}\n${getCostDisplay(kitCosts.crystal_pvp)}`, "textures/kits/crystal.png")
        .button(`§cPVP Kit\n${getLockStatusText(player, "pvp")}\n${getCostDisplay(kitCosts.pvp)}`, "textures/kits/pvp.png")
        .button(`§eElytra Kit\n${getLockStatusText(player, "elytra")}\n${getCostDisplay(kitCosts.elytra)}`, "textures/kits/elytra.png")
        .button(`§4Admin Kit\n§8[Admin Only]`, "textures/kits/admin.png")
        .button(`§cEmergency Kit\n${getCostDisplay(kitCosts.emergency)}`, "textures/kits/emergency_food.png");

    if (isOp) {
        form.button("§eEdit Kit Costs\n§8[ OP Exclusive ]", "textures/settings.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        const backIdx = isOp ? 14 : 13;
        if (response.selection === backIdx) {
            import("./menu.js").then(mod => mod.showMenu(player)).catch(() => { });
            return;
        }

        if (isOp && response.selection === 13) {
            showEditKitCosts(player);
            return;
        }

        const kitNames = [
            "wooden", "copper", "iron",
            "builder_wood", "builder_stone", "builder_modern",
            "diamond", "ocean", "crystal_pvp", "pvp", "elytra",
            "admin", "emergency"
        ];
        const kit = kitNames[response.selection];
        showConfirmKit(player, kit);
    });
}

/* -------------------------
   Edit Kit Costs UI (OP/ADMIN)
   ------------------------- */
function showEditKitCosts(player) {
    const form = new ModalFormData()
        .title("§6§lEdit Kit Costs")
        .textField("§aWooden Kit Cost", "0", { defaultValue: String(kitCosts.wooden) })
        .textField("§6Copper Kit Cost", "5000", { defaultValue: String(kitCosts.copper) })
        .textField("§fIron Kit Cost", "15000", { defaultValue: String(kitCosts.iron) })
        .textField("§eBuilder Kit (Wood) Cost", "30000", { defaultValue: String(kitCosts.builder_wood) })
        .textField("§8Builder Kit (Stone) Cost", "32000", { defaultValue: String(kitCosts.builder_stone) })
        .textField("§fBuilder Kit (Modern) Cost", "36000", { defaultValue: String(kitCosts.builder_modern) })
        .textField("§bDiamond Kit Cost", "75000", { defaultValue: String(kitCosts.diamond) })
        .textField("§3Ocean Kit Cost", "200000", { defaultValue: String(kitCosts.ocean) })
        .textField("§dCrystal PVP Kit Cost", "400000", { defaultValue: String(kitCosts.crystal_pvp) })
        .textField("§cPVP Kit Cost", "600000", { defaultValue: String(kitCosts.pvp) })
        .textField("§eElytra Kit Cost", "100000000", { defaultValue: String(kitCosts.elytra) })
        .textField("§4Admin Kit Cost", "0", { defaultValue: String(kitCosts.admin) })
        .textField("§cEmergency Kit Cost", "0", { defaultValue: String(kitCosts.emergency) })
        .submitButton("§aSave Costs");

    system.run(() => {
        form.show(player).then(response => {
            if (response.canceled) {
                showKits(player);
                return;
            }

            const kitKeys = Object.keys(kitCosts);
            let valid = true;
            const newCosts = {};

            for (let i = 0; i < kitKeys.length; i++) {
                const val = parseInt(response.formValues[i]);
                if (isNaN(val) || val < 0) {
                    valid = false;
                    break;
                }
                newCosts[kitKeys[i]] = val;
            }

            if (!valid) {
                player.sendMessage("§cInvalid input! Please enter valid numbers (0 or higher).");
                showEditKitCosts(player);
                return;
            }

            Object.assign(kitCosts, newCosts);
            saveKitCosts();

            player.sendMessage("§a==============================");
            player.sendMessage("§a§lKit Costs Updated Successfully!");
            player.sendMessage("§a==============================");
            playConfirmSound(player);

            showKits(player);
        }).catch(() => {
            player.sendMessage("§cAn error occurred.");
            showKits(player);
        });
    });
}

/* -------------------------
   Confirmation UI
   ------------------------- */
function showConfirmKit(player, kit) {
    if (kit === "admin" && !player.hasTag("admin") && !player.hasTag("op")) {
        const form = new ActionFormData()
            .title("§4Admin Kit")
            .body("§cThis kit is for admin only")
            .button("§cBack");
        form.show(player).then(() => showKits(player));
        return;
    }

    const titleMap = {
        wooden: "Wooden Set Kit", copper: "Copper Set Kit", iron: "Iron Set Kit",
        builder_wood: "Builder Kit (Wood)", builder_stone: "Builder Kit (Stone)", builder_modern: "Builder Kit (Modern)",
        diamond: "Diamond Set Kit", ocean: "Ocean Kit", crystal_pvp: "Crystal PVP Kit",
        pvp: "PVP Kit", elytra: "Elytra Kit", admin: "Admin Kit", emergency: "Emergency Kit"
    };

    const title = titleMap[kit] || kit;
    const form = new ActionFormData().title(`§e§l${title}`);

    let body = "§7Contents:\n§f" + kitContentsText(kit) + "\n\n";
    body += "§8---------------------------\n\n";

    const key = player.name + kit;
    const last = kitTimers.get(key) || 0;
    const cd = kitCooldowns[kit] || 0;
    const now = Date.now() / 1000;

    if (!player.hasTag("op")) {
        if (last > 0 && cd > 0) {
            const elapsed = now - last;
            if (elapsed < cd) {
                body += `§cCooldown remaining: §e${formatDuration(cd - elapsed)}\n\n`;
            } else {
                body += `§aCooldown: §eReady now\n\n`;
            }
        } else if (cd > 0) {
            body += `§aCooldown: §e${formatDuration(cd)}\n\n`;
        }
    } else {
        body += `§bOP DETECTED: §aCooldown bypassed!\n\n`;
    }

    const purchasableKits = Object.keys(kitCosts).filter(k => kitCosts[k] > 0);
    if (purchasableKits.includes(kit) && !isKitUnlocked(player, kit)) {
        const cost = kitCosts[kit];
        const currentMoney = getPlayerMoney(player);
        const canAfford = currentMoney >= cost;
        const color = canAfford ? "§a" : "§c";

        body += `§6STATUS: ${getLockStatusText(player, kit)}\n\n`;

        if (player.hasTag("op")) {
            body += `§bOP DETECTED!\n§aYou can claim this kit for free.\n\n`;
        } else {
            body += `§eCost: ${color}$${formatMoney(cost)}\n`;
            body += `§7Your Balance: §f$${formatMoney(currentMoney)}\n\n`;

            if (!canAfford) {
                body += `§cYOU NEED MORE MONEY TO UNLOCK!\n`;
                body += `§cRequired: §e$${formatMoney(cost - currentMoney)} more\n\n`;
            } else {
                body += `§aYou can afford this kit! Press Confirm to purchase.\n\n`;
            }
        }
    } else if (purchasableKits.includes(kit) && isKitUnlocked(player, kit)) {
        body += `§6STATUS:§r ${getLockStatusText(player, kit)}\n\n`;
        body += `§aThis kit is unlocked! You can claim it with cooldown.\n\n`;
    }

    form.body(body).button("§aConfirm").button("§cBack");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showKits(player);
            return;
        }
        try { player.runCommandAsync(`playsound random.click @s`); } catch { }
        tryGiveKit(player, kit);
    });
}

/* -------------------------
   Purchase / cooldown logic
   ------------------------- */
function tryGiveKit(player, kit) {
    const now = Date.now() / 1000;
    const key = player.name + kit;
    const last = kitTimers.get(key) || 0;
    const cd = kitCooldowns[kit];

    const purchasableKits = Object.keys(kitCosts).filter(k => kitCosts[k] > 0);
    if (purchasableKits.includes(kit) && !isKitUnlocked(player, kit)) {

        if (player.hasTag("op")) {
            sendStyled(player, `§b[OP] §aClaiming kit for free (No permanent unlock tag added).`);
        } else {
            const cost = kitCosts[kit];
            const success = deductPlayerMoney(player, cost);

            if (!success) {
                sendStyled(player, "§cYou don't have enough Money to buy this kit!");
                showKits(player);
                return;
            }

            player.addTag(`${kit}_kit`);
            sendStyled(player, `§a==============================`);
            sendStyled(player, `§aYou have purchased the §e${kit} §akit!`);
            sendStyled(player, `§6Cost: §e-$${formatMoney(cost)}`);
            sendStyled(player, `§a==============================`);
            playConfirmSound(player);
            showKits(player);
            return;
        }
    }

    if (!player.hasTag("op")) {
        if (now - last < cd) {
            const remaining = Math.ceil((cd - (now - last)) / 60);
            sendStyled(player, `§cCooldown active! Wait §e${remaining} §cminutes.`);
            return;
        }
    }

    if (kit === "admin" && !player.hasTag("admin") && !player.hasTag("op")) {
        sendStyled(player, "§cThis kit is for admin only.");
        return;
    }

    giveKitContents(player, kit);
    kitTimers.set(key, now);

    sendStyled(player, "§6==============================");
    if (player.hasTag("op")) {
        sendStyled(player, `§aYou received the §e${kit} §akit! §b[OP Bypass]`);
    } else {
        sendStyled(player, `§aYou received the §e${kit} §akit!`);
    }
    sendStyled(player, "§6Enjoy and play fair!");
    sendStyled(player, "§6==============================");

    playConfirmSound(player);
    try { player.runCommandAsync(`playsound random.fireworks_twinkle @s`); } catch { }
}

/* -------------------------
   Enchantment helper
   ------------------------- */
function createEnchanted(id, amount = 1, enchants = []) {
    const stack = new ItemStack(id, amount);
    try {
        const enchComp = stack.getComponent("minecraft:enchantable");
        if (!enchComp || typeof enchComp.addEnchantment !== "function") return stack;

        for (const e of enchants) {
            try {
                const key = e.name || e.id || "";
                const level = Math.max(1, Math.floor(Number(e.level) || 1));
                const type = new EnchantmentType(key);
                enchComp.addEnchantment({ type: type, level: level });
            } catch (err) {
                console.warn(`[kits] failed to apply enchant ${JSON.stringify(e)} on ${id}:`, err);
            }
        }
    } catch (err) {
        console.warn("[kits] createEnchanted error:", err);
    }
    return stack;
}

/* -------------------------
   BALANCED Give kit contents
   ------------------------- */
function giveKitContents(player, kit) {
    const inv = player.getComponent("minecraft:inventory").container;
    const equippable = player.getComponent("minecraft:equippable");

    function addStack(stack) { inv.addItem(stack); }
    function add(id, amount = 1) { inv.addItem(new ItemStack(id, amount)); }

    function equipStack(slotEnum, stack) {
        if (equippable && typeof equippable.setEquipment === "function") {
            try {
                equippable.setEquipment(slotEnum, stack);
            } catch (err) {
                inv.addItem(stack);
            }
        } else {
            inv.addItem(stack);
        }
    }

    switch (kit) {
        case "wooden": {
            addStack(createEnchanted("minecraft:wooden_sword", 1, [{ name: "unbreaking", level: 1 }]));
            add("minecraft:wooden_axe");
            add("minecraft:wooden_pickaxe");
            add("minecraft:wooden_shovel");
            add("minecraft:bread", 32);
            add("minecraft:torch", 16);
            add("minecraft:water_bucket", 1);
            equipStack(EquipmentSlot.Head, new ItemStack("minecraft:leather_helmet", 1));
            equipStack(EquipmentSlot.Chest, new ItemStack("minecraft:leather_chestplate", 1));
            equipStack(EquipmentSlot.Legs, new ItemStack("minecraft:leather_leggings", 1));
            equipStack(EquipmentSlot.Feet, new ItemStack("minecraft:leather_boots", 1));
            break;
        }

        case "copper": {
            addStack(createEnchanted("minecraft:copper_sword", 1, [{ name: "unbreaking", level: 1 }]));
            add("minecraft:copper_axe");
            add("minecraft:copper_pickaxe");
            add("minecraft:copper_shovel");
            add("minecraft:cooked_chicken", 32);
            add("minecraft:torch", 32);
            add("minecraft:coal", 16);
            add("minecraft:shield", 1);
            equipStack(EquipmentSlot.Head, new ItemStack("minecraft:chainmail_helmet", 1));
            equipStack(EquipmentSlot.Chest, new ItemStack("minecraft:chainmail_chestplate", 1));
            equipStack(EquipmentSlot.Legs, new ItemStack("minecraft:chainmail_leggings", 1));
            equipStack(EquipmentSlot.Feet, new ItemStack("minecraft:chainmail_boots", 1));
            break;
        }

        case "iron": {
            addStack(createEnchanted("minecraft:iron_sword", 1, [{ name: "sharpness", level: 1 }]));
            addStack(createEnchanted("minecraft:iron_pickaxe", 1, [{ name: "efficiency", level: 1 }]));
            addStack(createEnchanted("minecraft:iron_axe", 1, [{ name: "efficiency", level: 1 }]));
            add("minecraft:iron_shovel");
            addStack(createEnchanted("minecraft:bow", 1, [{ name: "power", level: 1 }]));
            add("minecraft:arrow", 64);
            add("minecraft:cooked_beef", 48);
            add("minecraft:shield");
            equipStack(EquipmentSlot.Head, new ItemStack("minecraft:iron_helmet", 1));
            equipStack(EquipmentSlot.Chest, new ItemStack("minecraft:iron_chestplate", 1));
            equipStack(EquipmentSlot.Legs, new ItemStack("minecraft:iron_leggings", 1));
            equipStack(EquipmentSlot.Feet, new ItemStack("minecraft:iron_boots", 1));
            break;
        }

        case "builder_wood": {
            add("minecraft:oak_planks", 64); add("minecraft:oak_planks", 64); add("minecraft:oak_planks", 64);
            add("minecraft:oak_stairs", 64);
            add("minecraft:wooden_door", 2);
            add("minecraft:glass", 16);
            add("minecraft:cobblestone", 64);
            add("minecraft:scaffolding", 64);
            add("minecraft:ladder", 64);
            add("minecraft:torch", 64);
            add("minecraft:crafting_table", 1);
            break;
        }

        case "builder_stone": {
            add("minecraft:stone", 64); add("minecraft:stone", 64); add("minecraft:stone", 64);
            add("minecraft:stone_bricks", 64); add("minecraft:stone_bricks", 64); add("minecraft:stone_bricks", 64);
            add("minecraft:cobblestone", 64);
            add("minecraft:deepslate_bricks", 64);
            add("minecraft:spruce_door", 2);
            add("minecraft:scaffolding", 64);
            add("minecraft:ladder", 64);
            add("minecraft:torch", 64);
            add("minecraft:stonecutter_block", 1);
            add("minecraft:furnace", 3);
            add("minecraft:coal", 16);
            break;
        }

        case "builder_modern": {
            add("minecraft:quartz_block", 64); add("minecraft:quartz_block", 64); add("minecraft:quartz_block", 64); add("minecraft:quartz_block", 64);
            add("minecraft:quartz_pillar", 64); add("minecraft:quartz_pillar", 64);
            add("minecraft:glass", 64);
            add("minecraft:white_concrete", 64);
            add("minecraft:light_gray_concrete", 64);
            add("minecraft:iron_door", 2);
            add("minecraft:scaffolding", 64);
            add("minecraft:ladder", 64);
            add("minecraft:glowstone", 32);
            add("minecraft:stonecutter_block", 1);
            break;
        }

        case "diamond": {
            addStack(createEnchanted("minecraft:diamond_sword", 1, [{ name: "sharpness", level: 2 }]));
            addStack(createEnchanted("minecraft:diamond_pickaxe", 1, [{ name: "efficiency", level: 3 }, { name: "unbreaking", level: 2 }]));
            addStack(createEnchanted("minecraft:diamond_axe", 1, [{ name: "efficiency", level: 2 }]));
            add("minecraft:diamond_shovel");
            add("minecraft:golden_carrot", 32);
            add("minecraft:golden_apple", 2);
            add("minecraft:ender_chest", 1);
            equipStack(EquipmentSlot.Head, createEnchanted("minecraft:diamond_helmet", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Chest, createEnchanted("minecraft:diamond_chestplate", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Legs, createEnchanted("minecraft:diamond_leggings", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Feet, createEnchanted("minecraft:diamond_boots", 1, [{ name: "protection", level: 2 }, { name: "feather_falling", level: 2 }]));
            break;
        }

        case "ocean": {
            addStack(createEnchanted("minecraft:trident", 1, [{ name: "loyalty", level: 3 }]));
            equipStack(EquipmentSlot.Head, createEnchanted("minecraft:turtle_helmet", 1, [{ name: "respiration", level: 3 }, { name: "aqua_affinity", level: 1 }]));
            equipStack(EquipmentSlot.Chest, createEnchanted("minecraft:diamond_chestplate", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Legs, createEnchanted("minecraft:diamond_leggings", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Feet, createEnchanted("minecraft:diamond_boots", 1, [{ name: "depth_strider", level: 3 }, { name: "protection", level: 2 }]));
            add("minecraft:cooked_salmon", 64);
            add("minecraft:golden_carrot", 16);
            add("minecraft:nautilus_shell", 4);
            add("minecraft:heart_of_the_sea", 1);
            break;
        }

        case "crystal_pvp": {
            add("minecraft:netherite_sword");
            add("minecraft:netherite_pickaxe");
            add("minecraft:end_crystal", 64);
            add("minecraft:obsidian", 64);
            add("minecraft:glowstone", 64);
            add("minecraft:respawn_anchor", 16);
            add("minecraft:golden_apple", 16);
            add("minecraft:totem_of_undying", 2);
            equipStack(EquipmentSlot.Head, new ItemStack("minecraft:netherite_helmet", 1));
            equipStack(EquipmentSlot.Chest, new ItemStack("minecraft:netherite_chestplate", 1));
            equipStack(EquipmentSlot.Legs, new ItemStack("minecraft:netherite_leggings", 1));
            equipStack(EquipmentSlot.Feet, new ItemStack("minecraft:netherite_boots", 1));
            break;
        }

        case "pvp": {
            addStack(createEnchanted("minecraft:netherite_sword", 1, [
                { name: "sharpness", level: 3 },
                { name: "unbreaking", level: 2 }
            ]));
            addStack(createEnchanted("minecraft:netherite_axe", 1, [
                { name: "efficiency", level: 3 },
                { name: "unbreaking", level: 2 }
            ]));
            addStack(createEnchanted("minecraft:bow", 1, [
                { name: "power", level: 3 },
                { name: "flame", level: 1 },
                { name: "unbreaking", level: 2 }
            ]));
            add("minecraft:arrow", 128);
            add("minecraft:golden_apple", 8);
            add("minecraft:totem_of_undying", 2);
            equipStack(EquipmentSlot.Head, createEnchanted("minecraft:netherite_helmet", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Chest, createEnchanted("minecraft:netherite_chestplate", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Legs, createEnchanted("minecraft:netherite_leggings", 1, [{ name: "protection", level: 2 }]));
            equipStack(EquipmentSlot.Feet, createEnchanted("minecraft:netherite_boots", 1, [{ name: "protection", level: 2 }, { name: "feather_falling", level: 3 }]));
            break;
        }

        case "elytra": {
            add("minecraft:elytra", 1);
            add("minecraft:firework_rocket", 64);
            break;
        }

        case "admin": {
            addStack(createEnchanted("minecraft:netherite_sword", 1, [
                { name: "sharpness", level: 5 },
                { name: "unbreaking", level: 3 },
                { name: "mending", level: 1 },
                { name: "knockback", level: 2 }
            ]));
            addStack(createEnchanted("minecraft:netherite_pickaxe", 1, [
                { name: "efficiency", level: 5 },
                { name: "unbreaking", level: 3 },
                { name: "mending", level: 1 },
                { name: "silk_touch", level: 1 }
            ]));
            add("minecraft:enchanted_golden_apple", 2);
            add("minecraft:totem_of_undying", 5);
            add("minecraft:shulker_box", 1);
            equipStack(EquipmentSlot.Head, createEnchanted("minecraft:netherite_helmet", 1, [{ name: "protection", level: 4 }, { name: "unbreaking", level: 3 }, { name: "mending", level: 1 }]));
            equipStack(EquipmentSlot.Chest, createEnchanted("minecraft:netherite_chestplate", 1, [{ name: "protection", level: 4 }, { name: "unbreaking", level: 3 }, { name: "mending", level: 1 }]));
            equipStack(EquipmentSlot.Legs, createEnchanted("minecraft:netherite_leggings", 1, [{ name: "protection", level: 4 }, { name: "unbreaking", level: 3 }, { name: "mending", level: 1 }]));
            equipStack(EquipmentSlot.Feet, createEnchanted("minecraft:netherite_boots", 1, [{ name: "protection", level: 4 }, { name: "unbreaking", level: 3 }, { name: "mending", level: 1 }]));
            break;
        }

        case "emergency": {
            add("minecraft:cooked_beef", 64);
            add("minecraft:iron_sword", 1);
            add("minecraft:shield", 1);
            add("minecraft:torch", 16);
            break;
        }

        default:
            break;
    }
}

/* -------------------------
   Kit contents text (No Bold, Detailed)
   ------------------------- */
function kitContentsText(kit) {
    switch (kit) {
        case "wooden":
            return [
                `- 1x Wooden Sword (§dUnbreaking I§f)`,
                `- 1x Wooden Axe, Pickaxe, Shovel`,
                `- Full Leather Armor (equipped)`,
                `- 32x Bread, 16x Torches, 1x Water Bucket`
            ].join("\n");

        case "copper":
            return [
                `- 1x §6Copper Sword§f (§dUnbreaking I§f)`,
                `- 1x §6Copper Axe, Pickaxe, Shovel§f`,
                `- Full Chainmail Armor (equipped)`,
                `- 1x Shield, 32x Cooked Chicken, 32x Torches, 16x Coal`
            ].join("\n");

        case "iron":
            return [
                `- 1x Iron Sword (§dSharpness I§f)`,
                `- 1x Iron Pickaxe & Axe (§dEfficiency I§f)`,
                `- 1x Bow (§dPower I§f) + 64x Arrows`,
                `- Full Iron Armor (equipped)`,
                `- 48x Cooked Beef, 1x Shield`
            ].join("\n");

        case "builder_wood":
            return [
                `- 192x Oak Planks, 64x Oak Stairs, 2x Oak Doors`,
                `- 16x Glass, 64x Cobblestone`,
                `- 64x Scaffolding, 64x Ladders, 64x Torches`,
                `- 1x Crafting Table`
            ].join("\n");

        case "builder_stone":
            return [
                `- 192x Stone, 192x Stone Bricks, 64x Cobblestone`,
                `- 64x Deepslate Bricks, 2x Spruce Doors`,
                `- 64x Scaffolding, 64x Ladders, 64x Torches`,
                `- 1x Stonecutter, 3x Furnaces, 16x Coal`
            ].join("\n");

        case "builder_modern":
            return [
                `- 256x Quartz Blocks, 128x Quartz Pillars`,
                `- 64x Glass, 64x White Concrete, 64x Light Gray Concrete`,
                `- 2x Iron Doors, 64x Scaffolding, 64x Ladders`,
                `- 32x Glowstone, 1x Stonecutter`
            ].join("\n");

        case "diamond":
            return [
                `- 1x §bDiamond Sword§f (§dSharpness II§f)`,
                `- §bDiamond Tools§f (§dEff III / Unbreaking II§f)`,
                `- Full §bDiamond Armor§f (§dProtection II§f, equipped)`,
                `- 32x Golden Carrots, 2x Golden Apples, 1x Ender Chest`
            ].join("\n");

        case "ocean":
            return [
                `- 1x §3Trident§f (§dLoyalty III§f)`,
                `- 1x Turtle Helmet (§dResp III, Aqua Aff I§f)`,
                `- §bDiamond Armor§f (§dDepth Strider III§f, equipped)`,
                `- 64x Cooked Salmon, 16x Golden Carrots`,
                `- 4x Nautilus Shells, 1x Heart of the Sea`
            ].join("\n");

        case "crystal_pvp":
            return [
                `- 1x Netherite Sword (No Enchants - Grind for it!)`,
                `- 1x Netherite Pickaxe`,
                `- 64x End Crystals, 64x Obsidian, 64x Glowstone`,
                `- 16x Respawn Anchors`,
                `- Full Netherite Armor (No Enchants, equipped)`,
                `- 16x Golden Apples, 2x Totems`
            ].join("\n");

        case "pvp":
            return [
                `- 1x Netherite Sword (§dSharpness III§f)`,
                `- 1x Netherite Axe (§dEfficiency III§f)`,
                `- 1x Bow (§dPower III, Flame I§f) + 128x Arrows`,
                `- Full Netherite Armor (§dProtection II§f, equipped)`,
                `- 8x Golden Apples, 2x Totems of Undying`
            ].join("\n");

        case "elytra":
            return [
                `- 1x Elytra (No Enchants)`,
                `- 64x Firework Rockets`
            ].join("\n");

        case "admin":
            return [
                `- 1x Netherite Sword (§dSharp V, Mend, KB II§f)`,
                `- 1x Netherite Pickaxe (§dEff V, Silk, Mend§f)`,
                `- Full Netherite Armor (§dProt IV, Mend§f, equipped)`,
                `- 2x Enchanted Golden Apples, 5x Totems`
            ].join("\n");

        case "emergency":
            return [
                `- 64x Cooked Beef`,
                `- 1x Iron Sword + 1x Shield`,
                `- 16x Torches`
            ].join("\n");

        default:
            return "- (No contents defined)";
    }
}

/* -------------------------
   Utility
   ------------------------- */
function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
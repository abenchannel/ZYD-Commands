// scripts/promocode.js
import { world, ItemStack, system, EnchantmentTypes } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { showMenu } from "./menu.js";
import { getBalance, setBalance } from "./operator/currency.js";

// ═══════════════════════════════════════════════════════════════
// ★ CONSTANTS
// ═══════════════════════════════════════════════════════════════

const PROMO_DATA_PROPERTY = "zyd:promo_codes";
const PROMO_INIT_PROPERTY = "zyd:promo_default_init";
const MONEY_CODE_DATA_PROPERTY = "zyd:money_codes";

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const MAX_MONEY_REWARD = 1000000000; // 1 Billion

// ═══════════════════════════════════════════════════════════════
// ★ UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function formatEncName(enc) {
    const name = enc.id.replace("minecraft:", "").replace(/_/g, " ");
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    const levelStr = ROMAN[enc.level] || String(enc.level);
    return `${capitalized} ${levelStr}`;
}

function enchantsMatch(a, b) {
    const aList = (a || []).map(e => `${e.id}:${e.level}`).sort();
    const bList = (b || []).map(e => `${e.id}:${e.level}`).sort();
    if (aList.length !== bList.length) return false;
    for (let i = 0; i < aList.length; i++) {
        if (aList[i] !== bList[i]) return false;
    }
    return true;
}

function getItemKey(item) {
    let key = item.typeId;
    try {
        const enchantable = item.getComponent("minecraft:enchantable");
        if (enchantable) {
            const enchants = enchantable.getEnchantments();
            if (enchants && enchants.length > 0) {
                const encStr = enchants.map(e => `${e.type.id}:${e.level}`).sort().join(",");
                key += `|${encStr}`;
            }
        }
    } catch (e) { }
    return key;
}

function sanitizeTag(name) {
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

function generateRandomCode(length = 15) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function forceCommas(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ═══════════════════════════════════════════════════════════════
// ★ PERSISTENT STORAGE
// ═══════════════════════════════════════════════════════════════

function getPromoCodes() {
    try { const data = world.getDynamicProperty(PROMO_DATA_PROPERTY); return data ? JSON.parse(data) : {}; } catch (e) { return {}; }
}
function savePromoCodes(codes) {
    try { world.setDynamicProperty(PROMO_DATA_PROPERTY, JSON.stringify(codes)); } catch (e) { console.error("[PROMO] Save error:", e); }
}
function getTempData(player) {
    try { const data = world.getDynamicProperty(`zyd:temp_${player.id}`); return data ? JSON.parse(data) : null; } catch (e) { return null; }
}
function saveTempData(player, temp) {
    try { world.setDynamicProperty(`zyd:temp_${player.id}`, JSON.stringify(temp)); } catch (e) { }
}
function clearTempData(player) {
    try { world.setDynamicProperty(`zyd:temp_${player.id}`, undefined); } catch (e) { }
}
function getMoneyCodes() {
    try { const data = world.getDynamicProperty(MONEY_CODE_DATA_PROPERTY); return data ? JSON.parse(data) : {}; } catch (e) { return {}; }
}
function saveMoneyCodes(codes) {
    try { world.setDynamicProperty(MONEY_CODE_DATA_PROPERTY, JSON.stringify(codes)); } catch (e) { console.error("[MONEY CODE] Save error:", e); }
}

// ═══════════════════════════════════════════════════════════════
// ★ DEFAULT PROMOCODE INITIALIZER
// ═══════════════════════════════════════════════════════════════

function initializeDefaultPromoCode() {
    try {
        if (world.getDynamicProperty(PROMO_INIT_PROPERTY)) return;
        const codes = getPromoCodes();
        if (!codes["2026"]) {
            codes["2026"] = { reward: { type: "mixed", money: 50, items: [] }, active: true, tag: "promo_2026" };
            savePromoCodes(codes);
        }
        world.setDynamicProperty(PROMO_INIT_PROPERTY, true);
    } catch (e) { console.error("[PROMO] Init error:", e); }
}

// ═══════════════════════════════════════════════════════════════
// ★ INVENTORY SCANNER & ITEM DROPDOWN (Per Slot, No Merging)
// ═══════════════════════════════════════════════════════════════

function getInventoryItems(player) {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) return [];

    const items = []; // Changed to array, no longer merging with a Map

    for (let i = 0; i < container.size; i++) {
        const item = container.getItem(i);
        if (!item) continue;

        let enchantments = [];
        try {
            const enchantable = item.getComponent("minecraft:enchantable");
            if (enchantable) {
                for (const enc of enchantable.getEnchantments()) {
                    enchantments.push({ id: enc.type.id, level: enc.level });
                }
            }
        } catch (e) { }

        const baseName = item.typeId.replace("minecraft:", "").replace(/_/g, " ");
        const name = baseName.charAt(0).toUpperCase() + baseName.slice(1);

        // Push every item from every slot individually
        items.push({
            id: item.typeId,
            name: name,
            count: item.amount, // This will be 1 for Totems/Swords, or 16 for Ender Pearls per slot
            enchantments: enchantments
        });
    }

    return items;
}

function buildItemDropdown(player, savedItems) {
    const invItems = getInventoryItems(player);

    const options = [{ display: "Nothing", id: null, count: 0, enchantments: [] }];

    for (const item of invItems) {
        let display = item.name;
        if (item.enchantments.length > 0) {
            display += ` [${item.enchantments.map(e => formatEncName(e)).join(", ")}]`;
        }
        // Only show (xAmount) if the count is more than 1
        if (item.count > 1) {
            display += ` (x${item.count})`;
        }

        options.push({
            display: display,
            id: item.id,
            count: item.count,
            enchantments: item.enchantments
        });
    }

    const defaultIndices = [];

    for (const savedItem of savedItems) {
        if (!savedItem || !savedItem.id) {
            defaultIndices.push(0);
            continue;
        }

        let foundIndex = -1;
        // Find the first matching item in the player's current inventory
        for (let i = 1; i < options.length; i++) {
            if (options[i].id === savedItem.id && enchantsMatch(options[i].enchantments, savedItem.enchantments)) {
                foundIndex = i;
                break;
            }
        }

        if (foundIndex !== -1) {
            defaultIndices.push(foundIndex);
        } else {
            // If not in inventory anymore, show as [Saved]
            let display = `[Saved] ${savedItem.id.replace("minecraft:", "").replace(/_/g, " ")}`;
            if (savedItem.enchantments && savedItem.enchantments.length > 0) {
                display += ` [${savedItem.enchantments.map(e => formatEncName(e)).join(", ")}]`;
            }
            if (savedItem.count > 1) {
                display += ` (x${savedItem.count})`;
            }

            options.push({
                display: display,
                id: savedItem.id,
                count: savedItem.count,
                enchantments: savedItem.enchantments || []
            });

            defaultIndices.push(options.length - 1);
        }
    }

    return {
        options,
        defaultIndices,
        displayNames: options.map(o => o.display)
    };
}

// ═══════════════════════════════════════════════════════════════
// ★ MAIN MENU (With Short Info for both Promo & Money Codes)
// ═══════════════════════════════════════════════════════════════

export function showPromoCode(player) {
    const isOp = player.hasTag("op");
    const form = new ActionFormData()
        .title("§dPromo & Money Codes")
        .body(
            "§eWelcome to the Redemption Center!§r\n\n" +
            "§a§lPromo Code:§r §7Enter a secret code to claim one-time rewards like Money and Items. Can only be used once per player.\n\n" +
            "§b§lMoney Code:§r §7Redeem physical Paper items in your inventory for Money and Items. Can be traded, but may be lost upon death!"
        )
        .button("§aRedeem Promocode", "textures/edit.png")
        .button("§bRedeem Money Code", "textures/name.png");

    if (isOp) {
        form.button("§ePromocode Creation", "textures/mod.png")
            .button("§6Money Code Creation", "textures/mod.png");
    }

    // ✅ ADDED: Back button always visible
    form.button("§cBack", "textures/back.png");

    system.run(() => {
        form.show(player).then(response => {
            if (response.canceled) {
                // ✅ FIX: Go back to menu on cancel/close
                showMenu(player);
                return;
            }

            // Calculate back button index based on OP status
            const backIndex = isOp ? 4 : 2;

            if (response.selection === backIndex) {
                // ✅ Back button pressed
                showMenu(player);
                return;
            }

            if (response.selection === 0) showRedeemForm(player);
            else if (response.selection === 1) showRedeemMoneyCode(player);
            else if (response.selection === 2 && isOp) showPromoCreationMenu(player);
            else if (response.selection === 3 && isOp) showMoneyCodeCreationMenu(player);
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// ★ REDEEM PROMOCODE
// ═══════════════════════════════════════════════════════════════

function showRedeemForm(player) {
    const form = new ModalFormData().title("§dRedeem Promo Code").textField("§7Enter your promo code:", "Case-sensitive");
    system.run(() => {
        form.show(player).then(response => {
            if (response.canceled) return;
            const input = response.formValues[0];
            if (!input || input.trim() === "") { player.sendMessage("§cPlease enter a promo code."); return; }
            const codes = getPromoCodes();
            const code = codes[input];
            if (!code) { player.sendMessage("§cInvalid promo code."); return; }
            if (!code.active) { player.sendMessage("§cThis promo code has expired."); return; }
            const isOp = player.hasTag("op");
            if (player.hasTag(code.tag) && !isOp) { player.sendMessage("§eYou already redeemed this code."); return; }
            if (!isOp) player.addTag(code.tag);

            const moneyAmount = code.reward.money || 0;
            const validItems = (code.reward.items || []).filter(item => item && item.id);
            if (moneyAmount > 0) {
                setBalance(player.scoreboardIdentity, getBalance(player.scoreboardIdentity) + moneyAmount);
            }
            if (validItems.length > 0) {
                const inv = player.getComponent("minecraft:inventory").container;
                for (const item of validItems) {
                    try {
                        const itemStack = new ItemStack(item.id, item.count);
                        if (item.enchantments && item.enchantments.length > 0) {
                            const enchantable = itemStack.getComponent("minecraft:enchantable");
                            if (enchantable) { for (const enc of item.enchantments) { try { const t = EnchantmentTypes.get(enc.id); if (t) enchantable.addEnchantment({ type: t, level: enc.level }); } catch (e) { } } }
                        }
                        inv.addItem(itemStack);
                    } catch (e) { console.error(`Failed to give item ${item.id}`, e); }
                }
            }

            let msg = `§a-------------------------------------------------------\n§a[Promo] Code Redeemed Successfully!\n§a-------------------------------------------------------\n§7Code: §f${input}\n`;
            if (moneyAmount > 0) msg += `§7Money Reward: §a+${forceCommas(moneyAmount)}\n`;
            if (validItems.length > 0) {
                msg += `§7Items Received:\n`;
                for (const item of validItems) {
                    let encString = (item.enchantments && item.enchantments.length > 0) ? ` §e[${item.enchantments.map(e => formatEncName(e)).join(", ")}]` : "";
                    msg += `   §f- ${item.id.replace("minecraft:", "").replace(/_/g, " ")} (x${item.count})${encString}\n`;
                }
            }
            msg += `§a-------------------------------------------------------\n§7Enjoy your rewards!`;
            player.sendMessage(msg);
        });
    });
}

// ═══════════════════════════════════════════════════════════════
// ★ REDEEM MONEY CODE (Ignores Paper Name - Relies purely on Lore)
// ═══════════════════════════════════════════════════════════════

function showRedeemMoneyCode(player) {
    const moneyCodes = getMoneyCodes();
    const inv = player.getComponent("minecraft:inventory").container;
    const foundCodes = new Map();

    for (let i = 0; i < inv.size; i++) {
        const item = inv.getItem(i);
        // Check only if it's a paper and has lore, IGNORE the nameTag completely
        if (!item || item.typeId !== "minecraft:paper") continue;

        const lore = item.getLore();
        if (!lore || lore.length === 0) continue;

        const codeLine = lore.find(l => l.startsWith("§7Code: §8"));
        if (!codeLine) continue; // If no code line in lore, skip

        const codeId = codeLine.replace("§7Code: §8", "");
        const dbData = moneyCodes[codeId];

        if (dbData && dbData.active) {
            if (!foundCodes.has(codeId)) foundCodes.set(codeId, { count: 0, value: dbData.value, name: dbData.name, items: dbData.items || [] });
            foundCodes.get(codeId).count += item.amount;
        }
    }

    if (foundCodes.size === 0) {
        player.sendMessage("§cNo valid or active Money Code found in your inventory!");
        return;
    }

    const entries = Array.from(foundCodes.entries());
    const form = new ModalFormData().title("§bRedeem Money Codes");

    for (const [codeId, data] of entries) {
        // Dropdown Label = Name of the Money Code (from database, not item)
        // Dropdown Options = Value (e.g. $50) and Nothing
        form.dropdown(data.name, ["§e$" + forceCommas(data.value), "Nothing"], { defaultValueIndex: 0 });
        form.slider("Amount", 1, data.count, { valueStep: 1, defaultValue: 1 });
    }

    system.run(() => {
        form.show(player).then(res => {
            if (res.canceled) return;
            let redeemedAny = false;

            for (let i = 0; i < entries.length; i++) {
                const [codeId, data] = entries[i];
                const action = res.formValues[i * 2];
                const amount = res.formValues[(i * 2) + 1];

                if (action === 0) {
                    const success = redeemSpecificMoneyCode(player, codeId, amount);
                    if (success) redeemedAny = true;
                }
            }

            if (!redeemedAny) player.sendMessage("§7No codes were selected for redemption.");
        });
    });
}

function redeemSpecificMoneyCode(player, codeId, amount) {
    const moneyCodes = getMoneyCodes();
    if (!moneyCodes[codeId] || !moneyCodes[codeId].active) {
        player.sendMessage("§cCode became invalid or expired just now!");
        return false;
    }
    const codeData = moneyCodes[codeId];
    const moneyValue = codeData.value * amount;
    const itemRewards = codeData.items || [];
    const inv = player.getComponent("minecraft:inventory").container;

    // === 1. RE-VERIFY INVENTORY COUNT (Lore check only, ignores Name) ===
    let currentCount = 0;
    for (let i = 0; i < inv.size; i++) {
        const item = inv.getItem(i);
        if (!item || item.typeId !== "minecraft:paper") continue;
        const lore = item.getLore();
        if (lore.find(l => l === `§7Code: §8${codeId}`)) {
            currentCount += item.amount;
        }
    }

    if (currentCount < amount) {
        player.sendMessage(`§cYou no longer have enough papers for this code! Found: ${currentCount}, Needed: ${amount}`);
        return false;
    }

    // === 2. CALCULATE INVENTORY SPACE FOR MULTIPLIED ITEMS ===
    let slotsNeeded = 0;
    for (const item of itemRewards) {
        let totalItems = item.count * amount;
        slotsNeeded += Math.ceil(totalItems / 64);
    }

    let slotsFreed = 0;
    let tempCheck = amount;
    for (let i = 0; i < inv.size; i++) {
        if (tempCheck <= 0) break;
        const item = inv.getItem(i);
        if (!item || item.typeId !== "minecraft:paper") continue;
        const lore = item.getLore();
        if (lore.find(l => l === `§7Code: §8${codeId}`)) {
            if (item.amount > tempCheck) {
                tempCheck = 0;
            } else {
                tempCheck -= item.amount;
                slotsFreed++;
            }
        }
    }

    let emptySlots = 0;
    try {
        emptySlots = inv.emptySlotsCount;
        if (typeof emptySlots !== 'number') {
            emptySlots = 0;
            for (let i = 0; i < inv.size; i++) { if (!inv.getItem(i)) emptySlots++; }
        }
    } catch (e) {
        emptySlots = 0;
        for (let i = 0; i < inv.size; i++) { if (!inv.getItem(i)) emptySlots++; }
    }

    if (emptySlots + slotsFreed < slotsNeeded) {
        player.sendMessage("§cYour inventory is full! Please make space for the item rewards before redeeming.");
        return false;
    }

    // === 3. APPLY REWARDS ===

    setBalance(player.scoreboardIdentity, getBalance(player.scoreboardIdentity) + moneyValue);
    if (itemRewards.length > 0) {
        for (const item of itemRewards) {
            try {
                let totalToGive = item.count * amount;
                while (totalToGive > 0) {
                    const giveAmount = Math.min(totalToGive, 64);
                    const itemStack = new ItemStack(item.id, giveAmount);

                    if (item.enchantments && item.enchantments.length > 0) {
                        const enchantable = itemStack.getComponent("minecraft:enchantable");
                        if (enchantable) {
                            for (const enc of item.enchantments) {
                                try {
                                    const encType = EnchantmentTypes.get(enc.id);
                                    if (encType) enchantable.addEnchantment({ type: encType, level: enc.level });
                                } catch (e) { }
                            }
                        }
                    }

                    inv.addItem(itemStack);
                    totalToGive -= giveAmount;
                }
            } catch (e) { console.error(`Failed to give item reward ${item.id}`, e); }
        }
    }

    // === 4. CONSUME PAPER MONEY CODE (Lore check only, ignores Name) ===
    let toRemove = amount;
    for (let i = 0; i < inv.size; i++) {
        if (toRemove <= 0) break;
        const item = inv.getItem(i);
        if (!item || item.typeId !== "minecraft:paper") continue;
        const lore = item.getLore();
        if (lore.find(l => l === `§7Code: §8${codeId}`)) {
            if (item.amount > toRemove) {
                item.amount -= toRemove;
                inv.setItem(i, item);
                toRemove = 0;
            } else {
                toRemove -= item.amount;
                inv.setItem(i, undefined);
            }
        }
    }

    player.sendMessage(`§a-------------------------------------------------------`);
    player.sendMessage(`§a[Money Code] Successfully Redeemed!`);
    player.sendMessage(`§7Value: §e$${forceCommas(moneyValue)}`);
    if (itemRewards.length > 0) player.sendMessage(`§7Item rewards have been added to your inventory.`);
    player.sendMessage(`§a-------------------------------------------------------`);

    return true;
}

// ═══════════════════════════════════════════════════════════════
// ★ PROMOCODE CREATION MENU & FORMS
// ═══════════════════════════════════════════════════════════════

function showPromoCreationMenu(player) {
    const form = new ActionFormData().title("§ePromocode Creation").body("§7Manage and create promo codes.")
        .button("§ePromocode List", "textures/list.png")
        .button("§aCreate Promocode", "textures/add.png")
        .button("§cBack", "textures/back.png");
    system.run(() => { form.show(player).then(res => { if (res.canceled) return; if (res.selection === 0) showPromoList(player); else if (res.selection === 1) { clearTempData(player); showCreatePromoForm(player); } else showPromoCode(player); }); });
}

function showPromoList(player) {
    const codes = getPromoCodes(); const e = Object.entries(codes);
    const form = new ActionFormData().title("§ePromocode List").body(e.length === 0 ? "§8No promo codes yet." : `§7Total: §e${e.length}`);
    if (e.length === 0) form.button("§cBack", "textures/back.png"); else { for (const [n, d] of e) form.button(`§e${n} §7[${d.active ? "§2Active" : "§cExpired"}§7]`); form.button("§cBack", "textures/back.png"); }
    system.run(() => { form.show(player).then(res => { if (res.canceled) return; const idx = e.length === 0 ? 0 : res.selection; if (idx === e.length) showPromoCreationMenu(player); else showPromoManage(player, e[idx][0]); }); });
}

function showPromoManage(player, codeName) {
    const codes = getPromoCodes(); const c = codes[codeName]; if (!c) { player.sendMessage("§cCode gone."); showPromoList(player); return; }
    let rText = ""; const m = c.reward.money || 0; const items = c.reward.items || [];
    if (m > 0) rText += `§a${forceCommas(m)} Money\n`;
    if (items.length > 0) { rText += `§bItems:\n`; for (const i of items) { let d = `  §f${i.id.replace("minecraft:", "").replace(/_/g, " ")} (x${i.count})`; if (i.enchantments && i.enchantments.length > 0) d += `\n  §e[${i.enchantments.map(e => formatEncName(e)).join(", ")}]`; rText += d + "\n"; } }
    if (!rText) rText = "§8None\n";
    const form = new ActionFormData().title(`§eManage: ${codeName}`).body(`§7Code: §e${codeName}\n§7Tag: §8${c.tag}\n§7Status: ${c.active ? "§2Active" : "§cExpired"}\n\n§6Rewards:\n${rText}`)
        .button(c.active ? "§cTurn OFF" : "§aTurn ON").button("§6Edit").button("§4Delete").button("§cBack");
    system.run(() => { form.show(player).then(res => { if (res.canceled) return; if (res.selection === 0) { codes[codeName].active = !codes[codeName].active; savePromoCodes(codes); showPromoManage(player, codeName); } else if (res.selection === 1) startEditPromoForm(player, codeName); else if (res.selection === 2) confirmDeletePromo(player, codeName); else showPromoList(player); }); });
}

function confirmDeletePromo(player, codeName) {
    const form = new MessageFormData().title("§4Delete?").body(`§cDelete §e${codeName}§c permanently?`).button1("§cYes").button2("§7No");
    system.run(() => { form.show(player).then(res => { if (res.canceled || res.selection === 1) { showPromoManage(player, codeName); return; } const c = getPromoCodes(); delete c[codeName]; savePromoCodes(c); player.sendMessage("§cDeleted."); showPromoList(player); }); });
}

function startEditPromoForm(player, codeName) {
    const codes = getPromoCodes(); const c = codes[codeName]; if (!c) return;
    const temp = { type: "promo", code: codeName, money: String(c.reward.money || 0), selectedItems: (c.reward.items || []).map(i => ({ ...i })), itemSlots: Math.max(5, (c.reward.items || []).length), editMode: true, originalCodeName: codeName };
    while (temp.selectedItems.length < temp.itemSlots) temp.selectedItems.push(null);
    saveTempData(player, temp); showCreatePromoForm(player);
}

function showCreatePromoForm(player) {
    let temp = getTempData(player); if (!temp || temp.type !== "promo") temp = { type: "promo", code: "", money: "0", selectedItems: new Array(5).fill(null), itemSlots: 5, editMode: false, originalCodeName: null };
    const savedItems = temp.selectedItems || new Array(temp.itemSlots).fill(null);
    const { options, defaultIndices, displayNames } = buildItemDropdown(player, savedItems);
    const form = new ModalFormData().title(temp.editMode ? `§6Edit: ${temp.originalCodeName}` : "§aCreate Promocode")
        .textField("§7Promocode Set:", "e.g. SUMMER2024", { defaultValue: temp.code })
        .textField("§7Set Money Reward:", "0", { defaultValue: temp.money });
    for (let i = 0; i < temp.itemSlots; i++) form.dropdown(`§7Item Reward ${i + 1}`, displayNames, { defaultValueIndex: (i < defaultIndices.length) ? defaultIndices[i] : 0 });
    form.dropdown("§eAction", ["§aSubmit", "§bAdd 3 More Items"], { defaultValueIndex: 0 });

    system.run(() => {
        form.show(player).then(res => {
            if (res.canceled) { clearTempData(player); return; } const nCode = res.formValues[0], nMoney = res.formValues[1]; const nItems = [];
            for (let i = 0; i < temp.itemSlots; i++) { const idx = res.formValues[2 + i]; if (idx > 0 && idx < options.length) nItems.push({ id: options[idx].id, count: options[idx].count, enchantments: options[idx].enchantments }); else nItems.push(null); }
            const action = res.formValues[2 + temp.itemSlots]; temp.code = nCode; temp.money = nMoney; temp.selectedItems = nItems;
            if (action === 1) { temp.itemSlots += 3; nItems.push(null, null, null); saveTempData(player, temp); showCreatePromoForm(player); } else handleSubmitPromo(player, temp);
        });
    });
}

function handleSubmitPromo(player, temp) {
    const codes = getPromoCodes(); if (!temp.code || temp.code.trim() === "") { player.sendMessage("§cName cannot be empty!"); saveTempData(player, temp); showCreatePromoForm(player); return; }
    let isActive = true; if (temp.editMode && codes[temp.originalCodeName]) isActive = codes[temp.originalCodeName].active;
    if (temp.editMode) delete codes[temp.originalCodeName];
    if (codes[temp.code]) { player.sendMessage("§cAlready exists!"); saveTempData(player, temp); showCreatePromoForm(player); return; }
    let m = parseInt(temp.money) || 0; if (m < 0) m = 0; if (m > MAX_MONEY_REWARD) m = MAX_MONEY_REWARD;
    const rItems = []; for (const s of temp.selectedItems) if (s && s.id) rItems.push({ id: s.id, count: s.count, enchantments: s.enchantments || [] });
    codes[temp.code] = { reward: { type: "mixed", money: m, items: rItems }, active: isActive, tag: `promo_${sanitizeTag(temp.code)}` };
    savePromoCodes(codes); clearTempData(player); player.sendMessage(`§aPromo ${temp.code} saved!`); showPromoCreationMenu(player);
}

// ═══════════════════════════════════════════════════════════════
// ★ MONEY CODE CREATION MENU & FORMS
// ═══════════════════════════════════════════════════════════════

function showMoneyCodeCreationMenu(player) {
    const form = new ActionFormData().title("§6Money Code Creation").body("§7Create physical paper items that hold monetary value and item rewards.")
        .button("§bMoney Code List", "textures/list.png")
        .button("§aCreate Money Code", "textures/add.png")
        .button("§cBack", "textures/back.png");
    system.run(() => { form.show(player).then(res => { if (res.canceled) return; if (res.selection === 0) showMoneyCodeList(player); else if (res.selection === 1) { clearTempData(player); showCreateMoneyCodeForm(player); } else showPromoCode(player); }); });
}

function showMoneyCodeList(player) {
    const codes = getMoneyCodes(); const e = Object.entries(codes);
    const form = new ActionFormData().title("§bMoney Code List").body(e.length === 0 ? "§8No money codes yet." : `§7Total: §e${e.length}`);
    if (e.length === 0) {
        form.button("§cBack", "textures/back.png");
    } else {
        for (const [n, d] of e) {
            // Show Exact Name as main text, Value and Status as subtext
            form.button(`${d.name}\n§cValue: §a$${forceCommas(d.value)} §7| ${d.active ? "§2Active" : "§cExpired"}`);
        }
        form.button("§cBack", "textures/back.png");
    }
    system.run(() => { form.show(player).then(res => { if (res.canceled) return; const idx = e.length === 0 ? 0 : res.selection; if (idx === e.length) showMoneyCodeCreationMenu(player); else showMoneyCodeManage(player, e[idx][0]); }); });
}

function showMoneyCodeManage(player, codeId) {
    const codes = getMoneyCodes(); const c = codes[codeId]; if (!c) { player.sendMessage("§cCode gone."); showMoneyCodeList(player); return; }
    let rText = `§7Value: §a$${forceCommas(c.value)}\n`; const items = c.items || [];
    if (items.length > 0) { rText += `§bItem Rewards:\n`; for (const i of items) { let d = `  §f${i.id.replace("minecraft:", "").replace(/_/g, " ")} (x${i.count})`; if (i.enchantments && i.enchantments.length > 0) d += `\n  §e[${i.enchantments.map(e => formatEncName(e)).join(", ")}]`; rText += d + "\n"; } }

    const form = new ActionFormData().title("§eManage Money Code").body(`§7Code ID: §8${codeId}\n§7Name: ${c.name}\n§7Status: ${c.active ? "§2Active" : "§cExpired"}\n\n${rText}`)
        .button(c.active ? "§cExpire Code" : "§aActivate Code").button("§6Edit Money Code").button("§bGet this Money Code").button("§4Delete Money Code").button("§cBack");
    system.run(() => {
        form.show(player).then(res => {
            if (res.canceled) return;
            if (res.selection === 0) { codes[codeId].active = !codes[codeId].active; saveMoneyCodes(codes); showMoneyCodeManage(player, codeId); }
            else if (res.selection === 1) startEditMoneyCodeForm(player, codeId);
            else if (res.selection === 2) showGetMoneyCodeSlider(player, codeId);
            else if (res.selection === 3) confirmDeleteMoneyCode(player, codeId);
            else showMoneyCodeList(player);
        });
    });
}

function showGetMoneyCodeSlider(player, codeId) {
    const codes = getMoneyCodes(); const c = codes[codeId]; if (!c) return;
    const form = new ModalFormData().title("§bGet Money Code").slider("§r§7Amount of Papers", 1, 64, { valueStep: 1, defaultValue: 1 });
    system.run(() => {
        form.show(player).then(res => {
            if (res.canceled) return; const amt = res.formValues[0]; const inv = player.getComponent("minecraft:inventory").container;
            const itemStack = new ItemStack("minecraft:paper", amt);
            itemStack.nameTag = c.name;
            itemStack.setLore([
                `§7Value: §e$${forceCommas(c.value)}`,
                `§7Code: §8${codeId}`,
                "", // Space before instructions
                `§fDo /menu go to promocode§r`,
                `§fand click Redeem Money Code.§r`,
                `§cRedeem immediately! May be lost§r`,
                `§cupon death or if code expires.§r`
            ]);
            inv.addItem(itemStack); player.sendMessage(`§aReceived §e${amt}§a Money Code Paper(s).`);
        });
    });
}

function confirmDeleteMoneyCode(player, codeId) {
    const form = new MessageFormData().title("§4Delete?").body(`§cDelete this Money Code permanently?\n\n§8ID: ${codeId}`).button1("§cYes").button2("§7No");
    system.run(() => { form.show(player).then(res => { if (res.canceled || res.selection === 1) { showMoneyCodeManage(player, codeId); return; } const c = getMoneyCodes(); delete c[codeId]; saveMoneyCodes(c); player.sendMessage("§cDeleted."); showMoneyCodeList(player); }); });
}

function startEditMoneyCodeForm(player, codeId) {
    const codes = getMoneyCodes(); const c = codes[codeId]; if (!c) return;
    const temp = { type: "money", codeId: codeId, name: c.name, value: String(c.value), selectedItems: (c.items || []).map(i => ({ ...i })), itemSlots: Math.max(5, (c.items || []).length), editMode: true };
    while (temp.selectedItems.length < temp.itemSlots) temp.selectedItems.push(null);
    saveTempData(player, temp); showCreateMoneyCodeForm(player);
}

function showCreateMoneyCodeForm(player) {
    let temp = getTempData(player); if (!temp || temp.type !== "money") temp = { type: "money", codeId: null, name: "", value: "", selectedItems: new Array(5).fill(null), itemSlots: 5, editMode: false };
    const savedItems = temp.selectedItems || new Array(temp.itemSlots).fill(null);
    const { options, defaultIndices, displayNames } = buildItemDropdown(player, savedItems);
    const form = new ModalFormData().title(temp.editMode ? `§6Edit: ${temp.codeId}` : "§aCreate Money Code")
        .textField("§7Paper Name:\nLeave blank to default to: §a§lMoney Code: §e<Value>§r", "Name...", { defaultValue: temp.name })
        .textField("§7Value (Money Amount):", "e.g. 500", { defaultValue: temp.value });
    for (let i = 0; i < temp.itemSlots; i++) form.dropdown(`§7Item Reward ${i + 1}`, displayNames, { defaultValueIndex: (i < defaultIndices.length) ? defaultIndices[i] : 0 });
    form.dropdown("§eAction", ["§aSubmit", "§bAdd 3 More Items"], { defaultValueIndex: 0 });

    system.run(() => {
        form.show(player).then(res => {
            if (res.canceled) { clearTempData(player); return; } const nName = res.formValues[0], nVal = res.formValues[1]; const nItems = [];
            for (let i = 0; i < temp.itemSlots; i++) { const idx = res.formValues[2 + i]; if (idx > 0 && idx < options.length) nItems.push({ id: options[idx].id, count: options[idx].count, enchantments: options[idx].enchantments }); else nItems.push(null); }
            const action = res.formValues[2 + temp.itemSlots]; temp.name = nName; temp.value = nVal; temp.selectedItems = nItems;
            if (action === 1) { temp.itemSlots += 3; nItems.push(null, null, null); saveTempData(player, temp); showCreateMoneyCodeForm(player); } else handleSubmitMoneyCode(player, temp);
        });
    });
}

function handleSubmitMoneyCode(player, temp) {
    let value = parseInt(temp.value); if (isNaN(value) || value <= 0) { player.sendMessage("§cInvalid value!"); saveTempData(player, temp); showCreateMoneyCodeForm(player); return; }
    if (value > MAX_MONEY_REWARD) value = MAX_MONEY_REWARD;
    const paperName = (temp.name && temp.name.trim() !== "") ? temp.name : `§a§lMoney Code: §e${forceCommas(value)}§r`;
    const rItems = []; for (const s of temp.selectedItems) if (s && s.id) rItems.push({ id: s.id, count: s.count, enchantments: s.enchantments || [] });
    const codes = getMoneyCodes();

    if (temp.editMode && temp.codeId) {
        codes[temp.codeId].value = value;
        codes[temp.codeId].name = paperName;
        codes[temp.codeId].items = rItems;
        saveMoneyCodes(codes); clearTempData(player); player.sendMessage(`§aMoney Code updated!`); showMoneyCodeManage(player, temp.codeId);
    } else {
        let id = generateRandomCode(15); while (codes[id]) id = generateRandomCode(15);
        codes[id] = { name: paperName, value: value, items: rItems, active: true };
        saveMoneyCodes(codes); clearTempData(player); player.sendMessage(`§aMoney Code created! ID: §8${id}`); showMoneyCodeCreationMenu(player);
    }
}

// ═══════════════════════════════════════════════════════════════
// ★ INITIALIZE ON LOAD
// ═══════════════════════════════════════════════════════════════

system.run(() => { initializeDefaultPromoCode(); });
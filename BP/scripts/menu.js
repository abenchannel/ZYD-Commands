// scripts/menu.js
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { showWarpsEdit } from "./operator/warpsedit.js";
import { getWarps, getWarpSettings } from "./data/warpsdata.js";
import { system, world, DisplaySlotId, ObjectiveSortOrder } from "@minecraft/server";
import { showAdminPanel } from "./admin/admin.js";
import { showTeleport } from "./teleport.js";
import { showKits } from "./kits.js";
import { showPromoCode } from "./promocode.js";
import { showScoreboardMenu } from "./operator/scoreboard.js";
import { showDailyRewards } from "./daily.js";
import { showReportMenu } from "./report.js";
import { showRanks, getActiveNickDisplay } from "./ranks.js";
import { getCurrencyObjective, setCurrencyObjective, getBalance, setBalance } from "./operator/currency.js";
import { showFactionsMainUI } from "./factionsCore.js";

const teleportLocks = new Map();
const lastHitMap = new Map();

// ============================================
// BOUNTY HELPERS
// ============================================

const BOUNTY_MAX = 1000000000; // 1 Billion
const BOUNTY_BELOWNAME_KEY = "zyd:bounty_belowname";

function formatBountyNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function getShortBountyLabel(num) {
    if (num >= BOUNTY_MAX) return "MAX";
    if (num >= 1000000000) return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + "B";
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + "M";
    if (num >= 10000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + "K";
    return num.toString();
}

function getPlayerNickName(playerId) {
    try {
        const onlinePlayer = world.getAllPlayers().find(p => p.id === playerId);
        if (onlinePlayer) {
            const nick = getActiveNickDisplay(onlinePlayer).replace(/§./g, "").trim();
            if (nick && nick.length > 0 && nick !== onlinePlayer.name) return nick;
        }
    } catch (e) { }
    const tracked = knownPlayers.get(playerId);
    if (tracked && tracked.name) return tracked.name;
    return null;
}

function getPlayerNickNameColored(playerId) {
    try {
        const onlinePlayer = world.getAllPlayers().find(p => p.id === playerId);
        if (onlinePlayer) {
            const nick = getActiveNickDisplay(onlinePlayer);
            if (nick && nick.trim().length > 0) return nick.trim();
        }
    } catch (e) { }
    const tracked = knownPlayers.get(playerId);
    if (tracked && tracked.name) return tracked.name;
    return null;
}

function isBountyBelowNameEnabled() {
    try {
        return world.getDynamicProperty(BOUNTY_BELOWNAME_KEY) === true;
    } catch (e) { return false; }
}

function setBountyBelowName(enabled) {
    try {
        world.setDynamicProperty(BOUNTY_BELOWNAME_KEY, enabled);
        const bountyObj = world.scoreboard.getObjective("Bounty");
        if (enabled && bountyObj) {
            world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.BelowName, { objective: bountyObj, sortOrder: ObjectiveSortOrder.Descending });
        } else {
            world.scoreboard.clearObjectiveAtDisplaySlot(DisplaySlotId.BelowName);
        }
    } catch (e) { console.warn("[Bounty BelowName] Error:", e); }
}

// ============================================
// SIMPLE PLAYER LIST TRACKER
// ============================================

const knownPlayers = new Map();
let isLoaded = false;

function loadData() {
    if (isLoaded) return;
    try {
        const data = world.getDynamicProperty("simpleplayerlist");
        if (data) {
            const parsed = JSON.parse(data);
            Object.entries(parsed).forEach(([id, info]) => {
                knownPlayers.set(id, info);
            });
        }
        isLoaded = true;
    } catch (e) { }
}

function saveData() {
    try {
        const obj = {};
        knownPlayers.forEach((val, key) => {
            obj[key] = val;
        });
        world.setDynamicProperty("simpleplayerlist", JSON.stringify(obj));
    } catch (e) { }
}

world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) {
        const p = event.player;
        loadData();
        knownPlayers.set(p.id, { name: p.name, isOnline: true });
        saveData();
    }
});

world.afterEvents.playerLeave.subscribe((event) => {
    const data = knownPlayers.get(event.playerId);
    if (data) {
        data.isOnline = false;
        saveData();
    }
});

system.runTimeout(() => { loadData(); }, 100);

// === [INITIALIZE BOUNTY SCOREBOARD] ===
system.run(() => {
    try {
        if (!world.scoreboard.getObjective("Bounty")) {
            world.scoreboard.addObjective("Bounty", "Bounty");
        }
        // Restore BelowName if previously enabled
        if (isBountyBelowNameEnabled()) {
            const bountyObj = world.scoreboard.getObjective("Bounty");
            if (bountyObj) {
                world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.BelowName, { objective: bountyObj });
            }
        }
    } catch (e) { }
});

// === [LAST HIT & BOUNTY DEATH EVENTS] ===
world.afterEvents.entityHitEntity.subscribe((event) => {
    if (event.damagingEntity && event.damagingEntity.typeId === "minecraft:player") {
        lastHitMap.set(event.hitEntity.id, event.damagingEntity.id);
        system.runTimeout(() => { lastHitMap.delete(event.hitEntity.id); }, 200);
    }
});

world.afterEvents.entityDie.subscribe((event) => {
    const deadEntity = event.deadEntity;
    if (deadEntity.typeId !== "minecraft:player") return;

    const bountyObj = world.scoreboard.getObjective("Bounty");
    if (!bountyObj) return;

    let bountyScore = 0;
    try { bountyScore = bountyObj.getScore(deadEntity.scoreboardIdentity) || 0; } catch (e) { }

    if (bountyScore <= 0) { lastHitMap.delete(deadEntity.id); return; }

    const killerId = lastHitMap.get(deadEntity.id);
    lastHitMap.delete(deadEntity.id);
    if (!killerId) return;

    const killer = world.getAllPlayers().find(p => p.id === killerId);
    if (!killer) return;

    let killerMoney = getBalance(killer.scoreboardIdentity);
    setBalance(killer.scoreboardIdentity, killerMoney + bountyScore);

    try { bountyObj.removeParticipant(deadEntity.scoreboardIdentity); } catch (err) {
        try { bountyObj.setScore(deadEntity.scoreboardIdentity, 0); } catch (e) { }
    }

    const deadNick = getPlayerNickNameColored(deadEntity.id) || deadEntity.nameTag;
    const killerNick = getPlayerNickNameColored(killer.id) || killer.nameTag;
    killer.sendMessage(`§aYou claimed the bounty on §e${deadNick} §afor §6$${formatBountyNumber(bountyScore)}§a!`);
    try { deadEntity.sendMessage(`§cYour bounty of §6$${formatBountyNumber(bountyScore)} §cwas claimed by §e${killerNick}§c!`); } catch (e) { }
    world.sendMessage(`§6[BOUNTY] §e${killerNick} §ahas claimed the bounty on §c${deadNick} §afor §6$${formatBountyNumber(bountyScore)}§a!`);
});

// === [MAIN MENU FUNCTION] ===
export function showMenu(player) {
    let descText = "§dWelcome to ZYD Menu §f" + player.nameTag + "\n\n§7Description:\n";
    if (isFeatureEnabled("warps")) descText += "§bWarps§f - Quickly travel to important areas.\n";
    if (isFeatureEnabled("teleport")) descText += "§aTeleport§f - Move instantly to saved locations.\n";
    if (isFeatureEnabled("factions")) descText += "§6Factions§f - Create and manage factions.\n";
    if (isFeatureEnabled("sethome")) descText += "§dSet Home§f - Save your home location.\n";
    if (isFeatureEnabled("kits")) descText += "§eStarter Kits§f - Claim beginner gear and items.\n";
    if (isFeatureEnabled("ranks")) descText += "§6Ranks§f - Grind PvP kills to rank up & unlock exclusive commands!\n";
    if (isFeatureEnabled("bounty")) descText += "§aBounty§f - Hunt targets for money.\n";
    if (isFeatureEnabled("sendmoney")) descText += "§eSend Money§f - Transfer money to players.\n";
    if (isFeatureEnabled("promocode")) descText += "§dPromo Codes§f - Redeem special rewards.\n";
    if (isFeatureEnabled("daily")) descText += "§6Daily Rewards§f - Claim daily login bonus.\n";
    if (isFeatureEnabled("report")) descText += "§cReport§f - Report players to moderators.\n";
    descText += "\n§7Version: 4";

    const form = new ActionFormData()
        .title("ZYD Main Menu")
        .body(descText);

    if (isFeatureEnabled("warps")) form.button("§l§b< Warps >§r\n§f[ Click to View ]", "textures/warps/warps.png");
    if (isFeatureEnabled("teleport")) form.button("§l§a< Teleport >§r\n§f[ Click to Teleport ]", "textures/teleport/teleport.png");
    if (isFeatureEnabled("factions")) form.button("§l§6< Factions >§r\n§f[ Create & Manage ]", "textures/factions/faction.png");
    if (isFeatureEnabled("sethome")) form.button("§l§d< Set Home >§r\n§f[ Save Location ]", "textures/random/claim_10.png");
    if (isFeatureEnabled("kits")) form.button("§l§e< Starter Kits >§r\n§f[ Claim Items ]", "textures/kits/kits.png");
    if (isFeatureEnabled("ranks")) form.button("§l§6< Ranks >§r\n§f[ View Rank ]", "textures/duels/duels.png");
    if (isFeatureEnabled("bounty")) form.button("§l§a< Bounty >§r\n§f[ Claim Hits ]", "textures/rank_colours/green.png");
    if (isFeatureEnabled("sendmoney")) form.button("§l§e< Send Money >§r\n§f[ Transfer Money ]", "textures/money.png");
    if (isFeatureEnabled("promocode")) form.button("§l§d< Promo Codes >§r\n§f[ Redeem Rewards ]", "textures/promocode.png");
    if (isFeatureEnabled("daily")) form.button("§l§6< Daily Rewards >§r\n§f[ Claim Bonus ]", "textures/timer.png");
    if (isFeatureEnabled("report")) form.button("§l§c< Report to Mods >§r\n§f[ Report a Player ]", "textures/down_vote.png");

    if (player.hasTag("admin") || player.hasTag("op")) {
        form.button("§l§6< Admin Panel >§r\n§f[ Admin Exclusive ]", "textures/admin/admin.png");
    }

    if (player.hasTag("op")) {
        form.button("§l§c< Operator Panel >§r\n§f[ OP Exclusive ]", "textures/operator/operator.png");
    }

    form.button("§cExit", "textures/exit.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        const menuActions = [];

        if (isFeatureEnabled("warps")) menuActions.push(() => showWarpsMenu(player));
        if (isFeatureEnabled("teleport")) menuActions.push(() => showTeleport(player));
        if (isFeatureEnabled("factions")) menuActions.push(() => showFactionsMainUI(player));
        if (isFeatureEnabled("sethome")) menuActions.push(() => {
            import("./sethome.js").then(mod => {
                if (typeof mod.showSetHome === "function") mod.showSetHome(player);
            }).catch(err => { player.sendMessage("§cSetHome module not found!"); });
        });
        if (isFeatureEnabled("kits")) menuActions.push(() => showKits(player));
        if (isFeatureEnabled("ranks")) menuActions.push(() => showRanks(player));
        if (isFeatureEnabled("bounty")) menuActions.push(() => showBountyList(player));
        if (isFeatureEnabled("sendmoney")) menuActions.push(() => showSendMoney(player));
        if (isFeatureEnabled("promocode")) menuActions.push(() => showPromoCode(player));
        if (isFeatureEnabled("daily")) menuActions.push(() => showDailyRewards(player));
        if (isFeatureEnabled("report")) menuActions.push(() => showReportMenu(player));

        if (player.hasTag("admin") || player.hasTag("op")) menuActions.push(() => showAdminPanel(player));
        if (player.hasTag("op")) menuActions.push(() => showOperatorPanel(player));
        menuActions.push(() => player.sendMessage("§7Closed ZYD Menu."));

        if (response.selection >= 0 && response.selection < menuActions.length) {
            menuActions[response.selection]();
        }
    });
}

// === [BOUNTY LIST] ===
export function showBountyList(player) {
    loadData();

    const bountyObj = world.scoreboard.getObjective("Bounty");
    if (!bountyObj) {
        player.sendMessage("§cBounty system is not available.");
        showMenu(player);
        return;
    }

    const onlineNow = world.getAllPlayers();
    const onlineIds = new Set(onlineNow.map(p => p.id));
    const participants = [];

    const rawParticipants = bountyObj.getParticipants();

    for (let idx = 0; idx < rawParticipants.length; idx++) {
        const p = rawParticipants[idx];

        let score = 0;
        try { score = bountyObj.getScore(p) || 0; } catch (e) { }
        if (score <= 0) continue;

        let playerName = null;
        let isOnline = false;
        let isSelf = false;
        const entryId = p.id || "";
        const displayName = p.displayName || "";

        if (entryId && knownPlayers.has(entryId)) {
            const tracked = knownPlayers.get(entryId);
            playerName = tracked.name;
            isOnline = onlineIds.has(entryId);
        }

        if (!playerName && displayName) {
            const cleanDisplay = displayName.replace(/§./g, "").trim();
            if (cleanDisplay && cleanDisplay.indexOf("commands.scoreboard") === -1 && cleanDisplay.indexOf("offlinePlayer") === -1 && cleanDisplay !== "*" && cleanDisplay.length <= 30) {
                knownPlayers.forEach((data, uuid) => {
                    if (!playerName && data.name === cleanDisplay) {
                        playerName = data.name;
                        isOnline = onlineIds.has(uuid);
                    }
                });
            }
        }

        if (!playerName && score > 0) {
            const candidates = [];
            knownPlayers.forEach((data, uuid) => {
                if (uuid !== player.id) candidates.push({ uuid: uuid, name: data.name, isOnline: onlineIds.has(uuid) });
            });

            if (candidates.length === 1) {
                playerName = candidates[0].name;
                isOnline = candidates[0].isOnline;
            } else if (candidates.length > 1) {
                const offlineCandidates = candidates.filter(c => !c.isOnline);
                if (offlineCandidates.length === 1) {
                    playerName = offlineCandidates[0].name;
                    isOnline = false;
                } else {
                    playerName = candidates[0].name;
                    isOnline = candidates[0].isOnline;
                }
            }
        }

        if (!playerName && entryId && onlineIds.has(entryId)) {
            const foundPlayer = onlineNow.find(op => op.id === entryId);
            if (foundPlayer) {
                playerName = foundPlayer.name;
                isOnline = true;
                knownPlayers.set(foundPlayer.id, { name: foundPlayer.name, isOnline: true });
                saveData();
            }
        }

        if (!playerName && displayName) {
            let cleaned = displayName.trim().replace(/commands\.scoreboard\./g, "").replace(/offlinePlayer/g, "").replace(/[0-9]+/g, "").replace(/[^a-zA-Z_]/g, "").trim();
            if (cleaned && cleaned.length >= 2 && cleaned.length <= 20) playerName = cleaned;
        }

        if (!playerName) playerName = "Unknown";

        let displayNick = playerName;
        if (entryId) {
            const coloredNick = getPlayerNickNameColored(entryId);
            if (coloredNick) displayNick = coloredNick;
        }

        if (entryId === player.id) isSelf = true;
        if (!isSelf && playerName === player.name) isSelf = true;

        participants.push({ identity: p, name: playerName, displayName: displayNick, score: score, isOnline: isOnline, isSelf: isSelf, playerId: entryId });
    }

    participants.sort(function (a, b) { return b.score - a.score; });

    let bodyText = "";
    if (participants.length > 0) {
        let onlineCount = 0, offlineCount = 0;
        for (let c = 0; c < participants.length; c++) {
            if (participants[c].isOnline) onlineCount++; else offlineCount++;
        }
        bodyText = "§7Targets with active bounties:\n§aOnline: " + onlineCount + "  §7|  §cOffline: " + offlineCount + "\n\n§7Click a target to manage.";
    } else {
        bodyText = "§7There are currently no active bounties.";
    }

    const form = new ActionFormData().title("§c§lBounty List").body(bodyText);

    const rankIcons = ["textures/rank_colours/red.png", "textures/rank_colours/gold.png", "textures/rank_colours/blue.png", "textures/rank_colours/dark_gray.png", "textures/rank_colours/dark_green.png"];

    const isOp = player.hasTag("op");

    for (let i = 0; i < participants.length; i++) {
        const target = participants[i];
        const icon = (i < 5) ? rankIcons[i] : "textures/rank_colours/white.png";
        let coloredName = "";
        if (target.isSelf) coloredName = "§e" + target.name + " §b(You)§r";
        else if (target.isOnline) coloredName = "§a" + target.name + "§r";
        else coloredName = "§c" + target.name + "§r";
        form.button(coloredName + "\n§c$" + formatBountyNumber(target.score), icon);
    }

    form.button("§dAdd Bounty\n§f[ Place a Hit ]", "textures/add.png");

    if (isOp) {
        const belowNameOn = isBountyBelowNameEnabled();
        const toggleText = belowNameOn ? "§aDisplay Bounty: ON§r\n§e[ Click to Hide Below Name ]" : "§cDisplay Bounty: OFF§r\n§e[ Click to Show Below Name ]";
        form.button(toggleText, "textures/mod.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(function (response) {
        if (response.canceled) return;

        const addBountyIdx = participants.length;
        const toggleIdx = isOp ? participants.length + 1 : -1;
        const backIdx = isOp ? participants.length + 2 : participants.length + 1;

        if (response.selection === addBountyIdx) {
            showAddBountyDropdown(player);
        } else if (response.selection === toggleIdx && isOp) {
            const current = isBountyBelowNameEnabled();
            setBountyBelowName(!current);
            player.sendMessage(!current ? "§aBounty display below name: §lON§r§a. Players will see bounty amounts under their names." : "§cBounty display below name: §lOFF§r§c. Below name display cleared.");
            showBountyList(player);
        } else if (response.selection === backIdx) {
            showMenu(player);
        } else if (response.selection < participants.length) {
            const targetData = participants[response.selection];
            if (targetData.isSelf) {
                player.sendMessage("§c═════════");
                player.sendMessage("§cYou cannot manage your own bounty!");
                player.sendMessage("§c═════════");
                try { player.runCommand("playsound note.bass @s ~~~ 0.5 1"); } catch (e) { }
                showBountyList(player);
                return;
            }
            showBountyTargetUI(player, targetData.identity, targetData.displayName || targetData.name, targetData.isOnline, targetData.score);
        }
    });
}

// === [BOUNTY TARGET SUB-UI] ===
function showBountyTargetUI(player, targetIdentity, targetName, isOnlineStatus, currentBountyScore) {
    const bountyObj = world.scoreboard.getObjective("Bounty");
    var currentBounty = 0;
    if (bountyObj) { try { currentBounty = bountyObj.getScore(targetIdentity) || 0; } catch (e) { } }

    var statusColor = isOnlineStatus ? "§a" : "§c";
    var statusWord = isOnlineStatus ? "Online" : "Offline";

    let bountyDisplay = "§c$" + formatBountyNumber(currentBounty) + "§r";
    if (currentBounty >= BOUNTY_MAX) {
        bountyDisplay += " §4(MAX)§r";
    } else if (currentBounty >= 1000000) {
        bountyDisplay += " §e(" + getShortBountyLabel(currentBounty) + ")§r";
    }

    const isMaxed = currentBounty >= BOUNTY_MAX;

    let bodyText = "§7═════════\n" +
        "§fPlayer: " + statusColor + targetName + "§r\n" +
        "§fStatus: " + statusColor + statusWord + "§r\n" +
        "§fCurrent Bounty: " + bountyDisplay + "\n" +
        "§7═════════\n\n";

    if (isMaxed) {
        bodyText += "§4§lThis bounty has reached the maximum amount!§r\n\n";
    }

    bodyText += "§7Choose an action:";

    const form = new ActionFormData()
        .title("§c§lBounty: " + targetName)
        .body(bodyText);

    if (!isMaxed) {
        form.button("§aAdd Bounty\n§f[ Add funds to hit ]", "textures/rank_colours/light_purple.png");
    }

    if (player.hasTag("op")) {
        form.button("§cDelete Bounty\n§f[ OP Exclusive ]", "textures/rank_colours/red.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(function (response) {
        if (response.canceled) return;

        let btnIdx = 0;
        const addIdx = !isMaxed ? btnIdx++ : -1;
        const deleteIdx = player.hasTag("op") ? btnIdx++ : -1;

        if (response.selection === addIdx) {
            showAddBountyModal(player, targetIdentity, targetName, currentBounty);
        } else if (response.selection === deleteIdx && player.hasTag("op")) {
            showDeleteBountyConfirmation(player, targetIdentity, targetName);
        } else {
            showBountyList(player);
        }
    });
}

// === [ADD BOUNTY MODAL] ===
function showAddBountyModal(player, targetIdentity, targetName, currentBountyScore) {
    const currentBounty = currentBountyScore || 0;
    const remainingCap = BOUNTY_MAX - currentBounty;

    if (remainingCap <= 0) {
        player.sendMessage("§cThis bounty has reached the maximum of §6$1,000,000,000§c! Your bounty is void.");
        showBountyTargetUI(player, targetIdentity, targetName, true, currentBounty);
        return;
    }

    const form = new ModalFormData()
        .title("§a§lAdd Bounty")
        .textField("§6Amount to add to §e" + targetName + "'s §6bounty\n§7Max remaining: §e$" + formatBountyNumber(remainingCap), "Enter amount...");

    form.show(player).then(function (response) {
        if (response.canceled) { showBountyTargetUI(player, targetIdentity, targetName, true, currentBounty); return; }

        var amountInput = response.formValues[0];
        var amount = parseInt(amountInput);

        if (isNaN(amount) || amount <= 0) {
            player.sendMessage("§cPlease enter a valid positive amount.");
            showAddBountyModal(player, targetIdentity, targetName, currentBounty);
            return;
        }

        if (amount > remainingCap) {
            amount = remainingCap;
            player.sendMessage("§eAmount capped to §6$" + formatBountyNumber(amount) + " §eto reach maximum bounty.");
        }

        var payerBalance = getBalance(player.scoreboardIdentity);

        if (payerBalance < amount) {
            player.sendMessage("§cInsufficient balance! Current: §e$" + formatBountyNumber(payerBalance));
            showAddBountyModal(player, targetIdentity, targetName, currentBounty);
            return;
        }

        const bountyObj = world.scoreboard.getObjective("Bounty");
        if (!bountyObj) { player.sendMessage("§cBounty system is not available."); return; }

        var newBounty = currentBounty + amount;

        setBalance(player.scoreboardIdentity, payerBalance - amount);
        bountyObj.setScore(targetIdentity, newBounty);

        player.sendMessage("§aYou added §6$" + formatBountyNumber(amount) + " §ato §e" + targetName + "'s §abounty!");
        player.sendMessage("§7New bounty: §c$" + formatBountyNumber(newBounty) + (newBounty >= BOUNTY_MAX ? " §4(MAX)" : ""));

        var onlineTarget = null;
        try { onlineTarget = world.getAllPlayers().find(function (p) { return p.id === targetIdentity.id || p.name === targetName; }); } catch (e) { }
        if (onlineTarget) { onlineTarget.sendMessage("§cA bounty of §6$" + formatBountyNumber(amount) + " §chas been placed on you by §e" + player.name + "§c!"); }
    });
}

// === [DELETE BOUNTY CONFIRMATION] ===
function showDeleteBountyConfirmation(player, targetIdentity, targetName) {
    const form = new ActionFormData()
        .title("§c§lDelete Bounty")
        .body("§cAre you sure you want to delete §e" + targetName + "'s §cbounty from the list?")
        .button("§aYes", "textures/rank_colours/green.png")
        .button("§cNo", "textures/rank_colours/red.png");

    form.show(player).then(function (response) {
        if (response.canceled) return;

        if (response.selection === 0) {
            const bountyObj = world.scoreboard.getObjective("Bounty");
            if (bountyObj) {
                try { bountyObj.removeParticipant(targetIdentity); } catch (err) { try { bountyObj.setScore(targetIdentity, 0); } catch (e) { } }

                player.sendMessage("§cYou forcefully removed §e" + targetName + "'s §cbounty.");

                var onlineTarget = null;
                try { onlineTarget = world.getAllPlayers().find(function (p) { return p.id === targetIdentity.id || p.name === targetName; }); } catch (e) { }
                if (onlineTarget) { onlineTarget.sendMessage("§cYour bounty has been forcefully removed by an operator."); }

                world.sendMessage("§6[BOUNTY] §e" + player.nameTag + " §chas reset the bounty on §c" + targetName + "§c.");
            }
            showBountyList(player);
        } else {
            showBountyTargetUI(player, targetIdentity, targetName, true, 0);
        }
    });
}

// ============================================
// ADD BOUNTY DROPDOWN
// ============================================
function showAddBountyDropdown(player) {
    loadData();

    const allOnline = world.getAllPlayers();
    const otherOnline = allOnline.filter(function (p) { return p.id !== player.id; });
    const onlineIds = new Set(otherOnline.map(p => p.id));

    if (otherOnline.length === 0) {
        player.sendMessage("§c═════════");
        player.sendMessage("§cCannot open this UI!");
        player.sendMessage("§c═════════");

        try { player.runCommand("playsound note.bass @s ~~~ 0.5 1"); } catch (e) { }

        system.runTimeout(function () {
            showBountyList(player);
        }, 20);

        return;
    }

    const playerList = [];

    otherOnline.forEach(function (p) {
        playerList.push({ name: p.name, id: p.id, isOnline: true, identity: p.scoreboardIdentity });
    });

    knownPlayers.forEach(function (data, id) {
        if (!onlineIds.has(id) && id !== player.id) {
            if (data.name && data.name !== "Unknown") {
                playerList.push({ name: data.name, id: id, isOnline: false, identity: null });
            }
        }
    });

    if (playerList.length === 0) {
        player.sendMessage("§cNo players available for bounty.");
        showBountyList(player);
        return;
    }

    playerList.sort(function (a, b) {
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return a.name.localeCompare(b.name);
    });

    const playerNames = [];
    for (var j = 0; j < playerList.length; j++) {
        const pl = playerList[j];
        let display = pl.name;
        const coloredNick = getPlayerNickNameColored(pl.id);
        if (coloredNick) display = coloredNick;
        if (pl.isOnline) {
            playerNames.push(display);
        } else {
            playerNames.push(display + " §7(Offline)§r");
        }
    }

    const form = new ModalFormData()
        .title("§d§lAdd Bounty")
        .textField("§6Bounty Amount §7(Number)\n§7Max per player: §e$1,000,000,000", "Enter amount...")
        .dropdown("§cSelect Player (" + playerList.length + " available)", playerNames);

    form.show(player).then(function (response) {
        if (response.canceled) { showBountyList(player); return; }

        var amountInput = response.formValues[0];
        var selectedIndex = response.formValues[1];
        var selectedPlayerData = playerList[selectedIndex];

        var amount = parseInt(amountInput);

        if (isNaN(amount) || amount <= 0) {
            player.sendMessage("§cPlease enter a valid positive amount.");
            showAddBountyDropdown(player);
            return;
        }

        if (amount > BOUNTY_MAX) {
            amount = BOUNTY_MAX;
            player.sendMessage("§eAmount capped to §6$" + formatBountyNumber(BOUNTY_MAX) + " §e(maximum bounty).");
        }

        var payerBalance = getBalance(player.scoreboardIdentity);

        if (payerBalance < amount) {
            player.sendMessage("§cInsufficient balance! Current: §e$" + formatBountyNumber(payerBalance));
            showAddBountyDropdown(player);
            return;
        }

        const bountyObj = world.scoreboard.getObjective("Bounty");
        if (!bountyObj) { player.sendMessage("§cBounty system is not available."); return; }

        if (selectedPlayerData.isOnline && selectedPlayerData.identity) {
            var currentBounty = 0;
            try { currentBounty = bountyObj.getScore(selectedPlayerData.identity) || 0; } catch (e) { }

            if (currentBounty >= BOUNTY_MAX) {
                player.sendMessage("§cThis player's bounty has reached the maximum of §6$1,000,000,000§c! Your bounty is void.");
                showAddBountyDropdown(player);
                return;
            }

            let cappedAmount = amount;
            let newBounty = currentBounty + amount;
            if (newBounty > BOUNTY_MAX) {
                cappedAmount = BOUNTY_MAX - currentBounty;
                newBounty = BOUNTY_MAX;
                player.sendMessage("§eBounty capped to §6$" + formatBountyNumber(BOUNTY_MAX) + " §e(maximum).");
            }

            setBalance(player.scoreboardIdentity, payerBalance - cappedAmount);
            bountyObj.setScore(selectedPlayerData.identity, newBounty);

            let displayNick = selectedPlayerData.name;
            const coloredNick = getPlayerNickNameColored(selectedPlayerData.id);
            if (coloredNick) displayNick = coloredNick;

            player.sendMessage("§aYou placed a §6$" + formatBountyNumber(cappedAmount) + " §abounty on " + displayNick + "§r§a!");

            var targetPlayer = null;
            try { targetPlayer = world.getAllPlayers().find(function (p) { return p.id === selectedPlayerData.id; }); } catch (e) { }
            if (targetPlayer) { targetPlayer.sendMessage("§cA bounty of §6$" + formatBountyNumber(cappedAmount) + " §chas been placed on you by §e" + player.name + "§c!"); }
        } else {
            try {
                var offlineIdentity = { id: selectedPlayerData.id, displayName: selectedPlayerData.name };
                var existingBounty = 0;
                try { existingBounty = bountyObj.getScore(offlineIdentity) || 0; } catch (e) { }

                if (existingBounty >= BOUNTY_MAX) {
                    player.sendMessage("§cThis player's bounty has reached the maximum of §6$1,000,000,000§c! Your bounty is void.");
                    showAddBountyDropdown(player);
                    return;
                }

                let cappedAmount = amount;
                let newBounty = existingBounty + amount;
                if (newBounty > BOUNTY_MAX) {
                    cappedAmount = BOUNTY_MAX - existingBounty;
                    newBounty = BOUNTY_MAX;
                    player.sendMessage("§eBounty capped to §6$" + formatBountyNumber(BOUNTY_MAX) + " §e(maximum).");
                }

                setBalance(player.scoreboardIdentity, payerBalance - cappedAmount);
                bountyObj.setScore(offlineIdentity, newBounty);

                if (!knownPlayers.has(selectedPlayerData.id)) {
                    knownPlayers.set(selectedPlayerData.id, { name: selectedPlayerData.name, isOnline: false });
                    saveData();
                }

                let displayNick = selectedPlayerData.name;
                const coloredNick = getPlayerNickNameColored(selectedPlayerData.id);
                if (coloredNick) displayNick = coloredNick;

                player.sendMessage("§aYou placed a §6$" + formatBountyNumber(cappedAmount) + " §abounty on " + displayNick + "§r§a!");
                player.sendMessage("§7(Player is offline. Name saved!)");
            } catch (error) {
                try { setBalance(player.scoreboardIdentity, payerBalance); } catch (e) { }
                player.sendMessage("§cFailed to place bounty on offline player.");
                showAddBountyDropdown(player);
                return;
            }
        }
    });
}

// === [SEND MONEY FUNCTION] ===
export function showSendMoney(player) {
    var players = world.getAllPlayers();
    var otherPlayers = players.filter(function (p) { return p.name !== player.name; });

    if (otherPlayers.length === 0) {
        player.sendMessage("§cNo other players online to send money to.");
        return;
    }

    var playerNames = [];
    for (var k = 0; k < otherPlayers.length; k++) { playerNames.push(otherPlayers[k].name); }

    const form = new ModalFormData()
        .title("§e§lSend Money")
        .textField("§6Amount to Send §7(Number)", "Enter amount...")
        .dropdown("§aSelect Player to Pay", playerNames);

    form.show(player).then(function (response) {
        if (response.canceled) return;

        var amountInput = response.formValues[0];
        var selectedIndex = response.formValues[1];
        var selectedPlayerName = playerNames[selectedIndex];

        var amount = parseInt(amountInput);
        if (isNaN(amount) || amount <= 0) {
            player.sendMessage("§cPlease enter a valid positive amount.");
            showSendMoney(player);
            return;
        }

        var onlinePlayers = world.getAllPlayers();
        var targetPlayer = null;
        for (var m = 0; m < onlinePlayers.length; m++) {
            if (onlinePlayers[m].name === selectedPlayerName) { targetPlayer = onlinePlayers[m]; break; }
        }

        if (!targetPlayer) { player.sendMessage("§cYou cannot send money to an offline player."); return; }

        var payerBalance = getBalance(player.scoreboardIdentity);

        if (payerBalance < amount) { player.sendMessage("§cInsufficient balance! Your current balance: §e$" + payerBalance); showSendMoney(player); return; }

        var receiverBalance = getBalance(targetPlayer.scoreboardIdentity);

        setBalance(player.scoreboardIdentity, payerBalance - amount);
        setBalance(targetPlayer.scoreboardIdentity, receiverBalance + amount);

        player.sendMessage("§aYou paid §e" + selectedPlayerName + " §awith the amount of §6$" + amount + "§a.");
        player.sendMessage("§7Your new balance: §e$" + (payerBalance - amount));

        targetPlayer.sendMessage("§e" + player.name + " §apaid you §6$" + amount + "§a.");
        targetPlayer.sendMessage("§7Your new balance: §e$" + (receiverBalance + amount));
    });
}

// === [WARPS MENU] ===
export function showWarpsMenu(player) {
    var warps = getWarps();

    const form = new ActionFormData()
        .title("§bWarps Menu")
        .body(warps.length > 0 ? "§7Choose a warp destination:" : "§cNo warps have been created yet.");

    for (var w = 0; w < warps.length; w++) {
        form.button("§a" + warps[w].name, warps[w].icon || "textures/warps/overworld.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(function (response) {
        if (response.canceled) return;
        if (response.selection === warps.length) { showMenu(player); return; }
        var selectedWarp = warps[response.selection];
        if (selectedWarp) { startWarpCountdown(player, selectedWarp); }
    });
}

// === [WARP COUNTDOWN] ===
function startWarpCountdown(player, warp) {
    if (teleportLocks.get(player.name)) { player.onScreenDisplay.setActionBar("§cAlready teleporting..."); return; }

    var settings = getWarpSettings();
    var countdown = (settings && settings.countdown) ? settings.countdown : 5;

    teleportLocks.set(player.name, true);

    if (countdown <= 0) { doTeleport(player, warp); teleportLocks.delete(player.name); return; }

    var startLoc = { x: player.location.x, y: player.location.y, z: player.location.z };
    var secondsLeft = countdown;
    var canceled = false;

    player.onScreenDisplay.setActionBar("§eTeleporting to '" + warp.name + "' in §l" + secondsLeft + "s...");

    var countdownInterval = system.runInterval(function () {
        secondsLeft--;
        if (secondsLeft > 0) {
            player.onScreenDisplay.setActionBar("§eTeleporting to '" + warp.name + "' in §l" + secondsLeft + "s...");
        } else {
            system.clearRun(countdownInterval);
            system.clearRun(particleInterval);
            system.clearRun(movementInterval);
            if (!canceled) { doTeleport(player, warp); teleportLocks.delete(player.name); }
        }
    }, 20);

    var particleInterval = system.runInterval(function () {
        try {
            var particleId = "minecraft:end_chest";
            var maxParticles = 30;
            var radiusXZ = 0.3;
            var radiusY = 2.0;
            var elapsed = countdown - secondsLeft;
            var progress = elapsed / countdown;
            var particlesPerTick = Math.max(1, Math.floor(progress * maxParticles));

            for (var pi = 0; pi < particlesPerTick; pi++) {
                var offsetX = (Math.random() - 0.5) * 2 * radiusXZ;
                var offsetY = Math.random() * radiusY;
                var offsetZ = (Math.random() - 0.5) * 2 * radiusXZ;
                var pos = { x: player.location.x + offsetX, y: player.location.y + offsetY, z: player.location.z + offsetZ };
                player.dimension.spawnParticle(particleId, pos);
            }
        } catch (err) { }
    }, 1);

    var movementInterval = system.runInterval(function () {
        if (secondsLeft <= 0.5) return;
        var loc = player.location;
        var dx = Math.abs(loc.x - startLoc.x);
        var dy = Math.abs(loc.y - startLoc.y);
        var dz = Math.abs(loc.z - startLoc.z);
        var threshold = 0.1;
        if (dx > threshold || dy > threshold || dz > threshold) {
            player.onScreenDisplay.setActionBar("§cTeleport canceled (you moved!)");
            system.clearRun(countdownInterval);
            system.clearRun(particleInterval);
            system.clearRun(movementInterval);
            teleportLocks.delete(player.name);
            canceled = true;
        }
    }, 5);
}

// === [TELEPORT] ===
function doTeleport(player, warp) {
    var coords = warp.coords.split(" ");
    var x = parseFloat(coords[0]);
    var y = parseFloat(coords[1]);
    var z = parseFloat(coords[2]);
    var targetDimension = world.getDimension(warp.dimension || "minecraft:overworld");

    player.teleport({ x: x + 0.5, y: y, z: z + 0.5 }, { dimension: targetDimension });
    player.onScreenDisplay.setActionBar("§aTeleported to '" + warp.name + "'");
}

// ============================================
// FEATURE TOGGLES
// ============================================

const FEATURE_TOGGLES_KEY = "zyd:feature_toggles";
const DEFAULT_FEATURES = {
    warps: true,
    teleport: true,
    factions: true,
    sethome: true,
    kits: true,
    ranks: true,
    bounty: true,
    sendmoney: true,
    promocode: true,
    daily: true,
    report: true
};

function getFeatureToggles() {
    try {
        const data = world.getDynamicProperty(FEATURE_TOGGLES_KEY);
        if (data) {
            const parsed = JSON.parse(data);
            return { ...DEFAULT_FEATURES, ...parsed };
        }
    } catch (e) { }
    return { ...DEFAULT_FEATURES };
}

function saveFeatureToggles(toggles) {
    try { world.setDynamicProperty(FEATURE_TOGGLES_KEY, JSON.stringify(toggles)); } catch (e) { }
}

export function isFeatureEnabled(featureId) {
    const toggles = getFeatureToggles();
    return toggles[featureId] === true;
}

function setFeatureEnabled(featureId, enabled) {
    const toggles = getFeatureToggles();
    toggles[featureId] = enabled;
    saveFeatureToggles(toggles);
}

function showFeatureTogglesUI(player) {
    const toggles = getFeatureToggles();

    const form = new ActionFormData()
        .title("§d§lFeature Toggles")
        .body("§7Click a feature to Enable/Disable it.\n§cDisabled features will be hidden from players.");

    const featureList = [
        { id: "warps", name: "Warps", color: "§b", icon: "textures/warps/warps.png" },
        { id: "teleport", name: "Teleport", color: "§a", icon: "textures/teleport/teleport.png" },
        { id: "factions", name: "Factions", color: "§6", icon: "textures/factions/faction.png" },
        { id: "sethome", name: "Set Home", color: "§d", icon: "textures/random/claim_10.png" },
        { id: "kits", name: "Starter Kits", color: "§e", icon: "textures/kits/kits.png" },
        { id: "ranks", name: "Ranks", color: "§6", icon: "textures/duels/duels.png" },
        { id: "bounty", name: "Bounty", color: "§a", icon: "textures/rank_colours/green.png" },
        { id: "sendmoney", name: "Send Money", color: "§e", icon: "textures/money.png" },
        { id: "promocode", name: "Promo Codes", color: "§d", icon: "textures/promocode.png" },
        { id: "daily", name: "Daily Rewards", color: "§6", icon: "textures/timer.png" },
        { id: "report", name: "Report", color: "§c", icon: "textures/down_vote.png" }
    ];

    for (const feat of featureList) {
        const status = toggles[feat.id] ? "§a[ON]" : "§c[OFF]";
        form.button(`${feat.color}${feat.name}\n§8${status}`, feat.icon);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;

        if (res.selection === featureList.length) {
            showOperatorPanel(player);
            return;
        }

        const selectedFeature = featureList[res.selection];
        const currentState = toggles[selectedFeature.id];
        const newState = !currentState;

        setFeatureEnabled(selectedFeature.id, newState);

        if (newState) {
            player.sendMessage(`§a§l✔ ${selectedFeature.name} has been ENABLED!`);
            world.sendMessage(`§d[SYSTEM] §a${selectedFeature.name} is now enabled.`);
        } else {
            player.sendMessage(`§c§l✔ ${selectedFeature.name} has been DISABLED!`);
            world.sendMessage(`§d[SYSTEM] §c${selectedFeature.name} is now disabled.`);
        }
        player.playSound("random.levelup");

        showFeatureTogglesUI(player);
    });
}

// === [EDIT CURRENCY UI] ===
function showEditCurrencyUI(player) {
    const currentCurrency = getCurrencyObjective();

    const form = new ModalFormData()
        .title("§l§6Edit Currency")
        .textField("§7Current: §f" + currentCurrency + "\n§7Enter new currency name:", "Money", { defaultValue: currentCurrency })
        .submitButton("§aConfirm & Save");

    system.run(() => {
        form.show(player).then(function (response) {
            if (response.canceled) {
                showOperatorPanel(player);
                return;
            }

            const nameInput = response.formValues[0];
            const trimmed = (nameInput || "").trim();

            if (trimmed.length === 0) {
                player.sendMessage("§c[Currency] Name cannot be empty.");
                system.run(() => showEditCurrencyUI(player));
                return;
            }
            if (trimmed.length > 16) {
                player.sendMessage("§c[Currency] Name too long (max 16 characters). You entered " + trimmed.length + ".");
                system.run(() => showEditCurrencyUI(player));
                return;
            }
            if (!/^[A-Za-z0-9_]+$/.test(trimmed)) {
                player.sendMessage("§c[Currency] Invalid characters. Use letters, numbers, and underscores only.");
                system.run(() => showEditCurrencyUI(player));
                return;
            }

            if (!setCurrencyObjective(trimmed)) {
                player.sendMessage("§c[Currency] Failed to save setting.");
                system.run(() => showOperatorPanel(player));
                return;
            }

            let created = false;
            let createError = null;
            try {
                if (!world.scoreboard.getObjective(trimmed)) {
                    world.scoreboard.addObjective(trimmed, "dummy");
                    created = true;
                }
            } catch (e) {
                createError = e;
            }

            player.sendMessage("§a---------------------------");
            player.sendMessage("§a[Currency] Configuration Saved!");
            player.sendMessage("§a---------------------------");
            player.sendMessage("§7Objective: §f" + trimmed);

            if (created) {
                player.sendMessage("§7Status: §aCreated & Linked");
            } else if (createError) {
                player.sendMessage("§7Status: §eLinked (create failed: " + (createError.message || createError) + ")");
                player.sendMessage("§7Manual: §f/scoreboard objectives add " + trimmed + " dummy");
            } else {
                player.sendMessage("§7Status: §aLinked (objective already existed)");
            }

            player.sendMessage("§a---------------------------");

            system.run(() => showOperatorPanel(player));
        }).catch(function (error) {
            player.sendMessage("§c[Currency] An error occurred.");
            showOperatorPanel(player);
        });
    });
}

// === [OPERATOR PANEL] ===
export function showOperatorPanel(player) {
    const currentCurrency = getCurrencyObjective();

    const form = new ActionFormData()
        .title("§cOperator Panel")
        .body(
            "§bOperator Tools§f – Manage server features.\n\n" +
            "§7Warp Operator§f - Create, edit, delete warps.\n" +
            "§9Scoreboard§f - Configure HUD display.\n" +
            "§dFeature Toggles§f - Enable/Disable server features.\n" +
            "§6Edit Currency§f - Edit your current currency (§f" + currentCurrency + "§7)"
        )
        .button("§bWarp Operator\n§f[ Manage Warps ]", "textures/warps/warps.png")
        .button("§9Scoreboard\n§f[ Configure HUD ]", "textures/operator/spawnicon35.png")
        .button("§dFeature Toggles\n§f[ Enable / Disable ]", "textures/admin/gamemodes.png")
        .button("§6Edit Currency\n§2" + currentCurrency, "textures/money.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(function (response) {
        if (response.canceled) return;

        switch (response.selection) {
            case 0:
                import("./operator/warpsedit.js").then(function (mod) {
                    if (typeof mod.showWarpsEdit === "function") { mod.showWarpsEdit(player); }
                });
                break;
            case 1:
                showScoreboardMenu(player);
                break;
            case 2:
                showFeatureTogglesUI(player);
                break;
            case 3:
                showEditCurrencyUI(player);
                break;
            default:
                showMenu(player);
                break;
        }
    });
}

console.log("✅ [Menu] Loaded - Bounty updated with BelowName toggle!");
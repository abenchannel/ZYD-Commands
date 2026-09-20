//scripts/main.js
import {
    system,
    CommandPermissionLevel,
    CustomCommandStatus,
    Player,
    world
} from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { showMenu, showOperatorPanel, showWarpsMenu, showBountyList, showSendMoney, isFeatureEnabled } from "./menu.js";
import "./factionsPower.js"; // Side-effect import: starts power regen loop + death penalty listener
import "./claimWand.js"; // Side-effect import: right-click handler for zyd:claim_wand item
import "./factionsProtection.js"; // Side-effect import: starts territory protection listeners
import { showReportMenu } from "./report.js";
import { showAdminPanel } from "./admin/admin.js";
import { showDailyRewards } from "./daily.js";
import { showPromoCode } from "./promocode.js";
import { showTeleport, doRandomTeleport, doDeathBack } from "./teleport.js"; // 
import { showKits } from "./kits.js";
import { showRanks } from "./ranks.js";
import { pendingRequests, confirmTeleportRequest } from "./teleport.js";
import { showBalance, showBalanceList } from "./bal.js";
import { registerFlySystem, toggleFly, isFlyEnabled, showFlySettingsMenu } from "./fly.js";
import {
    getCustomNicks,
    saveCustomNicks,
    getPlayerData,
    savePlayerData,
    getActiveNickDisplay,
    getRankSkillsEnabled,
    isCommandEnabledForPlayer
} from "./ranks.js";
import {
    showFactionsMainUI,
    showEditFactionUI,
    showCreateFactionUI,
    showLeaderboardUI,
    showJoinSearchUI,
    showDiplomacyAlliesUI,
    showDiplomacyEnemiesUI,
    getPlayerFactionId,
    getPlayerPendingRequests,
    savePlayerPendingRequests,
    getFactionById,
    removePendingRequestsForPlayer,
    getPlayerSavedPower,
    showDisbandConfirmUI,
    processOfflineNotifications,
    showFactionPowerInfo,
    showSetFactionHome,
    showTeleportFactionHome,
    showDeleteFactionHome,
    showFactionSettingsUI,
    hasFactionPermission
} from "./factionsCore.js";
import { autoMapPlayers, autoMapLastChunk, generateAsciiMap, executeClaim, executeUnclaim } from "./factionsClaims.js";

// ============================================
// CHANGELOG SYSTEM (shown once per player, resets on script reload)
// ============================================

// In-memory Set (NOT a dynamic property) — this is intentional.
// It clears automatically whenever the script/server reloads,
// so everyone will see the changelog again after an update,
// but won't see it again just from rejoining mid-session.
const changelogReadPlayers = new Set();

// ------------------------------------------------------
// HOW TO EDIT THE CHANGELOG TEXT BELOW:
// - "\n"   = new line
// - Colors: §f white | §a green | §c red | §e yellow | §b aqua | §d pink | §6 gold | §7 gray
// - Style:  §l bold | §o italic | §n underline | §r reset formatting back to normal
// - "Columns": pad with spaces so text lines up, e.g.:
//     "§7Warps:      §fDone\n"
//     "§7Factions:   §cIn Progress\n"
// - Keep lines short-ish; long lines auto-wrap in the form.
// ------------------------------------------------------
const CHANGELOG_TITLE = "§d§lZYD Changelog V4.2";
const CHANGELOG_BODY =
    "§7Welcome! Here's what's new:\n\n" +
    "§a+ Added: Creative-style flight mode in Survival\n" +
    "§a+ Added: New Rank Settings - set custom skills per rank\n" +
    "§a+ Added: Easy copy & paste for Unicode icons\n" +
    "§a+ Added: Create rank titles with skills built-in\n" +
    "§a+ Added: Rank Titles & Rank System are now separate - disable the Rank System without removing custom rank titles\n" +
    "§c~ Fixed: Various bug fixes\n\n " +
    "§7(End of Changelog§7).";

function showChangelogUI(player) {
    const form = new ActionFormData()
        .title(CHANGELOG_TITLE)
        .body(CHANGELOG_BODY)
        .button("§l§aI've Read This§r", "textures/check.png");

    form.show(player).then((response) => {
        if (response.canceled) return; // didn't confirm - will try again next initial join
        if (response.selection === 0) {
            changelogReadPlayers.add(player.id);
        }
    });
}

world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    const player = event.player;

    // Deliver offline faction notifications (e.g. stolen land)
    processOfflineNotifications(player);

    if (changelogReadPlayers.has(player.id)) return;

    system.runTimeout(() => {
        showChangelogUI(player);
    }, 40); // small delay so it doesn't collide with other join popups
});

// SELF-HOST FIX: On a self-hosted world, the host player is often already
// spawned/online by the time this script finishes loading, so the
// playerSpawn event above never fires for them (world loads before script,
// and the host is already "in"). This catches anyone already online
// right when the script starts running.
system.runTimeout(() => {
    for (const player of world.getAllPlayers()) {
        if (changelogReadPlayers.has(player.id)) continue;
        showChangelogUI(player);
    }
}, 40);

// === [HELPERS] ===
function hasTag(player, tag) {
    return player.getTags().includes(tag);
}

function isBanned(player) {
    return hasTag(player, "ban") && !hasTag(player, "op");
}

// === [COOLDOWN SYSTEM] ===
function formatCooldown(ms) {
    if (ms <= 0) return "0s";
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function checkCooldown(player, skillName, cooldownMs) {
    try {
        const prop = `zyd:cd_${skillName}_${player.id}`;
        const lastUsed = world.getDynamicProperty(prop) || 0;
        const now = Date.now();
        const remaining = cooldownMs - (now - lastUsed);
        return remaining > 0 ? remaining : 0;
    } catch (e) { return 0; }
}

function setCooldown(player, skillName) {
    try {
        const prop = `zyd:cd_${skillName}_${player.id}`;
        world.setDynamicProperty(prop, Date.now());
    } catch (e) { }
}

// OP Bypass Helpers
function canUseSkill(player, skillName, cooldownMs) {
    if (hasTag(player, "op")) return 0; // OPs bypass cooldown
    return checkCooldown(player, skillName, cooldownMs);
}

function applySkillCooldown(player, skillName) {
    if (!hasTag(player, "op")) { // Only set cooldown for non-OPs
        setCooldown(player, skillName);
    }
}

// === [FLIGHT SYSTEM] ===
// /zyd:fly grants the ability; the player then double-taps Jump to take off/land.
// registerFlySystem() wires up the movement loop + respawn/leave/hurt events.
registerFlySystem();

// === [COMMAND REGISTRATION] ===
system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {

    // ------------------------------------------------------
    // /zyd:menu
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:menu",
            description: "Open the ZYD Menu",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            system.run(() => showMenu(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:changelog (Everyone) - Manually view the changelog anytime
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:changelog",
            description: "View the latest changelog",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            system.run(() => showChangelogUI(source));
            return { status: CustomCommandStatus.Success };
        }
    );
    // ------------------------------------------------------
    // /zyd:report (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:report",
            description: "Report a player to moderators",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("report")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showReportMenu(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:ranks (Shortcut to Rank UI)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:ranks",
            description: "Open the Rank System UI",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("ranks")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showRanks(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:heal (Cadet+ | 30m CD)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:heal",
            description: "Heal yourself fully (30m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "heal")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "heal", 1800000); // 30 mins
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cHeal is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                const health = source.getComponent("minecraft:health");
                health.setCurrentValue(health.effectiveMax);
                applySkillCooldown(source, "heal");
                source.sendMessage("§a§l✔ You have been fully healed!");
                source.playSound("random.orb");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:hunger (Trainee+ | 45m CD)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:hunger",
            description: "Fill hunger & saturation (45m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "hunger")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "hunger", 2700000); // 45 mins
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cHunger is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                source.addEffect("saturation", 1, { amplifier: 20 }); // Saturation level 20 for 1s
                applySkillCooldown(source, "hunger");
                source.sendMessage("§a§l✔ Your hunger has been fully saturated!");
                source.playSound("random.orb");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:nick & /zyd:nickname (Specialist+ | 60m CD)"
    // ------------------------------------------------------
    const nickHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

        if (!isCommandEnabledForPlayer(source, "nick")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

        if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

        const cd = canUseSkill(source, "nick", 3600000); // 60 mins
        if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cNick command is on cooldown! ${formatCooldown(cd)} remaining.` };

        system.run(() => {
            const currentNick = getActiveNickDisplay(source).replace(/§./g, "");
            const form = new ModalFormData()
                .title("§d§lNickname (60m CD)")
                .textField("§7Enter new nickname §8(15 characters max):", "CoolName", { defaultValue: currentNick });

            form.show(source).then(res => {
                if (res.canceled) return;
                let newNick = res.formValues[0].trim();
                if (!newNick) {
                    const data = getPlayerData(source);
                    if (data.activeNick) {
                        data.activeNick = null;
                        data.hideNick = false;
                        savePlayerData(source, data);
                        applySkillCooldown(source, "nick");
                        source.sendMessage("§a§l✔ Nickname cleared. Reverted to original name.");
                        source.playSound("random.orb");
                    } else {
                        source.sendMessage("§cYou don't have a nickname equipped.");
                    }
                    return;
                }
                if (newNick.length > 15) { source.sendMessage("§cNickname is too long! Maximum 15 characters."); return; }

                const nicks = getCustomNicks();
                const customId = `cmd_nick_${source.id}`;
                let existing = nicks.find(n => n.id === customId);
                if (existing) {
                    existing.display = newNick + "§r"; // Added §r to prevent color bleed
                } else {
                    nicks.push({ id: customId, display: newNick + "§r", chatColor: "", chatFormat: "", nickColor: "§f", nickFormat: "" });
                }
                saveCustomNicks(nicks);

                const data = getPlayerData(source);
                data.activeNick = customId;
                data.hideNick = false;
                savePlayerData(source, data);

                applySkillCooldown(source, "nick");
                source.sendMessage(`§a§l✔ Nickname changed to: §f${newNick}`);
                source.playSound("random.orb");
            });
        });
        return { status: CustomCommandStatus.Success };
    };

    customCommandRegistry.registerCommand({ name: "zyd:nick", description: "Change nickname (60m CD)", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false }, nickHandler);
    customCommandRegistry.registerCommand({ name: "zyd:nickname", description: "Change nickname (60m CD)", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false }, nickHandler);

    // ------------------------------------------------------
    // /zyd:fire (Specialist+ | 10m CD)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:fire",
            description: "Gain Fire Resistance for 30s (10m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "fire")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "fire", 600000); // 10 mins
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cFire Resistance is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                source.addEffect("fire_resistance", 420, { amplifier: 0 }); // 20 seconds
                applySkillCooldown(source, "fire");
                source.sendMessage("§a§l✔ You gained Fire Resistance for 20 seconds!");
                source.playSound("random.orb");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:nv & /zyd:nightvision (Ace+ | 10m CD)
    // ------------------------------------------------------
    const nvHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

        if (!isCommandEnabledForPlayer(source, "nv")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

        if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

        const cd = canUseSkill(source, "nv", 600000); // 10 mins
        if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cNight Vision is on cooldown! ${formatCooldown(cd)} remaining.` };

        system.run(() => {
            source.addEffect("night_vision", 6020, { amplifier: 0 }); // 5 mins
            applySkillCooldown(source, "nv");
            source.sendMessage("§a§l✔ You gained Night Vision for 5 minutes!");
            source.playSound("random.orb");
        });
        return { status: CustomCommandStatus.Success };
    };

    customCommandRegistry.registerCommand({ name: "zyd:nv", description: "Gain Night Vision for 5m (10m CD)", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false }, nvHandler);
    customCommandRegistry.registerCommand({ name: "zyd:nightvision", description: "Gain Night Vision for 5m (10m CD)", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false }, nvHandler);

    // ------------------------------------------------------
    // /zyd:repair (Grandmaster+ | 280m CD)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:repair",
            description: "Fully repair held item (280m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "repair")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "repair", 16800000); // 280 mins
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cRepair is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                const equippable = source.getComponent("minecraft:equippable");
                const item = equippable.getEquipment("Mainhand");
                if (!item) { source.sendMessage("§cYou must hold an item in your main hand!"); return; }

                const durability = item.getComponent("minecraft:durability");
                if (!durability) { source.sendMessage("§cThis item cannot be repaired!"); return; }

                durability.damage = 0;
                equippable.setEquipment("Mainhand", item);

                applySkillCooldown(source, "repair");
                source.sendMessage("§a§l✔ Your held item has been fully repaired!");
                source.playSound("random.anvil_use");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:day (Death God+ | 45m CD)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:day",
            description: "Set time to day (45m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "day")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "time_cycle", 2700000); // Shared 45m CD
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cTime command is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                world.setTimeOfDay(0);
                applySkillCooldown(source, "time_cycle"); // Shared CD key
                source.sendMessage("§a§l✔ Time has been set to day!");
                source.playSound("random.orb");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:night (Death God+ | 45m CD - Shared with Day)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:night",
            description: "Set time to night (45m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "night")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "time_cycle", 2700000); // Shared 45m CD
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cTime command is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                world.setTimeOfDay(18000); // Midnight
                applySkillCooldown(source, "time_cycle"); // Shared CD key
                source.sendMessage("§a§l✔ Time has been set to night!");
                source.playSound("random.orb");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:itemname (Specialist+ | 30m CD)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:itemname",
            description: "Rename held item (30m CD)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            if (!isCommandEnabledForPlayer(source, "itemname")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const cd = canUseSkill(source, "itemname", 1800000); // 30 mins
            if (cd > 0) return { status: CustomCommandStatus.Failure, message: `§cItem Name is on cooldown! ${formatCooldown(cd)} remaining.` };

            system.run(() => {
                const equippable = source.getComponent("minecraft:equippable");
                const item = equippable.getEquipment("Mainhand");
                if (!item) { source.sendMessage("§cYou must hold an item in your main hand!"); return; }

                const currentName = item.nameTag || "";
                const form = new ModalFormData()
                    .title("§e§lItem Name (30m CD)")
                    .textField("§7Enter new item name:", "My Sword", { defaultValue: currentName });

                form.show(source).then(res => {
                    if (res.canceled) return;
                    let newName = res.formValues[0];
                    item.nameTag = newName.trim();
                    equippable.setEquipment("Mainhand", item);
                    applySkillCooldown(source, "itemname");
                    source.sendMessage(newName.trim() ? `§a§l✔ Item renamed to: §f${newName.trim()}` : "§a§l✔ Item name cleared!");
                    source.playSound("random.orb");
                });
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:gmc (Creative) - OP only
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:gmc",
            description: "Set gamemode to Creative (OP only)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op")) return { status: CustomCommandStatus.Failure, message: "You don't have the permission to use this command." };
            system.run(() => source.runCommand("gamemode creative @s"));
            return { status: CustomCommandStatus.Success, message: "Gamemode set to Creative!" };
        }
    );

    // ------------------------------------------------------
    // /zyd:gmsp (Spectator) - Admin or OP
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:gmsp",
            description: "Set gamemode to Spectator (Admin/OP only)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !hasTag(source, "admin")) return { status: CustomCommandStatus.Failure, message: "You don't have the permission to use this command." };
            system.run(() => source.runCommand("gamemode spectator @s"));
            return { status: CustomCommandStatus.Success, message: "Gamemode set to Spectator!" };
        }
    );

    // ------------------------------------------------------
    // /zyd:gms (Survival) - Admin or OP
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:gms",
            description: "Set gamemode to Survival (Admin/OP only)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !hasTag(source, "admin")) return { status: CustomCommandStatus.Failure, message: "You don't have the permission to use this command." };
            system.run(() => source.runCommand("gamemode survival @s"));
            return { status: CustomCommandStatus.Success, message: "Gamemode set to Survival!" };
        }
    );

    // ------------------------------------------------------
    // /zyd:gma (Adventure) - Admin or OP
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:gma",
            description: "Set gamemode to Adventure (Admin/OP only)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !hasTag(source, "admin")) return { status: CustomCommandStatus.Failure, message: "You don't have the permission to use this command." };
            system.run(() => source.runCommand("gamemode adventure @s"));
            return { status: CustomCommandStatus.Success, message: "Gamemode set to Adventure!" };
        }
    );

    // ------------------------------------------------------
    // /zyd:fly (Ace+ rank or OP) - Toggle Creative-style flight (vanilla mayfly, custom fallback)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:fly",
            description: "Toggle flight (Ace+ rank or OP)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            const alreadyFlying = isFlyEnabled(source);

            // Always allow turning flight OFF even without current permission —
            // prevents a player from getting stuck flying forever if their rank
            // (or rank's fly skill) is changed/removed while flight is active.
            if (!hasTag(source, "op") && !alreadyFlying && !isCommandEnabledForPlayer(source, "fly")) return { status: CustomCommandStatus.Failure, message: "§cYour current rank doesn't allow you to use this command!" };

            if (!hasTag(source, "op") && !alreadyFlying && !getRankSkillsEnabled()) return { status: CustomCommandStatus.Failure, message: "§cRank skills are currently disabled!" };

            const gm = String(source.getGameMode()).toLowerCase();
            if (gm === "creative" || gm === "spectator") {
                return { status: CustomCommandStatus.Failure, message: "§cYou can already fly in this gamemode!" };
            }

            system.run(() => {
                toggleFly(source);
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /flysettings - Adjust flight speed, drag, fall-damage toggle
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:flysettings",
            description: "Open Fly settings panel",
            permissionLevel: CommandPermissionLevel.GameDirectors,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (!hasTag(source, "op") && !hasTag(source, "admin")) return { status: CustomCommandStatus.Failure, message: "§cYou don't have permission to use this command." };

            system.run(() => {
                showFlySettingsMenu(source);
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:tpaccept (accept pending teleport request)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:tpaccept",
            description: "Accept a pending teleport request",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

            const request = pendingRequests.get(source.name);
            if (!request) return { status: CustomCommandStatus.Failure, message: "§cNo pending teleport request." };

            system.run(() => confirmTeleportRequest(source, request));
            return { status: CustomCommandStatus.Success, message: "Teleport request accepted." };
        }
    );

    // ------------------------------------------------------
    // /zyd:tpdecline, /zyd:tpno, /zyd:tpstop (decline pending request)
    // ------------------------------------------------------
    const declineHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

        const request = pendingRequests.get(source.name);
        if (!request) return { status: CustomCommandStatus.Failure, message: "§cNo pending teleport request." };

        system.run(() => {
            source.sendMessage("§cTeleport request declined.");
            const requester = world.getAllPlayers().find(p => p.name === request.from);
            if (requester) requester.sendMessage("§cYour teleport request has been declined.");
            if (request.timeoutId) system.clearRun(request.timeoutId);
            pendingRequests.delete(source.name);
        });
        return { status: CustomCommandStatus.Success, message: "Teleport request declined." };
    };

    ["zyd:tpdecline", "zyd:tpno", "zyd:tpstop"].forEach(cmd => {
        customCommandRegistry.registerCommand(
            {
                name: cmd,
                description: "Decline a pending teleport request",
                permissionLevel: CommandPermissionLevel.Any,
                cheatsRequired: false,
            },
            declineHandler
        );
    });

    // ------------------------------------------------------
    // ✅ /zyd:rtp (Everyone) - Random Teleport Command
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:rtp",
            description: "Teleport to a random safe location",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("teleport")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => doRandomTeleport(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // ✅ /zyd:deathback (Everyone) - Return to Death Location Command
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:deathback",
            description: "Return to your last death location",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("teleport")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => doDeathBack(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:bal or /zyd:balance (Check own balance)
    // ------------------------------------------------------
    const balHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

        system.run(() => showBalance(source));
        return { status: CustomCommandStatus.Success };
    };

    customCommandRegistry.registerCommand(
        {
            name: "zyd:bal",
            description: "Check your current balance",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        balHandler
    );

    customCommandRegistry.registerCommand(
        {
            name: "zyd:balance",
            description: "Check your current balance",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        balHandler
    );

    // ------------------------------------------------------
    // /zyd:ballist or /zyd:balancelist (List all balances UI)
    // ------------------------------------------------------
    const balListHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };

        system.run(() => showBalanceList(source));
        return { status: CustomCommandStatus.Success };
    };

    customCommandRegistry.registerCommand(
        {
            name: "zyd:baltop",
            description: "View and edit all player balances",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        balListHandler
    );

    customCommandRegistry.registerCommand(
        {
            name: "zyd:balancelist",
            description: "View and edit all player balances",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        balListHandler
    );

    // ======================================================
    // NEW SHORTCUT COMMANDS
    // ======================================================

    // ------------------------------------------------------
    // /zyd:warps (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:warps",
            description: "Open Warps Menu",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("warps")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showWarpsMenu(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:teleport (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:teleports",
            description: "Open Teleport Menu",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("teleport")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showTeleport(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:sethome → Direct to Create New Home
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:sethome",
            description: "Create a new home location",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("sethome")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => {
                import("./sethome.js").then(mod => {
                    if (typeof mod.showCreateHome === "function") mod.showCreateHome(source);
                    else if (typeof mod.showSetHome === "function") mod.showSetHome(source);
                    else source.sendMessage("§cSetHome module not found!");
                }).catch(() => source.sendMessage("§cSetHome module not found!"));
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:homes → Direct to My Homes List
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:homes",
            description: "View your saved homes",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("sethome")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => {
                import("./sethome.js").then(mod => {
                    if (typeof mod.showMyHomes === "function") mod.showMyHomes(source);
                    else if (typeof mod.showSetHome === "function") mod.showSetHome(source);
                    else source.sendMessage("§cSetHome module not found!");
                }).catch(() => source.sendMessage("§cSetHome module not found!"));
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:buyhomes → Direct to Buy More Homes
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:buyhomes",
            description: "Buy more home slots",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("sethome")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => {
                import("./sethome.js").then(mod => {
                    if (typeof mod.showBuyHomes === "function") mod.showBuyHomes(source);
                    else if (typeof mod.showSetHome === "function") mod.showSetHome(source);
                    else source.sendMessage("§cSetHome module not found!");
                }).catch(() => source.sendMessage("§cSetHome module not found!"));
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:kits (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:kits",
            description: "Open Starter Kits",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("kits")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showKits(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:bounty (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:bounty",
            description: "Open Bounty List",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("bounty")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showBountyList(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:sendmoney (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:pay",
            description: "Send money to another player",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("sendmoney")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showSendMoney(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:promo (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:promo",
            description: "Open Promo & Money Codes",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("promocode")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showPromoCode(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:daily (Everyone)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:daily",
            description: "Open Daily Rewards",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !isFeatureEnabled("daily")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showDailyRewards(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ======================================================
    // FACTION COMMANDS (FULLY FUNCTIONAL)
    // ======================================================

    // --- Generic handler: Smart routing to Main UI or My Faction ---
    const factionGenericHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
        if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };

        system.run(() => {
            if (getPlayerFactionId(source.id)) {
                showEditFactionUI(source);
            } else {
                showFactionsMainUI(source);
            }
        });
        return { status: CustomCommandStatus.Success };
    };

    // /zyd:faction, /zyd:factions, /zyd:f — Smart Factions panel routing
    ["zyd:faction", "zyd:factions", "zyd:f"].forEach(cmd => {
        customCommandRegistry.registerCommand(
            { name: cmd, description: "Open the Factions panel", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
            factionGenericHandler
        );
    });

    // /zyd:fcreate — Direct to Create Faction (or error if already in one)
    customCommandRegistry.registerCommand(
        { name: "zyd:fcreate", description: "Create a new faction", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            if (getPlayerFactionId(source.id)) return { status: CustomCommandStatus.Failure, message: "§cYou are already in a faction! Leave your current faction first before creating a new one." };
            system.run(() => showCreateFactionUI(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:ftop & /zyd:factiontop — Direct to Global Faction Ranking
    const factionTopHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
        if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
        system.run(() => showLeaderboardUI(source));
        return { status: CustomCommandStatus.Success };
    };
    customCommandRegistry.registerCommand(
        { name: "zyd:ftop", description: "View global faction rankings", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        factionTopHandler
    );
    customCommandRegistry.registerCommand(
        { name: "zyd:factiontop", description: "View global faction rankings", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        factionTopHandler
    );

    // /zyd:fjoin — Direct to Join Faction search (factionless only)
    customCommandRegistry.registerCommand(
        { name: "zyd:fjoin", description: "Search and request to join a faction", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            if (getPlayerFactionId(source.id)) return { status: CustomCommandStatus.Failure, message: "§cYou are already in a faction! Leave your current faction first before joining another one." };
            system.run(() => showJoinSearchUI(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fally — Direct to Faction Allies panel (must be in a faction)
    customCommandRegistry.registerCommand(
        { name: "zyd:fally", description: "View and manage faction allies", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            if (!getPlayerFactionId(source.id)) return { status: CustomCommandStatus.Failure, message: "§cYou must be in a faction to use this command!" };
            system.run(() => showDiplomacyAlliesUI(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fenemy — Direct to Faction Enemies panel (must be in a faction)
    customCommandRegistry.registerCommand(
        { name: "zyd:fenemy", description: "View and manage faction enemies", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            if (!getPlayerFactionId(source.id)) return { status: CustomCommandStatus.Failure, message: "§cYou must be in a faction to use this command!" };
            system.run(() => showDiplomacyEnemiesUI(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:faccept — Accept the first pending faction invitation
    customCommandRegistry.registerCommand(
        { name: "zyd:faccept", description: "Accept a pending faction invitation", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            if (getPlayerFactionId(source.id)) return { status: CustomCommandStatus.Failure, message: "§cYou are already in a faction! Leave first before accepting an invitation." };

            system.run(() => {
                const pending = getPlayerPendingRequests(source.id);
                if (pending.length === 0) {
                    source.sendMessage("§cYou don't have any pending faction invitations.");
                    return;
                }

                const req = pending[0];
                const factions = world.getDynamicProperty("zyd:factions_data");
                const allFactions = factions ? JSON.parse(factions) : {};
                const faction = allFactions[req.factionId];

                if (!faction) {
                    const newPending = pending.filter(r => r.factionId !== req.factionId);
                    savePlayerPendingRequests(source.id, newPending);
                    source.sendMessage("§cThat faction no longer exists. Invitation removed.");
                    return;
                }

                if (Object.keys(faction.members).length >= faction.maxMembers) {
                    source.sendMessage("§cThat faction is now full. Try again later.");
                    return;
                }

                removePendingRequestsForPlayer(source.id);
                faction.members[source.id] = { role: "member", power: getPlayerSavedPower(source.id), name: source.name, joinedAt: Date.now(), invitedBy: req.inviterName };
                world.setDynamicProperty("zyd:factions_data", JSON.stringify(allFactions));
                world.setDynamicProperty("zyd:fplayer_" + source.id, req.factionId);

                source.sendMessage(`§a§l✔ You joined §f${faction.iconUnicode} ${faction.name}§a!`);
                source.playSound("random.levelup");
                world.sendMessage(`§6[ZYD-FACTIONS] §a${source.name} joined §f${faction.iconUnicode} ${faction.name}§a!`);

                const inviter = world.getAllPlayers().find(p => p.id === req.inviterId);
                if (inviter) inviter.sendMessage(`§a§f${source.name} §aaccepted your faction invitation!`);
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fdeny — Decline the first pending faction invitation
    customCommandRegistry.registerCommand(
        { name: "zyd:fdeny", description: "Decline a pending faction invitation", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };

            system.run(() => {
                const pending = getPlayerPendingRequests(source.id);
                if (pending.length === 0) {
                    source.sendMessage("§cYou don't have any pending faction invitations.");
                    return;
                }

                const req = pending[0];
                const newPending = pending.filter(r => r.factionId !== req.factionId);
                savePlayerPendingRequests(source.id, newPending);

                source.sendMessage(`§cDeclined faction invitation from §f${req.factionIcon} ${req.factionName}§c.`);

                const inviter = world.getAllPlayers().find(p => p.id === req.inviterId);
                if (inviter) inviter.sendMessage(`§c§f${source.name} §cdeclined your faction invitation.`);
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fachievement — Not yet available
    customCommandRegistry.registerCommand(
        { name: "zyd:fachievement", description: "View faction achievements", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            return { status: CustomCommandStatus.Failure, message: "§7[FACTIONS] Achievements are not yet available. Coming soon!" };
        }
    );

    // /zyd:fmap — Toggle the live faction map tracker
    customCommandRegistry.registerCommand(
        { name: "zyd:fmap", description: "Toggle the live faction map tracker", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };

            system.run(() => {
                if (autoMapPlayers.has(source.id)) {
                    autoMapPlayers.delete(source.id);
                    autoMapLastChunk.delete(source.id);
                    source.sendMessage("§7Faction map is now §cDISABLED§7.");
                } else {
                    autoMapPlayers.add(source.id);
                    source.sendMessage("§7Faction map is now §aENABLED§7. Moving around will update your map.");
                    source.sendMessage(generateAsciiMap(source));
                }
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fmapon — Enable the live faction map tracker
    customCommandRegistry.registerCommand(
        { name: "zyd:fmapon", description: "Enable the live faction map tracker", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };

            system.run(() => {
                if (autoMapPlayers.has(source.id)) {
                    source.sendMessage("§eFaction map is already §aENABLED§e.");
                    return;
                }
                autoMapPlayers.add(source.id);
                source.sendMessage("§7Faction map is now §aENABLED§7. Moving around will update your map.");
                source.sendMessage(generateAsciiMap(source));
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fmapoff — Disable the live faction map tracker
    customCommandRegistry.registerCommand(
        { name: "zyd:fmapoff", description: "Disable the live faction map tracker", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };

            system.run(() => {
                if (!autoMapPlayers.has(source.id)) {
                    source.sendMessage("§eFaction map is already §cDISABLED§e.");
                    return;
                }
                autoMapPlayers.delete(source.id);
                autoMapLastChunk.delete(source.id);
                source.sendMessage("§7Faction map is now §cDISABLED§7.");
            });
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fdisband — Disband Faction UI (Owner only)
    customCommandRegistry.registerCommand(
        { name: "zyd:fdisband", description: "Disband your faction", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };

            const factionId = getPlayerFactionId(source.id);
            if (!factionId) return { status: CustomCommandStatus.Failure, message: "§cYou are not in a faction!" };

            const faction = getFactionById(factionId);
            if (!faction || faction.members[source.id]?.role !== "owner") {
                return { status: CustomCommandStatus.Failure, message: "§cOnly the faction owner can disband the faction." };
            }

            system.run(() => showDisbandConfirmUI(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fclaim — Claim the chunk you are standing on (requires Can Claim)
    customCommandRegistry.registerCommand(
        { name: "zyd:fclaim", description: "Claim the current chunk", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            const fid = getPlayerFactionId(source.id);
            if (fid) {
                const fac = getFactionById(fid);
                if (fac && !hasFactionPermission(fac, source.id, "canClaim")) {
                    return { status: CustomCommandStatus.Failure, message: "§cYou do not have permission to claim land! (Requires Can Claim)" };
                }
            }
            system.run(() => executeClaim(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:funclaim — Unclaim the chunk you are standing on (requires Can Claim)
    customCommandRegistry.registerCommand(
        { name: "zyd:funclaim", description: "Unclaim the current chunk", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            const fid = getPlayerFactionId(source.id);
            if (fid) {
                const fac = getFactionById(fid);
                if (fac && !hasFactionPermission(fac, source.id, "canClaim")) {
                    return { status: CustomCommandStatus.Failure, message: "§cYou do not have permission to unclaim land! (Requires Can Claim)" };
                }
            }
            system.run(() => executeUnclaim(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fpower — View your personal power
    customCommandRegistry.registerCommand(
        { name: "zyd:fpower", description: "View your personal power", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showFactionPowerInfo(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:factionsettings or /zyd:fsettings — Global Factions settings UI (OP/Admin only) — also disabled when factions OFF
    const fSettingsHandler = (origin) => {
        const source = origin.initiator ?? origin.sourceEntity;
        if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (!hasTag(source, "op") && !hasTag(source, "admin")) return { status: CustomCommandStatus.Failure, message: "§cYou don't have permission to use this command." };
        if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
        system.run(() => showFactionSettingsUI(source));
        return { status: CustomCommandStatus.Success };
    };

    customCommandRegistry.registerCommand(
        { name: "zyd:factionsettings", description: "Open Global Factions Settings", permissionLevel: CommandPermissionLevel.GameDirectors, cheatsRequired: false },
        fSettingsHandler
    );

    customCommandRegistry.registerCommand(
        { name: "zyd:fsettings", description: "Open Global Factions Settings", permissionLevel: CommandPermissionLevel.GameDirectors, cheatsRequired: false },
        fSettingsHandler
    );

    // /zyd:fsethome — set/relocate faction home (requires Can SetHome)
    customCommandRegistry.registerCommand(
        { name: "zyd:fsethome", description: "Set your Faction Home", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            const fid = getPlayerFactionId(source.id);
            if (fid) {
                const fac = getFactionById(fid);
                if (fac) {
                    const hasPerm = hasFactionPermission(fac, source.id, "canSetHome") || hasFactionPermission(fac, source.id, "manageHome");
                    if (!hasPerm) {
                        return { status: CustomCommandStatus.Failure, message: "§cYou do not have permission to set faction home! (Requires Can SetHome)" };
                    }
                }
            }
            system.run(() => showSetFactionHome(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fhome — teleport to faction home
    customCommandRegistry.registerCommand(
        { name: "zyd:fhome", description: "Teleport to Faction Home", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            system.run(() => showTeleportFactionHome(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // /zyd:fdelhome — delete faction home (requires Can SetHome)
    customCommandRegistry.registerCommand(
        { name: "zyd:fdelhome", description: "Delete Faction Home", permissionLevel: CommandPermissionLevel.Any, cheatsRequired: false },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!isFeatureEnabled("factions")) return { status: CustomCommandStatus.Failure, message: "§cThis feature is currently disabled!" };
            const fid = getPlayerFactionId(source.id);
            if (fid) {
                const fac = getFactionById(fid);
                if (fac) {
                    const hasPerm = hasFactionPermission(fac, source.id, "canSetHome") || hasFactionPermission(fac, source.id, "manageHome");
                    if (!hasPerm) {
                        return { status: CustomCommandStatus.Failure, message: "§cYou do not have permission to delete faction home! (Requires Can SetHome)" };
                    }
                }
            }
            system.run(() => showDeleteFactionHome(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:admin (Admin/OP Tag Only)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:admin",
            description: "Open Admin Panel (Admin/OP only)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op") && !hasTag(source, "admin")) return { status: CustomCommandStatus.Failure, message: "§cYou don't have permission to use this command." };
            system.run(() => showAdminPanel(source));
            return { status: CustomCommandStatus.Success };
        }
    );

    // ------------------------------------------------------
    // /zyd:op (OP Tag Only)
    // ------------------------------------------------------
    customCommandRegistry.registerCommand(
        {
            name: "zyd:operator",
            description: "Open Operator Panel (OP only)",
            permissionLevel: CommandPermissionLevel.Any,
            cheatsRequired: false,
        },
        (origin) => {
            const source = origin.initiator ?? origin.sourceEntity;
            if (!(source instanceof Player)) return { status: CustomCommandStatus.Failure, message: "Players only." };
            if (isBanned(source)) return { status: CustomCommandStatus.Failure, message: "§cYou are banned from using commands." };
            if (!hasTag(source, "op")) return { status: CustomCommandStatus.Failure, message: "§cYou don't have permission to use this command." };
            system.run(() => showOperatorPanel(source));
            return { status: CustomCommandStatus.Success };
        }
    );

});
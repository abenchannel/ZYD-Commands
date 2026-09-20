//scripts/sethome.js
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { system, world } from "@minecraft/server";
import { getChunkOwnerAt } from "./factionsClaims.js";
import { getPlayerFactionId } from "./factionsCore.js";
import {
    getPlayerHomes,
    addHome,
    updateHome,
    deleteHome,
    getAllPlayersWithHomes,
    getSettings,
    saveSettings,
    checkCooldown,
    setCooldown,
    getDimensionName,
    getPlayerLimit,
    setPlayerLimit,
    removePlayerLimit,
    getAllPlayersWithCustomLimits,
    getPurchasedHomesData,
    savePurchasedHomesData,
    getPlayerPurchasedCount,
    incrementPlayerPurchase,
    getNextPurchasePrice,
    formatPrice,
    getMaxPurchasedHomes,
    canPlayerBuyMore,
    getTotalEffectiveMaxHomes,
    HOME_ICONS
} from "./data/sethomedata.js";
import { getBalance, setBalance } from "./operator/currency.js";

const activeTeleports = new Map();

// ============================================
// PLAYER NAME TRACKER (Offline Support)
// ============================================

const knownPlayers = new Map();
let trackerLoaded = false;

function loadPlayerTracker() {
    if (trackerLoaded) return;

    try {
        const data = world.getDynamicProperty("sethome_playertracker");
        if (data) {
            const parsed = JSON.parse(data);
            Object.entries(parsed).forEach(([playerId, info]) => {
                knownPlayers.set(playerId, {
                    name: info.name || "Unknown",
                    lastSeen: info.lastSeen || 0,
                    isOnline: false
                });
            });
        }
        trackerLoaded = true;
        console.log(`[SetHome] Loaded ${knownPlayers.size} tracked players`);
    } catch (e) {
        console.warn("[SetHome] Tracker load error:", e);
        trackerLoaded = true;
    }
}

function savePlayerTracker() {
    try {
        const obj = {};
        knownPlayers.forEach((val, key) => {
            obj[key] = {
                name: val.name,
                lastSeen: val.lastSeen || Date.now(),
                isOnline: val.isOnline || false
            };
        });
        world.setDynamicProperty("sethome_playertracker", JSON.stringify(obj));
    } catch (e) {
        console.error("[SetHome] Tracker save error:", e);
    }
}

function trackPlayer(player) {
    loadPlayerTracker();

    const existing = knownPlayers.get(player.id);
    knownPlayers.set(player.id, {
        name: player.name,
        isOnline: true,
        lastSeen: Date.now()
    });

    if (!existing || existing.name !== player.name) {
        savePlayerTracker();
    }
}

function untrackPlayer(playerId) {
    const data = knownPlayers.get(playerId);
    if (data) {
        data.isOnline = false;
        data.lastSeen = Date.now();
        savePlayerTracker();
    }
}

function getPlayerNameSafe(playerId) {
    try {
        const onlinePlayer = world.getAllPlayers().find(p => p.id === playerId);
        if (onlinePlayer) return onlinePlayer.name;
    } catch (e) { }

    const tracked = knownPlayers.get(playerId);
    return tracked ? tracked.name : "Unknown Player";
}

function isPlayerOnline(playerId) {
    try {
        return world.getAllPlayers().some(p => p.id === playerId);
    } catch (e) {
        return false;
    }
}

// ============================================
// EVENT LISTENERS
// ============================================

world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) {
        trackPlayer(event.player);
    }
});

world.afterEvents.playerLeave.subscribe((event) => {
    untrackPlayer(event.playerId);
});

system.runTimeout(() => {
    loadPlayerTracker();

    knownPlayers.forEach((data, id) => {
        data.isOnline = false;
    });
}, 100);

// ============================================
// HELPER FUNCTIONS
// ============================================

function goBackToMenu(player) {
    import("./menu.js")
        .then(mod => {
            if (typeof mod.showMenu === "function") mod.showMenu(player);
        })
        .catch(err => console.warn("Failed to import menu module:", err));
}

function playSound(player, soundId) {
    try {
        player.runCommand(`playsound ${soundId} @s ~~~ 0.5 0.5`);
    } catch (e) { }
}

function spawnTeleportParticles(dimension, home) {
    try {
        for (let i = 0; i < 15; i++) {
            const offsetX = (Math.random() - 0.5) * 2;
            const offsetY = Math.random() * 1.5;
            const offsetZ = (Math.random() - 0.5) * 2;
            dimension.spawnParticle("minecraft:end_chest", {
                x: home.x + offsetX,
                y: home.y + offsetY,
                z: home.z + offsetZ
            });
        }
    } catch (e) { }
}

// ============================================
// MAIN SET HOME UI
// ============================================

export function showSetHome(player) {
    trackPlayer(player);

    const homes = getPlayerHomes(player.id);
    const settings = getSettings();
    const isOp = player.hasTag("op") || player.hasTag("admin");

    const effectiveMax = getTotalEffectiveMaxHomes(player);
    const maxHomesDisplay = effectiveMax === Infinity ? "\u221e" : effectiveMax;

    const purchasedCount = getPlayerPurchasedCount(player.id);
    const maxPurchase = getMaxPurchasedHomes();

    let bodyText = "§6Welcome to Home Manager §l§e" + player.name + "§r\n\n";
    bodyText += "§b---------------------------\n";
    bodyText += "§eTotal Homes: §a" + homes.length + "§f/§c" + maxHomesDisplay + "\n";
    bodyText += "§ePurchased Slots: §d" + purchasedCount + "§f/§c" + maxPurchase + "\n";
    bodyText += "§b---------------------------\n\n";

    if (homes.length > 0) {
        bodyText += "§6§lYour Homes§f:§r\n";
        homes.forEach((home, i) => {
            bodyText += "  §a" + (i + 1) + ". §f" + home.name + "\n";
        });
        bodyText += "\n";
    } else {
        bodyText += "§7No homes set yet.\n\n";
    }

    bodyText += "§eSelect an option below:";

    const form = new ActionFormData()
        .title("§6§lSet Home")
        .body(bodyText)
        .button("§aSet Home\n§8[ Create New Home ]", "textures/random/claim_0.png")
        .button("§bMy Homes\n§8[ View & Manage ]", "textures/random/claim_10.png")
        .button("§dBuy More Homes\n§8[ Increase Limit ]", "textures/random/marketplace.png");

    if (isOp) {
        form.button("§c[OP] Operator\n§8[ Admin Tools ]", "textures/random/roles.png");
    }

    form.button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            goBackToMenu(player);
            return;
        }

        switch (response.selection) {
            case 0:
                showAddHomeForm(player);
                break;
            case 1:
                if (homes.length === 0) {
                    player.sendMessage("§cYou don't have any homes yet!");
                    showSetHome(player);
                } else {
                    showHomesList(player);
                }
                break;
            case 2:
                showBuyHomesUI(player);
                break;
            case 3:
                if (isOp) {
                    showOperatorPanel(player);
                } else {
                    goBackToMenu(player);
                }
                break;
            default:
                goBackToMenu(player);
                break;
        }
    });
}

// ============================================
// ADD HOME FORM
// ============================================

export function showAddHomeForm(player) {
    const effectiveMax = getTotalEffectiveMaxHomes(player);
    const homes = getPlayerHomes(player.id);

    if (homes.length >= effectiveMax) {
        player.sendMessage("§cYou have reached the maximum limit of " + effectiveMax + " homes!");
        player.sendMessage("§eBuy more slots or contact admin to increase limit.");
        showSetHome(player);
        return;
    }

    const iconOptions = HOME_ICONS.map(icon => icon.name);

    const modal = new ModalFormData()
        .title("§a§lCreate New Home")
        .textField("§eEnter a Name for this Home", "§7Home name required")
        .dropdown(
            "§bSelect Icon",
            iconOptions,
            { defaultValueIndex: 0 }
        )
        .divider()
        .submitButton("§aSubmit");

    modal.show(player).then(response => {
        if (response.canceled) {
            showSetHome(player);
            return;
        }

        const values = response.formValues || [];
        const homeName = (values[0] || "").trim();
        const iconIndex = (typeof values[1] === "number") ? values[1] : 0;

        if (!homeName) {
            player.sendMessage("§cHome name is required!");
            showAddHomeForm(player);
            return;
        }

        if (homeName.length > 20) {
            player.sendMessage("§cHome name too long! Max 20 characters.");
            showAddHomeForm(player);
            return;
        }

        const playerFacId = getPlayerFactionId(player.id);
        const chunkOwner = getChunkOwnerAt(player.location, player.dimension.id);
        if (chunkOwner && chunkOwner !== playerFacId) {
            playSound(player, "note.bass");
            player.sendMessage("§cYou cannot set a home inside another faction's territory!");
            showSetHome(player);
            return;
        }

        const dimId = player.dimension.id;
        const selectedIconData = HOME_ICONS[iconIndex] || HOME_ICONS[0];

        const homeData = {
            name: homeName,
            x: player.location.x,
            y: player.location.y,
            z: player.location.z,
            dimension: dimId,
            icon: selectedIconData.id
        };

        const result = addHome(player.id, homeData);

        if (result.success) {
            player.sendMessage("§a" + result.message);
            player.sendMessage('§6Home "' + homeName + '" created in ' + getDimensionName(dimId));
            playSound(player, "random.orb");
            showSetHome(player);
        } else {
            player.sendMessage("§c" + result.message);
            showAddHomeForm(player);
        }
    });
}

// ============================================
// HOMES LIST
// ============================================

export function showHomesList(player) {
    const homes = getPlayerHomes(player.id);
    const effectiveMax = getTotalEffectiveMaxHomes(player);
    const maxDisplay = effectiveMax === Infinity ? "\u221e" : effectiveMax;

    if (homes.length === 0) {
        player.sendMessage("§cNo homes found!");
        showSetHome(player);
        return;
    }

    const form = new ActionFormData()
        .title("§b§lMy Homes")
        .body("§eSelect a home to manage:\n\n§b--------------------------\n§eTotal Homes: §a" + homes.length + "§f/§6" + maxDisplay + "\n§b--------------------------");

    homes.forEach(home => {
        const iconData = HOME_ICONS.find(i => i.id === home.icon) || HOME_ICONS[0];
        form.button(
            "§8§r" + home.name + "\n§3" + getDimensionName(home.dimension),
            iconData.texture
        );
    });

    form.button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showSetHome(player);
            return;
        }

        if (response.selection === homes.length) {
            showSetHome(player);
            return;
        }

        const selectedHome = homes[response.selection];
        if (selectedHome) {
            showHomeDetails(player, selectedHome);
        }
    });
}

// ============================================
// HOME DETAILS
// ============================================

function showHomeDetails(player, home) {
    const form = new ActionFormData()
        .title("§6§lHome: " + home.name)
        .body(
            "§b--------------------------\n" +
            "§eName: §f" + home.name + "\n" +
            "§eDimension: §b" + getDimensionName(home.dimension) + "\n" +
            "§b--------------------------\n\n" +
            "§eChoose an action:"
        )
        .button("§aTeleport\n§f[ Go to Home ]", "textures/teleport/teleport.png")
        .button("§eEdit\n§f[ Update Location ]", "textures/ranks/manage.png")
        .button("§cDelete\n§f[ Remove Home ]", "textures/rank_colours/red.png")
        .button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showHomesList(player);
            return;
        }

        switch (response.selection) {
            case 0:
                startHomeTeleport(player, home);
                break;
            case 1:
                showEditHomeForm(player, home);
                break;
            case 2:
                showDeleteMyHomeConfirmation(player, home);
                break;
            default:
                showHomesList(player);
                break;
        }
    });
}

function showDeleteMyHomeConfirmation(player, home) {
    const form = new ActionFormData()
        .title("§c§lDelete Home")
        .body(
            "§4WARNING!\n\n" +
            '§cAre you sure you want to delete:\n\n§4"' + home.name + '"§c?\n\n' +
            "§7This action cannot be undone!"
        )
        .button("§c§lYes, Delete It!", "textures/rank_colours/red.png")
        .button("§a§lNo, Keep It", "textures/rank_colours/green.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showHomeDetails(player, home);
            return;
        }

        if (response.selection === 0) {
            const result = deleteHome(player.id, home.id);
            player.sendMessage("§c" + result.message);
            playSound(player, "random.levelup");
            showHomesList(player);
        }
    });
}

function showEditHomeForm(player, home) {
    const currentIconIndex = HOME_ICONS.findIndex(i => i.id === home.icon);
    if (currentIconIndex < 0) currentIconIndex = 0;

    const iconOptions = HOME_ICONS.map(icon => icon.name);

    const modal = new ModalFormData()
        .title("§e§lEdit Home: " + home.name)
        .textField("§eHome Name:", home.name)
        .dropdown(
            "§bChange Icon",
            iconOptions,
            { defaultValueIndex: currentIconIndex }
        )
        .toggle("§eUpdate Location to Current Position?", true)
        .divider()
        .submitButton("§aUpdate");

    modal.show(player).then(response => {
        if (response.canceled) {
            showHomeDetails(player, home);
            return;
        }

        const values = response.formValues || [];
        const newNameRaw = (values[0] || "").trim();
        const newName = newNameRaw || home.name;
        const newIconIndex = (typeof values[1] === "number") ? values[1] : currentIconIndex;
        const shouldUpdateLoc = values[2];

        const updates = {
            name: newName,
            icon: HOME_ICONS[newIconIndex].id || home.icon
        };

        if (shouldUpdateLoc) {
            updates.x = player.location.x;
            updates.y = player.location.y;
            updates.z = player.location.z;
            updates.dimension = player.dimension.id;
        }

        showEditConfirmation(player, home, updates);
    });
}

function showEditConfirmation(player, originalHome, updates) {
    var confirmBody = '§6§lConfirm Update for "' + originalHome.name + '"\n\n';
    confirmBody += "§eNew Name: §a" + updates.name + "\n";

    if (updates.x !== undefined) {
        confirmBody += "§aLocation will be updated to your current position\n";
        confirmBody += "§eDimension: §b" + getDimensionName(updates.dimension) + "\n";
    } else {
        confirmBody += "§7Location: Unchanged\n";
    }

    confirmBody += "\n§eProceed with update?";

    const form = new ActionFormData()
        .title("§6§lConfirm Update")
        .body(confirmBody)
        .button("§a§lYes\n§7[ Confirm ]", "textures/rank_colours/green.png")
        .button("§c§lNo\n§7[ Cancel ]", "textures/rank_colours/red.png");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showHomeDetails(player, originalHome);
            return;
        }

        if (response.selection === 0) {
            if (updates.x !== undefined) {
                const playerFacId = getPlayerFactionId(player.id);
                const chunkOwner = getChunkOwnerAt(player.location, player.dimension.id);
                if (chunkOwner && chunkOwner !== playerFacId) {
                    playSound(player, "note.bass");
                    player.sendMessage("§cYou cannot set a home inside another faction's territory!");
                    showHomeDetails(player, originalHome);
                    return;
                }
            }

            const result = updateHome(player.id, originalHome.id, updates);

            if (result.success) {
                player.sendMessage("§a" + result.message);
                playSound(player, "random.orb");
                showHomesList(player);
            } else {
                player.sendMessage("§c" + result.message);
                showHomeDetails(player, originalHome);
            }
        }
    });
}

// ============================================
// TELEPORT SYSTEM
// ============================================

function startHomeTeleport(player, home) {
    if (activeTeleports.has(player.id)) {
        player.sendMessage("§cYou are already teleporting!");
        return;
    }

    const cooldownCheck = checkCooldown(player.id);
    if (!cooldownCheck.canTeleport) {
        player.sendMessage("§cPlease wait §e" + cooldownCheck.remainingTime + " §cseconds before teleporting again!");
        return;
    }

    const settings = getSettings();
    const countdown = settings.teleportCountdown || 5;

    activeTeleports.set(player.id, true);

    const startPos = {
        x: player.location.x,
        y: player.location.y,
        z: player.location.z
    };

    var secondsLeft = countdown;
    var canceled = false;

    player.onScreenDisplay.setActionBar('§aTeleporting to "§6' + home.name + '§a" in §e' + secondsLeft + 's... §7(Don\'t move!)');

    playSound(player, "note.pling");

    const countdownInterval = system.runInterval(() => {
        secondsLeft--;

        if (secondsLeft > 0) {
            player.onScreenDisplay.setActionBar('§aTeleporting to "§6' + home.name + '§a" in §e' + secondsLeft + 's... §7(Don\'t move!)');

            if (secondsLeft <= 2) {
                playSound(player, "note.pling");
            }
        } else {
            system.clearRun(countdownInterval);
            system.clearRun(movementCheckInterval);

            if (!canceled && activeTeleports.has(player.id)) {
                executeTeleport(player, home);
                activeTeleports.delete(player.id);
                setCooldown(player.id);
            }
        }
    }, 20);

    const movementCheckInterval = system.runInterval(() => {
        if (secondsLeft <= 0.5 || canceled) return;

        const currentPos = player.location;
        const dx = Math.abs(currentPos.x - startPos.x);
        const dy = Math.abs(currentPos.y - startPos.y);
        const dz = Math.abs(currentPos.z - startPos.z);

        const threshold = 0.15;

        if (dx > threshold || dy > threshold || dz > threshold) {
            canceled = true;
            activeTeleports.delete(player.id);
            system.clearRun(countdownInterval);
            system.clearRun(movementCheckInterval);
            player.onScreenDisplay.setActionBar("§cTeleport cancelled! §7(You moved)");
            player.sendMessage("§cTeleport cancelled because you moved!");
            playSound(player, "note.bass");
        }
    }, 5);
}

function executeTeleport(player, home) {
    try {
        const targetDim = world.getDimension(home.dimension || "minecraft:overworld");

        player.teleport(
            { x: home.x + 0.5, y: home.y, z: home.z + 0.5 },
            { dimension: targetDim }
        );

        player.onScreenDisplay.setActionBar('§aTeleported to "§6' + home.name + '§a"!');
        player.sendMessage('§aSuccessfully teleported to "§6' + home.name + '§a"!');

        playSound(player, "random.orb");

        spawnTeleportParticles(targetDim, home);

    } catch (error) {
        player.sendMessage("§cTeleport failed: " + error.message);
        console.error("[SetHome] Teleport error:", error);
    }
}

// ============================================
// BUY MORE HOMES UI
// ============================================

export function showBuyHomesUI(player) {
    const purchaseInfo = canPlayerBuyMore(player.id);
    const nextPrice = getNextPurchasePrice(player.id);
    const priceDisplay = formatPrice(nextPrice);
    const purchasedCount = getPlayerPurchasedCount(player.id);
    const maxPurchase = getMaxPurchasedHomes();
    const currentMax = getTotalEffectiveMaxHomes(player);

    var bodyText = "§dBuy More Homes\n\n";
    bodyText += "§b------------------------\n";
    bodyText += "§eCurrent Stats:\n";
    bodyText += "§eHomes Owned: §a" + getPlayerHomes(player.id).length + "\n";
    bodyText += "§eCurrent Max Limit: §6" + currentMax + "\n";
    bodyText += "§ePurchased Slots: §d" + purchasedCount + "§f/§6" + maxPurchase + "\n";
    bodyText += "§b------------------------\n\n";

    if (purchaseInfo.canBuy) {
        bodyText += "§6§lNext Purchase§f:§r\n";
        bodyText += "§ePrice: §d" + priceDisplay + "\n";
        bodyText += "§aAfter buying: Your max will become §6" + (currentMax + 1) + "\n\n";
        bodyText += "§e§lClick Purchase to buy!§r";
    } else {
        bodyText += "§cMAX PURCHASED REACHED!\n\n";
        bodyText += "§7You have purchased the maximum of §c" + maxPurchase + " §7extra slots.\n";
        bodyText += "§7Contact admin if you need more.";
    }

    let hasEnough = false;
    try {
        const balance = getBalance(player.scoreboardIdentity);
        hasEnough = balance >= nextPrice;
    } catch (e) { }

    const form = new ActionFormData()
        .title("§d§lBuy More Homes")
        .body(bodyText);

    if (purchaseInfo.canBuy) {
        let btnText = "§dPurchase +1 Home Slot\n";
        btnText += hasEnough ? ("§a[ " + priceDisplay + " ]") : "§cInsufficient balance";
        form.button(btnText, "textures/random/marketplace.png");
    }

    form.button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showSetHome(player);
            return;
        }

        if (response.selection === 0 && purchaseInfo.canBuy) {
            processHomePurchase(player);
        } else {
            showSetHome(player);
        }
    });
}

function processHomePurchase(player) {
    const nextPrice = getNextPurchasePrice(player.id);
    const priceDisplay = formatPrice(nextPrice);

    const purchaseInfo = canPlayerBuyMore(player.id);
    if (!purchaseInfo.canBuy) {
        player.sendMessage("§cYou have reached the maximum purchasable slots!");
        showBuyHomesUI(player);
        return;
    }

    var balance = 0;
    try {
        balance = getBalance(player.scoreboardIdentity);
    } catch (e) {
        player.sendMessage("§cCould not read your balance!");
        showBuyHomesUI(player);
        return;
    }

    if (balance < nextPrice) {
        const needed = nextPrice - balance;
        player.sendMessage("§cInsufficient balance!");
        player.sendMessage("§eYou need §a" + formatPrice(nextPrice) + " §ebut only have §a" + formatPrice(balance));
        player.sendMessage("§eYou need §c" + formatPrice(needed) + " §emore.");
        showBuyHomesUI(player);
        return;
    }

    try {
        setBalance(player.scoreboardIdentity, balance - nextPrice);
    } catch (e) {
        player.sendMessage("§cTransaction failed! Could not deduct money.");
        showBuyHomesUI(player);
        return;
    }

    const newCount = incrementPlayerPurchase(player.id);
    const newMax = getTotalEffectiveMaxHomes(player);

    player.sendMessage("§a=========================");
    player.sendMessage("§d§lPURCHASE SUCCESSFUL!");
    player.sendMessage("§a=========================");
    player.sendMessage("§eYou bought §a+1 Home Slot§e!");
    player.sendMessage("§ePrice Paid: §c-" + priceDisplay);
    player.sendMessage("§eNew Total Purchased: §d" + newCount);
    player.sendMessage("§eYour new max homes: §6" + newMax);
    player.sendMessage("§eRemaining Balance: §a" + formatPrice(balance - nextPrice));

    playSound(player, "random.levelup");
    playSound(player, "random.orb");

    showSetHome(player);
}

// ============================================
// OPERATOR PANEL
// ============================================

function showOperatorPanel(player) {
    const form = new ActionFormData()
        .title("§c§lHome Operator Panel")
        .body(
            "§4Admin Tools\n\n" +
            "§eManage all player homes:\n\n" +
            "§b* Player List §7- View/Edit/Delete any player's homes\n" +
            "§b* Home Settings §7- Configure limits and rules"
        )
        .button("§ePlayer List\n§8[ Manage Players' Homes ]", "textures/random/manage_members.png")
        .button("§6Home Settings\n§8[ Configure Limits ]", "textures/settings.png")
        .button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showSetHome(player);
            return;
        }

        switch (response.selection) {
            case 0:
                showPlayerListPanel(player);
                break;
            case 1:
                showHomeSettings(player);
                break;
            default:
                showSetHome(player);
                break;
        }
    });
}

// ============================================
// PLAYER LIST PANEL (Shows OFFLINE players!)
// ============================================

function showPlayerListPanel(player) {
    loadPlayerTracker();

    const allPlayersWithHomes = getAllPlayersWithHomes();

    const enhancedPlayerList = allPlayersWithHomes.map(p => {
        const playerId = p.playerId || p.id;

        const trackedName = knownPlayers.get(playerId)?.name;

        const online = isPlayerOnline(playerId);

        return {
            playerId: playerId,
            playerName: trackedName || p.playerName || p.name || "Unknown",
            homes: p.homes || [],
            isOnline: online,
            lastSeen: knownPlayers.get(playerId)?.lastSeen || null
        };
    });

    if (enhancedPlayerList.length === 0) {
        const form = new ActionFormData()
            .title("§e§lPlayer List")
            .body("§7No players have set any homes yet.")
            .button("§l§cBack§r", "textures/back.png");

        form.show(player).then(response => {
            showOperatorPanel(player);
        });
        return;
    }

    enhancedPlayerList.sort((a, b) => {
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return a.playerName.localeCompare(b.playerName);
    });

    const form = new ActionFormData()
        .title("§e§lPlayer List")
        .body(
            "§eFound §a" + enhancedPlayerList.length + " §eplayers with homes:\n\n" +
            "§a● Online  §c● Offline\n\n" +
            "§7Click a player to manage their homes."
        );

    enhancedPlayerList.forEach(function (p) {
        var statusText = p.isOnline ? "§a[Online]" : "§c[Offline]";
        var statusColor = p.isOnline ? "green" : "red";

        var extraInfo = "";
        if (!p.isOnline && p.lastSeen) {
            const timeAgo = getTimeAgo(p.lastSeen);
            extraInfo = "\n§7Last seen: " + timeAgo;
        }

        form.button(
            "§f" + p.playerName + "\n§eHomes: §b" + p.homes.length + " " + statusText + extraInfo,
            "textures/rank_colours/" + statusColor + ".png"
        );
    });

    form.button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showOperatorPanel(player);
            return;
        }

        if (response.selection === enhancedPlayerList.length) {
            showOperatorPanel(player);
            return;
        }

        const selectedPlayer = enhancedPlayerList[response.selection];
        if (selectedPlayer) {
            showPlayerHomesDetail(player, selectedPlayer);
        }
    });
}

// ============================================
// HELPER: Format timestamp as "time ago"
// ============================================

function getTimeAgo(timestamp) {
    if (!timestamp) return "Unknown";

    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes < 60) return minutes + "m ago";
    if (hours < 24) return hours + "h ago";
    return days + "d ago";
}

// ============================================
// PLAYER HOMES DETAIL (OPERATOR)
// ============================================

function showPlayerHomesDetail(operator, targetPlayer) {
    const settings = getSettings();
    const customLimit = getPlayerLimit(targetPlayer.playerId);
    const displayLimit = customLimit !== null ? customLimit : settings.maxHomes;
    const limitLabel = customLimit !== null ? "§d(Custom)" : "§6(Global)";
    const purchasedCount = getPlayerPurchasedCount(targetPlayer.playerId);

    const form = new ActionFormData()
        .title("§6§l" + targetPlayer.playerName + "'s Homes")
        .body(
            "§b--------------------------\n" +
            "§eManaging homes for: §f" + targetPlayer.playerName + "\n" +
            "§eStatus: " + (targetPlayer.isOnline ? "§aOnline" : "§cOffline") + "\n" +
            "§eTotal Homes: §b" + targetPlayer.homes.length + "\n" +
            "§eBase Limit: §6" + displayLimit + " " + limitLabel + "\n" +
            "§ePurchased Slots: §d" + purchasedCount + "\n" +
            "§eEffective Max: §a" + getTotalEffectiveMaxHomes(targetPlayer) + "\n" +
            "§b--------------------------\n\n" +
            "§eSelect a home:"
        );

    targetPlayer.homes.forEach(function (home) {
        const iconData = HOME_ICONS.find(function (i) { return i.id === home.icon; }) || HOME_ICONS[0];
        form.button(
            "§f" + home.name + "\n§7" + getDimensionName(home.dimension),
            iconData.texture
        );
    });

    form.button("§l§cBack§r", "textures/back.png");

    form.show(operator).then(response => {
        if (response.canceled) {
            showPlayerListPanel(operator);
            return;
        }

        if (response.selection === targetPlayer.homes.length) {
            showPlayerListPanel(operator);
            return;
        }

        const selectedHome = targetPlayer.homes[response.selection];
        if (selectedHome) {
            showOperatorHomeActions(operator, targetPlayer, selectedHome);
        }
    });
}

// ============================================
// OPERATOR HOME ACTIONS
// ============================================

function showOperatorHomeActions(operator, targetPlayer, home) {
    const form = new ActionFormData()
        .title("§6§lManage: " + home.name)
        .body(
            "§b--------------------------\n" +
            "§eOwner: §f" + targetPlayer.playerName + "\n" +
            "§eHome: §6" + home.name + "\n" +
            "§eDimension: §b" + getDimensionName(home.dimension) + "\n" +
            "§b--------------------------\n\n" +
            "§eChoose action:"
        )
        .button("§aTeleport\n§f[ Go to this Home ]", "textures/teleport/teleport.png")
        .button("§eEdit\n§f[ Modify Home ]", "textures/ranks/manage.png")
        .button("§cDelete\n§f[ Remove Home ]", "textures/rank_colours/red.png")
        .button("§l§cBack§r", "textures/back.png");

    form.show(operator).then(response => {
        if (response.canceled) {
            showPlayerHomesDetail(operator, targetPlayer);
            return;
        }

        switch (response.selection) {
            case 0:
                startHomeTeleport(operator, home);
                break;
            case 1:
                showOperatorEditHome(operator, targetPlayer, home);
                break;
            case 2:
                showDeleteConfirmation(operator, targetPlayer, home);
                break;
            default:
                showPlayerHomesDetail(operator, targetPlayer);
                break;
        }
    });
}

function showOperatorEditHome(operator, targetPlayer, home) {
    var currentIconIndex = HOME_ICONS.findIndex(function (i) { return i.id === home.icon; });
    if (currentIconIndex < 0) currentIconIndex = 0;

    const iconOptions = HOME_ICONS.map(function (icon) { return icon.name; });

    const modal = new ModalFormData()
        .title("§e§lEdit: " + home.name)
        .textField("§eHome Name:", home.name)
        .dropdown(
            "§bChange Icon",
            iconOptions,
            { defaultValueIndex: currentIconIndex }
        )
        .toggle("§eUpdate to Your Current Position?", false)
        .divider()
        .submitButton("§aUpdate");

    modal.show(operator).then(response => {
        if (response.canceled) return;

        const values = response.formValues || [];
        const newNameRaw = (values[0] || "").trim();
        const newName = newNameRaw || home.name;
        const newIconIdx = (typeof values[1] === "number") ? values[1] : currentIconIndex;
        const updateToMyLoc = values[2];

        const updates = {
            name: newName,
            icon: HOME_ICONS[newIconIdx].id || home.icon
        };

        if (updateToMyLoc) {
            updates.x = operator.location.x;
            updates.y = operator.location.y;
            updates.z = operator.location.z;
            updates.dimension = operator.dimension.id;
        }

        showOperatorEditConfirm(operator, targetPlayer, home, updates);
    });
}

function showOperatorEditConfirm(operator, targetPlayer, originalHome, updates) {
    const form = new ActionFormData()
        .title("§6§lConfirm Changes")
        .body(
            "§eUpdating §f" + targetPlayer.playerName + "§e's home:\n\n" +
            "§eName: §a" + updates.name + "\n" +
            "§eDimension: §b" + getDimensionName(updates.dimension) + "\n\n" +
            "§eConfirm?"
        )
        .button("§a§lYes", "textures/rank_colours/green.png")
        .button("§c§lNo", "textures/rank_colours/red.png");

    form.show(operator).then(response => {
        if (response.canceled || response.selection === 1) {
            showOperatorHomeActions(operator, targetPlayer, originalHome);
            return;
        }

        const result = updateHome(targetPlayer.playerId, originalHome.id, updates);
        operator.sendMessage("§a" + result.message);
        playSound(operator, "random.orb");

        const onlineTarget = world.getAllPlayers().find(function (p) { return p.id === targetPlayer.playerId; });
        if (onlineTarget) {
            onlineTarget.sendMessage("§6" + operator.name + " §emodified your home '§a" + updates.name + "§e'!");
        }

        showPlayerHomesDetail(operator, targetPlayer);
    });
}

function showDeleteConfirmation(operator, targetPlayer, home) {
    const form = new ActionFormData()
        .title("§c§lDELETE CONFIRMATION")
        .body(
            "§4WARNING!\n\n" +
            '§cAre you sure you want to delete:\n\n§4"' + home.name + '" §cfrom §f' + targetPlayer.playerName + "?\n\n" +
            "§eDimension: §b" + getDimensionName(home.dimension) + "\n\n" +
            "§cThis action CANNOT be undone!"
        )
        .button("§c§lYes, Delete It!", "textures/rank_colours/red.png")
        .button("§a§lNo, Keep It", "textures/rank_colours/green.png");

    form.show(operator).then(response => {
        if (response.canceled || response.selection === 1) {
            showOperatorHomeActions(operator, targetPlayer, home);
            return;
        }

        if (response.selection === 0) {
            const result = deleteHome(targetPlayer.playerId, home.id);
            operator.sendMessage("§c" + result.message);
            playSound(operator, "random.break");

            const onlineTarget = world.getAllPlayers().find(function (p) { return p.id === targetPlayer.playerId; });
            if (onlineTarget) {
                onlineTarget.sendMessage('§cYour home "§4' + result.homeName + '§c" was deleted by §6' + operator.name + "§c!");
            }

            showPlayerHomesDetail(operator, targetPlayer);
        }
    });
}

// ============================================
// HOME SETTINGS
// ============================================

function showHomeSettings(player) {
    const currentSettings = getSettings();
    const currentMaxHomes = Number.isInteger(currentSettings.maxHomes) ? currentSettings.maxHomes : 2;
    const currentMaxPurchased = Number.isInteger(currentSettings.maxPurchasedHomes) ? currentSettings.maxPurchasedHomes : 3;
    const currentCountdown = Number.isInteger(currentSettings.teleportCountdown) ? currentSettings.teleportCountdown : 5;
    const currentCooldown = Number.isInteger(currentSettings.teleportCooldown) ? currentSettings.teleportCooldown : 10;
    const currentOpBypass = currentSettings.opBypassLimit !== false;

    const form = new ActionFormData()
        .title("§6§lHome Settings")
        .body(
            "§eConfiguration Panel\n\n" +
            "§b-----------------------\n" +
            "§eCurrent Global Settings:\n\n" +
            "§eMax Homes (Default): §6" + currentMaxHomes + "\n" +
            "§eMax Purchased Homes: §d" + currentMaxPurchased + "\n" +
            "§eTeleport Countdown: §b" + currentCountdown + "s\n" +
            "§eTeleport Cooldown: §b" + currentCooldown + "s\n" +
            "§eOP Bypass Limit: " + (currentOpBypass ? "§aYes" : "§cNo") + "\n" +
            "§b-----------------------\n\n" +
            "§eClick an option to change:"
        )
        .button("§8Default Max Homes: §6" + currentMaxHomes, "textures/random/manage_all_claims.png")
        .button("§8Max Purchased Homes: §d" + currentMaxPurchased, "textures/random/get_for_sale_sign.png")
        .button("§8Countdown: §b" + currentCountdown + "s", "textures/random/realm_settings.png")
        .button("§8Cooldown: §b" + currentCooldown + "s", "textures/random/realm_settings.png")
        .button("§8OP Bypass: " + (currentOpBypass ? "§aEnabled" : "§cDisabled"), "textures/random/roles.png")
        .button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showOperatorPanel(player);
            return;
        }

        switch (response.selection) {
            case 0:
                showMaxHomesSubUI(player);
                break;
            case 1:
                showTextInputSetting(player, "maxPurchasedHomes", "Max Purchased Homes", "§eCurrent: §d" + currentMaxPurchased + " §7| Enter value (0-100)", "3", 0, 100);
                break;
            case 2:
                showTextInputSetting(player, "teleportCountdown", "Teleport Countdown", "§eCurrent: §b" + currentCountdown + " §7| Enter value (1-30)", "5", 1, 30);
                break;
            case 3:
                showTextInputSetting(player, "teleportCooldown", "Teleport Cooldown", "§eCurrent: §b" + currentCooldown + " §7| Enter value (0-120)", "10", 0, 120);
                break;
            case 4:
                const newBypass = !currentOpBypass;
                saveSettings(Object.assign({}, currentSettings, { opBypassLimit: newBypass }));
                player.sendMessage("§eOP Bypass Limit: " + (newBypass ? "§aEnabled" : "§cDisabled"));
                playSound(player, "random.click");
                showHomeSettings(player);
                break;
            default:
                showOperatorPanel(player);
                break;
        }
    });
}

// ============================================
// MAX HOMES SUBUI
// ============================================

function showMaxHomesSubUI(player) {
    const settings = getSettings();
    const globalMax = settings.maxHomes || 2;

    const form = new ActionFormData()
        .title("§6§lMax Homes Configuration")
        .body(
            "§eChoose what type of limit to edit:\n\n" +
            "§b--------------------------\n" +
            "§eCurrent Global Default: §6" + globalMax + " §ehomes\n" +
            "§b--------------------------\n\n" +
            "§a* Edit Default Homes Limit §7- Changes the base limit for ALL players\n\n" +
            "§b* Edit Player Homes Limit §7- Sets a fixed limit for SPECIFIC player\n\n" +
            "§7Note: Players who bought extra slots keep their bonuses.\n" +
            "§7Custom manual limits override both global + purchases."
        )
        .button("§aEdit Default Homes Limit\n§8[ Global Base Setting ]", "textures/random/manage_all_claims.png")
        .button("§bEdit Player Homes Limit\n§8[ Custom Per-Player ]", "textures/random/manage_members.png")
        .button("§l§cBack§r", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) {
            showHomeSettings(player);
            return;
        }

        switch (response.selection) {
            case 0:
                showTextInputSetting(player, "maxHomes", "Default Homes Limit (Global)", "§eCurrent: §6" + globalMax + " §7| Enter value (1-100)", "2", 1, 100);
                break;
            case 1:
                showSelectPlayerForLimit(player);
                break;
            default:
                showHomeSettings(player);
                break;
        }
    });
}

// ============================================
// SELECT PLAYER FOR CUSTOM LIMIT
// ============================================

function showSelectPlayerForLimit(admin) {
    const allPlayers = world.getAllPlayers();

    if (allPlayers.length === 0) {
        admin.sendMessage("§cNo players online!");
        showMaxHomesSubUI(admin);
        return;
    }

    const form = new ActionFormData()
        .title("§e§lSelect Player")
        .body("§eSelect a player to set a custom home limit:");

    allPlayers.forEach(function (p) {
        const currentLimit = getPlayerLimit(p.id);
        const limitDisplay = currentLimit !== null ? String(currentLimit) : String(getSettings().maxHomes);

        form.button(
            "§f" + p.name + "\n§eCurrent Limit: §6" + limitDisplay,
            "textures/rank_colours/green.png"
        );
    });

    form.button("§l§cBack§r", "textures/back.png");

    form.show(admin).then(response => {
        if (response.canceled) {
            showMaxHomesSubUI(admin);
            return;
        }

        if (response.selection === allPlayers.length) {
            showMaxHomesSubUI(admin);
            return;
        }

        const selectedPlayer = allPlayers[response.selection];
        if (selectedPlayer) {
            showEditPlayerLimitInput(admin, selectedPlayer);
        }
    });
}

// ============================================
// EDIT PLAYER LIMIT INPUT
// ============================================

function showEditPlayerLimitInput(admin, targetPlayer) {
    const currentLimit = getPlayerLimit(targetPlayer.id);
    const displayCurrent = currentLimit !== null ? String(currentLimit) : String(getSettings().maxHomes);

    const form = new ModalFormData()
        .title("§e§lEdit Player Limit: " + targetPlayer.name)
        .textField(
            "§eEnter max homes for §f" + targetPlayer.name,
            "§eCurrent: §6" + displayCurrent + " §7| Numbers only (1-100)"
        )
        .submitButton("§aSubmit");

    form.show(admin).then(response => {
        if (response.canceled) {
            showSelectPlayerForLimit(admin);
            return;
        }

        const inputValue = (response.formValues[0] || "").trim();

        if (!inputValue || inputValue.length === 0) {
            admin.sendMessage("§cInput cannot be empty! Please enter a number.");
            showEditPlayerLimitInput(admin, targetPlayer);
            return;
        }

        if (!/^\d+$/.test(inputValue)) {
            admin.sendMessage("§cInvalid input! Numbers only please.");
            showEditPlayerLimitInput(admin, targetPlayer);
            return;
        }

        const parsedValue = parseInt(inputValue);

        if (parsedValue < 1 || parsedValue > 100) {
            admin.sendMessage("§cValue must be between 1 and 100!");
            showEditPlayerLimitInput(admin, targetPlayer);
            return;
        }

        setPlayerLimit(targetPlayer.id, parsedValue);

        admin.sendMessage("§a=========================");
        admin.sendMessage("§aSuccess! §f" + targetPlayer.name + "§e's home limit is now: §6" + parsedValue);
        admin.sendMessage("§7This player now has a custom limit (unaffected by global changes or purchases).");
        admin.sendMessage("§a=========================");
        playSound(admin, "random.levelup");

        try {
            targetPlayer.sendMessage("§6" + admin.name + " §eset your home limit to: §6" + parsedValue);
        } catch (e) { }

        system.runTimeout(function () {
            showSelectPlayerForLimit(admin);
        }, 30);
    });
}

// ============================================
// TEXT INPUT SETTING
// ============================================

function showTextInputSetting(player, settingKey, title, placeholder, defaultValue, minValue, maxValue) {
    const form = new ModalFormData()
        .title("§6§l" + title)
        .textField(
            "§eEnter Value (§b" + minValue + " - " + maxValue + "§e)",
            placeholder
        )
        .submitButton("§aSubmit");

    form.show(player).then(response => {
        if (response.canceled) {
            showHomeSettings(player);
            return;
        }

        const inputValue = (response.formValues[0] || "").trim();

        if (!inputValue || inputValue.length === 0) {
            player.sendMessage("§cInput cannot be empty! Please enter a number.");
            showTextInputSetting(player, settingKey, title, placeholder, defaultValue, minValue, maxValue);
            return;
        }

        if (!/^\d+$/.test(inputValue)) {
            player.sendMessage("§cInvalid input! Numbers only please.");
            showTextInputSetting(player, settingKey, title, placeholder, defaultValue, minValue, maxValue);
            return;
        }

        const parsedValue = parseInt(inputValue);

        if (parsedValue < minValue || parsedValue > maxValue) {
            player.sendMessage("§cValue must be between §e" + minValue + " §cand §e" + maxValue + "!");
            showTextInputSetting(player, settingKey, title, placeholder, defaultValue, minValue, maxValue);
            return;
        }

        const settings = getSettings();
        const updatedSettings = Object.assign({}, settings);
        updatedSettings[settingKey] = parsedValue;
        saveSettings(updatedSettings);

        const settingNames = {
            maxHomes: "§eDefault Max Homes (Global)",
            maxPurchasedHomes: "§eMax Purchased Homes",
            teleportCountdown: "§eTeleport Countdown",
            teleportCooldown: "§eTeleport Cooldown"
        };

        player.sendMessage("§a" + settingNames[settingKey] + " §eset to: §6" + parsedValue);
        playSound(player, "random.levelup");

        system.runTimeout(function () {
            showHomeSettings(player);
        }, 20);
    });
}

// ============================================
// ✅ ALIAS EXPORTS FOR SHORTCUT COMMANDS
// These map the function names that main.js
// is looking for to the actual functions
// ============================================

export { showAddHomeForm as showCreateHome, showHomesList as showMyHomes, showBuyHomesUI as showBuyHomes };

console.log("✅ [SetHome] Enhanced version with offline player support loaded!");
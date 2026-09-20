// scripts/bal.js
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { world, system } from "@minecraft/server";
import { getBalance, setBalance, getBalanceMax, getBalanceParticipants } from "./operator/currency.js";

const MAX_MONEY = getBalanceMax(); // 9 Quadrillion Limit (safe integer cap, chunked across 2 objectives)

// ============================================
// BALANCE UI FORMATTER (Guaranteed Commas & Clean Suffix)
// ============================================

// Custom function to FORCE commas regardless of device language
function forceCommas(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatBalanceUI(value) {
    if (value === undefined || value === null || isNaN(value)) return "$0";

    // Force integer to remove any weird .9999 decimals from the system
    let num = Math.floor(Math.abs(parseFloat(value)));
    if (num === 0) return "$0";

    let isNegative = parseFloat(value) < 0;
    if (num > MAX_MONEY) num = MAX_MONEY;

    // Main string with FORCED commas (e.g. 11,334)
    let mainStr = forceCommas(num);
    let shortStr = "";

    if (num >= 1000000000000000) {
        let val = Math.floor(num / 100000000000000) / 10;
        shortStr = val + "Qa";
    } else if (num >= 1000000000000) {
        let val = Math.floor(num / 100000000000) / 10;
        shortStr = val + "T";
    } else if (num >= 1000000000) {
        let val = Math.floor(num / 100000000) / 10;
        shortStr = val + "B";
    } else if (num >= 1000000) {
        let val = Math.floor(num / 100000) / 10;
        shortStr = val + "M";
    } else if (num >= 10000) {
        let val = Math.floor(num / 1000);
        shortStr = val + "k";
    } else {
        return (isNegative ? "-" : "") + "$" + mainStr;
    }

    return (isNegative ? "-" : "") + "$" + mainStr + " §7(" + shortStr + ")§e";
}

// ============================================
// PLAYER NAME TRACKER & BALANCE SAVER (Offline Support)
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

world.afterEvents.playerSpawn.subscribe((event) => {
    if (event.initialSpawn) {
        loadData();
        const oldData = knownPlayers.get(event.player.id);
        knownPlayers.set(event.player.id, {
            name: event.player.name,
            isOnline: true,
            lastBalance: oldData ? oldData.lastBalance : 0
        });
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

function saveData() {
    try {
        const obj = {};
        knownPlayers.forEach((val, key) => { obj[key] = val; });
        world.setDynamicProperty("simpleplayerlist", JSON.stringify(obj));
    } catch (e) { }
}

// ============================================
// BALANCE CHECK (For zyd:bal)
// ============================================
export function showBalance(player) {
    const balance = getBalance(player.scoreboardIdentity);
    player.sendMessage("§eBalance: §a" + formatBalanceUI(balance));
}

// ============================================
// BALANCE LIST UI (For zyd:ballist)
// ============================================
export function showBalanceList(player) {
    loadData();

    const onlineNow = world.getAllPlayers();
    const onlineNames = new Set(onlineNow.map(p => p.name));

    const rawParticipants = getBalanceParticipants();
    const balanceMap = new Map();

    // 1. Process existing scoreboard participants (MERGE DUPLICATES!)
    for (let idx = 0; idx < rawParticipants.length; idx++) {
        const p = rawParticipants[idx];
        let score = 0;
        try { score = getBalance(p); } catch (e) { continue; }

        let playerName = null;
        const entryId = p.id || "";
        const displayName = p.displayName || "";

        if (entryId && knownPlayers.has(entryId)) {
            playerName = knownPlayers.get(entryId).name;
        }
        if (!playerName && displayName && knownPlayers.has(displayName)) {
            playerName = knownPlayers.get(displayName).name;
        }
        if (!playerName && displayName) {
            const cleanDisplay = displayName.replace(/§./g, "").trim();
            if (cleanDisplay && cleanDisplay !== "offlinePlayer" && cleanDisplay !== "*" && cleanDisplay.indexOf("commands.scoreboard") === -1) {
                knownPlayers.forEach((data, uuid) => {
                    if (!playerName && data.name === cleanDisplay) {
                        playerName = data.name;
                    }
                });
            }
        }
        if (!playerName && displayName && /^[a-zA-Z0-9_ ]{3,16}$/.test(displayName)) {
            playerName = displayName;
        }

        if (!playerName) continue;

        if (balanceMap.has(playerName)) {
            const existing = balanceMap.get(playerName);
            existing.score = Math.max(existing.score, score);
        } else {
            balanceMap.set(playerName, {
                name: playerName,
                score: score,
                isOnline: false,
                isSelf: (playerName === player.name),
                identity: p
            });
        }
    }

    // 2. Use currently online players as the ABSOLUTE TRUTH & update their last known balance
    for (const onlinePlayer of onlineNow) {
        let score = 0;
        try { score = getBalance(onlinePlayer.scoreboardIdentity); } catch (e) { }

        if (balanceMap.has(onlinePlayer.name)) {
            balanceMap.get(onlinePlayer.name).isOnline = true;
            balanceMap.get(onlinePlayer.name).score = score;
            balanceMap.get(onlinePlayer.name).identity = onlinePlayer.scoreboardIdentity;
        } else {
            balanceMap.set(onlinePlayer.name, {
                name: onlinePlayer.name,
                score: score,
                isOnline: true,
                isSelf: (onlinePlayer.name === player.name),
                identity: onlinePlayer.scoreboardIdentity
            });
        }

        const trackedData = knownPlayers.get(onlinePlayer.id);
        if (trackedData) {
            trackedData.lastBalance = score;
        }
    }
    saveData();

    // 3. Add tracked OFFLINE players (Fallback to lastBalance)
    knownPlayers.forEach((data, id) => {
        if (!balanceMap.has(data.name)) {
            balanceMap.set(data.name, {
                name: data.name,
                score: data.lastBalance || 0,
                isOnline: false,
                isSelf: (data.name === player.name),
                identity: null
            });
        } else {
            const mapData = balanceMap.get(data.name);
            if (!mapData.isOnline && data.lastBalance > mapData.score) {
                mapData.score = data.lastBalance;
            }
        }
    });

    const participantData = Array.from(balanceMap.values());

    // SORT: Highest to Lowest Balance
    participantData.sort((a, b) => b.score - a.score);

    // Cap at Top 100 players
    const displayList = participantData.slice(0, 100);

    let bodyText = "§7Top 100 Player Balances:§f\n\n";

    for (let i = 0; i < displayList.length; i++) {
        const target = displayList[i];
        let colorCode = "§c"; // Light Red for Offline
        if (target.isSelf) {
            colorCode = "§9"; // Blue for You
        } else if (target.isOnline) {
            colorCode = "§a"; // Green for Online
        }

        bodyText += `${i + 1}. ${colorCode}${target.name} §f- ${formatBalanceUI(target.score)}§r\n`;
    }

    const form = new ActionFormData()
        .title("§e§lPlayer Balances")
        .body(bodyText);

    if (player.hasTag("op")) {
        form.button("§aEdit Balance\n§f[ OP Exclusive ]", "textures/money.png");
    }

    form.button("§bSearch Player\n§f[ Check Balance ]", "textures/search.png");
    form.button("§cExit", "textures/exit.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let btnIndex = 0;

        if (player.hasTag("op") && response.selection === btnIndex) {
            showEditBalanceUI(player, participantData);
            return;
        }
        if (player.hasTag("op")) btnIndex++;

        if (response.selection === btnIndex) {
            showSearchPlayerUI(player, participantData);
            return;
        }
    });
}

// ============================================
// SEARCH PLAYER UI
// ============================================
function showSearchPlayerUI(player, fullList) {
    const form = new ModalFormData()
        .title("§b§lSearch Player Balance")
        .textField("§eEnter Player Name", "Type exact name...")
        .submitButton("§aSearch");

    form.show(player).then(response => {
        if (response.canceled) return;

        const searchQuery = (response.formValues[0] || "").trim().toLowerCase();

        if (!searchQuery) {
            player.sendMessage("§cNo name entered.");
            return;
        }

        let foundPlayers = [];

        for (const pData of fullList) {
            if (pData.name.toLowerCase() === searchQuery) {
                foundPlayers.push(pData);
            }
        }

        if (foundPlayers.length === 0) {
            player.sendMessage("§cNo player with that name exists or spelling is incorrect.");
        } else {
            for (const found of foundPlayers) {
                player.sendMessage(`§e${found.name} Balance: §a${formatBalanceUI(found.score)}`);
            }
        }
    });
}

// ============================================
// EDIT BALANCE UI (OP EXCLUSIVE - ONLINE ONLY)
// ============================================
function showEditBalanceUI(player, playerList) {
    if (!player.hasTag("op")) {
        player.sendMessage("§cOnly operators can edit balances.");
        return;
    }

    const onlinePlayers = playerList.filter(p => p.isOnline);

    if (onlinePlayers.length === 0) {
        player.sendMessage("§cNo online players available to edit.");
        return;
    }

    onlinePlayers.sort((a, b) => a.name.localeCompare(b.name));

    const selfIndex = onlinePlayers.findIndex(p => p.isSelf);
    if (selfIndex !== -1) {
        const myData = onlinePlayers.splice(selfIndex, 1)[0];
        onlinePlayers.unshift(myData);
    }

    // UPDATED: Green color for current balance, exact value only (no k/M/B suffix)
    const playerNames = onlinePlayers.map(p => {
        const balText = "§a$" + forceCommas(p.score); // Green color and exact commas only
        if (p.isSelf) return "§9" + p.name + " (You) - " + balText;
        return "§a" + p.name + " - " + balText;
    });

    const form = new ModalFormData()
        .title("§a§lEdit Balance")
        .dropdown("§eSelect Player", playerNames)
        .dropdown("§6Action", ["§eSet", "§aAdd", "§cTake"])
        .textField("§6Amount §7(Number)", "Enter amount...")
        .submitButton("§aUpdate Balance");

    form.show(player).then(response => {
        if (response.canceled) {
            showBalanceList(player);
            return;
        }

        if (!player.hasTag("op")) return;

        const selectedIndex = response.formValues[0];
        const actionIndex = response.formValues[1];
        const amountInput = response.formValues[2];
        const amount = parseInt(amountInput);

        const selectedData = onlinePlayers[selectedIndex];

        const targetPlayer = world.getAllPlayers().find(p => p.name === selectedData.name);
        if (!targetPlayer) {
            player.sendMessage(`§cPlayer '${selectedData.name}' is no longer online. Edit cancelled.`);
            showBalanceList(player);
            return;
        }

        if (isNaN(amount) || amount < 0) {
            player.sendMessage("§cPlease enter a valid positive number.");
            showEditBalanceUI(player, playerList);
            return;
        }

        let currentBalance = 0;
        try { currentBalance = getBalance(targetPlayer.scoreboardIdentity); } catch (e) { }

        let newBalance = currentBalance;

        if (actionIndex === 0) {
            newBalance = Math.min(amount, MAX_MONEY);
        } else if (actionIndex === 1) {
            newBalance = currentBalance + amount;
            if (newBalance > MAX_MONEY) newBalance = MAX_MONEY;
        } else if (actionIndex === 2) {
            newBalance = currentBalance - amount;
            if (newBalance < 0) newBalance = 0;
        }

        try {
            setBalance(targetPlayer.scoreboardIdentity, newBalance);

            const trackedData = knownPlayers.get(targetPlayer.id);
            if (trackedData) trackedData.lastBalance = newBalance;
            saveData();

            player.sendMessage(`§aSuccessfully updated §e${targetPlayer.name}'s §abalance. Their balance is now §6${formatBalanceUI(newBalance)}§a.`);

            targetPlayer.sendMessage(`§eYour balance has been updated by an operator. New balance: §a${formatBalanceUI(newBalance)}`);

        } catch (e) {
            player.sendMessage("§cFailed to set balance. An unexpected error occurred.");
        }
    });
}
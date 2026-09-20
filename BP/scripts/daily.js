// scripts/daily.js
import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { showMenu } from "./menu.js";
import { getBalance, setBalance } from "./operator/currency.js";

// ==========================================
// 1. DATA PERSISTENCE & CONFIG
// ==========================================

const STORAGE_KEY = "daily_debug_state_v1";
const REWARD_CONFIG_KEY = "daily_reward_config_v4";
const PLAYER_DATA_KEY = "daily_rewards_player_data_v1";

const actionBarSubs = new Set();
let debugData = {};

// ==========================================
// REWARD CONFIGURATION (MONEY ONLY)
// ==========================================

let rewardConfig = {
    base: 500,
    bonus: "50"
};

// ==========================================
// PLAYER DATA (Claim Tracking)
// ==========================================

let playerDataDB = {};

// ==========================================
// LOADING DATA
// ==========================================

function loadDebugData() {
    try {
        const raw = world.getDynamicProperty(STORAGE_KEY);
        if (raw) {
            debugData = JSON.parse(raw);
            Object.keys(debugData).forEach(id => {
                if (debugData[id]) {
                    actionBarSubs.add(id);
                }
            });
        }
    } catch (e) { console.warn("Error loading debug data: " + e); }
}

function loadRewardConfig() {
    try {
        const raw = world.getDynamicProperty(REWARD_CONFIG_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            if (saved.base !== undefined) rewardConfig.base = saved.base;
            if (saved.bonus !== undefined) rewardConfig.bonus = saved.bonus;
        }
    } catch (e) { console.warn("Error loading reward config: " + e); }
}

function loadPlayerData() {
    try {
        const raw = world.getDynamicProperty(PLAYER_DATA_KEY);

        // FIX: Handle empty string "" which causes JSON.parse to fail
        if (raw && typeof raw === 'string' && raw.length > 0) {
            playerDataDB = JSON.parse(raw);
        } else {
            // If data is empty or invalid, ensure we have a clean object
            playerDataDB = {};
        }
    } catch (e) {
        console.warn("Error loading player data (Resetting to prevent loops): " + e);
        playerDataDB = {}; // Reset to prevent infinite claim loops if data is corrupted
    }
}

function saveDebugData() {
    try { world.setDynamicProperty(STORAGE_KEY, JSON.stringify(debugData)); }
    catch (e) { console.warn("Error saving debug data: " + e); }
}

function saveRewardConfig() {
    try { world.setDynamicProperty(REWARD_CONFIG_KEY, JSON.stringify(rewardConfig)); }
    catch (e) { console.warn("Error saving reward config: " + e); }
}

function savePlayerData() {
    try {
        console.log("Saving player data..."); // Debug 1
        const json = JSON.stringify(playerDataDB);
        console.log("Player Data String: " + json); // Debug 2
        world.setDynamicProperty(PLAYER_DATA_KEY, json);
        console.log("Data saved successfully!"); // Debug 3
    }
    catch (e) {
        console.error("Error saving player data: " + e);
        playerDataDB = {}; // Reset to stop loops
    }
}

system.run(() => {
    loadDebugData();
    loadRewardConfig();
    loadPlayerData();
});

// ==========================================
// 2. AUTO-CLAIM SYSTEM
// ==========================================

world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;

    // Delay slightly
    system.run(() => {
        processAutoClaim(event.player);
    });
});

function processAutoClaim(player) {
    try {
        const pid = player.id;

        // 1. Get Manila Time
        const now = new Date();
        const manilaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));

        const currentMonth = manilaTime.getMonth() + 1;
        const currentDayNum = manilaTime.getDate();
        const currentYear = manilaTime.getFullYear();

        const todayStr = `${currentYear}-${currentMonth}-${currentDayNum}`;

        console.log(`Processing claim for ${player.name}. Today is: ${todayStr}`); // Debug 4

        // 2. Get Player Data (Safe Init)
        let pData = playerDataDB[pid];
        if (!pData || typeof pData.lastClaimed === 'undefined') {
            console.warn(`[Daily Rewards] New player detected: ${player.name}`);
            playerDataDB[pid] = { lastClaimed: "", streak: 0 };
            pData = playerDataDB[pid];
        }

        // 3. Check Tags
        const isTestMode = player.hasTag("test");
        if (isTestMode) {
            console.warn(`[Daily Rewards] ${player.name} is in TEST MODE.`);
        }

        // 4. CLAIM CHECK
        // Safety: If lastClaimed is not a string, return (Corruption check)
        if (typeof pData.lastClaimed !== 'string') {
            console.warn("Data corruption: lastClaimed is not a string. Blocking claim.");
            return;
        }

        // If data matches today AND we are not in test mode -> STOP.
        if (pData.lastClaimed === todayStr && !isTestMode) {
            console.warn(`[Daily Rewards] ${player.name} already claimed today. (${todayStr})`); // Debug 5
            return;
        }

        // 5. Calculate & Give Money
        const reward = calculateReward(currentDayNum);
        // FIX: Use player.name as fallback if scoreboardIdentity is undefined on first join
        if (!player.scoreboardIdentity) {
            console.warn(`[Daily Rewards] ${player.name} identity not ready yet. Skipping reward for 1 second.`);
            system.runTimeout(() => processAutoClaim(player), 20); // Retry after 1 second
            return;
        }
        const targetIdentity = player.scoreboardIdentity;
        const currentMoney = getBalance(targetIdentity);
        setBalance(targetIdentity, currentMoney + reward);

        // 6. Update Data (Only if not test mode)
        if (!isTestMode) {
            pData.lastClaimed = todayStr;
            pData.streak++;
            savePlayerData();
        } else {
            player.sendMessage("§e[Daily Rewards] §fTest Mode: §cClaimed without saving date.");
        }

        // 7. Notify Player (Clear values as requested)
        player.playSound("random.levelup");
        player.sendMessage("§a[Daily Rewards] §fYou claimed §e$" + reward + " §ffrom §fDay " + currentDayNum);
        player.sendMessage("§7Come back tomorrow!");

    } catch (e) {
        console.warn("Auto-claim error: " + e);
        player.sendMessage("§cAn error occurred while claiming rewards.");
    }
}

// ==========================================
// 3. HELPER: CALCULATE REWARD
// ==========================================

function calculateReward(day) {
    const base = rewardConfig.base;
    const bonusInput = rewardConfig.bonus.toString();

    if (bonusInput.includes("%")) {
        const percentage = parseFloat(bonusInput.replace("%", "")) / 100;
        let rawReward = base * Math.pow((1 + percentage), (day - 1));
        return Math.floor(rawReward);
    } else {
        const bonus = parseInt(bonusInput) || 0;
        return base + ((day - 1) * bonus);
    }
}

// ==========================================
// 4. ACTION BAR LOOP
// ==========================================

const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

system.runInterval(() => {
    try {
        const now = new Date();
        const manilaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));

        const hours = manilaTime.getHours();
        const minutes = manilaTime.getMinutes();
        const month = manilaTime.getMonth() + 1;
        const dayNum = manilaTime.getDate();
        const year = manilaTime.getFullYear();
        const dayName = dayNames[manilaTime.getDay()];

        const ampm = hours >= 12 ? " PM" : " AM";
        let h12 = hours % 12;
        h12 = h12 ? h12 : 12;
        const hStr = h12 < 10 ? "0" + h12 : h12;
        const mStr = minutes < 10 ? "0" + minutes : minutes;

        const actionBarText =
            `§6§lTIME: §f${hStr}:${mStr}${ampm}   ` +
            `§b§lDATE: §f${month}/${dayNum}/${year}   ` +
            `§e§lDAY: §f${dayName}`;

        const players = world.getAllPlayers();
        for (const player of players) {
            if (actionBarSubs.has(player.id)) {
                player.onScreenDisplay.setActionBar(actionBarText);
            }
        }
    } catch (error) { }
}, 20);

// ==========================================
// 5. MAIN DAILY REWARDS UI
// ==========================================

export function showDailyRewards(player) {
    const now = new Date();
    const manilaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));

    const currentHours = manilaTime.getHours();
    const currentMin = manilaTime.getMinutes();
    const currentMonth = manilaTime.getMonth() + 1;
    const currentDayNum = manilaTime.getDate();
    const currentYear = manilaTime.getFullYear();
    const currentDayName = dayNames[manilaTime.getDay()];
    const ampm = currentHours >= 12 ? "PM" : "AM";
    let h12 = currentHours % 12;
    h12 = h12 ? h12 : 12;

    const todayStr = `${currentYear}-${currentMonth}-${currentDayNum}`;

    const pid = player.id;
    const pData = playerDataDB[pid] || { lastClaimed: "" };
    const isTodayClaimed = pData.lastClaimed === todayStr;

    const infoBody =
        `§7Select a day to view rewards:\n` +
        `§eBase: §f$${rewardConfig.base} | §eBonus: §f${rewardConfig.bonus}`;

    const form = new ActionFormData()
        .title("§6§lDaily Rewards")
        .body(infoBody);

    const isOp = player.hasTag("op");

    if (isOp) {
        form.button("§c§lAdmin Settings", "textures/commands.png");
    }

    for (let i = 1; i <= 31; i++) {
        let btnText = `Day ${i}`;
        let btnColor = "";

        if (i === currentDayNum) {
            // TODAY
            if (isTodayClaimed) {
                btnText = `§eDay ${i} (Claimed)`;
                btnColor = "§e";
            } else {
                btnText = `§aDay ${i} (Today)`;
                btnColor = "§a";
            }
        } else if (i === currentDayNum + 1) {
            // TOMORROW
            btnText = `§aDay ${i} (Tomorrow)`;
            btnColor = "§a";
        } else if (i < currentDayNum) {
            // PAST / MISSED
            btnText = `§cDay ${i} (Missed)`;
            btnColor = "§c";
        } else {
            // FUTURE
            const daysLeft = i - currentDayNum;
            btnText = `§fDay ${i} (${daysLeft} Days Left)`;
        }

        form.button(btnText, `textures/numbers/${i}.png`);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then((response) => {
        if (response.canceled) {
            showMenu(player);
            return;
        }

        let startIndex = 0;

        if (isOp) {
            if (response.selection === 0) {
                showDailySettings(player);
                return;
            }
            startIndex = 1;
        }

        const backIndex = startIndex + 31;

        if (response.selection === backIndex) {
            showMenu(player);
            return;
        }

        const dayClicked = (response.selection - startIndex) + 1;
        showDayRewardDetails(player, dayClicked);
    });
}

// ==========================================
// 5.1 DAY REWARD DETAILS UI
// ==========================================

function showDayRewardDetails(player, dayNum) {
    const moneyReward = calculateReward(dayNum);
    const isOp = player.hasTag("op");

    const form = new ActionFormData()
        .title(`§6§lDay ${dayNum} Reward`)
        .body(`§7Money Reward: §e$${moneyReward}\n\n§7This reward will be granted automatically upon joining.`)
        .button("§cBack", "textures/back.png");

    form.show(player).then((response) => {
        if (response.canceled || response.selection === 0) {
            showDailyRewards(player);
            return;
        }
    });
}

// ==========================================
// 6. SETTINGS UI (OP ONLY)
// ==========================================

function showDailySettings(player) {
    const id = player.id;
    const isSubscribed = debugData[id] === true;
    const statusColor = isSubscribed ? "§aON" : "§cOFF";
    const statusText = isSubscribed ? "Disable" : "Enable";

    const form = new ActionFormData()
        .title("§c§lDaily Settings")
        .body("§7Admin Tools")
        .button(`§bLive Date: ${statusColor}\n§7${statusText}`, "")
        .button(`§6Base Price\n§7Day 1 Money`, "")
        .button(`§eBonus/Increase\n§7${rewardConfig.bonus}`, "")
        .button("§cBack", "textures/back.png");

    form.show(player).then((response) => {
        if (response.canceled) {
            showDailyRewards(player);
            return;
        }

        if (response.selection === 3) {
            showDailyRewards(player);
        } else if (response.selection === 2) {
            showRewardBonus(player);
        } else if (response.selection === 1) {
            showRewardBasePrice(player);
        } else {
            toggleDateDebug(player);
            showDailySettings(player);
        }
    });
}

// ==========================================
// 7. BASE PRICE UI
// ==========================================

function showRewardBasePrice(player) {
    const form = new ModalFormData()
        .title("§6§lSet Base Price")
        .textField("§eBase Reward (Day 1 Money)", "500", { defaultValue: rewardConfig.base.toString() });

    form.show(player).then((response) => {
        if (response.canceled) {
            showDailySettings(player);
            return;
        }

        const inputBase = response.formValues[0];
        const newBase = parseInt(inputBase);

        if (isNaN(newBase) || newBase < 0) {
            player.sendMessage("§cInvalid Base Price!");
            showRewardBasePrice(player);
            return;
        }

        rewardConfig.base = newBase;
        saveRewardConfig();

        player.sendMessage("§a[Daily Rewards] §fBase Price set to §e$" + newBase);

        showDailySettings(player);
    });
}

// ==========================================
// 7.1 BONUS SETTINGS UI
// ==========================================

function showRewardBonus(player) {
    const form = new ModalFormData()
        .title("§e§lSet Bonus")
        .textField("§eIncrease (e.g. 250 or 50%)", "250", { defaultValue: rewardConfig.bonus.toString() });

    form.show(player).then((response) => {
        if (response.canceled) {
            showDailySettings(player);
            return;
        }

        const inputBonus = response.formValues[0];
        const newBonus = inputBonus.trim();

        if (newBonus === "") {
            player.sendMessage("§cBonus cannot be empty!");
            showRewardBonus(player);
            return;
        }

        rewardConfig.bonus = newBonus;
        saveRewardConfig();

        const day1 = calculateReward(1);
        const day2 = calculateReward(2);
        const day3 = calculateReward(3);
        const day4 = calculateReward(4);

        player.sendMessage("§a[Daily Rewards] §fBonus set to §e" + newBonus);
        player.sendMessage(`§ePreview: §fDay 1 ($${day1}) > Day 2 ($${day2}) > Day 3 ($${day3})`);

        showDailySettings(player);
    });
}

// ==========================================
// 8. HELPER FUNCTIONS
// ==========================================

function toggleDateDebug(player) {
    const id = player.id;

    const isOn = debugData[id] === true;

    if (isOn) {
        debugData[id] = false;
        actionBarSubs.delete(id);
        player.onScreenDisplay.setActionBar("");
        player.sendMessage("§c[Daily Rewards] §fLive Date Count §lOFF");
    } else {
        debugData[id] = true;
        actionBarSubs.add(id);
        player.sendMessage("§a[Daily Rewards] §fLive Date Count §lON");
    }

    saveDebugData();
}
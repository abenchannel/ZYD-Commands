// scripts/factionsCore.js
// ============================================
// FACTIONS CORE — Foundation & Social Systems
// ============================================
// Contains:
// - Faction data structures & storage
// - Faction creation
// - Faction editing (status, description, disband)
// - Role system (Owner > Admin > Moderator > Member)
// - Member management (join, leave, kick, role assignment)
// - Edit permission toggle system
// - Pending invite/request system
// - Power calculation helpers
// - Ally/Enemy relations (placeholder)
// - Leaderboard (placeholder)
// ============================================

import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { world, system } from "@minecraft/server";
import { FACTION_ICONS } from "./factionIcons.js";
import { getChunkOwnerAt } from "./factionsClaims.js";

// ============================================
// SECTION 1: CONSTANTS
// ============================================

export const FACTIONS_DATA_KEY = "zyd:factions_data";
const FACTION_PLAYER_PREFIX = "zyd:fplayer_";
export const POWER_REGEN_PREFIX = "zyd:fpower_regen_";
const FACTION_INVITE_EXPIRE_MS = 600000; // 10 minutes for player invites
const JOIN_REQUEST_EXPIRE_MS = 600000; // 10 minutes for faction join requests
const DIPLOMACY_REQUEST_EXPIRE_MS = 600000; // 10 minutes for ally/peace requests

const FACTION_ROLES = {
    OWNER: "owner",
    ADMIN: "admin",
    MODERATOR: "moderator",
    MEMBER: "member"
};

const DEFAULT_PERMISSIONS = {
    admin: {
        setStatus: true, editDesc: true, manageHome: true, canSetHome: true, canClaim: true, viewMembers: true,
        inviteMembers: true, manageRequests: true, editRoles: true, kickMembers: true,
        manageSettings: false, viewDiplomacy: true, manageDiplomacy: true, disband: false,
        canBreak: true, canPlace: true, canOpenContainers: true, canUseDoors: true
    },
    moderator: {
        setStatus: false, editDesc: false, manageHome: false, canSetHome: false, canClaim: false, viewMembers: true,
        inviteMembers: false, manageRequests: false, editRoles: false, kickMembers: false,
        manageSettings: false, viewDiplomacy: true, manageDiplomacy: false, disband: false,
        canBreak: false, canPlace: false, canOpenContainers: false, canUseDoors: true
    },
    member: {
        setStatus: false, editDesc: false, manageHome: false, canSetHome: false, canClaim: false, viewMembers: true,
        inviteMembers: false, manageRequests: false, editRoles: false, kickMembers: false,
        manageSettings: false, viewDiplomacy: true, manageDiplomacy: false, disband: false,
        canBreak: false, canPlace: false, canOpenContainers: false, canUseDoors: true
    }
};

// Chunk perms storage key (shared with factionsClaims.js)
const CHUNK_PERMS_KEY = "zyd:chunk_perms";

function _getChunkPermsMapDirect() {
    try {
        const raw = world.getDynamicProperty(CHUNK_PERMS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}
function _saveChunkPermsMapDirect(map) {
    try { world.setDynamicProperty(CHUNK_PERMS_KEY, JSON.stringify(map)); } catch (e) { }
}
function removePlayerFromAllChunkPerms(factionId, playerId) {
    try {
        const map = _getChunkPermsMapDirect();
        let changed = false;
        for (const key in map) {
            const data = map[key];
            if (!data) continue;
            if (data.factionId === factionId && Array.isArray(data.allowedMembers)) {
                const before = data.allowedMembers.length;
                data.allowedMembers = data.allowedMembers.filter(id => id !== playerId);
                if (data.allowedMembers.length !== before) changed = true;
            }
        }
        if (changed) _saveChunkPermsMapDirect(map);
    } catch (e) { }
}
function deleteAllChunkPermsForFaction(factionId) {
    try {
        const map = _getChunkPermsMapDirect();
        let changed = false;
        for (const key in map) {
            if (map[key] && map[key].factionId === factionId) {
                delete map[key];
                changed = true;
            }
        }
        if (changed) _saveChunkPermsMapDirect(map);
    } catch (e) { }
}

export function hasFactionPermission(faction, playerId, permKey) {
    const member = faction.members[playerId];
    if (!member) return false;
    if (member.role === FACTION_ROLES.OWNER) return true; // Owner always has all access

    // Legacy support for the old "editPermission" toggle
    if (member.editPermission && (permKey === "inviteMembers" || permKey === "kickMembers")) return true;

    // Check faction-specific permissions, fallback to defaults
    const factionPerms = faction.permissions || DEFAULT_PERMISSIONS;
    const rolePerms = factionPerms[member.role] || DEFAULT_PERMISSIONS[member.role];

    return !!rolePerms[permKey];
}

// ============================================
// CONFIGURABLE LIMITS - Easy to adjust for testing
// ============================================
export const DEFAULT_MAX_MEMBERS = 10;           // Default max members per faction
export const MAX_MEMBERS_LIMIT = 20;             // Absolute max members limit
export const MAX_PENDING_REQUESTS_PER_FACTION = 10;  // Max pending requests per faction
export const MAX_PENDING_INVITATIONS_PER_PLAYER = 10; // Max pending invitations a player can have
export const MAX_ALLIES = 10;                        // Max allies per faction
export const MAX_ENEMIES = 10;                       // Max enemies per faction
export const MAX_ALLY_PENDING_REQUESTS = 10;         // Max incoming ally requests per faction
export const MAX_PEACE_REQUESTS = 10;                // Max incoming peace requests per faction
export const DEFAULT_PLAYER_POWER = 0;          // Default power when player joins world
export const MIN_POWER_PER_MEMBER = -10;        // Minimum power a member can have
export const MAX_POWER_PER_MEMBER = 10;         // Maximum power a member can have

// ============================================
// OTHER CONSTANTS
// ============================================
const FACTION_NAME_MAX = 15;
const FACTION_DESC_MAX = 50;
export const POWER_REGEN_MS = 600000; // 10 minutes
export const DEATH_POWER_LOSS = 2;
const CLAIM_POWER_RATIO = 2;
const FACTION_DISBAND_CD_MS = 3600000; // 1 hour
const FACTION_DISBAND_CD_PREFIX = "zyd:fdisband_cd_";
const FACTION_STATUS_BROADCAST_CD_MS = 3600000; // 60 minutes
const FACTION_STATUS_BROADCAST_CD_PREFIX = "zyd:fstatus_bcast_cd_";
const FACTION_STATUS_BCAST_COUNT_PREFIX = "zyd:fstatus_bcast_cnt_";
const PENDING_REQUEST_PREFIX = "zyd:fpending_";

// ============================================
// FACTIONS TOGGLE CHECK (no circular import)
// ============================================
const FEATURE_TOGGLES_KEY_CORE = "zyd:feature_toggles";
function isFactionsEnabledCore() {
    try {
        const raw = world.getDynamicProperty(FEATURE_TOGGLES_KEY_CORE);
        if (raw) {
            const toggles = JSON.parse(raw);
            if (toggles.factions === false) return false;
        }
    } catch (e) { }
    return true;
}

function isFactionsDisabledMessage(player) {
    try { player.sendMessage("§cFactions are currently disabled!"); } catch (e) { }
}
const PLAYER_SAVED_POWER_PREFIX = "zyd:fplayer_power_";
const PLAYER_REGISTRY_KEY = "zyd:player_registry";

function getAllKnownPlayers() {
    try {
        const raw = world.getDynamicProperty(PLAYER_REGISTRY_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { }
    return {};
}

export function getPlayerSavedPower(playerId) {
    try {
        const val = world.getDynamicProperty(PLAYER_SAVED_POWER_PREFIX + playerId);
        if (val !== null && val !== undefined && val !== "") return val;
    } catch (e) { }
    return DEFAULT_PLAYER_POWER;
}

export function savePlayerSavedPower(playerId, power) {
    try {
        world.setDynamicProperty(PLAYER_SAVED_POWER_PREFIX + playerId, power);
    } catch (e) { }
}

function removePlayerSavedPower(playerId) {
    try {
        world.setDynamicProperty(PLAYER_SAVED_POWER_PREFIX + playerId, "");
    } catch (e) { }
}

// ============================================
// SECTION 2: DATA STORAGE HELPERS
// ============================================

function generateFactionId() {
    return "fac_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
}

export function getAllFactions() {
    try {
        const raw = world.getDynamicProperty(FACTIONS_DATA_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) { console.warn("[FactionsCore] Failed to load factions data:", e); }
    return {};
}

export function saveAllFactions(factions) {
    try {
        world.setDynamicProperty(FACTIONS_DATA_KEY, JSON.stringify(factions));
    } catch (e) { console.warn("[FactionsCore] Failed to save factions data:", e); }
}

export function getFactionById(factionId) {
    const factions = getAllFactions();
    return factions[factionId] || null;
}

export function getPlayerFactionId(playerId) {
    try {
        const val = world.getDynamicProperty(FACTION_PLAYER_PREFIX + playerId);
        if (val && val !== "") return val;
    } catch (e) { }
    return null;
}

export function getPlayerFaction(playerId) {
    const factionId = getPlayerFactionId(playerId);
    if (!factionId) return null;
    return getFactionById(factionId);
}

function setPlayerFaction(playerId, factionId) {
    try {
        if (factionId) {
            world.setDynamicProperty(FACTION_PLAYER_PREFIX + playerId, factionId);
        } else {
            world.setDynamicProperty(FACTION_PLAYER_PREFIX + playerId, "");
        }
    } catch (e) { console.warn("[FactionsCore] Failed to set player faction:", e); }
}

export function getFactionDisplay(playerId) {
    if (!isFactionsEnabledCore()) return "";
    const faction = getPlayerFaction(playerId);
    if (!faction) return "";
    const iconUnicode = faction.iconUnicode || "";
    const factionName = faction.name || "";
    if (!iconUnicode && !factionName) return "";
    return `${iconUnicode} ${factionName} `;
}

// Player pending invite storage
function getPlayerPendingRequests(playerId) {
    try {
        const raw = world.getDynamicProperty(PENDING_REQUEST_PREFIX + playerId);
        if (raw) return JSON.parse(raw);
    } catch (e) { }
    return [];
}

function savePlayerPendingRequests(playerId, requests) {
    try {
        world.setDynamicProperty(PENDING_REQUEST_PREFIX + playerId, JSON.stringify(requests));
    } catch (e) { }
}

// ============================================
// SECTION 3: POWER CALCULATION HELPERS
// ============================================

export function calculateFactionPower(faction) {
    let total = 0;
    for (const id in faction.members) {
        const power = faction.members[id].power || 0;
        if (power > 0) {
            total += Math.min(power, MAX_POWER_PER_MEMBER);
        }
    }
    return total;
}

// ============================================
// SECTION 4: VALIDATION & UTILITY HELPERS
// ============================================

function stripColorCodes(str) {
    return str.replace(/§[0-9a-fk-or]/gi, "").trim();
}

function isFactionNameTaken(name) {
    const factions = getAllFactions();
    const lower = stripColorCodes(name).toLowerCase();
    for (const id in factions) {
        if (stripColorCodes(factions[id].name).toLowerCase() === lower) return true;
    }
    return false;
}

function isValidFactionName(name) {
    if (!name || name.trim().length === 0) return false;
    if (name.trim().length < 3) return false;
    if (name.length > FACTION_NAME_MAX) return false;
    if (!/^[a-zA-Z0-9_ ]+$/.test(name)) return false;
    return true;
}

function isValidFactionDescription(desc) {
    if (!desc || desc.trim().length === 0) return true;
    if (desc.length > FACTION_DESC_MAX) return false;
    return true;
}

function capitalizeFirst(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function getRoleColor(role) {
    switch (role) {
        case FACTION_ROLES.OWNER: return "§a";
        case FACTION_ROLES.ADMIN: return "§e";
        case FACTION_ROLES.MODERATOR: return "§c";
        case FACTION_ROLES.MEMBER: return "§f";
        default: return "§f";
    }
}

function getRoleIcon(role) {
    switch (role) {
        case FACTION_ROLES.OWNER: return "textures/rank_colours/green.png";
        case FACTION_ROLES.ADMIN: return "textures/rank_colours/yellow.png";
        case FACTION_ROLES.MODERATOR: return "textures/rank_colours/red.png";
        case FACTION_ROLES.MEMBER: return "textures/rank_colours/gray.png";
        default: return "textures/rank_colours/gray.png";
    }
}

function getPowerPercentColor(percent) {
    if (percent >= 100) return "§b";
    if (percent >= 61) return "§a";
    if (percent >= 31) return "§e";
    if (percent >= 1) return "§6";
    return "§c";
}

function formatJoinDate(timestamp) {
    if (!timestamp) return "Unknown";
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// ============================================
// SECTION 5: ROLE & PERMISSION HELPERS
// ============================================

function canManageMembers(role, memberData) {
    if (role === FACTION_ROLES.OWNER || role === FACTION_ROLES.ADMIN) return true;
    if (memberData && memberData.editPermission === true) return true;
    return false;
}

function canManageMember(myRole, targetRole, isSelf) {
    if (isSelf) return false;
    if (myRole === FACTION_ROLES.OWNER) return true;
    if (myRole === FACTION_ROLES.ADMIN) {
        return targetRole === FACTION_ROLES.MODERATOR || targetRole === FACTION_ROLES.MEMBER;
    }
    return false;
}

function getRoleEditOptions(myRole, targetRole) {
    if (myRole === FACTION_ROLES.OWNER) {
        return [
            { label: "Give Ownership", value: FACTION_ROLES.OWNER },
            { label: "Give Admin", value: FACTION_ROLES.ADMIN },
            { label: "Give Moderator", value: FACTION_ROLES.MODERATOR },
            { label: "Make Member", value: FACTION_ROLES.MEMBER }
        ].filter(o => o.value !== targetRole);
    }
    if (myRole === FACTION_ROLES.ADMIN) {
        if (targetRole !== FACTION_ROLES.MODERATOR && targetRole !== FACTION_ROLES.MEMBER) return [];
        const opts = [];
        if (targetRole !== FACTION_ROLES.MODERATOR) opts.push({ label: "Give Moderator", value: FACTION_ROLES.MODERATOR });
        if (targetRole !== FACTION_ROLES.MEMBER) opts.push({ label: "Make Member", value: FACTION_ROLES.MEMBER });
        return opts;
    }
    return [];
}

// ============================================
// SECTION 6: PENDING REQUESTS CLEANUP
// ============================================

function getPlayerActiveJoinRequestsCount(factions, playerId) {
    let count = 0;
    const now = Date.now();
    for (const id in factions) {
        if (factions[id].pendingRequests) {
            // Clean expired first to ensure accuracy
            factions[id].pendingRequests = factions[id].pendingRequests.filter(r => (now - r.timestamp) < JOIN_REQUEST_EXPIRE_MS);
            if (factions[id].pendingRequests.some(r => r.playerId === playerId)) count++;
        }
    }
    return count;
}

export function removePendingRequestsForPlayer(playerId) {
    try {
        const factions = getAllFactions();
        let changed = false;
        for (const id in factions) {
            if (factions[id].pendingRequests && factions[id].pendingRequests.length > 0) {
                const before = factions[id].pendingRequests.length;
                factions[id].pendingRequests = factions[id].pendingRequests.filter(r => r.playerId !== playerId);
                if (factions[id].pendingRequests.length < before) changed = true;
            }
        }
        if (changed) saveAllFactions(factions);
    } catch (e) { }
    try {
        savePlayerPendingRequests(playerId, []);
    } catch (e) { }
}

// ============================================
// SECTION 7: NAVIGATION HELPER
// ============================================

function goBackToMenu(player) {
    import("./menu.js").then(mod => {
        if (typeof mod.showMenu === "function") mod.showMenu(player);
    }).catch(() => { player.sendMessage("§cFailed to return to menu."); });
}

// ============================================
// SECTION 8: MAIN FACTION UI (ENTRY POINT)
// ============================================

export function showFactionsMainUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const faction = getPlayerFaction(player.id);

    let bodyText = "";

    if (faction) {
        const memberCount = Object.keys(faction.members).length;
        const memberRole = faction.members[player.id]?.role || "member";

        bodyText += "§7Your Faction: §f" + faction.name + "\n";
        bodyText += "§7Role: " + getRoleColor(memberRole) + capitalizeFirst(memberRole) + "\n";
        bodyText += "§7Members: §f" + memberCount + "/" + faction.maxMembers + "\n";
        bodyText += "§7Your Power: §b" + (faction.members[player.id]?.power || 0) + "/" + MAX_POWER_PER_MEMBER + "\n";
    } else {
        bodyText += "§cYou are not in a faction.\n";
        bodyText += "§7Your Power: §b" + getPlayerSavedPower(player.id) + "/" + MAX_POWER_PER_MEMBER + "\n";
        bodyText += "§7Select §aCreate Faction §7to form one.\n";
    }

    const form = new ActionFormData()
        .title("§6§lFactions")
        .body(bodyText);

    form.button("§bLeaderboard\n§f[ View faction rankings ]", "textures/list.png");

    if (!faction) {
        form.button("§aCreate Faction\n§f[ Form a new faction ]", "textures/factions/fcreate.png");
        form.button("§eJoin Faction\n§f[ Search & Request ]", "textures/tpa2.png");
    } else {
        const facIconImg = faction.iconTexture || "textures/factions/faction.png";
        form.button("§eMy Faction\n§f[ " + faction.name + "§f ]", facIconImg);
    }

    if (!faction) {
        const pendingReqs = getPlayerPendingRequests(player.id);
        if (pendingReqs.length > 0) {
            form.button("§dPending Invitation\n§f[ " + pendingReqs.length + "/10 ]", "textures/exclamation.png");
        }
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let btnIdx = 0;
        const leaderboardIdx = btnIdx++;

        if (!faction) {
            const createIdx = btnIdx++;
            const joinIdx = btnIdx++;
            const pendingReqIdx = (getPlayerPendingRequests(player.id).length > 0) ? btnIdx++ : -1;
            const backIdx = btnIdx++;

            if (response.selection === leaderboardIdx) { showLeaderboardUI(player); }
            else if (response.selection === createIdx) { showCreateFactionUI(player); }
            else if (response.selection === joinIdx) { showJoinSearchUI(player); }
            else if (response.selection === pendingReqIdx) { showPlayerPendingRequestsUI(player); }
            else { goBackToMenu(player); }
        } else {
            const editIdx = btnIdx++;
            const backIdx = btnIdx++;

            if (response.selection === leaderboardIdx) { showLeaderboardUI(player); }
            else if (response.selection === editIdx) { showEditFactionUI(player); }
            else { goBackToMenu(player); }
        }
    });
}

// ============================================
// SECTION 9: FACTION CREATION
// ============================================

export function showCreateFactionUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const existingFaction = getPlayerFaction(player.id);
    if (existingFaction) {
        player.sendMessage("§cYou are already in a faction: §f" + existingFaction.name);
        showFactionsMainUI(player);
        return;
    }

    if (!player.hasTag("op")) {
        try {
            const lastDisband = world.getDynamicProperty(FACTION_DISBAND_CD_PREFIX + player.id) || 0;
            const now = Date.now();
            const remaining = FACTION_DISBAND_CD_MS - (now - lastDisband);
            if (remaining > 0) {
                const minutes = Math.floor(remaining / 60000);
                const seconds = Math.floor((remaining % 60000) / 1000);
                const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
                player.sendMessage(`§cYou must wait §e${timeStr} §cbefore creating a new faction after disbanding.`);
                showFactionsMainUI(player);
                return;
            }
        } catch (e) { }
    }

    const iconNames = [];
    for (let i = 0; i < FACTION_ICONS.length; i++) {
        iconNames.push(FACTION_ICONS[i].unicode + " " + FACTION_ICONS[i].name);
    }

    const form = new ModalFormData()
        .title("§a§lCreate Faction")
        .textField("§6Faction Name §8(15 characters max)\n§7Letters, numbers, spaces, underscores only", "Enter faction name...")
        .textField("§6Description §8(50 characters max)\n§7Optional — leave empty for default", "Enter description...")
        .dropdown("§6Faction Icon", iconNames, { defaultValueIndex: 0 })
        .toggle("§6Faction Status §8(Open = Anyone can join)", { defaultValue: false });

    form.show(player).then(response => {
        if (response.canceled) { showFactionsMainUI(player); return; }

        let nameInput = (response.formValues[0] || "").trim();
        let descInput = (response.formValues[1] || "").trim();
        const selectedIconIndex = response.formValues[2];
        const isOpen = response.formValues[3];

        if (!isValidFactionName(nameInput)) {
            player.sendMessage("§cInvalid faction name!\n§7• 3–15 characters\n§7• Letters, numbers, spaces, underscores only");
            showCreateFactionUI(player); return;
        }
        if (!isValidFactionDescription(descInput)) {
            player.sendMessage("§cDescription too long! Maximum 50 characters.");
            showCreateFactionUI(player); return;
        }
        if (isFactionNameTaken(nameInput)) {
            player.sendMessage("§cThe faction name §f'" + nameInput + "' §cis already taken!");
            showCreateFactionUI(player); return;
        }

        nameInput += "§r";
        descInput = (descInput || "No description set.") + "§r";

        const selectedIcon = FACTION_ICONS[selectedIconIndex] || FACTION_ICONS[0];
        const factionId = generateFactionId();
        const factions = getAllFactions();

        removePendingRequestsForPlayer(player.id);

        factions[factionId] = {
            id: factionId,
            name: nameInput,
            description: descInput,
            icon: selectedIcon.id,
            iconUnicode: selectedIcon.unicode,
            iconTexture: selectedIcon.texture,
            status: isOpen ? "open" : "closed",
            leader: player.id,
            createdBy: player.id,
            createdByName: player.name,
            members: { [player.id]: { role: FACTION_ROLES.OWNER, power: getPlayerSavedPower(player.id), name: player.name, joinedAt: Date.now(), invitedBy: "System" } },
            maxMembers: DEFAULT_MAX_MEMBERS,
            allies: [],
            enemies: [],
            allyPendingRequests: [],
            peaceRequests: [],
            claims: [],
            homes: [],
            achievements: [],
            pendingRequests: [],
            createdAt: Date.now(),
            immunity: false
        };

        saveAllFactions(factions);
        setPlayerFaction(player.id, factionId);

        player.playSound("random.levelup");
        const statusWord = isOpen ? "§aOpen" : "§cClosed";
        world.sendMessage("§6[ZYD-FACTIONS] §aA new faction: §f" + selectedIcon.unicode + " " + nameInput + " §aby §e" + player.name + " §7[" + statusWord + "§7]");
        showFactionsMainUI(player);
    });
}

// ============================================
// SECTION 10: EDIT FACTION UI
// ============================================

function showEditFactionUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const faction = getPlayerFaction(player.id);
    if (!faction) return showFactionsMainUI(player);

    // FIX: Declare myRole BEFORE using it in body text
    const myRole = faction.members[player.id]?.role;
    const isOwner = myRole === FACTION_ROLES.OWNER;
    const isAdmin = myRole === FACTION_ROLES.ADMIN;

    const totalPower = calculateFactionPower(faction);
    const memberCount = Object.keys(faction.members).length;
    const pendingCount = faction.pendingRequests ? faction.pendingRequests.length : 0;
    const statusText = faction.status === "open" ? "§aOpen" : "§cClosed";
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
    const powerPercent = maxPossiblePower > 0 ? Math.round((totalPower / maxPossiblePower) * 100) : 0;
    const myPower = faction.members[player.id]?.power || 0;
    const maxClaims = memberCount * (MAX_POWER_PER_MEMBER / CLAIM_POWER_RATIO);
    const currentClaims = faction.currentClaims || 0;

    // Calculate Global Rank
    const allFactionsList = Object.values(getAllFactions());
    allFactionsList.sort((a, b) => calculateFactionPower(b) - calculateFactionPower(a));
    const myRank = allFactionsList.findIndex(f => f.id === faction.id) + 1;

    let body = "§7---------------------------\n";
    body += `§7Global Top: §e#${myRank > 0 ? myRank : "N/A"}\n`;
    body += `§7Name: §f${faction.iconUnicode} ${faction.name}\n`;
    body += `§7Description: §f${faction.description}\n`;
    body += `§7Status: ${statusText}\n`;
    body += `§7Members: §f${memberCount}/${faction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    body += `§7Faction Percentage: ${getPowerPercentColor(powerPercent)}${powerPercent} Percent\n`;
    body += `§7Claimed Land: §b${currentClaims}/${maxClaims}\n`;
    body += `§7Your Role: ${getRoleColor(myRole)}${capitalizeFirst(myRole)}\n`;
    body += `§7Your Power: §b${myPower}/${MAX_POWER_PER_MEMBER}\n`;
    body += "§7---------------------------";

    const pendingSeenCount = faction.pendingSeenCount || 0;
    const memberListIcon = pendingCount > pendingSeenCount ? "textures/tphere_request.png" : "textures/list.png";

    const form = new ActionFormData()
        .title("§e§lMy Faction")
        .body(body);

    const canSetStatus = hasFactionPermission(faction, player.id, "setStatus");
    const canEditDesc = hasFactionPermission(faction, player.id, "editDesc");
    const canViewMembers = hasFactionPermission(faction, player.id, "viewMembers");
    const canViewDiplomacy = hasFactionPermission(faction, player.id, "viewDiplomacy");
    const canDisband = hasFactionPermission(faction, player.id, "disband");

    if (canSetStatus) form.button("§eFaction Status\n§f[ Currently: " + statusText + " §f]", "textures/settings.png");
    if (canEditDesc) form.button("§eEdit Description\n§f[ Change faction info ]", "textures/edit2.png");
    if (canViewMembers) form.button("§bMember List\n§f[ View & Manage ]", memberListIcon);
    if (canViewDiplomacy) form.button("§6Diplomacy\n§f[ Allies & Enemies ]", "textures/factions/faction.png");

    if (canDisband) form.button("§cDisband Faction\n§f[ Delete permanently ]", "textures/delete.png");
    if (!isOwner) form.button("§eLeave Faction\n§f[ Leave this faction ]", "textures/tpa2.png");

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const statusIdx = canSetStatus ? idx++ : -1;
        const editDescIdx = canEditDesc ? idx++ : -1;
        const memberListIdx = canViewMembers ? idx++ : -1;
        const diplomacyIdx = canViewDiplomacy ? idx++ : -1;
        const disbandIdx = canDisband ? idx++ : -1;
        const leaveIdx = !isOwner ? idx++ : -1;
        const backIdx = idx;

        if (response.selection === statusIdx) showToggleStatusUI(player);
        else if (response.selection === editDescIdx) showEditDescriptionUI(player);
        else if (response.selection === memberListIdx) showMemberListUI(player);
        else if (response.selection === diplomacyIdx) showDiplomacyUI(player);
        else if (response.selection === disbandIdx) showDisbandConfirmUI(player);
        else if (response.selection === leaveIdx) showLeaveFactionConfirmUI(player);
        else showFactionsMainUI(player);
    });
}

// ============================================
// SECTION 11: FACTION STATUS TOGGLE
// ============================================

function showToggleStatusUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const isCurrentlyOpen = faction.status === "open";
    const newStatus = isCurrentlyOpen ? "closed" : "open";
    const statusWord = newStatus === "open" ? "§aOpen" : "§cClosed";

    const factions = getAllFactions();
    factions[faction.id].status = newStatus;
    saveAllFactions(factions);

    player.sendMessage(`§a§l Faction status changed to ${statusWord}§a!`);

    const bcastCountKey = FACTION_STATUS_BCAST_COUNT_PREFIX + faction.id;
    const bcastCdKey = FACTION_STATUS_BROADCAST_CD_PREFIX + faction.id;
    const now = Date.now();

    let bcastCount = world.getDynamicProperty(bcastCountKey) || 0;
    const lastBcast = world.getDynamicProperty(bcastCdKey) || 0;

    // If cooldown expired, reset count to 0
    if (lastBcast > 0 && now - lastBcast >= FACTION_STATUS_BROADCAST_CD_MS) {
        bcastCount = 0;
        world.setDynamicProperty(bcastCdKey, 0);
    }

    if (bcastCount === 0) {
        // 1st broadcast, cooldown starts here
        if (newStatus === "open") {
            world.sendMessage(`§6[ZYD-FACTIONS] §r${faction.iconUnicode} ${faction.name} §ais now §aOPEN§a! §7Anyone will be accepted instantly.`);
        } else {
            world.sendMessage(`§6[ZYD-FACTIONS] §r${faction.iconUnicode} ${faction.name} §cis now §cCLOSED§c! §7Players must send a request to join.`);
        }
        world.setDynamicProperty(bcastCountKey, 1);
        world.setDynamicProperty(bcastCdKey, now);
    } else if (bcastCount === 1) {
        // 2nd broadcast, then fully locked
        if (newStatus === "open") {
            world.sendMessage(`§6[ZYD-FACTIONS] §r${faction.iconUnicode} ${faction.name} §ais now §aOPEN§a! §7Anyone will be accepted instantly.`);
        } else {
            world.sendMessage(`§6[ZYD-FACTIONS] §r${faction.iconUnicode} ${faction.name} §cis now §cCLOSED§c! §7Players must send a request to join.`);
        }
        world.setDynamicProperty(bcastCountKey, 2);
    } else {
        // bcastCount === 2, fully locked until cooldown ends
        const remaining = FACTION_STATUS_BROADCAST_CD_MS - (now - lastBcast);
        const minutes = Math.floor(remaining / 60000);
        player.sendMessage(`§7World broadcast is on cooldown. Next broadcast in §e${minutes}m§7.`);
    }

    showEditFactionUI(player);
}

// ============================================
// SECTION 12: FACTION DESCRIPTION EDIT
// ============================================

function showEditDescriptionUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const form = new ModalFormData()
        .title("§e§lEdit Description")
        .textField("§6New Description §8(50 chars max):", "Enter description...", { defaultValue: faction.description });

    form.show(player).then(response => {
        if (response.canceled) { showEditFactionUI(player); return; }
        let newDesc = (response.formValues[0] || "").trim();

        if (!isValidFactionDescription(newDesc)) {
            player.sendMessage("§cDescription too long! Maximum 50 characters.");
            showEditDescriptionUI(player); return;
        }

        newDesc = (newDesc || "No description set.") + "§r";

        const factions = getAllFactions();
        factions[faction.id].description = newDesc;
        saveAllFactions(factions);
        player.sendMessage("§a§l Description updated!");
        showEditFactionUI(player);
    });
}

// ============================================
// SECTION 13: LEAVE FACTION
// ============================================

function showLeaveFactionConfirmUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return showFactionsMainUI(player);

    const form = new MessageFormData()
        .title("§e§lLeave Faction")
        .body(`§eAre you sure you want to leave §f${faction.iconUnicode} ${faction.name}§e?\n\n§7You will lose all your power and progress in this faction.`)
        .button1("§eYes, Leave")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) { showEditFactionUI(player); return; }

        const factions = getAllFactions();
        const currentFaction = factions[getPlayerFactionId(player.id)];
        if (!currentFaction || !currentFaction.members[player.id]) return;

        const leavingFactionId = getPlayerFactionId(player.id);
        savePlayerSavedPower(player.id, currentFaction.members[player.id].power || 0);
        delete currentFaction.members[player.id];
        saveAllFactions(factions);
        setPlayerFaction(player.id, null);
        try { if (leavingFactionId) removePlayerFromAllChunkPerms(leavingFactionId, player.id); } catch (e) { }

        player.sendMessage(`§e§l You left §f${faction.name}§e.`);
        player.playSound("random.orb");

        for (const mid in currentFaction.members) {
            const m = world.getAllPlayers().find(p => p.id === mid);
            if (m) m.sendMessage(`§6[ZYD-FACTIONS] §f${player.name} §7left the faction.`);
        }

        showFactionsMainUI(player);
    });
}

// ============================================
// FACTION RELATIONS CLEANUP HELPER
// Removes disbanded faction from all other factions' allies/enemies/pending lists
// ============================================
function cleanupFactionRelations(factions, disbandedFactionId) {
    for (const id in factions) {
        if (id === disbandedFactionId) continue;

        // Remove from allies list
        if (factions[id].allies) {
            factions[id].allies = factions[id].allies.filter(aId => aId !== disbandedFactionId);
        }

        // Remove from enemies list
        if (factions[id].enemies) {
            factions[id].enemies = factions[id].enemies.filter(e => e.factionId !== disbandedFactionId);
        }

        // Remove from incoming ally/peace requests
        if (factions[id].allyPendingRequests) {
            factions[id].allyPendingRequests = factions[id].allyPendingRequests.filter(r => r.fromFactionId !== disbandedFactionId);
        }
        if (factions[id].peaceRequests) {
            factions[id].peaceRequests = factions[id].peaceRequests.filter(r => r.fromFactionId !== disbandedFactionId);
        }
    }
}

// ============================================
// SECTION 14: DISBAND FACTION
// ============================================

function showDisbandConfirmUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return showFactionsMainUI(player);

    const form = new MessageFormData()
        .title("§c§lDisband Faction")
        .body(`§c§lWARNING!§r\n\n§cAre you sure you want to DISBAND §f${faction.iconUnicode} ${faction.name}§c?\n\n§7• All members will be removed\n• All claims will be lost\n• All progress will be deleted\n• §e1 hour cooldown §7before creating a new faction\n\n§cThis action CANNOT be undone!`)
        .button1("§cYes, Disband")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) { showEditFactionUI(player); return; }

        const factions = getAllFactions();
        const factionId = getPlayerFactionId(player.id);
        if (!factions[factionId]) return;

        const factionName = factions[factionId].name;
        const factionIcon = factions[factionId].iconUnicode || "";

        // Remove all members
        for (const memberId in factions[factionId].members) {
            savePlayerSavedPower(memberId, factions[factionId].members[memberId].power || 0);
            setPlayerFaction(memberId, null);
            const m = world.getAllPlayers().find(p => p.id === memberId);
            if (m && m.id !== player.id) {
                m.sendMessage(`§c[ZYD-FACTIONS] §f${factionName} §chas been disbanded by §e${player.name}§c.`);
            }
        }

        cleanupFactionRelations(factions, factionId);
        delete factions[factionId];
        saveAllFactions(factions);
        try { deleteAllChunkPermsForFaction(factionId); } catch (e) { }

        // Set cooldown (OP bypasses in create)
        if (!player.hasTag("op")) {
            try {
                world.setDynamicProperty(FACTION_DISBAND_CD_PREFIX + player.id, Date.now());
            } catch (e) { }
        }

        player.sendMessage(`§c§l Faction §f${factionName} §chas been disbanded.`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §c${factionIcon} ${factionName} §chas been disbanded by §e${player.name}§c.`);

        showFactionsMainUI(player);
    });
}

// ============================================
// SECTION 15: MEMBER LIST UI
// ============================================

const memberSortPref = new Map();
const memberSortAsc = new Map(); // true = ascending, false = descending

function showMemberListUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const memberCount = Object.keys(faction.members).length;
    const memberRole = faction.members[player.id]?.role || "member";
    const isOwner = memberRole === FACTION_ROLES.OWNER;
    const pendingCount = faction.pendingRequests ? faction.pendingRequests.length : 0;
    const sortMode = memberSortPref.get(player.id) || "joined";

    const form = new ActionFormData()
        .title("§b§lMember List")
        .body(`§7Faction: §f${faction.name}\n§7Total Members: §f${memberCount}/${faction.maxMembers}\n§7Total Power: §b${calculateFactionPower(faction)}`);

    // FIX: Added second argument to canManageMembers
    if (canManageMembers(memberRole, faction.members[player.id])) {
        form.button("§aAdd Member\n§f[ Invite a player ]", "textures/add.png");
    }

    if (canManageMembers(memberRole, faction.members[player.id]) && pendingCount > 0) {
        form.button("§dPending Request\n§f[ " + pendingCount + " waiting ]", "textures/exclamation.png");
    }

    const roles = [FACTION_ROLES.OWNER, FACTION_ROLES.ADMIN, FACTION_ROLES.MODERATOR, FACTION_ROLES.MEMBER];
    let memberButtons = [];
    const onlinePlayers = world.getAllPlayers();

    for (const role of roles) {
        let membersInRole = [];
        for (const id in faction.members) {
            if (faction.members[id].role === role) {
                const onlineP = world.getAllPlayers().find(p => p.id === id);
                const pName = onlineP?.name || faction.members[id].name || "Unknown";
                membersInRole.push({ id, name: pName, power: faction.members[id].power, joinedAt: faction.members[id].joinedAt || 0 });
            }
        }

        // Sort within each role group by the selected mode and direction
        const isAsc = memberSortAsc.get(player.id) === true;
        if (sortMode === "power") {
            membersInRole.sort((a, b) => isAsc ? (a.power - b.power) : (b.power - a.power));
        } else if (sortMode === "joined") {
            membersInRole.sort((a, b) => isAsc ? (b.joinedAt - a.joinedAt) : (a.joinedAt - b.joinedAt));
        } else {
            membersInRole.sort((a, b) => isAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
        }

        for (const m of membersInRole) {
            const isOnline = onlinePlayers.some(p => p.id === m.id);
            const nameColor = isOnline ? "§2" : "§4";
            form.button(`${nameColor}${m.name}§r\n§6Power: §b${m.power}/${MAX_POWER_PER_MEMBER}`, getRoleIcon(role));
            memberButtons.push(m.id);
        }
    }

    if (isOwner) {
        form.button("§eSettings\n§f[ Edit Factions Setup ]", "textures/settings.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        // FIX: Added second argument to canManageMembers
        const hasAddBtn = canManageMembers(memberRole, faction.members[player.id]);
        let idx = 0;
        const addIdx = hasAddBtn ? idx++ : -1;
        const pendingIdx = (hasAddBtn && pendingCount > 0) ? idx++ : -1;
        const memberStart = idx;
        idx += memberButtons.length;
        const memberEnd = idx;
        const settingsIdx = isOwner ? idx++ : -1;
        const backIdx = idx;

        if (response.selection === addIdx) {
            showAddMemberUI(player);
        } else if (response.selection === pendingIdx) {
            showPendingRequestsUI(player);
        } else if (response.selection === settingsIdx) {
            showMemberSettingsUI(player);
        } else if (response.selection === backIdx) {
            showEditFactionUI(player);
        } else if (response.selection >= memberStart && response.selection < memberEnd) {
            showMemberStatsUI(player, memberButtons[response.selection - memberStart]);
        }
    });
}

// ============================================
// SECTION 16: MEMBER LIST SETTINGS
// ============================================

function showMemberSettingsUI(player) {
    const current = memberSortPref.get(player.id) || "joined";
    const isAsc = memberSortAsc.get(player.id) === true;
    const dirLabel = isAsc ? "Ascending" : "Descending";

    const faction = getPlayerFaction(player.id);
    if (!faction) return;
    const canManageRoles = hasFactionPermission(faction, player.id, "manageSettings");

    const form = new ActionFormData()
        .title("§e§lFaction Settings")
        .body("§7Manage your faction member display and permissions.")
        .button("§2Arrange Member\n§f[ " + current + " | " + dirLabel + " ]", "textures/list.png");

    if (canManageRoles) {
        form.button("§dRoles Configuration\n§f[ Setup permissions ]", "textures/random/roles.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) { showMemberListUI(player); return; }

        let idx = 0;
        const arrangeIdx = idx++;
        const configIdx = canManageRoles ? idx++ : -1;

        if (response.selection === arrangeIdx) showArrangeMemberUI(player);
        else if (response.selection === configIdx) showRolesConfigSelectUI(player);
        else showMemberListUI(player);
    });
}

function showRolesConfigSelectUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const form = new ActionFormData()
        .title("§d§lRoles Configuration")
        .body("§7Select a role to edit its permissions.\n§eNote: §7The Owner role always has all permissions.")
        .button("§eAdmin Permissions", getRoleIcon(FACTION_ROLES.ADMIN))
        .button("§cModerator Permissions", getRoleIcon(FACTION_ROLES.MODERATOR))
        .button("§fMember Permissions", getRoleIcon(FACTION_ROLES.MEMBER))
        .button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection === 3) { showMemberSettingsUI(player); return; }
        const roles = [FACTION_ROLES.ADMIN, FACTION_ROLES.MODERATOR, FACTION_ROLES.MEMBER];
        showRolesConfigEditUI(player, faction, roles[res.selection]);
    });
}

function showRolesConfigEditUI(player, faction, role) {
    const factionPerms = faction.permissions || JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
    const defaultRolePerms = DEFAULT_PERMISSIONS[role] || {};
    const current = { ...defaultRolePerms, ...(factionPerms[role] || {}) };

    const form = new ModalFormData()
        .title(`§d§lEdit: ${capitalizeFirst(role)}`)
        .toggle("Set Faction Status", { defaultValue: !!current.setStatus })
        .toggle("Edit Description", { defaultValue: !!current.editDesc })
        .toggle("Manage Faction Home", { defaultValue: !!current.manageHome })
        .toggle("Can SetHome (/fsethome /fdelhome)", { defaultValue: !!(current.canSetHome ?? current.manageHome) })
        .toggle("Can Claim (/fclaim /funclaim + Area Permissions)", { defaultValue: !!current.canClaim })
        .toggle("View Member List", { defaultValue: !!current.viewMembers })
        .toggle("Add/Invite Member", { defaultValue: !!current.inviteMembers })
        .toggle("Manage Join & Diplomacy Requests", { defaultValue: !!current.manageRequests })
        .toggle("Edit Roles", { defaultValue: !!current.editRoles })
        .toggle("Kick Member", { defaultValue: !!current.kickMembers })
        .toggle("Faction Member Settings", { defaultValue: !!current.manageSettings })
        .toggle("View Diplomacy", { defaultValue: !!current.viewDiplomacy })
        .toggle("Add Allies & Enemies", { defaultValue: !!current.manageDiplomacy })
        .toggle("Disband Faction", { defaultValue: !!current.disband })
        .toggle("Break Blocks", { defaultValue: !!current.canBreak })
        .toggle("Place Blocks", { defaultValue: !!current.canPlace })
        .toggle("Open Chests/Containers", { defaultValue: !!current.canOpenContainers })
        .toggle("Use Doors/Redstone", { defaultValue: !!current.canUseDoors });

    form.show(player).then(res => {
        if (res.canceled) { showRolesConfigSelectUI(player); return; }

        const vals = res.formValues;
        factionPerms[role] = {
            setStatus: vals[0], editDesc: vals[1], manageHome: vals[2],
            canSetHome: vals[3], canClaim: vals[4],
            viewMembers: vals[5], inviteMembers: vals[6], manageRequests: vals[7],
            editRoles: vals[8], kickMembers: vals[9], manageSettings: vals[10],
            viewDiplomacy: vals[11], manageDiplomacy: vals[12], disband: vals[13],
            canBreak: vals[14], canPlace: vals[15], canOpenContainers: vals[16], canUseDoors: vals[17]
        };

        const factions = getAllFactions();
        factions[faction.id].permissions = factionPerms;
        saveAllFactions(factions);

        player.sendMessage(`§a§l✔ Permissions for ${capitalizeFirst(role)} updated!`);
        player.playSound("random.orb");
        showRolesConfigSelectUI(player);
    });
}

function showArrangeMemberUI(player) {
    const current = memberSortPref.get(player.id) || "joined";
    const isAsc = memberSortAsc.get(player.id) === true;
    const options = [
        { label: "By Name", value: "name" },
        { label: "By Power", value: "power" },
        { label: "By Time Joined", value: "joined" }
    ];
    const defaultIdx = Math.max(0, options.findIndex(o => o.value === current));

    const form = new ModalFormData()
        .title("§e§lArrange Member")
        .dropdown("§6Sort members by:\n§7(Owner > Admin > Mod > Member order is fixed)", options.map(o => o.label), { defaultValueIndex: defaultIdx })
        .toggle("§6Ascending §8(ON=Asc, OFF=Desc)", { defaultValue: isAsc });

    form.show(player).then(response => {
        if (response.canceled) { showMemberSettingsUI(player); return; }
        const chosen = options[response.formValues[0]];
        const asc = response.formValues[1];
        if (chosen) memberSortPref.set(player.id, chosen.value);
        memberSortAsc.set(player.id, asc);
        showMemberListUI(player);
    });
}

// ============================================
// SECTION 17: MEMBER STATS UI
// ============================================

function showMemberStatsUI(player, targetId) {
    const faction = getPlayerFaction(player.id);
    if (!faction || !faction.members[targetId]) return showMemberListUI(player);

    const targetData = faction.members[targetId];
    const onlineP = world.getAllPlayers().find(p => p.id === targetId);
    const targetName = onlineP?.name || targetData.name || "Unknown";
    const isOnline = !!onlineP;
    const powerColor = targetData.power < 0 ? "§c" : "§b";

    let body = "§7---------------------------\n";
    body += `§7Player: ${isOnline ? "§2" : "§4"}${targetName}§r\n`;
    body += `§7Status: ${isOnline ? "§aOnline" : "§cOffline"}\n`;
    body += `§7Role: ${getRoleColor(targetData.role)}${capitalizeFirst(targetData.role)}\n`;
    body += `§7Power: ${powerColor}${targetData.power}/${MAX_POWER_PER_MEMBER}\n`;
    body += `§7Joined: §f${formatJoinDate(targetData.joinedAt)}\n`;
    if (targetId === faction.createdBy) {
        if (targetId === faction.leader) {
            body += `§7Faction Created: §a${faction.createdByName || targetName}\n`;
        } else {
            body += `§7Ex Faction Owner: §6${faction.createdByName || targetName}\n`;
        }
    } else {
        body += `§7Invited by: §f${targetData.invitedBy || "Unknown"}\n`;
    }
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title("§b§lMember Stats")
        .body(body);

    const myRole = faction.members[player.id]?.role;
    const isOwner = myRole === FACTION_ROLES.OWNER;
    const canManage = canManageMember(myRole, targetData.role, targetId === player.id);
    const roleOptions = canManage ? getRoleEditOptions(myRole, targetData.role) : [];
    const canEditRole = canManage && roleOptions.length > 0;
    const canToggleEditPerm = isOwner && targetId !== player.id && targetData.role !== FACTION_ROLES.OWNER;

    if (canEditRole) {
        form.button("§eEdit Role\n§f[ Change member role ]", "textures/edit2.png");
    }
    if (canToggleEditPerm) {
        form.button("§dEdit Permission\n§f[ Toggle manage access ]", "textures/settings.png");
    }
    if (canManage) {
        form.button("§cKick Member\n§f[ Remove from faction ]", "textures/rank_colours/red.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const editRoleIdx = canEditRole ? idx++ : -1;
        const editPermIdx = canToggleEditPerm ? idx++ : -1;
        const kickIdx = canManage ? idx++ : -1;
        const backIdx = idx;

        if (response.selection === editRoleIdx) {
            showEditRoleUI(player, targetId, targetName, roleOptions);
        } else if (response.selection === editPermIdx) {
            showEditPermissionToggleUI(player, targetId, targetName);
        } else if (response.selection === kickIdx) {
            showKickConfirmUI(player, targetId, targetName, targetData.power);
        } else {
            showMemberListUI(player);
        }
    });
}

// ============================================
// SECTION 18: EDIT ROLE SYSTEM
// ============================================

function showEditRoleUI(player, targetId, targetName, roleOptions) {
    const labels = roleOptions.map(o => o.label);

    const form = new ModalFormData()
        .title("§e§lEdit Role")
        .dropdown(`§6Select new role for §f${targetName}`, labels);

    form.show(player).then(response => {
        if (response.canceled) { showMemberStatsUI(player, targetId); return; }

        const chosen = roleOptions[response.formValues[0]];
        if (!chosen) { showMemberStatsUI(player, targetId); return; }

        const isOwnershipTransfer = chosen.value === FACTION_ROLES.OWNER;
        showEditRoleConfirmUI(player, targetId, targetName, chosen, isOwnershipTransfer);
    });
}

function showEditRoleConfirmUI(player, targetId, targetName, chosen, isOwnershipTransfer) {
    if (isOwnershipTransfer) {
        const form1 = new MessageFormData()
            .title("§4§l⚠ OWNERSHIP TRANSFER")
            .body(`§c§lWARNING!§r\n\n§eYou are about to transfer §6OWNERSHIP §eof this faction to §f${targetName}§e!\n\n§7• You will be demoted to §eAdmin§7.\n• §f${targetName} §7will gain full control.\n• §cThis cannot be undone easily.\n\n§eAre you absolutely sure?`)
            .button1("§eYes, I understand")
            .button2("§cCancel");

        form1.show(player).then(response => {
            if (response.canceled || response.selection === 1) { showMemberStatsUI(player, targetId); return; }
            const form2 = new MessageFormData()
                .title("§4§l⚠ FINAL WARNING")
                .body(`§c§lTHIS IS YOUR LAST CHANCE TO CANCEL.§r\n\n§eTransfer ownership of this faction to §f${targetName}§e?\n\n§cYou will NO LONGER be the Owner.`)
                .button1("§eYes, Transfer Ownership")
                .button2("§cNo, Cancel");

            form2.show(player).then(response2 => {
                if (response2.canceled || response2.selection === 1) { showMemberStatsUI(player, targetId); return; }
                applyRoleChange(player, targetId, targetName, chosen);
            });
        });
    } else {
        const form = new MessageFormData()
            .title("§e§lChange Role")
            .body(`§eAre you sure you want to change §f${targetName}'s §erole to §6${chosen.label}§e?`)
            .button1("§eYes, Change Role")
            .button2("§cCancel");

        form.show(player).then(response => {
            if (response.canceled || response.selection === 1) { showMemberStatsUI(player, targetId); return; }
            applyRoleChange(player, targetId, targetName, chosen);
        });
    }
}

function applyRoleChange(player, targetId, targetName, chosen) {
    const factions = getAllFactions();
    const faction = factions[getPlayerFactionId(player.id)];
    if (!faction || !faction.members[targetId]) { showMemberListUI(player); return; }

    if (chosen.value === FACTION_ROLES.OWNER) {
        const oldOwnerId = faction.leader;
        if (oldOwnerId && faction.members[oldOwnerId]) {
            faction.members[oldOwnerId].role = FACTION_ROLES.ADMIN;
        }
        faction.leader = targetId;
    }

    faction.members[targetId].role = chosen.value;
    saveAllFactions(factions);

    player.sendMessage(`§f${targetName} §ais now §e${capitalizeFirst(chosen.value)}§a!`);

    const target = world.getAllPlayers().find(p => p.id === targetId);
    if (target) {
        target.sendMessage(`§a[ZYD-FACTIONS] §fYour role is now §e${capitalizeFirst(chosen.value)}§a!`);
        target.playSound("random.levelup");
    }

    for (const mid in faction.members) {
        if (mid === player.id || mid === targetId) continue;
        const m = world.getAllPlayers().find(p => p.id === mid);
        if (m) m.sendMessage(`§6[ZYD-FACTIONS] §f${targetName} §7is now §e${capitalizeFirst(chosen.value)}§7.`);
    }

    showMemberListUI(player);
}

// ============================================
// SECTION 19: EDIT PERMISSION TOGGLE
// ============================================

function showEditPermissionToggleUI(player, targetId, targetName) {
    const faction = getPlayerFaction(player.id);
    if (!faction || !faction.members[targetId]) { showMemberStatsUI(player, targetId); return; }

    const targetData = faction.members[targetId];
    const currentPerm = targetData.editPermission === true;

    const form = new ModalFormData()
        .title("§d§lEdit Permission")
        .toggle(`§6Toggle edit permission for §f${targetName}\n\n§7When ON, this member can manage members\n§7(invite, kick, etc.) like an Admin.\n§7Default: OFF`, { defaultValue: currentPerm });

    form.show(player).then(response => {
        if (response.canceled) { showMemberStatsUI(player, targetId); return; }

        const newValue = response.formValues[0];
        const factions = getAllFactions();
        const currentFaction = factions[faction.id];
        if (!currentFaction || !currentFaction.members[targetId]) { showMemberListUI(player); return; }

        currentFaction.members[targetId].editPermission = newValue;
        saveAllFactions(factions);

        const permStatus = newValue ? "§aON" : "§cOFF";
        player.sendMessage(`§aEdit permission for §f${targetName} §ais now ${permStatus}§a!`);

        const targetPlayer = world.getAllPlayers().find(p => p.id === targetId);
        if (targetPlayer) {
            targetPlayer.sendMessage(`§d[ZYD-FACTIONS] Your edit permission has been set to ${permStatus}§d by §f${player.name}§d.`);
        }

        showMemberStatsUI(player, targetId);
    });
}

// ============================================
// SECTION 20: KICK MEMBER
// ============================================

function showKickConfirmUI(player, targetId, targetName, targetPower) {
    const form = new MessageFormData()
        .title("§c§lKick Player")
        .body(`§cAre you sure you want to kick §f${targetName}§c?\n\n§7Warning: Kicking this player will decrease the overall faction power by §b${Math.max(0, targetPower)}§7.`)
        .button1("§cYes, Kick Player")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) { showMemberStatsUI(player, targetId); return; }

        const faction = getPlayerFaction(player.id);
        if (!faction) return;

        const factions = getAllFactions();
        const kFid = faction.id;
        savePlayerSavedPower(targetId, factions[kFid].members[targetId]?.power || 0);
        delete factions[kFid].members[targetId];
        saveAllFactions(factions);
        setPlayerFaction(targetId, null);
        try { removePlayerFromAllChunkPerms(kFid, targetId); } catch (e) { }

        player.sendMessage(`§c§l Kicked §f${targetName} §cfrom the faction.`);
        const targetPlayer = world.getAllPlayers().find(p => p.id === targetId);
        if (targetPlayer) targetPlayer.sendMessage("§cYou have been kicked from §f" + faction.name + "§c.");

        showMemberListUI(player);
    });
}

// ============================================
// SECTION 21: ADD MEMBER (INVITE) SYSTEM
// ============================================

function showAddMemberUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const form = new ActionFormData()
        .title("§a§lInvite Player")
        .body("§7Choose how to invite a player:");

    form.button("§aSelect Online Player\n§f[ Pick from online list ]", "textures/list.png");
    form.button("§eSearch Player Name\n§f[ Type a name to search ]", "textures/edit2.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) { showMemberListUI(player); return; }
        if (response.selection === 0) showInviteSelectOnlineUI(player);
        else if (response.selection === 1) showInviteSearchNameUI(player);
        else showMemberListUI(player);
    });
}

function showInviteSelectOnlineUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const onlinePlayers = world.getAllPlayers().filter(p => {
        return p.id !== player.id && !getPlayerFactionId(p.id);
    });

    if (onlinePlayers.length === 0) {
        player.sendMessage("§cNo eligible online players found to invite.");
        showAddMemberUI(player);
        return;
    }

    onlinePlayers.sort((a, b) => a.name.localeCompare(b.name));
    const playerNames = onlinePlayers.map(p => p.name);

    const form = new ModalFormData()
        .title("§a§lSelect Online Player")
        .dropdown("§6Choose a player:", playerNames);

    form.show(player).then(response => {
        if (response.canceled) { showAddMemberUI(player); return; }

        const selectedPlayer = onlinePlayers[response.formValues[0]];
        if (!selectedPlayer) { showInviteSelectOnlineUI(player); return; }

        if (getPlayerFactionId(selectedPlayer.id)) {
            player.sendMessage("§cPlayer is no longer eligible.");
            showInviteSelectOnlineUI(player); return;
        }

        sendPendingInvite(player, selectedPlayer);
    });
}

function showInviteSearchNameUI(player) {
    const form = new ModalFormData()
        .title("§e§lSearch Player Name")
        .textField("§6Enter player name:\n§7(Works for offline players too)", "Type name here...");

    form.show(player).then(response => {
        if (response.canceled) { showAddMemberUI(player); return; }

        const searchName = (response.formValues[0] || "").trim();
        if (!searchName) { showInviteSearchNameUI(player); return; }

        // First check online players
        const foundOnline = world.getAllPlayers().find(p => p.name.toLowerCase() === searchName.toLowerCase());

        if (foundOnline) {
            if (foundOnline.id === player.id) {
                player.sendMessage("§cYou cannot invite yourself.");
                showInviteSearchNameUI(player); return;
            }
            if (getPlayerFactionId(foundOnline.id)) {
                player.sendMessage("§cThat player is already in a faction.");
                showInviteSearchNameUI(player); return;
            }
            sendPendingInvite(player, foundOnline);
            return;
        }

        // If not online, check the player registry (for offline invites)
        const registry = getAllKnownPlayers();
        let foundOfflineId = null;
        let foundOfflineName = null;

        for (const id in registry) {
            if (registry[id].name.toLowerCase() === searchName.toLowerCase()) {
                foundOfflineId = id;
                foundOfflineName = registry[id].name;
                break;
            }
        }

        if (!foundOfflineId) {
            player.sendMessage("§cPlayer §f" + searchName + " §cnot found.");
            showInviteSearchNameUI(player); return;
        }
        if (foundOfflineId === player.id) {
            player.sendMessage("§cYou cannot invite yourself.");
            showInviteSearchNameUI(player); return;
        }
        if (getPlayerFactionId(foundOfflineId)) {
            player.sendMessage("§cThat player is already in a faction.");
            showInviteSearchNameUI(player); return;
        }

        // Send offline invite
        sendOfflinePendingInvite(player, foundOfflineId, foundOfflineName);
    });
}

function sendPendingInvite(inviter, target) {
    const faction = getPlayerFaction(inviter.id);
    if (!faction) return;

    const pending = getPlayerPendingRequests(target.id);

    if (pending.length >= MAX_PENDING_INVITATIONS_PER_PLAYER) {
        inviter.sendMessage("§cThat player already has §e" + MAX_PENDING_INVITATIONS_PER_PLAYER + " §cpending requests. They must clear some first.");
        showAddMemberUI(inviter);
        return;
    }

    if (pending.some(r => r.factionId === faction.id)) {
        inviter.sendMessage("§cThat player already has a pending invite from your faction.");
        showAddMemberUI(inviter);
        return;
    }

    const inviterRole = faction.members[inviter.id]?.role || FACTION_ROLES.MEMBER;

    pending.push({
        factionId: faction.id,
        factionName: faction.name,
        factionIcon: faction.iconUnicode,
        factionIconTexture: faction.iconTexture,
        inviterId: inviter.id,
        inviterName: inviter.name,
        inviterRole: inviterRole,
        timestamp: Date.now()
    });

    savePlayerPendingRequests(target.id, pending);

    inviter.sendMessage("§a§l Sent invite to §f" + target.name + " §a!");
    target.sendMessage("§d[ZYD-FACTIONS] §eYou are invited §dto join §f" + faction.iconUnicode + " " + faction.name + " §dby §f" + inviter.name + "§d!\n§7Check your §ePending Invitation §din the Factions menu.");
    target.playSound("random.orb");

    showAddMemberUI(inviter);
}

function sendOfflinePendingInvite(inviter, targetId, targetName) {
    const faction = getPlayerFaction(inviter.id);
    if (!faction) return;

    const pending = getPlayerPendingRequests(targetId);

    if (pending.length >= MAX_PENDING_INVITATIONS_PER_PLAYER) {
        inviter.sendMessage("§cThat player already has §e" + MAX_PENDING_INVITATIONS_PER_PLAYER + " §cpending requests. They must clear some first.");
        showAddMemberUI(inviter);
        return;
    }

    if (pending.some(r => r.factionId === faction.id)) {
        inviter.sendMessage("§cThat player already has a pending invite from your faction.");
        showAddMemberUI(inviter);
        return;
    }

    const inviterRole = faction.members[inviter.id]?.role || FACTION_ROLES.MEMBER;

    pending.push({
        factionId: faction.id,
        factionName: faction.name,
        factionIcon: faction.iconUnicode,
        factionIconTexture: faction.iconTexture,
        inviterId: inviter.id,
        inviterName: inviter.name,
        inviterRole: inviterRole,
        timestamp: Date.now()
    });

    savePlayerPendingRequests(targetId, pending);

    inviter.sendMessage("§a§l Sent offline invite to §f" + targetName + " §a!");
    inviter.sendMessage("§7They will see the invitation when they log in.");

    showAddMemberUI(inviter);
}

// ============================================
// SECTION 22: PLAYER PENDING REQUESTS UI
// ============================================

function getMemberListText(faction) {
    const roles = [
        { key: FACTION_ROLES.OWNER, label: "Owner" },
        { key: FACTION_ROLES.ADMIN, label: "Admin" },
        { key: FACTION_ROLES.MODERATOR, label: "Moderator" },
        { key: FACTION_ROLES.MEMBER, label: "Member" }
    ];
    let text = "";
    const onlinePlayers = world.getAllPlayers();
    for (const r of roles) {
        const members = [];
        for (const id in faction.members) {
            if (faction.members[id].role === r.key) {
                const onlineP = onlinePlayers.find(p => p.id === id);
                members.push(onlineP?.name || faction.members[id].name || "Unknown");
            }
        }
        if (members.length > 0) {
            text += `§7${r.label}: §f${members.join("§7, §f")}\n`;
        }
    }
    return text;
}

function showPlayerPendingRequestsUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const now = Date.now();
    let pending = getPlayerPendingRequests(player.id);

    // Clean expired invites (10 minutes)
    const activePending = pending.filter(r => (now - r.timestamp) < FACTION_INVITE_EXPIRE_MS);
    if (activePending.length !== pending.length) {
        pending = activePending;
        savePlayerPendingRequests(player.id, pending);
    }

    if (pending.length === 0) { player.sendMessage("§cNo pending invitations."); showFactionsMainUI(player); return; }

    const form = new ActionFormData()
        .title("§dPending Invitation")
        .body(`§7You have §d${pending.length}§7 pending invitation(s).\n§7Max: §f${MAX_PENDING_INVITATIONS_PER_PLAYER}§7.`);

    for (const req of pending) {
        const faction = getFactionById(req.factionId);
        if (!faction) continue;
        const memberCount = Object.keys(faction.members).length;
        const totalPower = calculateFactionPower(faction);
        const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
        const btnIcon = req.factionIconTexture || faction.iconTexture || "textures/pin.png";
        form.button(`§f${req.factionIcon} ${req.factionName}\n§f${memberCount}/${faction.maxMembers} §b${totalPower}/${maxPossiblePower}`, btnIcon);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === pending.length) { showFactionsMainUI(player); return; }

        const validPending = getPlayerPendingRequests(player.id).filter(r => getFactionById(r.factionId));
        if (response.selection >= validPending.length) { showPlayerPendingRequestsUI(player); return; }

        const req = validPending[response.selection];
        showPlayerManageRequestUI(player, req);
    });
}

function showPlayerManageRequestUI(player, req) {
    const faction = getFactionById(req.factionId);
    if (!faction) {
        const pending = getPlayerPendingRequests(player.id).filter(r => r.factionId !== req.factionId);
        savePlayerPendingRequests(player.id, pending);
        player.sendMessage("§cThat faction no longer exists.");
        showPlayerPendingRequestsUI(player);
        return;
    }

    const memberCount = Object.keys(faction.members).length;
    const totalPower = calculateFactionPower(faction);
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
    const statusText = faction.status === "open" ? "§aOpen" : "§cClosed";
    const memberListText = getMemberListText(faction);

    let bodyText = "§7---------------------------\n";
    bodyText += `§7Faction: §f${faction.iconUnicode} ${faction.name}\n`;
    bodyText += `§7Status: ${statusText}\n`;
    bodyText += `§7Description: §f${faction.description}\n`;
    bodyText += `§7Members: §f${memberCount}/${faction.maxMembers}\n`;
    bodyText += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    bodyText += "§7---------------------------\n";
    bodyText += memberListText;

    const form = new ActionFormData()
        .title("§dInvitation Details")
        .body(bodyText);

    form.button("§aJoin Faction\n§f[ Accept invitation ]", "textures/rank_colours/green.png");
    form.button("§cDecline Invitation\n§f[ Reject invitation ]", "textures/rank_colours/red.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) { showPlayerPendingRequestsUI(player); return; }

        if (response.selection === 0) { // Join Faction
            const pending = getPlayerPendingRequests(player.id);
            const newPending = pending.filter(r => r.factionId !== req.factionId);
            savePlayerPendingRequests(player.id, newPending);

            if (req.inviterRole === FACTION_ROLES.MODERATOR) {
                const factions = getAllFactions();
                const currentFaction = factions[req.factionId];
                if (!currentFaction || Object.keys(currentFaction.members).length >= currentFaction.maxMembers) {
                    player.sendMessage("§cFaction is now full.");
                    showPlayerPendingRequestsUI(player); return;
                }
                if (!currentFaction.pendingRequests) currentFaction.pendingRequests = [];
                if (!currentFaction.pendingRequests.some(r => r.playerId === player.id)) {
                    currentFaction.pendingRequests.push({
                        playerId: player.id,
                        playerName: player.name,
                        message: "Accepted moderator invite from " + req.inviterName,
                        timestamp: Date.now()
                    });
                    saveAllFactions(factions);
                }
                player.sendMessage("§a§l You accepted the invite. Since it was sent by a §cModerator§a, an §eAdmin §aor §aOwner §amust approve your request.");
                for (const id in currentFaction.members) {
                    if (canManageMembers(currentFaction.members[id].role, currentFaction.members[id])) {
                        const member = world.getAllPlayers().find(p => p.id === id);
                        if (member) member.sendMessage("§d[ZYD-FACTIONS] §f" + player.name + " §daccepted a moderator invite and is now pending approval.");
                    }
                }
            } else {
                const factions = getAllFactions();
                const currentFaction = factions[req.factionId];
                if (!currentFaction || Object.keys(currentFaction.members).length >= currentFaction.maxMembers) {
                    player.sendMessage("§cFaction is now full.");
                    showPlayerPendingRequestsUI(player); return;
                }

                removePendingRequestsForPlayer(player.id);
                currentFaction.members[player.id] = { role: FACTION_ROLES.MEMBER, power: getPlayerSavedPower(player.id), name: player.name, joinedAt: Date.now(), invitedBy: req.inviterName };
                saveAllFactions(factions);
                setPlayerFaction(player.id, req.factionId);

                player.sendMessage("§a§l You joined §f" + currentFaction.iconUnicode + " " + currentFaction.name + "§a!");
                player.playSound("random.levelup");
                world.sendMessage(`§6[ZYD-FACTIONS] §a${player.name} joined §f${currentFaction.iconUnicode} ${currentFaction.name}§a!`);

                const inviter = world.getAllPlayers().find(p => p.id === req.inviterId);
                if (inviter) inviter.sendMessage("§a§f" + player.name + " §aaccepted your faction invitation!");
            }
        } else if (response.selection === 1) { // Decline Invitation
            const pending = getPlayerPendingRequests(player.id);
            const newPending = pending.filter(r => r.factionId !== req.factionId);
            savePlayerPendingRequests(player.id, newPending);
            player.sendMessage("§cDeclined faction invitation.");
            const inviter = world.getAllPlayers().find(p => p.id === req.inviterId);
            if (inviter) inviter.sendMessage("§c§f" + player.name + " §cdeclined your faction invitation.");
        }

        showFactionsMainUI(player);
    });
}

// ============================================
// SECTION 23: JOIN / SEARCH / REQUEST SYSTEM
// ============================================

function showJoinSearchUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const form = new ModalFormData()
        .title("§e§lJoin Faction")
        .dropdown("§6Search By:", ["Faction Name", "Player Name"])
        .textField("§6Enter name to search:", "Type here...");

    form.show(player).then(response => {
        if (response.canceled) { showFactionsMainUI(player); return; }

        const searchType = response.formValues[0];
        const searchInput = (response.formValues[1] || "").trim();

        if (!searchInput) { showJoinSearchUI(player); return; }

        const factions = getAllFactions();
        let targetFaction = null;

        if (searchType === 0) {
            for (const id in factions) {
                if (stripColorCodes(factions[id].name).toLowerCase() === searchInput.toLowerCase()) {
                    targetFaction = factions[id]; break;
                }
            }
        } else {
            for (const p of world.getAllPlayers()) {
                if (p.name.toLowerCase() === searchInput.toLowerCase()) {
                    const fId = getPlayerFactionId(p.id);
                    if (fId) targetFaction = factions[fId];
                    break;
                }
            }
        }

        if (targetFaction) {
            showFactionInfoUI(player, targetFaction.id);
        } else {
            player.sendMessage("§cNo faction found matching that name.");
            showJoinSearchUI(player);
        }
    });
}

function showFactionInfoUI(player, factionId) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) { player.sendMessage("§cFaction no longer exists."); showFactionsMainUI(player); return; }

    const totalPower = calculateFactionPower(faction);
    const memberCount = Object.keys(faction.members).length;
    const statusText = faction.status === "open" ? "§aOpen" : "§cClosed";

    let body = "§7---------------------------\n";
    body += `§7Name: §f${faction.iconUnicode} ${faction.name}\n`;
    body += `§7Status: ${statusText}\n`;
    body += `§7Description: §f${faction.description}\n`;
    body += `§7Members: §f${memberCount}/${faction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}\n`;
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title("§e§lFaction Info")
        .body(body);

    // If player has a pending INVITE to this faction, show Join directly.
    const playerPending = getPlayerPendingRequests(player.id);
    const hasInvite = playerPending.some(r => r.factionId === factionId);

    if (hasInvite) {
        form.button("§aJoin Faction\n§f[ You are invited ]", "textures/rank_colours/green.png");
    } else if (memberCount >= faction.maxMembers) {
        form.button("§cFaction Full\n§f[ Cannot join ]", "textures/rank_colours/red.png");
    } else if (faction.status === "open") {
        form.button("§aJoin Faction\n§f[ Instant join ]", "textures/rank_colours/green.png");
    } else {
        form.button("§dRequest to Join\n§f[ Send a request ]", "textures/pin.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === 0) {
            if (hasInvite) {
                const req = playerPending.find(r => r.factionId === factionId);
                if (req) {
                    showPlayerManageRequestUI(player, req);
                } else {
                    joinFactionDirect(player, factionId);
                }
            } else if (memberCount >= faction.maxMembers) {
                player.sendMessage("§cThis faction is full."); showFactionInfoUI(player, factionId);
            } else if (faction.status === "open") {
                joinFactionDirect(player, factionId);
            } else {
                showRequestToJoinUI(player, factionId);
            }
        } else {
            showJoinSearchUI(player);
        }
    });
}

function joinFactionDirect(player, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction || Object.keys(faction.members).length >= faction.maxMembers) {
        player.sendMessage("§cCannot join right now."); showFactionsMainUI(player); return;
    }

    removePendingRequestsForPlayer(player.id);

    faction.members[player.id] = { role: FACTION_ROLES.MEMBER, power: getPlayerSavedPower(player.id), name: player.name, joinedAt: Date.now(), invitedBy: "System" };
    saveAllFactions(factions);
    setPlayerFaction(player.id, factionId);

    player.sendMessage("§a§l You joined §f" + faction.iconUnicode + " " + faction.name + "§a!");
    player.playSound("random.levelup");
    world.sendMessage(`§6[ZYD-FACTIONS] §a${player.name} joined §f${faction.iconUnicode} ${faction.name}§a!`);
    showFactionsMainUI(player);
}

function showRequestToJoinUI(player, factionId) {
    const factions = getAllFactions();
    const targetFaction = factions[factionId];
    if (!targetFaction) { player.sendMessage("§cFaction no longer exists."); showFactionsMainUI(player); return; }

    if (targetFaction.status === "open") {
        joinFactionDirect(player, factionId);
        return;
    }

    const sentCount = getPlayerActiveJoinRequestsCount(factions, player.id);
    if (sentCount >= MAX_PENDING_INVITATIONS_PER_PLAYER) {
        player.sendMessage(`§cYou already have ${MAX_PENDING_INVITATIONS_PER_PLAYER} active join requests. Wait for them to expire (10m) or be declined.`);
        showFactionInfoUI(player, factionId);
        return;
    }

    if ((targetFaction.pendingRequests || []).length >= MAX_PENDING_REQUESTS_PER_FACTION) {
        player.sendMessage(`§cThis faction's request inbox is full (Max ${MAX_PENDING_REQUESTS_PER_FACTION}).`);
        showFactionInfoUI(player, factionId);
        return;
    }

    const form = new ModalFormData()
        .title("§dRequest to Join")
        .textField("§6Why do you want to join? §8(Optional)", "I want to help build...");

    form.show(player).then(response => {
        if (response.canceled) { showFactionInfoUI(player, factionId); return; }

        const message = (response.formValues[0] || "").trim();
        const factions = getAllFactions();
        const faction = factions[factionId];

        if (!faction || !faction.pendingRequests) { showFactionInfoUI(player, factionId); return; }

        faction.pendingRequests.push({
            playerId: player.id,
            playerName: player.name,
            message: message || "",
            timestamp: Date.now()
        });

        saveAllFactions(factions);
        player.sendMessage("§a§l Request sent to §f" + faction.name + "§a!");

        for (const id in faction.members) {
            if (canManageMembers(faction.members[id].role, faction.members[id])) {
                const member = world.getAllPlayers().find(p => p.id === id);
                if (member) member.sendMessage("§d[ZYD-FACTIONS] §f" + player.name + " §drequested to join your faction!");
            }
        }
        showFactionsMainUI(player);
    });
}

// ============================================
// SECTION 24: FACTION PENDING REQUESTS UI (For faction managers)
// ============================================

function showPendingRequestsUI(player) {
    const faction = getPlayerFaction(player.id);
    if (!faction) return;

    const now = Date.now();
    const factions = getAllFactions();
    const currentFaction = factions[faction.id];

    if (currentFaction && currentFaction.pendingRequests) {
        // Clean expired join requests (10 mins)
        currentFaction.pendingRequests = currentFaction.pendingRequests.filter(r => (now - r.timestamp) < JOIN_REQUEST_EXPIRE_MS);
        currentFaction.pendingSeenCount = currentFaction.pendingRequests.length;
        saveAllFactions(factions);
    }

    if (!currentFaction || !currentFaction.pendingRequests || currentFaction.pendingRequests.length === 0) {
        player.sendMessage("§cNo pending requests."); showMemberListUI(player); return;
    }

    const form = new ActionFormData()
        .title("§dPending Requests")
        .body(`§7Faction: §f${faction.name}\n§7Pending: §d${faction.pendingRequests.length}`);

    for (const req of faction.pendingRequests) {
        let reqPower = getPlayerSavedPower(req.playerId);
        const reqFaction = getPlayerFaction(req.playerId);
        if (reqFaction && reqFaction.members[req.playerId]) reqPower = reqFaction.members[req.playerId].power;
        form.button(`§2${req.playerName}§r\n§fPower: §f${reqPower}/${MAX_POWER_PER_MEMBER}`, "textures/rank_colours/gray.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === faction.pendingRequests.length) { showMemberListUI(player); return; }

        const req = faction.pendingRequests[response.selection];
        showManageRequestUI(player, req.playerId, req.playerName);
    });
}

function showManageRequestUI(player, targetId, targetName) {
    const isOnline = world.getAllPlayers().some(p => p.id === targetId);
    let reqPower = getPlayerSavedPower(targetId);
    const reqFaction = getPlayerFaction(targetId);
    if (reqFaction && reqFaction.members[targetId]) reqPower = reqFaction.members[targetId].power;
    const powerColor = reqPower < 0 ? "§c" : "§b";

    const faction = getPlayerFaction(player.id);
    const req = faction && faction.pendingRequests ? faction.pendingRequests.find(r => r.playerId === targetId) : null;
    const reason = req ? (req.message || "").trim() : "";

    const bodyText = "§7---------------------------\n" +
        `§7Player: §f${targetName}\n` +
        `§7Status: ${isOnline ? "§aOnline" : "§cOffline"}\n` +
        `§7Power: ${powerColor}${reqPower}/${MAX_POWER_PER_MEMBER}\n` +
        (reason ? `§7Reason: §f${reason}\n` : "") +
        "§7---------------------------\n" +
        `§f${targetName} §dwants to join your faction.`;

    const form = new MessageFormData()
        .title("§d§lManage Request")
        .body(bodyText)
        .button1("§aAccept")
        .button2("§cDecline");

    form.show(player).then(response => {
        if (response.canceled) { showPendingRequestsUI(player); return; }

        const factions = getAllFactions();
        const currentFaction = factions[getPlayerFactionId(player.id)];
        if (!currentFaction || !currentFaction.pendingRequests) { showPendingRequestsUI(player); return; }

        currentFaction.pendingRequests = currentFaction.pendingRequests.filter(r => r.playerId !== targetId);

        if (response.selection === 0) {
            if (getPlayerFactionId(targetId)) {
                player.sendMessage(`§c§f${targetName} §cis already in a faction.`);
                saveAllFactions(factions);
                showPendingRequestsUI(player);
                return;
            }
            if (Object.keys(currentFaction.members).length >= currentFaction.maxMembers) {
                player.sendMessage("§cFaction is now full.");
                saveAllFactions(factions);
                showPendingRequestsUI(player);
                return;
            }

            removePendingRequestsForPlayer(targetId);
            currentFaction.members[targetId] = { role: FACTION_ROLES.MEMBER, power: getPlayerSavedPower(targetId), name: targetName, joinedAt: Date.now(), invitedBy: player.name };
            saveAllFactions(factions);
            setPlayerFaction(targetId, currentFaction.id);

            player.sendMessage(`§a§l Accepted §f${targetName} §ainto the faction!`);

            const targetPlayer = world.getAllPlayers().find(p => p.id === targetId);
            if (targetPlayer) {
                targetPlayer.sendMessage("§a§l Your request to join §f" + currentFaction.iconUnicode + " " + currentFaction.name + " §awas accepted!");
                targetPlayer.playSound("random.levelup");
            }
            world.sendMessage(`§6[ZYD-FACTIONS] §a${targetName} joined §f${currentFaction.iconUnicode} ${currentFaction.name}§a!`);
        } else {
            try {
                const playerPending = getPlayerPendingRequests(targetId);
                const filtered = playerPending.filter(r => r.factionId !== currentFaction.id);
                savePlayerPendingRequests(targetId, filtered);
            } catch (e) { }

            saveAllFactions(factions);
            player.sendMessage(`§cDeclined §f${targetName}'s §crequest.`);
            const targetPlayer = world.getAllPlayers().find(p => p.id === targetId);
            if (targetPlayer) targetPlayer.sendMessage("§cYour request to join §f" + currentFaction.iconUnicode + " " + currentFaction.name + " §cwas declined.");
        }

        showPendingRequestsUI(player);
    });
}

// ============================================
// SECTION 25: DIPLOMACY SYSTEM (Allies & Enemies)
// Owner & Admin Exclusive (OP Override Supported)
// ============================================

const opDiplomacyOverride = new Map();

function getDiplomacyFaction(player) {
    const overrideId = opDiplomacyOverride.get(player.id);
    if (overrideId) return getFactionById(overrideId);
    return getPlayerFaction(player.id);
}

function getDiplomacyFactionId(player) {
    const overrideId = opDiplomacyOverride.get(player.id);
    if (overrideId) return overrideId;
    return getPlayerFactionId(player.id);
}

function isDiplomacyOpOverride(player) {
    return opDiplomacyOverride.has(player.id);
}

function showDiplomacyUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const faction = getDiplomacyFaction(player);
    if (!faction) {
        if (isDiplomacyOpOverride(player)) {
            const overrideId = opDiplomacyOverride.get(player.id);
            opDiplomacyOverride.delete(player.id);
            player.sendMessage("§cFaction no longer exists.");
            showOpEditFactionUI(player, overrideId);
        } else {
            showEditFactionUI(player);
        }
        return;
    }

    const isOpOverride = isDiplomacyOpOverride(player);
    let canManageDiplomacy = isOpOverride;
    let canManageRequests = isOpOverride;

    if (!isOpOverride) {
        if (!hasFactionPermission(faction, player.id, "viewDiplomacy")) {
            player.sendMessage("§cYou do not have permission to view Diplomacy.");
            showEditFactionUI(player);
            return;
        }
        canManageDiplomacy = hasFactionPermission(faction, player.id, "manageDiplomacy");
        canManageRequests = hasFactionPermission(faction, player.id, "manageRequests");
    }

    const allyCount = (faction.allies || []).length;
    const enemyCount = (faction.enemies || []).length;
    const allyPendingCount = (faction.allyPendingRequests || []).length;
    const peaceRequestCount = (faction.peaceRequests || []).length;

    const form = new ActionFormData()
        .title(`§6§lDiplomacy — ${faction.name}`)
        .body("§7Manage your faction's allies and enemies.");

    form.button(`§bFaction Allies\n§f( ${allyCount}/${MAX_ALLIES} )`, "textures/rank_colours/green.png");
    form.button(`§cFaction Enemies\n§f( ${enemyCount}/${MAX_ENEMIES} )`, "textures/rank_colours/red.png");

    const totalPendingDiplomacy = allyPendingCount + peaceRequestCount;
    // Only show pending requests if they have permission to manage requests
    if (canManageRequests && totalPendingDiplomacy > 0) {
        form.button(`§dRequest Diplomacy\n§fPending ${totalPendingDiplomacy}/10`, "textures/exclamation.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const alliesIdx = idx++;
        const enemiesIdx = idx++;
        const diplomacyPendingIdx = (canManageRequests && totalPendingDiplomacy > 0) ? idx++ : -1;
        const backIdx = idx;

        if (response.selection === alliesIdx) {
            showDiplomacyAlliesUI(player);
        } else if (response.selection === enemiesIdx) {
            showDiplomacyEnemiesUI(player);
        } else if (response.selection === diplomacyPendingIdx) {
            showDiplomacyPendingOverviewUI(player);
        } else {
            if (isDiplomacyOpOverride(player)) {
                const overrideId = opDiplomacyOverride.get(player.id);
                opDiplomacyOverride.delete(player.id);
                showOpEditFactionUI(player, overrideId);
            } else {
                showEditFactionUI(player);
            }
        }
    });
}

function showOpDiplomacyUI(player, factionId) {
    opDiplomacyOverride.set(player.id, factionId);
    showDiplomacyUI(player);
}

function showDiplomacyAlliesUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyUI(player);

    const isOpOverride = isDiplomacyOpOverride(player);
    const canManageDiplomacy = isOpOverride || hasFactionPermission(faction, player.id, "manageDiplomacy");

    const allies = faction.allies || [];
    const form = new ActionFormData()
        .title("§b§lFaction Allies")
        .body(`§7Faction: §f${faction.name}\n§7Allies: §b${allies.length}/${MAX_ALLIES}`);

    if (canManageDiplomacy) {
        form.button("§aAdd Allies\n§f[ Search & send request ]", "textures/add.png");
    }

    const allFactions = getAllFactions();
    let allyButtons = [];

    for (const allyId of allies) {
        const allyFaction = allFactions[allyId];
        if (!allyFaction) continue;
        const memberCount = Object.keys(allyFaction.members).length;
        const power = calculateFactionPower(allyFaction);
        form.button(`§b${allyFaction.iconUnicode} ${allyFaction.name}\n§fMembers: §2${memberCount} §f| Power: §b${power}`, allyFaction.iconTexture || "textures/factions/faction.png");
        allyButtons.push(allyId);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const addIdx = canManageDiplomacy ? idx++ : -1;
        const allyStart = idx;
        idx += allyButtons.length;
        const backIdx = idx;

        if (response.selection === addIdx) {
            showDiplomacySearchUI(player, "ally");
        } else if (response.selection >= allyStart && response.selection < allyStart + allyButtons.length) {
            showDiplomacyAllyDetailUI(player, allyButtons[response.selection - allyStart]);
        } else {
            showDiplomacyUI(player);
        }
    });
}

function showDiplomacyAllyDetailUI(player, allyFactionId) {
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyAlliesUI(player);

    const allFactions = getAllFactions();
    const allyFaction = allFactions[allyFactionId];
    if (!allyFaction) {
        player.sendMessage("§cThis faction no longer exists.");
        showDiplomacyAlliesUI(player);
        return;
    }

    const memberCount = Object.keys(allyFaction.members).length;
    const totalPower = calculateFactionPower(allyFaction);
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
    const statusText = allyFaction.status === "open" ? "§aOpen" : "§cClosed";

    let body = "§7---------------------------\n";
    body += `§7Name: §b${allyFaction.iconUnicode} ${allyFaction.name}\n`;
    body += `§7Status: ${statusText}\n`;
    body += `§7Description: §f${allyFaction.description}\n`;
    body += `§7Members: §f${memberCount}/${allyFaction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    body += "§7---------------------------";

    const enemyCount = (faction.enemies || []).length;
    const theirEnemyCount = (allyFaction.enemies || []).length;
    const canBetray = enemyCount < MAX_ENEMIES && theirEnemyCount < MAX_ENEMIES;

    const form = new ActionFormData()
        .title("§b§lAlly Details")
        .body(body);

    const isOpOverride = isDiplomacyOpOverride(player);
    const canManageDiplomacy = isOpOverride || hasFactionPermission(faction, player.id, "manageDiplomacy");

    if (canManageDiplomacy) {
        form.button("§eRemove Ally\n§f[ End the alliance ]", "textures/rank_colours/yellow.png");

        if (canBetray) {
            form.button("§cBetray Ally\n§f[ Make them your enemy ]", "textures/rank_colours/red.png");
        } else {
            form.button("§cBetray Ally\n§f[ Enemy list is full ]", "textures/rank_colours/gray.png");
        }
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const removeIdx = canManageDiplomacy ? idx++ : -1;
        const betrayIdx = canManageDiplomacy ? idx++ : -1;
        const backIdx = idx;

        if (response.selection === removeIdx) {
            showDiplomacyRemoveAllyConfirmUI(player, allyFactionId, allyFaction.name);
        } else if (response.selection === betrayIdx && canBetray) {
            showDiplomacyBetrayAllyConfirmUI(player, allyFactionId, allyFaction.name);
        } else {
            showDiplomacyAlliesUI(player);
        }
    });
}

function showDiplomacyRemoveAllyConfirmUI(player, allyFactionId, allyFactionName) {
    const form = new MessageFormData()
        .title("§e§lRemove Ally")
        .body(`§eAre you sure you want to remove §b${allyFactionName} §eas your ally?\n\n§7The alliance will be ended for both factions.`)
        .button1("§eYes, Remove Ally")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacyAllyDetailUI(player, allyFactionId);
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        myFaction.allies = (myFaction.allies || []).filter(id => id !== allyFactionId);
        if (factions[allyFactionId]) {
            factions[allyFactionId].allies = (factions[allyFactionId].allies || []).filter(id => id !== myFaction.id);
        }
        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§a§l Removed §b${allyFactionName} §afrom your allies.`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §e${myName} §7has ended their alliance with §b${allyFactionName}§7.`);

        if (factions[allyFactionId]) {
            for (const mid in factions[allyFactionId].members) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§6[ZYD-FACTIONS] §e${myName} §7has ended your alliance.`);
            }
        }

        showDiplomacyAlliesUI(player);
    });
}

function showDiplomacyBetrayAllyConfirmUI(player, allyFactionId, allyFactionName) {
    const form = new MessageFormData()
        .title("§c§lBetray Ally")
        .body(`§c§lWARNING!§r\n\n§cAre you sure you want to BETRAY §b${allyFactionName}§c?\n\n§7• The alliance will be broken\n§7• They will become your enemy\n§7• This will be broadcast to the server\n\n§cThis action cannot be undone easily.`)
        .button1("§cYes, Betray Them")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacyAllyDetailUI(player, allyFactionId);
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        if (factions[allyFactionId] && (factions[allyFactionId].enemies || []).length >= MAX_ENEMIES) {
            player.sendMessage(`§cCannot betray ally. §f${allyFactionName} §calready has the maximum number of enemies (${MAX_ENEMIES}).`);
            showDiplomacyAllyDetailUI(player, allyFactionId);
            return;
        }

        myFaction.allies = (myFaction.allies || []).filter(id => id !== allyFactionId);
        if (factions[allyFactionId]) {
            factions[allyFactionId].allies = (factions[allyFactionId].allies || []).filter(id => id !== myFaction.id);
            factions[allyFactionId].enemies = factions[allyFactionId].enemies || [];
            factions[allyFactionId].enemies.push({ factionId: myFaction.id, declaredBy: myFaction.id, timestamp: Date.now() });
        }
        myFaction.enemies = myFaction.enemies || [];
        myFaction.enemies.push({ factionId: allyFactionId, declaredBy: myFaction.id, timestamp: Date.now() });

        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§c§l You have betrayed §b${allyFactionName}§c! They are now your enemy.`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §c${myName} §chas BETRAYED their ally §b${allyFactionName}§c! §7They are now enemies.`);

        if (factions[allyFactionId]) {
            for (const mid in factions[allyFactionId].members) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§c[ZYD-FACTIONS] §c${myName} §chas BETRAYED your alliance! §7You are now enemies.`);
            }
        }

        showDiplomacyAlliesUI(player);
    });
}

// ============================================
// DIPLOMACY: FACTION ENEMIES LIST
// ============================================

function showDiplomacyEnemiesUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyUI(player);

    const isOpOverride = isDiplomacyOpOverride(player);
    const canManageDiplomacy = isOpOverride || hasFactionPermission(faction, player.id, "manageDiplomacy");

    const enemies = faction.enemies || [];
    const form = new ActionFormData()
        .title("§c§lFaction Enemies")
        .body(`§7Faction: §f${faction.name}\n§7Enemies: §c${enemies.length}/${MAX_ENEMIES}`);

    const canAdd = enemies.length < MAX_ENEMIES;
    if (canManageDiplomacy) {
        if (canAdd) {
            form.button("§cAdd Enemy\n§f[ Search & declare ]", "textures/add.png");
        } else {
            form.button(`§cEnemy List Full\n§f[ Max ${MAX_ENEMIES} reached ]`, "textures/rank_colours/gray.png");
        }
    }

    const allFactions = getAllFactions();
    let enemyButtons = [];

    for (const enemyData of enemies) {
        const enemyFaction = allFactions[enemyData.factionId];
        if (!enemyFaction) continue;
        const memberCount = Object.keys(enemyFaction.members).length;
        const power = calculateFactionPower(enemyFaction);
        form.button(`§c${enemyFaction.iconUnicode} ${enemyFaction.name}\n§fMembers: §2${memberCount} §f| Power: §b${power}`, enemyFaction.iconTexture || "textures/factions/faction.png");
        enemyButtons.push(enemyData);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const addIdx = canManageDiplomacy ? idx++ : -1;
        const enemyStart = idx;
        idx += enemyButtons.length;
        const backIdx = idx;

        if (response.selection === addIdx && canAdd) {
            showDiplomacySearchUI(player, "enemy");
        } else if (response.selection >= enemyStart && response.selection < enemyStart + enemyButtons.length) {
            showDiplomacyEnemyDetailUI(player, enemyButtons[response.selection - enemyStart]);
        } else {
            showDiplomacyUI(player);
        }
    });
}

function showDiplomacyEnemyDetailUI(player, enemyData) {
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyEnemiesUI(player);

    const allFactions = getAllFactions();
    const enemyFaction = allFactions[enemyData.factionId];
    if (!enemyFaction) {
        player.sendMessage("§cThis faction no longer exists.");
        showDiplomacyEnemiesUI(player);
        return;
    }

    const declaredByUs = enemyData.declaredBy === faction.id;
    const memberCount = Object.keys(enemyFaction.members).length;
    const totalPower = calculateFactionPower(enemyFaction);
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;

    let body = "§7---------------------------\n";
    body += `§7Name: §c${enemyFaction.iconUnicode} ${enemyFaction.name}\n`;
    body += `§7Members: §f${memberCount}/${enemyFaction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    body += `§7Declared by: ${declaredByUs ? "§eYour faction" : "§c" + enemyFaction.name + "§7"}\n`;
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title("§c§lEnemy Details")
        .body(body);

    const isOpOverride = isDiplomacyOpOverride(player);
    const canManageDiplomacy = isOpOverride || hasFactionPermission(faction, player.id, "manageDiplomacy");

    if (canManageDiplomacy) {
        if (declaredByUs) {
            form.button("§eRemove Enemy\n§f[ End the enmity ]", "textures/rank_colours/yellow.png");
        } else {
            const peacePending = (faction.peaceRequests || []).some(r => r.fromFactionId === enemyFaction.id);
            if (peacePending) {
                form.button("§ePeace Request Sent\n§f[ Awaiting response ]", "textures/rank_colours/gray.png");
            } else {
                form.button("§aSend Peace Request\n§f[ Request to end enmity ]", "textures/pin.png");
            }
        }
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const manageIdx = canManageDiplomacy ? idx++ : -1;
        const backIdx = idx;

        if (response.selection === manageIdx) {
            if (declaredByUs) {
                showDiplomacyRemoveEnemyConfirmUI(player, enemyData);
            } else {
                const peacePending = (faction.peaceRequests || []).some(r => r.fromFactionId === enemyFaction.id);
                if (!peacePending) {
                    showDiplomacySendPeaceRequestUI(player, enemyData.factionId, enemyFaction.name);
                } else {
                    showDiplomacyEnemiesUI(player);
                }
            }
        } else {
            showDiplomacyEnemiesUI(player);
        }
    });
}

function showDiplomacyRemoveEnemyConfirmUI(player, enemyData) {
    const allFactions = getAllFactions();
    const enemyFaction = allFactions[enemyData.factionId];
    const enemyName = enemyFaction ? (enemyFaction.iconUnicode + " " + enemyFaction.name) : "Unknown";

    const form = new MessageFormData()
        .title("§e§lRemove Enemy")
        .body(`§eAre you sure you want to remove §c${enemyName} §efrom your enemies?\n\n§7The enmity will be ended for both factions.`)
        .button1("§eYes, Remove Enemy")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacyEnemyDetailUI(player, enemyData);
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        myFaction.enemies = (myFaction.enemies || []).filter(e => e.factionId !== enemyData.factionId);
        if (factions[enemyData.factionId]) {
            factions[enemyData.factionId].enemies = (factions[enemyData.factionId].enemies || []).filter(e => e.factionId !== myFaction.id);
        }
        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§a§l Removed §c${enemyName} §afrom your enemies.`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §e${myName} §7has ended their enmity with §c${enemyName}§7.`);

        if (factions[enemyData.factionId]) {
            for (const mid in factions[enemyData.factionId].members) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§6[ZYD-FACTIONS] §e${myName} §7has ended their enmity with you.`);
            }
        }

        showDiplomacyEnemiesUI(player);
    });
}

function showDiplomacySendPeaceRequestUI(player, targetFactionId, targetFactionName) {
    const form = new MessageFormData()
        .title("§a§lSend Peace Request")
        .body(`§aSend a §eDeclaration of Peace §ato §c${targetFactionName}§a?\n\n§7If they accept, the enmity will be ended for both factions.`)
        .button1("§aYes, Send Request")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacyEnemiesUI(player);
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        const targetFaction = factions[targetFactionId];
        if (!targetFaction) {
            player.sendMessage("§cThis faction no longer exists.");
            showDiplomacyEnemiesUI(player);
            return;
        }

        if (!targetFaction.peaceRequests) targetFaction.peaceRequests = [];
        if (targetFaction.peaceRequests.length >= MAX_PEACE_REQUESTS) {
            player.sendMessage(`§cTheir peace request list is full (max ${MAX_PEACE_REQUESTS}).`);
            showDiplomacyEnemiesUI(player);
            return;
        }
        if (targetFaction.peaceRequests.some(r => r.fromFactionId === myFaction.id)) {
            player.sendMessage("§cYou already have a pending peace request to this faction.");
            showDiplomacyEnemiesUI(player);
            return;
        }

        targetFaction.peaceRequests.push({
            fromFactionId: myFaction.id,
            fromFactionName: myFaction.name,
            fromFactionIcon: myFaction.iconUnicode || "",
            timestamp: Date.now()
        });
        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§a§l Peace request sent to §c${targetFactionName}§a!`);
        player.playSound("random.orb");

        for (const mid in targetFaction.members) {
            const mRole = targetFaction.members[mid].role;
            if (mRole === FACTION_ROLES.OWNER || mRole === FACTION_ROLES.ADMIN) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§a[ZYD-FACTIONS] §e${myName} §ahas sent a §eDeclaration of Peace§a! Check §6Diplomacy > Request Diplomacy§a.`);
            }
        }

        showDiplomacyEnemiesUI(player);
    });
}

function showDiplomacySearchUI(player, mode) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const form = new ActionFormData()
        .title(mode === "ally" ? "§a§lAdd Allies" : "§c§lAdd Enemy")
        .body(mode === "ally" ? "§7Search for a faction to send an ally request:" : "§7Search for a faction to declare as enemy:");

    form.button("§aSelect Online Player\n§f[ Pick from online list ]", "textures/list.png");
    form.button("§bSearch by Faction Name\n§f[ Type faction name ]", "textures/edit2.png");
    form.button("§eSearch by Player Name\n§f[ Type player name ]", "textures/tpa2.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === 0) showDiplomacySelectOnlineUI(player, mode);
        else if (response.selection === 1) showDiplomacySearchInputUI(player, mode, "faction");
        else if (response.selection === 2) showDiplomacySearchInputUI(player, mode, "player");
        else {
            if (mode === "ally") showDiplomacyAlliesUI(player);
            else showDiplomacyEnemiesUI(player);
        }
    });
}

function showDiplomacySelectOnlineUI(player, mode) {
    const myFactionId = getDiplomacyFactionId(player);
    const onlinePlayers = world.getAllPlayers().filter(p => {
        if (p.id === player.id) return false;
        const pFactionId = getPlayerFactionId(p.id);
        return pFactionId && pFactionId !== myFactionId;
    });

    if (onlinePlayers.length === 0) {
        player.sendMessage("§cNo eligible online faction members found.");
        showDiplomacySearchUI(player, mode);
        return;
    }

    const playerNames = onlinePlayers.map(p => p.name);
    const form = new ModalFormData()
        .title("§a§lSelect Online Player")
        .dropdown("§6Choose a player:", playerNames);

    form.show(player).then(response => {
        if (response.canceled) { showDiplomacySearchUI(player, mode); return; }
        const selectedPlayer = onlinePlayers[response.formValues[0]];
        if (!selectedPlayer) { showDiplomacySelectOnlineUI(player, mode); return; }

        const fId = getPlayerFactionId(selectedPlayer.id);
        if (fId) {
            showDiplomacySearchResultUI(player, fId, mode);
        } else {
            player.sendMessage("§cPlayer is no longer in a faction.");
            showDiplomacySelectOnlineUI(player, mode);
        }
    });
}

function showDiplomacySearchInputUI(player, mode, searchType) {
    const titleText = mode === "ally" ? "§a§lSearch Ally" : "§c§lSearch Enemy";
    const promptText = searchType === "faction" ? "Enter faction name:" : "Enter player name:";

    const form = new ModalFormData()
        .title(titleText)
        .textField(`§6${promptText}`, "Type here...");

    form.show(player).then(response => {
        if (response.canceled) {
            showDiplomacySearchUI(player, mode);
            return;
        }

        const searchInput = (response.formValues[0] || "").trim();
        if (!searchInput) {
            showDiplomacySearchInputUI(player, mode, searchType);
            return;
        }

        const factions = getAllFactions();
        const myFactionId = getDiplomacyFactionId(player);
        let targetFaction = null;

        if (searchType === "faction") {
            for (const id in factions) {
                if (id === myFactionId) continue;
                if (stripColorCodes(factions[id].name).toLowerCase() === searchInput.toLowerCase()) {
                    targetFaction = factions[id];
                    break;
                }
            }
        } else {
            for (const p of world.getAllPlayers()) {
                if (p.id === player.id) continue;
                const fId = getPlayerFactionId(p.id);
                if (fId && fId !== myFactionId) {
                    targetFaction = factions[fId];
                    break;
                }
            }
            if (!targetFaction) {
                for (const id in factions) {
                    if (id === myFactionId) continue;
                    for (const mid in factions[id].members) {
                        const mName = factions[id].members[mid].name || "";
                        if (mName.toLowerCase() === searchInput.toLowerCase()) {
                            targetFaction = factions[id];
                            break;
                        }
                    }
                    if (targetFaction) break;
                }
            }
        }

        if (targetFaction) {
            showDiplomacySearchResultUI(player, targetFaction.id, mode);
        } else {
            player.sendMessage("§cNo faction found matching that name.");
            showDiplomacySearchInputUI(player, mode, searchType);
        }
    });
}

function showDiplomacySearchResultUI(player, targetFactionId, mode) {
    const factions = getAllFactions();
    const myFaction = factions[getDiplomacyFactionId(player)];
    const targetFaction = factions[targetFactionId];
    if (!myFaction || !targetFaction) {
        player.sendMessage("§cFaction no longer exists.");
        showDiplomacySearchUI(player, mode);
        return;
    }

    const memberCount = Object.keys(targetFaction.members).length;
    const totalPower = calculateFactionPower(targetFaction);
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
    const statusText = targetFaction.status === "open" ? "§aOpen" : "§cClosed";

    let body = "§7---------------------------\n";
    body += `§7Name: §f${targetFaction.iconUnicode} ${targetFaction.name}\n`;
    body += `§7Status: ${statusText}\n`;
    body += `§7Description: §f${targetFaction.description}\n`;
    body += `§7Members: §f${memberCount}/${targetFaction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title(mode === "ally" ? "§a§lAlly Search Result" : "§c§lEnemy Search Result")
        .body(body);

    let canProceed = false;
    let isEnemyToAlly = false;

    if (mode === "ally") {
        if ((myFaction.allies || []).includes(targetFactionId)) {
            form.button("§eAlready Allied\n§f[ You are allies ]", "textures/rank_colours/gray.png");
        } else if ((myFaction.enemies || []).some(e => e.factionId === targetFactionId)) {
            const peacePending = (targetFaction.allyPendingRequests || []).some(r => r.fromFactionId === myFaction.id && r.isEnemyToAlly);
            if (peacePending) {
                form.button("§eRequest Sent\n§f[ Awaiting response ]", "textures/rank_colours/gray.png");
            } else {
                form.button("§eRequest Alliance\n§f[ End war, become permanent allies ]", "textures/rank_colours/yellow.png");
                canProceed = true;
                isEnemyToAlly = true;
            }
        } else if ((targetFaction.allyPendingRequests || []).some(r => r.fromFactionId === myFaction.id)) {
            form.button("§eRequest Already Sent\n§f[ Awaiting response ]", "textures/rank_colours/gray.png");
        } else if ((myFaction.allies || []).length >= MAX_ALLIES) {
            form.button(`§cAlly List Full\n§f[ Max ${MAX_ALLIES} reached ]`, "textures/rank_colours/gray.png");
        } else if ((targetFaction.allies || []).length >= MAX_ALLIES) {
            form.button(`§cTheir Ally List Full\n§f[ They reached max ]`, "textures/rank_colours/gray.png");
        } else if ((targetFaction.allyPendingRequests || []).length >= MAX_ALLY_PENDING_REQUESTS) {
            form.button(`§cTheir Pending Full\n§f[ Max ${MAX_ALLY_PENDING_REQUESTS} reached ]`, "textures/rank_colours/gray.png");
        } else {
            form.button("§aRequest Ally Invitation\n§f[ Send ally request ]", "textures/rank_colours/green.png");
            canProceed = true;
        }
    } else {
        if ((myFaction.allies || []).includes(targetFactionId)) {
            form.button("§eCurrently Allied\n§f[ Betray them first ]", "textures/rank_colours/gray.png");
        } else if ((myFaction.enemies || []).some(e => e.factionId === targetFactionId)) {
            form.button("§cAlready Enemies\n§f[ You are enemies ]", "textures/rank_colours/gray.png");
        } else if ((myFaction.enemies || []).length >= MAX_ENEMIES) {
            form.button(`§cEnemy List Full\n§f[ Max ${MAX_ENEMIES} reached ]`, "textures/rank_colours/gray.png");
        } else if ((targetFaction.enemies || []).length >= MAX_ENEMIES) {
            form.button(`§cTheir Enemy List Full\n§f[ They reached max ]`, "textures/rank_colours/gray.png");
        } else {
            form.button("§cMake Them Enemy\n§f[ Declare as enemy ]", "textures/rank_colours/red.png");
            canProceed = true;
        }
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === 0 && canProceed) {
            if (mode === "ally") {
                if (isEnemyToAlly) {
                    showDiplomacySendEnemyAllyConfirmUI(player, targetFactionId, targetFaction.name);
                } else {
                    showDiplomacySendAllyRequestConfirmUI(player, targetFactionId, targetFaction.name);
                }
            } else {
                showDiplomacyMakeEnemyConfirmUI(player, targetFactionId, targetFaction.name);
            }
        } else {
            showDiplomacySearchUI(player, mode);
        }
    });
}

function showDiplomacySendAllyRequestConfirmUI(player, targetFactionId, targetFactionName) {
    const form = new MessageFormData()
        .title("§a§lRequest Ally Invitation")
        .body(`§aSend an ally request to §b${targetFactionName}§a?\n\n§7If they accept, both factions will become allies.`)
        .button1("§aYes, Send Request")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacySearchResultUI(player, targetFactionId, "ally");
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        const targetFaction = factions[targetFactionId];
        if (!targetFaction) {
            player.sendMessage("§cThis faction no longer exists.");
            showDiplomacySearchUI(player, "ally");
            return;
        }

        if (!targetFaction.allyPendingRequests) targetFaction.allyPendingRequests = [];
        if (targetFaction.allyPendingRequests.some(r => r.fromFactionId === myFaction.id)) {
            player.sendMessage("§cYou already have a pending ally request to this faction.");
            showDiplomacySearchResultUI(player, targetFactionId, "ally");
            return;
        }

        targetFaction.allyPendingRequests.push({
            fromFactionId: myFaction.id,
            fromFactionName: myFaction.name,
            fromFactionIcon: myFaction.iconUnicode || "",
            timestamp: Date.now()
        });
        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§a§l Ally request sent to §b${targetFactionName}§a!`);
        player.playSound("random.orb");

        for (const mid in targetFaction.members) {
            const mRole = targetFaction.members[mid].role;
            if (mRole === FACTION_ROLES.OWNER || mRole === FACTION_ROLES.ADMIN) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§a[ZYD-FACTIONS] §e${myName} §ahas sent an §bAlly Request§a! Check §6Diplomacy > Request Diplomacy§a.`);
            }
        }

        showDiplomacySearchUI(player, "ally");
    });
}

function showDiplomacySendEnemyAllyConfirmUI(player, targetFactionId, targetFactionName) {
    const form = new MessageFormData()
        .title("§e§lRequest Permanent Alliance")
        .body(`§eSend an alliance request to §c${targetFactionName}§e?\n\n§7If they accept, the war will end §cPERMANENTLY§7 and both factions will become allies.`)
        .button1("§eYes, Send Request")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacySearchResultUI(player, targetFactionId, "ally");
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        const targetFaction = factions[targetFactionId];
        if (!targetFaction) {
            player.sendMessage("§cThis faction no longer exists.");
            showDiplomacySearchUI(player, "ally");
            return;
        }

        if (!targetFaction.allyPendingRequests) targetFaction.allyPendingRequests = [];
        if (targetFaction.allyPendingRequests.some(r => r.fromFactionId === myFaction.id)) {
            player.sendMessage("§cYou already have a pending request to this faction.");
            showDiplomacySearchResultUI(player, targetFactionId, "ally");
            return;
        }

        targetFaction.allyPendingRequests.push({
            fromFactionId: myFaction.id,
            fromFactionName: myFaction.name,
            fromFactionIcon: myFaction.iconUnicode || "",
            isEnemyToAlly: true,
            timestamp: Date.now()
        });
        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§e§l Alliance request sent to §c${targetFactionName}§e!`);
        player.playSound("random.orb");

        for (const mid in targetFaction.members) {
            const mRole = targetFaction.members[mid].role;
            if (mRole === FACTION_ROLES.OWNER || mRole === FACTION_ROLES.ADMIN) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§e[ZYD-FACTIONS] §c${myName} §ehas sent a §6Permanent Alliance Request§e! Check §6Diplomacy > Request Diplomacy§e.`);
            }
        }

        showDiplomacySearchUI(player, "ally");
    });
}

function showDiplomacyMakeEnemyConfirmUI(player, targetFactionId, targetFactionName) {
    const form = new MessageFormData()
        .title("§c§lDeclare Enemy")
        .body(`§cAre you sure you want to declare §c${targetFactionName} §cas your enemy?\n\n§7• Both factions will see each other as enemies\n§7• Only your faction can remove this enmity\n§7• They can send a peace request to end it\n\n§cThis action will be broadcast to the server.`)
        .button1("§cYes, Declare Enemy")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showDiplomacySearchResultUI(player, targetFactionId, "enemy");
            return;
        }

        const factions = getAllFactions();
        const myFaction = factions[getDiplomacyFactionId(player)];
        if (!myFaction) return showDiplomacyUI(player);

        const targetFaction = factions[targetFactionId];
        if (!targetFaction) {
            player.sendMessage("§cThis faction no longer exists.");
            showDiplomacySearchUI(player, "enemy");
            return;
        }

        if ((targetFaction.enemies || []).length >= MAX_ENEMIES) {
            player.sendMessage(`§cCannot declare enemy. §f${targetFactionName} §calready has the maximum number of enemies (${MAX_ENEMIES}).`);
            showDiplomacySearchUI(player, "enemy");
            return;
        }

        myFaction.enemies = myFaction.enemies || [];
        myFaction.enemies.push({ factionId: targetFactionId, declaredBy: myFaction.id, timestamp: Date.now() });

        targetFaction.enemies = targetFaction.enemies || [];
        targetFaction.enemies.push({ factionId: myFaction.id, declaredBy: myFaction.id, timestamp: Date.now() });

        myFaction.allies = (myFaction.allies || []).filter(id => id !== targetFactionId);
        targetFaction.allies = (targetFaction.allies || []).filter(id => id !== myFaction.id);

        // Cancel any pending diplomacy requests between them
        myFaction.allyPendingRequests = (myFaction.allyPendingRequests || []).filter(r => r.fromFactionId !== targetFactionId);
        targetFaction.allyPendingRequests = (targetFaction.allyPendingRequests || []).filter(r => r.fromFactionId !== myFaction.id);
        myFaction.peaceRequests = (myFaction.peaceRequests || []).filter(r => r.fromFactionId !== targetFactionId);
        targetFaction.peaceRequests = (targetFaction.peaceRequests || []).filter(r => r.fromFactionId !== myFaction.id);

        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§c§l You have declared §c${targetFactionName} §cas your enemy!`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §c${myName} §chas declared §c${targetFactionName} §cas their §cENEMY§c!`);

        for (const mid in targetFaction.members) {
            const m = world.getAllPlayers().find(p => p.id === mid);
            if (m) m.sendMessage(`§c[ZYD-FACTIONS] §c${myName} §chas declared your faction as their §cENEMY§c!`);
        }

        showDiplomacySearchUI(player, "enemy");
    });
}

// ============================================
// PENDING DIPLOMACY OVERVIEW
// ============================================

function showDiplomacyPendingOverviewUI(player) {
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyUI(player);

    const now = Date.now();
    const factions = getAllFactions();
    const currentFaction = factions[faction.id];

    // Clean up expired requests (older than 10 mins)
    if (currentFaction.allyPendingRequests) {
        currentFaction.allyPendingRequests = currentFaction.allyPendingRequests.filter(r => now - r.timestamp < DIPLOMACY_REQUEST_EXPIRE_MS);
    }
    if (currentFaction.peaceRequests) {
        currentFaction.peaceRequests = currentFaction.peaceRequests.filter(r => now - r.timestamp < DIPLOMACY_REQUEST_EXPIRE_MS);
    }
    saveAllFactions(factions);

    const allyPending = currentFaction.allyPendingRequests || [];
    const peacePending = currentFaction.peaceRequests || [];
    const totalCount = allyPending.length + peacePending.length;

    if (totalCount === 0) {
        player.sendMessage("§7No pending diplomacy requests.");
        showDiplomacyUI(player);
        return;
    }

    const form = new ActionFormData()
        .title("§d§lRequest Diplomacy")
        .body(`§7Faction: §f${faction.name}\n§7Pending Requests: §f${totalCount}/10\n\n§dPink = Ally/Peace Treaty\n§eYellow = Peace`);

    const allFactions = getAllFactions();
    let allyButtons = [];
    for (const req of allyPending) {
        const reqFaction = allFactions[req.fromFactionId];
        if (!reqFaction) continue;
        const memberCount = Object.keys(reqFaction.members).length;
        const power = calculateFactionPower(reqFaction);
        const reqType = req.isEnemyToAlly ? "§e[Peace Treaty]" : "§d[Ally]";
        form.button(`§f${reqFaction.iconUnicode} ${req.fromFactionName}\n${reqType} §b${power} §fPower`, reqFaction.iconTexture || "textures/factions/faction.png");
        allyButtons.push(req);
    }

    let peaceButtons = [];
    for (const req of peacePending) {
        const reqFaction = allFactions[req.fromFactionId];
        if (!reqFaction) continue;
        const memberCount = Object.keys(reqFaction.members).length;
        const power = calculateFactionPower(reqFaction);
        form.button(`§e${reqFaction.iconUnicode} ${req.fromFactionName}\n§e[Peace] §b${power} §fPower`, reqFaction.iconTexture || "textures/factions/faction.png");
        peaceButtons.push(req);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const allyStart = idx;
        idx += allyButtons.length;
        const peaceStart = idx;
        idx += peaceButtons.length;
        const backIdx = idx;

        if (response.selection >= allyStart && response.selection < allyStart + allyButtons.length) {
            showDiplomacyManageAllyRequestUI(player, allyButtons[response.selection - allyStart]);
        } else if (response.selection >= peaceStart && response.selection < peaceStart + peaceButtons.length) {
            showDiplomacyManagePeaceRequestUI(player, peaceButtons[response.selection - peaceStart]);
        } else {
            showDiplomacyUI(player);
        }
    });
}

function showDiplomacyAllyPendingUI(player) {
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyUI(player);

    const pending = faction.allyPendingRequests || [];
    const form = new ActionFormData()
        .title("§d§lAlly Pending")
        .body(`§7Faction: §f${faction.name}\n§7Pending Requests: §d${pending.length}/${MAX_ALLY_PENDING_REQUESTS}`);

    form.button("§aAdd Allies\n§f[ Send ally request ]", "textures/add.png");

    const allFactions = getAllFactions();
    let pendingButtons = [];

    for (const req of pending) {
        const reqFaction = allFactions[req.fromFactionId];
        if (!reqFaction) continue;
        const memberCount = Object.keys(reqFaction.members).length;
        const power = calculateFactionPower(reqFaction);
        form.button(`§d${reqFaction.iconUnicode} ${req.fromFactionName}\n§fMembers: §2${memberCount} §f| Power: §b${power}`, reqFaction.iconTexture || "textures/factions/faction.png");
        pendingButtons.push(req);
    }

    if (pendingButtons.length === 0) {
        form.button("§cNo Peace Requests\n§f[ None at this time ]", "textures/rank_colours/gray.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const addIdx = idx++;
        const pendingStart = idx;
        idx += pendingButtons.length > 0 ? pendingButtons.length : 1;
        const backIdx = idx;

        if (response.selection === addIdx) {
            showDiplomacySearchUI(player, "ally");
        } else if (pendingButtons.length > 0 && response.selection >= pendingStart && response.selection < pendingStart + pendingButtons.length) {
            showDiplomacyManageAllyRequestUI(player, pendingButtons[response.selection - pendingStart]);
        } else {
            showDiplomacyUI(player);
        }
    });
}

function showDiplomacyManageAllyRequestUI(player, req) {
    const factions = getAllFactions();
    const myFaction = factions[getDiplomacyFactionId(player)];
    const reqFaction = factions[req.fromFactionId];
    if (!myFaction || !reqFaction) {
        player.sendMessage("§cFaction no longer exists.");
        showDiplomacyPendingOverviewUI(player);
        return;
    }

    const memberCount = Object.keys(reqFaction.members).length;
    const totalPower = calculateFactionPower(reqFaction);
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;

    let body = "§7---------------------------\n";
    body += `§7Faction: §d${reqFaction.iconUnicode} ${req.fromFactionName}\n`;
    body += `§7Description: §f${reqFaction.description}\n`;
    body += `§7Members: §f${memberCount}/${reqFaction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    body += "§7---------------------------\n\n";
    body += `§d${req.fromFactionName} §dwants to become your ally.`;

    const form = new MessageFormData()
        .title("§d§lManage Ally Request")
        .body(body)
        .button1("§aAccept")
        .button2("§cDecline");

    form.show(player).then(response => {
        if (response.canceled) { showDiplomacyPendingOverviewUI(player); return; }

        const factions2 = getAllFactions();
        const currentFaction = factions2[getDiplomacyFactionId(player)];
        const currentReqFaction = factions2[req.fromFactionId];
        if (!currentFaction || !currentReqFaction) {
            player.sendMessage("§cFaction no longer exists.");
            showDiplomacyPendingOverviewUI(player);
            return;
        }

        currentFaction.allyPendingRequests = (currentFaction.allyPendingRequests || []).filter(r => r.fromFactionId !== req.fromFactionId);

        if (response.selection === 0) {
            if (req.isEnemyToAlly) {
                // Permanently remove from enemies
                currentFaction.enemies = (currentFaction.enemies || []).filter(e => e.factionId !== req.fromFactionId);
                currentReqFaction.enemies = (currentReqFaction.enemies || []).filter(e => e.factionId !== currentFaction.id);

                // Permanently add to allies
                currentFaction.allies = currentFaction.allies || [];
                currentFaction.allies.push(req.fromFactionId);
                currentReqFaction.allies = currentReqFaction.allies || [];
                currentReqFaction.allies.push(currentFaction.id);

                saveAllFactions(factions2);
                const myName = currentFaction.iconUnicode + " " + currentFaction.name;
                const reqName = currentReqFaction.iconUnicode + " " + currentReqFaction.name;
                player.sendMessage(`§a§l Accepted alliance with §b${req.fromFactionName}§a! The war is over permanently.`);
                player.playSound("random.levelup");
                world.sendMessage(`§6[ZYD-FACTIONS] §a${myName} §7and §a${reqName} §7have ended their war and formed a §bPERMANENT ALLIANCE§7!`);

                for (const mid in currentReqFaction.members) {
                    const m = world.getAllPlayers().find(p => p.id === mid);
                    if (m) m.sendMessage(`§a[ZYD-FACTIONS] §a${myName} §ahas accepted your alliance request! You are now §bPERMANENT ALLIES§a!`);
                }
                showDiplomacyPendingOverviewUI(player);
                return;
            } else {
                if ((currentFaction.allies || []).length >= MAX_ALLIES) {
                    player.sendMessage(`§cYour ally list is full (max ${MAX_ALLIES}).`);
                    saveAllFactions(factions2);
                    showDiplomacyPendingOverviewUI(player);
                    return;
                }
                if ((currentReqFaction.allies || []).length >= MAX_ALLIES) {
                    player.sendMessage(`§cTheir ally list is full (max ${MAX_ALLIES}).`);
                    saveAllFactions(factions2);
                    showDiplomacyPendingOverviewUI(player);
                    return;
                }

                currentFaction.enemies = (currentFaction.enemies || []).filter(e => e.factionId !== req.fromFactionId);
                currentReqFaction.enemies = (currentReqFaction.enemies || []).filter(e => e.factionId !== currentFaction.id);

                currentFaction.allies = currentFaction.allies || [];
                currentFaction.allies.push(req.fromFactionId);
                currentReqFaction.allies = currentReqFaction.allies || [];
                currentReqFaction.allies.push(currentFaction.id);

                saveAllFactions(factions2);

                const myName = currentFaction.iconUnicode + " " + currentFaction.name;
                const reqName = currentReqFaction.iconUnicode + " " + currentReqFaction.name;
                player.sendMessage(`§a§l Accepted ally request from §b${req.fromFactionName}§a!`);
                player.playSound("random.levelup");
                world.sendMessage(`§6[ZYD-FACTIONS] §a${myName} §7and §a${reqName} §7have formed an §bALLIANCE§7!`);

                for (const mid in currentReqFaction.members) {
                    const m = world.getAllPlayers().find(p => p.id === mid);
                    if (m) m.sendMessage(`§a[ZYD-FACTIONS] §a${myName} §ahas accepted your ally request! You are now §bALLIES§a!`);
                }
            }
        } else {
            saveAllFactions(factions2);
            player.sendMessage(`§cDeclined ally request from §d${req.fromFactionName}§c.`);

            for (const mid in currentReqFaction.members) {
                const mRole = currentReqFaction.members[mid].role;
                if (mRole === FACTION_ROLES.OWNER || mRole === FACTION_ROLES.ADMIN) {
                    const m = world.getAllPlayers().find(p => p.id === mid);
                    if (m) m.sendMessage(`§c[ZYD-FACTIONS] §c${currentFaction.iconUnicode} ${currentFaction.name} §chas declined your ally request.`);
                }
            }
        }

        showDiplomacyPendingOverviewUI(player);
    });
}

function showDiplomacyPeaceRequestsUI(player) {
    const faction = getDiplomacyFaction(player);
    if (!faction) return showDiplomacyUI(player);

    const pending = faction.peaceRequests || [];
    const form = new ActionFormData()
        .title("§e§lPeace Requests")
        .body(`§7Faction: §f${faction.name}\n§7Pending Requests: §e${pending.length}/${MAX_PEACE_REQUESTS}`);

    const allFactions = getAllFactions();
    let pendingButtons = [];

    for (const req of pending) {
        const reqFaction = allFactions[req.fromFactionId];
        if (!reqFaction) continue;
        const memberCount = Object.keys(reqFaction.members).length;
        const power = calculateFactionPower(reqFaction);
        form.button(`§e${reqFaction.iconUnicode} ${req.fromFactionName}\n§fMembers: §2${memberCount} §f| Power: §b${power}`, reqFaction.iconTexture || "textures/factions/faction.png");
        pendingButtons.push(req);
    }

    if (pendingButtons.length === 0) {
        form.button("§cNo Peace Requests\n§f[ None at this time ]", "textures/rank_colours/gray.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const pendingStart = idx;
        idx += pendingButtons.length > 0 ? pendingButtons.length : 1;
        const backIdx = idx;

        if (pendingButtons.length > 0 && response.selection >= pendingStart && response.selection < pendingStart + pendingButtons.length) {
            showDiplomacyManagePeaceRequestUI(player, pendingButtons[response.selection - pendingStart]);
        } else {
            showDiplomacyUI(player);
        }
    });
}

function showDiplomacyManagePeaceRequestUI(player, req) {
    const factions = getAllFactions();
    const myFaction = factions[getDiplomacyFactionId(player)];
    const reqFaction = factions[req.fromFactionId];
    if (!myFaction || !reqFaction) {
        player.sendMessage("§cFaction no longer exists.");
        showDiplomacyPendingOverviewUI(player);
        return;
    }

    const memberCount = Object.keys(reqFaction.members).length;
    const totalPower = calculateFactionPower(reqFaction);
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;

    let body = "§7---------------------------\n";
    body += `§7Faction: §e${reqFaction.iconUnicode} ${req.fromFactionName}\n`;
    body += `§7Description: §f${reqFaction.description}\n`;
    body += `§7Members: §f${memberCount}/${reqFaction.maxMembers}\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}\n`;
    body += "§7---------------------------\n\n";
    body += `§e${req.fromFactionName} §ehas sent a §eDeclaration of Peace§e.`;
    body += `\n\n§7Accepting will end the enmity between both factions.`;

    const form = new MessageFormData()
        .title("§e§lManage Peace Request")
        .body(body)
        .button1("§aAccept Peace")
        .button2("§cDecline Peace");

    form.show(player).then(response => {
        if (response.canceled) { showDiplomacyPendingOverviewUI(player); return; }

        const factions2 = getAllFactions();
        const currentFaction = factions2[getDiplomacyFactionId(player)];
        const currentReqFaction = factions2[req.fromFactionId];
        if (!currentFaction || !currentReqFaction) {
            player.sendMessage("§cFaction no longer exists.");
            showDiplomacyPendingOverviewUI(player);
            return;
        }

        currentFaction.peaceRequests = (currentFaction.peaceRequests || []).filter(r => r.fromFactionId !== req.fromFactionId);

        if (response.selection === 0) {
            currentFaction.enemies = (currentFaction.enemies || []).filter(e => e.factionId !== req.fromFactionId);
            currentReqFaction.enemies = (currentReqFaction.enemies || []).filter(e => e.factionId !== currentFaction.id);

            saveAllFactions(factions2);

            const myName = currentFaction.iconUnicode + " " + currentFaction.name;
            const reqName = currentReqFaction.iconUnicode + " " + currentReqFaction.name;
            player.sendMessage(`§a§l Accepted peace with §e${req.fromFactionName}§a! Enmity has ended.`);
            player.playSound("random.levelup");
            world.sendMessage(`§6[ZYD-FACTIONS] §a${myName} §7and §a${reqName} §7have made §ePEACE§7! The enmity has ended.`);

            for (const mid in currentReqFaction.members) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§a[ZYD-FACTIONS] §a${myName} §ahas accepted your §eDeclaration of Peace§a! The enmity has ended.`);
            }
        } else {
            saveAllFactions(factions2);
            player.sendMessage(`§cDeclined peace request from §e${req.fromFactionName}§c.`);

            for (const mid in currentReqFaction.members) {
                const mRole = currentReqFaction.members[mid].role;
                if (mRole === FACTION_ROLES.OWNER || mRole === FACTION_ROLES.ADMIN) {
                    const m = world.getAllPlayers().find(p => p.id === mid);
                    if (m) m.sendMessage(`§c[ZYD-FACTIONS] §c${currentFaction.iconUnicode} ${currentFaction.name} §chas declined your §eDeclaration of Peace§c.`);
                }
            }
        }

        showDiplomacyPendingOverviewUI(player);
    });
}

// ============================================
// LEADERBOARD SEARCH SYSTEM
// ============================================

function showLeaderboardSearchUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const form = new ModalFormData()
        .title("§e§lSearch Faction")
        .textField("§6Enter faction name to search:", "Type here...");

    form.show(player).then(response => {
        if (response.canceled) { showLeaderboardUI(player); return; }

        const searchInput = (response.formValues[0] || "").trim().toLowerCase();
        if (!searchInput) { showLeaderboardSearchUI(player); return; }

        const factions = getAllFactions();
        const results = [];

        for (const id in factions) {
            const name = stripColorCodes(factions[id].name).toLowerCase();
            if (name.startsWith(searchInput)) {
                results.push(factions[id]);
            }
        }

        if (results.length === 0) {
            player.sendMessage("§cNo factions found starting with '" + searchInput + "'.");
            showLeaderboardSearchUI(player);
            return;
        }

        showLeaderboardSearchResultsUI(player, results, searchInput);
    });
}

function showLeaderboardSearchResultsUI(player, results, searchTerm) {
    let bodyText = `§7Search results for: §f"${searchTerm}"\n`;
    bodyText += `§7Found: §f${results.length} faction(s)\n\n`;
    bodyText += "§8Click a faction to view details:";

    const form = new ActionFormData()
        .title("§e§lSearch Results")
        .body(bodyText);

    for (const f of results) {
        const memberCount = Object.keys(f.members).length;
        const totalPower = calculateFactionPower(f);
        const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
        form.button(`§f${f.iconUnicode} ${f.name}\n§b${totalPower} §fPower | §a${memberCount} §fMembers`, f.iconTexture || "textures/factions/faction.png");
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection < results.length) {
            const allFactionsList = Object.values(getAllFactions());
            allFactionsList.sort((a, b) => calculateFactionPower(b) - calculateFactionPower(a));
            const rank = allFactionsList.findIndex(f => f.id === results[response.selection].id) + 1;
            showLeaderboardFactionInfoUI(player, results[response.selection].id, rank > 0 ? rank : "N/A");
        } else {
            showLeaderboardUI(player);
        }
    });
}

// ============================================
// LEADERBOARD ALLY/ENEMY DIRECT ACTIONS
// ============================================

function showLeaderboardRequestAllyUI(player, targetFactionId) {
    const factions = getAllFactions();
    const myFaction = factions[getPlayerFactionId(player.id)];
    const targetFaction = factions[targetFactionId];
    if (!myFaction || !targetFaction) {
        player.sendMessage("§cFaction no longer exists.");
        showLeaderboardUI(player);
        return;
    }

    const form = new MessageFormData()
        .title("§a§lRequest Ally Invitation")
        .body(`§aSend an ally request to §b${targetFaction.iconUnicode} ${targetFaction.name}§a?\n\n§7If they accept, both factions will become allies.`)
        .button1("§aYes, Send Request")
        .button2("§cCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showLeaderboardUI(player);
            return;
        }

        if (!targetFaction.allyPendingRequests) targetFaction.allyPendingRequests = [];
        if (targetFaction.allyPendingRequests.some(r => r.fromFactionId === myFaction.id)) {
            player.sendMessage("§cYou already have a pending ally request to this faction.");
            showLeaderboardUI(player);
            return;
        }

        targetFaction.allyPendingRequests.push({
            fromFactionId: myFaction.id,
            fromFactionName: myFaction.name,
            fromFactionIcon: myFaction.iconUnicode || "",
            timestamp: Date.now()
        });
        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§a§l Ally request sent to §b${targetFaction.name}§a!`);
        player.playSound("random.orb");

        for (const mid in targetFaction.members) {
            const mRole = targetFaction.members[mid].role;
            if (mRole === FACTION_ROLES.OWNER || mRole === FACTION_ROLES.ADMIN) {
                const m = world.getAllPlayers().find(p => p.id === mid);
                if (m) m.sendMessage(`§a[ZYD-FACTIONS] §e${myName} §ahas sent an §bAlly Request§a! Check §6Diplomacy > Ally Pending§a.`);
            }
        }

        showLeaderboardUI(player);
    });
}

function showLeaderboardAddEnemyUI(player, targetFactionId) {
    const factions = getAllFactions();
    const myFaction = factions[getPlayerFactionId(player.id)];
    const targetFaction = factions[targetFactionId];
    if (!myFaction || !targetFaction) {
        player.sendMessage("§cFaction no longer exists.");
        showLeaderboardUI(player);
        return;
    }

    if ((targetFaction.enemies || []).length >= MAX_ENEMIES) {
        player.sendMessage(`§cCannot declare enemy. §f${targetFaction.name} §calready has the maximum number of enemies (${MAX_ENEMIES}).`);
        showLeaderboardUI(player);
        return;
    }

    const form = new MessageFormData()
        .title("§c§lDeclare Enemy")
        .body(`§cAre you sure you want to declare §c${targetFaction.iconUnicode} ${targetFaction.name} §cas your enemy?\n\n§7• Both factions will see each other as enemies\n§7• Only your faction can remove this enmity\n§7• They can send a peace request to end it\n\n§cThis action will be broadcast to the server.`)
        .button1("§cYes, Declare Enemy")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showLeaderboardUI(player);
            return;
        }

        myFaction.enemies = myFaction.enemies || [];
        myFaction.enemies.push({ factionId: targetFactionId, declaredBy: myFaction.id, timestamp: Date.now() });

        targetFaction.enemies = targetFaction.enemies || [];
        targetFaction.enemies.push({ factionId: myFaction.id, declaredBy: myFaction.id, timestamp: Date.now() });

        // Cancel any pending diplomacy requests between them
        myFaction.allyPendingRequests = (myFaction.allyPendingRequests || []).filter(r => r.fromFactionId !== targetFactionId);
        targetFaction.allyPendingRequests = (targetFaction.allyPendingRequests || []).filter(r => r.fromFactionId !== myFaction.id);
        myFaction.peaceRequests = (myFaction.peaceRequests || []).filter(r => r.fromFactionId !== targetFactionId);
        targetFaction.peaceRequests = (targetFaction.peaceRequests || []).filter(r => r.fromFactionId !== myFaction.id);

        saveAllFactions(factions);

        const myName = myFaction.iconUnicode + " " + myFaction.name;
        player.sendMessage(`§c§l You have declared §c${targetFaction.name} §cas your enemy!`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §c${myName} §chas declared §c${targetFaction.name} §cas their §cENEMY§c!`);

        for (const mid in targetFaction.members) {
            const m = world.getAllPlayers().find(p => p.id === mid);
            if (m) m.sendMessage(`§c[ZYD-FACTIONS] §c${myName} §chas declared your faction as their §cENEMY§c!`);
        }

        showLeaderboardUI(player);
    });
}

// ============================================
// SECTION 26: LEADERBOARD
// ============================================

function showLeaderboardUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factions = getAllFactions();
    const factionList = [];

    for (const id in factions) {
        const f = factions[id];
        const memberCount = Object.keys(f.members).length;
        const totalPower = calculateFactionPower(f);
        const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
        factionList.push({
            id: id,
            name: f.name,
            iconUnicode: f.iconUnicode || "",
            iconTexture: f.iconTexture || "textures/factions/faction.png",
            memberCount,
            maxMembers: f.maxMembers,
            totalPower,
            maxPossiblePower
        });
    }

    factionList.sort((a, b) => b.totalPower - a.totalPower);

    let bodyText = "§7The strongest factions globally,\n";
    bodyText += "§7ranked by total accumulated power.\n\n";

    if (factionList.length === 0) {
        bodyText += "§cNo factions created yet.\n§7Be the first to forge a legacy!";
    } else {
        bodyText += `§7Total Factions: §f${factionList.length}§r\n\n`;
        bodyText += "§8Click a faction below to view details:";
    }

    const form = new ActionFormData()
        .title("§b§lGlobal Faction Ranking")
        .body(bodyText);

    form.button("§eSearch Faction\n§f[ Find a specific faction ]", "textures/edit2.png");

    if (factionList.length === 0) {
        form.button("§cNo Factions\n§f[ None created ]", "textures/list.png");
    } else {
        const myFactionId = getPlayerFactionId(player.id);
        const myFaction = myFactionId ? factions[myFactionId] : null;

        for (let i = 0; i < factionList.length; i++) {
            const f = factionList[i];
            let nameColor = "§f";

            if (myFactionId) {
                if (myFactionId === f.id) nameColor = "§a"; // Your Faction (Light Green)
                else if ((myFaction.allies || []).includes(f.id)) nameColor = "§d"; // Ally (Pink)
                else if ((myFaction.enemies || []).some(e => e.factionId === f.id)) nameColor = "§c"; // Enemy (Light Red)
            }

            form.button(`${nameColor}${f.iconUnicode} ${f.name}\n§b${f.totalPower} §fPower | §a${f.memberCount} §fMembers`, f.iconTexture);
        }
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === 0) {
            showLeaderboardSearchUI(player);
            return;
        }

        if (factionList.length === 0) {
            showFactionsMainUI(player);
            return;
        }

        if (response.selection >= 1 && response.selection <= factionList.length) {
            showLeaderboardFactionInfoUI(player, factionList[response.selection - 1].id, response.selection);
        } else {
            showFactionsMainUI(player);
        }
    });
}

// ============================================
// LEADERBOARD FACTION DETAILS (clickable)
// Shows stats, members as TEXT, OP edit & request buttons
// ============================================

function showLeaderboardFactionInfoUI(player, factionId, rank) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) {
        player.sendMessage("§cFaction no longer exists.");
        showLeaderboardUI(player);
        return;
    }

    const totalPower = calculateFactionPower(faction);
    const memberCount = Object.keys(faction.members).length;
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
    const powerPercent = maxPossiblePower > 0 ? Math.round((totalPower / maxPossiblePower) * 100) : 0;
    const statusText = faction.status === "open" ? "§aOpen" : "§cClosed";
    const ownerData = faction.members[faction.leader];
    const ownerName = ownerData?.name || faction.createdByName || "Unknown";
    const createdDate = formatJoinDate(faction.createdAt);
    const isFull = memberCount >= faction.maxMembers;

    const memberRoles = [
        { key: FACTION_ROLES.OWNER, label: "Owner" },
        { key: FACTION_ROLES.ADMIN, label: "Admin" },
        { key: FACTION_ROLES.MODERATOR, label: "Moderator" },
        { key: FACTION_ROLES.MEMBER, label: "Member" }
    ];

    let memberText = "";
    const onlinePlayers = world.getAllPlayers();
    for (const r of memberRoles) {
        const members = [];
        for (const id in faction.members) {
            if (faction.members[id].role === r.key) {
                const onlineP = onlinePlayers.find(p => p.id === id);
                members.push(onlineP?.name || faction.members[id].name || "Unknown");
            }
        }
        if (members.length > 0) {
            memberText += `§7${r.label}: §f${members.join("§7, §f")}§r\n`;
        }
    }
    if (!memberText) memberText = "§cNo members.\n";

    let body = "§7---------------------------\n";
    body += `§7Global Top: §e#${rank}§r\n`;
    body += `§7Name: §f${faction.iconUnicode} ${faction.name}§r\n`;
    body += `§7Status: ${statusText}§r\n`;
    body += `§7Description: §f${faction.description}§r\n`;
    body += `§7Owner: §a${ownerName}§r\n`;
    body += `§7Created: §f${createdDate}§r\n`;
    body += `§7Members: §f${memberCount}/${faction.maxMembers}§r\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}§r §7(${getPowerPercentColor(powerPercent)}${powerPercent}%§7)\n`;
    body += "§7---------------------------\n";
    body += "§7§lMember Roster:§r\n";
    body += memberText;
    body += "§7---------------------------";

    const form = new ActionFormData()
        .title("§b§lFaction Details")
        .body(body);

    const playerFactionId = getPlayerFactionId(player.id);
    const isOp = player.hasTag("op");
    const playerPending = getPlayerPendingRequests(player.id);
    const hasInvite = playerPending.some(r => r.factionId === factionId);

    const dynamicButtons = [];

    if (!playerFactionId) {
        if (hasInvite) dynamicButtons.push({ id: "join", text: "§aJoin the Faction\n§f[ You are invited ]", icon: "textures/rank_colours/green.png" });
        else if (isFull) dynamicButtons.push({ id: "full", text: "§cFaction Full\n§f[ Cannot join ]", icon: "textures/rank_colours/red.png" });
        else dynamicButtons.push({ id: "request", text: "§dRequest to Join\n§f[ Send a request ]", icon: "textures/pin.png" });
    } else if (playerFactionId !== factionId) {
        const myFaction = getFactionById(playerFactionId);
        const isAlly = myFaction && (myFaction.allies || []).includes(factionId);
        const isEnemy = myFaction && (myFaction.enemies || []).some(e => e.factionId === factionId);
        const hasSentAlly = (() => { const tf = getFactionById(factionId); return tf && (tf.allyPendingRequests || []).some(r => r.fromFactionId === playerFactionId); })();
        const hasIncomingAlly = myFaction && (myFaction.allyPendingRequests || []).some(r => r.fromFactionId === factionId);

        // Only show diplomacy request buttons if neither allied nor enemies
        if (!isAlly && !isEnemy) {
            if (hasIncomingAlly) dynamicButtons.push({ id: "none", text: "§dAlly Request Pending\n§f[ Check Diplomacy ]", icon: "textures/rank_colours/gray.png" });
            else if (hasSentAlly) dynamicButtons.push({ id: "none", text: "§dAlly Request Sent\n§f[ Awaiting response ]", icon: "textures/rank_colours/gray.png" });
            else dynamicButtons.push({ id: "request_ally", text: "§bRequest Ally\n§f[ Send ally request ]", icon: "textures/rank_colours/green.png" });

            const myEnemies = (myFaction.enemies || []).length;
            const targetEnemies = (getFactionById(factionId)?.enemies || []).length;

            if (myEnemies >= MAX_ENEMIES) {
                dynamicButtons.push({ id: "none", text: `§cEnemy List Full\n§f[ Max ${MAX_ENEMIES} reached ]`, icon: "textures/rank_colours/gray.png" });
            } else if (targetEnemies >= MAX_ENEMIES) {
                dynamicButtons.push({ id: "none", text: `§cTheir Enemy List Full\n§f[ They reached max ]`, icon: "textures/rank_colours/gray.png" });
            } else {
                dynamicButtons.push({ id: "add_enemy", text: "§cAdd Enemy\n§f[ Declare as enemy ]", icon: "textures/rank_colours/red.png" });
            }
        }
    }

    if (isOp) dynamicButtons.push({ id: "op_edit", text: "§4OP: Edit Their Faction\n§f[ Full owner control ]", icon: "textures/settings.png" });
    dynamicButtons.push({ id: "back", text: "§cBack", icon: "textures/back.png" });

    for (const btn of dynamicButtons) {
        form.button(btn.text, btn.icon);
    }

    form.show(player).then(response => {
        if (response.canceled) return;
        const action = dynamicButtons[response.selection]?.id;

        if (action === "join") {
            const req = playerPending.find(r => r.factionId === factionId);
            if (req) showPlayerManageRequestUI(player, req);
            else showLeaderboardFactionInfoUI(player, factionId, rank);
        } else if (action === "request") {
            showLeaderboardRequestToJoinUI(player, factionId);
        } else if (action === "request_ally") {
            showLeaderboardRequestAllyUI(player, factionId);
        } else if (action === "add_enemy") {
            showLeaderboardAddEnemyUI(player, factionId);
        } else if (action === "op_edit") {
            showOpEditFactionUI(player, factionId);
        } else if (action === "back" || action === "full" || action === "none") {
            showLeaderboardUI(player);
        }
    });
}

// ============================================
// LEADERBOARD REQUEST TO JOIN 
// ============================================

function showLeaderboardRequestToJoinUI(player, factionId) {
    const factions = getAllFactions();
    const targetFaction = factions[factionId];
    if (!targetFaction) { player.sendMessage("§cFaction no longer exists."); showLeaderboardUI(player); return; }

    if (targetFaction.status === "open") {
        joinFactionDirect(player, factionId);
        return;
    }

    const sentCount = getPlayerActiveJoinRequestsCount(factions, player.id);
    if (sentCount >= MAX_PENDING_INVITATIONS_PER_PLAYER) {
        player.sendMessage(`§cYou already have ${MAX_PENDING_INVITATIONS_PER_PLAYER} active join requests. Wait for them to expire (10m) or be declined.`);
        showLeaderboardFactionInfoUI(player, factionId, "N/A");
        return;
    }

    if ((targetFaction.pendingRequests || []).length >= MAX_PENDING_REQUESTS_PER_FACTION) {
        player.sendMessage(`§cThis faction's request inbox is full (Max ${MAX_PENDING_REQUESTS_PER_FACTION}).`);
        showLeaderboardFactionInfoUI(player, factionId, "N/A");
        return;
    }

    const form = new ModalFormData()
        .title("§dRequest to Join")
        .textField("§6Why do you want to join? §8(Optional)", "I want to help build...");

    form.show(player).then(response => {
        if (response.canceled) { showLeaderboardFactionInfoUI(player, factionId, "N/A"); return; }

        const message = (response.formValues[0] || "").trim();
        const factions = getAllFactions();
        const faction = factions[factionId];

        if (!faction || !faction.pendingRequests) { showLeaderboardFactionInfoUI(player, factionId); return; }

        faction.pendingRequests.push({
            playerId: player.id,
            playerName: player.name,
            message: message || "",
            timestamp: Date.now()
        });

        saveAllFactions(factions);
        player.sendMessage("§a§l Request sent to §f" + faction.iconUnicode + " " + faction.name + "§a!");

        for (const id in faction.members) {
            if (canManageMembers(faction.members[id].role, faction.members[id])) {
                const member = world.getAllPlayers().find(p => p.id === id);
                if (member) member.sendMessage("§d[ZYD-FACTIONS] §f" + player.name + " §drequested to join your faction!");
            }
        }
        showLeaderboardFactionInfoUI(player, factionId);
    });
}

// ============================================
// OP-ONLY: EDIT THEIR FACTION (Full owner control)
// Only players with "op" tag can access this
// ============================================

function showOpEditFactionUI(player, factionId) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    if (!player.hasTag("op")) {
        player.sendMessage("§cOperator access required.");
        showLeaderboardFactionInfoUI(player, factionId);
        return;
    }

    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) {
        player.sendMessage("§cFaction no longer exists.");
        showLeaderboardUI(player);
        return;
    }

    const totalPower = calculateFactionPower(faction);
    const memberCount = Object.keys(faction.members).length;
    const maxPossiblePower = memberCount * MAX_POWER_PER_MEMBER;
    const statusText = faction.status === "open" ? "§aOpen" : "§cClosed";
    const ownerName = faction.members[faction.leader]?.name || faction.createdByName || "Unknown";
    const createdDate = formatJoinDate(faction.createdAt);

    let body = "§4§lOP CONTROL MODE§r\n";
    body += "§7---------------------------\n";
    body += `§7Name: §f${faction.iconUnicode} ${faction.name}§r\n`;
    body += `§7Owner: §a${ownerName}§r\n`;
    body += `§7Created: §f${createdDate}§r\n`;
    body += `§7Status: ${statusText}§r\n`;
    body += `§7Description: §f${faction.description}§r\n`;
    body += `§7Members: §f${memberCount}/${faction.maxMembers}§r\n`;
    body += `§7Faction Power: §b${totalPower}/${maxPossiblePower}§r\n`;
    body += "§7---------------------------\n";
    body += "§cYou have full owner-level control over this faction.";

    const form = new ActionFormData()
        .title("§4§lOperator Control")
        .body(body);

    form.button("§eFaction Status\n§f[ Toggle open/closed ]", "textures/settings.png");
    form.button("§eEdit Description\n§f[ Change info ]", "textures/edit2.png");
    form.button("§bMember List\n§f[ Manage members ]", "textures/list.png");
    form.button("§6Diplomacy\n§f[ Allies & Enemies ]", "textures/factions/faction.png");
    form.button("§dRoles Configuration\n§f[ Setup permissions ]", "textures/random/roles.png");
    form.button("§9Extras\n§f[ Home, claims & logs ]", "textures/hologram_edit.png");
    form.button("§cDisband Faction\n§f[ Delete permanently ]", "textures/delete.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        switch (response.selection) {
            case 0: showOpToggleStatusUI(player, factionId); break;
            case 1: showOpEditDescriptionUI(player, factionId); break;
            case 2: showOpMemberListUI(player, factionId); break;
            case 3: showOpDiplomacyUI(player, factionId); break;
            case 4: showOpRolesConfigSelectUI(player, factionId); break;
            case 5: showOpExtrasUI(player, factionId); break;
            case 6: showOpDisbandConfirmUI(player, factionId); break;
            case 7: showLeaderboardFactionInfoUI(player, factionId); break;
        }
    });
}

function showOpEditDescriptionUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpEditFactionUI(player, factionId);

    const form = new ModalFormData()
        .title("§e§lEdit Description")
        .textField("§6New Description §8(50 chars max):", "Enter description...", { defaultValue: faction.description });

    form.show(player).then(response => {
        if (response.canceled) { showOpEditFactionUI(player, factionId); return; }
        let newDesc = (response.formValues[0] || "").trim();

        if (!isValidFactionDescription(newDesc)) {
            player.sendMessage("§cDescription too long! Maximum 50 characters.");
            showOpEditDescriptionUI(player, factionId); return;
        }

        newDesc = (newDesc || "No description set.") + "§r";

        const factions = getAllFactions();
        if (factions[factionId]) {
            factions[factionId].description = newDesc;
            saveAllFactions(factions);
            player.sendMessage("§a§l Description updated! §7(OP Action)");
        }
        showOpEditFactionUI(player, factionId);
    });
}

function showOpToggleStatusUI(player, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showOpEditFactionUI(player, factionId);

    const isCurrentlyOpen = faction.status === "open";
    const newStatus = isCurrentlyOpen ? "closed" : "open";
    const statusWord = newStatus === "open" ? "§aOpen" : "§cClosed";

    factions[factionId].status = newStatus;
    saveAllFactions(factions);

    player.sendMessage(`§a§l Faction status changed to ${statusWord}§a! §7(OP Action)`);

    if (newStatus === "open") {
        world.sendMessage(`§6[ZYD-FACTIONS] §r${faction.iconUnicode} ${faction.name} §ais now §aOPEN§a! §7(OP Action)`);
    } else {
        world.sendMessage(`§6[ZYD-FACTIONS] §r${faction.iconUnicode} ${faction.name} §cis now §cCLOSED§c! §7(OP Action)`);
    }

    showOpEditFactionUI(player, factionId);
}

function showOpMemberListUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpEditFactionUI(player, factionId);

    const memberCount = Object.keys(faction.members).length;
    const pendingCount = faction.pendingRequests ? faction.pendingRequests.length : 0;

    const form = new ActionFormData()
        .title("§4§lOP Member Control")
        .body(`§7Faction: §f${faction.iconUnicode} ${faction.name}§r\n§7Members: §f${memberCount}/${faction.maxMembers}§r\n§7Pending: §d${pendingCount}\n\n§cOP Super-Owner Mode`);

    form.button("§aAdd Member\n§f[ Invite a player ]", "textures/add.png");
    if (pendingCount > 0) {
        form.button(`§dPending Requests\n§f[ ${pendingCount} waiting ]`, "textures/exclamation.png");
    }
    form.button("§eSettings\n§f[ Arrange / Roles ]", "textures/settings.png");

    const roles = [FACTION_ROLES.OWNER, FACTION_ROLES.ADMIN, FACTION_ROLES.MODERATOR, FACTION_ROLES.MEMBER];
    let memberButtons = [];
    const onlinePlayers = world.getAllPlayers();

    for (const role of roles) {
        for (const id in faction.members) {
            if (faction.members[id].role === role) {
                const onlineP = onlinePlayers.find(p => p.id === id);
                const pName = onlineP?.name || faction.members[id].name || "Unknown";
                const isOnline = !!onlineP;
                const nameColor = isOnline ? "§2" : "§4";
                form.button(`${nameColor}${pName}§r\n§6Role: ${getRoleColor(role)}${capitalizeFirst(role)} §f| §b${faction.members[id].power || 0}/${MAX_POWER_PER_MEMBER}`, getRoleIcon(role));
                memberButtons.push(id);
            }
        }
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const addIdx = idx++;
        const pendingIdx = pendingCount > 0 ? idx++ : -1;
        const settingsIdx = idx++;
        const memberStart = idx;
        idx += memberButtons.length;
        const backIdx = idx;

        if (response.selection === addIdx) {
            showOpAddMemberUI(player, factionId);
        } else if (response.selection === pendingIdx) {
            showOpPendingRequestsUI(player, factionId);
        } else if (response.selection === settingsIdx) {
            showOpMemberSettingsUI(player, factionId);
        } else if (response.selection === backIdx) {
            showOpEditFactionUI(player, factionId);
        } else if (response.selection >= memberStart && response.selection < memberStart + memberButtons.length) {
            showOpMemberManageUI(player, factionId, memberButtons[response.selection - memberStart]);
        }
    });
}

function showOpMemberManageUI(player, factionId, targetId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction || !faction.members[targetId]) return showOpMemberListUI(player, factionId);

    const targetData = faction.members[targetId];
    const onlineP = world.getAllPlayers().find(p => p.id === targetId);
    const targetName = onlineP?.name || targetData.name || "Unknown";
    const isOnline = !!onlineP;
    const powerColor = targetData.power < 0 ? "§c" : "§b";

    let body = "§7---------------------------\n";
    body += `§7Player: ${isOnline ? "§2" : "§4"}${targetName}§r\n`;
    body += `§7Status: ${isOnline ? "§aOnline" : "§cOffline"}§r\n`;
    body += `§7Role: ${getRoleColor(targetData.role)}${capitalizeFirst(targetData.role)}§r\n`;
    body += `§7Power: ${powerColor}${targetData.power}/${MAX_POWER_PER_MEMBER}§r\n`;
    body += `§7Joined: §f${formatJoinDate(targetData.joinedAt)}§r\n`;
    body += "§7---------------------------\n";
    body += "§cOP control: You can change role or kick this member.";

    const form = new ActionFormData()
        .title("§4§lOP Member Control")
        .body(body);

    const roleOptions = [
        { label: "Give Ownership", value: FACTION_ROLES.OWNER },
        { label: "Give Admin", value: FACTION_ROLES.ADMIN },
        { label: "Give Moderator", value: FACTION_ROLES.MODERATOR },
        { label: "Make Member", value: FACTION_ROLES.MEMBER }
    ].filter(o => o.value !== targetData.role);

    if (roleOptions.length > 0) {
        form.button("§eEdit Role\n§f[ Change member role ]", "textures/edit2.png");
    }
    form.button("§cKick Member\n§f[ Remove from faction ]", "textures/rank_colours/red.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let idx = 0;
        const editRoleIdx = roleOptions.length > 0 ? idx++ : -1;
        const kickIdx = idx++;
        const backIdx = idx;

        if (response.selection === editRoleIdx) {
            showOpEditRoleUI(player, factionId, targetId, targetName, roleOptions);
        } else if (response.selection === kickIdx) {
            showOpKickConfirmUI(player, factionId, targetId, targetName, targetData.power);
        } else {
            showOpMemberListUI(player, factionId);
        }
    });
}

function showOpEditRoleUI(player, factionId, targetId, targetName, roleOptions) {
    const labels = roleOptions.map(o => o.label);

    const form = new ModalFormData()
        .title("§e§lOP Edit Role")
        .dropdown(`§6Select new role for §f${targetName}`, labels);

    form.show(player).then(response => {
        if (response.canceled) { showOpMemberManageUI(player, factionId, targetId); return; }

        const chosen = roleOptions[response.formValues[0]];
        if (!chosen) { showOpMemberManageUI(player, factionId, targetId); return; }

        const factions = getAllFactions();
        const faction = factions[factionId];
        if (!faction || !faction.members[targetId]) { showOpMemberListUI(player, factionId); return; }

        if (chosen.value === FACTION_ROLES.OWNER) {
            const oldOwnerId = faction.leader;
            if (oldOwnerId && faction.members[oldOwnerId]) {
                faction.members[oldOwnerId].role = FACTION_ROLES.ADMIN;
            }
            faction.leader = targetId;
        }

        faction.members[targetId].role = chosen.value;
        saveAllFactions(factions);

        player.sendMessage(`§f${targetName} §ais now §e${capitalizeFirst(chosen.value)}§a! §7(OP Action)`);

        const target = world.getAllPlayers().find(p => p.id === targetId);
        if (target) {
            target.sendMessage(`§a[ZYD-FACTIONS] §fYour role is now §e${capitalizeFirst(chosen.value)}§a! §7(OP Action)`);
            target.playSound("random.levelup");
        }

        showOpMemberManageUI(player, factionId, targetId);
    });
}

function showOpKickConfirmUI(player, factionId, targetId, targetName, targetPower) {
    const form = new MessageFormData()
        .title("§c§lOP Kick Player")
        .body(`§cAre you sure you want to kick §f${targetName}§c from this faction?\n\n§7(OP Action)\n§7Warning: Kicking this player will decrease the overall faction power by §b${Math.max(0, targetPower)}§7.`)
        .button1("§cYes, Kick Player")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) { showOpMemberManageUI(player, factionId, targetId); return; }

        const factions = getAllFactions();
        const faction = factions[factionId];
        if (!faction || !faction.members[targetId]) { showOpMemberListUI(player, factionId); return; }

        savePlayerSavedPower(targetId, faction.members[targetId]?.power || 0);
        delete factions[factionId].members[targetId];
        saveAllFactions(factions);
        setPlayerFaction(targetId, null);
        try { removePlayerFromAllChunkPerms(factionId, targetId); } catch (e) { }

        player.sendMessage(`§c§l Kicked §f${targetName} §cfrom the faction. §7(OP Action)`);
        const targetPlayer = world.getAllPlayers().find(p => p.id === targetId);
        if (targetPlayer) targetPlayer.sendMessage("§cYou have been kicked from §f" + faction.name + "§c. §7(OP Action)");

        showOpMemberListUI(player, factionId);
    });
}

function showOpMemberSettingsUI(player, factionId) {
    const form = new ActionFormData()
        .title("§4§lOP Member Settings")
        .body("§7Operator tools for this faction's members.")
        .button("§dRoles Configuration\n§f[ Setup permissions ]", "textures/random/roles.png")
        .button("§aAdd Member\n§f[ Invite a player ]", "textures/add.png")
        .button("§dPending Requests\n§f[ Approve / Decline ]", "textures/exclamation.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled) return;
        if (res.selection === 0) showOpRolesConfigSelectUI(player, factionId);
        else if (res.selection === 1) showOpAddMemberUI(player, factionId);
        else if (res.selection === 2) showOpPendingRequestsUI(player, factionId);
        else showOpMemberListUI(player, factionId);
    });
}

function showOpExtrasUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpEditFactionUI(player, factionId);

    const homeStatus = faction.home
        ? `§aSet §7at §f(${Math.floor(faction.home.x)}, ${Math.floor(faction.home.y)}, ${Math.floor(faction.home.z)})`
        : "§cNot Set";

    let claimCount = 0;
    try {
        const raw = world.getDynamicProperty("zyd:claim_map");
        if (raw) {
            const claimMap = JSON.parse(raw);
            for (const key in claimMap) {
                if (claimMap[key] === factionId) claimCount++;
            }
        }
    } catch (e) { }

    let body = "§7---------------------------\n";
    body += `§7Faction: §f${faction.iconUnicode} ${faction.name}\n`;
    body += `§7Faction Home: ${homeStatus}\n`;
    body += `§7Total Claims: §b${claimCount}\n`;
    body += "§7---------------------------\n";
    body += "§7Operator tools for faction infrastructure.";

    const form = new ActionFormData()
        .title("§9§lOP Extras")
        .body(body);

    form.button("§2Set Faction Home\n§f[ Your current location ]", "textures/random/claim_0.png");
    form.button("§aTeleport to Faction Home\n§f[ Instant travel ]", "textures/tpa2.png");
    form.button("§eDelete Faction Home\n§f[ Remove home ]", "textures/delete.png");
    form.button("§bView Claim Coordinates\n§f[ Logs & details ]", "textures/list.png");
    form.button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled) { showOpEditFactionUI(player, factionId); return; }
        switch (res.selection) {
            case 0: showOpSetFactionHome(player, factionId); break;
            case 1: showOpTeleportFactionHome(player, factionId); break;
            case 2: showOpDeleteFactionHome(player, factionId); break;
            case 3: showOpClaimCoordinatesUI(player, factionId); break;
            case 4: showOpEditFactionUI(player, factionId); break;
        }
    });
}

function showOpTeleportFactionHome(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpExtrasUI(player, factionId);

    if (!faction.home) {
        player.playSound("note.bass");
        player.sendMessage("§cThis faction has no Faction Home set.");
        return showOpExtrasUI(player, factionId);
    }

    try {
        const targetDim = world.getDimension(faction.home.dimension || "minecraft:overworld");
        player.teleport(
            { x: faction.home.x, y: faction.home.y, z: faction.home.z },
            { dimension: targetDim }
        );
        player.playSound("random.orb");
        player.sendMessage(`§a[OP] Teleported to Faction Home of §f${faction.name}§a.`);
    } catch (e) {
        player.sendMessage("§cFailed to teleport to Faction Home.");
    }
}

function showOpClaimCoordinatesUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpExtrasUI(player, factionId);

    let claims = [];
    try {
        const raw = world.getDynamicProperty("zyd:claim_map");
        if (raw) {
            const claimMap = JSON.parse(raw);
            for (const key in claimMap) {
                if (claimMap[key] === factionId) {
                    const parts = key.split("_");
                    const dim = parts[0];
                    const coords = parts[1].split(",");
                    const cx = parseInt(coords[0]);
                    const cz = parseInt(coords[1]);
                    claims.push({ dim, cx, cz, blockX: cx * 16, blockZ: cz * 16 });
                }
            }
        }
    } catch (e) { }

    let body = "§7---------------------------\n";
    body += `§7Faction: §f${faction.iconUnicode} ${faction.name}\n`;
    body += `§7Total Claims: §b${claims.length}\n`;
    body += "§7---------------------------\n\n";

    if (claims.length === 0) {
        body += "§cThis faction has no claimed land.";
    } else {
        body += "§7Claim Log (Chunk → Block Coords):\n\n";
        const maxShow = Math.min(claims.length, 30);
        for (let i = 0; i < maxShow; i++) {
            const c = claims[i];
            const dimShort = c.dim.replace("minecraft:", "");
            body += `§f${i + 1}. §b(${c.cx}, ${c.cz}) §7→ §a(${c.blockX}, ${c.blockZ}) §8[${dimShort}]\n`;
        }
        if (claims.length > 30) {
            body += `\n§7...and §e${claims.length - 30} §7more claims.`;
        }
    }

    const form = new ActionFormData()
        .title("§b§lOP Claim Coordinates")
        .body(body)
        .button("§cBack", "textures/back.png");

    form.show(player).then(() => {
        showOpExtrasUI(player, factionId);
    });
}

function showOpAddMemberUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpEditFactionUI(player, factionId);

    const onlinePlayers = world.getAllPlayers().filter(p => !getPlayerFactionId(p.id));
    if (onlinePlayers.length === 0) {
        player.sendMessage("§cNo eligible online players to invite.");
        return showOpEditFactionUI(player, factionId);
    }

    const form = new ActionFormData()
        .title("§4§lOP Invite Player")
        .body(`§7Invite a player into §f${faction.iconUnicode} ${faction.name}`);

    onlinePlayers.forEach(p => form.button(p.name, "textures/tpa2.png"));
    form.button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection === onlinePlayers.length) {
            showOpEditFactionUI(player, factionId);
            return;
        }

        const target = onlinePlayers[res.selection];
        if (!target) return;

        if (Object.keys(faction.members).length >= faction.maxMembers) {
            player.sendMessage("§cThis faction is full.");
            return showOpAddMemberUI(player, factionId);
        }

        const factions = getAllFactions();
        const current = factions[factionId];
        if (!current) return;

        removePendingRequestsForPlayer(target.id);
        current.members[target.id] = {
            role: FACTION_ROLES.MEMBER,
            power: getPlayerSavedPower(target.id),
            name: target.name,
            joinedAt: Date.now(),
            invitedBy: `OP:${player.name}`
        };
        saveAllFactions(factions);
        setPlayerFaction(target.id, factionId);

        player.sendMessage(`§aOP added §f${target.name} §ato §f${current.name}§a!`);
        target.sendMessage(`§aAn Operator added you to §f${current.iconUnicode} ${current.name}§a!`);
        target.playSound("random.levelup");
        showOpAddMemberUI(player, factionId);
    });
}

function showOpPendingRequestsUI(player, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showOpEditFactionUI(player, factionId);

    const pending = faction.pendingRequests || [];
    if (pending.length === 0) {
        player.sendMessage("§cNo pending requests.");
        return showOpEditFactionUI(player, factionId);
    }

    const form = new ActionFormData()
        .title("§4§lOP Pending Requests")
        .body(`§7Faction: §f${faction.name}\n§7Pending: §d${pending.length}`);

    for (const req of pending) {
        form.button(`§2${req.playerName}\n§fPower: §b${getPlayerSavedPower(req.playerId)}/${MAX_POWER_PER_MEMBER}`, "textures/rank_colours/gray.png");
    }
    form.button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection === pending.length) {
            showOpEditFactionUI(player, factionId);
            return;
        }
        showOpManageRequestUI(player, factionId, pending[res.selection]);
    });
}

function showOpManageRequestUI(player, factionId, req) {
    const form = new MessageFormData()
        .title("§4§lOP Manage Request")
        .body(`§7Player: §f${req.playerName}\n§7Reason: §f${req.message || "None"}\n\n§eApprove this join request?`)
        .button1("§aAccept")
        .button2("§cDecline");

    form.show(player).then(res => {
        if (res.canceled) return showOpPendingRequestsUI(player, factionId);

        const factions = getAllFactions();
        const faction = factions[factionId];
        if (!faction) return;

        faction.pendingRequests = (faction.pendingRequests || []).filter(r => r.playerId !== req.playerId);

        if (res.selection === 0) {
            if (getPlayerFactionId(req.playerId)) {
                player.sendMessage("§cThat player is already in a faction.");
                saveAllFactions(factions);
                return showOpPendingRequestsUI(player, factionId);
            }
            if (Object.keys(faction.members).length >= faction.maxMembers) {
                player.sendMessage("§cFaction is full.");
                saveAllFactions(factions);
                return showOpPendingRequestsUI(player, factionId);
            }

            removePendingRequestsForPlayer(req.playerId);
            faction.members[req.playerId] = {
                role: FACTION_ROLES.MEMBER,
                power: getPlayerSavedPower(req.playerId),
                name: req.playerName,
                joinedAt: Date.now(),
                invitedBy: `OP:${player.name}`
            };
            setPlayerFaction(req.playerId, factionId);
            saveAllFactions(factions);

            player.sendMessage(`§aOP accepted §f${req.playerName}§a!`);
            const target = world.getAllPlayers().find(p => p.id === req.playerId);
            if (target) {
                target.sendMessage(`§aAn Operator accepted your request to join §f${faction.iconUnicode} ${faction.name}§a!`);
                target.playSound("random.levelup");
            }
        } else {
            saveAllFactions(factions);
            player.sendMessage(`§cOP declined §f${req.playerName}§c.`);
            const target = world.getAllPlayers().find(p => p.id === req.playerId);
            if (target) target.sendMessage(`§cAn Operator declined your request to join §f${faction.name}§c.`);
        }

        showOpPendingRequestsUI(player, factionId);
    });
}

function showOpSetFactionHome(player, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showOpEditFactionUI(player, factionId);

    import("./factionsClaims.js").then(mod => {
        const owner = mod.getChunkOwnerAt
            ? mod.getChunkOwnerAt(player.location, player.dimension.id)
            : null;

        if (owner !== factionId) {
            player.playSound("note.bass");
            player.sendMessage("§cStand inside that faction's claimed land to set their home.");
            return showOpEditFactionUI(player, factionId);
        }

        faction.home = {
            x: player.location.x,
            y: player.location.y,
            z: player.location.z,
            dimension: player.dimension.id
        };
        saveAllFactions(factions);

        player.playSound("random.orb");
        player.sendMessage(`§aOP set Faction Home for §f${faction.name}§a!`);
        showOpEditFactionUI(player, factionId);
    }).catch(() => {
        player.sendMessage("§cFailed to check claimed land.");
        showOpEditFactionUI(player, factionId);
    });
}

function showOpDeleteFactionHome(player, factionId) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return showOpEditFactionUI(player, factionId);

    if (!faction.home) {
        player.sendMessage("§cThis faction has no Faction Home.");
        return showOpEditFactionUI(player, factionId);
    }

    delete faction.home;
    saveAllFactions(factions);
    player.playSound("random.orb");
    player.sendMessage(`§eOP deleted Faction Home for §f${faction.name}§e.`);
    showOpEditFactionUI(player, factionId);
}

function showOpRolesConfigSelectUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) {
        player.sendMessage("§cFaction no longer exists.");
        return showLeaderboardUI(player);
    }

    const form = new ActionFormData()
        .title("§4§lOP Roles Configuration")
        .body(`§7Editing permissions for:\n§f${faction.iconUnicode} ${faction.name}\n\n§eNote: §7Owner always has full access.`)
        .button("§eAdmin Permissions", getRoleIcon(FACTION_ROLES.ADMIN))
        .button("§cModerator Permissions", getRoleIcon(FACTION_ROLES.MODERATOR))
        .button("§fMember Permissions", getRoleIcon(FACTION_ROLES.MEMBER))
        .button("§cBack", "textures/back.png");

    form.show(player).then(res => {
        if (res.canceled || res.selection === 3) {
            showOpEditFactionUI(player, factionId);
            return;
        }
        const roles = [FACTION_ROLES.ADMIN, FACTION_ROLES.MODERATOR, FACTION_ROLES.MEMBER];
        showOpRolesConfigEditUI(player, factionId, roles[res.selection]);
    });
}

function showOpRolesConfigEditUI(player, factionId, role) {
    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) {
        player.sendMessage("§cFaction no longer exists.");
        return showLeaderboardUI(player);
    }

    const factionPerms = faction.permissions || JSON.parse(JSON.stringify(DEFAULT_PERMISSIONS));
    const defaultRolePerms = DEFAULT_PERMISSIONS[role] || {};
    const current = { ...defaultRolePerms, ...(factionPerms[role] || {}) };

    const form = new ModalFormData()
        .title(`§4§lOP Edit: ${capitalizeFirst(role)}`)
        .toggle("Set Faction Status", { defaultValue: !!current.setStatus })
        .toggle("Edit Description", { defaultValue: !!current.editDesc })
        .toggle("Manage Faction Home", { defaultValue: !!current.manageHome })
        .toggle("Can SetHome (/fsethome /fdelhome)", { defaultValue: !!(current.canSetHome ?? current.manageHome) })
        .toggle("Can Claim (/fclaim /funclaim + Area Permissions)", { defaultValue: !!current.canClaim })
        .toggle("View Member List", { defaultValue: !!current.viewMembers })
        .toggle("Add/Invite Member", { defaultValue: !!current.inviteMembers })
        .toggle("Manage Join & Diplomacy Requests", { defaultValue: !!current.manageRequests })
        .toggle("Edit Roles", { defaultValue: !!current.editRoles })
        .toggle("Kick Member", { defaultValue: !!current.kickMembers })
        .toggle("Faction Member Settings", { defaultValue: !!current.manageSettings })
        .toggle("View Diplomacy", { defaultValue: !!current.viewDiplomacy })
        .toggle("Add Allies & Enemies", { defaultValue: !!current.manageDiplomacy })
        .toggle("Disband Faction", { defaultValue: !!current.disband })
        .toggle("Break Blocks", { defaultValue: !!current.canBreak })
        .toggle("Place Blocks", { defaultValue: !!current.canPlace })
        .toggle("Open Chests/Containers", { defaultValue: !!current.canOpenContainers })
        .toggle("Use Doors/Redstone", { defaultValue: !!current.canUseDoors });

    form.show(player).then(res => {
        if (res.canceled) {
            showOpRolesConfigSelectUI(player, factionId);
            return;
        }

        const vals = res.formValues;
        factionPerms[role] = {
            setStatus: vals[0],
            editDesc: vals[1],
            manageHome: vals[2],
            canSetHome: vals[3],
            canClaim: vals[4],
            viewMembers: vals[5],
            inviteMembers: vals[6],
            manageRequests: vals[7],
            editRoles: vals[8],
            kickMembers: vals[9],
            manageSettings: vals[10],
            viewDiplomacy: vals[11],
            manageDiplomacy: vals[12],
            disband: vals[13],
            canBreak: vals[14],
            canPlace: vals[15],
            canOpenContainers: vals[16],
            canUseDoors: vals[17]
        };

        factions[factionId].permissions = factionPerms;
        saveAllFactions(factions);

        player.sendMessage(`§a§l✔ OP updated permissions for ${capitalizeFirst(role)} in ${faction.name}!`);
        player.playSound("random.orb");
        showOpRolesConfigSelectUI(player, factionId);
    });
}

function showOpDisbandConfirmUI(player, factionId) {
    const faction = getFactionById(factionId);
    if (!faction) return showOpEditFactionUI(player, factionId);

    const form = new MessageFormData()
        .title("§c§lOP Disband Faction")
        .body(`§c§lWARNING!§r\n\n§c(OP Action) Are you sure you want to DISBAND §f${faction.iconUnicode} ${faction.name}§c?\n\n§7• All members will be removed\n• All claims will be lost\n• All progress will be deleted\n\n§cThis action CANNOT be undone!`)
        .button1("§cYes, Disband")
        .button2("§aCancel");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) { showOpEditFactionUI(player, factionId); return; }

        const factions = getAllFactions();
        if (!factions[factionId]) return;

        const factionName = factions[factionId].name;
        const factionIcon = factions[factionId].iconUnicode || "";

        for (const memberId in factions[factionId].members) {
            savePlayerSavedPower(memberId, factions[factionId].members[memberId].power || 0);
            setPlayerFaction(memberId, null);
            const m = world.getAllPlayers().find(p => p.id === memberId);
            if (m && m.id !== player.id) {
                m.sendMessage(`§c[ZYD-FACTIONS] §f${factionName} §chas been disbanded by §e${player.name} §c(OP Action).`);
            }
        }

        cleanupFactionRelations(factions, factionId);
        delete factions[factionId];
        saveAllFactions(factions);
        try { deleteAllChunkPermsForFaction(factionId); } catch (e) { }

        player.sendMessage(`§c§l Faction §f${factionName} §chas been disbanded. §7(OP Action)`);
        player.playSound("random.orb");
        world.sendMessage(`§6[ZYD-FACTIONS] §c${factionIcon} ${factionName} §chas been disbanded by §e${player.name} §c(OP Action).`);

        showLeaderboardUI(player);
    });
}

// ============================================
// SCRIPT INITIALIZATION
// ============================================

export { showLeaderboardUI };
export { showJoinSearchUI };
export { showDiplomacyAlliesUI };
export { showDiplomacyEnemiesUI };
export { getPlayerPendingRequests, savePlayerPendingRequests };
export { showEditFactionUI };
export { showDisbandConfirmUI };

// ============================================
// SECTION 27: OFFLINE NOTIFICATIONS
// ============================================
export function processOfflineNotifications(player) {
    if (!isFactionsEnabledCore()) return;
    const factions = getAllFactions();
    const fId = getPlayerFactionId(player.id);
    if (!fId) return;
    const faction = factions[fId];

    if (faction && faction.members[player.id]) {
        const notes = faction.members[player.id].notifications;
        if (notes && notes.length > 0) {
            system.runTimeout(() => {
                if (player.isValid) {
                    player.sendMessage("§e§l[FACTIONS] §r§eWhile you were offline:");
                    notes.forEach(msg => player.sendMessage(msg));
                }
            }, 100);

            faction.members[player.id].notifications = [];
            saveAllFactions(factions);
        }
    }
}

// ============================================
// SECTION 28: FACTION POWER & FACTION HOME
// ============================================

export function showFactionPowerInfo(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factionId = getPlayerFactionId(player.id);
    let myPower = getPlayerSavedPower(player.id);

    if (factionId) {
        const faction = getFactionById(factionId);
        if (faction && faction.members[player.id]) {
            myPower = faction.members[player.id].power || 0;
        }
    }

    player.sendMessage(`§eMy Power: §b${myPower}`);
    player.playSound("random.orb");
}

const activeFactionHomeTeleports = new Map();

export function showSetFactionHome(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factionId = getPlayerFactionId(player.id);
    if (!factionId) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou must be in a faction to set a Faction Home!");
    }

    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return;

    if (!hasFactionPermission(faction, player.id, "canSetHome") && !hasFactionPermission(faction, player.id, "manageHome")) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou do not have permission to manage the Faction Home!");
    }

    import("./factionsClaims.js").then(mod => {
        const currentOwner = mod.getChunkOwnerAt
            ? mod.getChunkOwnerAt(player.location, player.dimension.id)
            : null;

        if (currentOwner !== factionId) {
            player.playSound("note.bass");
            return player.sendMessage("§cYou can only set a Faction Home inside your own claimed territory!");
        }

        faction.home = {
            x: player.location.x,
            y: player.location.y,
            z: player.location.z,
            dimension: player.dimension.id
        };

        saveAllFactions(factions);
        player.playSound("random.orb");
        player.sendMessage("§aFaction Home set successfully!");

        for (const mid in faction.members) {
            if (mid === player.id) continue;
            const m = world.getAllPlayers().find(p => p.id === mid);
            if (m) m.sendMessage(`§a[ZYD-FACTIONS] §f${player.name} §aset/relocated the Faction Home!`);
        }
    }).catch(() => {
        player.sendMessage("§cFailed to check claimed land.");
    });
}

export function showTeleportFactionHome(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factionId = getPlayerFactionId(player.id);
    if (!factionId) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou must be in a faction to use Faction Home!");
    }

    const faction = getFactionById(factionId);
    if (!faction || !faction.home) {
        player.playSound("note.bass");
        return player.sendMessage("§cYour faction does not have a Faction Home set!");
    }

    if (activeFactionHomeTeleports.has(player.id)) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou are already teleporting!");
    }

    const home = faction.home;
    const startPos = {
        x: player.location.x,
        y: player.location.y,
        z: player.location.z
    };

    let secondsLeft = 5;
    let canceled = false;

    activeFactionHomeTeleports.set(player.id, true);
    player.playSound("note.pling");
    player.onScreenDisplay.setActionBar(`§aTeleporting to Faction Home in §e${secondsLeft}s... §f(Don't move!)`);

    const countdownInterval = system.runInterval(() => {
        secondsLeft--;

        if (secondsLeft > 0) {
            player.onScreenDisplay.setActionBar(`§aTeleporting to Faction Home in §e${secondsLeft}s... §f(Don't move!)`);
            if (secondsLeft <= 2) player.playSound("note.pling");
        } else {
            system.clearRun(countdownInterval);
            system.clearRun(movementCheckInterval);

            if (!canceled && activeFactionHomeTeleports.has(player.id)) {
                try {
                    const targetDim = world.getDimension(home.dimension || "minecraft:overworld");
                    player.teleport(
                        { x: home.x, y: home.y, z: home.z },
                        { dimension: targetDim }
                    );
                    player.onScreenDisplay.setActionBar("§aTeleported to Faction Home!");
                    player.sendMessage("§aSuccessfully teleported to Faction Home!");
                    player.playSound("random.orb");
                } catch (e) {
                    player.sendMessage("§cFailed to teleport to Faction Home.");
                }
                activeFactionHomeTeleports.delete(player.id);
            }
        }
    }, 20);

    const movementCheckInterval = system.runInterval(() => {
        if (secondsLeft <= 0.5 || canceled) return;

        const dx = Math.abs(player.location.x - startPos.x);
        const dy = Math.abs(player.location.y - startPos.y);
        const dz = Math.abs(player.location.z - startPos.z);

        if (dx > 0.15 || dy > 0.15 || dz > 0.15) {
            canceled = true;
            activeFactionHomeTeleports.delete(player.id);
            system.clearRun(countdownInterval);
            system.clearRun(movementCheckInterval);
            player.onScreenDisplay.setActionBar("§cTeleport cancelled! (You moved)");
            player.sendMessage("§cTeleport cancelled because you moved!");
            player.playSound("note.bass");
        }
    }, 5);
}

export function showDeleteFactionHome(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    const factionId = getPlayerFactionId(player.id);
    if (!factionId) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou must be in a faction to manage Faction Home!");
    }

    const factions = getAllFactions();
    const faction = factions[factionId];
    if (!faction) return;

    if (!hasFactionPermission(faction, player.id, "canSetHome") && !hasFactionPermission(faction, player.id, "manageHome")) {
        player.playSound("note.bass");
        return player.sendMessage("§cYou do not have permission to manage the Faction Home!");
    }

    if (!faction.home) {
        player.playSound("note.bass");
        return player.sendMessage("§cYour faction does not have a Faction Home set!");
    }

    delete faction.home;
    saveAllFactions(factions);

    player.playSound("random.orb");
    player.sendMessage("§eFaction Home deleted successfully!");

    for (const mid in faction.members) {
        if (mid === player.id) continue;
        const m = world.getAllPlayers().find(p => p.id === mid);
        if (m) m.sendMessage("§c[ZYD-FACTIONS] The Faction Home was deleted by the owner.");
    }
}

// ============================================
// SECTION 29: GLOBAL FACTION SETTINGS (OP ONLY)
// ============================================

const FACTION_SETTINGS_KEY = "zyd:faction_settings";

export function getFactionSettings() {
    try {
        const raw = world.getDynamicProperty(FACTION_SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);

            // Support old boolean saves
            if (typeof parsed.friendlyFire === "boolean") {
                return {
                    friendlyFireMode: parsed.friendlyFire ? "enabled" : "team_only"
                };
            }

            const mode = parsed.friendlyFireMode;
            if (mode === "enabled" || mode === "team_and_ally" || mode === "team_only") {
                return { friendlyFireMode: mode };
            }
        }
    } catch (e) { }

    // DEFAULT: block only same-team damage, allow ally damage
    return { friendlyFireMode: "team_only" };
}

export function saveFactionSettings(settings) {
    try {
        world.setDynamicProperty(FACTION_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { }
}

export function showFactionSettingsUI(player) {
    if (!isFactionsEnabledCore()) { isFactionsDisabledMessage(player); return; }
    if (!player.hasTag("op") && !player.hasTag("admin")) {
        player.playSound("note.bass");
        return player.sendMessage("§cOperator access required.");
    }

    import("./factionsClaims.js").then(mod => {
        const dims = mod.getAllowedClaimDimensions();
        const settings = getFactionSettings();

        let ffLabel = "§aDisable Team Damage";
        let ffIcon = "textures/rank_colours/green.png";

        if (settings.friendlyFireMode === "team_and_ally") {
            ffLabel = "§eDisable Team + Ally Damage";
            ffIcon = "textures/rank_colours/yellow.png";
        } else if (settings.friendlyFireMode === "enabled") {
            ffLabel = "§cEnable Friendly Fire";
            ffIcon = "textures/rank_colours/red.png";
        }

        const form = new ActionFormData()
            .title("§d§lFaction Settings")
            .body(
                "§7Configure global faction settings.\n\n" +
                "§fOverworld Claims: §aALWAYS ENABLED\n" +
                `§fNether Claims: ${dims.nether ? "§aENABLED" : "§cDISABLED"}\n` +
                `§fEnd Claims: ${dims.end ? "§aENABLED" : "§cDISABLED"}\n` +
                `§fFriendly Fire: ${ffLabel}\n\n` +
                "§8Modes:\n" +
                "§aDisable Team Damage §8- team blocked, allies allowed\n" +
                "§eDisable Team + Ally Damage §8- team and allies blocked\n" +
                "§cEnable Friendly Fire §8- everyone can damage"
            )
            .button(
                `§eNether Claims\n§f[ Currently: ${dims.nether ? "§aENABLED" : "§cDISABLED"} §f]`,
                dims.nether ? "textures/rank_colours/green.png" : "textures/rank_colours/red.png"
            )
            .button(
                `§eEnd Claims\n§f[ Currently: ${dims.end ? "§aENABLED" : "§cDISABLED"} §f]`,
                dims.end ? "textures/rank_colours/green.png" : "textures/rank_colours/red.png"
            )
            .button(
                `§6Friendly Fire\n§f[ ${ffLabel} §f]`,
                ffIcon
            )
            .button("§bProtection Settings\n§f[ Explosion & Interactions ]", "textures/settings.png")
            .button("§cBack", "textures/back.png");

        form.show(player).then(res => {
            if (res.canceled || res.selection === 4) return;

            if (res.selection === 0) {
                dims.nether = !dims.nether;
                mod.saveAllowedClaimDimensions(dims);
                player.sendMessage(`§aNether claims are now ${dims.nether ? "§aENABLED" : "§cDISABLED"}§a.`);
                player.playSound("random.orb");
                showFactionSettingsUI(player);
            } else if (res.selection === 1) {
                dims.end = !dims.end;
                mod.saveAllowedClaimDimensions(dims);
                player.sendMessage(`§aEnd claims are now ${dims.end ? "§aENABLED" : "§cDISABLED"}§a.`);
                player.playSound("random.orb");
                showFactionSettingsUI(player);
            } else if (res.selection === 2) {
                if (settings.friendlyFireMode === "team_only") {
                    settings.friendlyFireMode = "team_and_ally";
                    player.sendMessage("§eFriendly Fire set to: §eDisable Team + Ally Damage");
                } else if (settings.friendlyFireMode === "team_and_ally") {
                    settings.friendlyFireMode = "enabled";
                    player.sendMessage("§cFriendly Fire set to: §cEnable Friendly Fire");
                } else {
                    settings.friendlyFireMode = "team_only";
                    player.sendMessage("§aFriendly Fire set to: §aDisable Team Damage");
                }

                saveFactionSettings(settings);
                player.playSound("random.orb");
                showFactionSettingsUI(player);
            } else if (res.selection === 3) {
                showProtectionSettingsUI(player);
            }
        });
    }).catch(() => {
        player.sendMessage("§cFailed to open Faction Settings.");
    });
}

function showProtectionSettingsUI(player) {
    import("./factionsProtection.js").then(mod => {
        const pSettings = mod.getProtectionSettings();

        const form = new ModalFormData()
            .title("§b§lProtection Settings")
            .textField("§c--- EXPLOSIONS ---", "", { defaultValue: "Settings for claims" })
            .toggle("Allow TNT to destroy blocks", { defaultValue: !!pSettings.allowTntDamage })
            .toggle("Allow Creeper to destroy blocks", { defaultValue: !!pSettings.allowCreeperDamage })
            .toggle("Allow Wither to destroy blocks", { defaultValue: !!pSettings.allowWitherDamage })
            .toggle("Allow Crystals/Anchors to destroy blocks", { defaultValue: !!pSettings.allowCrystalDamage })
            .toggle("Allow Explosions if Faction Power is Zero", { defaultValue: !!pSettings.allowRaidOnZeroPower })
            .toggle("Players take explosion damage inside claims", { defaultValue: !!pSettings.allowExplosionPlayerDamage })
            .divider()
            .textField("§a--- DIPLOMACY ---", "", { defaultValue: "Settings for allies" })
            .toggle("Allow Allies to open doors/chests", { defaultValue: !!pSettings.allowAllyInteract })
            .divider()
            .textField("§6--- HOSTILE ACTIONS ---", "", { defaultValue: "Enemy & stranger rules" })
            .toggle("Allow Flint & Steel / Fire Charges", { defaultValue: !!pSettings.allowEnemyFire })
            .toggle("Allow Lava / Water Buckets (Place & Scoop)", { defaultValue: !!pSettings.allowEnemyBuckets })
            .toggle("Block Enemy Projectiles (Ender Pearls, Bows)", { defaultValue: !!pSettings.blockEnemyProjectiles });

        form.show(player).then(res => {
            if (res.canceled) return showFactionSettingsUI(player);

            // Correct formValue indices:
            // 0: textField, 1: TNT, 2: Creeper, 3: Wither, 4: Crystal, 5: ZeroPowerRaid, 6: ExplPlayer
            // 7: divider, 8: textField, 9: AllyInteract
            // 10: divider, 11: textField, 12: EnemyFire, 13: EnemyBuckets, 14: Projectiles
            pSettings.allowTntDamage = !!res.formValues[1];
            pSettings.allowCreeperDamage = !!res.formValues[2];
            pSettings.allowWitherDamage = !!res.formValues[3];
            pSettings.allowCrystalDamage = !!res.formValues[4];
            pSettings.allowRaidOnZeroPower = !!res.formValues[5];
            pSettings.allowExplosionPlayerDamage = !!res.formValues[6];

            pSettings.allowAllyInteract = !!res.formValues[9];

            pSettings.allowEnemyFire = !!res.formValues[12];
            pSettings.allowEnemyBuckets = !!res.formValues[13];
            pSettings.blockEnemyProjectiles = !!res.formValues[14];

            mod.saveProtectionSettings(pSettings);
            player.sendMessage("§a§l✔ Global Protection Settings Updated!");
            player.playSound("random.orb");
            showFactionSettingsUI(player);
        });
    }).catch(err => {
        player.sendMessage("§cFailed to load Protection Settings module.");
    });
}

console.log("✅ [FactionsCore] Loaded — Foundation & Social Systems Active");
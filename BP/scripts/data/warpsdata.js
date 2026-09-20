import { world } from "@minecraft/server";

//console.warn("warpsdata.js loaded");

// === [REGISTER DYNAMIC PROPERTIES] ===
world.afterEvents.worldLoad.subscribe(() => {
  try {
    world.getDynamicProperty("warps:data");
  } catch {
    world.setDynamicProperty("warps:data", "[]");
  }

  try {
    world.getDynamicProperty("warps:settings");
  } catch {
    world.setDynamicProperty("warps:settings", JSON.stringify({ countdown: 5 }));
  }
});

// === [HELPERS: WARPS] ===
function loadWarps() {
  const raw = world.getDynamicProperty("warps:data");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("Failed to parse warps data, resetting.");
    return [];
  }
}

function saveWarps(warps) {
  world.setDynamicProperty("warps:data", JSON.stringify(warps));
}

// === [HELPERS: SETTINGS] ===
function loadSettings() {
  const raw = world.getDynamicProperty("warps:settings");
  if (!raw) return { countdown: 5 };
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("Failed to parse warp settings, resetting.");
    return { countdown: 5 };
  }
}

function saveSettings(settings) {
  world.setDynamicProperty("warps:settings", JSON.stringify(settings));
}

// === [API FUNCTIONS: WARPS] ===
export function getWarps() {
  return loadWarps();
}

export function addWarp(name, coords, dimension = "minecraft:overworld", icon = "textures/warps/overworld.png") {
  const warps = loadWarps();

  const exists = warps.some(w => w.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    return { success: false, reason: "duplicate" };
  }

  warps.push({ name, coords, dimension, icon });
  saveWarps(warps);
  return { success: true };
}

export function updateWarp(oldName, changes) {
  const warps = loadWarps();
  const index = warps.findIndex(w => w.name === oldName);
  if (index === -1) return { success: false, reason: "notfound" };

  if (changes.name) {
    const conflict = warps.some(
      w => w.name.toLowerCase() === changes.name.toLowerCase() && w.name !== oldName
    );
    if (conflict) {
      return { success: false, reason: "duplicate" };
    }
  }

  warps[index] = { ...warps[index], ...changes };
  saveWarps(warps);
  return { success: true };
}

export function deleteWarp(name) {
  let warps = loadWarps();
  const before = warps.length;
  warps = warps.filter(w => w.name !== name);
  saveWarps(warps);
  return before !== warps.length;
}

// === [API FUNCTIONS: SETTINGS] ===
export function getWarpSettings() {
  return loadSettings();
}

export function setWarpSettings(newSettings) {
  const current = loadSettings();
  const updated = { ...current, ...newSettings };
  saveSettings(updated);
}

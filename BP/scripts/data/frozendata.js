import { world } from "@minecraft/server";

// === [REGISTER DYNAMIC PROPERTIES] ===
world.afterEvents.worldLoad.subscribe(() => {
  try {
    world.getDynamicProperty("froze:data");
  } catch {
    world.setDynamicProperty("froze:data", "[]");
  }
});

// === [HELPERS: FROZE DATA] ===
function loadFrozen() {
  const raw = world.getDynamicProperty("froze:data");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("Failed to parse frozen data, resetting.");
    world.setDynamicProperty("froze:data", "[]");
    return [];
  }
}

function saveFrozen(list) {
  world.setDynamicProperty("froze:data", JSON.stringify(list));
}

// === [API FUNCTIONS] ===
export function saveFrozenLocation(player) {
  const frozen = loadFrozen();
  const existingIndex = frozen.findIndex(f => f.name === player.name);

  const entry = {
    name: player.name,
    x: player.location.x,
    y: player.location.y,
    z: player.location.z,
    dimension: player.dimension.id,   // <-- NEW: store dimension id
    tags: ["frozed", "ban"]           // keep tags for audit/debug
  };

  if (existingIndex !== -1) {
    frozen[existingIndex] = entry;
  } else {
    frozen.push(entry);
  }

  saveFrozen(frozen);
}

export function getFrozenLocation(player) {
  const frozen = loadFrozen();
  return frozen.find(f => f.name === player.name);
}

export function clearFrozenLocation(player) {
  let frozen = loadFrozen();
  frozen = frozen.filter(f => f.name !== player.name);
  saveFrozen(frozen);
}

export function getAllFrozen() {
  return loadFrozen();
}

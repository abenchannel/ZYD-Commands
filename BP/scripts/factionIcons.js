// scripts/factionIcons.js
// ═══════════════════════════════════════════════════════════════
// ICON REGISTRY FOR FACTIONS
// ═══════════════════════════════════════════════════════════════
// 
// 📝 HOW TO ADD NEW ICONS (FLAGS):
//    1. Add your flag texture to: resourcePack/textures/factions/icons/
//    2. Map the icon in your glyph_E1.png and get the unicode (e.g., \u{E101})
//    3. Copy one of the objects below and change the id, name, and unicode.
//
//    Format:
//    { id: "flag_id", name: "Display Name", unicode: "\u{E1XX}" }
//
// ⚠️ RULES:
//    1. "id" must be unique (saved to database).
//    2. "name" is what players see in the dropdown.
//    3. "unicode" is the character shown in chat and above the head.
//    4. First entry = Default icon (shown at top of dropdown).
//
// 🎨 TIP: Use emojis in the "name" to make them stand out in the list!
// ═══════════════════════════════════════════════════════════════

export const FACTION_ICONS = [

    // ==========================================
    // FLAG ICONS
    // ==========================================
    { id: "flag_philippines", name: "Philippines Flag", unicode: "\u{E100}", texture: "textures/factions/icons/flag_philippines.png" }

    // Example for when you add your next flag:
    // { id: "flag_japan", name: "Japan Flag", unicode: "\u{E101}", texture: "textures/factions/icons/flag_japan.png" },
    // { id: "flag_america", name: "America Flag", unicode: "\u{E102}", texture: "textures/factions/icons/flag_america.png" },

];

console.log("✅ [FactionIcons] Loaded — " + FACTION_ICONS.length + " icons registered.");
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import {
    addWarp,
    getWarps,
    updateWarp,
    deleteWarp,
    getWarpSettings,
    setWarpSettings
} from "../data/warpsdata.js";

// Helper to avoid circular import with menu.js
function goBackToOperatorPanel(player) {
    import("../menu.js")
        .then(mod => {
            if (typeof mod.showOperatorPanel === "function") mod.showOperatorPanel(player);
            else console.warn("showOperatorPanel not found on menu module", mod);
        })
        .catch(err => console.warn("Failed to import menu module:", err));
}

// === [OPERATOR WARPS EDIT FUNCTION] ===
export function showWarpsEdit(player) {
    const form = new ActionFormData()
        .title("§bOperator Warps")
        .body("§7Manage warps here:\n\n" +
            "§aAdd Warp§f - Create a new warp point.\n" +
            "§eEdit Warp§f - Modify or delete existing warp points.\n" +
            "§6Warp Settings§f - Adjust global countdown before teleport.\n")
        .button("§aAdd Warp", "textures/operator/add.png")
        .button("§eEdit Warp", "textures/operator/edit.png")
        .button("§6Warp Settings", "textures/operator/settings.png")
        .button("§cBack", "textures/operator/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        switch (response.selection) {
            case 0: showAddWarpForm(player); break;
            case 1: showEditWarpMenu(player); break;
            case 2: showWarpSettings(player); break;
            case 3:
            default: goBackToOperatorPanel(player); break;
        }
    });
}

// === [WARP SETTINGS SUB‑UI] ===
function showWarpSettings(player) {
    const currentSettings = getWarpSettings();
    const currentCountdown = Number.isInteger(currentSettings?.countdown)
        ? currentSettings.countdown
        : 5;

    const form = new ActionFormData()
        .title("§6Warp Settings")
        .body(`§7Current global countdown: §a${currentCountdown}s\n§7Select new countdown:`);

    for (let i = 0; i <= 10; i++) {
        form.button(`${i}s`);
    }

    form.show(player).then(response => {
        if (response.canceled) return;
        const newCountdown = response.selection;
        setWarpSettings({ countdown: newCountdown });
        player.sendMessage(`§aGlobal warp countdown set to ${newCountdown}s.`);
    });
}

// === [ADD WARP FORM] ===
function showAddWarpForm(player) {
    const location = player.location;
    const defaultX = Math.floor(location.x);
    const defaultY = Math.floor(location.y);
    const defaultZ = Math.floor(location.z);

    let defaultDimIndex = 0;
    const dimId = player.dimension.id;
    if (dimId === "minecraft:nether") defaultDimIndex = 1;
    if (dimId === "minecraft:the_end") defaultDimIndex = 2;

    const modal = new ModalFormData()
        .title("§aAdd Warp")
        .textField("Enter a Name for this Warp", "Warp name required")
        .dropdown("Select Dimension", ["Overworld", "Nether", "The End"], { defaultValueIndex: defaultDimIndex })
        .textField("X Coordinate", defaultX.toString())
        .textField("Y Coordinate", defaultY.toString())
        .textField("Z Coordinate", defaultZ.toString())
        // Expanded icon selection
        .dropdown("Select Icon", [
            "Overworld",
            "Nether",
            "End",
            "Coal Block",
            "Diamond Block",
            "Emerald Block",
            "Gold Block",
            "Iron Block",
            "Lapis Block",
            "Netherite Block",
            "Redstone Block"
        ], { defaultValueIndex: 0 })
        .divider()
        .submitButton("§aSubmit");

    modal.show(player).then(response => {
        if (response.canceled) return;

        const values = response.formValues || [];
        const warpName = (values[0] || "").trim();
        const dimensionIndex = (typeof values[1] === "number") ? values[1] : defaultDimIndex;
        const xInput = (values[2] || "").trim();
        const yInput = (values[3] || "").trim();
        const zInput = (values[4] || "").trim();
        const iconIndex = (typeof values[5] === "number") ? values[5] : 0;

        if (!warpName) {
            player.sendMessage("§cWarp name is required.");
            return;
        }

        let dimension = "minecraft:overworld";
        if (dimensionIndex === 1) dimension = "minecraft:nether";
        if (dimensionIndex === 2) dimension = "minecraft:the_end";

        const coords = `${xInput || defaultX} ${yInput || defaultY} ${zInput || defaultZ}`;

        // Map dropdown index to icon path
        let iconPath = "textures/warps/overworld.png";
        switch (iconIndex) {
            case 1: iconPath = "textures/warps/nether.png"; break;
            case 2: iconPath = "textures/warps/end.png"; break;
            case 3: iconPath = "textures/warps/minecraft_coal_block.png"; break;
            case 4: iconPath = "textures/warps/minecraft_diamond_block.png"; break;
            case 5: iconPath = "textures/warps/minecraft_emerald_block.png"; break;
            case 6: iconPath = "textures/warps/minecraft_gold_block.png"; break;
            case 7: iconPath = "textures/warps/minecraft_iron_block.png"; break;
            case 8: iconPath = "textures/warps/minecraft_lapis_block.png"; break;
            case 9: iconPath = "textures/warps/minecraft_netherite_block.png"; break;
            case 10: iconPath = "textures/warps/minecraft_redstone_block.png"; break;
        }

        const result = addWarp(warpName, coords, dimension, iconPath);
        if (result.success) {
            player.sendMessage(`§aWarp '${warpName}' added in ${dimension.replace("minecraft:", "")} with icon '${iconPath}'.`);
        } else if (result.reason === "duplicate") {
            player.sendMessage(`§cWarp '${warpName}' already exists.`);
        }
    });
}

// === [EDIT WARP MENU] ===
function showEditWarpMenu(player) {
    const warps = getWarps();
    if (!warps || warps.length === 0) {
        player.sendMessage("§cNo warps available to edit.");
        return;
    }

    const form = new ActionFormData()
        .title("§eEdit Warp")
        .body("§7Select a warp to manage:");

    warps.forEach(w => form.button(`§f${w.name}`, w.icon || "textures/warps/overworld.png"));
    form.button("§cBack", "textures/operator/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === warps.length) {
            showWarpsEdit(player);
            return;
        }

        const selectedWarp = warps[response.selection];
        if (selectedWarp) showWarpSubMenu(player, selectedWarp);
    });
}

// === [WARP SUBMENU] ===
function showWarpSubMenu(player, warp) {
    const form = new ActionFormData()
        .title(`§eManage Warp: ${warp.name}`)
        .body("§7Choose an action:")
        .button("§aEdit Name/Coordinates/Icon", "textures/operator/edit2.png")
        .button("§cDelete Warp", "textures/operator/delete.png")
        .button("§dBack", "textures/operator/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        switch (response.selection) {
            case 0: showWarpDirectEdit(player, warp); break;
            case 1: confirmDeleteWarp(player, warp.name); break;
            case 2:
            default: showEditWarpMenu(player); break;
        }
    });
}

// === [DIRECT EDIT FORM] ===
function showWarpDirectEdit(player, warp) {
    const [xDefault, yDefault, zDefault] = warp.coords.split(" ").map(c => c.trim());
    let dimensionIndex = 0;
    if (warp.dimension === "minecraft:nether") dimensionIndex = 1;
    if (warp.dimension === "minecraft:the_end") dimensionIndex = 2;

    // Expanded icon options
    const iconOptions = [
        "textures/warps/overworld.png",
        "textures/warps/nether.png",
        "textures/warps/end.png",
        "textures/warps/minecraft_coal_block.png",
        "textures/warps/minecraft_diamond_block.png",
        "textures/warps/minecraft_emerald_block.png",
        "textures/warps/minecraft_gold_block.png",
        "textures/warps/minecraft_iron_block.png",
        "textures/warps/minecraft_lapis_block.png",
        "textures/warps/minecraft_netherite_block.png",
        "textures/warps/minecraft_redstone_block.png"
    ];

    // Find current icon index
    let iconIndex = iconOptions.indexOf(warp.icon);
    if (iconIndex < 0) iconIndex = 0;

    const modal = new ModalFormData()
        .title(`§eEdit Warp: ${warp.name}`)
        .textField("Warp Name:", warp.name)
        .dropdown("Select Dimension", ["Overworld", "Nether", "The End"], { defaultValueIndex: dimensionIndex })
        .textField("X Coordinate", xDefault)
        .textField("Y Coordinate", yDefault)
        .textField("Z Coordinate", zDefault)
        .dropdown("Select Icon", [
            "Overworld",
            "Nether",
            "End",
            "Coal Block",
            "Diamond Block",
            "Emerald Block",
            "Gold Block",
            "Iron Block",
            "Lapis Block",
            "Netherite Block",
            "Redstone Block"
        ], { defaultValueIndex: iconIndex })
        .divider()
        .submitButton("§aUpdate");

    modal.show(player).then(response => {
        if (response.canceled) return;

        const values = response.formValues || [];
        const newNameRaw = (values[0] || "").trim();
        const newName = newNameRaw || warp.name;
        const newDimIndex = (typeof values[1] === "number") ? values[1] : 0;
        const newX = (values[2] || "").trim() || xDefault;
        const newY = (values[3] || "").trim() || yDefault;
        const newZ = (values[4] || "").trim() || zDefault;
        const newIconIndex = (typeof values[5] === "number") ? values[5] : iconIndex;

        let newDimension = "minecraft:overworld";
        if (newDimIndex === 1) newDimension = "minecraft:nether";
        if (newDimIndex === 2) newDimension = "minecraft:the_end";

        const newCoords = `${newX} ${newY} ${newZ}`;
        const newIconPath = iconOptions[newIconIndex] || "textures/warps/overworld.png";

        const result = updateWarp(warp.name, {
            name: newName,
            coords: newCoords,
            dimension: newDimension,
            icon: newIconPath
        });

        if (result.success) {
            player.sendMessage(`§aWarp '${warp.name}' updated to '${newName}' with icon '${newIconPath}'.`);
        } else if (result.reason === "duplicate") {
            player.sendMessage(`§cWarp update failed. Name '${newName}' already exists.`);
        } else {
            player.sendMessage(`§cWarp update failed.`);
        }
    });
}

// === [DELETE CONFIRMATION] ===
function confirmDeleteWarp(player, warpName) {
    const form = new ActionFormData()
        .title("§cConfirm Delete")
        .body(`§7Delete warp '${warpName}'?`)
        .button("§aYes", "textures/operator/delete.png")
        .button("§cNo", "textures/operator/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        if (response.selection === 0) {
            deleteWarp(warpName);
            player.sendMessage(`§cWarp '${warpName}' deleted.`);
            showEditWarpMenu(player);
        } else {
            showEditWarpMenu(player);
        }
    });
}

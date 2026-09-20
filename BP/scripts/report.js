import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { showMenu } from "./menu.js";

// ============================================
// DATA PERSISTENCE
// ============================================

const REPORT_DATA_KEY = "zyd_reports_v1";

function getReports() {
    try {
        const raw = world.getDynamicProperty(REPORT_DATA_KEY);
        if (raw && typeof raw === 'string' && raw.length > 0) {
            return JSON.parse(raw);
        }
    } catch (e) { }
    return { reports: [] };
}

function saveReports(data) {
    try {
        world.setDynamicProperty(REPORT_DATA_KEY, JSON.stringify(data));
    } catch (e) {
        console.error("[Report] Save error:", e);
    }
}

// ============================================
// ICON HELPER
// ============================================

function getSubjectIcon(subject) {
    switch (subject) {
        case "Cheating / Hacking": return "textures/reports/cheating.png";
        case "Duping / Item Exploit": return "textures/reports/duping.png";
        case "Verbal Abuse / Harassment": return "textures/reports/verbal_abuse.png";
        case "Inappropriate / Sensitive Text": return "textures/reports/inappropriate.png";
        case "Scamming": return "textures/reports/scamming.png";
        case "Bug Abuse": return "textures/reports/bug_abuse.png";
        case "Griefing / Trolling": return "textures/reports/griefing.png";
        default: return "textures/reports/others.png";
    }
}

// ============================================
// TIME HELPER (Manila Time UTC+8)
// ============================================

function getManilaTimeString() {
    const now = new Date();
    const manilaTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));

    const month = manilaTime.getMonth() + 1;
    const day = manilaTime.getDate();
    const year = manilaTime.getFullYear();

    let hours = manilaTime.getHours();
    const minutes = manilaTime.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = dayNames[manilaTime.getDay()];

    return `${dayName}, ${month}/${day}/${year} ${hours}:${minutes} ${ampm}`;
}

// ============================================
// MAIN REPORT MENU
// ============================================

export function showReportMenu(player) {
    const isOp = player.hasTag("op") || player.hasTag("admin");

    // Check if there are unread/unhandled reports for the admin icon
    const data = getReports();
    const hasUnread = isOp && data.reports.some(r => r.adminStatus === "Pending" && !r.adminRemoved);
    const adminIcon = hasUnread ? "textures/exclamation.png" : "textures/endersee.png";

    const form = new ActionFormData()
        .title("§c§lReport System§r")
        .body("§7Report players who violate rules or abuse bugs.\n\n§eSelect an option:")
        .button("§aReport Player\n§e[ Send Report to Mods ]", "textures/red_flag.png")
        .button("§bMy Inbox\n§e[ View My Reports ]", "textures/shop.png");

    if (isOp) {
        form.button("§6§lAdmin Inbox§r\n§e[ OP/Admin Exclusive ]", adminIcon);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        switch (response.selection) {
            case 0: showCreateReport(player); break;
            case 1: showMyInbox(player); break;
            case 2: if (isOp) showAdminInbox(player); else showMenu(player); break;
            default: showMenu(player); break;
        }
    });
}

// ============================================
// CREATE REPORT
// ============================================

function showCreateReport(player) {
    const onlinePlayers = world.getAllPlayers().filter(p => p.id !== player.id);
    const playerNames = onlinePlayers.map(p => p.name);
    playerNames.unshift("§4Not Sure (Player name not seen)§r");

    const subjects = [
        "Cheating / Hacking",
        "Duping / Item Exploit",
        "Verbal Abuse / Harassment",
        "Inappropriate / Sensitive Text",
        "Scamming",
        "Bug Abuse",
        "Griefing / Trolling",
        "Other / Not Listed"
    ];

    const form = new ModalFormData()
        .title("§a§lReport a Player§r")
        .dropdown("§eSelect Player to Report", playerNames, { defaultValueIndex: 0 })
        .dropdown("§eReport Subject", subjects)
        .textField("§bMessage / Proof / More Info §e[1]§r\n§7(Leave blank if none)", "Type here...")
        .textField("§bMessage / Proof / More Info §e[2]§r\n§7(Leave blank if none)", "Type here...")
        .textField("§bMessage / Proof / More Info §e[3]§r\n§7(Leave blank if none)", "Type here...");

    form.show(player).then(response => {
        if (response.canceled) return;

        const selectedPlayerIndex = response.formValues[0];
        const selectedSubjectIndex = response.formValues[1];
        const msg1 = (response.formValues[2] || "").trim();
        const msg2 = (response.formValues[3] || "").trim();
        const msg3 = (response.formValues[4] || "").trim();

        const reportedPlayer = selectedPlayerIndex === 0 ? "Not Sure" : playerNames[selectedPlayerIndex];
        const subject = subjects[selectedSubjectIndex];

        const messages = [msg1, msg2, msg3].filter(m => m.length > 0);
        if (messages.length === 0) {
            player.sendMessage("§cInvalid report! You need to explain what happened in at least one message line.§r");
            showCreateReport(player);
            return;
        }
        const finalMessage = messages.join("\n");

        const data = getReports();
        const newReport = {
            id: `rpt_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            reporterId: player.id,
            reporterName: player.name,
            reportedPlayer: reportedPlayer,
            subject: subject,
            message: finalMessage,
            timestamp: Date.now(),
            timeString: getManilaTimeString(),
            deletedByReporter: false,
            markedFalseByReporter: false,
            readByAdmin: false, // NEW: Read mark
            adminStatus: "Pending",
            adminReply: ""
        };

        data.reports.push(newReport);
        saveReports(data);

        player.sendMessage("§a§l✔ Report Submitted Successfully!§r");
        player.sendMessage(`§7Subject: §e${subject}§r`);
        player.sendMessage(`§7Reported: §c${reportedPlayer}§r`);
        player.sendMessage(`§7Time: §b${newReport.timeString}§r`);
        player.playSound("random.orb");

        showReportMenu(player);
    });
}

// ============================================
// MY INBOX
// ============================================

function showMyInbox(player) {
    const data = getReports();
    const myReports = data.reports.filter(r => r.reporterId === player.id && !r.deletedByReporter);

    if (myReports.length === 0) {
        const form = new ActionFormData()
            .title("§b§lMy Inbox§r")
            .body("§7You haven't submitted any reports yet, or you deleted them from your inbox.")
            .button("§cBack", "textures/back.png");

        form.show(player).then(response => {
            if (!response.canceled) showReportMenu(player);
        });
        return;
    }

    const form = new ActionFormData()
        .title("§b§lMy Inbox§r")
        .body(`§eTotal Reports: §b${myReports.length}§r\n\n§7Click a report to view details.`);

    for (const report of myReports) {
        let statusText;
        if (report.adminStatus === "Pending") {
            statusText = report.readByAdmin ? "§b[Read]§r" : "§e[Unread]§r";
        } else if (report.adminStatus === "Noted") {
            statusText = "§b[Noted]§r";
        } else {
            statusText = "§a[Done]§r";
        }

        const falseTag = report.markedFalseByReporter ? " §c[FALSE]§r" : "";
        const icon = getSubjectIcon(report.subject);

        form.button(`§f${report.subject}§r\n§eTarget: §c${report.reportedPlayer}§r ${statusText}${falseTag}`, icon);
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === myReports.length) {
            showReportMenu(player);
            return;
        }

        const selectedReport = myReports[response.selection];
        if (selectedReport) showMyReportDetail(player, selectedReport.id);
    });
}

function showMyReportDetail(player, reportId) {
    const data = getReports();
    const report = data.reports.find(r => r.id === reportId);

    if (!report) {
        player.sendMessage("§cReport no longer exists.§r");
        showMyInbox(player);
        return;
    }

    let statusText;
    if (report.adminStatus === "Pending") {
        statusText = report.readByAdmin ? "§bRead by Admin§r" : "§eUnread by Admin§r";
    } else if (report.adminStatus === "Noted") {
        statusText = "§bNoted§r";
    } else {
        statusText = "§aDone§r";
    }

    let bodyText = "§7═══════════════════§r\n";
    bodyText += `§eSubject: §f${report.subject}§r\n`;
    bodyText += `§eReported Player: §c${report.reportedPlayer}§r\n`;
    bodyText += `§eTime: §b${report.timeString}§r\n`;
    bodyText += `§eMessage/Proof: §f${report.message}§r\n`;
    bodyText += "§7═══════════════════§r\n\n";
    bodyText += `§eAdmin Status: ${statusText}\n`;

    if (report.adminReply) {
        bodyText += `§eAdmin Reply: §a${report.adminReply}§r\n`;
    }

    if (report.markedFalseByReporter) {
        bodyText += "\n§c§lYou marked this as a False Report.§r";
    }

    const form = new ActionFormData()
        .title("§b§lReport Details§r")
        .body(bodyText);

    if (!report.markedFalseByReporter) {
        form.button("§cMark as False Report\n§e[ Mistake Report ]", "textures/rank_colours/red.png");
    } else {
        form.button("§aUnmark False Report\n§e[ Restore Report ]", "textures/rank_colours/green.png");
    }

    form.button("§4Delete for Me\n§e[ Warning: Admin still sees ]", "textures/rank_colours/dark_gray.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        switch (response.selection) {
            case 0:
                report.markedFalseByReporter = !report.markedFalseByReporter;
                saveReports(data);
                player.sendMessage(report.markedFalseByReporter ? "§cMarked as False Report.§r" : "§aUnmarked False Report.§r");
                showMyReportDetail(player, reportId);
                break;
            case 1:
                showDeleteConfirm(player, reportId);
                break;
            default:
                showMyInbox(player);
                break;
        }
    });
}

function showDeleteConfirm(player, reportId) {
    const form = new MessageFormData()
        .title("§4§lDELETE WARNING§r")
        .body("§cAre you sure you want to delete this from your inbox?§r\n\n§eThis will ONLY hide it from your view.§r\n§aAdmins will STILL SEE this report.§r\n\n§7If you made a mistake, use 'Mark as False Report' instead.§r")
        .button1("§cYes, Delete for Me")
        .button2("§aNo, Keep It");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showMyReportDetail(player, reportId);
            return;
        }

        const data = getReports();
        const report = data.reports.find(r => r.id === reportId);
        if (report) {
            report.deletedByReporter = true;
            saveReports(data);
            player.sendMessage("§eReport deleted from your inbox. Admins can still see it.§r");
        }
        showMyInbox(player);
    });
}

// ============================================
// ADMIN INBOX (OP/ADMIN ONLY)
// ============================================

function showAdminInbox(player) {
    const data = getReports();
    const activeReports = data.reports.filter(r => !r.adminRemoved);

    if (activeReports.length === 0) {
        const form = new ActionFormData()
            .title("§6§lAdmin Inbox§r")
            .body("§7No active reports found.")
            .button("§cBack", "textures/back.png");

        form.show(player).then(response => {
            if (!response.canceled) showReportMenu(player);
        });
        return;
    }

    const form = new ActionFormData()
        .title("§6§lAdmin Inbox§r")
        .body(`§eTotal Active Reports: §c${activeReports.length}§r\n\n§7Click to manage.`);

    for (const report of activeReports) {
        let statusColor;
        if (report.adminStatus === "Pending") {
            statusColor = report.readByAdmin ? "§b" : "§e"; // Yellow if Unread, Aqua if Read
        } else if (report.adminStatus === "Noted") {
            statusColor = "§b";
        } else {
            statusColor = "§a";
        }

        const deletedTag = report.deletedByReporter ? " §d[Owner Deleted]§r" : "";
        const falseTag = report.markedFalseByReporter ? " §c[FALSE]§r" : "";
        const icon = getSubjectIcon(report.subject);

        // Name as main text, Subject as subtext
        form.button(
            `§f${report.reporterName}§r\n§e${report.subject}§r ${statusColor}[${report.adminStatus}]§r${falseTag}${deletedTag}`,
            icon
        );
    }

    form.button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;
        if (response.selection === activeReports.length) {
            showReportMenu(player);
            return;
        }

        const selectedReport = activeReports[response.selection];
        if (selectedReport) showAdminReportDetail(player, selectedReport.id);
    });
}

function showAdminReportDetail(player, reportId) {
    const data = getReports();
    const report = data.reports.find(r => r.id === reportId);

    if (!report) {
        player.sendMessage("§cReport no longer exists.§r");
        showAdminInbox(player);
        return;
    }

    // Mark as Read when opened by Admin
    if (!report.readByAdmin) {
        report.readByAdmin = true;
        saveReports(data);
    }

    let statusText;
    if (report.adminStatus === "Pending") {
        statusText = report.readByAdmin ? "§bRead§r" : "§eUnread§r";
    } else if (report.adminStatus === "Noted") {
        statusText = "§bNoted§r";
    } else {
        statusText = "§aDone§r";
    }

    let bodyText = "§7═══════════════════§r\n";
    bodyText += `§eReporter: §a${report.reporterName}§r\n`;
    bodyText += `§eReported Player: §c${report.reportedPlayer}§r\n`;
    bodyText += `§eExact Time: §b${report.timeString}§r\n`;
    bodyText += `§eSubject: §f${report.subject}§r\n`;
    bodyText += `§eMessage/Proof: §f${report.message}§r\n`;
    bodyText += "§7═══════════════════§r\n\n";

    if (report.markedFalseByReporter) bodyText += "§c§l[!] Reporter marked this as FALSE!§r\n\n";
    if (report.deletedByReporter) bodyText += "§d§l[!] Reporter deleted this from their inbox. Your replies won't be seen.§r\n\n";

    bodyText += `§eAdmin Status: ${statusText}\n`;
    if (report.adminReply) bodyText += `§eAdmin Reply: §a${report.adminReply}§r\n`;

    const form = new ActionFormData()
        .title("§6§lManage Report§r")
        .body(bodyText);

    if (!report.deletedByReporter) {
        form.button("§aReply to Reporter\n§e[ Send Message ]", "textures/hologram.png");
    } else {
        form.button("§dReply Disabled\n§e[ Owner Deleted Inbox ]", "textures/rank_colours/light_purple.png");
    }

    if (report.adminStatus !== "Noted") form.button("§bMark as Noted\n§e[ Seen / Acknowledged ]", "textures/guide.png");
    if (report.adminStatus !== "Done") form.button("§aMark as Done\n§e[ Resolved / Action Taken ]", "textures/check.png");

    form.button("§4Remove Report\n§e[ Delete Permanently ]", "textures/delete.png")
        .button("§cBack", "textures/back.png");

    form.show(player).then(response => {
        if (response.canceled) return;

        let actionIndex = 0;

        const replyIndex = actionIndex++;
        const isDisabled = report.deletedByReporter;

        const notedIndex = report.adminStatus !== "Noted" ? actionIndex++ : -1;
        const doneIndex = report.adminStatus !== "Done" ? actionIndex++ : -1;
        const removeIndex = actionIndex++;
        const backIndex = actionIndex++;

        if (response.selection === replyIndex && !isDisabled) {
            showReplyForm(player, reportId);
        } else if (response.selection === notedIndex) {
            report.adminStatus = "Noted";
            saveReports(data);
            player.sendMessage("§bReport marked as §lNoted§r§b.§r");
            showAdminReportDetail(player, reportId);
        } else if (response.selection === doneIndex) {
            report.adminStatus = "Done";
            saveReports(data);
            player.sendMessage("§aReport marked as §lDone§r§a.§r");
            showAdminReportDetail(player, reportId);
        } else if (response.selection === removeIndex) {
            showAdminRemoveConfirm(player, reportId);
        } else {
            showAdminInbox(player);
        }
    });
}

function showReplyForm(player, reportId) {
    const form = new ModalFormData()
        .title("§a§lReply to Reporter§r")
        .textField("§eEnter your reply message:", "Type reply here...");

    form.show(player).then(response => {
        if (response.canceled) return;

        const replyMessage = (response.formValues[0] || "").trim();
        if (!replyMessage) {
            player.sendMessage("§cReply cannot be empty.§r");
            showReplyForm(player, reportId);
            return;
        }

        const data = getReports();
        const report = data.reports.find(r => r.id === reportId);
        if (!report) return;

        report.adminReply = replyMessage;
        saveReports(data);

        player.sendMessage("§aReply sent successfully!§r");

        const reporter = world.getAllPlayers().find(p => p.id === report.reporterId);
        if (reporter) {
            reporter.sendMessage("§a§l[REPORT UPDATE]§r §eAn admin replied to your report regarding §c" + report.reportedPlayer + "§e!§r");
            reporter.sendMessage(`§bAdmin: §f${replyMessage}§r`);
            reporter.playSound("random.orb");
        }

        showAdminReportDetail(player, reportId);
    });
}

function showAdminRemoveConfirm(player, reportId) {
    const form = new MessageFormData()
        .title("§4§lREMOVE REPORT§r")
        .body("§cAre you sure you want to permanently remove this report?§r\n\n§4This action CANNOT be undone and it will vanish for everyone.§r")
        .button1("§cYes, Remove Permanently")
        .button2("§aNo, Keep It");

    form.show(player).then(response => {
        if (response.canceled || response.selection === 1) {
            showAdminReportDetail(player, reportId);
            return;
        }

        const data = getReports();
        data.reports = data.reports.filter(r => r.id !== reportId);
        saveReports(data);

        player.sendMessage("§cReport permanently removed.§r");
        showAdminInbox(player);
    });
}

console.log("✅ [Report] System Loaded!");
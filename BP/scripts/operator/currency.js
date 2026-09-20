// scripts/operator/currency.js
// SINGLE SOURCE OF TRUTH for currency configuration

import { world, system } from "@minecraft/server";

const CURRENCY_OBJECTIVE_PROP = "zyd:currency_objective";
const CURRENCY_SYMBOL_PROP = "zyd:currency_symbol";
const CURRENCY_NAME_PROP = "zyd:currency_name";

const DEFAULT_OBJECTIVE = "Money";
const DEFAULT_SYMBOL = "$";
const DEFAULT_NAME = "Money";

// Get the scoreboard objective name used for currency
export function getCurrencyObjective() {
    try {
        const v = world.getDynamicProperty(CURRENCY_OBJECTIVE_PROP);
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
    } catch (e) { }
    return DEFAULT_OBJECTIVE;
}

// Set the scoreboard objective name
export function setCurrencyObjective(name) {
    try {
        world.setDynamicProperty(CURRENCY_OBJECTIVE_PROP, String(name || DEFAULT_OBJECTIVE).trim());
        return true;
    } catch (e) { return false; }
}

// Get the currency symbol (e.g., "$")
export function getCurrencySymbol() {
    try {
        const v = world.getDynamicProperty(CURRENCY_SYMBOL_PROP);
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
    } catch (e) { }
    return DEFAULT_SYMBOL;
}

// Set the currency symbol
export function setCurrencySymbol(symbol) {
    try {
        world.setDynamicProperty(CURRENCY_SYMBOL_PROP, String(symbol || DEFAULT_SYMBOL).trim());
        return true;
    } catch (e) { return false; }
}

// Get the display name of the currency
export function getCurrencyName() {
    try {
        const v = world.getDynamicProperty(CURRENCY_NAME_PROP);
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
    } catch (e) { }
    return DEFAULT_NAME;
}

// Set the display name
export function setCurrencyName(name) {
    try {
        world.setDynamicProperty(CURRENCY_NAME_PROP, String(name || DEFAULT_NAME).trim());
        return true;
    } catch (e) { return false; }
}

// Convenience: Get the money objective (for backward compatibility)
// ============================================
// BIG BALANCE SYSTEM (Chunked across 2 objectives)
// ============================================
// Bedrock scoreboard scores are 32-bit signed integers (max ~2.147 billion),
// so a single objective can't hold big economies. We split the balance into
// a "low" shard (kept in the normal currency objective, e.g. "Money") and a
// "high" shard (a second objective, e.g. "Money_Hi"), combined as:
//   total = (high * CURRENCY_SHARD_BASE) + low
// This gives room up to ~9 Quadrillion while staying inside JS's safe
// integer range (Number.MAX_SAFE_INTEGER), so normal math stays exact.

const CURRENCY_SHARD_BASE = 1000000000; // 1e9 per shard (safe under int32 max)
const BALANCE_MAX = 9000000000000000; // 9 Quadrillion hard cap (safe integer)
const CURRENCY_MIGRATION_FLAG = "zyd:currency_migrated_v2";

function getHighObjectiveName() {
    return getCurrencyObjective() + "_Hi";
}

function ensureBalanceObjectives() {
    try {
        const lowName = getCurrencyObjective();
        const highName = getHighObjectiveName();
        if (!world.scoreboard.getObjective(lowName)) world.scoreboard.addObjective(lowName, lowName);
        if (!world.scoreboard.getObjective(highName)) world.scoreboard.addObjective(highName, highName);
    } catch (e) { }
}

// Get a player's/identity's full balance (combines both shards into one number)
export function getBalance(identity) {
    ensureBalanceObjectives();
    let low = 0, high = 0;
    try {
        const lowObj = world.scoreboard.getObjective(getCurrencyObjective());
        if (lowObj) low = lowObj.getScore(identity) || 0;
    } catch (e) { }
    try {
        const highObj = world.scoreboard.getObjective(getHighObjectiveName());
        if (highObj) high = highObj.getScore(identity) || 0;
    } catch (e) { }
    return (high * CURRENCY_SHARD_BASE) + low;
}

// Set a player's/identity's full balance (splits it back into both shards)
export function setBalance(identity, amount) {
    ensureBalanceObjectives();
    let value = Math.floor(Math.max(0, Math.min(amount || 0, BALANCE_MAX)));
    const high = Math.floor(value / CURRENCY_SHARD_BASE);
    const low = value % CURRENCY_SHARD_BASE;
    try {
        const lowObj = world.scoreboard.getObjective(getCurrencyObjective());
        const highObj = world.scoreboard.getObjective(getHighObjectiveName());
        if (lowObj) lowObj.setScore(identity, low);
        if (highObj) highObj.setScore(identity, high);
        return true;
    } catch (e) { return false; }
}

// Add to a player's/identity's balance. Returns the new total.
export function addBalance(identity, amount) {
    const newTotal = getBalance(identity) + (amount || 0);
    setBalance(identity, newTotal);
    return Math.min(newTotal, BALANCE_MAX);
}

// Subtract from a player's/identity's balance (floors at 0). Returns the new total.
export function subtractBalance(identity, amount) {
    const newTotal = Math.max(0, getBalance(identity) - (amount || 0));
    setBalance(identity, newTotal);
    return newTotal;
}

// The maximum balance any player/identity can hold
export function getBalanceMax() {
    return BALANCE_MAX;
}

// List every identity that currently has (or ever had) a balance entry
export function getBalanceParticipants() {
    ensureBalanceObjectives();
    try {
        const lowObj = world.scoreboard.getObjective(getCurrencyObjective());
        return lowObj ? lowObj.getParticipants() : [];
    } catch (e) { return []; }
}

// ONE-TIME MIGRATION: if the old single-objective balances had scores that
// were already close to/over the old ~1.2B ceiling, split them properly
// into low/high shards so nobody loses money when this update loads.
function migrateCurrencyIfNeeded() {
    try {
        if (world.getDynamicProperty(CURRENCY_MIGRATION_FLAG) === true) return;
        ensureBalanceObjectives();
        const lowObj = world.scoreboard.getObjective(getCurrencyObjective());
        const highObj = world.scoreboard.getObjective(getHighObjectiveName());
        if (lowObj) {
            const participants = lowObj.getParticipants();
            for (const p of participants) {
                let score = 0;
                try { score = lowObj.getScore(p) || 0; } catch (e) { continue; }
                if (score >= CURRENCY_SHARD_BASE) {
                    const extraHigh = Math.floor(score / CURRENCY_SHARD_BASE);
                    const remLow = score % CURRENCY_SHARD_BASE;
                    try {
                        lowObj.setScore(p, remLow);
                        const existingHigh = highObj ? (highObj.getScore(p) || 0) : 0;
                        if (highObj) highObj.setScore(p, existingHigh + extraHigh);
                    } catch (e) { }
                }
            }
        }
        world.setDynamicProperty(CURRENCY_MIGRATION_FLAG, true);
        console.warn("[Currency] Balance migration to multi-objective system complete.");
    } catch (e) { console.warn("[Currency] Migration failed:", e); }
}

system.run(() => { migrateCurrencyIfNeeded(); });
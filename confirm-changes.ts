/**
 * Confirm Changes Extension
 *
 * Intercepts file-modifying tool calls (write, edit) and bash commands.
 * Uses ~/.pi/agent/operations.json to decide which bash commands are
 * allowed, denied, or need approval. Write/edit default to "ask"
 * but can be set to "allow" or "deny" in operations.json.
 *
 * Rules are loaded once on startup and refreshed on /reload.
 * If operations.json is missing, all bash commands require approval.
 *
 * Auto-confirm mode: set `"autoApprove": true` in operations.json, or
 * toggle at runtime via `/auto-confirm [on|off|status]`. When enabled,
 * all write/edit/bash operations are auto-approved — except those that
 * match an explicit `deny` rule, which are still blocked.
 *
 * In non-interactive (headless) mode, operations that require prompting
 * are blocked. Operations with "allow" or "deny" rules still apply.
 * Allowed bash commands pass through; unrecognized ones are blocked.
 *
 * Pattern matching is prefix-based with word boundaries:
 *   "rm"       → matches rm, rm -rf, rm file (but not rmdir)
 *   "rm *"     → same (trailing " *" is stripped)
 *   "git push" → matches git push origin main (but not git status)
 *
 * Compound commands (&&, ||, ;, |) are split via shell-quote and each
 * part is checked independently:
 *   ANY part denied  → whole command denied
 *   ANY part unknown → prompt for approval
 *   ALL parts allowed → auto-approve
 */

import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as shellParse } from "shell-quote";

// ── Config ──────────────────────────────────────────────────────────

type FilePermission = "allow" | "deny" | "ask";

interface BashRules {
	allow: string[];
	deny: string[];
}

interface Rules {
	write: FilePermission;
	edit: FilePermission;
	bash: BashRules;
	autoApprove: boolean;
}

const OPS_PATH = join(homedir(), ".pi", "agent", "operations.json");

function parseFilePermission(value: unknown): FilePermission {
	if (value === "allow" || value === "deny" || value === "ask") return value;
	return "ask";
}

function parseStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function loadRules(): Rules {
	const defaults: Rules = { write: "ask", edit: "ask", bash: { allow: [], deny: [] }, autoApprove: false };
	try {
		const raw = readFileSync(OPS_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		const bash = parsed.bash && typeof parsed.bash === "object" ? parsed.bash : {};
		return {
			write: parseFilePermission(parsed.write),
			edit: parseFilePermission(parsed.edit),
			bash: {
				allow: parseStringArray(bash.allow),
				deny: parseStringArray(bash.deny),
			},
			autoApprove: parsed.autoApprove === true,
		};
	} catch {
		return defaults;
	}
}

// ── Command parsing ─────────────────────────────────────────────────

/** Split a compound command into individual sub-commands using shell-quote. */
function extractSubCommands(command: string): string[] {
	const tokens = shellParse(command);
	const commands: string[][] = [[]];

	for (const token of tokens) {
		if (typeof token === "object" && token !== null && "op" in token) {
			if (commands[commands.length - 1].length > 0) {
				commands.push([]);
			}
		} else {
			const text = typeof token === "string"
				? token
				: "pattern" in token ? String(token.pattern) : String(token);
			commands[commands.length - 1].push(text);
		}
	}

	return commands
		.map((parts) => parts.join(" ").trim())
		.filter(Boolean);
}

// ── Pattern matching ────────────────────────────────────────────────

/** Check if a sub-command matches a prefix pattern (word-boundary aware). */
function matchesPrefix(subCommand: string, pattern: string): boolean {
	const prefix = pattern.replace(/\s+\*$/, "");
	return subCommand === prefix || subCommand.startsWith(prefix + " ");
}

/** Check if a sub-command is a pure variable assignment (e.g. PI_DIR="/some/path"). */
function isVariableAssignment(subCommand: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(subCommand);
}

function decideBash(command: string, rules: BashRules): FilePermission {
	const subs = extractSubCommands(command);
	if (subs.length === 0) return "allow";

	let allAllowed = true;

	for (const sub of subs) {
		if (rules.deny.some((p) => matchesPrefix(sub, p))) return "deny";
		// Variable assignments (NAME=value) are safe — they don't execute anything
		if (isVariableAssignment(sub)) continue;
		if (!rules.allow.some((p) => matchesPrefix(sub, p))) allAllowed = false;
	}

	return allAllowed ? "allow" : "ask";
}

// ── Gate ─────────────────────────────────────────────────────────────

type BlockResult = { block: true; reason: string };
const REJECTED = "User rejected this change. Stop and ask the user what they want instead.";
const SKIPPED = "User skipped this operation. Continue with the next step.";

async function gate(
	permission: FilePermission,
	label: string,
	ctx: ExtensionContext,
	enableAutoApprove: () => void,
): Promise<undefined | BlockResult> {
	if (permission === "allow") return undefined;
	if (permission === "deny") return { block: true, reason: `${label} denied by operations.json` };
	if (!ctx.hasUI) return { block: true, reason: `${label} blocked (no UI for confirmation)` };

	const APPROVE_ALL = "Approve & auto-confirm all from now on";
	const choice = await ctx.ui.select(label, [
		"Approve",
		APPROVE_ALL,
		"Skip",
		"Reject & ask me",
	]);
	if (choice === "Approve") return undefined;
	if (choice === APPROVE_ALL) {
		enableAutoApprove();
		return undefined;
	}
	if (choice === "Skip") return { block: true, reason: SKIPPED };
	// "Reject & ask me" or Escape — stop and ask the user
	ctx.abort();
	return { block: true, reason: REJECTED };
}

// ── Extension ───────────────────────────────────────────────────────

export default function confirmChanges(pi: ExtensionAPI) {
	const rules = loadRules();
	// Runtime override — toggled via /auto-confirm. Initial value seeded from
	// operations.json's `autoApprove` flag. When true, all write/edit/bash
	// operations are auto-approved (except those explicitly denied).
	let autoApprove = rules.autoApprove;

	type NotifyCtx = { ui: { notify: (message: string, type?: "warning" | "info" | "error") => void } };
	const setAutoApprove = (value: boolean, ctx?: NotifyCtx) => {
		autoApprove = value;
		ctx?.ui.notify(
			`Auto-confirm is ${autoApprove ? "ON — all edits/writes/bash auto-approved" : "OFF — confirmations enabled"}`,
			autoApprove ? "warning" : "info",
		);
	};

	pi.registerShortcut("ctrl+shift+y", {
		description: "Toggle auto-confirm (YOLO) mode for edits/writes/bash",
		handler: async (ctx) => {
			setAutoApprove(!autoApprove, ctx);
		},
	});

	pi.registerCommand("auto-confirm", {
		description: "Toggle auto-approve of all edits/writes/bash (YOLO mode)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "on", label: "on — auto-approve everything" },
				{ value: "off", label: "off — prompt for confirmation" },
				{ value: "status", label: "status — show current mode" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			let next = autoApprove;
			if (arg === "on" || arg === "true" || arg === "enable") next = true;
			else if (arg === "off" || arg === "false" || arg === "disable") next = false;
			else if (arg === "status") next = autoApprove;
			else next = !autoApprove;
			setAutoApprove(next, ctx);
		},
	});

	const enableFromMenu = () => setAutoApprove(true);

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("write", event)) {
			const perm = autoApprove && rules.write !== "deny" ? "allow" : rules.write;
			return gate(perm, `Write: ${event.input.path}`, ctx, enableFromMenu);
		}

		if (isToolCallEventType("edit", event)) {
			const perm = autoApprove && rules.edit !== "deny" ? "allow" : rules.edit;
			return gate(perm, `Edit: ${event.input.path}`, ctx, enableFromMenu);
		}

		if (isToolCallEventType("bash", event)) {
			const decided = decideBash(event.input.command, rules.bash);
			// Auto-approve never overrides an explicit deny
			const perm = autoApprove && decided !== "deny" ? "allow" : decided;
			return gate(perm, `Approve bash command?`, ctx, enableFromMenu);
		}

		return undefined;
	});
}

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
	const defaults: Rules = { write: "ask", edit: "ask", bash: { allow: [], deny: [] } };
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

function decideBash(command: string, rules: BashRules): FilePermission {
	const subs = extractSubCommands(command);
	if (subs.length === 0) return "allow";

	let allAllowed = true;

	for (const sub of subs) {
		if (rules.deny.some((p) => matchesPrefix(sub, p))) return "deny";
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
): Promise<undefined | BlockResult> {
	if (permission === "allow") return undefined;
	if (permission === "deny") return { block: true, reason: `${label} denied by operations.json` };
	if (!ctx.hasUI) return { block: true, reason: `${label} blocked (no UI for confirmation)` };

	const choice = await ctx.ui.select(label, ["Approve", "Reject", "Skip"]);
	if (choice === "Approve") return undefined;
	if (choice === "Reject") {
		ctx.abort();
		return { block: true, reason: REJECTED };
	}
	return { block: true, reason: SKIPPED };
}

// ── Extension ───────────────────────────────────────────────────────

export default function confirmChanges(pi: ExtensionAPI) {
	const rules = loadRules();

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("write", event)) {
			return gate(rules.write, `Write: ${event.input.path}`, ctx);
		}

		if (isToolCallEventType("edit", event)) {
			return gate(rules.edit, `Edit: ${event.input.path}`, ctx);
		}

		if (isToolCallEventType("bash", event)) {
			return gate(decideBash(event.input.command, rules.bash), `Bash: ${event.input.command}`, ctx);
		}

		return undefined;
	});
}

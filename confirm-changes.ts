/**
 * Confirm Changes Extension
 *
 * Intercepts file-modifying tool calls (write, edit) and bash commands.
 * Uses ~/.pi/agent/operations.json to decide which bash commands are
 * allowed, denied, or need approval. Write/edit always prompt.
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
	type ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as shellParse } from "shell-quote";

// ── Config ──────────────────────────────────────────────────────────

interface BashRules {
	allow: string[];
	deny: string[];
}

const OPS_PATH = join(homedir(), ".pi", "agent", "operations.json");

function loadRules(): BashRules {
	const defaults: BashRules = { allow: [], deny: [] };
	try {
		const raw = readFileSync(OPS_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		return { ...defaults, ...parsed.bash };
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

type Decision = "allow" | "deny" | "prompt";

function decideBash(command: string, rules: BashRules): Decision {
	const subs = extractSubCommands(command);
	if (subs.length === 0) return "allow";

	let allAllowed = true;

	for (const sub of subs) {
		if (rules.deny.some((p) => matchesPrefix(sub, p))) return "deny";
		if (!rules.allow.some((p) => matchesPrefix(sub, p))) allAllowed = false;
	}

	return allAllowed ? "allow" : "prompt";
}

// ── Prompt helpers ──────────────────────────────────────────────────

async function promptUser(ui: ExtensionUIContext, header: string): Promise<"approve" | "reject" | "skip"> {
	const choice = await ui.select(header, ["Approve", "Reject", "Skip"]);
	if (choice === "Approve") return "approve";
	if (choice === "Skip") return "skip";
	return "reject"; // Reject selected or Escape pressed
}

// ── Extension ───────────────────────────────────────────────────────

const REJECTED = "User rejected this change. Stop and ask the user what they want instead.";
const SKIPPED = "User skipped this operation. Continue with the next step.";

export default function confirmChanges(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return undefined;

		if (isToolCallEventType("write", event)) {
			const result = await promptUser(ctx.ui, `Write: ${event.input.path}`);
			if (result === "approve") return undefined;
			return { block: true, reason: result === "reject" ? REJECTED : SKIPPED };
		}

		if (isToolCallEventType("edit", event)) {
			const result = await promptUser(ctx.ui, `Edit: ${event.input.path}`);
			if (result === "approve") return undefined;
			return { block: true, reason: result === "reject" ? REJECTED : SKIPPED };
		}

		if (isToolCallEventType("bash", event)) {
			const rules = loadRules();
			const decision = decideBash(event.input.command, rules);

			if (decision === "allow") return undefined;
			if (decision === "deny") return { block: true, reason: "Command denied by operations.json" };

			const result = await promptUser(ctx.ui, `Bash: ${event.input.command}`);
			if (result === "approve") return undefined;
			return { block: true, reason: result === "reject" ? REJECTED : SKIPPED };
		}

		return undefined;
	});
}

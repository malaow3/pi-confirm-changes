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
 * In non-interactive (headless) mode, all operations are blocked.
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

function loadRules(): Rules {
	const defaults: Rules = { write: "ask", edit: "ask", bash: { allow: [], deny: [] } };
	try {
		const raw = readFileSync(OPS_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			write: parseFilePermission(parsed.write),
			edit: parseFilePermission(parsed.edit),
			bash: { ...defaults.bash, ...parsed.bash },
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

const NO_UI = "Operation blocked (no UI available for confirmation)";
const REJECTED = "User rejected this change. Stop and ask the user what they want instead.";
const SKIPPED = "User skipped this operation. Continue with the next step.";

export default function confirmChanges(pi: ExtensionAPI) {
	const rules = loadRules();

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) {
			return { block: true, reason: NO_UI };
		}

		if (isToolCallEventType("write", event)) {
			if (rules.write === "allow") return undefined;
			if (rules.write === "deny") return { block: true, reason: "Write operations denied by operations.json" };
			const result = await promptUser(ctx.ui, `Write: ${event.input.path}`);
			if (result === "approve") return undefined;
			return { block: true, reason: result === "reject" ? REJECTED : SKIPPED };
		}

		if (isToolCallEventType("edit", event)) {
			if (rules.edit === "allow") return undefined;
			if (rules.edit === "deny") return { block: true, reason: "Edit operations denied by operations.json" };
			const result = await promptUser(ctx.ui, `Edit: ${event.input.path}`);
			if (result === "approve") return undefined;
			return { block: true, reason: result === "reject" ? REJECTED : SKIPPED };
		}

		if (isToolCallEventType("bash", event)) {
			const decision = decideBash(event.input.command, rules.bash);

			if (decision === "allow") return undefined;
			if (decision === "deny") return { block: true, reason: "Command denied by operations.json" };

			const result = await promptUser(ctx.ui, `Bash: ${event.input.command}`);
			if (result === "approve") return undefined;
			return { block: true, reason: result === "reject" ? REJECTED : SKIPPED };
		}

		return undefined;
	});
}

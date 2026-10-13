import { Notice } from "obsidian";
import type { IndexProgress } from "./note-index";

export type StatusTone = "error" | "warning" | "success" | "info" | "muted";

/** Semantic roles use the active Obsidian theme's colors. */
export function setStatusTone(element: HTMLElement | undefined, tone: StatusTone): void {
	if (!element) return;
	element.addClass("ai-helper-status");
	element.setAttribute("data-tone", tone);
}

export function indexStatusTone(progress: IndexProgress): StatusTone {
	if (progress.state === "error") return "error";
	if (progress.error || progress.state === "partial" || progress.state === "paused") return "warning";
	return progress.state === "complete" ? "success" : "info";
}

export function showStatusNotice(message: string, tone: StatusTone): Notice {
	const notice = new Notice(message);
	setStatusTone(notice.messageEl, tone);
	return notice;
}

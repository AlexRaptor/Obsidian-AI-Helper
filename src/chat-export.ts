import type { Role } from "./conversation";
import type { LocaleKey } from "./i18n";
import type { NoteSnapshot } from "./note-attachments";

/** Only visible conversation data; no protocol messages or hidden fragment validation base. */
export interface ChatExportMessage {
	role: Role;
	content: string;
	error?: string;
	stopped?: boolean;
	attachments?: { title: string; path: string; markdown?: string }[];
}

export function exportChat(messages: readonly ChatExportMessage[], includeAttachments: boolean, t: (key: LocaleKey) => string): string {
	return messages.map(message => {
		const parts = [`## ${t(message.role === "user" ? "export-user" : "export-model")}`, message.content];
		for (const attachment of message.attachments ?? []) {
			parts.push(`${t("export-attachment")}: [[${attachment.path}|${attachment.title}]]`);
			if (includeAttachments && attachment.markdown !== undefined) parts.push(attachment.markdown);
		}
		if (message.stopped) parts.push(`*${t("export-incomplete")}*`);
		if (message.error) parts.push(`${t("chat-error-prefix")}: ${message.error}`);
		return parts.join("\n\n");
	}).join("\n\n") + "\n";
}

export function exportAttachments(snapshots: readonly NoteSnapshot[]): NonNullable<ChatExportMessage["attachments"]> {
	return snapshots.map(snapshot => ({ title: snapshot.title, path: snapshot.path, markdown: snapshot.markdown }));
}

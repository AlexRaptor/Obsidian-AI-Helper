import type { ChatMessage } from "./server-client";
import type { NoteSnapshot } from "./note-attachments";
export type Role = "user" | "model";

export interface Message {
	role: Role;
	content: string;
	snapshots?: NoteSnapshot[];
	toolMessages?: ChatMessage[];
}

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export class Conversation {
	private messages: Array<{ message: Message; turn: number }> = [];
	private nextTurn = 0;
	private tokensUsed: number | undefined = 0;

	reserveTurn(): number { return this.nextTurn++; }

	addMessage(message: Message, turn = this.reserveTurn()): void {
		// An atomic write can settle after a later turn has already completed.
		const index = this.messages.findIndex(entry => entry.turn > turn);
		this.messages.splice(index < 0 ? this.messages.length : index, 0, { message, turn });
	}

	recordUsage(usage?: TokenUsage): void {
		this.tokensUsed = usage?.totalTokens;
	}

	getMessages(): Message[] {
		return this.messages.map(entry => entry.message);
	}

	getTokensUsed(): number | undefined {
		return this.tokensUsed;
	}

	clear(): void {
		this.messages = [];
		this.nextTurn = 0;
		this.tokensUsed = 0;
	}
}

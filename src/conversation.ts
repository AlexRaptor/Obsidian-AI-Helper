export type Role = "user" | "model";

export interface Message {
	role: Role;
	content: string;
}

export class Conversation {
	private messages: Message[] = [];

	addMessage(message: Message): void {
		this.messages.push(message);
	}

	getMessages(): Message[] {
		return [...this.messages];
	}

	clear(): void {
		this.messages = [];
	}
}

export type Role = "user" | "model";

export interface Message {
	role: Role;
	content: string;
}

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

export class Conversation {
	private messages: Message[] = [];
	private tokensUsed: number | undefined = 0;

	addMessage(message: Message): void {
		this.messages.push(message);
	}

	recordUsage(usage?: TokenUsage): void {
		this.tokensUsed = usage?.totalTokens;
	}

	getMessages(): Message[] {
		return [...this.messages];
	}

	getTokensUsed(): number | undefined {
		return this.tokensUsed;
	}

	clear(): void {
		this.messages = [];
		this.tokensUsed = 0;
	}
}

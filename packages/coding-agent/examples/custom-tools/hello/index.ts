import type { CustomToolFactory } from "@yemu/agent-runtime";

const factory: CustomToolFactory = yemu => ({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: yemu.zod.object({
		name: yemu.zod.string().describe("Name to greet"),
	}),

	async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
		const { name } = params;
		return {
			content: [{ type: "text", text: `Hello, ${name}!` }],
			details: { greeted: name },
		};
	},
});

export default factory;

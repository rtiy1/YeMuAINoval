import type { ExtensionFactory } from "@yemu/agent-runtime";
import { Container, Text } from "@yemu/tui";

const extension: ExtensionFactory = yemu => {
	yemu.setLabel("Thinking note");
	yemu.registerAssistantThinkingRenderer((context, theme) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("dim", `thinking chars: ${context.text.length}`), 1, 0));
		return container;
	});
};

export default extension;

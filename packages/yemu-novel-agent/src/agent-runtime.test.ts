import { expect, test } from "bun:test";
import { listStorySkills, runStoryAgent } from "./agent-runtime";

test("web agent runtime discovers Story Skills and validates model credentials", async () => {
	const previousOpenAIKey = Bun.env.OPENAI_API_KEY;
	const previousAnthropicKey = Bun.env.ANTHROPIC_API_KEY;
	Bun.env.OPENAI_API_KEY = "";
	Bun.env.ANTHROPIC_API_KEY = "";
	try {
		const skills = await listStorySkills();
		expect(skills.length).toBeGreaterThanOrEqual(10);
		expect(skills.every(skill => skill.executor === "yemu-agent-runtime")).toBe(true);
		await expect(
			runStoryAgent({
				message: "写一个短篇",
				skill: "story-short-write",
				model_config: { provider: "openai", api_key: "" },
			}),
		).rejects.toThrow("API Key");
	} finally {
		if (previousOpenAIKey === undefined) delete Bun.env.OPENAI_API_KEY;
		else Bun.env.OPENAI_API_KEY = previousOpenAIKey;
		if (previousAnthropicKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
		else Bun.env.ANTHROPIC_API_KEY = previousAnthropicKey;
	}
});

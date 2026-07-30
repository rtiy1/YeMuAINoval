import {
	AnthropicOAuthFlow as RootAnthropicOAuthFlow,
	loginAnthropic as rootLoginAnthropic,
	refreshAnthropicToken as rootRefreshAnthropicToken,
} from "@yemu/model-runtime";
import {
	AnthropicOAuthFlow as OAuthAnthropicOAuthFlow,
	loginAnthropic as oauthLoginAnthropic,
	refreshAnthropicToken as oauthRefreshAnthropicToken,
} from "@yemu/model-runtime/registry/oauth";
import "@yemu/model-runtime/providers/anthropic";
import "@yemu/model-runtime/auth-storage";

const publicExports = [
	RootAnthropicOAuthFlow,
	rootLoginAnthropic,
	rootRefreshAnthropicToken,
	OAuthAnthropicOAuthFlow,
	oauthLoginAnthropic,
	oauthRefreshAnthropicToken,
];

if (publicExports.some(value => !value)) {
	throw new Error("Anthropic OAuth exports are unavailable");
}

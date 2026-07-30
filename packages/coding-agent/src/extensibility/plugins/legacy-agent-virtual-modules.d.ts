declare module "yemu-legacy-agent-modules" {
	/** Lazy host package namespace loaders retained for compiled legacy extensions. */
	export const BUNDLED_YEMU_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}

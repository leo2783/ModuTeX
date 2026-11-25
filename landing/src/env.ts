import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	PUBLIC_MODUTEX_SITE_ORIGIN: {
		public: true,
		static: true,
		schema: value => value
	}
});

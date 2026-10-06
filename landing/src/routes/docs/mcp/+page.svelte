<script lang="ts">
	import DocsHead from '$lib/docs/DocsHead.svelte';
	import Section from '$lib/docs/Section.svelte';
	import Figure from '$lib/docs/Figure.svelte';
	import Bullets from '$lib/docs/Bullets.svelte';
	import Note from '$lib/docs/Note.svelte';
	import Where from '$lib/docs/Where.svelte';
	import mcpModalShot from '$lib/assets/showcase/app/mcp-modal.png';

	const where = [
		{
			label: 'Setting',
			value: 'Preferences › MCP server',
			note: 'Preferences opens from the start screen, and from File › Preferences… once a folder is open.'
		}
	];

	// one line per tool the MCP server registers (electron/src/mcp/server.ts)
	const tools = [
		'get_editor_state — read open workspaces, tabs, active file, view, caret, and selection.',
		'get_unsaved — read unsaved editor content.',
		'get_diagnostics — read compile errors, warnings, and run state.',
		'open_file — open a workspace-relative file, optionally at a source line.',
		'show_diff — show a workspace file diff when the folder is a Git repository.',
		'set_view_mode — switch between visual, source, and diff views.',
		'synctex_to_line — show a source line in the PDF or Typst preview.',
		'set_main_file — choose the workspace .tex or .typ file to compile.',
		'compile — run the configured compile action.',
		'get_compile_config — read the compile command, format, engine, resolved output paths, and command permission.',
		'set_output_paths — change the compile output directory and PDF/log paths.',
		'set_compile_command — change the shell compile command only when separately enabled in Preferences; this permission is off by default.'
	];
</script>

<DocsHead
	title={'AI assistants (MCP)'}
	description={'Texpile exposes a local MCP server so Claude Code, Codex, and other assistants can read your editor state and compile errors and drive the editor.'}
	path="/docs/mcp"
/>

<header>
	<h1 class="text-surface-900 text-3xl font-bold md:text-4xl">{'AI assistants (MCP)'}</h1>
	<p class="text-surface-600 mt-4 text-lg leading-relaxed">
		{'Texpile exposes a local MCP server, so an AI assistant can see what you are working on and drive the editor. It stays off until you turn it on in Preferences.'}
	</p>
</header>

<div class="mt-6"><Where rows={where} /></div>

<p class="text-surface-600 mt-5 text-sm leading-relaxed">
	{'Verified with a running Electron MCP session: initialize identifies modutex version 1, tools/list returns these 12 tools, and get_editor_state and get_compile_config return live editor and compile configuration data.'}
</p>

<Figure
	src={mcpModalShot}
	alt={'The Connect an assistant dialog, with setup commands for Claude Code and Codex'}
	caption={'The Connect an assistant dialog, with setup commands for Claude Code and Codex'}
	narrow
/>

<div class="mt-10 space-y-10">
	<Section
		title={'Setting it up'}
		body={"Preferences shows the server's address along with a ready-made command for Claude Code and a config entry for Codex. They are not interchangeable, so copy the one for your client. Preferences fills in the real port for you."}
	>
		<div class="space-y-4">
			<div>
				<p class="text-surface-700 mb-2 text-sm font-medium">{'Claude Code'}</p>
				<pre class="border-surface-200 bg-surface-50 text-surface-800 overflow-x-auto rounded-lg border p-4 font-mono text-sm"><code
						>claude mcp add --transport http modutex http://127.0.0.1:PORT</code
					></pre>
			</div>
			<div>
				<p class="text-surface-700 mb-2 text-sm font-medium">{'Codex, in its config file'}</p>
				<pre class="border-surface-200 bg-surface-50 text-surface-800 overflow-x-auto rounded-lg border p-4 font-mono text-sm"><code
						>[mcp_servers.modutex]{'\n'}url = "http://127.0.0.1:PORT"</code
					></pre>
			</div>
		</div>
	</Section>

	<Section
		title={'What an assistant can do'}
		body={'The server offers a small, deliberate set of actions rather than general access to your disk.'}
	>
		<Bullets items={tools} />
		<div class="mt-4">
			<Note
				body={'These tools do not write to or edit .tex document contents. Some actions change the visible editor state or project compile settings. Setting a shell compile command requires separate user permission and is off by default. To edit .tex documents, an assistant should use its own file-editing tools.'}
			/>
		</div>
	</Section>

	<Section
		title={'During a shared session'}
		body={"The server is local to whichever machine is running Texpile, so it only ever shows what is open in that machine's own window. In a real-time collaboration session, that means only the host can connect an assistant to it; guests do not get one of their own."}
	/>

	<Section
		title={'Local only'}
		body={'The server listens on 127.0.0.1 and is reachable only from your own machine. Texpile itself sends nothing anywhere.'}
	>
		<Note
			body={'What your assistant does with what it reads is between you and your assistant. If it is a cloud model, your document content reaches that provider the same way it would if you pasted it in.'}
		/>
	</Section>
</div>

<script lang="ts">
	export let data;
</script>

<svelte:head>
	<title>RiverHacks | Verify Email</title>
</svelte:head>

<div class="topographic-background">
	<div class="top-margin">
		{#if data.success}
			<p>Your email has been successfully verified!</p>
			<h1 class="top-margin">Hackers, Volunteers Judges</h1>

			<button class="finish-your-app">
				<a href="/apply">Click here to finish your application</a>
			</button>
		{:else}
			<p>The link you specified is not valid or expired.</p>
		{/if}
	</div>
</div>

<style>
	.topographic-background {
		display: flex;
		flex-direction: column;
		align-items: center;
		background-color: #303030;
		text-align: center;
		/* background-image: url('/Topographic Background.svg'); */
		background-size: 110%;
		min-height: calc(100vh - 159px);
	}

	.top-margin {
		width: 100%;

		color: var(--highlight-color);
		margin-top: 4rem;
	}

	@media (max-width: 768px) {
		.topographic-background {
			min-height: calc(100vh - 56px);
		}
	}

	.finish-your-app {
		background-color: var(--highlight-color);
		color: var(--background-color);
		padding: 0.5rem 2rem;
		font-size: 1.25rem;
		font-weight: bold;
		vertical-align: middle;
		text-transform: uppercase;
		/* border: 2px solid var(--primary-accent); */
		border-radius: 0.5rem;
		cursor: pointer;
		transition: background-color 0.3s ease;
	}
	.finish-your-app:hover {
		background-color: var(--secondary-color);
	}
	.finish-your-app a {
		color: var(--primary-accent);
		text-decoration: none;
	}
	.finish-your-app:hover a {
		color: var(--background-color);
	}

	a {
		color: var(--highlight-color);
		text-decoration: none;
		font-family: 'sofachrome', sans-serif;
		font-weight: 500;
		font-style: italic;
	}
</style>

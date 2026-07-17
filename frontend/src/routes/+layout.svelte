<script lang="ts">
  import '../app.css';
  import '../app.css';
  import { page } from '$app/stores';
  import { beforeNavigate, afterNavigate } from '$app/navigation';
  import { siteConfig } from '$lib/config/site';
  import BackToTop from '$lib/components/BackToTop.svelte';
  import NavBar from '$lib/components/NavBar.svelte';
  import Analytics from '$lib/components/Analytics.svelte';
  import CookieConsent from '$lib/components/CookieConsent.svelte';
  import ShortLinkRedirect from '$lib/components/ShortLinkRedirect.svelte';
  import DashLoader from '$lib/components/DashLoader.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import Footer from '$lib/components/Footer.svelte';
  import PageViews from '$lib/components/PageViews.svelte';

  let { children } = $props();

  // 文章详情页自己输出 og:image / twitter:image / og:title 等，避免重复
  let isPostDetail = $derived(/^\/posts\/[^/]+\/?$/.test($page.url.pathname));
  let isHomePage = $derived($page.route.id === '/');

  let navigating = $state(false);
  let barWidth = $state(0);
  let rafId = $state(0);

  beforeNavigate(() => {
    navigating = true;
    barWidth = 0;
    cancelAnimationFrame(rafId);
    const start = performance.now();
    function tick() {
      const elapsed = performance.now() - start;
      const pct = 1 - Math.pow(1 - Math.min(elapsed / 2000, 1), 3);
      barWidth = Math.min(pct * 100, 99);
      if (navigating) rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  });
  afterNavigate(() => {
    cancelAnimationFrame(rafId);
    const start = performance.now();
    const fromWidth = barWidth;
    function tick() {
      const elapsed = performance.now() - start;
      const p = Math.min(elapsed / 300, 1);
      const t = 1 - Math.pow(1 - p, 3);
      barWidth = fromWidth + (100 - fromWidth) * t;
      if (t < 1) rafId = requestAnimationFrame(tick);
      else setTimeout(() => { navigating = false; barWidth = 0; }, 150);
    }
    rafId = requestAnimationFrame(tick);
  });

  // popstate 时 SvelteKit Router 只处理 state.the==='yes'，其余情况手动 reload
  $effect(() => {
    const handler = (e: PopStateEvent) => {
      if (e.state?.the !== 'yes') location.reload();
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  });
</script>

<svelte:head>
  <title>{siteConfig.title}</title>
  <link rel="icon" href={siteConfig.icon} />
  <meta name="description" content={siteConfig.description} />
  <meta name="keywords" content={siteConfig.keywords.join(', ')} />
  <meta property="og:site_name" content={siteConfig.title} />
  <meta property="og:locale" content={siteConfig.lang} />
  {#if !isPostDetail}
    <meta property="og:type" content="website" />
    <meta property="og:url" content={siteConfig.url} />
    <meta property="og:title" content={siteConfig.title} />
    <meta property="og:description" content={siteConfig.description} />
    <meta property="og:image" content="{siteConfig.url}{siteConfig.ogImage}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content={siteConfig.title} />
    <meta name="twitter:description" content={siteConfig.description} />
    <meta name="twitter:image" content="{siteConfig.url}{siteConfig.ogImage}" />
  {/if}
  <link rel="canonical" href="{siteConfig.url}{$page.url.pathname}" />

  <!-- RSS Feed -->
  <link rel="alternate" type="application/rss+xml" title="{siteConfig.title} RSS Feed" href="/rss.xml" />
</svelte:head>

<NavBar />

<div
  class="fixed top-0 left-0 z-50 h-0.5 bg-primary transition-opacity duration-200"
  class:opacity-0={!navigating}
  class:opacity-100={navigating}
  style="width: {barWidth}%;"
/>

<style>
</style>

<div>
  {@render children()}
</div>

{#if !$page.url.pathname.startsWith('/posts/')}
  <div class="text-center py-4">
    <PageViews pathname={$page.url.pathname} class="text-xs text-muted-foreground" />
  </div>
{/if}

<Footer />

<BackToTop />

<Analytics />

<CookieConsent />

<ShortLinkRedirect />

<DashLoader />

<Toast />

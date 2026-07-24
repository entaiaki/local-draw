import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: path.resolve('./src/lib'),
    },
  },
  server: {
    watch: {
      // 后端运行时写入 web/ 的文件，不应触发前端 reload
      ignored: [
        '**/creator_users.txt',
        '**/queue_state.json',
        '**/prompt_meta.json',
        '**/state.json',
        '**/recommendations.json',
        '**/deleted_images.json',
        '**/announcement.json',
        '**/banned_users.txt',
        '**/collaborators.json',
        '**/limits.json',
        '**/uploads/**',
        '**/thumbnails/**',
      ],
    },
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
      },
    },
  },
});

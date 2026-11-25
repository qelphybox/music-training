<script setup lang="ts">
/**
 * The vocal pages' icons: one stroke family, 24-unit grid, drawn here rather than borrowed glyphs.
 * Decorative by default; pass `label` when the icon is the only thing that names a control.
 */
const props = defineProps<{ name: keyof typeof PATHS; label?: string }>()
</script>

<script lang="ts">
export const PATHS = {
  play: '',
  pause: '',
  start: 'M6 5v14M18 5l-9 7 9 7z',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  check: 'M5 12l5 5 9-10',
  next: 'm9 6 6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  chevronDown: 'm6 9 6 6 6-6',
  up: 'm6 15 6-6 6 6',
  down: 'm6 9 6 6 6-6',
  octaveUp: 'm6 13 6-6 6 6M6 19l6-6 6 6',
  octaveDown: 'm6 5 6 6 6-6M6 11l6 6 6-6',
  earlier: 'M19 12H5M11 6l-6 6 6 6',
  later: 'M5 12h14M13 6l6 6-6 6',
  higher: 'M12 19V5M6 11l6-6 6 6',
  lower: 'M12 5v14M6 13l6 6 6-6',
  cut: 'M8.5 8.5 20 18M8.5 15.5 20 6M9 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  join: 'M3 12h6M15 12h6M6 8l4 4-4 4M18 8l-4 4 4 4',
  ornament: 'M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z',
  loop: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  sliders:
    'M4 7h9M17 7h3M4 17h3M11 17h9M17 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0M11 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  mic: 'M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  copy: 'M8 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2zM16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  fit: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4',
  zoomIn: 'M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0M8.5 11h5M11 8.5v5M20 20l-4.5-4.5',
  zoomOut: 'M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0M8.5 11h5M20 20l-4.5-4.5',
  close: 'M6 6l12 12M18 6 6 18',
  headphones:
    'M4 15v-3a8 8 0 0 1 16 0v3M3 16a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 16a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2z',
  retry: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5',
  voice: 'M3 12c2-4 3-4 5 0s3 4 5 0 3-4 5 0 2 2 3 0',
} as const
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    :role="props.label ? 'img' : undefined"
    :aria-label="props.label"
    :aria-hidden="props.label ? undefined : 'true'"
  >
    <path v-if="name === 'play'" d="M8 5v14l11-7z" fill="currentColor" stroke="none" />
    <path
      v-else-if="name === 'pause'"
      d="M7 5h4v14H7zM13 5h4v14h-4z"
      fill="currentColor"
      stroke="none"
    />
    <path v-else :d="PATHS[name]" />
  </svg>
</template>

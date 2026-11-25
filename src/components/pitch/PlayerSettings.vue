<script setup lang="ts">
import { computed } from 'vue'
import type { useVocalPlayback } from '@/composables/useVocalPlayback'
import type { Grid } from '@/training/vocal/edit'

/**
 * How the part plays: speed with the pitch kept, volume, a bar of count-in, the metronome on the
 * part's grid, and the stretch on repeat. Straight onto the player's settings; the teacher's
 * pop-over and the student's sheet show the same block.
 */
const props = defineProps<{
  player: ReturnType<typeof useVocalPlayback>
  grid?: Grid | null
  disabled?: boolean
  /** Where the stretch to repeat is marked, said under its switch. */
  loopHint: string
}>()

const settings = props.player.settings
const bpm = computed(() => (props.grid ? Math.round(props.grid.bpm * settings.rate) : null))
function clearLoop(): void {
  settings.looping = false
  settings.loop = null
}
</script>

<template>
  <div class="ps">
    <label class="knob">
      <span
        >Темп <b class="num">{{ Math.round(settings.rate * 100) }}%</b>
        <span class="muted ps__aside"
          ><template v-if="bpm">· {{ bpm }} BPM, </template>высота та же</span
        ></span
      >
      <input
        v-model.number="settings.rate"
        type="range"
        min="0.5"
        max="1.5"
        step="0.05"
        :disabled="disabled"
      />
    </label>
    <label class="knob">
      <span
        >Громкость <b class="num">{{ Math.round(settings.volume * 100) }}%</b></span
      >
      <input v-model.number="settings.volume" type="range" min="0" max="1" step="0.05" />
    </label>
    <div class="ps__rows">
      <label class="switch">
        <span class="ps__grow">Отсчёт перед началом<span class="sub">такт щелчков</span></span>
        <input v-model="settings.countIn" type="checkbox" role="switch" :disabled="disabled" />
      </label>
      <label class="switch">
        <span class="ps__grow"
          >Метроном<span v-if="!grid" class="sub">у партии нет сетки</span></span
        >
        <input
          v-model="settings.metronome"
          type="checkbox"
          role="switch"
          :disabled="disabled || !grid"
        />
      </label>
      <div class="ps__loop">
        <label class="switch ps__grow">
          <span class="ps__grow"
            >Повтор куска<span class="sub">{{ loopHint }}</span></span
          >
          <input
            v-model="settings.looping"
            type="checkbox"
            role="switch"
            :disabled="disabled || !settings.loop"
          />
        </label>
        <button v-if="settings.loop" type="button" class="btn quiet small" @click="clearLoop">
          Убрать
        </button>
      </div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.ps {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ps__aside {
  font-size: 14px;
}
.ps__rows > * + * {
  border-top: 1px solid var(--line-soft, #e3ddd1);
}
.ps__grow {
  flex: 1;
}
.ps__loop {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>

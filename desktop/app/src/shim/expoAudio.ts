/** expo-audio shim — see expoFileSystem.ts for the policy. */
export interface AudioStatus {
  playing: boolean
  duration: number
  currentTime: number
}

export interface AudioPlayer {
  play(): void
  pause(): void
  remove(): void
  seekTo(seconds: number): void
  addListener(_event: string, _cb: (s: AudioStatus) => void): { remove(): void }
}

export function createAudioPlayer(): AudioPlayer {
  throw new Error('expo-audio is not available on desktop — use the desktop audio path')
}

export function setAudioModeAsync(): Promise<void> {
  return Promise.resolve()
}

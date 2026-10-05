import { atom } from 'nanostores'
import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import { createAudioPlayer, type AudioPlayer } from 'expo-audio'
import { apiFetch } from './http'
import { log } from './log'

export const ttsPlaying = atom(false)
export const voiceBusy = atom<null | 'transcribing' | 'synthesizing'>(null)

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 // server caps at 25MB; stay under
const MAX_TTS_CHARS = 3000

export function mimeForUri(uri: string): string {
  const ext = uri.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'm4a': return 'audio/m4a'
    case 'mp4': return 'audio/mp4'
    case 'wav': return 'audio/wav'
    case 'webm': return 'audio/webm'
    case 'ogg':
    case 'opus': return 'audio/ogg'
    case 'mp3': return 'audio/mpeg'
    case 'aac': return 'audio/aac'
    case '3gp':
    case '3gpp': return 'audio/3gpp'
    case 'flac': return 'audio/flac'
    default: return 'audio/m4a' // expo-audio HIGH_QUALITY records .m4a
  }
}

function extForMime(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase()
  if (m === 'audio/mpeg') return 'mp3'
  if (m === 'audio/ogg') return 'ogg'
  if (m === 'audio/wav' || m === 'audio/wave') return 'wav'
  if (m === 'audio/flac') return 'flac'
  if (m === 'audio/mp4') return 'mp4'
  return 'm4a'
}

export interface Transcription {
  transcript: string
  provider?: string
}

/** Record → server STT (whatever the gateway runs: Deepgram, Whisper, …) → text. */
export async function transcribeRecording(uri: string): Promise<Transcription> {
  voiceBusy.set('transcribing')
  try {
    const info = await FileSystem.getInfoAsync(uri)
    if (!info.exists) throw new Error('Recording file missing')
    if (typeof info.size === 'number' && info.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Recording too large (${Math.round(info.size / 1048576)}MB, max 20MB) — try a shorter clip.`)
    }
    if (typeof info.size === 'number' && info.size < 1000) {
      throw new Error('Recording too short — hold mic and speak.')
    }
    const mime = mimeForUri(uri)
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' })
    const dataUrl = `data:${mime};base64,${b64}`
    // Desktop budgets ~0.1ms/char with a 180s floor and 600s cap.
    const timeoutMs = Math.min(600_000, Math.max(180_000, Math.ceil(dataUrl.length * 0.1)))
    const res = await apiFetch<{ ok?: boolean; transcript?: string; provider?: string }>(
      '/api/audio/transcribe',
      { method: 'POST', body: { data_url: dataUrl, mime_type: mime }, timeoutMs },
    ).catch((err: unknown) => {
      // Command-type providers (e.g. Deepgram-as-command) 400 on silence with
      // provider-specific wording instead of the server's empty-transcript path.
      const msg = err instanceof Error ? err.message : String(err)
      if (/no output|empty|no speech|silence|blank/i.test(msg)) {
        throw new Error('No speech detected — try again, closer to the mic.')
      }
      throw err
    })
    const transcript = (res.transcript ?? '').trim()
    if (!transcript) throw new Error('No speech detected — try again, closer to the mic.')
    log('info', 'voice', `transcribed via ${res.provider ?? 'gateway'} (${transcript.length} chars)`)
    return { transcript, provider: res.provider }
  } finally {
    voiceBusy.set(null)
  }
}

export interface TtsAudio {
  uri: string
  mime: string
  provider?: string
}

/** Text → server TTS (gateway provider chain) → local audio file. */
export async function speakToFile(rawText: string): Promise<TtsAudio> {
  const text = rawText.trim().slice(0, MAX_TTS_CHARS)
  if (!text) throw new Error('Nothing to speak')
  voiceBusy.set('synthesizing')
  try {
    // Desktop budgets ~35ms/char with a 180s floor and 600s cap.
    const timeoutMs = Math.min(600_000, Math.max(180_000, Math.ceil(text.length * 35)))
    const res = await apiFetch<{ ok?: boolean; data_url?: string; mime_type?: string; provider?: string }>(
      '/api/audio/speak',
      { method: 'POST', body: { text }, timeoutMs },
    )
    if (!res.data_url || !res.data_url.includes(',')) throw new Error('Bad TTS response')
    const b64 = res.data_url.split(',', 2)[1]
    const mime = res.mime_type ?? 'audio/mpeg'
    const name = `hermes-tts-${Date.now()}.${extForMime(mime)}`
    const dest = `${FileSystem.cacheDirectory}${name}`
    await FileSystem.writeAsStringAsync(dest, b64, { encoding: 'base64' })
    log('info', 'voice', `synthesized via ${res.provider ?? 'gateway'} (${text.length} chars)`)
    return { uri: dest, mime, provider: res.provider }
  } finally {
    voiceBusy.set(null)
  }
}

// --- shared playback (one voice at a time) ---

let player: AudioPlayer | null = null

export async function playUri(uri: string): Promise<void> {
  stopTts()
  player = createAudioPlayer({ uri })
  ttsPlaying.set(true)
  player.play()
}

export function stopTts() {
  try { player?.pause() } catch {}
  try { player?.remove() } catch {}
  player = null
  if (ttsPlaying.get()) ttsPlaying.set(false)
}

/** Speak text through the gateway voice and play it. Throws on failure (caller falls back). */
export async function speakText(text: string): Promise<void> {
  const audio = await speakToFile(text)
  // iOS AVPlayer can't decode ogg/opus/webm (e.g. Deepgram's native voice
  // delivery) — fail fast so the caller falls back to on-device speech.
  if (Platform.OS === 'ios' && /ogg|opus|webm/.test(audio.mime)) {
    throw new Error('Server voice format is not playable on iOS')
  }
  await playUri(audio.uri)
}

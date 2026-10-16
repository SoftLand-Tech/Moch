/**
 * Voice: mic STT through the gateway (keys never live in the app), the
 * desktop twin of the phone's voice.ts — MediaRecorder in the webview,
 * transcribe via POST /api/audio/transcribe, drop the transcript into the
 * composer for review (never auto-sent).
 */

import { gatewayInfo } from './gateway'

export interface VoiceState {
  recording: boolean
  level: number // 0..1 (mic meter)
  error: string | null
}

let mediaRecorder: MediaRecorder | null = null
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let rafId = 0
let stream: MediaStream | null = null

export async function startRecording(
  onState: (s: VoiceState) => void,
): Promise<void> {
  if (mediaRecorder) return
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    onState({ recording: false, level: 0, error: `microphone unavailable: ${String(err)}` })
    return
  }
  const chunks: Blob[] = []
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.onstop = async () => {
    cleanupMeter()
    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
    mediaRecorder = null
    onState({ recording: false, level: 0, error: null })
    if (blob.size === 0) return
    try {
      const text = await transcribe(blob)
      if (text) onState({ recording: false, level: 0, error: null, transcript: text } as VoiceState & { transcript: string })
    } catch (err) {
      onState({ recording: false, level: 0, error: `transcription failed: ${String(err)}` })
    }
  }

  // Mic meter
  try {
    audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      if (!analyser) return
      analyser.getByteFrequencyData(data)
      const avg = data.reduce((a, b) => a + b, 0) / data.length / 255
      onState({ recording: true, level: avg, error: null })
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
  } catch {
    onState({ recording: true, level: 0, error: null })
  }

  mediaRecorder.start()
}

export function stopRecording(): void {
  try {
    mediaRecorder?.stop()
  } catch {
    /* already stopped */
  }
}

function cleanupMeter(): void {
  cancelAnimationFrame(rafId)
  try { stream?.getTracks().forEach((t) => t.stop()) } catch { /* ok */ }
  stream = null
  void audioCtx?.close().catch(() => undefined)
  audioCtx = null
  analyser = null
}

async function transcribe(blob: Blob): Promise<string> {
  const info = gatewayInfo.get()
  if (!info?.port || !info.token) throw new Error('gateway not connected')
  const form = new FormData()
  form.append('file', blob, 'speech.webm')
  form.append('model', 'whisper-1')
  const res = await fetch(`http://127.0.0.1:${info.port}/api/audio/transcribe`, {
    method: 'POST',
    headers: { 'X-Hermes-Session-Token': info.token },
    body: form,
  })
  if (!res.ok) throw new Error(`stt ${res.status}`)
  const payload = (await res.json()) as { text?: string }
  return (payload.text ?? '').trim()
}

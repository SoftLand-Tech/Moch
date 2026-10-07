import React, { useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Modal } from 'react-native'
import { router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Icon } from './Icon'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { connect, normalizeHost } from '../lib/gateway'
import { getEmbeddedGateway } from '../lib/hermesRuntime'
import { parseConnectUrl } from '../lib/pairing'
import { ensureNotificationPermission } from '../lib/push'
import { C, useStyles } from '../lib/theme'

/**
 * Pairing UI, shared by onboarding (app/index) and "Add computer"
 * (app/add-computer). The QR scan is the whole flow for almost everyone —
 * hermes-pair.sh bakes host + token + TLS into it — so everything else
 * (paste a link, type host/token by hand) stays folded under "More options".
 */
export function PairForm({ onPaired }: { onPaired: () => void }) {
  const s = useStyles(makeS)
  const [host, setHost] = useState('')
  const [token, setToken] = useState('')
  const [tls, setTls] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [pairingCode, setPairingCode] = useState('')
  const [permission, requestPermission] = useCameraPermissions()
  const scanned = useRef(false)

  const doConnect = async (override?: { host: string; token: string; tls: boolean; name?: string }) => {
    const h = (override?.host ?? host).trim()
    const t = (override?.token ?? token).trim()
    const useTls = override?.tls ?? tls
    if (!h || !t) {
      setError('Enter the server address and token — or scan the QR from your PC.')
      return
    }
    try { normalizeHost(h) } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid server address.')
      return
    }
    // BUG-069: soft shape check on the probe token (hermes probe keys are
    // base64 of exactly 16 bytes → 24 chars). A short token surfaces as an
    // opaque connect error otherwise. Non-blocking: the server stays
    // authoritative.
    if (t.length < 16) {
      setError('That token looks too short — pairing tokens are usually longer. Check it and try again.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await connect({ host: h, token: t, tls: useTls, name: override?.name })
      onPaired()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check host and token')
    } finally {
      setBusy(false)
    }
  }

  const useThisPhone = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const gw = await getEmbeddedGateway()
      if (!gw || !gw.running || !gw.port || !gw.token) {
        throw new Error(gw?.error || 'Embedded runtime not ready — give it a few seconds and try again.')
      }
      await connect({ host: `127.0.0.1:${gw.port}`, token: gw.token, tls: false, name: 'This phone' })
      // Automation knocks are regular notifications — on 13+ they need the
      // POST_NOTIFICATIONS runtime grant (the FGS notice is exempt, so a
      // fresh install looks "allowed" while knocks are silently dropped).
      // Ask at pairing: the embedded flow's natural permission moment.
      void ensureNotificationPermission().catch(() => {})
      router.push('/setup')
      setBusy(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Embedded runtime unavailable')
    } finally {
      setBusy(false)
    }
  }

  const onScanned = (data: string) => {
    if (scanned.current || !data) return
    scanned.current = true
    try {
      const p = parseConnectUrl(data)
      setShowScanner(false)
      scanned.current = false
      void doConnect(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bad QR code')
      setShowScanner(false)
      scanned.current = false
    }
  }

  const applyPairingCode = () => {
    if (!pairingCode.trim()) return
    try {
      const p = parseConnectUrl(pairingCode.trim())
      setPairingCode('')
      void doConnect(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bad pairing code')
    }
  }

  const openScanner = async () => {
    setError(null)
    if (!permission?.granted) {
      const r = await requestPermission()
      if (!r.granted) { setError('Camera permission is needed to scan the QR.'); return }
    }
    scanned.current = false
    setShowScanner(true)
  }

  return (
    <View>
      <Pressable
        style={({ pressed }) => [s.scanBtn, pressed && s.pressed]}
        onPress={() => void openScanner()}
        accessibilityRole="button"
        accessibilityLabel="Scan pairing QR"
      >
        <Icon name="qr-code-outline" size={22} color={C.onAccent} />
        <Text style={s.scanText}>Scan QR code</Text>
      </Pressable>
      {/* BUG-053: name the user-facing tool, not the maintainer script path. */}
      <Text style={s.scanHint}>On your computer, open the agent's pairing screen —{'\n'}it prints the QR code to scan.</Text>

      <Pressable
        style={({ pressed }) => [s.localBtn, pressed && s.pressed]}
        onPress={() => void useThisPhone()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Use this phone as the agent host"
      >
        <Icon name="phone-portrait-outline" size={22} color={C.text} />
        <Text style={s.localText}>Use this phone</Text>
      </Pressable>
      <Text style={s.scanHint}>No computer? Run Hermes right here — embedded on this phone.</Text>

      <Pressable
        style={({ pressed }) => [s.moreToggle, pressed && s.pressed]}
        onPress={() => setShowMore(!showMore)}
        accessibilityRole="button"
        accessibilityLabel="More pairing options"
      >
        <Text style={s.moreText}>{showMore ? 'Hide options' : 'More options'}</Text>
        <Icon name={showMore ? 'chevron-up' : 'chevron-down'} size={14} color={C.textFaint} />
      </Pressable>

      {showMore ? (
        <>
          <View style={s.card}>
            <Text style={s.label}>PASTE PAIRING LINK</Text>
            <TextInput
              style={s.input}
              value={pairingCode}
              onChangeText={setPairingCode}
              placeholder="hermes://connect?host=…&token=…"
              placeholderTextColor={C.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Pairing link"
            />
            <Pressable style={({ pressed }) => [s.secondaryBtn, pressed && s.pressed]} onPress={applyPairingCode} accessibilityLabel="Use pairing link">
              <Text style={s.secondaryText}>Use pairing link</Text>
            </Pressable>
          </View>

          <View style={s.card}>
            <Text style={s.label}>OR ENTER MANUALLY</Text>
            <TextInput
              style={s.input}
              value={host}
              onChangeText={setHost}
              placeholder="192.168.1.10:9999"
              placeholderTextColor={C.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Server address"
            />
            <Pressable style={s.tlsRow} onPress={() => setTls(!tls)} accessibilityRole="checkbox" accessibilityLabel="Use TLS">
              <View style={[s.checkbox, tls && s.checkboxOn]} />
              <Text style={s.tlsText}>Use HTTPS/WSS (Tailscale / public host)</Text>
            </Pressable>
            <View style={s.tokenRow}>
              <TextInput
                style={[s.input, { flex: 1 }]}
                value={token}
                onChangeText={setToken}
                placeholder="Token from the pairing script"
                placeholderTextColor={C.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showToken}
                accessibilityLabel="Token"
              />
              <Pressable style={s.showBtn} onPress={() => setShowToken(!showToken)} accessibilityLabel={showToken ? 'Hide token' : 'Show token'}>
                <Text style={s.showText}>{showToken ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>
            <Pressable
              style={({ pressed }) => [s.btn, busy && s.btnBusy, pressed && s.pressed]}
              onPress={() => void doConnect()}
              disabled={busy}
              accessibilityLabel="Connect"
            >
              {busy ? <ActivityIndicator color={C.onAccent} /> : <Text style={s.btnText}>Connect</Text>}
            </Pressable>
          </View>
        </>
      ) : null}

      {error ? <Text style={s.error}>{error}</Text> : null}

      <Modal visible={showScanner} animationType="slide" onRequestClose={() => setShowScanner(false)}>
        <View style={s.scannerRoot}>
          <CameraView
            style={s.scanner}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={(r) => onScanned(r.data)}
          />
          <View style={s.scannerFooter}>
            <Text style={s.scannerHint}>Point at the pairing QR code on your computer's screen</Text>
            <Pressable style={s.secondaryBtn} onPress={() => setShowScanner(false)}>
              <Text style={s.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const makeS = () => StyleSheet.create({
  pressed: { opacity: 0.6 },
  scanBtn: {
    backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56,
  },
  scanText: { color: C.onAccent, fontSize: 16, fontWeight: '800' },
  scanHint: { color: C.textFaint, fontSize: 12.5, lineHeight: 18, textAlign: 'center', marginTop: 10 },
  moreToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, minHeight: 44 },
  moreText: { color: C.textFaint, fontSize: 13.5, fontWeight: '600' },
  card: { backgroundColor: C.bgCard, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: C.border, marginBottom: 14 },
  label: { color: C.textFaint, fontSize: 10.5, fontWeight: '700', letterSpacing: 2, marginBottom: 6 },
  input: { backgroundColor: C.inputBg, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, color: C.text, fontSize: 15, minHeight: 48 },
  tlsRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 12, minHeight: 44 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: C.textFaint, marginRight: 10 },
  checkboxOn: { backgroundColor: C.accent, borderColor: C.accent },
  tlsText: { color: C.textDim, fontSize: 13.5, flexShrink: 1 },
  tokenRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  showBtn: { paddingHorizontal: 14, paddingVertical: 13, borderRadius: 10, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, minHeight: 48, justifyContent: 'center' },
  showText: { color: C.textDim, fontSize: 13, fontWeight: '700' },
  error: { color: C.red, fontSize: 13, marginTop: 6, lineHeight: 18 },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 18, minHeight: 52, justifyContent: 'center' },
  btnBusy: { opacity: 0.7 },
  btnText: { color: C.onAccent, fontSize: 16, fontWeight: '800' },
  secondaryBtn: { backgroundColor: C.inputBg, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 12, borderWidth: 1, borderColor: C.border, minHeight: 48, justifyContent: 'center' },
  secondaryText: { color: C.text, fontSize: 14, fontWeight: '700' },
  scannerRoot: { flex: 1, backgroundColor: '#000' },
  scanner: { flex: 1 },
  scannerFooter: { padding: 20, backgroundColor: '#000', gap: 10 },
  localBtn: {
    backgroundColor: C.bgCard, borderRadius: 14, paddingVertical: 15, paddingHorizontal: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56,
    borderWidth: 1, borderColor: C.border, marginTop: 16,
  },
  localText: { color: C.text, fontSize: 16, fontWeight: '800' },
  scannerHint: { color: '#fff', textAlign: 'center', fontSize: 14 },
})

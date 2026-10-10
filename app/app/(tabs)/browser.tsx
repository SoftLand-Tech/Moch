import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { WebView } from 'react-native-webview'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useStore } from '@nanostores/react'
import { Ionicons } from '@expo/vector-icons'
import { ScreenShell } from '../../src/components/ScreenShell'
import { C, useStyles } from '../../src/lib/theme'
import {
  ensureBrowserRelay,
  browserTabs,
  activeTabId,
  relayStatus,
  addTab,
  closeTab,
  switchTab,
  updateTab,
  syncActiveUrl,
} from '../../src/lib/browserRelay'
import { shareInInbox, normalizeSharedPayload } from '../../src/lib/shareIn'

/**
 * Moch Browser (BUILD-PLAN.md B1) — the visible, multi-tab WebView pool the
 * embedded agent drives over the CDP relay.
 *
 * Contract with the native side:
 *  - Screen mount calls ensureBrowserRelay() FIRST (relay + debug switch),
 *    then mounts one real <WebView> per tab. Tabs stay MOUNTED (1px, opaque,
 *    untouchable) when inactive — detached WebViews stop producing frames
 *    and CDP degrades (research: webview-cdp-report §e.3).
 *  - Every navigation state change syncs the live URL into the relay, whose
 *    /json/list filter makes the agent's "first page target" THIS tab.
 *  - Tab lifecycle is RN-owned: CDP cannot create or focus WebView targets,
 *    and the relay 405s /json/new|close|activate to keep that single owner.
 *  - Ask Moch routes the page into the agent's composer through the same
 *    shareIn inbox the OS share target uses — text lands in the draft,
 *    nothing auto-sends.
 */

const HOME_URL = 'https://www.google.com'

export default function Browser() {
  const s = useStyles(makeS)
  const tabs = useStore(browserTabs)
  const activeId = useStore(activeTabId)
  const status = useStore(relayStatus)
  const [booting, setBooting] = useState(true)
  const [urlDraft, setUrlDraft] = useState('')
  const [askDraft, setAskDraft] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  /** Bumped to remount (recreate) a tab's WebView after a renderer crash. */
  const [renderKeys, setRenderKeys] = useState<Record<string, number>>({})
  /** Bumped to force a reload (WebView remount at the tab's live URL). */
  const [reloadNonce, setReloadNonce] = useState<Record<string, number>>({})
  /** Real current URL per tab (in-page navigations never rewrite the requested url). */
  const liveUrls = useRef<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    void ensureBrowserRelay().finally(() => {
      if (cancelled) return
      setBooting(false)
      if (browserTabs.get().length === 0) addTab(HOME_URL)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const active = tabs.find((t) => t.id === activeId) ?? null
  const activeLiveUrl = active ? liveUrls.current[active.id] ?? active.url : ''

  useEffect(() => {
    setUrlDraft(activeLiveUrl)
  }, [activeLiveUrl])

  const onNavState = useCallback(
    (tabId: string, nav: { url?: string; title?: string; loading?: boolean }) => {
      const url = nav.url ?? ''
      if (url) liveUrls.current[tabId] = url
      updateTab(tabId, {
        title: nav.title?.slice(0, 80) || url,
        ready: nav.loading === false,
      })
      // The relay's filter keys on the LIVE url, not the requested one.
      if (tabId === activeTabId.get() && url) syncActiveUrl(url)
    },
    [],
  )

  const submitUrl = useCallback(() => {
    if (!active) return
    let next = urlDraft.trim()
    if (!next) return
    if (!/^https?:\/\//i.test(next)) {
      next = next.includes('.') && !next.includes(' ')
        ? `https://${next}`
        : `https://www.google.com/search?q=${encodeURIComponent(next)}`
    }
    liveUrls.current[active.id] = next
    updateTab(active.id, { url: next, ready: false })
  }, [active, urlDraft])

  const reload = useCallback(() => {
    if (!active) return
    const live = liveUrls.current[active.id] ?? active.url
    liveUrls.current[active.id] = live
    setReloadNonce((cur) => ({ ...cur, [active.id]: (cur[active.id] ?? 0) + 1 }))
  }, [active])

  const openTab = useCallback((id: string) => {
    switchTab(id)
    const live = liveUrls.current[id]
    if (live) syncActiveUrl(live)
  }, [])

  const removeTab = useCallback((id: string) => {
    delete liveUrls.current[id]
    closeTab(id)
  }, [])

  const askMoch = useCallback(() => {
    const task = askDraft.trim()
    if (!active || !task) return
    const url = liveUrls.current[active.id] ?? active.url
    const title = active.title || url
    const payload = normalizeSharedPayload({
      text: `Open in my browser: ${title}\n${url}\n\n${task}`,
      subject: title,
      files: [],
      skipped: 0,
      at: Date.now(),
    })
    if (!payload) return
    setAskDraft('')
    setAskOpen(false)
    shareInInbox.set(payload)
  }, [active, askDraft])

  const relayBad = status && !status.running

  return (
    <ScreenShell title="Browser">
      <SafeAreaView style={s.safe} edges={['top']}>
        {booting ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color={C.accent} />
            <Text style={s.bootText}>Starting the browser relay…</Text>
          </View>
        ) : relayBad ? (
          <View style={s.center}>
            <Ionicons name="warning-outline" size={34} color={C.red} />
            <Text style={s.bootText}>Browser relay unavailable</Text>
            <Text style={s.errText}>{status?.lastError ?? 'unknown error'}</Text>
          </View>
        ) : (
          <View style={s.root}>
            {/* Tab strip */}
            <View style={s.tabBar}>
              <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={s.tabScroll}>
                <View style={s.tabRow}>
                  {tabs.map((t) => (
                    <Pressable
                      key={t.id}
                      onPress={() => openTab(t.id)}
                      style={[s.tab, t.id === activeId && s.tabOn]}
                      accessibilityRole="tab"
                      accessibilityLabel={`Tab ${t.title}`}
                    >
                      <Text numberOfLines={1} style={[s.tabText, t.id === activeId && s.tabTextOn]}>
                        {t.ready === false ? '… ' : ''}{t.title || t.url}
                      </Text>
                      <Pressable
                        hitSlop={8}
                        onPress={() => removeTab(t.id)}
                        accessibilityRole="button"
                        accessibilityLabel="Close tab"
                      >
                        <Ionicons name="close" size={14} color={t.id === activeId ? C.onAccent : C.textFaint} />
                      </Pressable>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
              <Pressable
                style={s.newTab}
                onPress={() => addTab(HOME_URL)}
                accessibilityRole="button"
                accessibilityLabel="New tab"
              >
                <Ionicons name="add" size={20} color={C.text} />
              </Pressable>
            </View>

            {/* URL row */}
            <View style={s.urlRow}>
              <Pressable style={s.urlBtn} onPress={reload} accessibilityRole="button" accessibilityLabel="Reload page">
                <Ionicons name="refresh" size={18} color={C.text} />
              </Pressable>
              <TextInput
                style={s.urlInput}
                value={urlDraft}
                onChangeText={setUrlDraft}
                onSubmitEditing={submitUrl}
                placeholder="Search or enter address"
                placeholderTextColor={C.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                accessibilityLabel="Address bar"
              />
              <Pressable
                style={[s.urlBtn, s.askBtn]}
                onPress={() => setAskOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel="Ask Moch about this page"
              >
                <Ionicons name="sparkles" size={18} color={C.onAccent} />
              </Pressable>
            </View>

            {askOpen && (
              <View style={s.askRow}>
                <TextInput
                  style={s.askInput}
                  value={askDraft}
                  onChangeText={setAskDraft}
                  onSubmitEditing={askMoch}
                  placeholder="What should Moch do on this page?"
                  placeholderTextColor={C.textFaint}
                  multiline
                  accessibilityLabel="Ask Moch task"
                />
                <Pressable style={s.askGo} onPress={askMoch} accessibilityRole="button" accessibilityLabel="Send task to Moch">
                  <Ionicons name="arrow-up" size={20} color={C.onAccent} />
                </Pressable>
              </View>
            )}

            {/* WebView pool — every tab stays mounted; inactive tabs render
                1px, opaque and untouchable so their renderer keeps producing
                frames for CDP (screenshots/screencast need a live surface). */}
            <View style={s.pool}>
              {tabs.map((t) => {
                const on = t.id === activeId
                return (
                  <View
                    key={`${t.id}:${renderKeys[t.id] ?? 0}:${reloadNonce[t.id] ?? 0}`}
                    style={on ? s.pageOn : s.pageOff}
                    pointerEvents={on ? 'auto' : 'none'}
                  >
                    <WebView
                      source={{ uri: t.url }}
                      webviewDebuggingEnabled
                      setSupportMultipleWindows={false}
                      onNavigationStateChange={(nav) => onNavState(t.id, nav)}
                      onLoadEnd={() => updateTab(t.id, { ready: true })}
                      onRenderProcessGone={() => {
                        setRenderKeys((cur) => ({ ...cur, [t.id]: (cur[t.id] ?? 0) + 1 }))
                      }}
                      userAgent="Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"
                      javaScriptEnabled
                      domStorageEnabled
                      thirdPartyCookiesEnabled
                      allowFileAccess={false}
                      pullToRefreshEnabled={false}
                    />
                  </View>
                )
              })}
            </View>
          </View>
        )}
      </SafeAreaView>
    </ScreenShell>
  )
}

const makeS = () =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: C.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
    bootText: { color: C.textDim, fontSize: 15, textAlign: 'center' },
    errText: { color: C.red, fontSize: 13, textAlign: 'center' },
    root: { flex: 1 },
    tabBar: {
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.borderSoft,
      paddingRight: 4,
    },
    tabScroll: { flex: 1 },
    tabRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6 },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      maxWidth: 170,
      paddingHorizontal: 10,
      height: 34,
      borderRadius: 10,
      backgroundColor: C.bgCard,
    },
    tabOn: { backgroundColor: C.accent },
    tabText: { color: C.textDim, fontSize: 13, maxWidth: 120 },
    tabTextOn: { color: C.onAccent, fontWeight: '600' },
    newTab: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    urlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    urlBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    askBtn: { backgroundColor: C.accent, borderRadius: 16 },
    urlInput: {
      flex: 1,
      height: 36,
      borderRadius: 18,
      backgroundColor: C.bgCard,
      borderWidth: 1,
      borderColor: C.borderSoft,
      paddingHorizontal: 14,
      color: C.text,
      fontSize: 14,
    },
    askRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingHorizontal: 10,
      paddingBottom: 6,
    },
    askInput: {
      flex: 1,
      minHeight: 38,
      maxHeight: 110,
      borderRadius: 12,
      backgroundColor: C.bgCard,
      borderWidth: 1,
      borderColor: C.accentSoft,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: C.text,
      fontSize: 14,
    },
    askGo: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pool: { flex: 1, overflow: 'hidden' },
    pageOn: { flex: 1, backgroundColor: C.bg },
    pageOff: {
      position: 'absolute',
      width: 1,
      height: 1,
      opacity: 0,
      overflow: 'hidden',
    },
  })
